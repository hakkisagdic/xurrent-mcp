"""Gemini `generateContent` istemcisi — SDK YOK, duz httpx.

NEDEN SDK yok: bu bir ders projesi. Wire formati gorunur kalmali. Ayrica httpx
zaten bagimlilik listesinde (Xurrent GraphQL icin); tek bir uc nokta icin ikinci
bir SDK eklemek hem bagimliligi hem de "sihir" miktarini artirirdi.

UC NOKTA
    POST {BASE}/v1beta/models/{model}:generateContent
    BASE varsayilan https://generativelanguage.googleapis.com
    GEMINI_BASE_URL ile degistirilebilir (sahte sunucuya yonlendirmek icin).

AUTH
    ★ Anahtar `x-goog-api-key` HEADER'inda gider. URL query parametresine
      KOYULMAZ: query string ters vekil, CDN ve erisim loglarina duser; bir kez
      dustu mu anahtar sizmis sayilir. Sahte sunucu da bu kurali zorlar
      (header yoksa 401 doner).

CEVAP
    { candidates: [{ content: {role, parts}, finishReason }], usageMetadata }
    ★ HTTP 200 olsa BILE govdede `error` alani gelebilir. Ikisi de kontrol edilir.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"

# Rol eslemesi. Gemini'de "system" rolu YOKTUR — sistem mesaji contents'e
# konmaz, ayri `systemInstruction` alanina konur.
ROLE_USER = "user"
ROLE_MODEL = "model"

# finishReason -> Turkce aciklama. STOP disindaki her sey kullaniciya
# ACIKCA soylenir; sessizce yarim cevap dondurmek en kotu davranistir.
FINISH_REASONS: dict[str, str] = {
    "MAX_TOKENS": "Model cikti sinirina takildi; cevap YARIM kalmis olabilir.",
    "SAFETY": "Model cevabi guvenlik filtresi nedeniyle durdurdu.",
    "RECITATION": "Model cevabi ezber/alinti filtresi nedeniyle durdurdu.",
    "PROHIBITED_CONTENT": "Model istegi yasakli icerik gerekcesiyle reddetti.",
    "SPII": "Model cevabi hassas kisisel veri gerekcesiyle durdurdu.",
    "BLOCKLIST": "Model cevabi engellenmis terim listesi nedeniyle durdurdu.",
    "MALFORMED_FUNCTION_CALL": (
        "Model bozuk bir tool cagrisi uretti. Genellikle sema cok karmasik "
        "veya cok derin oldugunda olur."
    ),
    "OTHER": "Model cevabi bilinmeyen bir nedenle durdurdu.",
}


class GeminiError(RuntimeError):
    """Gemini API'sinden gelen ya da baglanti sirasinda olusan hata."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class GeminiResponse:
    """Tek bir generateContent cevabinin ise yarayan parcalari."""

    parts: list[dict[str, Any]]
    finish_reason: str | None
    usage: dict[str, Any]
    raw: dict[str, Any]

    @property
    def text(self) -> str:
        """parts icindeki tum metin parcalarini birlestirir."""
        return "\n".join(
            p["text"] for p in self.parts if isinstance(p.get("text"), str) and p["text"]
        ).strip()

    @property
    def function_calls(self) -> list[dict[str, Any]]:
        """parts icindeki functionCall'lar. Paralel cagri MUMKUNDUR."""
        return [p["functionCall"] for p in self.parts if isinstance(p.get("functionCall"), dict)]

    @property
    def finish_warning(self) -> str | None:
        if not self.finish_reason or self.finish_reason == "STOP":
            return None
        return FINISH_REASONS.get(self.finish_reason, f"Model '{self.finish_reason}' ile durdu.")


