"""Iki adaptorun paylastigi MCP parcalari.

Burada YALNIZCA protokol tipleri ile core arasindaki ceviri yasar. Is mantigi
yoktur; tek satir Xurrent bilgisi yoktur.
"""

from __future__ import annotations

import logging
from typing import Any

import mcp_types as types

from ..core.confirm import CONFIRM_FIELD, ConfirmationPrompt
from ..core.toolimpl import ToolResult
from ..tools import TOOLS

log = logging.getLogger(__name__)

# v2 (2026-07-28) tools/list sonucunda ttlMs ve cacheScope ZORUNLUDUR.
# Bizim tool listemiz statiktir (contract/tools.json'dan gelir, calisma zamaninda
# degismez) -> 5 dakika, paylasimli cache'e uygun.
LIST_TTL_MS = 300_000
LIST_CACHE_SCOPE = "public"


def tool_definitions() -> list[types.Tool]:
    """8 tool'u MCP Tool nesnelerine cevirir — SOZLESMEDEKI SIRAYLA.

    Sira DETERMINISTIK olmak zorundadir: v2 spec'i bunu acikca ister cunku
    tool listesi LLM prompt'unun basina girer ve sira degisirse prompt cache
    isabeti kaybolur. TOOLS listesi contract/tools.json sirasindadir.
    """
    out: list[types.Tool] = []
    for spec in TOOLS:
        description = spec.description
        if spec.teaching_notes:
            # Ogretici notlar description'a eklenir: LLM'in tool'u dogru
            # kullanmasinin TEK yolu bu metindir.
            notes = "\n".join(f"- {n}" for n in spec.teaching_notes)
            description = f"{description}\n\nDIKKAT EDILECEKLER:\n{notes}"
        out.append(
            types.Tool(
                name=spec.name,
                description=description,
                input_schema=spec.input_schema,
                # 8/8 tool outputSchema BEYAN EDER. Beyan etmeden
                # structuredContent gondermek client tarafinda dogrulanamaz bir
                # veri demektir; sozlesmenin yarisini bosa dusurur.
                output_schema=spec.output_schema,
                annotations=types.ToolAnnotations(
                    read_only_hint=spec.annotations.get("readOnlyHint"),
                    destructive_hint=spec.annotations.get("destructiveHint"),
                    idempotent_hint=spec.annotations.get("idempotentHint"),
                    open_world_hint=spec.annotations.get("openWorldHint"),
                ),
            )
        )
    return out


def list_tools_result() -> types.ListToolsResult:
    """tools/list sonucu. ttl_ms/cache_scope ACIKCA verilir.

    SDK varsayilani ttl_ms=0 + cache_scope="private"'dir (yani "hemen bayat,
    paylasma"). Statik bir listede bu israftir; degerleri elle set etmek
    `apply_cache_hint`in bizim secimimizi ezmesini de engeller.
    """
    return types.ListToolsResult(
        tools=tool_definitions(),
        ttl_ms=LIST_TTL_MS,
        cache_scope=LIST_CACHE_SCOPE,
    )


def success_result(result: ToolResult) -> types.CallToolResult:
    """Tamamlanmis tool cagrisi -> CallToolResult.

    structuredContent VE okunabilir Turkce text blogu BIRLIKTE yayinlanir.
    """
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=result.text)],
        structured_content=result.payload,
        is_error=False,
    )


def error_result(message: str) -> types.CallToolResult:
    """Is kurali/onay hatasi -> isError=true + okunabilir TURKCE metin.

    Protokol seviyesinde hata (JSON-RPC error) DEGIL: LLM'in gorup kendini
    duzeltebilmesi icin sonucun icinde raporlanir.
    """
    return types.CallToolResult(
        content=[types.TextContent(type="text", text=message)],
        is_error=True,
    )


def elicit_params(prompt: ConfirmationPrompt) -> types.ElicitRequestFormParams:
    """Onay talebini form modu elicitation parametrelerine cevirir.

    Ayni parametreler v1'de bir ISTEK olarak, v2'de bir SONUCUN icine gomulu
    olarak gider. Sema tek yerde uretilir (core/confirm.py) — iki protokolde de
    kullaniciya AYNI soru sorulur.
    """
    return types.ElicitRequestFormParams(
        message=prompt.message,
        requested_schema=prompt.requested_schema,
    )


def client_can_confirm(ctx: Any) -> bool:
    """Client kullaniciya soru sorabiliyor mu?

    v1'de bu bilgi initialize handshake'inden, v2'de her istegin
    `_meta.io.modelcontextprotocol/clientCapabilities` alanindan gelir; SDK
    ikisini de ayni yerde toplar. Yetenek yoksa onay adimi atlanir ve karar
    yazma tool'unun politika koluna kalir (XURRENT_CONFIRM_POLICY):
        open   -> yaz, onay arama (CI/otomasyon)
        closed -> mock: uyari + devam · live: REDDET   (varsayilan)
        strict -> mock dahil HER MODDA REDDET
    """
    try:
        capabilities = ctx.session.client_capabilities
    except Exception:  # noqa: BLE001
        return False
    return bool(capabilities is not None and capabilities.elicitation is not None)


def accepted(result: types.ElicitResult | Any) -> bool:
    """Kullanici gercekten ONAYLADI mi?

    'accept' TEK BASINA YETMEZ: form gonderildi ama kutu isaretlenmemis
    olabilir. Iki kosul da aranir.
    """
    if getattr(result, "action", None) != "accept":
        return False
    content = getattr(result, "content", None) or {}
    return bool(content.get(CONFIRM_FIELD))


def declined_message(tool_name: str) -> str:
    return (
        f"'{tool_name}' ONAYLANMADI — hiçbir mutation gönderilmedi. "
        "Onay diyaloğunu LLM'e bırakmıyoruz: LLM ikna edilebilir, protokol "
        "seviyesindeki onay edilemez."
    )


__all__ = [
    "LIST_CACHE_SCOPE",
    "LIST_TTL_MS",
    "accepted",
    "client_can_confirm",
    "declined_message",
    "elicit_params",
    "error_result",
    "list_tools_result",
    "success_result",
    "tool_definitions",
]
