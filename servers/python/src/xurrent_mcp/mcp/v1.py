"""2025-11-25 adaptoru — sunucu-baslatmali `elicitation/create`.

    client ---- tools/call -----------------> server
    client <--- elicitation/create ---------- server   <- sunucu ISTEK gonderiyor
    client ---- ElicitResult ---------------> server
    client <--- CallToolResult -------------- server

Sunucu, islemin ORTASINDA client'a bir ISTEK gonderir. Bu kalici cift yonlu bir
baglanti gerektirir — yani sunucu stateful'dur. `await` satiri tam olarak burasi:
handler, cevap gelene kadar acik durur.

v2'de bu satir YOK olur; farki gormek icin v2.py ile yan yana okuyun.
"""

from __future__ import annotations

import logging
from typing import Any

import mcp_types as types

from ..core.toolimpl import ConfirmationRequired, ToolResult, run_tool
from ..tools import Runtime
from . import common

log = logging.getLogger(__name__)


async def call_tool(
    rt: Runtime,
    ctx: Any,
    params: types.CallToolRequestParams,
) -> types.CallToolResult:
    """tools/call — v1 kabugu."""
    name = params.name
    args = dict(params.arguments or {})
    can_confirm = common.client_can_confirm(ctx)

    try:
        outcome = run_tool(rt, name, args, can_confirm=can_confirm)
    except Exception as exc:  # noqa: BLE001
        log.exception("Tool basarisiz: %s", name)
        return common.error_result(f"'{name}' tool'u çalıştırılamadı: {exc}")

    if isinstance(outcome, ToolResult):
        return common.success_result(outcome)

    assert isinstance(outcome, ConfirmationRequired)

    try:
        # ISTE O SATIR: sunucu client'a istek gonderiyor ve CEVABI BEKLIYOR.
        # Bu bekleme, protokolun stateful olmasinin ta kendisidir.
        elicited = await ctx.session.elicit_form(
            message=outcome.prompt.message,
            requested_schema=outcome.prompt.requested_schema,
            related_request_id=ctx.request_id,
        )
    except Exception as exc:  # noqa: BLE001
        # Geri kanal yoksa (NoBackChannelError) veya client hata dondurduyse:
        # onay ADIMI atlanir, karar yazma tool'unun politika koluna kalir.
        log.warning("elicitation/create basarisiz (%s) — politika koluna dusuluyor", exc)
        try:
            fallback = run_tool(rt, name, args, can_confirm=False)
        except Exception as inner:  # noqa: BLE001
            log.exception("Tool basarisiz: %s", name)
            return common.error_result(f"'{name}' tool'u çalıştırılamadı: {inner}")
        assert isinstance(fallback, ToolResult)
        return common.success_result(fallback)

    if not common.accepted(elicited):
        return common.error_result(common.declined_message(name))

    try:
        confirmed = run_tool(rt, name, args, can_confirm=True, confirmed=True)
    except Exception as exc:  # noqa: BLE001
        log.exception("Tool basarisiz: %s", name)
        return common.error_result(f"'{name}' tool'u çalıştırılamadı: {exc}")

    assert isinstance(confirmed, ToolResult)
    return common.success_result(confirmed)


__all__ = ["call_tool"]
