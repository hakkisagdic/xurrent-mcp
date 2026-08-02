"""8 tool'un outputSchema'lari — contract/tools.json'daki "output" alanlarindan
BIREBIR turetilmistir.

NEDEN ELLE YAZILIYOR: dusuk seviye `Server` kullaniyoruz; MCPServer (eski FastMCP)
semayi fonksiyon imzasindan URETIR ve o uretim sozlesmeyi (default'lar, enum'lar,
["string","null"] birlesimleri) korumaz. Semayi elle vermek sozlesmeye birebir
uymanin TEK yoludur.

NEDEN $defs HER SEMANIN ICINE KOPYALANIYOR: `$ref: "#/$defs/Person"` ifadesi
BULUNDUGU DOKUMANIN kokune gore cozulur. tools/list'te her tool'un outputSchema'si
ayri bir dokumandir; ortak bir dosyaya isaret edemez. Bu yuzden kullanilan
tanimlar her semanin kokune kopyalanir — semalar KENDI KENDINE YETERLIDIR.

TEK BILINCLI SAPMA: PlannedMutation.index sozlesmede {"type": "integer"} ama
tekil xurrent_create_time_entry ciktisinda bu alan null gelir (bulk'ta dolar).
Sema client tarafinda structuredContent'i DOGRULAMAK icin kullanilir; gercek
ciktiyi reddeden bir sema tool'u kirar. Bu yuzden yalnizca bu alanda nullable'a
genisletildi ve sebep burada yazili.
"""

from __future__ import annotations

from typing import Any

# ------------------------------------------------------------------ $defs

PERSON_DEF: dict[str, Any] = {
    "type": "object",
    "required": ["id", "name"],
    "properties": {
        "id": {"type": "string"},
        "name": {"type": ["string", "null"]},
        "primaryEmail": {"type": ["string", "null"]},
        "jobTitle": {"type": ["string", "null"]},
        "timeZone": {"type": ["string", "null"]},
        "disabled": {"type": ["boolean", "null"]},
        "organization": {
            "type": ["object", "null"],
            "properties": {
                "id": {"type": "string"},
                "name": {"type": ["string", "null"]},
            },
        },
    },
}

WORK_ITEM_DEF: dict[str, Any] = {
    "type": "object",
    "required": ["id", "displayId", "subject", "status", "kind"],
    "properties": {
        "kind": {"enum": ["request", "task"]},
        "id": {
            "type": "string",
            "description": "Opak GraphQL node ID — mutation'larda BU kullanilir",
        },
        "displayId": {
            "type": "string",
            "description": "UI'da gorunen numara. Request'te requestId, Task'ta taskId.",
        },
        "subject": {"type": ["string", "null"]},
        "status": {"type": ["string", "null"]},
        "statusLabel": {"type": ["string", "null"], "description": "Turkce okunur durum"},
        "isOpen": {"type": "boolean"},
        "targetAt": {
            "type": ["string", "null"],
            "description": "Request'te nextTargetAt, Task'ta completionTargetAt",
        },
        "team": {"type": ["string", "null"]},
        "member": {"type": ["string", "null"]},
        "parentLabel": {"type": ["string", "null"]},
        "updatedAt": {"type": ["string", "null"]},
    },
}

WORK_PAGE_DEF: dict[str, Any] = {
    "type": "object",
    "required": ["totalCount", "nodes"],
    "properties": {
        "totalCount": {"type": "integer"},
        "hasNextPage": {"type": "boolean"},
        "endCursor": {"type": ["string", "null"]},
        "nodes": {"type": "array", "items": {"$ref": "#/$defs/WorkItem"}},
    },
}

