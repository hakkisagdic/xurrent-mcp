"""Takvim tool'lari: calendar_list_today ve plan_time_entries_from_calendar."""

from __future__ import annotations

from datetime import date
from typing import Any

from .. import calendar as calendar_pkg
from ..models import Proposal, to_dict
from ..timeutil import parse_iso, round_to_increment, today_in
from .matching import match_meeting
from .runtime import Runtime


def calendar_list_today(rt: Runtime, args: dict[str, Any]) -> dict[str, Any]:
    """ISTER #4 (1. yari): gunun takvimini okur, normalize eder, filtreler.

    'Her bir toplanti' cumlesi masumca duruyor. Degil: takvimde dogum gunu var,
    ogle arasi var, reddettigin bir retro var, iki toplanti cakisiyor ve biri
    45 dakika olup hesabin 30'un katlarini kabul ediyor.
    """
    day = _parse_day(args.get("date"), rt.config.timezone)
    result = calendar_pkg.read_day(
        rt.config,
        provider=args.get("provider") or "auto",
        day=day,
        time_zone=args.get("timeZone") or rt.config.timezone,
        user_email=args.get("userEmail"),
        include_all_day=bool(args.get("includeAllDay", False)),
        include_declined=bool(args.get("includeDeclined", False)),
        include_free=bool(args.get("includeFree", False)),
    )
    return to_dict(result)


def plan_time_entries_from_calendar(rt: Runtime, args: dict[str, Any]) -> dict[str, Any]:
    """ISTER #4 (2. yari): takvim + acik is listesini birlestirip ONERI uretir.

    KRITIK TASARIM KARARI: bu tool ASLA YAZMAZ. Yapisal olarak yazma yetenegi
    yoktur — dry-run'in ucuncu ve en guclu katmanidir. Neden? Cunku eslesme
    heuristigi ASLA %100 dogru olamaz. 'Standup' hangi ticket'a yazilacak?
    Bilemez. SORMASI gerekir.
    """
    tz = args.get("timeZone") or rt.config.timezone
    day = _parse_day(args.get("date"), tz)
    person_id = rt.adapter.resolve_person_id(args.get("personId"))

    calendar_day = calendar_pkg.read_day(
        rt.config,
        provider=args.get("provider") or "auto",
        day=day,
        time_zone=tz,
    )

    ctx = rt.time_tracking_context(person_id)
    increment = ctx.timeIncrement or 60
    rounding_mode = args.get("roundingMode") or rt.config.rounding_mode

    snapshot = getattr(rt.adapter, "open_work_snapshot", None)
    work_items = snapshot(person_id) if callable(snapshot) else []

    default_target_type = args.get("defaultTargetType")
    # Eslesmeyen toplantilar icin onerilecek yedek hedef. Sirasiyla: arguman ->
    # DEFAULT_TIME_ALLOCATION_ID -> hesaptaki ilk TimeAllocation. Son adim, .env
    # olusturulmamis bir demo ortaminda bile anlamli bir oneri uretilmesini saglar.
    default_target_id = (
        args.get("defaultTargetId")
        or rt.config.default_time_allocation_id
        or (ctx.timeAllocations[0].id if ctx.timeAllocations else "")
    )

    proposals: list[Proposal] = []
    unmatched: list[str] = []

    for meeting in calendar_day.meetings:
        if meeting.skipped:
            continue

        warnings: list[str] = []
        rounded = round_to_increment(meeting.minutes, increment, rounding_mode)
        if rounded != meeting.minutes:
            # Yuvarlama HER ZAMAN warnings'e yazilir, ASLA sessizce yapilmaz.
            warnings.append(
                f"{meeting.minutes} dakika, hesabin timeIncrement degerinin ({increment} dk) "
                f"kati degil -> '{rounding_mode}' moduyla {rounded} dakikaya yuvarlandi."
            )

        match = match_meeting(meeting.title, work_items)

        if match.item is not None and not match.needs_decision:
            target_type = match.item.kind
            target_id = match.item.id
            target_label = f"#{match.item.displayId} {match.item.subject}"
        else:
            target_type = default_target_type or ("time_allocation" if default_target_id else None)
            target_id = default_target_id or None
            target_label = rt.adapter.target_label(target_type or "", target_id or "") if target_id else None
            if match.item is None:
                unmatched.append(meeting.title)
                if default_target_id:
                    warnings.append(
                        "Eslesme bulunamadi; varsayilan TimeAllocation onerildi. "
                        "Bu kayit hicbir ticket'a BAGLANMAZ."
                    )

        if match.needs_decision:
            warnings.append("Bot tahmin etmemeli — hedefi kullanici onaylamali.")

        proposals.append(
            Proposal(
                meetingTitle=meeting.title,
                startedAt=meeting.start,
                rawMinutes=meeting.minutes,
                roundedMinutes=rounded,
                suggestedTargetType=target_type,
                suggestedTargetId=target_id,
                suggestedTargetLabel=target_label,
                matchReason=match.reason,
                matchConfidence=match.confidence,
                needsUserDecision=match.needs_decision,
                warnings=warnings,
            )
        )

    return {
        "date": day.isoformat(),
        "timeIncrement": increment,
        "proposals": [to_dict(p) for p in proposals],
        "unmatchedMeetings": unmatched,
        "totals": {
            "meetingMinutes": sum(p.rawMinutes for p in proposals),
            "proposedMinutes": sum(p.roundedMinutes for p in proposals),
        },
    }


def _parse_day(raw: Any, tz_name: str) -> date:
    if not raw:
        return today_in(tz_name)
    return parse_iso(f"{raw}T00:00:00+00:00").date()
