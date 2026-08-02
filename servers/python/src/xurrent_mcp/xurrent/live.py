"""Gercek Xurrent GraphQL API'sine baglanan adapter (httpx).

ENDPOINT: POST https://graphql.xurrent.com/ — TUM operasyonlar POST.
Bolgeler: global (varsayilan), au, uk, ch, us. "eu" DIYE BIR BOLGE YOKTUR.

DIKKAT: Bu kod gercek bir Xurrent hesabina karsi CALISTIRILMAMISTIR. GraphQL
semasi resmi dokumantasyondan cikarilmistir. Ilk canli baglantida
XURRENT_DRY_RUN=1 birakip planlanan mutation'lari incelemek sarttir.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from ..config import Config
from ..models import (
    Account,
    EffortClass,
    Person,
    RateLimit,
    TimeAllocation,
    TimeTrackingContext,
    TimeTrackingDefaults,
    WorkItem,
    WorkPage,
)
from ..timeutil import today_in
from . import queries
from .base import XurrentAdapter
from .mock import STATUS_LABELS_TR

log = logging.getLogger(__name__)

# Rate limit 20 istek / 2 saniye -> istekler arasi en az 110 ms.
MIN_REQUEST_INTERVAL_SECONDS = 0.110


class XurrentTransportError(RuntimeError):
    """Aglama/HTTP seviyesindeki hata. Is kurali hatalari bundan FARKLIDIR."""


class LiveXurrentAdapter(XurrentAdapter):
    mode = "live"

    def __init__(self, config: Config) -> None:
        self.config = config
        self._last_request_at = 0.0
        self._me_id: str | None = None
        self._account: Account | None = None
        self._context_cache: TimeTrackingContext | None = None
        self._rate_limit: RateLimit | None = None

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.token}",
        }
        if config.account:
            # NUMERIK DEGIL — kisa slug (orn. "widget"). Yanlis hesabi hedeflemek
            # "kayit bulunamadi" hatalarinin en yaygin sebebidir.
            headers["X-Xurrent-Account"] = config.account

        self._client = httpx.Client(
            base_url=config.graphql_url,
            headers=headers,
            timeout=httpx.Timeout(30.0, connect=10.0),
        )

    # ------------------------------------------------------------ HTTP

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < MIN_REQUEST_INTERVAL_SECONDS:
            time.sleep(MIN_REQUEST_INTERVAL_SECONDS - elapsed)
        self._last_request_at = time.monotonic()

    def execute(self, document: str, variables: dict[str, Any] | None = None) -> dict[str, Any]:
        """Tek bir GraphQL operasyonu calistirir.

        GraphQL istek basina 1 mutation kabul eder -> bulk = N sirali HTTP istegi.
        """
        self._throttle()
        try:
            response = self._client.post(
                "/", json={"query": document, "variables": variables or {}}
            )
        except httpx.HTTPError as exc:  # sirlar ASLA loglanmaz
            raise XurrentTransportError(f"Xurrent'a baglanilamadi: {exc.__class__.__name__}") from exc

        if response.status_code >= 400:
            raise XurrentTransportError(
                f"Xurrent HTTP {response.status_code}. Token/hesap slug'ini kontrol edin."
            )

        body = response.json()
        self._capture_rate_limit(response.headers)

        # Top-level GraphQL errors = SEMA/SORGU hatasi. Is kurali hatalari
        # payload icindeki `errors` dizisinde doner (HTTP 200 ile birlikte).
        if body.get("errors"):
            first = body["errors"][0].get("message", "bilinmeyen GraphQL hatasi")
            raise XurrentTransportError(f"GraphQL hatasi: {first}")
        return body.get("data") or {}

    def _capture_rate_limit(self, headers: httpx.Headers) -> None:
        def _num(name: str) -> float | None:
            raw = headers.get(name)
            try:
                return float(raw) if raw is not None else None
            except ValueError:
                return None

        limit = _num("x-ratelimit-limit")
        remaining = _num("x-ratelimit-remaining")
        if limit is None and remaining is None:
            return
        self._rate_limit = RateLimit(
            limit=limit or 0,
            cost=_num("x-ratelimit-cost") or 0,
            remaining=remaining or 0,
            resetAt=_num("x-ratelimit-reset") or 0,
        )

    # ------------------------------------------------------------ kimlik

    def whoami(self) -> tuple[Person, Account, RateLimit | None]:
        data = self.execute(queries.ME_QUERY)
        me = data.get("me") or {}
        acc = data.get("account") or {}
        self._me_id = me.get("id")
        self._account = Account(
            id=str(acc.get("id") or self.config.account or "unknown"),
            name=acc.get("name"),
            directory=acc.get("directory"),
        )
        return self._to_person(me), self._account, self._rate_limit

    def find_person(self, email: str, view: str = "all") -> list[Person]:
        data = self.execute(queries.FIND_PERSON_QUERY, {"email": email, "view": view})
        nodes = ((data.get("people") or {}).get("nodes")) or []
        return [self._to_person(n) for n in nodes]

    def resolve_person_id(self, person_id: str | None) -> str:
        if person_id and person_id != "$me":
            return person_id
        if self._me_id is None:
            self.whoami()
        return str(self._me_id)

    def account_id(self) -> str:
        if self._account is None:
            self.whoami()
        return self._account.id if self._account else (self.config.account or "unknown")

    # ------------------------------------------------------------ acik isler

    def list_open_requests(
        self, person_id: str, first: int, after: str | None, view: str
    ) -> WorkPage:
        data = self.execute(
            queries.OPEN_REQUESTS_QUERY,
            # personId String! olarak deklare edilmistir (ID! DEGIL), cunku
            # PersonReferenceFilter.values tipi [String]!.
            {"personId": person_id, "first": first, "after": after, "view": view},
        )
        return self._to_page(data.get("requests") or {}, "request")

    def list_open_tasks(
        self, person_id: str, first: int, after: str | None, view: str
    ) -> WorkPage:
        data = self.execute(
            queries.OPEN_TASKS_QUERY,
            {"personId": person_id, "first": first, "after": after, "view": view},
        )
        return self._to_page(data.get("tasks") or {}, "task")

    def _to_page(self, raw: dict[str, Any], kind: str) -> WorkPage:
        page_info = raw.get("pageInfo") or {}
        return WorkPage(
            totalCount=int(raw.get("totalCount") or 0),
            hasNextPage=bool(page_info.get("hasNextPage")),
            endCursor=page_info.get("endCursor"),
            nodes=[self._to_work_item(n, kind) for n in (raw.get("nodes") or [])],
        )

    @staticmethod
    def _to_work_item(node: dict[str, Any], kind: str) -> WorkItem:
        status = node.get("status")
        team = (node.get("team") or {}).get("name")
        member = (node.get("member") or {}).get("name")
        workflow = node.get("workflow") or {}
        return WorkItem(
            kind=kind,
            id=str(node.get("id")),
            displayId=str(node.get("requestId") or node.get("taskId") or node.get("id")),
            subject=node.get("subject"),
            status=status,
            statusLabel=STATUS_LABELS_TR.get(status or "", status),
            isOpen=True,
            # Request'te nextTargetAt, Task'ta completionTargetAt.
            targetAt=node.get("nextTargetAt") or node.get("completionTargetAt"),
            team=team,
            member=member,
            parentLabel=workflow.get("subject"),
            updatedAt=node.get("updatedAt"),
        )

    # ------------------------------------------------------------ zaman baglami

    def time_tracking_context(self, person_id: str) -> TimeTrackingContext:
        # Sonuc session icinde CACHE'lenmelidir — her yazmadan once tekrar
        # sorgulamak gereksiz maliyettir.
        if self._context_cache is not None:
            return self._context_cache

        data = self.execute(queries.TIMESHEET_SETTINGS_QUERY, {"first": 100})
        setting = (
            ((data.get("me") or {}).get("organization") or {}).get("timesheetSetting")
        ) or {}

        # EffortClassFilter'da 'disabled' filtresi YOKTUR -> CLIENT TARAFINDA eleriz.
        effort_nodes = ((data.get("effortClasses") or {}).get("nodes")) or []
        effort_classes = [
            EffortClass(
                id=str(n["id"]),
                name=n.get("name"),
                position=n.get("position"),
                costMultiplier=n.get("costMultiplier"),
                disabled=n.get("disabled", False),
            )
            for n in effort_nodes
            if not n.get("disabled", False)
        ]

        alloc_nodes = ((data.get("timeAllocations") or {}).get("nodes")) or []
        allocations = [
            TimeAllocation(
                id=str(n["id"]),
                name=n.get("name"),
                group=n.get("group"),
                descriptionRequired=n.get("descriptionRequired", False),
            )
            for n in alloc_nodes
        ]

        def _ref(key: str) -> str | None:
            value = setting.get(key)
            return (value or {}).get("id") if isinstance(value, dict) else None

        context = TimeTrackingContext(
            unit=setting.get("unit"),
            # Varsayilan 60'tir; alan bos gelirse bunu varsaymak, sessizce
            # reddedilen 45 dakikalik girisleri onler.
            timeIncrement=setting.get("timeIncrement") or 60,
            workday=setting.get("workday") or 480,
            workweek=setting.get("workweek") or 2400,
            allowWorkdayOvertime=setting.get("allowWorkdayOvertime"),
            allowWorkweekOvertime=setting.get("allowWorkweekOvertime"),
            allocationTimeTracking=setting.get("allocationTimeTracking"),
            assignmentTimeTracking=setting.get("assignmentTimeTracking"),
            requireNote=setting.get("requireNote"),
            requireTimeEntryDescription=setting.get("requireTimeEntryDescription"),
            effortClasses=effort_classes,
            timeAllocations=allocations,
            defaults=TimeTrackingDefaults(
                requestEffortClassId=_ref("requestEffortClass"),
                taskEffortClassId=_ref("taskEffortClass"),
                projectTaskEffortClassId=_ref("projectTaskEffortClass"),
                problemEffortClassId=_ref("problemEffortClass"),
                timeAllocationEffortClassId=_ref("timeAllocationEffortClass"),
            ),
        )
        self._context_cache = context
        return context

    def minutes_logged_on(self, person_id: str, date_iso: str) -> int:
        # Canli modda gunluk toplami cekmek ek bir sorgu maliyetidir; workday
        # kontrolu icin sunucu zaten kendi dogrulamasini yapar. 0 donerek
        # client-side kontrolu devre disi birakiyoruz.
        return 0

    # ------------------------------------------------------------ mutation

    def run_mutation(self, planned: dict[str, Any]) -> dict[str, Any]:
        path = planned["path"]
        document = queries.MUTATION_BY_PATH.get(path)
        if document is None:
            return {
                "timeEntry": None,
                "errors": [{"message": f"Bilinmeyen mutation: {path}", "path": ["path"]}],
            }

        data = self.execute(document, {"input": planned.get("input", {})})
        payload = data.get(path) or {}
        # Validation hatalari HTTP 200 + errors dolu + timeEntry null olarak doner.
        return {
            "timeEntry": payload.get("timeEntry"),
            "errors": payload.get("errors") or [],
            "parent": payload.get("request") or payload.get("task") or payload.get("problem"),
        }

    def find_latest_time_entry_id(self, person_id: str) -> str | None:
        """two_step'in 2. adiminda guncellenecek entry'nin id'sini bulur.

        NEDEN gerekli: requestUpdate payload'i Request'i doner, olusan
        TimeEntry'yi DEGIL. En son olusan entry'yi ayrica sormak zorundayiz.
        """
        data = self.execute(
            queries.LATEST_TIME_ENTRY_QUERY,
            {"personId": person_id, "date": today_in(self.config.timezone).isoformat()},
        )
        nodes = ((data.get("timeEntries") or {}).get("nodes")) or []
        return str(nodes[0]["id"]) if nodes else None

    def target_label(self, target_type: str, target_id: str) -> str | None:
        return None  # canli modda ek sorgu maliyetinden kacinilir

    def open_work_snapshot(self, person_id: str) -> list[WorkItem]:
        return [
            *self.list_open_requests(person_id, 100, None, "all").nodes,
            *self.list_open_tasks(person_id, 100, None, "all").nodes,
        ]

    def time_allocations(self) -> list[TimeAllocation]:
        return self.time_tracking_context(self.resolve_person_id(None)).timeAllocations

    @staticmethod
    def _to_person(raw: dict[str, Any]) -> Person:
        return Person(
            id=str(raw.get("id", "")),
            name=raw.get("name"),
            primaryEmail=raw.get("primaryEmail"),
            jobTitle=raw.get("jobTitle"),
            timeZone=raw.get("timeZone"),
            disabled=raw.get("disabled"),
            organization=raw.get("organization"),
        )
