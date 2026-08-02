"""Yazmadan ONCE calisan on kontroller.

NEDEN dry-run'dan ayri: bu kontroller sunucuya HIC gitmeden hatayi yakalar.
Xurrent bir system of record'dur; yanlis yazilan bir zaman girisi faturalamaya
kadar gider. Her kontrolun yanindaki yorum, o kuralin NEDEN var oldugunu anlatir.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from ..config import Config
from ..models import TimeTrackingContext, ValidationError
from ..timeutil import iso_date, today_in

# ISO8601 timestamp'te offset ZORUNLU: '+03:00' / '-05:00' / 'Z'
_OFFSET_RE = re.compile(r"(Z|[+-]\d{2}:\d{2})$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

DESCRIPTION_MAX_LENGTH = 80  # REST'te max 80 karakter
ALLOWED_INCREMENTS = (5, 10, 15, 30, 60, 120, 240)


@dataclass
class TimeEntryRequest:
    """xurrent_create_time_entry girdisinin ic temsili."""

    targetType: str
    targetId: str
    minutes: int
    date: str | None = None
    startedAt: str | None = None
    personId: str | None = None
    effortClassId: str | None = None
    description: str | None = None
    note: str | None = None
    customerId: str | None = None
    serviceId: str | None = None
    organizationId: str | None = None
    teamId: str | None = None
    correction: bool = False
    sourceId: str | None = None
    backdateStrategy: str | None = None
    dryRun: bool = False

    @property
    def is_allocation(self) -> bool:
        """time_allocation hedefi -> Yol A (timeEntryCreate) zorunlu."""
        return self.targetType == "time_allocation"

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "TimeEntryRequest":
        return cls(
            targetType=str(raw.get("targetType", "")),
            targetId=str(raw.get("targetId", "")),
            minutes=int(raw.get("minutes", 0)),
            date=raw.get("date"),
            startedAt=raw.get("startedAt"),
            personId=raw.get("personId"),
            effortClassId=raw.get("effortClassId"),
            description=raw.get("description"),
            note=raw.get("note"),
            customerId=raw.get("customerId"),
            serviceId=raw.get("serviceId"),
            organizationId=raw.get("organizationId"),
            teamId=raw.get("teamId"),
            correction=bool(raw.get("correction", False)),
            sourceId=raw.get("sourceId"),
            backdateStrategy=raw.get("backdateStrategy"),
            dryRun=bool(raw.get("dryRun", False)),
        )


def deterministic_source_id(req: TimeEntryRequest, config: Config) -> str:
    """Idempotency anahtari. Bos birakilirsa deterministik uretilir.

    NEDEN deterministik: bulk yazma atomik DEGILDIR. Yarim kalan bir bulk
    tekrar calistirildiginda ayni satirlarin ikinci kez yazilmasini onler.
    """
    seed = "|".join(
        [
            config.source,
            req.targetType,
            req.targetId,
            str(req.minutes),
            req.date or "",
            req.startedAt or "",
            req.personId or "",
            req.description or "",
        ]
    )
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
    return f"{config.source}:{digest}"


@dataclass
class PrecheckResult:
    errors: list[ValidationError] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def precheck(
    req: TimeEntryRequest,
    ctx: TimeTrackingContext,
    config: Config,
    *,
    authenticated_person_id: str,
    minutes_already_logged: int = 0,
    allocation_description_required: bool = False,
) -> PrecheckResult:
    """Yazmadan once calisan tum is kurali kontrolleri."""
    result = PrecheckResult()
    add_error = lambda msg, path: result.errors.append(  # noqa: E731
        ValidationError(message=msg, path=path)
    )

    increment = ctx.timeIncrement or 60
    if increment not in ALLOWED_INCREMENTS:
        result.warnings.append(
            f"timeIncrement={increment} izinli degerler arasinda degil "
            f"({', '.join(map(str, ALLOWED_INCREMENTS))}). Sunucu reddedebilir."
        )

    # --- sure ---------------------------------------------------------
    if req.minutes == 0:
        add_error("minutes 0 olamaz.", ["minutes"])
    if req.minutes < 0 and not req.correction:
        # Negatif timeSpent YALNIZCA correction: true ile mumkundur.
        add_error(
            "Negatif sure yalnizca correction=true ile yazilabilir (duzeltme kaydi).",
            ["minutes"],
        )
    if req.minutes != 0 and abs(req.minutes) % increment != 0:
        # timeIncrement hem MINIMUM hem ADIM'dir. Katı olmayan deger REDDEDILIR.
        # Entegrasyonlardaki en yaygin SESSIZ hata budur.
        add_error(
            f"{abs(req.minutes)} dakika, hesabin timeIncrement degerinin "
            f"({increment} dk) kati degil. Izinli en yakin degerler: "
            f"{(abs(req.minutes) // increment) * increment} veya "
            f"{((abs(req.minutes) // increment) + 1) * increment} dakika.",
            ["minutes"],
        )

    # --- tarih --------------------------------------------------------
    today = today_in(config.timezone)
    entry_date = today
    if req.date:
        if not _DATE_RE.match(req.date):
            add_error("date alani YYYY-MM-DD formatinda olmalidir.", ["date"])
        else:
            entry_date = date.fromisoformat(req.date)
            earliest = today - timedelta(days=config.max_backdate_days)
            if entry_date < earliest:
                add_error(
                    f"En eski girilebilir tarih {iso_date(earliest)} "
                    f"(XURRENT_MAX_BACKDATE_DAYS={config.max_backdate_days}). "
                    f"Verilen: {req.date}.",
                    ["date"],
                )
            if entry_date > today:
                add_error("Gelecek tarihe zaman girisi yapilamaz.", ["date"])

    # --- baslangic ani ------------------------------------------------
    if req.startedAt:
        if not _OFFSET_RE.search(req.startedAt):
            # Ciplak timestamp gondermek sessizce yanlis gunu getirir.
            add_error(
                "startedAt ISO8601 olmali ve OFFSET icermelidir "
                "(orn. 2026-08-01T14:00:00+03:00).",
                ["startedAt"],
            )
        else:
            result.warnings.append(
                "startedAt yalnizca metadata'dir; timesheet gununu DEGISTIRMEZ. "
                "Gun her zaman date alanindan gelir."
            )

    # --- aciklama -----------------------------------------------------
    if req.description and len(req.description) > DESCRIPTION_MAX_LENGTH:
        add_error(
            f"description en fazla {DESCRIPTION_MAX_LENGTH} karakter olabilir "
            f"(verilen: {len(req.description)}).",
            ["description"],
        )
    if ctx.requireTimeEntryDescription and not req.description:
        add_error(
            "Bu hesapta zaman girisi aciklamasi ZORUNLUDUR "
            "(requireTimeEntryDescription=true).",
            ["description"],
        )
    if allocation_description_required and not req.description:
        add_error(
            "Secilen TimeAllocation icin aciklama zorunludur (descriptionRequired=true).",
            ["description"],
        )
    if ctx.requireNote and not req.note and not req.is_allocation:
        add_error("Bu hesapta not ZORUNLUDUR (requireNote=true).", ["note"])

    # --- iki yolun acik/kapali olmasi ---------------------------------
    if req.is_allocation and ctx.allocationTimeTracking is False:
        # allocationTimeTracking=false ise Yol A (timeEntryCreate) TAMAMEN kapalidir.
        add_error(
            "Bu hesapta allocation bazli zaman takibi kapali "
            "(allocationTimeTracking=false) — Yol A kullanilamaz.",
            ["targetType"],
        )
    if not req.is_allocation and ctx.assignmentTimeTracking is False:
        # assignmentTimeTracking=false ise Yol B (requestUpdate/taskUpdate) kapalidir.
        add_error(
            "Bu hesapta ticket bazli zaman takibi kapali "
            "(assignmentTimeTracking=false) — Yol B kullanilamaz, dolayisiyla "
            "two_step ve link_first calisamaz.",
            ["targetType"],
        )

    # --- gunluk mesai tavani ------------------------------------------
    workday = ctx.workday or 480
    if (
        ctx.allowWorkdayOvertime is False
        and req.minutes > 0
        and minutes_already_logged + req.minutes > workday
    ):
        add_error(
            f"Gunluk mesai tavani asiliyor: {minutes_already_logged} + {req.minutes} "
            f"= {minutes_already_logged + req.minutes} dk > {workday} dk. "
            "Bu hesapta fazla mesai kapali (allowWorkdayOvertime=false).",
            ["minutes"],
        )

    # --- baskasi adina yazma ------------------------------------------
    if req.personId and req.personId not in ("$me", authenticated_person_id):
        result.warnings.append(
            "Baska bir kisi adina yazma isteniyor. Bunun icin manager, substitute "
            "veya Account Administrator yetkisi gerekir; yetki yoksa sunucu reddeder."
        )

    # --- effort class -------------------------------------------------
    if req.effortClassId:
        known = {ec.id for ec in ctx.effortClasses}
        if known and req.effortClassId not in known:
            add_error(
                "Secilen effort class aktif listede yok (disabled olabilir). "
                "costMultiplier faturalamayi dogrudan etkiler.",
                ["effortClassId"],
            )

    # --- Yol A'ya ozel alanlar ----------------------------------------
    a_only = {
        "customerId": req.customerId,
        "serviceId": req.serviceId,
        "organizationId": req.organizationId,
        "teamId": req.teamId,
    }
    used_a_only = [name for name, value in a_only.items() if value]
    if used_a_only and not req.is_allocation:
        result.warnings.append(
            f"{', '.join(used_a_only)} yalnizca Yol A'da (timeEntryCreate) anlamlidir; "
            "ticket hedefli yazmada YOK SAYILIR."
        )
    if req.note and req.is_allocation:
        result.warnings.append(
            "note yalnizca Yol B'de anlamlidir; TimeAllocation hedefinde YOK SAYILIR."
        )

    return result
