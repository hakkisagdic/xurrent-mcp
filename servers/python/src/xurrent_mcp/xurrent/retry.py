"""Retry/backoff politikasi — contract/reliability.md'nin calistirilabilir hali.

★ TEZ: Retry TRANSPORTUN degil, OPERASYONUN ozelligidir. Ayni HTTP 500,
  bir timeEntryUpdate'te guvenle tekrarlanir (mutlak SET); bir requestUpdate'te
  cift sayim uretir (timeSpent ARTIMLIDIR). Bu yuzden siniflandirma anahtari
  status kodu DEGIL, operasyon sinifidir.

Hata siniflari (reliability.md §1):
  - kesin-islenmedi : HTTP 429            -> HER operasyon icin retry edilebilir
  - belirsiz        : 5xx / ag / timeout  -> karar operasyon sinifina bakar
  - kesin-reddedildi: 4xx (429 haric), top-level GraphQL errors, payload errors
                      -> ASLA otomatik retry edilmez

Kutuphane eslemesi (reliability.md §8): TS `p-retry`, C# `Polly`, Python
`tenacity`. Politika TEK, kutuphane uc — "dil bir detaydir" tezinin
guvenilirlik ayagi.
"""

from __future__ import annotations

import random
import sys
import time as _time
from collections.abc import Callable
from typing import Any

from tenacity import RetryCallState, Retrying, retry_if_exception, stop_after_attempt
from tenacity.wait import wait_base

# ---------------------------------------------------------------- hatalar
#
# NEDEN burada (live.py'de degil): retry katmani siniflandirma icin bu tiplere
# bakmak zorunda; live.py de retry katmanini kullaniyor. Tipleri burada tutup
# live.py'den yeniden ihrac etmek dongusel import'u onler.


class XurrentTransportError(RuntimeError):
    """Ag/HTTP seviyesindeki hata. Is kurali hatalari bundan FARKLIDIR.

    Duz hali "ag hatasi" demektir ve BELIRSIZ siniftadir: istek sunucuya
    ULASMIS ve ISLENMIS olabilir. (ECONNREFUSED/DNS aslinda kesin-islenmedi'dir
    ama uc dilde bu ayrimi guvenilir yapmak kirilgandir — bilincli sadelestirme,
    bkz. reliability.md §1 notu.)
    """


class XurrentHttpError(XurrentTransportError):
    """HTTP >= 400 cevabi; status kodu + Retry-After basligini tasir.

    NEDEN ayri tip: 429 (kesin-islenmedi) ile 5xx (belirsiz) FARKLI retry
    kararlari uretir. Onceki tek-tip XurrentTransportError bu ayrimi
    tasiyamiyordu — tum >=400'leri ayni sepete atmak, politikayi transport
    seviyesinde kor birakirdi.
    """

    def __init__(
        self, message: str, *, status: int, retry_after: float | None = None
    ) -> None:
        super().__init__(message)
        self.status = status
        # Retry-After SANIYE cinsindendir (D15: gercek birim dogrulanacak).
        self.retry_after = retry_after


class XurrentGraphQLError(XurrentTransportError):
    """Top-level GraphQL `errors` — sema/sorgu hatasi.

    KESIN-REDDEDILDI: sunucu istegi anladi ve reddetti; tekrarlamak ayni reddi
    uretir. (Payload icindeki is kurali hatalari exception DEGILDIR; onlar
    normal donus yolunda `errors` dizisiyle akar.)
    """


class XurrentRestValidationError(XurrentHttpError):
    """HTTP 422 — REST yuzeyinin is kurali reddi (Unprocessable Entity).

    GraphQL'de is kurali hatasi "HTTP 200 + payload.errors" ile gelir; REST'te
    ayni red "HTTP 422 + {errors:[...]}" govdesiyle gelir. IKISI DE AYNI SEYDIR:
    kesin-reddedildi. Bu tip 4xx oldugu icin classify() None doner — ASLA retry
    edilmez — ve adaptor bu hatayi exception olarak YUKARI SIZDIRMAZ; sozlesmedeki
    errors[] sekline cevirip normal donus yolundan raporlar (docs/16 dersi:
    istemci HTTP koduna BAKMAK zorundadir).
    """

    def __init__(self, message: str, *, errors: list[dict] | None = None) -> None:
        super().__init__(message, status=422, retry_after=None)
        # Sahte/gercek REST govdesi: [{"message": ..., "attribute": ...}]
        self.errors = errors or []


# ---------------------------------------------------------------- siniflar

