"""Onay talebi uretimi + `requestState` imzalama/dogrulama.

BU MODUL PROTOKOL BILMEZ. Yalnizca "kullaniciya sorulacak sey nedir" ve
"onayin kendisi nasil kurcalanmaya karsi korunur" sorularini cevaplar.
Sorunun v1'de `elicitation/create` istegi, v2'de `InputRequiredResult` sonucu
olarak gonderildigini yalnizca mcp/v1.py ve mcp/v2.py bilir.

NEDEN IMZA GEREKIYOR (contract/protocol.md):
MRTR'de `requestState` client uzerinden gecer ve spec onu ACIKCA
"saldirgan kontrolundeki girdi" sayar. Bizim blob'umuz sunu tasiyor:
"kullanici X, Request #70248'e 120 dakika yazmayi onayladi."
Imzasiz birakilirsa client bunu degistirip BASKA ticket'a BASKA sure yazdirabilir.

Icine gomulenler ve her birinin engelledigi saldiri:
  principal    -> baska kullanicinin onayini calip kendine kullanma
  exp          -> eski bir onayi aylar sonra tekrar oynatma (replay penceresi)
  fingerprint  -> "60 dakika" onayini alip "600 dakika" cagrisina iliştirme
  nonce        -> ayni onayi iki kez kullanma (surec ici tek kullanimlik set)

Spec'in uyarisi aynen gecerli: bu onlemler replay penceresini daraltir ve
capraz kullanici/capraz istek kullanimini engeller ama tek kullanimi TEK BASINA
garanti etmez — onu sunucu tarafinda zorlamak gerekir. `nonce` seti tam olarak
bunu yapar.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

# Onay formunda kullanicinin isaretleyecegi alan. Tek alan, tek anlam.
CONFIRM_FIELD = "onay"

# InputRequiredResult.input_requests sozlugunun anahtari. Client cevabi ayni
# anahtarla geri getirir.
CONFIRM_KEY = "zaman-girisi-onayi"


class StateError(Exception):
    """requestState dogrulanamadi. Mesaj TURKCE ve kullaniciya gosterilebilir."""


@dataclass(frozen=True)
class ConfirmationPrompt:
    """Kullaniciya sorulacak onay — protokolden bagimsiz gosterim.

    `message` insan icindir; `summary` log/UI icin yapisal ozettir;
    `requested_schema` elicitation form semasidir (v1 ve v2'de AYNI sema
    kullanilir — degisen yalnizca tasima bicimi).
    """

    tool_name: str
    message: str
    summary: dict[str, Any]
    requested_schema: dict[str, Any]


def build_prompt(tool_name: str, message: str, summary: dict[str, Any]) -> ConfirmationPrompt:
    """Onay formunu kurar. Sema kasitli olarak TEK boolean alandir.

    NEDEN tek alan: onay bir VERI TOPLAMA degil, bir SINIRDIR. Kullaniciya
    "kac dakika?" diye sormuyoruz — o zaten arguman olarak geldi ve fingerprint
    ile kilitlendi. Sorulan tek sey: "bunu yazayim mi?"
    """
    return ConfirmationPrompt(
        tool_name=tool_name,
        message=message,
        summary=summary,
        requested_schema={
            "type": "object",
            "required": [CONFIRM_FIELD],
            "properties": {
                CONFIRM_FIELD: {
                    "type": "boolean",
                    "title": "Onaylıyor musunuz?",
                    "description": message,
                }
            },
        },
    )


# ------------------------------------------------------------------ imzalama


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def fingerprint(method: str, arguments: dict[str, Any] | None) -> str:
    """Metod adi + tool argumanlarinin SHA-256 ozeti.

    sort_keys=True ZORUNLU: dict siralamasi degisirse ozet degisir ve gecerli
    bir onay bosuna reddedilir. separators ile bosluk farklari da elenir.
    """
    canonical = json.dumps(
        {"method": method, "arguments": arguments or {}},
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


@dataclass
class StateSigner:
    """HMAC-SHA256 ile imzalanmis `requestState` uretir ve dogrular.

    XURRENT_STATE_SECRET bossa surec basinda rastgele bir anahtar uretilir.
    Bu KASITLIDIR: sunucu yeniden baslayinca eski onaylar gecersiz olur.
    """

    secret: bytes
    ttl_seconds: int = 300
    # Tek kullanimlik nonce seti. Surec ici — stateless protokolde "sunucu hicbir
    # sey hatirlamaz" kuralinin TEK istisnasi budur ve sebebi tek kullanimi
    # zorlamaktir. HTTP'de coklu surec varsa paylasimli bir store gerekir.
    _used_nonces: set[str] = field(default_factory=set)

    @classmethod
    def create(cls, secret_text: str = "", ttl_seconds: int = 300) -> "StateSigner":
        if secret_text:
            secret = secret_text.encode("utf-8")
        else:
            # Rastgele anahtar: yeniden baslatinca eski state'ler gecersiz olur.
            secret = secrets.token_bytes(32)
        return cls(secret=secret, ttl_seconds=max(1, ttl_seconds))

    def issue(self, *, principal: str, method: str, arguments: dict[str, Any] | None) -> str:
        payload = {
            "v": 1,
            "principal": principal,
            "method": method,
            "fingerprint": fingerprint(method, arguments),
            "nonce": secrets.token_urlsafe(16),
            "iat": int(time.time()),
            "exp": int(time.time()) + self.ttl_seconds,
        }
        body = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        body_bytes = body.encode("utf-8")
        signature = hmac.new(self.secret, body_bytes, hashlib.sha256).digest()
        return f"{_b64url(body_bytes)}.{_b64url(signature)}"

    def verify(
        self, token: str, *, principal: str, method: str, arguments: dict[str, Any] | None
    ) -> dict[str, Any]:
        """Dogrular ve nonce'u TUKETIR. Basarisizsa StateError firlatir.

        Cagiran taraf StateError'u yakalayip isError=true + Turkce aciklama
        dondurmek ZORUNDADIR. Yazma YAPILMAZ.
        """
        parts = token.split(".")
        if len(parts) != 2:
            raise StateError(
                "requestState bicimi bozuk (beklenen 'govde.imza'). Onay gecersiz — "
                "hicbir sey yazilmadi."
            )
        body_raw, signature_raw = parts
        try:
            body_bytes = _b64url_decode(body_raw)
            signature = _b64url_decode(signature_raw)
        except Exception as exc:  # noqa: BLE001
            raise StateError(
                f"requestState base64url olarak cozulemedi ({exc}). Onay gecersiz — "
                "hicbir sey yazilmadi."
            ) from exc

        expected = hmac.new(self.secret, body_bytes, hashlib.sha256).digest()
        # compare_digest: sabit zamanli karsilastirma. == kullanmak imzayi
        # byte byte tahmin etmeye izin veren bir zamanlama sizintisidir.
        if not hmac.compare_digest(expected, signature):
            raise StateError(
                "requestState IMZASI GECERSIZ — blob kurcalanmis olabilir. "
                "Yazma REDDEDILDI."
            )

        try:
            payload = json.loads(body_bytes.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise StateError(f"requestState govdesi JSON degil ({exc}). Yazma REDDEDILDI.") from exc

        if int(payload.get("exp", 0)) < int(time.time()):
            raise StateError(
                f"requestState suresi doldu (TTL {self.ttl_seconds} sn). Onayi yenileyin — "
                "hicbir sey yazilmadi."
            )

        if payload.get("principal") != principal:
            raise StateError(
                "requestState BASKA bir kullaniciya ait (principal uyusmuyor). "
                "Yazma REDDEDILDI."
            )

        if payload.get("fingerprint") != fingerprint(method, arguments):
            raise StateError(
                "requestState BASKA bir cagriya ait (arguman parmak izi uyusmuyor). "
                "Onaylanan islem ile yapilmak istenen islem AYNI DEGIL — yazma REDDEDILDI."
            )

        nonce = str(payload.get("nonce", ""))
        if not nonce or nonce in self._used_nonces:
            raise StateError(
                "requestState DAHA ONCE kullanilmis (nonce tekrari). Her onay yalnizca "
                "bir kez gecerlidir — yazma REDDEDILDI."
            )
        self._used_nonces.add(nonce)
        return payload


__all__ = [
    "CONFIRM_FIELD",
    "CONFIRM_KEY",
    "ConfirmationPrompt",
    "StateError",
    "StateSigner",
    "build_prompt",
    "fingerprint",
]
