"""Yazma tool'lari: xurrent_create_time_entry ve ..._bulk.

Xurrent bir system of record'dur. Yanlis yazilan bir zaman girisi faturalamaya
kadar gider. Bu yuzden her yazma tool'unun UC katmanli koruma modeli vardir:
  1. on kontroller (validate.py)   — sunucuya HIC gitmeden yakalar
  2. dryRun                        — hicbir mutation HTTP'ye cikmaz
  3. onay politikasi               — onay ALINAMADIYSA: 'closed' live modda
                                     fail-closed, 'strict' MOCK MODDA DA
                                     fail-closed (XURRENT_CONFIRM_POLICY)
"""

from __future__ import annotations

import logging
from typing import Any

from ..models import ValidationError, to_dict
from ..timeutil import iso_date, today_in
from ..xurrent.retry import log_dedup
from ..xurrent.strategies import STEP1_ENTRY_ID_PLACEHOLDER, build_plan
from ..xurrent.validate import TimeEntryRequest, precheck
from .runtime import Runtime

log = logging.getLogger(__name__)

# GraphQL istek basina 1 mutation kabul eder -> bulk = N ayri HTTP istegi.
# ★ Burada time.sleep YOKTUR — gaz (min istek araligi) ADAPTOR seviyesinde
# yasar (contract/reliability.md §4) ve retry tekrarlari dahil her istegi
# kapsar. Ayni bekleme iki katmanda yasarsa biri kacinilmaz olarak yanlis olur.


def xurrent_create_time_entry(rt: Runtime, args: dict[str, Any]) -> dict[str, Any]:
    """ISTER #3: tek bir zaman girisi olusturur.

    targetType'a gore Yol A veya Yol B'ye yonlendirir; ticket'a bagli + gecmis
    tarihli + baslangic saatli bir kayit TEK BIR MUTATION ILE MUMKUN DEGILDIR.
    """
    result = _plan_and_maybe_write(rt, TimeEntryRequest.from_dict(args))
    return result


def xurrent_create_time_entries_bulk(rt: Runtime, args: dict[str, Any]) -> dict[str, Any]:
    """Birden cok zaman girisini SIRAYLA olusturur. ATOMIK DEGILDIR.

    Kismi basari NORMALDIR ve her satir ayri raporlanir; chatbot bunu
    kullaniciya ACIKCA soylemek zorundadir.
    """
    entries = list(args.get("entries") or [])
    dry_run = bool(args.get("dryRun", False)) or rt.config.dry_run
    stop_on_error = bool(args.get("stopOnError", True))
    strategy_override = args.get("backdateStrategy")

    planned_all: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    created = failed = skipped = deduped = 0
    total_minutes = 0

    for index, raw in enumerate(entries):
        payload = dict(raw)
        payload.pop("dryRun", None)
        if strategy_override:
            payload["backdateStrategy"] = strategy_override
        payload["dryRun"] = dry_run

        req = TimeEntryRequest.from_dict(payload)

        if failed and stop_on_error:
            # stopOnError=true ise ilk hatadan sonrasi ATLANIR — yarim kalan
            # durumu netlestirir, "bazilari yazildi mi?" belirsizligini onler.
            results.append({"index": index, "status": "skipped", "timeEntryId": None, "errors": []})
            skipped += 1
            continue

        single = _plan_and_maybe_write(rt, req)
        for step in single["planned"]:
            step = dict(step)
            step["index"] = index
            planned_all.append(step)

        if single["errors"]:
            results.append(
                {
                    "index": index,
                    "status": "failed",
                    "timeEntryId": None,
                    "errors": single["errors"],
                }
            )
            failed += 1
        elif dry_run:
            results.append({"index": index, "status": "skipped", "timeEntryId": None, "errors": []})
            skipped += 1
            total_minutes += req.minutes
        elif single.get("deduped"):
            # Yazma-oncesi dedup "zaten yazilmis" dedi (reliability.md §5).
            # Bulk'in kurtarma yolu tam olarak budur: kismen basarisiz bir bulk
            # AYNI komutla tekrar calistirilir; yazilmis kalemler deduped,
            # eksikler created olur — cift kayit OLUSMAZ.
            entry = single.get("timeEntry") or {}
            results.append(
                {
                    "index": index,
                    "status": "deduped",
                    "timeEntryId": entry.get("id"),
                    "errors": [],
                }
            )
            deduped += 1
            # totalMinutes'a EKLENMEZ: bu calistirmada yazilan dakika 0'dir;
            # kaydin dakikasi onceki calistirmada sayilmisti.
        else:
            entry = single.get("timeEntry") or {}
            results.append(
                {
                    "index": index,
                    "status": "created",
                    "timeEntryId": entry.get("id"),
                    "errors": [],
                }
            )
            created += 1
            total_minutes += req.minutes

    return {
        "dryRun": dry_run,
        "planned": planned_all,
        "results": results,
        "summary": {
            "requested": len(entries),
            "created": created,
            "failed": failed,
            "skipped": skipped,
            "deduped": deduped,
            "totalMinutes": total_minutes,
        },
    }