# Operasyon siniflari (reliability.md §2). Mutation path -> sinif.
#   guarded_create    : deterministik sourceID var ama sunucuda unique kisit YOK
#                       -> belirsiz hatada once dedup geri-okumasi, sonra retry.
#   idempotent_update : mutlak SET — tekrar zararsiz.
#   no_retry          : timeSpent ARTIMLI + idempotency anahtari yok
#                       -> belirsiz hatada tekrar = cift sayim. ASLA.
OP_CLASS_BY_PATH: dict[str, str] = {
    "timeEntryCreate": "guarded_create",
    "timeEntryUpdate": "idempotent_update",
    "requestUpdate": "no_retry",
    "taskUpdate": "no_retry",
    "projectTaskUpdate": "no_retry",
    "problemUpdate": "no_retry",
}

# Belirsiz hatada retry'a IZIN VERILEN siniflar. guarded_create burada cunku
# retry'dan ONCE dedup geri-okumasi yapilir (execute_with_retry icinde);
# geri-okuma "yazilmamis" derse tekrar guvenlidir.
_UNCERTAIN_RETRY_CLASSES = frozenset({"query", "idempotent_update", "guarded_create"})


def classify(exc: BaseException) -> str | None:
    """Hata -> iz/karar etiketi: '429' | '5xx' | 'network' | None (retry yok)."""
    if isinstance(exc, XurrentHttpError):
        if exc.status == 429:
            return "429"
        if exc.status >= 500:
            return "5xx"
        return None  # diger 4xx: kesin-reddedildi
    if isinstance(exc, XurrentGraphQLError):
        return None  # sema/sorgu reddi: tekrarlamak ayni reddi uretir
    if isinstance(exc, XurrentTransportError):
        return "network"
    return None


def is_uncertain(exc: BaseException) -> bool:
    """Belirsiz sinif mi (5xx / ag)? 'Istek islenmis OLABILIR' demektir."""
    return classify(exc) in ("5xx", "network")


def transport_error_message(path: str, op_class: str, exc: XurrentTransportError) -> str:
    """Transport hatasini KULLANICIYA anlamli Turkce metne cevirir.

    NEDEN burada (adaptorde degil): metin operasyon SINIFINA gore kurulur ve
    politika transport-bagimsizdir — GraphQL ve REST adaptorleri ayni belirsizlik
    dersini AYNI cumlelerle anlatmak zorundadir (contract/reliability.md §2).
    """
    if op_class == "no_retry" and is_uncertain(exc):
        # reliability.md §2: Yol B'de timeSpent ARTIMLIDIR ve input
        # idempotency anahtari kabul etmez. Belirsiz hatada tekrar = cift
        # sayim -> retry YAPILMADI; karar kullanicinin.
        return (
            f"{path} belirsiz bir hatayla dustu ({exc}). Istek sunucuya ULASMIS "
            "ve ISLENMIS olabilir — yani kayit YAZILMIS DA OLABILIR, yazilmamis da. "
            "timeSpent bu yolda ARTIMLI oldugu icin otomatik tekrar CIFT SAYIM "
            "riski tasir; bu yuzden retry YAPILMADI. Lutfen ticket'in zaman "
            "kayitlarini kontrol edin: kayit olusmussa TEKRAR GONDERMEYIN, "
            "olusmamissa istegi elle tekrarlayin."
        )
    if op_class == "guarded_create" and is_uncertain(exc):
        return (
            f"{path} tum denemelerde basarisiz oldu ({exc}). sourceID "
            "geri-okumasi kayit BULAMADI — yazma gerceklesmemis gorunuyor; "
            "ayni komut guvenle tekrar calistirilabilir (dedup korumasi devrede)."
        )
    return f"{path} basarisiz: {exc}"


# ---------------------------------------------------------------- izler (§6)
#
# Izler STDERR'e yazilir — stdout MCP stdio kanalidir, tek bir yabanci satir
# JSON-RPC akisini bozar. Bicim uc dilde BIREBIR AYNIDIR; senaryo koşucusu
# (tools/fake-xurrent/senaryolar.mjs) bu satirlari sayarak politikayi dogrular.


def log_retry(op: str, attempt: int, max_attempts: int, reason: str, wait_ms: int) -> None:
    print(
        f"[retry] op={op} attempt={attempt}/{max_attempts} reason={reason} waitMs={wait_ms}",
        file=sys.stderr,
        flush=True,
    )


def log_dedup(source_id: str, hit: bool) -> None:
    print(
        f"[dedup] op=timeEntryCreate sourceID={source_id} hit={'true' if hit else 'false'}",
        file=sys.stderr,
        flush=True,
    )


# ---------------------------------------------------------------- bekleme (§3)


