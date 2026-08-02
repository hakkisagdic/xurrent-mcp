"""2026-07-28 adaptoru — MRTR (Multi Round-Trip Requests).

    client ---- tools/call (id:1) ---------> server
    client <--- InputRequiredResult --------- server   <- bu bir SONUC, istek degil
           -- kullaniciya sorulur --
    client ---- tools/call (id:2) ---------> server   <- AYNI istek, YENI id
                  + inputResponses + requestState
    client <--- CallToolResult -------------- server

Ilk istek SONLANIR. Sunucu hicbir state tutmaz — ihtiyaci olan her seyi
`requestState` icine kodlar ve client onu geri getirir. v1.py'deki `await
ctx.session.elicit_form(...)` satirinin karsiligi burada YOKTUR; onun yerine
bir `return` vardir. Farkin tamami budur.

GUVENLIK: `requestState` client uzerinden gectigi icin spec onu ACIKCA
"saldirgan kontrolundeki girdi" sayar. Dogrulama core/confirm.py'de yapilir;
basarisizsa yazma YAPILMAZ, isError=true + Turkce aciklama doner.
"""

from __future__ import annotations

import logging
from typing import Any

import mcp_types as types

from ..core.confirm import CONFIRM_KEY, StateError, StateSigner
from ..core.toolimpl import ConfirmationRequired, ToolResult, run_tool
from ..tools import Runtime
from . import common

log = logging.getLogger(__name__)


async def call_tool(
    rt: Runtime,
    signer: StateSigner,
    ctx: Any,
    params: types.CallToolRequestParams,
) -> types.CallToolResult | types.InputRequiredResult:
    """tools/call — v2 kabugu."""
    name = params.name
    args = dict(params.arguments or {})
    # principal = authenticated person id. requestState'e gomulur ki baska bir
    # kullanicinin onayi calinip kullanilamasin.
    # try/except SART: canli modda bu cagri Xurrent'a gider ve token/ag hatasi
    # firlatabilir. Korumasiz birakilirsa istisna JSON-RPC -32603'e donusur ve
    # kullanici "Internal server error" gorur — is kurali hatalari isError=true
    # + okunabilir TURKCE metin ile donmelidir.
    try:
        principal = rt.adapter.resolve_person_id(None)
    except Exception as exc:  # noqa: BLE001
        log.exception("Authenticated kullanici cozulemedi")
        return common.error_result(
            "Kimlik çözülemedi — Xurrent'a ulaşılamıyor veya token geçersiz olabilir: "
            f"{exc}"
        )

    request_state = getattr(params, "request_state", None)
    input_responses = getattr(params, "input_responses", None) or {}

    # ---- 2. tur: client onayi geri getirdi -------------------------------
    if request_state:
        try:
            signer.verify(request_state, principal=principal, method=name, arguments=args)
        except StateError as exc:
            # Dogrulama basarisiz -> YAZMA YAPILMAZ.
            log.warning("requestState dogrulanamadi: %s", exc)
            return common.error_result(f"Onay doğrulanamadı: {exc}")

        answer = input_responses.get(CONFIRM_KEY)
        if not common.accepted(answer):
            return common.error_result(common.declined_message(name))

        try:
            confirmed = run_tool(rt, name, args, can_confirm=True, confirmed=True)
        except Exception as exc:  # noqa: BLE001
            log.exception("Tool basarisiz: %s", name)
            return common.error_result(f"'{name}' tool'u çalıştırılamadı: {exc}")
        assert isinstance(confirmed, ToolResult)
        return common.success_result(confirmed)

    # ---- 1. tur: normal cagri --------------------------------------------
    can_confirm = common.client_can_confirm(ctx)
    try:
        outcome = run_tool(rt, name, args, can_confirm=can_confirm)
    except Exception as exc:  # noqa: BLE001
        log.exception("Tool basarisiz: %s", name)
        return common.error_result(f"'{name}' tool'u çalıştırılamadı: {exc}")

    if isinstance(outcome, ToolResult):
        return common.success_result(outcome)

    assert isinstance(outcome, ConfirmationRequired)

    # Sunucu SORU SORMAZ; "eksik bilgi var" diye SONUC doner ve istek biter.
    return types.InputRequiredResult(
        input_requests={
            CONFIRM_KEY: types.ElicitRequest(params=common.elicit_params(outcome.prompt))
        },
        request_state=signer.issue(
            principal=principal,
            method=name,
            # Parmak izi ORIJINAL argumanlardan alinir: client tekrar cagrida
            # argumanlari degistirirse (60 -> 600 dakika) dogrulama patlar.
            arguments=outcome.arguments,
        ),
    )


__all__ = ["call_tool"]
