"""timesheet_wizard — sunucu-gudumlu sohbet durum makinesi (contract/wizard.md).

TEZ: Ince host'ta (Copilot Studio, duz bir REPL) chatbot olmak icin LLM
gerekmez — deterministik bir durum makinesi + imzali oturum durumu yeter.
Host yalnizca kullanici cumlesini iletir ve donen soruyu gosterir.

UC TASARIM KARARI (sozlesmeden):

1. `step` alani ILERLEME etiketidir: bu cagrida HANGI adimin isi yapildi.
   Senaryo koducusu (h) bunu sabitler: ilk cagri "start", is secimi
   "pick_work", sure "duration", detay "detail". sessionState payload'ina da
   AYNI etiket yazilir; bir sonraki cumlenin nasil yorumlanacagi bu etiketten
   turetilir. "confirm" ve "done" gecis/uc durumlaridir; "write" son cagrinin
   etiketi olur (yazma o cagrida gerceklesir).

2. HMAC payload BYTE'lari uzerinde hesaplanir — kanonikleştirme GEREKMEZ:
   dogrulayan taraf parse etmeden ONCE byte'lari imzalar. Bu sayede
   capraz-dil devir calisir: TS'in urettigi state Python'a verilebilir
   (ayni XURRENT_STATE_SECRET ile). Wire bicimi requestState codec'iyle ayni
   aile: base64url(payloadJson) + "." + base64url(HMAC_SHA256(secret, bytes)).
   requestState'ten AYRI bir codec'tir cunku payload alanlari farklidir
   (nonce YOK — state her adimda geri doner, tek kullanimlik degildir).

3. `plannedFingerprint`: confirm'de gosterilen planin sha256 kisaltmasi.
   write adimi parmak izini YENIDEN hesaplar ve eslesmezse YAZMAZ — state'le
   oynayip onaylanandan farkli bir sey yazdirma girisimini keser.

Modul ici tool cagrilari LAZY import ile yapilir: tools paketi bu modulu
kayit defterine almak icin import eder; modul seviyesinde geri import etmek
dongusel import uretirdi.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import date, timedelta
from typing import TYPE_CHECKING, Any

from ..config import Config
from ..timeutil import iso, iso_date, local_datetime, today_in
from .confirm import _b64url, _b64url_decode

if TYPE_CHECKING:  # dongusel import onlemi — yalnizca tip denetimi icin
    from ..tools.runtime import Runtime

# Sozlesmedeki adim etiketleri (contract/wizard.md §2).
WIZARD_STEPS = frozenset(
    {
        "start",
        "pick_work",
        "duration",
        "detail",
        "strategy",
        "confirm",
        "write",
        "calendar_plan",
        "calendar_confirm",
        "done",
    }
)

# §3 — onay kumeleri (Turkce kucuk-harf katlamasindan SONRA karsilastirilir).
EVET_KUMESI = frozenset({"evet", "onay", "onaylıyorum", "tamam", "e"})
HAYIR_KUMESI = frozenset({"hayır", "iptal", "vazgeç", "h"})
TAKVIM_KELIMELERI = ("takvim", "toplantı")

_SURE_RE = re.compile(r"^(\d+(?:[.,]\d+)?)\s*(saat|sa|dakika|dk)?$")
_TARIH_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SAAT_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")
_ELEME_RE = re.compile(r"^(\d+)\s*hariç$")

# XURRENT_STATE_SECRET bossa surec basina rastgele anahtar: yeniden baslatinca
# eski sohbetler gecersiz olur (requestState ile ayni bilincli davranis).
# Capraz-dil devir icin sirrin ACIKCA verilmesi gerekir.
_FALLBACK_SECRET = secrets.token_bytes(32)


class WizardStateError(Exception):
    """sessionState dogrulanamadi. Mesaj TURKCE ve kullaniciya gosterilebilir."""


# ------------------------------------------------------------------ katlamalar


def katla(text: str) -> str:
    """Turkce kucuk-harf katlamasi: İ→i, I→ı (fake-gemini'deki desenin aynisi)."""
    return text.replace("İ", "i").replace("I", "ı").lower().strip()


def _temizle(text: str) -> str:
    """Cevap sonundaki noktalama katlamayi bozmasin."""
    return katla(text).strip(" .!?")


# ------------------------------------------------------------------ codec


def _secret(config: Config) -> bytes:
    return config.state_secret.encode("utf-8") if config.state_secret else _FALLBACK_SECRET


def sign_state(secret: bytes, payload: dict[str, Any]) -> str:
    """payload -> base64url(json) + "." + base64url(HMAC_SHA256(secret, jsonBytes))."""
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    signature = hmac.new(secret, body, hashlib.sha256).digest()
    return f"{_b64url(body)}.{_b64url(signature)}"


def verify_state(secret: bytes, token: str) -> dict[str, Any]:
    """IMZA ONCE, parse SONRA. Basarisizsa WizardStateError (Turkce)."""
    parts = token.split(".")
    if len(parts) != 2:
        raise WizardStateError(
            "Oturum durumu (sessionState) bicimi bozuk — beklenen 'govde.imza'."
        )
    try:
        body = _b64url_decode(parts[0])
        signature = _b64url_decode(parts[1])
    except Exception as exc:  # noqa: BLE001
        raise WizardStateError(
            "Oturum durumu base64url olarak cozulemedi — bozulmus gorunuyor."
        ) from exc

    # Imza HAM byte'lar uzerinde dogrulanir; kanonikleştirme YOK. Baska dilin
    # urettigi state bu sayede kabul edilir (contract/wizard.md §4).
    expected = hmac.new(secret, body, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, signature):
        raise WizardStateError(
            "Oturum durumu IMZASI GECERSIZ — state kurcalanmis olabilir."
        )

    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise WizardStateError("Oturum durumu govdesi JSON degil.") from exc

    if payload.get("v") != 1 or payload.get("kind") != "wizard":
        raise WizardStateError("Oturum durumu bu sihirbaza ait degil (v/kind uyusmuyor).")
    if int(payload.get("exp", 0)) < int(time.time()):
        raise WizardStateError("Oturum suresi dolmus (XURRENT_WIZARD_TTL).")
    if payload.get("step") not in WIZARD_STEPS:
        raise WizardStateError("Oturum durumu bilinmeyen bir adim tasiyor.")
    return payload


def plan_fingerprint(planned: list[dict[str, Any]]) -> str:
    """Onaylanan planin sha256 kisaltmasi — kanonik JSON uzerinden."""
    canonical = json.dumps(
        planned, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


# ------------------------------------------------------------------ ayristiricilar


def sure_ayristir(text: str) -> tuple[int, bool] | None:
    """'2 saat'→(120, True) · '90'→(90, False) · '1,5 saat'→(90, True).

    Ondalik virgul de kabul edilir (§3). Ciplak sayi DAKIKA'dir — sozlesmenin
    tek sure birimi. Donus: (dakika, saat_birimiyle_mi_soylendi).
    """
    m = _SURE_RE.match(_temizle(text))
    if not m:
        return None
    sayi = float(m.group(1).replace(",", "."))
    birim = m.group(2)
    if birim in ("saat", "sa"):
        return int(round(sayi * 60)), True
    if sayi != int(sayi):
        return None  # "1,5 dk" gibi kesirli dakika anlamsiz
    dakika = int(sayi)
    return (dakika, False) if dakika > 0 else None


def tarih_ayristir(token: str, bugun: date) -> date | None:
    f = katla(token)
    if f == "bugün":
        return bugun
    if f == "dün":
        return bugun - timedelta(days=1)
    if _TARIH_RE.match(f):
        try:
            return date.fromisoformat(f)
        except ValueError:
            return None
    return None


def secim_ayristir(
    text: str, choices: list[dict[str, Any]]
) -> dict[str, Any] | None:
    """choice id'si · 1-bazli sira numarasi · label'in kucuk-harf tam eslesmesi."""
    raw = text.strip()
    f = _temizle(text)
    for c in choices:
        if raw == c["id"] or f == katla(str(c["id"])):
            return c
    if f.isdigit():
        index = int(f)
        if 1 <= index <= len(choices):
            return choices[index - 1]
    for c in choices:
        if f == katla(str(c["label"])):
            return c
    return None


def _takvim_istendi(text: str) -> bool:
    f = katla(text)
    return any(kelime in f for kelime in TAKVIM_KELIMELERI)


# ------------------------------------------------------------------ cikti kurucu


def _yanit(
    config: Config,
    *,
    step: str,
    reply: str,
    question: dict[str, Any] | None = None,
    store_step: str | None = None,
    data: dict[str, Any] | None = None,
    done: bool = False,
    write_result: dict[str, Any] | None = None,
    errors: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """WizardResult sozlugu. done=true iken sessionState ve nextQuestion YOK."""
    out: dict[str, Any] = {
        "step": step,
        "reply": reply,
        "nextQuestion": None if done else question,
        "sessionState": None,
        "done": done,
        "writeResult": write_result,
        "errors": errors or [],
    }
    if not done:
        payload = {
            "v": 1,
            "kind": "wizard",
            "step": store_step or step,
            "exp": int(time.time()) + config.wizard_ttl_seconds,
            "data": data or {},
        }
        out["sessionState"] = sign_state(_secret(config), payload)
    return out


# ------------------------------------------------------------------ tool erisimi
# LAZY import: tools paketi bu modulu kayit icin import eder; modul seviyesinde
# geri import dongusel olurdu. Fonksiyon icindeki import ilk cagridan sonra
# sys.modules'ten gelir — maliyeti yoktur.


def _oku(rt: "Runtime", name: str, args: dict[str, Any]) -> dict[str, Any]:
    from ..tools import calendar_tools, read_tools

    handlers = {
        "whoami": read_tools.xurrent_whoami,
        "context": read_tools.xurrent_get_time_tracking_context,
        "open_work": read_tools.xurrent_list_open_work,
        "list_entries": read_tools.xurrent_list_time_entries,
        "calendar_plan": calendar_tools.plan_time_entries_from_calendar,
    }
    return handlers[name](rt, args)


def _yaz(rt: "Runtime", name: str, args: dict[str, Any], *, onayli: bool) -> dict[str, Any]:
    """Yazma tool'unu cagirir. onayli=True, sihirbazin KENDI confirm adiminin
    'evet' cevabidir — core'un sundugu mekanizma (ConfirmationState.granted)
    uzerinden tasinir; protokol seviyesinde YENIDEN onay SORULMAZ.
    XURRENT_CONFIRM_POLICY=strict altinda da gecerlidir: onay ALINMISTIR."""
    from ..tools import write_tools
    from ..tools.runtime import ConfirmationState

    handlers = {
        "create": write_tools.xurrent_create_time_entry,
        "bulk": write_tools.xurrent_create_time_entries_bulk,
    }
    rt.confirmation = ConfirmationState(can_ask=onayli, granted=onayli)
    try:
        return handlers[name](rt, args)
    finally:
        rt.confirmation = ConfirmationState()


# ------------------------------------------------------------------ sorular


def _is_listesi(rt: "Runtime") -> list[dict[str, Any]]:
    """Acik is secenekleri — start sorusunun choices listesi (deterministik sira:
    once Request'ler, sonra Task'lar; 'takvim' HER ZAMAN sonda ve numarasiz sayilir)."""
    work = _oku(rt, "open_work", {"personId": "$me", "view": "all"})
    items = [*(work["requests"]["nodes"] or []), *(work["tasks"]["nodes"] or [])]
    choices = [
        {
            "id": n["id"],
            "label": f"#{n['displayId']} {n.get('subject') or ''}".strip(),
            "detail": n.get("statusLabel") or n.get("status"),
            "_kind": n["kind"],
            "_displayId": str(n["displayId"]),
        }
        for n in items
    ]
    choices.append(
        {
            "id": "takvim",
            "label": "Takvimden al",
            "detail": "Gunun toplantilarindan zaman girisi onerileri uretilir.",
            "_kind": "takvim",
            "_displayId": "takvim",
        }
    )
    return choices


def _soru(prompt: str, choices: list[dict[str, Any]] | None, free_text: bool) -> dict[str, Any]:
    q: dict[str, Any] = {"prompt": prompt, "expectsFreeText": free_text}
    if choices:
        q["choices"] = [
            {"id": c["id"], "label": c["label"], "detail": c.get("detail")}
            for c in choices
        ]
    return q


def _secim_sorusu(choices: list[dict[str, Any]]) -> dict[str, Any]:
    return _soru(
        "Hangi kayda zaman yazalım? Sıra numarası, id ya da 'takvim' yazın.",
        choices,
        False,
    )


_SURE_SORUSU = _soru(
    "Ne kadar süre yazalım? Örnek: '2 saat', '90', '1,5 saat' — birim DAKİKADIR.",
    None,
    True,
)

_DETAY_SORUSU = _soru(
    "Tarih (bugün / dün / YYYY-AA-GG), istersen başlangıç saati (SS:DD) ve kısa "
    "bir açıklama yazın. Örnek: 'dün 14:00 VPN bakımı'",
    None,
    True,
)

# Uc yol, backdateStrategies.keeps/costs metinleriyle (contract/tools.json).
_STRATEJI_SECENEKLERI: list[dict[str, Any]] = [
    {
        "id": "two_step",
        "label": "İki adımlı telafi",
        "detail": (
            "Korur: ticket bağı, geçmiş tarih (T-1), başlangıç saati. "
            "Bedeli: 2 HTTP isteği, atomik değil."
        ),
    },
    {
        "id": "link_first",
        "label": "Ticket bağı öncelikli",
        "detail": (
            "Tek istek, atomik. Bedeli: tarih her zaman BUGÜN olur, başlangıç "
            "saati kaydedilmez."
        ),
    },
    {
        "id": "date_first",
        "label": "Tarih öncelikli",
        "detail": (
            "date/startedAt tam doğru, tek istek. Bedeli: kayıt ticket'a "
            "BAĞLANMAZ (assignment=null)."
        ),
    },
]

_STRATEJI_SORUSU = _soru("Hangi yazma stratejisini kullanalım?", _STRATEJI_SECENEKLERI, False)

_ONAY_SECENEKLERI = [
    {"id": "evet", "label": "Evet", "detail": "Planı onayla ve yaz."},
    {"id": "hayır", "label": "Hayır", "detail": "Vazgeç — hiçbir şey yazılmaz."},
]

_ONAY_SORUSU = _soru("Bu planı onaylıyor musunuz? (evet / hayır)", _ONAY_SECENEKLERI, False)

_TAKVIM_SORUSU = _soru(
    "Bu önerileri yazalım mı? 'evet', 'hayır' ya da eleme için '3 hariç' yazın.",
    _ONAY_SECENEKLERI,
    True,
)


# ------------------------------------------------------------------ ana giris


def timesheet_wizard(rt: "Runtime", args: dict[str, Any]) -> dict[str, Any]:
    """Tool giris noktasi: utterance + sessionState -> WizardResult."""
    utterance = str(args.get("utterance") or "").strip()
    token = args.get("sessionState")

    if not token:
        return _basla(rt)

    try:
        payload = verify_state(_secret(rt.config), str(token))
    except WizardStateError as exc:
        # Sessiz sifirlama YOK: neden bastan basladigimiz ACIKCA soylenir.
        return _basla(rt, onek=f"{exc} Sihirbaz BAŞTAN başlıyor. ")

    step = str(payload.get("step"))
    data = dict(payload.get("data") or {})

    if step == "start":
        return _secimi_isle(rt, utterance, data)
    if step == "pick_work":
        return _sureyi_isle(rt, utterance, data)
    if step == "duration":
        return _detayi_isle(rt, utterance, data)
    if step == "detail":
        return _stratejiyi_isle(rt, utterance, data)
    if step == "strategy":
        return _onayi_isle(rt, utterance, data)
    if step == "calendar_plan":
        return _takvim_cevabini_isle(rt, utterance, data)
    if step == "calendar_confirm":
        return _takvim_onayini_isle(rt, utterance, data)
    # write/done/confirm state'te SAKLANMAZ; gorulduyse state eski demektir.
    return _basla(rt, onek="Oturum tamamlanmış bir akışa ait. Sihirbaz BAŞTAN başlıyor. ")


# ------------------------------------------------------------------ adimlar


def _basla(rt: "Runtime", onek: str = "") -> dict[str, Any]:
    """start: whoami + baglam + acik isler; timeIncrement ACIKCA soylenir."""
    kim = _oku(rt, "whoami", {})
    ctx = _oku(rt, "context", {"personId": "$me"})
    increment = ctx.get("timeIncrement") or 60
    choices = _is_listesi(rt)

    isim = (kim.get("person") or {}).get("name") or "merhaba"
    satirlar = [
        f"{onek}Merhaba {isim}! Zaman girişi sihirbazındayız (mod: {kim.get('mode')}).",
        f"Bu hesapta timeIncrement {increment} dakikadır — süreler {increment} "
        "dakikanın katı olmak zorunda.",
        "Açık işlerin:",
    ]
    for index, c in enumerate(choices[:-1], start=1):
        satirlar.append(f"  {index}) [{c['_kind']}] {c['label']} — {c.get('detail')}")
    satirlar.append("Takvimden üretmek için 'takvim' yazabilirsin.")

    return _yanit(
        rt.config,
        step="start",
        reply="\n".join(satirlar),
        question=_secim_sorusu(choices),
        data={"personId": rt.adapter.resolve_person_id(None)},
    )


def _secimi_isle(rt: "Runtime", utterance: str, data: dict[str, Any]) -> dict[str, Any]:
    """pick_work: secilen isi dogrular, ozetler; sure sorusuna gecer."""
    if _takvim_istendi(utterance):
        return _takvim_plani(rt, data)

    choices = _is_listesi(rt)
    secim = secim_ayristir(utterance, choices)
    if secim is None:
        # displayId ile de secilebilsin (ornegin '70248').
        raw = utterance.strip()
        secim = next((c for c in choices if c["_displayId"] == raw), None)
    if secim is None:
        return _yanit(
            rt.config,
            step="start",
            reply=(
                "Cevabı anlayamadım. Listeden bir SIRA NUMARASI (örn. '1'), bir id "
                "ya da 'takvim' bekliyorum. Aynı soru tekrar aşağıda."
            ),
            question=_secim_sorusu(choices),
            data=data,
        )
    if secim["id"] == "takvim":
        return _takvim_plani(rt, data)

    data.update(
        {
            "targetType": secim["_kind"],
            "targetId": secim["id"],
            "targetLabel": secim["label"],
        }
    )
    return _yanit(
        rt.config,
        step="pick_work",
        reply=(
            f"Seçim: {secim['label']} ({secim['_kind']}). Şimdi süreye geçelim."
        ),
        question=_SURE_SORUSU,
        data=data,
    )


def _sureyi_isle(rt: "Runtime", utterance: str, data: dict[str, Any]) -> dict[str, Any]:
    """duration: sureyi ayristirir; '2 saat' -> 120 dk cevirimi ACIKCA soylenir."""
    if _takvim_istendi(utterance):
        return _takvim_plani(rt, data)

    sonuc = sure_ayristir(utterance)
    if sonuc is None:
        return _yanit(
            rt.config,
            step="pick_work",
            reply=(
                "Süreyi anlayamadım. Kabul ettiklerim: '2 saat', '1,5 saat', '90' "
                "(çıplak sayı DAKİKA demektir). Aynı soru tekrar aşağıda."
            ),
            question=_SURE_SORUSU,
            data=data,
        )

    dakika, saatle = sonuc
    ctx = _oku(rt, "context", {"personId": "$me"})
    increment = ctx.get("timeIncrement") or 60
    if dakika % increment != 0:
        alt = (dakika // increment) * increment
        ust = alt + increment
        oneriler = f"{alt} veya {ust}" if alt > 0 else str(ust)
        return _yanit(
            rt.config,
            step="pick_work",
            reply=(
                f"{dakika} dakika, hesabın timeIncrement değerinin ({increment} dk) "
                f"katı değil — sessizce yuvarlamıyorum. {oneriler} dakika yazabilirim; "
                "hangisini istersin? (Süreyi yeniden yaz.)"
            ),
            question=_SURE_SORUSU,
            data=data,
        )

    data["minutes"] = dakika
    cevirim = (
        f"'{utterance.strip()}' = {dakika} dakika olarak aldım (birim dakikadır)."
        if saatle
        else f"{dakika} dakika olarak aldım."
    )
    return _yanit(
        rt.config,
        step="duration",
        reply=f"{cevirim} Şimdi detaylar.",
        question=_DETAY_SORUSU,
        data=data,
    )


def _detayi_isle(rt: "Runtime", utterance: str, data: dict[str, Any]) -> dict[str, Any]:
    """detail: tarih (+ opsiyonel saat + aciklama) ayristirilir."""
    bugun = today_in(rt.config.timezone)
    gun: date | None = None
    saat: str | None = None
    kalan: list[str] = []

    for token in utterance.split():
        if gun is None:
            aday = tarih_ayristir(token, bugun)
            if aday is not None:
                gun = aday
                continue
        if saat is None and _SAAT_RE.match(token):
            saat = token
            continue
        kalan.append(token)

    if gun is None:
        return _yanit(
            rt.config,
            step="duration",
            reply=(
                "Tarihi anlayamadım. 'bugün', 'dün' ya da YYYY-AA-GG bekliyorum "
                "(örn. 'dün 14:00 VPN bakımı'). Aynı soru tekrar aşağıda."
            ),
            question=_DETAY_SORUSU,
            data=data,
        )

    en_eski = bugun - timedelta(days=rt.config.max_backdate_days)
    if gun < en_eski:
        return _yanit(
            rt.config,
            step="duration",
            reply=(
                f"En eski girilebilir tarih {iso_date(en_eski)} "
                f"(XURRENT_MAX_BACKDATE_DAYS={rt.config.max_backdate_days}). "
                f"Verilen: {iso_date(gun)}. Daha yeni bir tarih yazın."
            ),
            question=_DETAY_SORUSU,
            data=data,
        )
    if gun > bugun:
        return _yanit(
            rt.config,
            step="duration",
            reply="Gelecek tarihe zaman girişi yapılamaz. Tarihi yeniden yazın.",
            question=_DETAY_SORUSU,
            data=data,
        )

    data["date"] = iso_date(gun)
    if saat:
        data["startedAt"] = iso(local_datetime(gun, saat, rt.config.timezone))
    aciklama = " ".join(kalan).strip()
    if aciklama:
        data["description"] = aciklama[:80]

    ozet = [f"Tarih: {data['date']}"]
    if saat:
        ozet.append(f"başlangıç: {saat}")
    ozet.append(f"açıklama: {aciklama or '(yok)'}")
    return _yanit(
        rt.config,
        step="detail",
        reply=(
            ", ".join(ozet)
            + ". Şimdi yazma stratejisi — üçü de doğru cevap değil, raporlama "
            "ihtiyacın belirler."
        ),
        question=_STRATEJI_SORUSU,
        data=data,
    )


def _yazma_argumanlari(data: dict[str, Any], *, dry_run: bool) -> dict[str, Any]:
    args: dict[str, Any] = {
        "targetType": data.get("targetType"),
        "targetId": data.get("targetId"),
        "minutes": data.get("minutes"),
        "date": data.get("date"),
        "backdateStrategy": data.get("strategy"),
        "dryRun": dry_run,
    }
    if data.get("startedAt"):
        args["startedAt"] = data["startedAt"]
    if data.get("description"):
        args["description"] = data["description"]
    return {k: v for k, v in args.items() if v is not None}


def _stratejiyi_isle(rt: "Runtime", utterance: str, data: dict[str, Any]) -> dict[str, Any]:
    """strategy: secim ayristirilir, dryRun=true plan gosterilir, onay istenir."""
    secim = secim_ayristir(utterance, _STRATEJI_SECENEKLERI)
    if secim is None:
        return _yanit(
            rt.config,
            step="detail",
            reply=(
                "Stratejiyi anlayamadım. 1/2/3, id (two_step/link_first/date_first) "
                "ya da etiketle seçebilirsin. Aynı soru tekrar aşağıda."
            ),
            question=_STRATEJI_SORUSU,
            data=data,
        )

    data["strategy"] = secim["id"]
    dry = _yaz(rt, "create", _yazma_argumanlari(data, dry_run=True), onayli=False)
    if dry["errors"]:
        mesajlar = "; ".join(e.get("message", "?") for e in dry["errors"])
        return _yanit(
            rt.config,
            step="strategy",
            reply=f"Plan üretilemedi — işlem BAŞARISIZ: {mesajlar}",
            done=True,
            errors=dry["errors"],
        )

    data["plannedFingerprint"] = plan_fingerprint(dry["planned"])

    satirlar = [
        f"PLAN (dryRun=true — hiçbir şey yazılmadı). Strateji: {dry['strategy']}.",
        f"Hedef: {data.get('targetLabel') or data.get('targetId')} · "
        f"{data.get('minutes')} dk · tarih {data.get('date')}.",
        "Planlanan mutation'lar:",
    ]
    for adim in dry["planned"]:
        etiket = adim.get("stepLabel") or "-"
        satirlar.append(f"  [{etiket}] {adim.get('path')}")
    for uyari in dry["warnings"]:
        satirlar.append(f"  ! {uyari}")
    return _yanit(
        rt.config,
        step="strategy",
        reply="\n".join(satirlar),
        question=_ONAY_SORUSU,
        data=data,
    )


def _onayi_isle(rt: "Runtime", utterance: str, data: dict[str, Any]) -> dict[str, Any]:
    """confirm cevabi: evet -> write (fingerprint korumali), hayir -> iptal."""
    cevap = _temizle(utterance)
    if cevap in HAYIR_KUMESI:
        return _yanit(
            rt.config,
            step="done",
            reply="Vazgeçildi — hiçbir mutation gönderilmedi.",
            done=True,
        )
    if cevap not in EVET_KUMESI:
        return _yanit(
            rt.config,
            step="strategy",
            reply=(
                "Onay için 'evet' (ya da onay/tamam/e), vazgeçmek için 'hayır' "
                "(ya da iptal/vazgeç/h) bekliyorum."
            ),
            question=_ONAY_SORUSU,
            data=data,
        )

    # --- plannedFingerprint korumasi (contract/wizard.md §4) -------------
    dry = _yaz(rt, "create", _yazma_argumanlari(data, dry_run=True), onayli=False)
    guncel = plan_fingerprint(dry["planned"])
    if guncel != data.get("plannedFingerprint"):
        return _yanit(
            rt.config,
            step="write",
            reply=(
                "Onaylanan plan ile yazılmak istenen plan AYNI DEĞİL "
                "(plannedFingerprint uyuşmuyor) — yazma REDDEDİLDİ. "
                "Sihirbazı baştan çalıştırın."
            ),
            done=True,
            errors=[
                {
                    "message": (
                        "plannedFingerprint uyuşmuyor: onaylanandan farklı bir plan "
                        "yazdırılmak istendi. Yazma REDDEDİLDİ."
                    ),
                    "path": ["sessionState"],
                }
            ],
        )

    # --- gercek yazma: sihirbazin confirm'i ONAYDIR, yeniden sorulmaz ----
    sonuc = _yaz(rt, "create", _yazma_argumanlari(data, dry_run=False), onayli=True)
    if sonuc["errors"]:
        mesajlar = "; ".join(e.get("message", "?") for e in sonuc["errors"])
        return _yanit(
            rt.config,
            step="write",
            reply=f"Yazma BAŞARISIZ: {mesajlar}",
            done=True,
            write_result=sonuc,
            errors=sonuc["errors"],
        )

    # --- geri-okuma: yazma raporuna guvenme, kaydi GERI OKU (§5) --------
    bugun = iso_date(today_in(rt.config.timezone))
    tarih = str(data.get("date") or bugun)
    geri = _oku(
        rt,
        "list_entries",
        {
            "personId": data.get("personId") or "$me",
            "dateFrom": min(tarih, bugun),
            "dateTo": max(tarih, bugun),
            "first": 100,
        },
    )
    entry = sonuc.get("timeEntry") or {}
    satirlar = [
        (
            "Dedup: aynı sourceID'li kayıt zaten vardı — yazma ATLANDI, mevcut "
            "kayıt döndürüldü."
            if sonuc.get("deduped")
            else f"Yazıldı: {data.get('minutes')} dk, kayıt id {entry.get('id')}."
        ),
        (
            f"Geri-okuma doğrulaması: {min(tarih, bugun)}–{max(tarih, bugun)} "
            f"aralığında {len(geri['timeEntries'])} kayıt, toplam "
            f"{geri['totalMinutes']} dakika görünüyor."
        ),
    ]
    for uyari in sonuc["warnings"]:
        satirlar.append(f"! {uyari}")
    return _yanit(
        rt.config,
        step="write",
        reply="\n".join(satirlar),
        done=True,
        write_result=sonuc,
    )


# ------------------------------------------------------------------ takvim kolu


def _takvim_ozeti(entries: list[dict[str, Any]]) -> list[str]:
    satirlar = []
    for index, e in enumerate(entries, start=1):
        satirlar.append(
            f"  {index}) {e.get('description') or '(başlıksız)'} — {e['minutes']} dk "
            f"→ {e.get('_targetLabel') or e['targetId']}"
        )
    toplam = sum(int(e["minutes"]) for e in entries)
    satirlar.append(f"Toplam: {len(entries)} kalem, {toplam} dakika.")
    return satirlar


def _takvim_plani(rt: "Runtime", data: dict[str, Any]) -> dict[str, Any]:
    """calendar_plan: takvim + acik is eslesmesinden ONERI listesi (asla yazmaz)."""
    plan = _oku(rt, "calendar_plan", {"personId": "$me"})
    yazilabilir: list[dict[str, Any]] = []
    bekleyen: list[str] = []
    for p in plan["proposals"]:
        if p.get("suggestedTargetType") and p.get("suggestedTargetId") and not p.get("needsUserDecision"):
            yazilabilir.append(
                {
                    "targetType": p["suggestedTargetType"],
                    "targetId": p["suggestedTargetId"],
                    "minutes": int(p["roundedMinutes"]),
                    "date": plan["date"],
                    "startedAt": p.get("startedAt"),
                    "description": str(p["meetingTitle"])[:80],
                    "_targetLabel": p.get("suggestedTargetLabel"),
                }
            )
        else:
            bekleyen.append(str(p["meetingTitle"]))

    if not yazilabilir:
        return _yanit(
            rt.config,
            step="calendar_plan",
            reply=(
                "Takvimden yazılabilir bir öneri çıkmadı"
                + (f" ({len(bekleyen)} toplantı kullanıcı kararı bekliyor)" if bekleyen else "")
                + ". Sihirbazı yeniden başlatabilirsin."
            ),
            done=True,
        )

    satirlar = ["Takvimden üretilen öneriler (henüz HİÇBİR ŞEY yazılmadı):"]
    satirlar.extend(_takvim_ozeti(yazilabilir))
    if bekleyen:
        satirlar.append(
            f"Karar bekleyen ve LİSTEYE ALINMAYAN toplantılar: {', '.join(bekleyen)}."
        )
    data["calendarDraft"] = yazilabilir
    return _yanit(
        rt.config,
        step="calendar_plan",
        reply="\n".join(satirlar),
        question=_TAKVIM_SORUSU,
        data=data,
    )


def _takvim_cevabini_isle(rt: "Runtime", utterance: str, data: dict[str, Any]) -> dict[str, Any]:
    cevap = _temizle(utterance)
    draft: list[dict[str, Any]] = list(data.get("calendarDraft") or [])

    eleme = _ELEME_RE.match(cevap)
    if eleme:
        index = int(eleme.group(1))
        if 1 <= index <= len(draft):
            cikarilan = draft.pop(index - 1)
            if not draft:
                return _yanit(
                    rt.config,
                    step="done",
                    reply="Tüm kalemler elendi — yazılacak bir şey kalmadı.",
                    done=True,
                )
            data["calendarDraft"] = draft
            satirlar = [
                f"'{cikarilan.get('description')}' listeden çıkarıldı. Güncel liste:"
            ]
            satirlar.extend(_takvim_ozeti(draft))
            return _yanit(
                rt.config,
                step="calendar_plan",
                reply="\n".join(satirlar),
                question=_TAKVIM_SORUSU,
                data=data,
            )
        return _yanit(
            rt.config,
            step="calendar_plan",
            reply=f"Listede {index} numaralı kalem yok ({len(draft)} kalem var).",
            question=_TAKVIM_SORUSU,
            data=data,
        )

    if cevap in HAYIR_KUMESI:
        return _yanit(
            rt.config,
            step="done",
            reply="Vazgeçildi — hiçbir mutation gönderilmedi.",
            done=True,
        )
    if cevap not in EVET_KUMESI:
        return _yanit(
            rt.config,
            step="calendar_plan",
            reply=(
                "'evet', 'hayır' ya da eleme için '3 hariç' bekliyorum. "
                "Aynı soru tekrar aşağıda."
            ),
            question=_TAKVIM_SORUSU,
            data=data,
        )

    entries = [{k: v for k, v in e.items() if not k.startswith("_")} for e in draft]
    dry = _yaz(rt, "bulk", {"entries": entries, "dryRun": True}, onayli=False)
    if dry["summary"]["failed"]:
        hatalar = [
            hata for satir in dry["results"] for hata in (satir.get("errors") or [])
        ]
        mesajlar = "; ".join(h.get("message", "?") for h in hatalar) or "bilinmeyen hata"
        return _yanit(
            rt.config,
            step="calendar_plan",
            reply=f"Toplu plan üretilemedi — işlem BAŞARISIZ: {mesajlar}",
            done=True,
            errors=hatalar,
        )

    data["plannedFingerprint"] = plan_fingerprint(dry["planned"])
    toplam = sum(int(e["minutes"]) for e in entries)
    return _yanit(
        rt.config,
        step="calendar_confirm",
        reply=(
            f"Toplu dry-run özeti: {len(entries)} kalem, toplam {toplam} dakika, "
            f"{len(dry['planned'])} mutation planlandı. "
            "DİKKAT: toplu yazma ATOMİK DEĞİLDİR — kısmi başarı olabilir; "
            "sonuç satır satır raporlanır."
        ),
        question=_ONAY_SORUSU,
        data=data,
    )


def _takvim_onayini_isle(rt: "Runtime", utterance: str, data: dict[str, Any]) -> dict[str, Any]:
    cevap = _temizle(utterance)
    if cevap in HAYIR_KUMESI:
        return _yanit(
            rt.config,
            step="done",
            reply="Vazgeçildi — hiçbir mutation gönderilmedi.",
            done=True,
        )
    if cevap not in EVET_KUMESI:
        return _yanit(
            rt.config,
            step="calendar_confirm",
            reply="Onay için 'evet', vazgeçmek için 'hayır' bekliyorum.",
            question=_ONAY_SORUSU,
            data=data,
        )

    draft: list[dict[str, Any]] = list(data.get("calendarDraft") or [])
    entries = [{k: v for k, v in e.items() if not k.startswith("_")} for e in draft]

    dry = _yaz(rt, "bulk", {"entries": entries, "dryRun": True}, onayli=False)
    guncel = plan_fingerprint(dry["planned"])
    if guncel != data.get("plannedFingerprint"):
        return _yanit(
            rt.config,
            step="write",
            reply=(
                "Onaylanan toplu plan ile yazılmak istenen plan AYNI DEĞİL "
                "(plannedFingerprint uyuşmuyor) — yazma REDDEDİLDİ."
            ),
            done=True,
            errors=[
                {
                    "message": "plannedFingerprint uyuşmuyor — toplu yazma REDDEDİLDİ.",
                    "path": ["sessionState"],
                }
            ],
        )

    sonuc = _yaz(rt, "bulk", {"entries": entries, "dryRun": False}, onayli=True)
    ozet = sonuc["summary"]

    tarih = str(entries[0].get("date")) if entries else iso_date(today_in(rt.config.timezone))
    bugun = iso_date(today_in(rt.config.timezone))
    geri = _oku(
        rt,
        "list_entries",
        {
            "personId": data.get("personId") or "$me",
            "dateFrom": min(tarih, bugun),
            "dateTo": max(tarih, bugun),
            "first": 100,
        },
    )

    hatalar = [h for satir in sonuc["results"] for h in (satir.get("errors") or [])]
    satirlar = [
        (
            f"Toplu yazma bitti (ATOMİK DEĞİLDİ): istenen {ozet['requested']}, "
            f"oluşan {ozet['created']}, dedup {ozet.get('deduped', 0)}, "
            f"başarısız {ozet['failed']}, atlanan {ozet['skipped']} — "
            f"bu koşuda yazılan {ozet['totalMinutes']} dakika."
        ),
        (
            f"Geri-okuma doğrulaması: {min(tarih, bugun)}–{max(tarih, bugun)} "
            f"aralığında {len(geri['timeEntries'])} kayıt, toplam "
            f"{geri['totalMinutes']} dakika görünüyor."
        ),
    ]
    return _yanit(
        rt.config,
        step="write",
        reply="\n".join(satirlar),
        done=True,
        errors=hatalar,
    )


__all__ = [
    "EVET_KUMESI",
    "HAYIR_KUMESI",
    "WIZARD_STEPS",
    "WizardStateError",
    "katla",
    "plan_fingerprint",
    "secim_ayristir",
    "sign_state",
    "sure_ayristir",
    "tarih_ayristir",
    "timesheet_wizard",
    "verify_state",
]
