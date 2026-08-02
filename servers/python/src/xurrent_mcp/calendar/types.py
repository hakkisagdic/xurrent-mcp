"""Takvim saglayicilarinin ortak sekli ve filtreleme kurallari.

Ham veriyi cekmek kolay; ANLAMLI veriye cevirmek asil istir. Bu modul
"gercek toplanti nedir" sorusunun tek cevabini tutar; dort saglayici da
(mock/ics/google/graph) kendi alanlarini bu sekle cevirir.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from ..models import CalendarDay, CalendarTotals, Meeting
from ..timeutil import (
    iso,
    local_datetime,
    merge_intervals,
    minutes_between,
    parse_iso,
)


@dataclass
class RawEvent:
    """Saglayicidan gelen, henuz filtrelenmemis etkinlik."""

    id: str
    ical_uid: str
    title: str
    start: datetime
    end: datetime
    is_all_day: bool = False
    is_cancelled: bool = False
    declined: bool = False
    free: bool = False
    organizer: str | None = None
    attendee_count: int = 0
    categories: list[str] = field(default_factory=list)
    series_id: str | None = None
    join_url: str | None = None


@dataclass
class FetchOptions:
    day: date
    time_zone: str
    window_start: datetime
    window_end: datetime
    user_email: str | None = None


class CalendarProviderBase(ABC):
    """Tum saglayicilarin ortak arayuzu."""

    name: str

    @abstractmethod
    def fetch(self, options: FetchOptions) -> list[RawEvent]:
        """Pencereyle CAKISAN tum ham etkinlikleri doner (filtresiz)."""


def build_window(day: date, tz_name: str) -> tuple[datetime, datetime]:
    """Pencere HER ZAMAN yerel gece yarisindan yerel gece yarisina kurulur.

    Offset GOMULU olmalidir ('2026-08-02T00:00:00+03:00'). Ciplak timestamp
    gondermek sessizce yanlis gunu getirir — bu, takvim entegrasyonlarindaki
    en sik hatadir.
    """
    start = local_datetime(day, "00:00", tz_name)
    end = local_datetime(day + timedelta(days=1), "00:00", tz_name)
    return start, end


def normalize(
    events: list[RawEvent],
    options: FetchOptions,
    source: str,
    *,
    include_all_day: bool = False,
    include_declined: bool = False,
    include_free: bool = False,
) -> CalendarDay:
    """Ham etkinlikleri filtreler, dedup eder, clip eder ve toplamlari hesaplar."""
    # Dedup anahtari: iCalUID TEK BASINA yetmez. Graph'te her occurrence farkli
    # bir uid tasir, Google'da seri boyunca AYNI uid gelir. Bu yuzden anahtara
    # start instant'ini dahil ediyoruz.
    seen: set[str] = set()
    deduped: list[RawEvent] = []
    for event in events:
        key = f"{event.ical_uid}|{event.start.isoformat()}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(event)

    meetings: list[Meeting] = []
    for event in deduped:
        skip_reason = _skip_reason(
            event,
            include_all_day=include_all_day,
            include_declined=include_declined,
            include_free=include_free,
        )

        # Filtre bir OVERLAP filtresidir: dun 23:00'te baslayip bugun 01:00'de
        # biten toplanti da doner -> pencereye CLIP edilir.
        clipped_start = max(event.start, options.window_start)
        clipped_end = min(event.end, options.window_end)

        if event.is_all_day:
            # Tum gun etkinliklerinin suresi instant'lardan HESAPLANMAZ;
            # her iki API de exclusive end date kullanir (tek gunluk all-day:
            # start=bugun, end=yarin). Sure raporlamak yaniltici olur.
            minutes = 0
        else:
            minutes = minutes_between(clipped_start, clipped_end)

        meetings.append(
            Meeting(
                source=source,
                id=event.id,
                uid=f"{event.ical_uid}|{iso(event.start)}",
                title=event.title,
                start=iso(clipped_start),
                end=iso(clipped_end),
                minutes=minutes,
                isAllDay=event.is_all_day,
                isCancelled=event.is_cancelled,
                declined=event.declined,
                free=event.free,
                skipped=skip_reason is not None,
                skipReason=skip_reason,
                organizer=event.organizer,
                attendeeCount=event.attendee_count,
                categories=list(event.categories),
                seriesId=event.series_id,
                joinUrl=event.join_url,
            )
        )

    real = [m for m in meetings if not m.skipped]
    spans = [(parse_iso(m.start), parse_iso(m.end)) for m in real]

    totals = CalendarTotals(
        count=len(real),
        # Cakismalar BIR KEZ sayilir (interval merge).
        busyMinutes=merge_intervals(spans),
        # Naif toplam: cakismalari ayri sayar. Farki gormek ogreticidir.
        naiveSumMinutes=sum(m.minutes for m in real),
        rawCount=len(meetings),
        filteredOut=len(meetings) - len(real),
    )

    return CalendarDay(
        windowStart=iso(options.window_start),
        windowEnd=iso(options.window_end),
        timeZone=options.time_zone,
        provider=source,
        meetings=meetings,
        totals=totals,
    )


def _skip_reason(
    event: RawEvent,
    *,
    include_all_day: bool,
    include_declined: bool,
    include_free: bool,
) -> str | None:
    """Elenen her etkinlik icin TURKCE gerekce. Her biri farkli bir kural ogretir."""
    if event.is_cancelled:
        return "Iptal edilmis etkinlik — takvimde durur ama calisilmamistir."
    if event.is_all_day and not include_all_day:
        return (
            "Tum gun etkinligi — suresi instant'lardan HESAPLANMAZ; "
            "her iki API de exclusive end date kullanir."
        )
    if event.declined and not include_declined:
        return (
            "Reddedilen toplanti — takvimde durmaya devam eder, sunucu tarafinda "
            "filtre YOKTUR; elemek client'in isidir."
        )
    if event.free and not include_free:
        return (
            "Mesgul olmayan etkinlik (Graph'te showAs='free', Google'da "
            "transparency='transparent') — takvimde yer kaplar ama calisma degildir."
        )
    return None
