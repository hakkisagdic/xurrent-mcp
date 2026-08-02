"""Takvim saglayici secimi ve gunluk okuma."""

from __future__ import annotations

import logging
from datetime import date

from ..config import Config
from ..models import CalendarDay
from ..timeutil import today_in
from .types import CalendarProviderBase, FetchOptions, build_window, normalize

log = logging.getLogger(__name__)


def build_provider(config: Config, requested: str = "auto") -> CalendarProviderBase:
    """Saglayici secer. 'auto' sirayla dener: graph -> google -> ics -> mock.

    NEDEN bu sira: yapilandirilmis olan kazanir. Hicbiri yapilandirilmamissa
    mock'a duser — ders her zaman calisir.
    """
    choice = requested if requested and requested != "auto" else config.calendar_provider
    if choice == "auto":
        choice = _autodetect(config)

    if choice == "graph":
        from .graph import GraphCalendarProvider

        return GraphCalendarProvider(config)
    if choice == "google":
        from .google import GoogleCalendarProvider

        return GoogleCalendarProvider(config)
    if choice == "ics":
        from .ics import IcsCalendarProvider

        return IcsCalendarProvider(config)

    from .mock import MockCalendarProvider

    return MockCalendarProvider(config)


def _autodetect(config: Config) -> str:
    from pathlib import Path

    if config.ms_tenant_id and config.ms_client_id and config.ms_client_secret:
        return "graph"
    if config.google_client_id and Path(config.google_token_path).expanduser().is_file():
        return "google"
    if config.ics_url or Path(config.ics_path).expanduser().is_file():
        return "ics"
    return "mock"


def read_day(
    config: Config,
    *,
    provider: str = "auto",
    day: date | None = None,
    time_zone: str | None = None,
    user_email: str | None = None,
    include_all_day: bool = False,
    include_declined: bool = False,
    include_free: bool = False,
) -> CalendarDay:
    """Bir gunun takvimini okur, normalize eder ve toplamlari hesaplar."""
    tz = time_zone or config.timezone
    target_day = day or today_in(tz)
    window_start, window_end = build_window(target_day, tz)

    impl = build_provider(config, provider)
    options = FetchOptions(
        day=target_day,
        time_zone=tz,
        window_start=window_start,
        window_end=window_end,
        user_email=user_email,
    )

    try:
        events = impl.fetch(options)
    except Exception as exc:  # noqa: BLE001 — saglayici hatasi dersi durdurmasin
        log.warning("Takvim saglayicisi '%s' basarisiz: %s. mock'a dusuluyor.", impl.name, exc)
        from .mock import MockCalendarProvider

        impl = MockCalendarProvider(config)
        events = impl.fetch(options)

    return normalize(
        events,
        options,
        impl.name,
        include_all_day=include_all_day,
        include_declined=include_declined,
        include_free=include_free,
    )


__all__ = ["build_provider", "read_day", "CalendarProviderBase", "FetchOptions"]