class GeminiClient:
    """Senkron `generateContent` istemcisi.

    Tek bir httpx.Client'i yeniden kullanir — baglanti havuzu, chatbot'un
    tool dongusunde her turda yeni TLS el sikismasi yapmasini onler.
    """

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 120.0,
        client: httpx.Client | None = None,
    ) -> None:
        if not api_key:
            raise GeminiError(
                "GEMINI_API_KEY tanimli degil. Chatbot icin gereklidir. "
                "Sadece MCP sunucusu kullanacaksaniz gerekmez — LLM'i host uygulama saglar."
            )
        self.api_key = api_key
        self.model = model
        self.base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self._client = client or httpx.Client(timeout=timeout)

    # ── ic yardimcilar ──

    def _url(self) -> str:
        # ★ Anahtar URL'e EKLENMEZ. Yalnizca model adi yola girer.
        return f"{self.base_url}/v1beta/models/{self.model}:generateContent"

    @staticmethod
    def _error_text(payload: Any, fallback: str) -> tuple[str, str | None]:
        if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
            err = payload["error"]
            message = str(err.get("message") or fallback)
            status = err.get("status")
            return message, (str(status) if status else None)
        return fallback, None

    # ── genel API ──

    def generate(
        self,
        *,
        contents: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        system_instruction: str | None = None,
        generation_config: dict[str, Any] | None = None,
    ) -> GeminiResponse:
        """Tek bir generateContent turu calistirir."""
        body: dict[str, Any] = {"contents": contents}
        if tools:
            body["tools"] = tools
        if system_instruction:
            # ★ Sistem mesaji contents icine KONMAZ. Gemini'de "system" rolu
            #   yoktur; contents'e {"role":"system"} koymak 400 verir.
            body["systemInstruction"] = {"parts": [{"text": system_instruction}]}
        if generation_config:
            body["generationConfig"] = generation_config

        try:
            response = self._client.post(
                self._url(),
                json=body,
                headers={
                    "x-goog-api-key": self.api_key,  # ★ header, query DEGIL
                    "content-type": "application/json",
                },
            )
        except httpx.HTTPError as exc:
            raise GeminiError(f"Gemini'ye baglanilamadi: {exc}") from exc

        try:
            payload = response.json()
        except ValueError:
            raise GeminiError(
                f"Gemini gecerli JSON dondurmedi (HTTP {response.status_code}): "
                f"{response.text[:200]}",
                status=response.status_code,
            ) from None

        if response.status_code >= 400:
            message, code = self._error_text(payload, f"HTTP {response.status_code}")
            raise GeminiError(
                f"Gemini API hatasi (HTTP {response.status_code}): {message}",
                status=response.status_code,
                code=code,
            )

        # ★ HTTP 200 + govdede error. Gercek API'de gorulur; sadece status'e
        #   bakan istemci burada sessizce bos cevap isler.
        if isinstance(payload, dict) and payload.get("error"):
            message, code = self._error_text(payload, "bilinmeyen hata")
            raise GeminiError(f"Gemini API hatasi (govde): {message}", status=200, code=code)

        candidates = payload.get("candidates") if isinstance(payload, dict) else None
        if not candidates:
            # Prompt engellenmis olabilir; gerekce promptFeedback'te durur.
            feedback = (payload or {}).get("promptFeedback") or {}
            reason = feedback.get("blockReason")
            if reason:
                raise GeminiError(f"Gemini istegi engelledi (promptFeedback.blockReason={reason}).")
            raise GeminiError("Gemini bos cevap dondurdu (candidates yok).")

        candidate = candidates[0] or {}
        content = candidate.get("content") or {}
        parts = content.get("parts") or []
        if not isinstance(parts, list):
            parts = []

        return GeminiResponse(
            parts=[p for p in parts if isinstance(p, dict)],
            finish_reason=candidate.get("finishReason"),
            usage=(payload.get("usageMetadata") or {}) if isinstance(payload, dict) else {},
            raw=payload if isinstance(payload, dict) else {},
        )

    def close(self) -> None:
        self._client.close()


# ── contents kurucu yardimcilari ────────────────────────────────────────────


def user_text(text: str) -> dict[str, Any]:
    return {"role": ROLE_USER, "parts": [{"text": text}]}


def model_parts(parts: list[dict[str, Any]]) -> dict[str, Any]:
    """Modelin URETTIGI parts'i gecmise oldugu gibi geri koyar.

    ★ functionCall parcasi AYNEN saklanir (id dahil). Yeniden uretmek veya
      sadelestirmek, bir sonraki turda functionResponse eslesmesini bozar.
    """
    return {"role": ROLE_MODEL, "parts": parts}


def function_response(call: dict[str, Any], response: Any) -> dict[str, Any]:
    """Tool sonucunu Gemini'nin bekledigi `functionResponse` parcasina cevirir.

    ★ ID ESLESMESI: functionResponse.id, functionCall.id ile AYNI olmak
      ZORUNDADIR — API paralel cagrilari yalnizca bu id ile eslestirir.
      Model id ureTMEDIYSE (tek cagrida sik olur) biz de id GONDERMEYIZ;
      uydurulmus bir id eslesmeyi bozar.

    ★ `response` bir OBJE olmali. Duz string/sayi gondermek 400 verir; bu
      yuzden dict olmayan her sey {"result": ...} icine sarilir.
    """
    payload = response if isinstance(response, dict) else {"result": response}
    part: dict[str, Any] = {"name": call.get("name"), "response": payload}
    call_id = call.get("id")
    if call_id:
        part["id"] = call_id
    return {"functionResponse": part}


def function_responses_turn(parts: list[dict[str, Any]]) -> dict[str, Any]:
    """Tool sonuclari KULLANICI rolunde doner — Gemini sozlesmesi boyle.

    Sezgiye aykiridir ("sonucu ben urettim, model degil") ama dogru olan budur:
        {role:"model", parts:[{functionCall}]}      <- modelin cagrisi
        {role:"user",  parts:[{functionResponse}]}  <- bizim sonucumuz
    """
    return {"role": ROLE_USER, "parts": parts}


__all__ = [
    "DEFAULT_BASE_URL",
    "FINISH_REASONS",
    "GeminiClient",
    "GeminiError",
    "GeminiResponse",
    "function_response",
    "function_responses_turn",
    "model_parts",
    "user_text",
]
