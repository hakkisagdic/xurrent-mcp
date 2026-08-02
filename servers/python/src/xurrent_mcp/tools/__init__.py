"""8 tool'un sozlesmesi ve kayit defteri.

inputSchema, tool adlari ve parametre adlari contract/tools.json ile BIREBIR
aynidir. scripts/verify-contract.mjs uc sunucunun tools/list ciktisini o dosyaya
karsi dogrular; burada tek bir alan sapmasi testi kirmalidir.

LLM'in tool'lari nasil kullanacagini ogrenmesinin TEK yolu bu aciklamalardir.
Kotu yazilmis bir description = yanlis kullanilan bir tool.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..core.schemas import OUTPUT_SCHEMAS
from .calendar_tools import calendar_list_today, plan_time_entries_from_calendar
from .read_tools import (
    xurrent_find_person,
    xurrent_get_time_tracking_context,
    xurrent_list_open_work,
    xurrent_whoami,
)
from .runtime import ConfirmationState, Runtime
from .write_tools import xurrent_create_time_entries_bulk, xurrent_create_time_entry


@dataclass(frozen=True)
class ToolSpec:
    name: str
    kind: str  # read | write | preview
    description: str
    input_schema: dict[str, Any]
    annotations: dict[str, bool]
    handler: Callable[[Runtime, dict[str, Any]], dict[str, Any]]
    teaching_notes: list[str] = field(default_factory=list)

    @property
    def output_schema(self) -> dict[str, Any]:
        """contract/tools.json'daki "output" alanindan turetilmis sema.

        Ayri bir modulde (core/schemas.py) durur cunku semayi HEM tools/list
        beyani HEM de structuredContent dogrulamasi kullanir; ikisi de ayni
        kaynaktan beslenmek zorundadir.
        """
        return OUTPUT_SCHEMAS[self.name]


READ_ONLY = {"readOnlyHint": True, "idempotentHint": True, "openWorldHint": True}
WRITE = {
    "readOnlyHint": False,
    "destructiveHint": False,
    "idempotentHint": False,
    "openWorldHint": True,
}


TOOLS: list[ToolSpec] = [
    ToolSpec(
        name="xurrent_whoami",
        kind="read",
        description=(
            "Authenticated kullaniciyi, hesabi ve rate limit durumunu doner. "
            "Ayni zamanda baglanti smoke test'idir."
        ),
        annotations=READ_ONLY,
        input_schema={"type": "object", "properties": {}, "additionalProperties": False},
        handler=xurrent_whoami,
    ),
    ToolSpec(
        name="xurrent_find_person",
        kind="read",
        description=(
            "Kisiyi birincil e-posta ile bulur. TAM eslesme yapar (substring degil) — "
            "Xurrent PersonFilter.primaryEmail bir TextFilter'dir."
        ),
        annotations=READ_ONLY,
        input_schema={
            "type": "object",
            "required": ["email"],
            "additionalProperties": False,
            "properties": {
                "email": {
                    "type": "string",
                    "description": "Birincil e-posta. TAM eslesme; buyuk-kucuk harf ve format duyarli.",
                },
                "view": {
                    "enum": ["all", "current_account"],
                    "default": "all",
                    "description": (
                        "Varsayilan 'all' — 'current_account' kullanicinin diger "
                        "hesaplardaki kaydini gizler."
                    ),
                },
            },
        },
        handler=xurrent_find_person,
    ),
    ToolSpec(
        name="xurrent_list_open_work",
        kind="read",
        description=(
            "ISTER #1: Bir kisinin uzerindeki acik Request ve Task'lari id + aciklama "
            "ile listeler."
        ),
        annotations=READ_ONLY,
        teaching_notes=[
            "TUZAK 1 — Filtre asimetrisi: RequestFilter'da atanan kisi alani 'member', "
            "TaskFilter'da 'assignee'. Karistirmak sessizce bos sonuc dondurur.",
            "TUZAK 2 — view varsayilani 'current_account'tur. 'all' gecilmezse kisinin "
            "diger hesaplardaki isleri gorunmez.",
            "TUZAK 3 — Acik/kapali ayrimi sadece status ile yapilir; 'open' diye bir view YOKTUR.",
            "TUZAK 4 — Request'te tamamlanma alani 'completedAt', Task'ta 'finishedAt'.",
            "TUZAK 5 — GraphQL'de personId variable'i String! olarak deklare edilmeli (ID! degil).",
        ],
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "personId": {
                    "type": "string",
                    "default": "$me",
                    "description": "Person node ID veya '$me'",
                },
                "include": {
                    "type": "array",
                    "items": {"enum": ["requests", "tasks"]},
                    "default": ["requests", "tasks"],
                },
                "first": {"type": "integer", "minimum": 1, "maximum": 100, "default": 25},
                "afterRequests": {"type": "string", "description": "Request sayfalama cursor'i"},
                "afterTasks": {"type": "string", "description": "Task sayfalama cursor'i"},
                "view": {"enum": ["all", "current_account"], "default": "all"},
            },
        },
        handler=xurrent_list_open_work,
    ),
    ToolSpec(
        name="xurrent_get_time_tracking_context",
        kind="read",
        description=(
            "Zaman yazmadan ONCE calistirilmasi ZORUNLU olan baglam sorgusu: "
            "timeIncrement, effort class'lar, timesheet kisitlari."
        ),
        annotations=READ_ONLY,
        teaching_notes=[
            "timeIncrement bilinmeden timeSpent SECILEMEZ. Varsayilan 60'tir; yani "
            "varsayilan yapilandirmada 45 dakikalik bir giris reddedilir.",
            "Izinli timeIncrement degerleri: 5, 10, 15, 30, 60, 120, 240.",
            "allocationTimeTracking=false ise Yol A (timeEntryCreate) tamamen kapalidir.",
            "assignmentTimeTracking=false ise Yol B (requestUpdate/taskUpdate) kapalidir.",
            "EffortClassFilter'da 'disabled' filtresi YOKTUR — client tarafinda elenir.",
            "Sonuc session icinde cache'lenmelidir.",
        ],
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {"personId": {"type": "string", "default": "$me"}},
        },
        handler=xurrent_get_time_tracking_context,
    ),
    ToolSpec(
        name="xurrent_create_time_entry",
        kind="write",
        description=(
            "ISTER #3: Tek bir zaman girisi olusturur. targetType'a gore Yol A veya "
            "Yol B'ye yonlendirir."
        ),
        annotations=WRITE,
        teaching_notes=[
            "IKI YAZMA YOLU VARDIR VE BIRBIRININ YERINE GECMEZ.",
            "Yol A — timeEntryCreate: date/startedAt/personId tam kontrol, AMA "
            "Request/Task'a BAGLANAMAZ (assignment=null).",
            "Yol B — requestUpdate/taskUpdate/projectTaskUpdate/problemUpdate: ticket'a "
            "baglar, AMA date='bugun' ve person=authenticated user olarak sunucu atar.",
            "TimeEntryCreateInput icinde requestId/taskId/assignmentId alani YOKTUR.",
            "Yol B'de timeSpent ARTIMLIDIR: 'en son giristen bu yana eklenen sure'.",
            "Negatif timeSpent yalnizca correction=true ile mumkundur.",
        ],
        input_schema={
            "type": "object",
            "required": ["targetType", "targetId", "minutes"],
            "additionalProperties": False,
            "properties": {
                "targetType": {
                    "enum": ["time_allocation", "request", "task", "project_task", "problem"],
                    "description": "'time_allocation' -> Yol A. Digerleri -> Yol B.",
                },
                "targetId": {
                    "type": "string",
                    "description": (
                        "time_allocation icin TimeAllocation node ID; digerleri icin "
                        "parent kaydin node ID'si"
                    ),
                },
                "minutes": {
                    "type": "integer",
                    "description": (
                        "DAKIKA. timeIncrement'in kati olmali. Negatif yalnizca correction=true ile."
                    ),
                },
                "date": {
                    "type": "string",
                    "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
                    "description": "ISO8601 tarih. Bossa bugun. T-1'den eski degerler reddedilir.",
                },
                "startedAt": {
                    "type": "string",
                    "description": (
                        "ISO8601 timestamp, offset ZORUNLU. Sadece metadata; timesheet "
                        "gununu DEGISTIRMEZ."
                    ),
                },
                "personId": {
                    "type": "string",
                    "description": (
                        "Bossa authenticated user. Farkli ise manager/substitute/Account "
                        "Administrator yetkisi gerekir."
                    ),
                },
                "effortClassId": {"type": "string"},
                "description": {
                    "type": "string",
                    "maxLength": 80,
                    "description": "REST'te max 80 karakter.",
                },
                "note": {
                    "type": "string",
                    "description": "Yalnizca Yol B'de anlamli; TimeEntry.note olusturur.",
                },
                "customerId": {"type": "string", "description": "Yalnizca Yol A"},
                "serviceId": {"type": "string", "description": "Yalnizca Yol A"},
                "organizationId": {
                    "type": "string",
                    "description": "Yalnizca Yol A. Kisinin KENDI organizasyonu (musteri degil).",
                },
                "teamId": {"type": "string", "description": "Yalnizca Yol A"},
                "correction": {"type": "boolean", "default": False},
                "sourceId": {
                    "type": "string",
                    "description": "Idempotency anahtari. Bossa deterministik uretilir.",
                },
                "backdateStrategy": {
                    "enum": ["two_step", "link_first", "date_first"],
                    "description": (
                        "Yol B + gecmis tarih catismasini cozme stratejisi. Bossa "
                        "XURRENT_BACKDATE_STRATEGY env degeri kullanilir."
                    ),
                },
                "dryRun": {
                    "type": "boolean",
                    "default": False,
                    "description": (
                        "true ise HICBIR mutation gonderilmez; sadece plan + uyarilar doner."
                    ),
                },
            },
        },
        handler=xurrent_create_time_entry,
    ),
    ToolSpec(
        name="xurrent_create_time_entries_bulk",
        kind="write",
        description=(
            "Birden cok zaman girisini sirayla olusturur. ATOMIK DEGILDIR — kismi "
            "basari normaldir."
        ),
        annotations=WRITE,
        teaching_notes=[
            "GraphQL istek basina 1 mutation kabul eder -> bulk = N ayri HTTP istegi.",
            "Rate limit 20 istek / 2 saniye -> istekler arasi en az 110 ms bekleme.",
            "Atomik olmadigi icin her satir ayri raporlanir.",
            "Onay (elicitation) N kez degil, OZET uzerinden BIR kez sorulur.",
        ],
        input_schema={
            "type": "object",
            "required": ["entries"],
            "additionalProperties": False,
            "properties": {
                "entries": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 50,
                    "items": {
                        "type": "object",
                        "description": (
                            "xurrent_create_time_entry input'u (dryRun ve backdateStrategy haric)"
                        ),
                    },
                },
                "dryRun": {"type": "boolean", "default": False},
                "stopOnError": {
                    "type": "boolean",
                    "default": True,
                    "description": "true ise ilk hatada durur — yarim kalan durumu netlestirir.",
                },
                "backdateStrategy": {"enum": ["two_step", "link_first", "date_first"]},
            },
        },
        handler=xurrent_create_time_entries_bulk,
    ),
    ToolSpec(
        name="calendar_list_today",
        kind="read",
        description=(
            "ISTER #4 (1. yari): Kisinin belirtilen gundeki takvimini okur, normalize "
            "eder ve gercek toplantilari filtreler."
        ),
        annotations=READ_ONLY,
        teaching_notes=[
            "Pencere HER ZAMAN yerel gece yarisindan yerel gece yarisina, OFFSET GOMULU kurulur.",
            "Microsoft Graph: 'events' degil 'calendarView' kullanilir.",
            "Graph'in dateTime alani OFFSET TASIMAZ ve 7 kesirli hane icerir.",
            "Google: singleEvents varsayilani FALSE'tur; true yapilmazsa tekrarlayanlar gorunmez.",
            "Google'in transparency alani varsayilan 'opaque' iken cevapta CIKMAZ.",
            "Filtre bir OVERLAP filtresidir -> pencereye clip edilmeli.",
            "Dedup anahtari iCalUID TEK BASINA yetmez; start instant'i dahil edilir.",
        ],
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "provider": {
                    "enum": ["mock", "ics", "google", "graph", "auto"],
                    "default": "auto",
                },
                "userEmail": {
                    "type": "string",
                    "description": (
                        "app-only/domain-wide-delegation modunda impersonate edilecek kullanici"
                    ),
                },
                "date": {
                    "type": "string",
                    "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
                    "description": "Bossa bugun",
                },
                "timeZone": {
                    "type": "string",
                    "default": "Europe/Istanbul",
                    "description": "IANA zone",
                },
                "includeAllDay": {"type": "boolean", "default": False},
                "includeDeclined": {"type": "boolean", "default": False},
                "includeFree": {"type": "boolean", "default": False},
            },
        },
        handler=calendar_list_today,
    ),
    ToolSpec(
        name="plan_time_entries_from_calendar",
        kind="preview",
        description=(
            "ISTER #4 (2. yari): Takvim + acik is listesini birlestirip ONERILEN zaman "
            "girisi plani uretir. ASLA YAZMAZ."
        ),
        annotations=READ_ONLY,
        teaching_notes=[
            "Bu tool yapisal olarak yazma yetenegi olmayan bir tool'dur — dry-run'in "
            "ucuncu ve en guclu katmani.",
            "Eslesme heuristigi basit ve ACIKLANABILIR tutulur: (1) baslikta ticket "
            "numarasi deseni, (2) normalize edilmis metin benzerligi, (3) hicbiri "
            "tutmazsa needsUserDecision=true.",
            "roundedMinutes her zaman timeIncrement katina yuvarlanir ve yuvarlama "
            "HER ZAMAN warnings'e yazilir.",
        ],
        input_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "personId": {"type": "string", "default": "$me"},
                "date": {"type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$"},
                "timeZone": {"type": "string", "default": "Europe/Istanbul"},
                "provider": {
                    "enum": ["mock", "ics", "google", "graph", "auto"],
                    "default": "auto",
                },
                "defaultTargetType": {"enum": ["time_allocation", "request", "task"]},
                "defaultTargetId": {"type": "string"},
                "roundingMode": {"enum": ["nearest", "up", "down"], "default": "nearest"},
            },
        },
        handler=plan_time_entries_from_calendar,
    ),
]

TOOLS_BY_NAME: dict[str, ToolSpec] = {spec.name: spec for spec in TOOLS}


def call_tool(rt: Runtime, name: str, args: dict[str, Any] | None) -> dict[str, Any]:
    """Tool'u ada gore, ONAY KANALI OLMADAN calistirir. Bilinmeyen ad -> ValueError.

    Bu giris noktasini web /tool ucu ve chatbot kullanir; ikisinin de protokol
    seviyesinde onay sorma imkani YOKTUR. Bu yuzden onay durumu ACIKCA
    sifirlanir — ayni Runtime uzerinde daha once yapilmis onayli bir cagridan
    artakalan bayrak, sonraki cagriyi onayli gostermemelidir.
    XURRENT_CONFIRM_POLICY=strict altinda bu yoldan yazma REDDEDILIR; onay
    sorabilen bir yol icin core.toolimpl.run_tool kullanin.
    """
    spec = TOOLS_BY_NAME.get(name)
    if spec is None:
        raise ValueError(f"Bilinmeyen tool: {name}")
    rt.confirmation = ConfirmationState()
    return spec.handler(rt, args or {})


__all__ = [
    "ConfirmationState",
    "Runtime",
    "TOOLS",
    "TOOLS_BY_NAME",
    "ToolSpec",
    "call_tool",
]