# ---------------------------------------------------------------- ic akis


def _plan_and_maybe_write(rt: Runtime, req: TimeEntryRequest) -> dict[str, Any]:
    config = rt.config
    # XURRENT_DRY_RUN=1 iken HICBIR mutation HTTP'ye cikmaz — arguman ne olursa olsun.
    dry_run = req.dryRun or config.dry_run

    me = rt.adapter.resolve_person_id(None)
    person_id = rt.adapter.resolve_person_id(req.personId)
    ctx = rt.time_tracking_context(me)

    allocation_desc_required = False
    if req.is_allocation:
        allocation = next(
            (a for a in ctx.timeAllocations if a.id == req.targetId), None
        )
        allocation_desc_required = bool(allocation and allocation.descriptionRequired)

    entry_date = req.date or iso_date(today_in(config.timezone))
    already = rt.adapter.minutes_logged_on(person_id, entry_date)

    checks = precheck(
        req,
        ctx,
        config,
        authenticated_person_id=me,
        minutes_already_logged=already,
        allocation_description_required=allocation_desc_required,
    )

    label = rt.adapter.target_label(req.targetType, req.targetId)
    plan = build_plan(
        req, ctx, config, authenticated_person_id=me, target_label=label
    )

    warnings = [*plan.warnings, *checks.warnings]
    errors = list(checks.errors)

    # ---- Onay politikasi (K5) -------------------------------------------
    # Onay ALINDI ise politika kolu devreye GIRMEZ: onaylanmis bir yazmayi
    # politikaya takilip reddetmek onayi anlamsiz kilardi.
    #
    #   open   -> onay hic sorulmaz; politika kolu da susar (CI/otomasyon)
    #   closed -> VARSAYILAN. Onay alinamadiysa live'da REDDET, mock'ta uyar+devam
    #   strict -> Onay ZORUNLU. Onay alinamadiysa mock modda BILE REDDET
    approved = rt.confirmation.granted
    if not dry_run and config.confirm_policy == "strict" and not approved:
        errors.append(
            ValidationError(
                message=(
                    "XURRENT_CONFIRM_POLICY=strict: yazma icin onay ZORUNLUDUR ve bu "
                    "cagride onay ALINMADI -> yazma REDDEDILDI (mock modda da). Bu "
                    "politika, MRTR onay akisini mock modda canli gosterebilmek icindir; "
                    "onay sorabilen bir client kullanin (elicitation yetenegini bildiren) "
                    "veya politikayi 'closed' yapin."
                ),
                path=["confirmPolicy"],
            )
        )
    elif not dry_run and config.confirm_policy == "closed":
        # NEDEN yalnizca live modda bloklar: mock modda yazma zararsizdir ve ders
        # akisini kirmamalidir; yine de uyari uretiriz.
        if config.is_live and not approved:
            errors.append(
                ValidationError(
                    message=(
                        "XURRENT_CONFIRM_POLICY=closed ve client onay (elicitation) "
                        "desteklemiyor -> canli yazma REDDEDILDI. Once dryRun ile "
                        "plani inceleyin veya politikayi 'open' yapin."
                    ),
                    path=["confirmPolicy"],
                )
            )
        elif not config.is_live:
            warnings.append(
                "Mock modda calisiyoruz; canli modda bu yazma icin protokol seviyesinde "
                "onay (elicitation) istenirdi. Onay diyalogunu LLM'e birakmiyoruz — "
                "LLM ikna edilebilir, protokol seviyesindeki onay edilemez."
            )

    planned_dicts = [to_dict(step) for step in plan.planned]

    if errors:
        return {
            "dryRun": dry_run,
            "strategy": plan.strategy,
            "strategyExplanation": plan.explanation,
            "planned": planned_dicts,
            "warnings": warnings,
            "timeEntry": None,
            "deduped": False,
            "errors": [to_dict(e) for e in errors],
        }

    if dry_run:
        warnings.insert(0, "dryRun=true — HICBIR mutation gonderilmedi, yalnizca plan uretildi.")
        return {
            "dryRun": True,
            "strategy": plan.strategy,
            "strategyExplanation": plan.explanation,
            "planned": planned_dicts,
            "warnings": warnings,
            "timeEntry": None,
            "deduped": False,
            "errors": [],
        }

    # ---- yazma oncesi dedup (contract/reliability.md §5) ----------------
    # YALNIZCA plan timeEntryCreate ile basliyorsa (Yol A: date_first veya
    # time_allocation hedefi) — sourceID sadece orada yazilabiliyor.
    # ★ two_step/link_first BILEREK dedup ALMAZ: ilk adimlari parent update'tir
    #   ve o input idempotency anahtari tasiyamaz. Yol B'nin korumasi dedup
    #   degil, retry YASAGIDIR. Bu asimetri dersin kendisidir.
    first_step = plan.planned[0]
    if first_step.path == "timeEntryCreate":
        source_id = str(first_step.input.get("sourceID") or "")
        existing = None
        if source_id:
            try:
                existing = rt.adapter.find_time_entry_by_source_id(source_id)
            except Exception as exc:  # noqa: BLE001
                # Geri-okuma dustu -> dedup ATLANIR (fail-open): yazmanin kendi
                # guarded_create korumasi hala devrede. Sessiz gecmiyoruz.
                warnings.append(
                    f"Dedup geri-okumasi basarisiz oldu ({exc.__class__.__name__}); "
                    "yazma dedup KONTROLSUZ devam ediyor."
                )
            else:
                log_dedup(source_id, existing is not None)
        if existing is not None:
            warnings.append(
                "Ayni sourceID'li kayit zaten var — yazma ATLANDI (dedup). "
                "timeEntry alani MEVCUT kaydi gosterir; yeni bir mutation gonderilmedi."
            )
            return {
                "dryRun": False,
                "strategy": plan.strategy,
                "strategyExplanation": plan.explanation,
                "planned": planned_dicts,
                "warnings": warnings,
                "timeEntry": existing,
                "deduped": True,
                "errors": [],
            }

    # ---- gercek calistirma -------------------------------------------
    time_entry: dict[str, Any] | None = None
    exec_errors: list[dict[str, Any]] = []

    for position, step in enumerate(plan.planned):
        payload = dict(step.input)

        # two_step 2. adiminda 1. adimda olusan entry'nin id'si gerekir.
        if payload.get("id") == STEP1_ENTRY_ID_PLACEHOLDER:
            resolved = _resolve_step1_entry_id(rt, time_entry, person_id)
            if not resolved:
                exec_errors.append(
                    {
                        "message": (
                            "2. adim atlandi: 1. adimda olusan TimeEntry id'si bulunamadi. "
                            "Kayit ticket'a bagli kaldi ama tarihi BUGUN. two_step ATOMIK DEGILDIR."
                        ),
                        "path": ["planned", "1"],
                    }
                )
                break
            payload["id"] = resolved

        outcome = rt.adapter.run_mutation({"path": step.path, "input": payload})
        step_errors = outcome.get("errors") or []
        if step_errors:
            exec_errors.extend(step_errors)
            if position == 0:
                break
            # 1. adim gecti, 2. adim patladi -> tam olarak uyardigimiz senaryo.
            warnings.append(
                "1. adim BASARILI, 2. adim BASARISIZ. Ticket'a bagli ama tarihi bugun "
                "olan bir kayit olustu. Manuel duzeltme gerekir."
            )
            break
        if outcome.get("timeEntry"):
            time_entry = outcome["timeEntry"]

    return {
        "dryRun": False,
        "strategy": plan.strategy,
        "strategyExplanation": plan.explanation,
        "planned": planned_dicts,
        "warnings": warnings,
        "timeEntry": time_entry,
        "deduped": False,
        "errors": exec_errors,
    }


def _resolve_step1_entry_id(
    rt: Runtime, step1_entry: dict[str, Any] | None, person_id: str
) -> str | None:
    """1. adimda olusan TimeEntry'nin id'sini bulur.

    Mock adapter parent update'te olusan entry'yi dogrudan doner. Canli modda
    requestUpdate payload'i Request'i doner, TimeEntry'yi DEGIL — bu yuzden
    timeEntries sorgusu ile en son kaydi cekmek gerekir.
    """
    if step1_entry and step1_entry.get("id"):
        return str(step1_entry["id"])
    finder = getattr(rt.adapter, "find_latest_time_entry_id", None)
    if callable(finder):
        try:
            return finder(person_id)
        except Exception as exc:  # noqa: BLE001
            log.warning("En son TimeEntry bulunamadi: %s", exc)
    return None
