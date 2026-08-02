"""8 tool'un PROTOKOLDEN BAGIMSIZ calistirma yuzeyi.

Bu modulun tek isi: `args in -> result out`. Icinde tek bir MCP tipi gecmez;
`import mcp_types` yoktur ve olmamalidir. Test edilirken sunucu ayaga
kaldirmak gerekmez, sihirbaz da bunu dogrudan cagirir.

ONAY KURALI (contract/protocol.md'nin kalbi):
Bir yazma tool'u gercekten yazacaksa (dryRun=false) ve client'a soru
SORULABILIYORSA, bu modul `ConfirmationRequired` doner ve DURUR. Sorunun
v1'de `elicitation/create` istegi mi yoksa v2'de `InputRequiredResult` sonucu
mu oldugunu BILMEZ — o karar mcp/v1.py ve mcp/v2.py'ye aittir.

                    +- mcp/v1 -> elicitation/create  (sunucu istek gonderir)
    run_tool -------+
      ConfirmationRequired
                    +- mcp/v2 -> InputRequiredResult (sunucu sonuc doner)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from ..tools import TOOLS_BY_NAME, ConfirmationState, Runtime
from .confirm import ConfirmationPrompt, build_prompt

# Onay isteyen tool'lar. Okuma ve onizleme tool'lari ASLA onay istemez —
# plan_time_entries_from_calendar yapisal olarak yazamaz, sormasi da anlamsiz olur.
CONFIRMABLE_TOOLS = frozenset({"xurrent_create_time_entry", "xurrent_create_time_entries_bulk"})


@dataclass(frozen=True)
class ToolResult:
    """Tamamlanmis tool cagrisi: yapisal cikti + okunabilir Turkce metin.

    IKISI DE HER ZAMAN uretilir. structuredContent makine icindir (sema ile
    dogrulanir), text blogu insan ve LLM icindir.
    """

    name: str
    payload: dict[str, Any]
    text: str


@dataclass(frozen=True)
class ConfirmationRequired:
    """Tool calistirilmadi: once kullanicidan onay alinmali.

    `arguments` degistirilmeden saklanir; adaptor onu requestState'in parmak
    izine gomer ve tekrar cagrida BIREBIR ayni argumanlari bekler.
    """

    name: str
    arguments: dict[str, Any]
    prompt: ConfirmationPrompt


ToolOutcome = ToolResult | ConfirmationRequired


def needs_confirmation(rt: Runtime, name: str, args: dict[str, Any]) -> bool:
    """Bu cagri icin ONAY SORULACAK MI?

    K5 — XURRENT_CONFIRM_POLICY (uc dilde de ayni; referans C# ToolImpl.cs):

        dryRun=true / XURRENT_DRY_RUN=1 -> asla (hicbir mutation gitmiyor)
        open                            -> asla (YALNIZCA CI/otomasyon)
        closed (VARSAYILAN)             -> onay kanali varsa SORULUR
        strict                          -> onay kanali varsa SORULUR ve onay
                                           ZORUNLUDUR (mock modda da)

    Iki politikanin farki BURADA gorunmez, yazma tool'unun politika kolunda
    gorunur (tools/write_tools.py): onay ALINAMADIGINDA 'closed' mock modda
    uyarip devam eder, 'strict' mock modda BILE reddeder.

    C#'tan BILINCLI TEK SAPMA: C# 'closed' + mock'ta onayi HIC sormaz
    (RequiresConfirmation -> !IsMock). Bu repoda TypeScript ve Python soruyor
    ve sihirbazin 11. adimi ("Gercekten yazalim — onay diyaloguyla") tam olarak
    o diyalogu gostermek uzerine kurulu. Mock'ta sormayi kesmek dersin o adimini
    sessizce bosaltirdi; bu yuzden davranis KORUNDU.
    """
    if name not in CONFIRMABLE_TOOLS:
        return False
    if rt.config.dry_run or bool(args.get("dryRun", False)):
        return False
    # "open": onay hic sorulmaz. Bu ayar bir kolaylik degil, bilincli bir
    # gudumlu-yazma modudur ve YALNIZCA CI/otomasyon icindir.
    return rt.config.confirm_policy != "open"


def run_tool(
    rt: Runtime,
    name: str,
    args: dict[str, Any] | None,
    *,
    can_confirm: bool = False,
    confirmed: bool = False,
) -> ToolOutcome:
    """Tool'u calistirir; gerekiyorsa once onay ister.

    can_confirm: client kullaniciya soru sorabiliyor mu (v1'de elicitation
                 capability, v2'de _meta.clientCapabilities.elicitation).
    confirmed:   kullanici ONAYLADI — dogrudan calistir.

    can_confirm=False ise onay adimi ATLANIR ve karar yazma tool'unun kendi
    politika koluna kalir (closed -> mock: uyari + devam, live: reddet;
    strict -> her iki modda da reddet). Bu, ders icin bilincli bir karardir:
    mock modda kimseye zarar vermeyen bir yazma ders akisini kirmamalidir —
    ta ki XURRENT_CONFIRM_POLICY=strict ile ACIKCA tersi istenene kadar.
    """
    spec = TOOLS_BY_NAME.get(name)
    if spec is None:
        raise ValueError(f"Bilinmeyen tool: {name}")

    arguments = dict(args or {})

    if can_confirm and not confirmed and needs_confirmation(rt, name, arguments):
        return ConfirmationRequired(
            name=name,
            arguments=arguments,
            prompt=_confirmation_prompt(rt, name, arguments),
        )

    # Onayin durumu tool'a ARGUMAN OLARAK gecmez: argumanlar requestState
    # parmak izine girer ve orada uydurulmus bir alan dogrulamayi kirardi.
    # Bu yuzden calisma zamani durumu olarak tasinir.
    rt.confirmation = ConfirmationState(can_ask=can_confirm, granted=confirmed)
    payload = spec.handler(rt, arguments)
    return ToolResult(name=name, payload=payload, text=render_text(name, payload))


# ------------------------------------------------------------------ onay metni


def _confirmation_prompt(rt: Runtime, name: str, args: dict[str, Any]) -> ConfirmationPrompt:
    """Onay metnini uretir. Sayilar ARGUMANLARDAN gelir, tahmin edilmez."""
    mode = rt.adapter.mode
    if name == "xurrent_create_time_entry":
        minutes = args.get("minutes")
        target_type = args.get("targetType", "?")
        target_id = args.get("targetId", "?")
        label = rt.adapter.target_label(str(target_type), str(target_id)) or str(target_id)
        when = args.get("date") or "bugün"
        summary = {
            "tool": name,
            "targetType": target_type,
            "targetId": target_id,
            "targetLabel": label,
            "minutes": minutes,
            "date": when,
            "mode": mode,
        }
        message = (
            f"{minutes} dakikalık zaman girişi "
            f"'{label}' kaydına, {when} tarihiyle yazılacak. "
            f"(Mod: {mode}) Onaylıyor musunuz?"
        )
    else:
        entries = list(args.get("entries") or [])
        total = sum(int(e.get("minutes") or 0) for e in entries)
        summary = {
            "tool": name,
            "entryCount": len(entries),
            "totalMinutes": total,
            "mode": mode,
        }
        message = (
            f"{len(entries)} adet zaman girişi (toplam {total} dakika) yazılacak. "
            f"İşlem ATOMİK DEĞİLDİR — kısmi başarı olabilir. "
            f"(Mod: {mode}) Onaylıyor musunuz?"
        )
    # Onay N kez degil, OZET uzerinden BIR kez sorulur (sozlesme notu).
    return build_prompt(name, message, summary)


# ------------------------------------------------------------------ metin blogu


def render_text(name: str, payload: dict[str, Any]) -> str:
    """structuredContent'in YANI SIRA yayinlanan okunabilir Turkce metin.

    NEDEN HER ZAMAN IKISI BIRDEN: outputSchema'yi anlamayan/eski bir client
    yalnizca text blogunu gorur; yapisal veriyi isleyen client structuredContent'i
    kullanir. Ikisinden birini atlamak, o client sinifini kor birakir.
    """
    summary = _summary_line(name, payload)
    body = json.dumps(payload, ensure_ascii=False, indent=2)
    return f"{summary}\n\n```json\n{body}\n```"


def _summary_line(name: str, payload: dict[str, Any]) -> str:
    try:
        if name == "xurrent_whoami":
            person = payload.get("person") or {}
            account = payload.get("account") or {}
            mode = payload.get("mode")
            rate = payload.get("rateLimit")
            # K4: mock modda rateLimit HER ZAMAN null'dur — gercek bir zaman
            # damgasi koymak ciktiyi deterministik olmaktan cikarirdi.
            rate_text = (
                "mock modda rate limit yok"
                if rate is None
                else f"rate limit {rate.get('remaining')}/{rate.get('limit')}"
            )
            return (
                f"Kimlik: {person.get('name')} <{person.get('primaryEmail')}> • "
                f"Hesap: {account.get('name') or account.get('id')} • "
                f"Mod: {mode} • {rate_text}."
            )

        if name == "xurrent_find_person":
            total = payload.get("totalCount", 0)
            if total:
                return f"{total} kişi bulundu (TAM e-posta eşleşmesi)."
            return (
                "Kişi bulunamadı. PersonFilter.primaryEmail TAM eşleşme yapar — "
                "büyük/küçük harf ve format duyarlıdır."
            )

        if name == "xurrent_list_open_work":
            req = (payload.get("requests") or {}).get("totalCount", 0)
            task = (payload.get("tasks") or {}).get("totalCount", 0)
            return (
                f"Açık iş: {req} talep (Request), {task} görev (Task). "
                f"Hesap: {payload.get('accountId')}."
            )

        if name == "xurrent_get_time_tracking_context":
            increment = payload.get("timeIncrement")
            classes = payload.get("effortClasses") or []
            allocations = payload.get("timeAllocations") or []
            return (
                f"timeIncrement = {increment} dakika (timeSpent bunun katı olmak ZORUNDA). "
                f"{len(classes)} effort class, {len(allocations)} time allocation kullanılabilir."
            )

        if name == "xurrent_create_time_entry":
            planned = payload.get("planned") or []
            errors = payload.get("errors") or []
            warnings = payload.get("warnings") or []
            head = "PLAN (hiçbir şey yazılmadı)" if payload.get("dryRun") else "YAZMA"
            state = "HATA" if errors else "başarılı"
            return (
                f"{head} — strateji '{payload.get('strategy')}', {len(planned)} mutation, "
                f"{len(warnings)} uyarı, {len(errors)} hata → {state}."
            )

        if name == "xurrent_create_time_entries_bulk":
            summary = payload.get("summary") or {}
            return (
                f"Toplu yazma ATOMİK DEĞİLDİR. İstenen {summary.get('requested')}, "
                f"oluşan {summary.get('created')}, başarısız {summary.get('failed')}, "
                f"atlanan {summary.get('skipped')} — toplam {summary.get('totalMinutes')} dakika."
            )

        if name == "calendar_list_today":
            totals = payload.get("totals") or {}
            return (
                f"{totals.get('rawCount')} ham etkinlikten {totals.get('count')} gerçek toplantı "
                f"kaldı ({totals.get('filteredOut')} elendi). Meşgul süre "
                f"{totals.get('busyMinutes')} dk; naif toplam {totals.get('naiveSumMinutes')} dk "
                f"(fark çakışmalardan gelir)."
            )

        if name == "plan_time_entries_from_calendar":
            proposals = payload.get("proposals") or []
            undecided = sum(1 for p in proposals if p.get("needsUserDecision"))
            totals = payload.get("totals") or {}
            return (
                f"{len(proposals)} ÖNERİ üretildi (bu tool ASLA yazmaz). "
                f"{undecided} tanesi kullanıcı kararı bekliyor. "
                f"Önerilen toplam {totals.get('proposedMinutes')} dakika."
            )
    except Exception:  # noqa: BLE001
        # Ozet metni bir KOLAYLIKTIR; uretilemezse tool cagrisi yine de basarilidir.
        pass
    return f"'{name}' tool'u çalıştı."


__all__ = [
    "CONFIRMABLE_TOOLS",
    "ConfirmationRequired",
    "ToolOutcome",
    "ToolResult",
    "needs_confirmation",
    "render_text",
    "run_tool",
]
