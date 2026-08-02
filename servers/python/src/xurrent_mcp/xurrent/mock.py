"""fixtures/ klasorunu okuyan mock adapter.

Uc dil de AYNI dosyalari okur ve AYNI sayilari uretir — dersin "dil degisti
ama sonuc ayni" iddiasinin kaniti budur.

Goreli tarih sozlesmesi (fixtures/README.md):
    instant = zonedDateTime(today + dayOffset, startLocal, timeZone)
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import timedelta
from pathlib import Path
from typing import Any

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
from ..timeutil import iso, iso_date, materialize, today_in
from .base import XurrentAdapter

log = logging.getLogger(__name__)

# Terminal (kapali) durumlar. Bunlar dersin en onemli asimetrilerinden biridir.
REQUEST_TERMINAL_STATUSES = {"completed"}
TASK_TERMINAL_STATUSES = {"completed", "approved", "failed", "rejected", "canceled"}

# Turkce durum etiketleri — kullaniciya donen tum metinler Turkce.
STATUS_LABELS_TR = {
    "registered": "Kaydedildi",
    "declined": "Reddedildi",
    "on_backlog": "Beklemede (backlog)",
    "assigned": "Atandi",
    "accepted": "Kabul edildi",
    "in_progress": "Devam ediyor",
    "waiting_for": "Bekliyor",
    "waiting_for_customer": "Musteri bekleniyor",
    "reservation_pending": "Rezervasyon bekliyor",
    "workflow_pending": "Is akisi bekliyor",
    "project_pending": "Proje bekliyor",
    "request_pending": "Talep bekliyor",
    "completed": "Tamamlandi",
    "approved": "Onaylandi",
    "failed": "Basarisiz",
    "rejected": "Reddedildi",
    "canceled": "Iptal edildi",
}


def _read_json(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


class MockXurrentAdapter(XurrentAdapter):
    """Token istemez, internete cikmaz. Yazmalar bellekte birikir."""

    mode = "mock"

    def __init__(self, config: Config) -> None:
        self.config = config
        self.tz = config.timezone
        self._lock = threading.Lock()
        root = config.fixtures_dir

        self._people_doc = _read_json(root / "people.json")
        self._requests_doc = _read_json(root / "requests.json")
        self._tasks_doc = _read_json(root / "tasks.json")
        self._effort_doc = _read_json(root / "effort-classes.json")
        self._timesheet_doc = _read_json(root / "timesheet-settings.json")
        self._allocations_doc = _read_json(root / "time-allocations.json")
        self._entries_doc = _read_json(root / "time-entries.json")

        # Mock modda olusan kayitlar burada birikir. sourceID -> id eslemesi
        # idempotency icin tutulur (ayni sourceID iki kez yazilmaz).
        self._created: list[dict[str, Any]] = []
        self._by_source_id: dict[str, str] = {}
        self._seq = 100

    # ------------------------------------------------------------ kimlik

    def whoami(self) -> tuple[Person, Account, RateLimit | None]:
        me = self._person_raw(self._people_doc["me"])
        account_raw = self._people_doc.get("account", {})
        account = Account(
            id=str(account_raw.get("id", "mock-account")),
            name=account_raw.get("name"),
            directory=account_raw.get("directory"),
        )
        # Mock modda rate limit YOKTUR -> None.
        # NEDEN uydurmuyoruz: rateLimit.resetAt bir ZAMAN DAMGASIDIR. Uydurulmus
        # bir deger ya her calistirmada degisir (cikti deterministik olmaktan
        # cikar, sozlesme testi ve sihirbaz sallanir) ya da sabit 0 kalir
        # (kullaniciya "kotanız bitmek uzere" gibi YANLIS bilgi verir).
        # null tek durust cevaptir: "bu bilgi mock modda mevcut degil".
        return self._to_person(me), account, None

    def find_person(self, email: str, view: str = "all") -> list[Person]:
        # TAM eslesme — PersonFilter.primaryEmail bir TextFilter'dir, substring DEGIL.
        matches = [
            p for p in self._people_doc["people"] if p.get("primaryEmail") == email
        ]
        return [self._to_person(p) for p in matches]

    def resolve_person_id(self, person_id: str | None) -> str:
        if not person_id or person_id == "$me":
            return str(self._people_doc["me"])
        return person_id

    def account_id(self) -> str:
        return str(self._people_doc.get("account", {}).get("id", "mock-account"))

    # ------------------------------------------------------------ acik isler

    def list_open_requests(
        self, person_id: str, first: int, after: str | None, view: str
    ) -> WorkPage:
        rows = [
            r
            for r in self._requests_doc["requests"]
            if r.get("memberId") == person_id
            # Acik/kapali ayrimi SADECE status ile yapilir; 'open' view YOKTUR.
            and r.get("status") not in REQUEST_TERMINAL_STATUSES
        ]
        return self._page(rows, first, after, kind="request")

    def list_open_tasks(
        self, person_id: str, first: int, after: str | None, view: str
    ) -> WorkPage:
        rows = [
            t
            for t in self._tasks_doc["tasks"]
            # TUZAK: TaskFilter'da atanan alani 'assignee'dir ('member' DEGIL).
            if t.get("assigneeId") == person_id
            # BES terminal durum. Sadece 'completed'i elemek yetmez —
            # 'approved' durumundaki 4390 kaydi acik sanilirdi.
            and t.get("status") not in TASK_TERMINAL_STATUSES
        ]
        return self._page(rows, first, after, kind="task")

    def _page(
        self, rows: list[dict[str, Any]], first: int, after: str | None, kind: str
    ) -> WorkPage:
        total = len(rows)
        start = 0
        if after:
            try:
                start = int(after)
            except ValueError:
                start = 0
        window = rows[start : start + first]
        nodes = [self._to_work_item(r, kind) for r in window]
        end = start + len(window)
        return WorkPage(
            totalCount=total,
            nodes=nodes,
            hasNextPage=end < total,
            endCursor=str(end) if end < total else None,
        )

    def _to_work_item(self, row: dict[str, Any], kind: str) -> WorkItem:
        today = today_in(self.tz)
        target_offset = row.get("targetAtOffsetDays")
        updated_offset = row.get("updatedAtOffsetDays")
        parent = None
        if kind == "task":
            parent = row.get("workflowSubject")
            if not parent and row.get("linkedRequestId"):
                parent = f"Bagli talep: {row['linkedRequestId']}"
        return WorkItem(
            kind=kind,
            id=str(row["id"]),
            # Request'te requestId, Task'ta taskId. UI'da gorunen numara budur.
            displayId=str(row.get("requestId") or row.get("taskId") or row["id"]),
            subject=row.get("subject"),
            status=row.get("status"),
            statusLabel=row.get("statusLabel") or STATUS_LABELS_TR.get(row.get("status", "")),
            isOpen=True,
            targetAt=(
                iso(materialize(int(target_offset), "17:00", self.tz, today))
                if target_offset is not None
                else None
            ),
            team=row.get("team"),
            member=self._person_name(row.get("memberId") or row.get("assigneeId")),
            parentLabel=parent,
            updatedAt=(
                iso(materialize(int(updated_offset), "12:00", self.tz, today))
                if updated_offset is not None
                else None
            ),
        )

    # ------------------------------------------------------------ zaman baglami

    def time_tracking_context(self, person_id: str) -> TimeTrackingContext:
        setting = self._timesheet_doc["timesheetSetting"]
        defaults_raw = setting.get("defaults", {})

        # TUZAK: EffortClassFilter'da 'disabled' filtresi YOKTUR — sunucu
        # disabled olanlari eleyemez. Bu yuzden CLIENT TARAFINDA eliyoruz.
        # Fixture'da 4 kayit var, 3'u donmelidir.
        effort_classes = [
            EffortClass(
                id=str(ec["id"]),
                name=ec.get("name"),
                position=ec.get("position"),
                costMultiplier=ec.get("costMultiplier"),
                disabled=ec.get("disabled", False),
            )
            for ec in self._effort_doc["effortClasses"]
            if not ec.get("disabled", False)
        ]

        allocations = [
            TimeAllocation(
                id=str(a["id"]),
                name=a.get("name"),
                group=a.get("group"),
                descriptionRequired=a.get("descriptionRequired", False),
            )
            for a in self._allocations_doc["timeAllocations"]
        ]

        return TimeTrackingContext(
            unit=setting.get("unit"),
            # timeIncrement hem MINIMUM hem ADIM'dir (dakika).
            timeIncrement=setting.get("timeIncrement"),
            workday=setting.get("workday"),
            workweek=setting.get("workweek"),
            allowWorkdayOvertime=setting.get("allowWorkdayOvertime"),
            allowWorkweekOvertime=setting.get("allowWorkweekOvertime"),
            allocationTimeTracking=setting.get("allocationTimeTracking"),
            assignmentTimeTracking=setting.get("assignmentTimeTracking"),
            requireNote=setting.get("requireNote"),
            requireTimeEntryDescription=setting.get("requireTimeEntryDescription"),
            effortClasses=effort_classes,
            timeAllocations=allocations,
            defaults=TimeTrackingDefaults(
                requestEffortClassId=defaults_raw.get("requestEffortClassId"),
                taskEffortClassId=defaults_raw.get("taskEffortClassId"),
                projectTaskEffortClassId=defaults_raw.get("projectTaskEffortClassId"),
                problemEffortClassId=defaults_raw.get("problemEffortClassId"),
                timeAllocationEffortClassId=defaults_raw.get("timeAllocationEffortClassId"),
            ),
        )

    def minutes_logged_on(self, person_id: str, date_iso: str) -> int:
        today = today_in(self.tz)
        total = 0
        for entry in self._entries_doc["timeEntries"]:
            if entry.get("personId") != person_id:
                continue
            day = today + timedelta(days=int(entry.get("dayOffset", 0)))
            if iso_date(day) == date_iso:
                total += int(entry.get("timeSpent", 0))
        for entry in self._created:
            if entry.get("personId") == person_id and entry.get("date") == date_iso:
                total += int(entry.get("timeSpent", 0))
        return total

    # ------------------------------------------------------------ mutation

    def run_mutation(self, planned: dict[str, Any]) -> dict[str, Any]:
        """Mock mutation calistirici.

        Gercek API gibi davranir: is kurali hatalari `errors` dizisine yazilir,
        timeEntry null doner. Top-level exception ATILMAZ.
        """
        path = planned["path"]
        payload = dict(planned.get("input", {}))

        with self._lock:
            if path == "timeEntryCreate":
                return self._create_entry(payload, assignment=None)
            if path == "timeEntryUpdate":
                return self._update_entry(payload)
            if path in ("requestUpdate", "taskUpdate", "projectTaskUpdate", "problemUpdate"):
                return self._parent_update(path, payload)

        return {
            "timeEntry": None,
            "errors": [{"message": f"Bilinmeyen mutation: {path}", "path": ["path"]}],
        }

    def _create_entry(
        self, payload: dict[str, Any], assignment: dict[str, str] | None
    ) -> dict[str, Any]:
        source_id = payload.get("sourceID")
        if source_id and source_id in self._by_source_id:
            existing = next(
                (e for e in self._created if e["id"] == self._by_source_id[source_id]), None
            )
            # Idempotency: ayni sourceID ile ikinci kez yazma yapilmaz.
            return {"timeEntry": existing, "errors": []}

        self._seq += 1
        entry_id = f"TW9jay9UaW1lRW50cnkv{self._seq}"
        entry = {
            "id": entry_id,
            "date": payload.get("date") or iso_date(today_in(self.tz)),
            "startedAt": payload.get("startedAt"),
            "timeSpent": int(payload.get("timeSpent", 0)),
            "description": payload.get("description"),
            "correction": bool(payload.get("correction", False)),
            "personId": payload.get("personId") or self.resolve_person_id(None),
            "timeAllocationId": payload.get("timeAllocationId"),
            "effortClassId": payload.get("effortClassId"),
            # Yol A ile olusan kayitta assignment HER ZAMAN null'dur.
            "assignment": assignment,
            "source": payload.get("source") or self.config.source,
            "sourceID": source_id,
        }
        self._created.append(entry)
        if source_id:
            self._by_source_id[source_id] = entry_id
        return {"timeEntry": entry, "errors": []}

    def _update_entry(self, payload: dict[str, Any]) -> dict[str, Any]:
        entry_id = payload.get("id")
        entry = next((e for e in self._created if e["id"] == entry_id), None)
        if entry is None:
            return {
                "timeEntry": None,
                "errors": [
                    {"message": f"TimeEntry bulunamadi: {entry_id}", "path": ["id"]}
                ],
            }
        # DIKKAT: TimeEntryUpdateInput'ta assignment ALANI YOKTUR. Bu yuzden
        # asagidaki guncelleme ticket bagini BOZAMAZ — two_step'in dayanagi budur.
        for key in ("date", "startedAt", "personId", "description", "effortClassId"):
            if payload.get(key) is not None:
                entry[key] = payload[key]
        if payload.get("timeSpent") is not None:
            entry["timeSpent"] = int(payload["timeSpent"])
        return {"timeEntry": entry, "errors": []}

    def _parent_update(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        target_id = payload.get("id")
        kind = {
            "requestUpdate": "Request",
            "taskUpdate": "Task",
            "projectTaskUpdate": "ProjectTask",
            "problemUpdate": "Problem",
        }[path]

        if not self._parent_exists(kind, str(target_id)):
            return {
                "timeEntry": None,
                "errors": [{"message": f"{kind} bulunamadi: {target_id}", "path": ["id"]}],
            }

        # Yol B: ticket'a bagli bir TimeEntry olusur. date sunucu tarafindan
        # "bugun", person authenticated user olarak atanir — KONTROL EDILEMEZ.
        result = self._create_entry(
            {
                "timeSpent": payload.get("timeSpent"),
                "description": payload.get("timeEntryDescription"),
                "effortClassId": payload.get("timeSpentEffortClassId"),
                "date": iso_date(today_in(self.tz)),
                "personId": self.resolve_person_id(None),
                "sourceID": payload.get("sourceID"),
            },
            assignment={"type": kind, "id": str(target_id)},
        )
        result["parent"] = {"type": kind, "id": str(target_id)}
        return result

    def _parent_exists(self, kind: str, target_id: str) -> bool:
        if kind == "Request":
            return any(r["id"] == target_id for r in self._requests_doc["requests"])
        if kind == "Task":
            return any(t["id"] == target_id for t in self._tasks_doc["tasks"])
        # ProjectTask / Problem icin mock veri yok — ders senaryosunda kullanilmiyor.
        return True

    def target_label(self, target_type: str, target_id: str) -> str | None:
        if target_type == "request":
            row = next(
                (r for r in self._requests_doc["requests"] if r["id"] == target_id), None
            )
            return f"#{row['requestId']} {row['subject']}" if row else None
        if target_type == "task":
            row = next((t for t in self._tasks_doc["tasks"] if t["id"] == target_id), None)
            return f"#{row['taskId']} {row['subject']}" if row else None
        if target_type == "time_allocation":
            row = next(
                (
                    a
                    for a in self._allocations_doc["timeAllocations"]
                    if a["id"] == target_id
                ),
                None,
            )
            return row["name"] if row else None
        return None

    # ------------------------------------------------------------ yardimcilar

    def open_work_snapshot(self, person_id: str) -> list[WorkItem]:
        """Eslestirme heuristigi icin: acik Request + Task birlesik listesi."""
        reqs = self.list_open_requests(person_id, 100, None, "all").nodes
        tasks = self.list_open_tasks(person_id, 100, None, "all").nodes
        return [*reqs, *tasks]

    def time_allocations(self) -> list[TimeAllocation]:
        return self.time_tracking_context(self.resolve_person_id(None)).timeAllocations

    def _person_raw(self, person_id: str) -> dict[str, Any]:
        return next(
            (p for p in self._people_doc["people"] if p["id"] == person_id),
            {"id": person_id, "name": None},
        )

    def _person_name(self, person_id: str | None) -> str | None:
        if not person_id:
            return None
        return self._person_raw(person_id).get("name")

    @staticmethod
    def _to_person(raw: dict[str, Any]) -> Person:
        return Person(
            id=str(raw["id"]),
            name=raw.get("name"),
            primaryEmail=raw.get("primaryEmail"),
            jobTitle=raw.get("jobTitle"),
            timeZone=raw.get("timeZone"),
            disabled=raw.get("disabled"),
            organization=raw.get("organization"),
        )