class FullJitterWait(wait_base):
    """Tam jitter'li ustel geri cekilme + Retry-After tabani.

    bekleme_k = rastgele(0, min(CAP, BASE·2^(k-1)))  [k = kacinci TEKRAR]

    NEDEN tam jitter: ayni anda dusen N istemci ayni sabit backoff'la ayni anda
    geri doner ve sunucuyu tekrar devirir (thundering herd). Rastgelelik
    tekrarlari zamana yayar.

    Yanit `Retry-After: <saniye>` tasiyorsa o tekrarin beklemesi EN AZ o
    kadardir: max(jitter, retryAfter). Sunucu "su kadar bekle" diyorsa daha
    erken donmek ayni 429'u yemektir.
    """

    def __init__(self, base_ms: float, cap_ms: float) -> None:
        self.base_ms = base_ms
        self.cap_ms = cap_ms

    def __call__(self, retry_state: RetryCallState) -> float:
        k = retry_state.attempt_number  # basarisiz olan deneme (1 tabanli)
        ceiling_ms = min(self.cap_ms, self.base_ms * (2 ** (k - 1)))
        wait_ms = random.uniform(0, ceiling_ms)
        exc = retry_state.outcome.exception() if retry_state.outcome else None
        retry_after = getattr(exc, "retry_after", None)
        if retry_after:
            wait_ms = max(wait_ms, float(retry_after) * 1000.0)
        return wait_ms / 1000.0


# ---------------------------------------------------------------- calistirici


def execute_with_retry(
    fn: Callable[[], Any],
    *,
    op: str,
    op_class: str,
    max_attempts: int,
    base_ms: float,
    cap_ms: float,
    on_uncertain: Callable[[], Any | None] | None = None,
    sleep: Callable[[float], None] = _time.sleep,
) -> Any:
    """`fn`'i (tek HTTP denemesi) operasyon sinifina gore tekrarlar.

    op          : iz etiketi — mutation path'i ya da "query" (§6 bicimi).
    op_class    : query | guarded_create | idempotent_update | no_retry.
    on_uncertain: YALNIZCA guarded_create icin — belirsiz hatada cagrilir
                  (dedup geri-okumasi). None-degil donerse o deger BASARI
                  sayilir ve dongu biter; None donerse retry surer.
    sleep       : testlerde enjekte edilebilir (gercek beklemesiz test).

    max_attempts=1 retry'i tamamen kapatir (stop_after_attempt(1)).
    """
    attempts = max(1, int(max_attempts))

    def _attempt() -> Any:
        try:
            return fn()
        except XurrentTransportError as exc:
            # guarded_create'in belirsiz-hata korumasi: KOR retry cift kayit
            # yazabilir. Once "yazilmis mi?" sorusu sorulur (sourceID
            # geri-okumasi); yazilmissa mevcut kayit BASARI olarak doner.
            if (
                op_class == "guarded_create"
                and on_uncertain is not None
                and is_uncertain(exc)
            ):
                found = on_uncertain()
                if found is not None:
                    return found
            raise

    def _should_retry(exc: BaseException) -> bool:
        reason = classify(exc)
        if reason is None:
            return False  # kesin-reddedildi: tekrar ISRAF ya da ayni red
        if reason == "429":
            return True  # kesin-islenmedi: her sinif icin guvenli
        return op_class in _UNCERTAIN_RETRY_CLASSES

    def _before_sleep(retry_state: RetryCallState) -> None:
        exc = retry_state.outcome.exception() if retry_state.outcome else None
        reason = classify(exc) if exc else "network"
        wait_s = retry_state.next_action.sleep if retry_state.next_action else 0.0
        # attempt = az once BASARISIZ olan deneme; waitMs = gercekten
        # beklenecek sure (jitter + Retry-After tabani uygulanmis hali).
        log_retry(op, retry_state.attempt_number, attempts, reason or "network", int(wait_s * 1000))

    retrying = Retrying(
        sleep=sleep,
        stop=stop_after_attempt(attempts),
        wait=FullJitterWait(base_ms, cap_ms),
        retry=retry_if_exception(_should_retry),
        before_sleep=_before_sleep,
        # reraise: denemeler tukendiginde tenacity'nin RetryError sargisi
        # yerine SON gercek hata firlatilir — cagiran katman siniflandirmayi
        # kaybetmez.
        reraise=True,
    )
    return retrying(_attempt)


__all__ = [
    "OP_CLASS_BY_PATH",
    "FullJitterWait",
    "XurrentGraphQLError",
    "XurrentHttpError",
    "XurrentRestValidationError",
    "XurrentTransportError",
    "classify",
    "execute_with_retry",
    "is_uncertain",
    "log_dedup",
    "log_retry",
    "transport_error_message",
]
