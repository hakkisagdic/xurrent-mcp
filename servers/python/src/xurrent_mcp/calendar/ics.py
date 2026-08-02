""".ics dosyasi / yayinlanmis URL okuyan takvim saglayicisi.

.ics gercek bir dosya formatidir ve GORELI TARIH TASIYAMAZ. Bu yuzden
scripts/gen-ics.mjs calendar.json'dan o anki tarihe gore yeniden uretir.
Sunumdan hemen once bir kez calistirmak yeterlidir.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import httpx

from ..config import Config
from ..timeutil import zone
from .types import CalendarProviderBase, FetchOptions, RawEvent


class IcsCalendarProvider(CalendarProviderBase):
    name = "ics"

    def __init__(self, config: Config) -> None:
        self.config = config

    def fetch(self, options: FetchOptions) -> list[RawEvent]:
        text = self._load()
        events: list[RawEvent] = []
        for block in _iter_vevents(text):
            event = _to_raw_event(block, options.time_zone)
            if event is None:
                continue
            if event.start < options.window_end and event.end > options.window_start:
                events.append(event)
        return events

    def _load(self) -> str:
        if self.config.ics_url:
            response = httpx.get(self.config.ics_url, timeout=20.0, follow_redirects=True)
            response.raise_for_status()
            return response.text
        from pathlib import Path

        path = Path(self.config.ics_path).expanduser()
        if not path.is_file():
            raise FileNotFoundError(
                f"ICS dosyasi bulunamadi: {path}. 'node scripts/gen-ics.mjs' ile "
                "uretin veya CALENDAR_ICS_URL tanimlayin."
            )
        return path.read_text(encoding="utf-8")


def _unfold(text: str) -> list[str]:
    """RFC5545 satir katlamasini acar (bosluk/tab ile baslayan satirlar devamdir)."""
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def _iter_vevents(text: str):
    current: dict[str, str] | None = None
    for line in _unfold(text):
        if line.startswith("BEGIN:VEVENT"):
            current = {}
        elif line.startswith("END:VEVENT"):
            if current is not None:
                yield current
            current = None
        elif current is not None and ":" in line:
            key, _, value = line.partition(":")
            current[key.upper()] = value


def _parse_ics_datetime(key: str, value: str, tz_name: str) -> tuple[datetime, bool]:
    """ICS tarih/saat degerini parse eder. Donus: (instant, all_day_mi)."""
    is_all_day = "VALUE=DATE" in key.upper()
    tz_id = tz_name
    if "TZID=" in key.upper():
        tz_id = key.upper().split("TZID=")[1].split(";")[0].split(":")[0]

    if is_all_day or (len(value) == 8 and value.isdigit()):
        parsed = datetime.strptime(value, "%Y%m%d").replace(tzinfo=zone(tz_id))
        return parsed, True
    if value.endswith("Z"):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=zone("UTC")), False
    return datetime.strptime(value, "%Y%m%dT%H%M%S").replace(tzinfo=zone(tz_id)), False


def _to_raw_event(block: dict[str, str], tz_name: str) -> RawEvent | None:
    start_key = next((k for k in block if k.startswith("DTSTART")), None)
    end_key = next((k for k in block if k.startswith("DTEND")), None)
    if start_key is None:
        return None

    start, all_day = _parse_ics_datetime(start_key, block[start_key], tz_name)
    if end_key:
        end, _ = _parse_ics_datetime(end_key, block[end_key], tz_name)
    else:
        end = start + (timedelta(days=1) if all_day else timedelta(hours=1))

    status = (block.get("STATUS") or "").upper()
    # TRANSP varsayilani OPAQUE'tir (mesgul). Alanin YOKLUGU 'free' demek DEGILDIR.
    transparency = (block.get("TRANSP") or "OPAQUE").upper()
    partstat = ""
    for key, value in block.items():
        if key.startswith("ATTENDEE") and "PARTSTAT=DECLINED" in key.upper():
            partstat = "DECLINED"
            break
        if key.startswith("ATTENDEE") and "PARTSTAT=DECLINED" in value.upper():
            partstat = "DECLINED"
            break

    uid = block.get("UID") or f"{block.get('SUMMARY', '')}-{start.isoformat()}"
    return RawEvent(
        id=uid,
        ical_uid=uid,
        title=block.get("SUMMARY", "(basliksiz)"),
        start=start,
        end=end,
        is_all_day=all_day,
        is_cancelled=status == "CANCELLED",
        declined=partstat == "DECLINED",
        free=transparency == "TRANSPARENT",
        organizer=(block.get("ORGANIZER") or "").replace("mailto:", "") or None,
        attendee_count=sum(1 for k in block if k.startswith("ATTENDEE")),
        categories=[c for c in (block.get("CATEGORIES") or "").split(",") if c],
        series_id=block.get("RECURRENCE-ID") or (uid if block.get("RRULE") else None),
        join_url=block.get("URL") or None,
    )