MEETING_DEF: dict[str, Any] = {
    "type": "object",
    "required": ["id", "uid", "title", "start", "end", "minutes"],
    "properties": {
        "source": {"enum": ["mock", "ics", "google", "graph"]},
        "id": {"type": "string"},
        "uid": {"type": "string", "description": "Dedup anahtari: iCalUID + start instant"},
        "title": {"type": "string"},
        "start": {"type": "string", "description": "ISO8601, offset'li mutlak instant"},
        "end": {"type": "string"},
        "minutes": {"type": "integer"},
        "isAllDay": {"type": "boolean"},
        "isCancelled": {"type": "boolean"},
        "declined": {"type": "boolean"},
        "free": {
            "type": "boolean",
            "description": "showAs=free veya transparency=transparent",
        },
        "skipped": {"type": "boolean", "description": "Filtreden elendi mi"},
        "skipReason": {"type": ["string", "null"], "description": "Turkce gerekce — ogretici"},
        "organizer": {"type": ["string", "null"]},
        "attendeeCount": {"type": "integer"},
        "categories": {"type": "array", "items": {"type": "string"}},
        "seriesId": {"type": ["string", "null"]},
        "joinUrl": {"type": ["string", "null"]},
    },
}

PLANNED_MUTATION_DEF: dict[str, Any] = {
    "type": "object",
    "required": ["path", "mutation", "input", "warnings"],
    "properties": {
        # Sozlesmede "integer"; tekil yazmada null gelir -> nullable'a genisletildi
        # (dosya basindaki "TEK BILINCLI SAPMA" notuna bak).
        "index": {"type": ["integer", "null"]},
        "path": {
            "enum": [
                "timeEntryCreate",
                "requestUpdate",
                "taskUpdate",
                "projectTaskUpdate",
                "problemUpdate",
                "timeEntryUpdate",
            ],
            "description": "Hangi Xurrent mutation'i calistirilacak/calistirildi",
        },
        "mutation": {
            "type": "string",
            "description": "Gonderilecek GraphQL mutation metni — derste birebir gosterilir",
        },
        "input": {"type": "object", "description": "Mutation degiskenleri"},
        "warnings": {"type": "array", "items": {"type": "string"}},
        "stepLabel": {
            "type": ["string", "null"],
            "description": "two_step stratejisinde '1/2' veya '2/2'",
        },
    },
}

VALIDATION_ERROR_DEF: dict[str, Any] = {
    "type": "object",
    "required": ["message"],
    "properties": {
        "message": {"type": "string"},
        "path": {"type": ["array", "null"], "items": {"type": "string"}},
    },
}


# ------------------------------------------------------------------ semalar

WHOAMI_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["person", "account", "mode"],
    "properties": {
        "person": {"$ref": "#/$defs/Person"},
        "account": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {"type": "string"},
                "name": {"type": ["string", "null"]},
                "directory": {"type": ["boolean", "null"]},
            },
        },
        "mode": {"enum": ["mock", "live"], "description": "Hangi Xurrent adapter'i aktif"},
        "rateLimit": {
            # mock modda HER ZAMAN null — deterministik cikti icin (bkz. toolimpl).
            "type": ["object", "null"],
            "properties": {
                "limit": {"type": "number"},
                "cost": {"type": "number"},
                "remaining": {"type": "number"},
                "resetAt": {"type": "number"},
            },
        },
    },
    "$defs": {"Person": PERSON_DEF},
}

FIND_PERSON_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["totalCount", "people"],
    "properties": {
        "totalCount": {"type": "integer"},
        "people": {"type": "array", "items": {"$ref": "#/$defs/Person"}},
        "suggestFuzzy": {
            "type": "boolean",
            "description": "true ise tam eslesme bulunamadi; serbest metin arama onerilebilir.",
        },
    },
    "$defs": {"Person": PERSON_DEF},
}

LIST_OPEN_WORK_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["requests", "tasks", "accountId"],
    "properties": {
        "accountId": {
            "type": "string",
            "description": (
                "Cache anahtari (accountId, nodeId) olmali — status/member/team "
                "alanlari account-specific'tir."
            ),
        },
        "requests": {"$ref": "#/$defs/WorkPage"},
        "tasks": {"$ref": "#/$defs/WorkPage"},
    },
    "$defs": {"WorkPage": WORK_PAGE_DEF, "WorkItem": WORK_ITEM_DEF},
}

