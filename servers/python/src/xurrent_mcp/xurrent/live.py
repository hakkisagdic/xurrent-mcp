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

# Hata tipleri ve retry politikasi retry.py'de yasar (contract/reliability.md).
# XurrentTransportError buradan YENIDEN IHRAC edilir: eski import yolu
# (`from .live import XurrentTransportError`) calismaya devam eder.
from .retry import (  # noqa: F401  (yeniden ihrac)
    OP_CLASS_BY_PATH,
    XurrentGraphQLError,
    XurrentHttpError,
    XurrentTransportError,
    execute_with_retry,
    is_uncertain,
    log_dedup,
    transport_error_message,
)

log = logging.getLogger(__name__)


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
        """Gaz ADAPTOR seviyesinde yasar (reliability.md §4): retry tekrarlari
        dahil HER HTTP istegi bu kapidan gecer. Bulk dongusunde ayrica bekleme
        YOKTUR — gaz tek yerde yasar, iki yerde yasarsa biri yanlis olur."""
        gap_seconds = self.config.min_request_gap_ms / 1000.0
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < gap_seconds:
            time.sleep(gap_seconds - elapsed)
        self._last_request_at = time.monotonic()

    def _request_once(self, document: str, variables: dict[str, Any] | None) -> dict[str, Any]:
        """TEK HTTP denemesi. Retry karari burada DEGIL, execute()'ta verilir."""
        self._throttle()
        try:
            response = self._client.post(
                "/", json={"query": document, "variables": variables or {}}
            )
        except httpx.HTTPError as exc:  # sirlar ASLA loglanmaz
            raise XurrentTransportError(
                f"Xurrent'a baglanilamadi: {exc.__class__.__name__}"
            ) from exc

        if response.status_code >= 400:
            # 429/5xx digerlerinden AYRI tip tasir: retry politikasi status'a
            # ve Retry-After'a bakmak zorundadir (reliability.md §1, §3).
            retry_after: float | None = None
            raw = response.headers.get("retry-after")
            if raw is not None:
                try:
                    retry_after = float(raw)
                except ValueError:
                    retry_after = None  # tarih bicimi vb. — D15, saniye varsayildi
            raise XurrentHttpError(
                f"Xurrent HTTP {response.status_code}. Token/hesap slug'ini kontrol edin.",
                status=response.status_code,
                retry_after=retry_after,
            )

        body = response.json()
        self._capture_rate_limit(response.headers)

        # Top-level GraphQL errors = SEMA/SORGU hatasi -> kesin-reddedildi,
        # ASLA retry edilmez. Is kurali hatalari payload icindeki `errors`
        # dizisinde doner (HTTP 200 ile birlikte) ve exception DEGILDIR.
        if body.get("errors"):
            first = body["errors"][0].get("message", "bilinmeyen GraphQL hatasi")
            raise XurrentGraphQLError(f"GraphQL hatasi: {first}")
        return body.get("data") or {}

    def execute(
        self,
        document: str,
        variables: dict[str, Any] | None = None,
        *,
        op_class: str = "query",
        op_label: str = "query",
        on_uncertain: Any = None,
    ) -> dict[str, Any]:
        """Tek bir GraphQL operasyonu calistirir — retry politikasiyla birlikte.

        GraphQL istek basina 1 mutation kabul eder -> bulk = N sirali HTTP istegi.
        Retry TRANSPORTUN degil OPERASYONUN ozelligidir; sinif cagirandan gelir
        (varsayilan "query" = yan etkisiz, serbestce tekrarlanabilir).
        """
        return execute_with_retry(
            lambda: self._request_once(document, variables),
            op=op_label,
            op_class=op_class,
            max_attempts=self.config.retry_max_attempts,
            base_ms=self.config.retry_base_ms,
            cap_ms=self.config.retry_cap_ms,
            on_uncertain=on_uncertain,
        )

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
        """Tek bir planlanmis mutation'i, OPERASYON SINIFINA gore calistirir.

        Sinif haritasi (reliability.md §2, OP_CLASS_BY_PATH):
          timeEntryCreate  -> guarded_create   (belirsiz hatada ONCE dedup geri-okumasi)
          timeEntryUpdate  -> idempotent_update (mutlak SET — tekrar zararsiz)
          *Update (parent) -> no_retry          (timeSpent ARTIMLI — tekrar = cift sayim)
        """
        path = planned["path"]
        document = queries.MUTATION_BY_PATH.get(path)
        if document is None:
            return {
                "timeEntry": None,
                "errors": [{"message": f"Bilinmeyen mutation: {path}", "path": ["path"]}],
            }

        op_class = OP_CLASS_BY_PATH.get(path, "no_retry")
        input_payload = planned.get("input", {})

        on_uncertain = None
        if op_class == "guarded_create":
            source_id = str(input_payload.get("sourceID") or "")

            def _dedup_read_back() -> dict[str, Any] | None:
                """Belirsiz hata sonrasi 'yazilmis mi?' sorusu.

                Kayit VARSA: ilk deneme sunucuya ulasip islenmis demektir —
                mevcut kayit BASARI olarak doner, kor retry'in yazacagi cift
                kayit onlenir. Kayit YOKSA: tekrar guvenlidir, retry surer.
                """
                if not source_id:
                    return None
                try:
                    entry = self.find_time_entry_by_source_id(source_id)
                except XurrentTransportError:
                    # Geri-okuma da dustu -> karar veremiyoruz; retry dongusu
                    # bir sonraki denemede tekrar soracak.
                    return None
                log_dedup(source_id, entry is not None)
                if entry is None:
                    return None
                # execute() donus sekliyle ayni: sentezlenmis basari payload'i.
                return {path: {"errors": [], "timeEntry": entry, "deduped": True}}

            on_uncertain = _dedup_read_back

        try:
            data = self.execute(
                document,
                {"input": input_payload},
                op_class=op_class,
                op_label=path,
                on_uncertain=on_uncertain,
            )
        except XurrentTransportError as exc:
            # Transport hatasi exception olarak YUKARI SIZMAZ: bulk akisi devam
            # edebilmeli ve hata, sozlesmedeki errors[] seklinde raporlanmali.
            return {
                "timeEntry": None,
                "errors": [
                    {
                        "message": self._transport_error_message(path, op_class, exc),
                        "path": None,
                    }
                ],
            }

        payload = data.get(path) or {}
        # Validation hatalari HTTP 200 + errors dolu + timeEntry null olarak doner.
        result: dict[str, Any] = {
            "timeEntry": payload.get("timeEntry"),
            "errors": payload.get("errors") or [],
            "parent": payload.get("request") or payload.get("task") or payload.get("problem"),
        }
        if payload.get("deduped"):
            result["deduped"] = True
        return result

    @staticmethod
    def _transport_error_message(
        path: str, op_class: str, exc: XurrentTransportError
    ) -> str:
        """retry.transport_error_message'a delege eder.

        NEDEN tasindi: ayni belirsizlik dersi REST adaptorunde de (rest.py)
        AYNI cumlelerle anlatilmak zorunda — metin operasyon sinifinin
        ozelligidir, transportun degil (contract/reliability.md §2).
        """
        return transport_error_message(path, op_class, exc)

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

    def list_time_entries(
        self,
        person_id: str,
        date_from: str | None,
        date_to: str | None,
        source_id: str | None,
        first: int,
    ) -> list[dict[str, Any]]:
        """xurrent_list_time_entries — TEK timeEntries sorgusu.

        Degisken adlari sahte sunucuyla BIREBIR ayni olmak zorundadir:
        personId / dateFrom / dateTo / sourceID (tools/fake-xurrent bunlari
        dogrudan okur). Query sinifidir — yan etkisiz, retry politikasi serbest.
        """
        data = self.execute(
            queries.LIST_TIME_ENTRIES_QUERY,
            {
                "personId": person_id,
                "dateFrom": date_from,
                "dateTo": date_to,
                "sourceID": source_id,
                "first": first,
            },
            op_class="query",
            op_label="timeEntries",
        )
        nodes = ((data.get("timeEntries") or {}).get("nodes")) or []
        return [self._to_time_entry_record(n) for n in nodes[: max(1, first)]]

    @staticmethod
    def _to_time_entry_record(node: dict[str, Any]) -> dict[str, Any]:
        """GraphQL node -> contract $defs/TimeEntryRecord."""
        person = node.get("person") or None
        effort = node.get("effortClass") or None
        assignment = None
        raw = node.get("assignment")
        if raw and raw.get("id"):
            display = raw.get("requestId") or raw.get("taskId")
            assignment = {
                "type": raw.get("__typename"),
                "id": str(raw.get("id")),
                "displayId": str(display) if display is not None else None,
            }
        return {
            "id": str(node.get("id")),
            "date": node.get("date"),
            "startedAt": node.get("startedAt"),
            "timeSpent": int(node.get("timeSpent") or 0),
            "description": node.get("description"),
            "correction": node.get("correction"),
            "source": node.get("source"),
            "sourceID": node.get("sourceID"),
            "person": (
                {"id": str(person.get("id")), "name": person.get("name")} if person else None
            ),
            "assignment": assignment,
            "effortClass": (
                {"id": str(effort.get("id")), "name": effort.get("name")} if effort else None
            ),
        }

    def find_time_entry_by_source_id(self, source_id: str) -> dict[str, Any] | None:
        """Dedup geri-okumasi (reliability.md §5).

        Query sinifidir — yan etkisiz, kendisi de retry politikasindan gecer.
        D14: gercek TimeEntryFilter'da sourceID filtresinin varligi henuz
        DOGRULANMADI; sahte sunucu destekliyor, canli tenant'ta teyit sart.
        """
        if not source_id:
            return None
        data = self.execute(
            queries.TIME_ENTRY_BY_SOURCE_ID_QUERY, {"sourceID": source_id}
        )
        nodes = ((data.get("timeEntries") or {}).get("nodes")) or []
        return nodes[0] if nodes else None

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
