"""fixtures/calendar.json okuyan mock takvim saglayicisi.

8 ham etkinlik -> 5 gercek toplanti. Elenen 3 tanesinin her biri farkli bir
filtreleme kuralini ogretir. Iki toplanti KASITLI cakisir: naif toplam 255 dk,
dogru cevap (interval merge) 225 dk.
"""

from __future__ import annotations

import json
from datetime import timedelta
from pathlib import Path

from ..config import Config
from ..timeutil import materialize
from .types import CalendarProviderBase, FetchOptions, RawEvent


class MockCalendarProvider(CalendarProviderBase):
    name = "mock"

    def __init__(self, config: Config) -> None:
        self.config = config
        path = Path(config.fixtures_dir) / "calendar.json"
        with path.open(encoding="utf-8") as handle:
            self._doc = json.load(handle)

    def fetch(self, options: FetchOptions) -> list[RawEvent]:
        tz = options.time_zone
        out: list[RawEvent] = []

        for raw in self._doc.get("events", []):
            day_offset = int(raw.get("dayOffset", 0))
            start = materialize(day_offset, raw.get("startLocal", "00:00"), tz)

            if raw.get("isAllDay"):
                # Tek gunluk all-day: start=o gun 00:00, end=ERTESI gun 00:00.
                # Her iki gercek API de exclusive end date kullanir; fixture'daki
                # endLocal "00:00" degerini oldugu gibi kullanmak 0 uzunluk verir
                # ve etkinlik pencere kesisiminden DUSER -> rawCount 8 yerine 7 olur.
                start = materialize(day_offset, "00:00", tz)
                end = start + timedelta(days=1)
            else:
                end = materialize(day_offset, raw.get("endLocal", "00:00"), tz)
                if end <= start:  # gece yarisini asan toplanti
                    end = end + timedelta(days=1)

            # Pencere ile CAKISAN her etkinlik doner (overlap filtresi).
            if not (start < options.window_end and end > options.window_start):
                continue

            out.append(
                RawEvent(
                    id=str(raw.get("id")),
                    ical_uid=str(raw.get("iCalUID") or raw.get("id")),
                    title=str(raw.get("title", "")),
                    start=start,
                    end=end,
                    is_all_day=bool(raw.get("isAllDay", False)),
                    is_cancelled=bool(raw.get("isCancelled", False)),
                    declined=bool(raw.get("declined", False)),
                    free=bool(raw.get("free", False)),
                    organizer=raw.get("organizer"),
                    attendee_count=int(raw.get("attendeeCount", 0)),
                    categories=list(raw.get("categories") or []),
                    series_id=raw.get("seriesId"),
                    join_url=raw.get("joinUrl"),
                )
            )
        return out
