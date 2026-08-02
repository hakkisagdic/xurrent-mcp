"""contract/tools.json cikti sekillerinin Python karsiliklari.

NEDEN dataclass: cikti JSON'a serilestirilecek. Pydantic'in dogrulama gucune
burada ihtiyac yok — sozlesme testi (scripts/verify-contract.mjs) zaten sema
uyumunu disaridan dogruluyor. Sade dataclass'lar dersi okunur kiliyor.

KURAL: alan adlari contract/tools.json ile BIREBIR ayni (camelCase).
Python'da snake_case yazip serilestirmede cevirmek yerine dogrudan camelCase
kullaniyoruz; boylece "sozlesmede ne yaziyorsa kodda o var" gorunumu bozulmuyor.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


def _clean(value: Any) -> Any:
    """dataclass -> dict cevriminde None olan opsiyonel alanlari korur.

    Sozlesmede `["string", "null"]` tipli alanlar var; bu yuzden None'lari
    ATMIYORUZ. Yalnizca ic ice dataclass'lari duz dict'e ceviriyoruz.
    """
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def to_dict(obj: Any) -> Any:
    """Dataclass agacini JSON'a hazir dict'e cevirir."""
    if hasattr(obj, "__dataclass_fields__"):
        return _clean(asdict(obj))
    return _clean(obj)


# ---------------------------------------------------------------- Person


@dataclass
class Organization:
    id: str
    name: str | None = None


@dataclass
class Person:
    id: str
    name: str | None = None
    primaryEmail: str | None = None
    jobTitle: str | None = None
    timeZone: str | None = None
    disabled: bool | None = None
    organization: dict[str, Any] | None = None


@dataclass
class Account:
    id: str
    name: str | None = None
    directory: bool | None = None


@dataclass
class RateLimit:
    limit: float
    cost: float
    remaining: float
    resetAt: float


# ---------------------------------------------------------------- Is ogeleri


@dataclass
class WorkItem:
    kind: str  # "request" | "task"
    id: str  # opak GraphQL node ID — mutation'larda BU kullanilir
    displayId: str  # Request'te requestId, Task'ta taskId
    subject: str | None
    status: str | None
    statusLabel: str | None = None
    isOpen: bool = True
    # TUZAK: Request'te nextTargetAt, Task'ta completionTargetAt. Tek alanda birlestirdik.
    targetAt: str | None = None
    team: str | None = None
    member: str | None = None
    parentLabel: str | None = None
    updatedAt: str | None = None


@dataclass
class WorkPage:
    totalCount: int
    nodes: list[WorkItem] = field(default_factory=list)
    hasNextPage: bool = False
    endCursor: str | None = None


# ---------------------------------------------------------------- Takvim


@dataclass
class Meeting:
    source: str  # "mock" | "ics" | "google" | "graph"
    id: str
    # Dedup anahtari: iCalUID TEK BASINA yetmez (Graph'te her occurrence farkli,
    # Google'da seri boyunca ayni) -> anahtara start instant dahil edilir.
    uid: str
    title: str
    start: str  # ISO8601, offset'li mutlak instant
    end: str
    minutes: int
    isAllDay: bool = False
    isCancelled: bool = False
    declined: bool = False
    free: bool = False
    skipped: bool = False
    skipReason: str | None = None
    organizer: str | None = None
    attendeeCount: int = 0
    categories: list[str] = field(default_factory=list)
    seriesId: str | None = None
    joinUrl: str | None = None


@dataclass
class CalendarTotals:
    count: int
    busyMinutes: int
    naiveSumMinutes: int
    rawCount: int
    filteredOut: int


@dataclass
class CalendarDay:
    windowStart: str
    windowEnd: str
    timeZone: str
    provider: str
    meetings: list[Meeting]
    totals: CalendarTotals


# ---------------------------------------------------------------- Yazma


@dataclass
class ValidationError:
    message: str
    path: list[str] | None = None


@dataclass
class PlannedMutation:
    path: str  # timeEntryCreate | requestUpdate | ... | timeEntryUpdate
    mutation: str  # gonderilecek GraphQL metni — derste birebir gosterilir
    input: dict[str, Any]
    warnings: list[str] = field(default_factory=list)
    index: int | None = None
    stepLabel: str | None = None  # two_step'te "1/2" veya "2/2"


@dataclass
class WriteResult:
    dryRun: bool
    strategy: str
    planned: list[PlannedMutation]
    warnings: list[str]
    errors: list[ValidationError]
    strategyExplanation: str = ""
    timeEntry: dict[str, Any] | None = None


@dataclass
class BulkRowResult:
    index: int
    status: str  # created | failed | skipped
    timeEntryId: str | None = None
    errors: list[ValidationError] = field(default_factory=list)


@dataclass
class BulkSummary:
    requested: int
    created: int
    failed: int
    skipped: int
    totalMinutes: int


# ---------------------------------------------------------------- Zaman baglami


@dataclass
class EffortClass:
    id: str
    name: str | None = None
    position: int | None = None
    costMultiplier: float | None = None
    disabled: bool | None = None


@dataclass
class TimeAllocation:
    id: str
    name: str | None = None
    group: str | None = None
    descriptionRequired: bool | None = None


@dataclass
class TimeTrackingDefaults:
    requestEffortClassId: str | None = None
    taskEffortClassId: str | None = None
    projectTaskEffortClassId: str | None = None
    problemEffortClassId: str | None = None
    timeAllocationEffortClassId: str | None = None


@dataclass
class TimeTrackingContext:
    # timeIncrement bilinmeden timeSpent SECILEMEZ. Varsayilan 60'tir; yani
    # varsayilan yapilandirmada 45 dakikalik bir giris REDDEDILIR.
    timeIncrement: int | None
    effortClasses: list[EffortClass]
    defaults: TimeTrackingDefaults
    unit: str | None = None
    workday: int | None = None
    workweek: int | None = None
    allowWorkdayOvertime: bool | None = None
    allowWorkweekOvertime: bool | None = None
    allocationTimeTracking: bool | None = None
    assignmentTimeTracking: bool | None = None
    requireNote: bool | None = None
    requireTimeEntryDescription: bool | None = None
    timeAllocations: list[TimeAllocation] = field(default_factory=list)


# ---------------------------------------------------------------- Plan onerisi


@dataclass
class Proposal:
    meetingTitle: str
    startedAt: str
    rawMinutes: int
    roundedMinutes: int
    needsUserDecision: bool
    suggestedTargetType: str | None = None
    suggestedTargetId: str | None = None
    suggestedTargetLabel: str | None = None
    matchReason: str | None = None
    matchConfidence: float | None = None
    warnings: list[str] = field(default_factory=list)
