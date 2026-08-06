"""Uc backdate stratejisi — dersin kalbi.

XURRENT'TA BIR REQUEST/TASK'A ZAMAN YAZMANIN IKI YOLU VARDIR VE IKISI DE
TEK BASINA YETERSIZDIR:

  Yol A  timeEntryCreate            -> date/startedAt/personId TAM KONTROL,
                                       ama ticket'a BAGLANAMAZ (assignment=null)
  Yol B  requestUpdate/taskUpdate   -> ticket'a BAGLAR,
                                       ama date="bugun", person=authenticated user

TimeEntryCreateInput icinde requestId/taskId/assignmentId ALANI YOKTUR.
Ticket'a baglamanin TEK yolu parent update mutation'una timeSpent gondermektir.

Uc strateji bu catali uc farkli sekilde cozer. Hicbiri "dogru cevap" degildir;
hangisinin dogru oldugunu RAPORLAMA IHTIYACI belirler.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import Config
from ..models import PlannedMutation, TimeTrackingContext
from ..timeutil import iso_date, today_in
from . import queries
from .validate import TimeEntryRequest, deterministic_source_id

# two_step'in 2. adiminda kullanilan yer tutucu. Calisma aninda 1. adimda
# olusan TimeEntry'nin gercek id'si ile degistirilir.
STEP1_ENTRY_ID_PLACEHOLDER = "{{step1.timeEntry.id}}"

STRATEGY_EXPLANATIONS = {
    "two_step": (
        "Iki adimli telafi: once Yol B ile ticket'a bagli entry olusturulur "
        "(tarih=bugun), ardindan timeEntryUpdate ile date + startedAt + personId "
        "duzeltilir. Her seyi korur. Bedeli: 2 HTTP istegi ve ATOMIK OLMAMASI. "
        "Neden calisir: TimeEntryUpdateInput'ta assignment alani YOKTUR, bu yuzden "
        "2. adim ticket bagini bozamaz — kisiti avantaja ceviren nokta budur."
    ),
    "link_first": (
        "Ticket bagi oncelikli: yalnizca Yol B calisir. Tek istek, atomik, en basit "
        "ve en dayanikli yol. Feda edilen: tarih HER ZAMAN bugun olur, baslangic "
        "saati kaydedilmez, kayit her zaman authenticated user adina yazilir."
    ),
    "date_first": (
        "Tarih oncelikli: yalnizca Yol A calisir (TimeAllocation hedefli). date, "
        "startedAt ve personId tam dogru; tek istek, atomik. Feda edilen: kayit "
        "ticket'a BAGLANMAZ (assignment=null). Ticket bazli raporlama yapiliyorsa "
        "bu secenek UYGUN DEGILDIR."
    ),
}


@dataclass
class Plan:
    strategy: str
    explanation: str
    planned: list[PlannedMutation]
    warnings: list[str]


def build_plan(
    req: TimeEntryRequest,
    ctx: TimeTrackingContext,
    config: Config,
    *,
    authenticated_person_id: str,
    target_label: str | None = None,
) -> Plan:
    """Istegi, secilen stratejiye gore planlanmis mutation dizisine cevirir."""
    strategy = req.backdateStrategy or config.backdate_strategy
    source_id = req.sourceId or deterministic_source_id(req, config)
    today = today_in(config.timezone)
    entry_date = req.date or iso_date(today)
    is_backdated = entry_date != iso_date(today)
    warnings: list[str] = []

    # ---- Hedef bir TimeAllocation ise Yol A ZATEN tek secenektir --------
    if req.is_allocation:
        planned = [_time_entry_create(req, ctx, config, source_id, req.targetId, entry_date)]
        warnings.append(
            "Hedef bir TimeAllocation oldugu icin Yol A (timeEntryCreate) zaten tek "
            "secenektir. Bu kayit hicbir ticket'a BAGLANMAZ (assignment=null)."
        )
        return Plan("date_first", STRATEGY_EXPLANATIONS["date_first"], planned, warnings)

    # ---- date_first: hedef otomatik olarak TimeAllocation'a cevrilir ----
    if strategy == "date_first":
        allocation_id = config.default_time_allocation_id or _first_allocation_id(ctx)
        if not allocation_id:
            warnings.append(
                "date_first secildi ama DEFAULT_TIME_ALLOCATION_ID tanimli degil ve "
                "hesapta secilebilir TimeAllocation bulunamadi. .env dosyasini kontrol edin."
            )
        label = target_label or f"{req.targetType} {req.targetId}"
        warnings.append(
            f"date_first: bu kayit '{label}' hedefine BAGLANMAYACAK. Hedef otomatik "
            f"olarak varsayilan TimeAllocation'a ({allocation_id or 'TANIMSIZ'}) cevrildi. "
            "Ticket bazli raporlamada bu kayit GORUNMEZ."
        )
        planned = [
            _time_entry_create(req, ctx, config, source_id, allocation_id, entry_date)
        ]
        return Plan("date_first", STRATEGY_EXPLANATIONS["date_first"], planned, warnings)

    # ---- Yol B ortak adimi (link_first ve two_step icin 1. adim) --------
    parent_step = _parent_update(req, ctx, config, source_id)

    if strategy == "link_first":
        if is_backdated:
            # Ister #2'deki T-1 bu yolda KARSILANAMAZ. Bot bunu kullaniciya
            # soylemek ZORUNDADIR; sessizce bugune yazmak kabul edilemez.
            warnings.append(
                f"link_first: istenen tarih {entry_date} idi ama bu yolda date'i "
                f"SUNUCU 'bugun' ({iso_date(today)}) olarak atar. T-1 KARSILANAMADI."
            )
        if req.startedAt:
            warnings.append(
                "link_first: startedAt bu yolda KAYDEDILMEZ; baslangic saati kaybolur."
            )
        if req.personId and req.personId not in ("$me", authenticated_person_id):
            warnings.append(
                "link_first: kayit her zaman authenticated user adina yazilir; "
                "personId YOK SAYILIR."
            )
        parent_step.stepLabel = None
        return Plan(
            "link_first", STRATEGY_EXPLANATIONS["link_first"], [parent_step], warnings
        )

    # ---- two_step -------------------------------------------------------
    parent_step.stepLabel = "1/2"
    parent_step.index = 0
    parent_step.warnings.append(
        "1/2 — Bu adim ticket'a bagli bir TimeEntry olusturur; tarih SUNUCU tarafindan "
        "bugun atanir. Duzeltme 2. adimda yapilir."
    )

    fix_step = _time_entry_update(req, config, entry_date, authenticated_person_id)
    fix_step.stepLabel = "2/2"
    fix_step.index = 1

    warnings.append(
        "two_step ATOMIK DEGILDIR: 1. adim basarili olup 2. adim basarisiz olabilir. "
        "Bu durumda ticket'a bagli ama tarihi BUGUN olan bir kayit kalir — "
        "gercek bir risktir ve saklanmaz."
    )
    warnings.append(
        "2. adimda guncellenecek TimeEntry id'si calisma aninda bulunur: parent update "
        "payload'i Request/Task doner, olusan TimeEntry'yi DEGIL. Bu yuzden "
        "timeEntries sorgusu ile en son kayit cekilir."
    )
    return Plan(
        "two_step", STRATEGY_EXPLANATIONS["two_step"], [parent_step, fix_step], warnings
    )


# ---------------------------------------------------------------- adim uretici


def _first_allocation_id(ctx: TimeTrackingContext) -> str:
    return ctx.timeAllocations[0].id if ctx.timeAllocations else ""


def _default_effort_class(req: TimeEntryRequest, ctx: TimeTrackingContext) -> str | None:
    if req.effortClassId:
        return req.effortClassId
    d = ctx.defaults
    return {
        "time_allocation": d.timeAllocationEffortClassId,
        "request": d.requestEffortClassId,
        "task": d.taskEffortClassId,
        "project_task": d.projectTaskEffortClassId,
        "problem": d.problemEffortClassId,
    }.get(req.targetType)


def _time_entry_create(
    req: TimeEntryRequest,
    ctx: TimeTrackingContext,
    config: Config,
    source_id: str,
    allocation_id: str,
    entry_date: str,
) -> PlannedMutation:
    """Yol A — TimeEntryCreateInput.

    Sema seviyesinde TEK zorunlu alan timeSpent'tir (Int!, DAKIKA).
    BU ALANLAR YOKTUR: assignmentId, requestId, taskId, projectTaskId,
    problemId, note(string), startTime, serviceInstanceId.
    """
    payload: dict[str, object] = {
        "timeSpent": req.minutes,  # DAKIKA. Saat/saniye ASLA kullanilmaz.
        "date": entry_date,
        "timeAllocationId": allocation_id,
        "source": config.source,
        "sourceID": source_id,
        "clientMutationId": source_id,
    }
    if req.startedAt:
        payload["startedAt"] = req.startedAt
    if req.personId:
        payload["personId"] = req.personId
    if req.description:
        payload["description"] = req.description[:80]
    effort = _default_effort_class(req, ctx)
    if effort:
        payload["effortClassId"] = effort
    if req.correction:
        payload["correction"] = True
    for key, value in (
        ("customerId", req.customerId),
        ("serviceId", req.serviceId),
        ("organizationId", req.organizationId),
        ("teamId", req.teamId),
    ):
        if value:
            payload[key] = value

    return PlannedMutation(
        path="timeEntryCreate",
        mutation=queries.TIME_ENTRY_CREATE_MUTATION,
        input=payload,
        warnings=[
            "Yol A: bu kayit hicbir Request/Task'a BAGLANMAZ (assignment=null). "
            "Karsiliginda date, startedAt ve personId tam kontrol edilebilir."
        ],
    )


def _parent_update(
    req: TimeEntryRequest, ctx: TimeTrackingContext, config: Config, source_id: str
) -> PlannedMutation:
    """Yol B — requestUpdate / taskUpdate / projectTaskUpdate / problemUpdate."""
    path = queries.PARENT_UPDATE_BY_TARGET.get(req.targetType, "requestUpdate")
    payload: dict[str, object] = {
        "id": req.targetId,
        # ARTIMLI: "en son giristen bu yana EKLENEN sure", toplam DEGIL.
        # Entegrasyonlarda cift sayma hatalarinin bir numarali kaynagi budur.
        "timeSpent": req.minutes,
        "clientMutationId": source_id,
    }
    if req.description:
        payload["timeEntryDescription"] = req.description[:80]
    if req.note:
        payload["note"] = req.note
    effort = _default_effort_class(req, ctx)
    if effort:
        payload["timeSpentEffortClassId"] = effort

    return PlannedMutation(
        path=path,
        mutation=queries.MUTATION_BY_PATH[path],
        input=payload,
        warnings=[
            "Yol B: timeSpent ARTIMLIDIR — 'uzerine ekle' demektir, 'toplami su yap' degil.",
            "Bu yolda date'i sunucu 'bugun', person'i authenticated user olarak atar.",
        ],
    )


def _time_entry_update(
    req: TimeEntryRequest, config: Config, entry_date: str, authenticated_person_id: str
) -> PlannedMutation:
    """two_step 2. adim — TimeEntryUpdateInput.

    KRITIK: Bu input'ta assignment ALANI YOKTUR. Bir alan sema icinde yoksa o
    alan guncellenemez; dolayisiyla mevcut degeri korunur. Ticket bagi bu
    sayede BOZULMAZ.
    """
    payload: dict[str, object] = {
        "id": STEP1_ENTRY_ID_PLACEHOLDER,
        "date": entry_date,
        "clientMutationId": f"{config.source}:fix",
    }
    if req.startedAt:
        payload["startedAt"] = req.startedAt
    if req.personId and req.personId != "$me":
        payload["personId"] = req.personId
    if req.description:
        # REST Yol B'de time_entry_description parametresi YOKTUR
        # (developer.xurrent.com/v1/requests) — aciklama 1. adimda ancak
        # note'a dusurulur. 2. adim description'i burada DUZELTIR; GraphQL'de
        # ayni deger yeniden yazilir (idempotent, zararsiz).
        payload["description"] = req.description[:80]

    return PlannedMutation(
        path="timeEntryUpdate",
        mutation=queries.TIME_ENTRY_UPDATE_MUTATION,
        input=payload,
        warnings=[
            "2/2 — TimeEntryUpdateInput'ta assignment alani YOKTUR; bu adim ticket "
            "bagini BOZMAZ. Kisiti avantaja ceviren nokta tam olarak budur.",
        ],
    )
