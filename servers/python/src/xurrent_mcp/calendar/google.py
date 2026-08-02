"""Google Calendar API v3 saglayicisi.

EN KRITIK PARAMETRE: singleEvents=true.
Varsayilani FALSE'tur; true yapilmazsa tekrarlayan toplantilar ACILMAZ —
seri master'i ham RRULE ile doner ve o gunku occurrence'i HIC goremezsiniz.
orderBy='startTime' de yalnizca singleEvents=true iken calisir.

Token: OAuth kullanici onayi ile alinir ve ~/.xurrent-mcp/google-token.json
dosyasina yazilir. UC DIL DE AYNI DOSYAYI OKUR — OAuth kutuphanesini uc kez
implemente etmek yerine token yenilemeyi duz bir HTTP POST'a indiriyoruz.
"""

from __future__ import annotations

import json
import time
from datetime import timedelta
from pathlib import Path

import httpx

from ..config import Config
from ..timeutil import iso, parse_iso, zone
from .types import CalendarProviderBase, FetchOptions, RawEvent

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/{cal}/events"


class GoogleCalendarProvider(CalendarProviderBase):
    name = "google"

    def __init__(self, config: Config) -> None:
        self.config = config
        self._access_token: str | None = None
        self._expires_at: float = 0.0

    # ------------------------------------------------------------ auth

    def _token_file(self) -> Path:
        return Path(self.config.google_token_path).expanduser()

    def _access(self) -> str:
        if self._access_token and time.time() < self._expires_at - 60:
            return self._access_token

        path = self._token_file()
        if not path.is_file():
            raise RuntimeError(
                f"Google token dosyasi yok: {path}. Once 'node scripts/google-auth.mjs' "
                "calistirin (tek seferlik)."
            )
        stored = json.loads(path.read_text(encoding="utf-8"))
        refresh_token = stored.get("refresh_token")
        if not refresh_token:
            raise RuntimeError("Google token dosyasinda refresh_token yok.")

        response = httpx.post(
            GOOGLE_TOKEN_URL,
            data={
                "client_id": self.config.google_client_id or stored.get("client_id", ""),
                "client_secret": self.config.google_client_secret
                or stored.get("client_secret", ""),
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
            timeout=20.0,
        )
        response.raise_for_status()
        payload = response.json()
        self._access_token = payload["access_token"]
        self._expires_at = time.time() + float(payload.get("expires_in", 3600))
        return self._access_token

    # ------------------------------------------------------------ fetch

    def fetch(self, options: FetchOptions) -> list[RawEvent]:
        calendar_id = options.user_email or self.config.google_calendar_id or "primary"
        params = {
            # ZORUNLU: false birakilirsa tekrarlayan toplantilar hic gorunmez.
            "singleEvents": "true",
            # Yalnizca singleEvents=true iken gecerlidir.
            "orderBy": "startTime",
            # timeMin/timeMax OFFSET ZORUNLU. Ciplak timestamp yanlis gun getirir.
            "timeMin": iso(options.window_start),
            "timeMax": iso(options.window_end),
            "maxResults": "2500",
            "showDeleted": "false",
        }
        response = httpx.get(
            GOOGLE_EVENTS_URL.format(cal=calendar_id),
            params=params,
            headers={"Authorization": f"Bearer {self._access()}"},
            timeout=30.0,
        )
        response.raise_for_status()
        items = response.json().get("items", [])
        return [self._to_raw_event(item, options.time_zone) for item in items]

    def _to_raw_event(self, item: dict, tz_name: str) -> RawEvent:
        start_raw = item.get("start", {})
        end_raw = item.get("end", {})
        all_day = "date" in start_raw

        if all_day:
            start = parse_iso(start_raw["date"] + "T00:00:00").replace(tzinfo=zone(tz_name))
            end_date = end_raw.get("date")
            end = (
                parse_iso(end_date + "T00:00:00").replace(tzinfo=zone(tz_name))
                if end_date
                else start + timedelta(days=1)
            )
        else:
            start = parse_iso(start_raw["dateTime"])
            end = parse_iso(end_raw.get("dateTime") or start_raw["dateTime"])

        attendees = item.get("attendees") or []
        self_attendee = next((a for a in attendees if a.get("self")), None)

        return RawEvent(
            id=str(item.get("id")),
            # Google'da iCalUID seri boyunca AYNIdir -> tek basina dedup anahtari
            # olamaz. types.normalize() anahtara start instant'ini ekler.
            ical_uid=str(item.get("iCalUID") or item.get("id")),
            title=item.get("summary") or "(basliksiz)",
            start=start,
            end=end,
            is_all_day=all_day,
            is_cancelled=(item.get("status") == "cancelled"),
            declined=bool(self_attendee and self_attendee.get("responseStatus") == "declined"),
            # TUZAK: transparency varsayilani 'opaque' iken cevapta HIC CIKMAZ.
            # (item.get("transparency") or "opaque") yazmak ZORUNLUDUR.
            free=(item.get("transparency") or "opaque") == "transparent",
            organizer=(item.get("organizer") or {}).get("email"),
            attendee_count=len(attendees),
            categories=[],
            series_id=item.get("recurringEventId"),
            join_url=item.get("hangoutLink"),
        )
