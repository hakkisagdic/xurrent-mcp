"""Microsoft Graph (Microsoft 365 / Outlook) takvim saglayicisi.

EN KRITIK SECIM: 'events' DEGIL 'calendarView'.
calendarView tekrarlayan etkinlikleri ACILMIS (expanded) doner; /events ham
seri master'ini dondurur ve o gunku occurrence'i goremezsiniz.

IZIN TUZAGI: Calendars.Read.All etkinlik OKUMAK ICIN DEGILDIR — "tum
kullanicilarin calisma saatleri ve lokasyonlari"ni okur. Dogru izin hem
app-only hem delegated icin: Calendars.Read
Client credentials akisinda scope HER ZAMAN https://graph.microsoft.com/.default

PARSE TUZAGI: Graph'in dateTime alani OFFSET TASIMAZ ve 7 kesirli hane icerir.
Prefer: outlook.timezone GONDERMIYORUZ ki UTC gelsin; sonra kesirli haneyi
3'e kirpip 'Z' ekleyerek parse ediyoruz.
"""

from __future__ import annotations

import time
from datetime import timedelta

import httpx

from ..config import Config
from ..timeutil import iso, parse_graph_datetime, parse_iso
from .types import CalendarProviderBase, FetchOptions, RawEvent

GRAPH_TOKEN_URL = "https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class GraphCalendarProvider(CalendarProviderBase):
    name = "graph"

    def __init__(self, config: Config) -> None:
        self.config = config
        self._token: str | None = None
        self._expires_at = 0.0

    def _access(self) -> str:
        if self._token and time.time() < self._expires_at - 60:
            return self._token
        if not (self.config.ms_tenant_id and self.config.ms_client_id):
            raise RuntimeError("MS_TENANT_ID / MS_CLIENT_ID tanimli degil.")

        response = httpx.post(
            GRAPH_TOKEN_URL.format(tenant=self.config.ms_tenant_id),
            data={
                "client_id": self.config.ms_client_id,
                "client_secret": self.config.ms_client_secret,
                "grant_type": "client_credentials",
                # Client credentials akisinda scope HER ZAMAN .default'tur.
                "scope": "https://graph.microsoft.com/.default",
            },
            timeout=20.0,
        )
        response.raise_for_status()
        payload = response.json()
        self._token = payload["access_token"]
        self._expires_at = time.time() + float(payload.get("expires_in", 3600))
        return self._token

    def fetch(self, options: FetchOptions) -> list[RawEvent]:
        user = options.user_email or self.config.ms_impersonate_user
        scope = f"/users/{user}" if user else "/me"
        url = f"{GRAPH_BASE}{scope}/calendarView"

        headers = {"Authorization": f"Bearer {self._access()}"}
        # DIKKAT: Prefer: outlook.timezone GONDERILMEZ. Gondermek Graph'in
        # dateTime alanini o saat diliminde ama yine OFFSETSIZ dondurmesine yol
        # acar; UTC gelmesi parse'i deterministik yapar.
        params = {
            # startDateTime/endDateTime OFFSETLI gonderilir.
            "startDateTime": iso(options.window_start),
            "endDateTime": iso(options.window_end),
            "$top": "250",
            "$orderby": "start/dateTime",
            "$select": (
                "id,iCalUId,subject,start,end,isAllDay,isCancelled,showAs,"
                "organizer,attendees,categories,seriesMasterId,onlineMeeting,responseStatus"
            ),
        }
        response = httpx.get(url, params=params, headers=headers, timeout=30.0)
        response.raise_for_status()
        return [self._to_raw_event(v, options.time_zone) for v in response.json().get("value", [])]

    def _to_raw_event(self, item: dict, tz_name: str) -> RawEvent:
        start = self._parse(item.get("start") or {}, tz_name)
        end = self._parse(item.get("end") or {}, tz_name)
        if item.get("isAllDay") and end <= start:
            end = start + timedelta(days=1)

        response_status = (item.get("responseStatus") or {}).get("response")
        show_as = item.get("showAs") or "busy"

        return RawEvent(
            id=str(item.get("id")),
            # Graph'te her occurrence FARKLI bir iCalUId tasir -> types.normalize()
            # yine de anahtara start instant'ini ekler (Google ile ortak davranis).
            ical_uid=str(item.get("iCalUId") or item.get("id")),
            title=item.get("subject") or "(basliksiz)",
            start=start,
            end=end,
            is_all_day=bool(item.get("isAllDay", False)),
            is_cancelled=bool(item.get("isCancelled", False)),
            declined=response_status == "declined",
            # Graph'te 'free' -> mesgul degil. 'oof'/'workingElsewhere' mesgul sayilir.
            free=show_as == "free",
            organizer=((item.get("organizer") or {}).get("emailAddress") or {}).get("address"),
            attendee_count=len(item.get("attendees") or []),
            categories=list(item.get("categories") or []),
            series_id=item.get("seriesMasterId"),
            join_url=(item.get("onlineMeeting") or {}).get("joinUrl"),
        )

    @staticmethod
    def _parse(node: dict, tz_name: str):
        raw = node.get("dateTime")
        if not raw:
            return parse_iso("1970-01-01T00:00:00Z")
        # timeZone alani genellikle 'UTC' gelir (Prefer gondermedigimiz icin).
        return parse_graph_datetime(raw, node.get("timeZone") or "UTC")
