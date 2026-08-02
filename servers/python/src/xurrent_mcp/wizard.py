"""docs/wizard/steps.json'u yuruten sihirbaz (ders modu).

Uc dil de AYNI steps.json dosyasini calistirir. Sihirbaz LLM KULLANMAZ —
tool'lari dogrudan cagirir, bu yuzden ANTHROPIC_API_KEY gerekmez.

Bu modul stdio MCP modunda CALISTIRILMAZ; ciktisi insan icindir ve stdout'a yazar.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import timedelta
from pathlib import Path
from typing import Any

from .config import Config, load_config
from .core.toolimpl import ConfirmationRequired, ToolResult, run_tool
from .timeutil import iso_date, today_in, tz_offset_string
from .tools import TOOLS, Runtime

BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
CYAN = "\033[36m"
RESET = "\033[0m"

RULE = "─" * 78


@dataclass
class WizardOutcome:
    """Sihirbaz sonucu — UC DURUMLU.

    PASS / FAIL / SKIP ayrimi kasitlidir: bir kontrol ON KOSULU saglanmadigi
    icin CALISTIRILAMIYORSA bu bir BASARISIZLIK DEGILDIR. Ikisini ayni kefeye
    koymak, gercek bir regresyonu "zaten kirmiziydi" gurultusunun icinde
    kaybeder.
    """

    steps: int
    checks: int
    passed: int
    failed: list[str]
    skipped: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        # SKIP cikis kodunu bozmaz; yalnizca FAIL bozar.
        return not self.failed


def _placeholders(config: Config) -> dict[str, str]:
    today = today_in(config.timezone)
    yesterday = today - timedelta(days=1)
    return {
        "{{today}}": iso_date(today),
        "{{yesterday}}": iso_date(yesterday),
        # Offset GUNE BAGLIDIR — DST nedeniyle yil icinde degisir.
        "{{tzOffset}}": tz_offset_string(yesterday, config.timezone),
    }


def _substitute(value: Any, table: dict[str, str]) -> Any:
    if isinstance(value, str):
        out = value
        for token, replacement in table.items():
            out = out.replace(token, replacement)
        return out
    if isinstance(value, dict):
        return {k: _substitute(v, table) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute(v, table) for v in value]
    return value


def _resolve_path(payload: Any, path: str) -> Any:
    """'requests.totalCount' / 'effortClasses.length' gibi yollari cozer."""
    current = payload
    for part in path.split("."):
        if current is None:
            return None
        if part == "length":
            return len(current) if hasattr(current, "__len__") else None
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and re.fullmatch(r"\d+", part):
            index = int(part)
            current = current[index] if index < len(current) else None
        else:
            current = getattr(current, part, None)
    return current


def _wrap(text: str, width: int = 76, indent: str = "  ") -> str:
    words = text.split()
    lines: list[str] = []
    line = ""
    for word in words:
        if len(line) + len(word) + 1 > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    if line:
        lines.append(line)
    return "\n".join(f"{indent}{ln}" for ln in lines)


def run_wizard(config: Config | None = None, *, steps_path: Path | None = None) -> WizardOutcome:
    cfg = config or load_config()
    path = steps_path or cfg.wizard_steps_path
    with path.open(encoding="utf-8") as handle:
        doc = json.load(handle)

    runtime = Runtime.create(cfg)
    table = _placeholders(cfg)

    chapters = {c["id"]: c["title"] for c in doc.get("chapters", [])}
    steps = doc.get("steps", [])

    print()
    print(f"{BOLD}{doc.get('title', 'Sihirbaz')}{RESET}")
    print(f"{DIM}{doc.get('subtitle', '')}  •  ~{doc.get('estimatedMinutes', '?')} dakika{RESET}")
    print(f"{DIM}Sunucu: Python  •  Mod: {runtime.adapter.mode}  •  "
          f"Saat dilimi: {cfg.timezone}{RESET}")
    print()

    checks = 0
    passed = 0
    failures: list[str] = []
    skips: list[str] = []
    current_chapter = None

    for number, step in enumerate(steps, start=1):
        chapter = step.get("chapter")
        if chapter != current_chapter:
            current_chapter = chapter
            print(f"\n{CYAN}{RULE}{RESET}")
            print(f"{CYAN}{BOLD}BOLUM: {chapters.get(chapter, chapter)}{RESET}")
            print(f"{CYAN}{RULE}{RESET}")

        print(f"\n{BOLD}[{number}/{len(steps)}] {step.get('title', step.get('id'))}{RESET}")
        for line in step.get("narrate", []):
            print(_wrap(line))
            print()

        if step.get("table"):
            _print_table(step["table"])

        payload: Any = None
        # Bu adimdaki kontroller CALISTIRILAMIYORSA sebebi burada tutulur.
        # None ise kontroller normal sekilde kosar.
        skip_reason: str | None = None

        if step.get("listTools"):
            payload = {"tools": [t.name for t in TOOLS], "toolCount": len(TOOLS)}
            print(f"{DIM}  -> tools/list{RESET}")
            for spec in TOOLS:
                hint = "read-only" if spec.annotations.get("readOnlyHint") else "WRITE"
                schema_ok = "outputSchema ✓" if spec.output_schema else "outputSchema YOK"
                print(f"     • {spec.name:<38} {DIM}{spec.kind:<8} {hint:<10} {schema_ok}{RESET}")
            declared = sum(1 for spec in TOOLS if spec.output_schema)
            print(f"{DIM}     {declared}/{len(TOOLS)} tool outputSchema beyan ediyor "
                  f"-> tools/call structuredContent doner.{RESET}")
            print()

        if step.get("compareProtocols"):
            # ON KOSUL SAGLANMIYOR -> SKIP (bkz. asagidaki aciklama).
            skip_reason = _protocol_comparison_skip(step["compareProtocols"])

        call = step.get("callTool")
        if call:
            args = _substitute(call.get("args") or {}, table)
            print(f"{DIM}  -> {call['name']}({json.dumps(args, ensure_ascii=False)}){RESET}")
            if step.get("confirmable"):
                print(f"{YELLOW}  ! Bu adim GERCEKTEN yazar (mock modda guvende).{RESET}")
            payload = _call_with_confirmation(runtime, call["name"], args)
            _print_payload(payload)

        for entry in step.get("callToolSequence", []):
            args = _substitute(entry.get("args") or {}, table)
            print(f"{BOLD}  ── {entry.get('label', entry['name'])} ──{RESET}")
            print(f"{DIM}  -> {entry['name']}({json.dumps(args, ensure_ascii=False)}){RESET}")
            seq_payload = _call_with_confirmation(runtime, entry["name"], args)
            planned = seq_payload.get("planned") or []
            print(f"     planned.length = {len(planned)}  "
                  f"strategy = {seq_payload.get('strategy')}")
            for mutation in planned:
                label = mutation.get("stepLabel") or "-"
                print(f"       [{label}] {mutation.get('path')}")
            for warning in seq_payload.get("warnings", []):
                print(f"     {YELLOW}! {warning}{RESET}")
            print()

        for expectation in step.get("expect", []):
            checks += 1
            if expectation.get("check") == "toolCount":
                actual = len(TOOLS)
                label = "toolCount"
            else:
                label = expectation.get("path") or expectation.get("check") or "?"
                actual = _resolve_path(payload, label)

            # SKIP: on kosul saglanmadi, kontrol CALISTIRILAMADI.
            # Bir de sessiz SKIP kaynagi var: adim hic tool cagirmadiysa
            # (payload None) yol cozumlemesi anlamsizdir.
            if skip_reason is None and payload is None and expectation.get("check") != "toolCount":
                skip_reason = (
                    "Bu adimda tool cagrilmadi; kontrol edilecek bir cikti yok."
                )

            if skip_reason is not None:
                message = f"{step.get('id')}: {label} — {skip_reason}"
                skips.append(message)
                print(f"  {YELLOW}⊘ ATLANDI{RESET} {label}")
                print(f"{DIM}{_wrap(skip_reason, indent='      ')}{RESET}")
                if expectation.get("explain"):
                    print(f"{DIM}{_wrap(expectation['explain'], indent='      ')}{RESET}")
                continue

            if "equals" in expectation:
                ok = actual == expectation["equals"]
                expected_text = repr(expectation["equals"])
            elif expectation.get("exists"):
                ok = actual is not None
                expected_text = "var olmali"
            else:
                ok = True
                expected_text = "-"

            if ok:
                passed += 1
                print(f"  {GREEN}✓{RESET} {label} = {actual!r}")
            else:
                message = f"{step.get('id')}: {label} = {actual!r} (beklenen {expected_text})"
                failures.append(message)
                print(f"  {RED}✗ {message}{RESET}")
            if expectation.get("explain"):
                print(f"{DIM}{_wrap(expectation['explain'], indent='      ')}{RESET}")

        if step.get("reveal"):
            print(f"\n  {BOLD}Perde arkasi:{RESET}")
            for line in step["reveal"]:
                print(_wrap(line, indent="    "))

        quiz = step.get("quiz")
        if quiz:
            print(f"\n  {BOLD}Soru:{RESET} {quiz['question']}")
            for index, option in enumerate(quiz.get("options", [])):
                marker = f"{GREEN}✓{RESET}" if index == quiz.get("answer") else " "
                print(f"    {marker} {index + 1}) {option}")
            print(f"{DIM}{_wrap(quiz.get('explain', ''), indent='    ')}{RESET}")

        if step.get("docs"):
            print(f"{DIM}  Ayrinti: {step['docs']}{RESET}")

    print(f"\n{CYAN}{RULE}{RESET}")
    color = RED if failures else GREEN
    print(f"{color}{BOLD}SONUC: {passed} gecti, {len(failures)} basarisiz, "
          f"{len(skips)} atlandi ({checks} kontrol).{RESET}")
    for failure in failures:
        print(f"  {RED}✗ {failure}{RESET}")
    for skip in skips:
        print(f"  {YELLOW}⊘ {skip}{RESET}")
    if not failures:
        print(f"{GREEN}Beklenen tum sayilar tutturuldu. "
              f"Atlanan kontroller BASARISIZLIK DEGILDIR.{RESET}")
    print(f"{CYAN}{RULE}{RESET}\n")

    return WizardOutcome(
        steps=len(steps),
        checks=checks,
        passed=passed,
        failed=failures,
        skipped=skips,
    )


def _call_with_confirmation(runtime: Runtime, name: str, args: dict[str, Any]) -> Any:
    """Tool'u cagirir; onay gerekirse ONAY DIYALOGUNU EKRANDA GOSTERIR.

    Sihirbaz burada bir MCP CLIENT'i taklit eder: onay isteyen bir sonuc gelirse
    kullaniciya ne sorulacagini basar ve kabul eder. Ders acisindan onemli olan,
    onayin LLM'e degil PROTOKOLE ait bir adim olarak gorunmesidir.

    can_confirm=True veriyoruz cunku bu client onay sorabilir. Onay soramayan bir
    client'ta (can_confirm=False) karar yazma tool'unun politika koluna kalirdi:
    XURRENT_CONFIRM_POLICY=closed'da mock modda uyari + devam / live modda RED,
    'strict'te ise MOCK MODDA DA RED.
    """
    outcome = run_tool(runtime, name, args, can_confirm=True)
    if isinstance(outcome, ConfirmationRequired):
        print(f"{YELLOW}  ⇄ ONAY GEREKIYOR (v1'de elicitation/create ISTEGI, "
              f"v2'de InputRequiredResult SONUCU){RESET}")
        print(f"{YELLOW}    ? {outcome.prompt.message}{RESET}")
        print(f"{DIM}    -> sihirbaz onayliyor (gercek client'ta kullanici tiklardi){RESET}")
        outcome = run_tool(runtime, name, args, can_confirm=True, confirmed=True)
    assert isinstance(outcome, ToolResult)
    return outcome.payload


def _protocol_comparison_skip(spec: dict[str, Any]) -> str:
    """13. adim (compareProtocols) neden ATLANIYOR — ve neden bu bir HATA DEGIL.

    Adim, AYNI tool'u iki protokol kabugu altinda calistirip ciktilarin birebir
    ayni oldugunu gostermek ister. Bunu durust yapmanin tek yolu IKI AYRI MCP
    SUNUCU SURECI ayaga kaldirmaktir; sihirbaz ise tek surecte, tool katmanini
    dogrudan cagirarak calisir.

    Python'da isin ustune bir de bagimlilik izolasyonu binir: v1 paketi de v2
    paketi de 'mcp' adini tasir, dolayisiyla AYNI ORTAMDA YAN YANA DURAMAZLAR
    (TypeScript'te paket adlari farkli oldugu icin durabiliyorlar). Iki kabugu
    gercekten karsilastirmak `uv run --with 'mcp==1.28.1' ...` ile ikinci bir
    ortam gerektirir.

    Sonuc: kontrol CALISTIRILAMADI -> SKIP. FAIL demek, olmayan bir regresyonu
    var gostermek olurdu.
    """
    protocols = ", ".join(spec.get("protocols") or [])
    return (
        f"Iki protokol ({protocols}) karsilastirmasi icin iki ayri sunucu sureci gerekir; "
        "sihirbaz tek surecte calisir. Ayrica Python'da mcp==1.28.1 ile mcp==2.0.0 ayni "
        "ortamda yasayamaz (ayni paket adi). Kontrol CALISTIRILAMADI — basarisiz degil. "
        "Karsilastirmayi calistirmak icin: node scripts/verify-contract.mjs --all"
    )


def _print_payload(payload: Any) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    lines = text.splitlines()
    limit = 24
    for line in lines[:limit]:
        print(f"{DIM}     {line}{RESET}")
    if len(lines) > limit:
        print(f"{DIM}     … ({len(lines) - limit} satir daha){RESET}")
    print()


def _print_table(table: dict[str, Any]) -> None:
    headers = table.get("headers", [])
    rows = table.get("rows", [])
    widths = [
        max(len(str(headers[i])), *(len(str(r[i])) for r in rows)) if rows else len(str(headers[i]))
        for i in range(len(headers))
    ]
    header_line = "  " + " │ ".join(str(h).ljust(widths[i]) for i, h in enumerate(headers))
    print(f"{BOLD}{header_line}{RESET}")
    print("  " + "─┼─".join("─" * w for w in widths))
    for row in rows:
        print("  " + " │ ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)))
    print()