TIME_TRACKING_CONTEXT_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["timeIncrement", "effortClasses", "defaults"],
    "properties": {
        "unit": {"type": ["string", "null"], "enum": ["hours_and_minutes", "percentage_of_workday", None]},
        "timeIncrement": {
            "type": ["integer", "null"],
            "description": "timeSpent'in minimumu VE adimi (dakika)",
        },
        "workday": {"type": ["integer", "null"], "description": "Gunluk dakika, varsayilan 480"},
        "workweek": {"type": ["integer", "null"], "description": "Haftalik dakika, varsayilan 2400"},
        "allowWorkdayOvertime": {"type": ["boolean", "null"]},
        "allowWorkweekOvertime": {"type": ["boolean", "null"]},
        "allocationTimeTracking": {"type": ["boolean", "null"]},
        "assignmentTimeTracking": {"type": ["boolean", "null"]},
        "requireNote": {"type": ["boolean", "null"]},
        "requireTimeEntryDescription": {"type": ["boolean", "null"]},
        "effortClasses": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {
                    "id": {"type": "string"},
                    "name": {"type": ["string", "null"]},
                    "position": {"type": ["integer", "null"]},
                    "costMultiplier": {"type": ["number", "null"]},
                    "disabled": {"type": ["boolean", "null"]},
                },
            },
        },
        "timeAllocations": {
            "type": "array",
            "description": "Yol A icin secilebilir allocation'lar",
            "items": {
                "type": "object",
                "required": ["id", "name"],
                "properties": {
                    "id": {"type": "string"},
                    "name": {"type": ["string", "null"]},
                    "group": {"type": ["string", "null"]},
                    "descriptionRequired": {"type": ["boolean", "null"]},
                },
            },
        },
        "defaults": {
            "type": "object",
            "properties": {
                "requestEffortClassId": {"type": ["string", "null"]},
                "taskEffortClassId": {"type": ["string", "null"]},
                "projectTaskEffortClassId": {"type": ["string", "null"]},
                "problemEffortClassId": {"type": ["string", "null"]},
                "timeAllocationEffortClassId": {"type": ["string", "null"]},
            },
        },
    },
}

# Sozlesmede bu tool'un ciktisi {"$ref": "#/$defs/WriteResult"}. outputSchema'nin
# KOKU 2025-11-25'e kadar `type: "object"` olmak ZORUNDA — bu yuzden WriteResult
# burada koke ACILARAK yaziliyor (ref degil, govde).
CREATE_TIME_ENTRY_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["dryRun", "strategy", "planned", "warnings", "errors"],
    "properties": {
        "dryRun": {"type": "boolean"},
        "strategy": {"enum": ["two_step", "link_first", "date_first"]},
        "strategyExplanation": {
            "type": "string",
            "description": "Secilen stratejinin Turkce gerekcesi ve neyi feda ettigi",
        },
        "planned": {
            "type": "array",
            "items": {"$ref": "#/$defs/PlannedMutation"},
            "description": "two_step'te 2 eleman, digerlerinde 1",
        },
        "warnings": {"type": "array", "items": {"type": "string"}},
        "timeEntry": {"type": ["object", "null"]},
        "errors": {"type": "array", "items": {"$ref": "#/$defs/ValidationError"}},
    },
    "$defs": {
        "PlannedMutation": PLANNED_MUTATION_DEF,
        "ValidationError": VALIDATION_ERROR_DEF,
    },
}

