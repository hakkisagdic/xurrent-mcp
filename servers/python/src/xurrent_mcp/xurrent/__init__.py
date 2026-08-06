"""Xurrent adapter katmani: mock ve live ayni arayuzu sunar."""

from __future__ import annotations

from ..config import Config
from .base import XurrentAdapter
from .mock import MockXurrentAdapter


def build_adapter(config: Config) -> XurrentAdapter:
    """XURRENT_MODE + XURRENT_API'ye gore adapter secer.

    live + graphql -> LiveXurrentAdapter (tek istekte zengin sorgu)
    live + rest    -> RestXurrentAdapter (snake_case, HTTP 422, N istek)
    mock           -> MockXurrentAdapter (fixtures; transport secimi anlamsiz)

    Ikisi de AYNI arayuzu sunar — transport bir adaptor detayidir (docs/16).

    NEDEN gec import: live/rest adapter httpx'i ice aktarir; mock modda
    calisan ders ortaminda gereksiz yere yuklenmesin.
    """
    if config.is_live:
        if config.api == "rest":
            from .rest import RestXurrentAdapter

            return RestXurrentAdapter(config)
        from .live import LiveXurrentAdapter

        return LiveXurrentAdapter(config)
    return MockXurrentAdapter(config)


__all__ = ["XurrentAdapter", "MockXurrentAdapter", "build_adapter"]
