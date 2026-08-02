"""Tool'larin paylastigi calisma zamani durumu.

Session icinde cache'lenen tek sey zaman takibi baglamidir — sozlesme bunu
acikca soyluyor ("Sonuc session icinde cache'lenmelidir").
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from ..config import Config, load_config
from ..models import TimeTrackingContext
from ..xurrent import XurrentAdapter, build_adapter

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ConfirmationState:
    """Icinde bulunulan tool cagrisinda onayin durumu.

    NEDEN GEREKLI: yazma tool'u "onay ALINDI mi" sorusunu bilmeden politika
    uygulayamaz. Onay alinmis bir cagriyi politika koluna dusurup reddetmek
    (live+closed'da oldugu gibi) onayi ANLAMSIZ kilar; onay alinmamis bir
    cagriyi serbest birakmak da politikayi anlamsiz kilar.

    can_ask: client kullaniciya soru sorabiliyor mu (v1'de elicitation
             capability, v2'de _meta.clientCapabilities.elicitation).
    granted: kullanici bu cagri icin ONAY VERDI mi.
    """

    can_ask: bool = False
    granted: bool = False


@dataclass
class Runtime:
    config: Config
    adapter: XurrentAdapter
    # run_tool HER cagri oncesi bunu tazeler; onay kanali olmayan dogrudan
    # cagrilar (web /tool, chatbot) varsayilan "onay yok" degeriyle calisir.
    confirmation: ConfirmationState = field(default_factory=ConfirmationState)
    _context_cache: dict[str, TimeTrackingContext] = field(default_factory=dict)

    @classmethod
    def create(cls, config: Config | None = None) -> "Runtime":
        cfg = config or load_config()
        for warning in cfg.warnings():
            # stdio transport'ta stdout SADECE JSON-RPC icindir -> loglar stderr'e.
            log.warning(warning)
        return cls(config=cfg, adapter=build_adapter(cfg))

    def time_tracking_context(self, person_id: str) -> TimeTrackingContext:
        """Cache anahtari (accountId, personId) — status/member/team alanlari
        account-specific'tir, bu yuzden hesabi da anahtara dahil ediyoruz."""
        key = f"{self.adapter.account_id()}|{person_id}"
        cached = self._context_cache.get(key)
        if cached is None:
            cached = self.adapter.time_tracking_context(person_id)
            self._context_cache[key] = cached
        return cached

    def invalidate_context(self) -> None:
        self._context_cache.clear()