CREATE_TIME_ENTRIES_BULK_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["dryRun", "planned", "results", "summary"],
    "properties": {
        "dryRun": {"type": "boolean"},
        "planned": {"type": "array", "items": {"$ref": "#/$defs/PlannedMutation"}},
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["index", "status"],
                "properties": {
                    "index": {"type": "integer"},
                    "status": {"enum": ["created", "failed", "skipped"]},
                    "timeEntryId": {"type": ["string", "null"]},
                    "errors": {"type": "array", "items": {"$ref": "#/$defs/ValidationError"}},
                },
            },
        },
        "summary": {
            "type": "object",
            "required": ["requested", "created", "failed", "skipped", "totalMinutes"],
            "properties": {
                "requested": {"type": "integer"},
                "created": {"type": "integer"},
                "failed": {"type": "integer"},
                "skipped": {"type": "integer"},
                "totalMinutes": {"type": "integer"},
            },
        },
    },
    "$defs": {
        "PlannedMutation": PLANNED_MUTATION_DEF,
        "ValidationError": VALIDATION_ERROR_DEF,
    },
}

CALENDAR_LIST_TODAY_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["windowStart", "windowEnd", "timeZone", "provider", "meetings", "totals"],
    "properties": {
        "windowStart": {"type": "string"},
        "windowEnd": {"type": "string"},
        "timeZone": {"type": "string"},
        "provider": {"type": "string"},
        "meetings": {"type": "array", "items": {"$ref": "#/$defs/Meeting"}},
        "totals": {
            "type": "object",
            "required": ["count", "busyMinutes", "rawCount", "filteredOut"],
            "properties": {
                "count": {"type": "integer"},
                "busyMinutes": {
                    "type": "integer",
                    "description": "Cakismalar BIR KEZ sayilir (interval merge)",
                },
                "naiveSumMinutes": {
                    "type": "integer",
                    "description": "Cakismalari ayri sayan naif toplam — farki gostermek ogreticidir",
                },
                "rawCount": {"type": "integer"},
                "filteredOut": {"type": "integer"},
            },
        },
    },
    "$defs": {"Meeting": MEETING_DEF},
}

PLAN_FROM_CALENDAR_OUTPUT: dict[str, Any] = {
    "type": "object",
    "required": ["date", "proposals", "totals"],
    "properties": {
        "date": {"type": "string"},
        "timeIncrement": {"type": ["integer", "null"]},
        "proposals": {
            "type": "array",
            "items": {
                "type": "object",
                "required": [
                    "meetingTitle",
                    "startedAt",
                    "rawMinutes",
                    "roundedMinutes",
                    "needsUserDecision",
                ],
                "properties": {
                    "meetingTitle": {"type": "string"},
                    "startedAt": {"type": "string"},
                    "rawMinutes": {"type": "integer"},
                    "roundedMinutes": {"type": "integer"},
                    "suggestedTargetType": {"type": ["string", "null"]},
                    "suggestedTargetId": {"type": ["string", "null"]},
                    "suggestedTargetLabel": {"type": ["string", "null"]},
                    "matchReason": {
                        "type": ["string", "null"],
                        "description": "Turkce, insan-okunur gerekce",
                    },
                    "matchConfidence": {"type": ["number", "null"], "minimum": 0, "maximum": 1},
                    "needsUserDecision": {"type": "boolean"},
                    "warnings": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "unmatchedMeetings": {"type": "array", "items": {"type": "string"}},
        "totals": {
            "type": "object",
            "properties": {
                "meetingMinutes": {"type": "integer"},
                "proposedMinutes": {"type": "integer"},
            },
        },
    },
}


OUTPUT_SCHEMAS: dict[str, dict[str, Any]] = {
    "xurrent_whoami": WHOAMI_OUTPUT,
    "xurrent_find_person": FIND_PERSON_OUTPUT,
    "xurrent_list_open_work": LIST_OPEN_WORK_OUTPUT,
    "xurrent_get_time_tracking_context": TIME_TRACKING_CONTEXT_OUTPUT,
    "xurrent_create_time_entry": CREATE_TIME_ENTRY_OUTPUT,
    "xurrent_create_time_entries_bulk": CREATE_TIME_ENTRIES_BULK_OUTPUT,
    "calendar_list_today": CALENDAR_LIST_TODAY_OUTPUT,
    "plan_time_entries_from_calendar": PLAN_FROM_CALENDAR_OUTPUT,
}

__all__ = ["OUTPUT_SCHEMAS"]
