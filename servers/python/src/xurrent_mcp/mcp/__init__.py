"""MCP adaptor katmani — INCE olmasi kasitlidir.

    common.py         ortak: tool beyanlari (input+output sema), sonuc zarflari
    v1.py             2025-11-25: sunucu-baslatmali `elicitation/create`
    v2.py             2026-07-28: `InputRequiredResult` + MRTR (imzali requestState)
    parse_guard.py    protokol-ustu: bozuk JSON -> -32700 (revizyondan BAGIMSIZ)

Ders acisindan onemli olan bu klasorun BOYUTUDUR. Xurrent adapter'i, takvim
saglayicilari, uc backdate stratejisi, dogrulama kurallari — hicbiri protokol
revizyonundan etkilenmedi. Breaking change yalnizca buraya dokundu.

NOT: bu paketin adi `mcp` ama ust seviye `mcp` (resmi SDK) paketiyle
CAKISMAZ. Python 3'te ortu kapali goreli import yoktur; `from mcp.server...`
her zaman ust seviye SDK'yi cozer, bu paket `xurrent_mcp.mcp` adiyla yasar.
"""

from __future__ import annotations

__all__ = ["common", "parse_guard", "v1", "v2"]
