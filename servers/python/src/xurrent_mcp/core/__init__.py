"""Protokolden BAGIMSIZ cekirdek.

contract/protocol.md'deki mimari kural burada yasar:

    core/                      <- protokolden BAGIMSIZ. Iki adaptor de bunu cagirir.
      toolimpl.py              <- 8 tool'un saf hali: args in -> result out
      confirm.py               <- onay talebi uretimi + requestState imzala/dogrula
      schemas.py               <- contract/tools.json "output" alanlarindan turetilmis semalar

    mcp/v1.py  <- 2025-11-25 adaptoru: sunucu-baslatmali elicitation
    mcp/v2.py  <- 2026-07-28 adaptoru: InputRequiredResult / MRTR

KRITIK: core/toolimpl bir tool'u calistirirken onay gerekiyorsa
ConfirmationRequired doner — NASIL sorulacagini BILMEZ. Bunu protokole ceviren
adaptordur. Ders acisindan bu su demek: ayni is mantigi, iki farkli protokol kabugu.

NEDEN BURADA `toolimpl` RE-EXPORT EDILMIYOR: toolimpl tool kayit defterini
(`..tools`) okur, tools ise sema icin `core.schemas`'i okur. Bu paketin
__init__'i toolimpl'i cekseydi `import xurrent_mcp.tools` yolu dairesel olurdu.
toolimpl'e her zaman `from .core.toolimpl import ...` ile ulasilir.
"""

from __future__ import annotations

from .confirm import ConfirmationPrompt, StateError, StateSigner
from .schemas import OUTPUT_SCHEMAS

__all__ = [
    "ConfirmationPrompt",
    "OUTPUT_SCHEMAS",
    "StateError",
    "StateSigner",
]
