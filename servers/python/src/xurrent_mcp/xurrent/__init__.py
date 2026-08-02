"""Xurrent adapter katmani: mock ve live ayni arayuzu sunar."""

from __future__ import annotations

from ..config import Config
from .base import XurrentAdapter
from .mock import MockXurrentAdapter


def build_adapter(config: Config) -> XurrentAdapter:
    """XURRENT_MODE'a gore adapter secer.

    NEDEN gec import: live adapter httpx'i ice aktarir; mock modda calisan
    ders ortaminda gereksiz yere yuklenmesin.
    """
    if config.is_live:
        from .live import LiveXurrentAdapter

        return LiveXurrentAdapter(config)
    return MockXurrentAdapter(config)


__all__ = ["XurrentAdapter", "MockXurrentAdapter", "build_adapter"]
