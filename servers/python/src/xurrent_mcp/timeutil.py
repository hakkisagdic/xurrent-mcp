"""Saat dilimi ve ISO8601 yardimcilari.

NEDEN zoneinfo: fixtures/README.md'deki goreli tarih sozlesmesi
`instant = zonedDateTime(today + dayOffset, startLocal, timeZone)` diyor.
DST gecisleri bilerek YEREL SAATTEN hesaplanir — bir toplanti "saat 09:00'da"
baslar, "UTC 06:00'da" degil. UTC uzerinden hesaplamak DST gunlerinde 1 saat
kayma uretir; bu sessiz bir hatadir.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

_FRACTIONAL_RE = re.compile(r"(\.\d{3})\d+$")


def zone(tz_name: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz_name)
    except Exception:  # gecersiz IANA adi -> sessizce yanlis gun getirmektense UTC
        return ZoneInfo("UTC")


def today_in(tz_name: str) -> date:
    """Kisinin saat dilimindeki BUGUN. Sunucunun local'i degil."""
    return datetime.now(zone(tz_name)).date()


def local_datetime(day: date, hhmm: str, tz_name: str) -> datetime:
    """'HH:mm' yerel saatini o gunun offset'iyle mutlak instant'a cevirir."""
    hour, _, minute = hhmm.partition(":")
    return datetime(
        day.year, day.month, day.day, int(hour or 0), int(minute or 0), tzinfo=zone(tz_name)
    )


def materialize(day_offset: int, hhmm: str, tz_name: str, base: date | None = None) -> datetime:
    """fixtures goreli tarih sozlesmesi: today + dayOffset @ startLocal."""
    ref = base or today_in(tz_name)
    return local_datetime(ref + timedelta(days=day_offset), hhmm, tz_name)


def iso(dt: datetime) -> str:
    """ISO8601 + ZORUNLU offset. Ciplak timestamp sessizce yanlis gun getirir."""
    return dt.isoformat(timespec="seconds")


def iso_date(d: date) -> str:
    return d.isoformat()


def tz_offset_string(day: date, tz_name: str) -> str:
    """Verilen GUNUN UTC offset'i, '+03:00' formatinda.

    NEDEN gune bagli: DST nedeniyle offset yil icinde degisir. Sabit '+03:00'
    yazmak yaz saati uygulayan bolgelerde yanlis instant uretir.
    """
    raw = local_datetime(day, "12:00", tz_name).strftime("%z")  # '+0300'
    return f"{raw[:3]}:{raw[3:]}"


def parse_iso(value: str) -> datetime:
    """Offset'li ISO8601 metnini parse eder. 'Z' sonekini de kabul eder."""
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    return datetime.fromisoformat(text)


def parse_graph_datetime(value: str, tz_name: str = "UTC") -> datetime:
    """Microsoft Graph dateTime alanini guvenle parse eder.

    TUZAK: Graph'in dateTime alani OFFSET TASIMAZ ve 7 kesirli hane icerir
    ('2026-08-02T09:00:00.0000000'). Dogrudan parse edilirse sunucunun local
    time'i sanilir -> yanlis instant. Kesirli haneyi 3'e kirpip 'Z' ekliyoruz
    (Prefer: outlook.timezone GONDERMEDIGIMIZ icin Graph UTC doner).
    """
    text = value.strip()
    if text.endswith("Z"):
        return parse_iso(text)
    if "+" in text[10:] or text[10:].count("-") > 0:
        return parse_iso(text)
    text = _FRACTIONAL_RE.sub(r"\1", text)
    if "." not in text:
        text += ".000"
    return parse_iso(text + "Z").astimezone(zone(tz_name))


def minutes_between(start: datetime, end: datetime) -> int:
    return max(0, int((end - start).total_seconds() // 60))


def merge_intervals(spans: list[tuple[datetime, datetime]]) -> int:
    """Cakisan araliklari birlestirip toplam DAKIKAyi doner.

    NEDEN: iki toplanti cakisirsa naif toplam fazla sayar. busyMinutes bu
    fonksiyonun sonucudur; naiveSumMinutes duz toplamdir. IKISI DE raporlanir
    cunku farki gormek dersin bir parcasidir.
    """
    if not spans:
        return 0
    ordered = sorted(spans, key=lambda s: s[0])
    total = 0
    cur_start, cur_end = ordered[0]
    for start, end in ordered[1:]:
        if start <= cur_end:
            cur_end = max(cur_end, end)
        else:
            total += minutes_between(cur_start, cur_end)
            cur_start, cur_end = start, end
    total += minutes_between(cur_start, cur_end)
    return total


def round_to_increment(minutes: int, increment: int, mode: str = "nearest") -> int:
    """timeSpent'i timeIncrement katina yuvarlar.

    TUZAK: Xurrent timeIncrement'in KATI olmayan timeSpent'i reddeder.
    Varsayilan increment 60'tir; yani 45 dakikalik bir giris sessizce reddedilir.
    Yuvarlama HER ZAMAN warnings'e yazilir, sessizce yapilmaz.
    """
    if increment <= 0:
        return minutes
    if minutes % increment == 0:
        return minutes
    quotient = minutes / increment
    if mode == "up":
        steps = int(quotient) + (1 if quotient > int(quotient) else 0)
    elif mode == "down":
        steps = int(quotient)
    else:
        # Python'un round()'u banker's rounding yapar (2.5 -> 2). Biz "yariyi
        # yukari" istiyoruz: 45/30 = 1.5 -> 2 -> 60 dakika.
        steps = int(quotient + 0.5)
    return max(increment, steps * increment)
