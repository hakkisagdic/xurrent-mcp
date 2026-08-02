#!/usr/bin/env node
/**
 * Sihirbaz — docs/wizard/steps.json'u IN-PROCESS yürüten interaktif ders.
 *
 * NEDEN in-process (MCP client değil): ders akışı ile sunucu implementasyonu
 * arasındaki mesafeyi kısaltmak için. clients/wizard/wizard.mjs GERÇEK bir MCP
 * client'tır ve üç sunucuya da bağlanır — protokol vaadini o kanıtlar.
 * Buradaki sürüm ise "npm run wizard" ile tek komutta çalışan, ağ/transport
 * gerektirmeyen hızlı yoldur. İkisi AYNI steps.json'u yürütür ve AYNI sayıları üretir.
 *
 * ÇIKTILAR ÖNCEDEN YAZILMAMIŞTIR: her sayı canlı tool çağrısından gelir ve
 * steps.json'daki "expect" bloklarına karşı doğrulanır.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "./config.js";
import { createToolContext, type ConfirmFn, type ToolContext } from "./core/context.js";
import { runCalendarListToday } from "./tools/calendar-list-today.js";
import { runBulk } from "./tools/create-time-entries-bulk.js";
import { runCreateTimeEntry } from "./tools/create-time-entry.js";
import { runFindPerson } from "./tools/find-person.js";
import { runListOpenWork } from "./tools/list-open-work.js";
import { runPlanFromCalendar } from "./tools/plan-from-calendar.js";
import { runTimeTrackingContext } from "./tools/time-tracking-context.js";
import { runWhoami } from "./tools/whoami.js";
import { TOOL_NAMES } from "./core/toolimpl.js";
import { addDaysISO, offsetStringForDate, todayISO } from "./util/time.js";
import { createXurrentAdapter } from "./xurrent/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// steps.json tipleri
// ─────────────────────────────────────────────────────────────────────────────

interface ExpectCheck {
  check?: string;
  path?: string;
  equals?: unknown;
  exists?: boolean;
  explain?: string;
}

interface ToolCall {
  label?: string;
  name: string;
  args: Record<string, unknown>;
}

interface Quiz {
  question: string;
  options: string[];
  answer: number;
  explain: string;
}

/**
 * 13-iki-kabuk adımı: AYNI tool'u iki protokol kabuğunun altında çalıştırıp
 * çıktıların birebir aynı olduğunu gösterir. Bu, v1 (2025-11-25) ve v2 (2026-07-28)
 * adaptörlerinin ikisinin de kurulu olmasını gerektirir.
 */
interface CompareProtocols {
  tool: string;
  args: Record<string, unknown>;
  protocols: string[];
}

interface Step {
  id: string;
  chapter: string;
  title: string;
  narrate: string[];
  callTool?: ToolCall | null;
  callToolSequence?: ToolCall[];
  compareProtocols?: CompareProtocols;
  listTools?: boolean;
  table?: { headers: string[]; rows: string[][] };
  expect?: ExpectCheck[];
  reveal?: string[];
  quiz?: Quiz;
  confirmable?: boolean;
  docs?: string;
}

interface StepsFile {
  title: string;
  subtitle: string;
  estimatedMinutes: number;
  chapters: Array<{ id: string; title: string }>;
  steps: Step[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Çıktı yardımcıları — sihirbaz bir CLI'dır, stdout serbesttir (stdio MCP DEĞİL).
// ─────────────────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

const useColor = process.stdout.isTTY === true && !process.env["NO_COLOR"];
function c(code: string, text: string): string {
  return useColor ? `${code}${text}${C.reset}` : text;
}
function out(line = ""): void {
  process.stdout.write(line + "\n");
}
function rule(char = "─", width = 78): void {
  out(c(C.dim, char.repeat(width)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool dispatch — sihirbaz tool'ları DOĞRUDAN (in-process) çağırır.
// ─────────────────────────────────────────────────────────────────────────────

type Dispatcher = (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;

const DISPATCH: Record<string, Dispatcher> = {
  xurrent_whoami: (ctx) => runWhoami(ctx),
  xurrent_find_person: (ctx, a) => runFindPerson(ctx, { email: a["email"], view: a["view"] }),
  xurrent_list_open_work: (ctx, a) => runListOpenWork(ctx, a),
  xurrent_get_time_tracking_context: (ctx, a) => runTimeTrackingContext(ctx, a),
  xurrent_create_time_entry: (ctx, a) => runCreateTimeEntry(ctx, a as any),
  xurrent_create_time_entries_bulk: (ctx, a) => runBulk(ctx, a as any),
  calendar_list_today: (ctx, a) => runCalendarListToday(ctx, a),
  plan_time_entries_from_calendar: (ctx, a) => runPlanFromCalendar(ctx, a),
};

// ─────────────────────────────────────────────────────────────────────────────
// Placeholder çözümü ({{today}}, {{yesterday}}, {{tzOffset}})
// ─────────────────────────────────────────────────────────────────────────────

function resolvePlaceholders(value: unknown, timeZone: string): unknown {
  if (typeof value === "string") {
    const today = todayISO(timeZone);
    const yesterday = addDaysISO(today, -1);
    return value
      .replaceAll("{{today}}", today)
      .replaceAll("{{yesterday}}", yesterday)
      // tzOffset o GÜNÜN offset'idir — DST nedeniyle sabit değildir.
      .replaceAll("{{tzOffset}}", offsetStringForDate(yesterday, timeZone));
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, timeZone));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v, timeZone);
    return out;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// expect değerlendirme
// ─────────────────────────────────────────────────────────────────────────────

function readPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (part === "length" && Array.isArray(cur)) {
      cur = cur.length;
      continue;
    }
    cur = cur[part];
  }
  return cur;
}

interface CheckOutcome {
  ok: boolean;
  /** Değerlendirilemeyen kontrol (ör. henüz kurulmamış bir adaptör) — hata DEĞİL. */
  skipped?: boolean;
  label: string;
  detail: string;
}

function evaluate(
  check: ExpectCheck,
  value: unknown,
  toolCount: number,
  protocolCompare: ProtocolCompareOutcome | null,
): CheckOutcome {
  if (check.check === "toolCount") {
    const ok = toolCount === check.equals;
    return {
      ok,
      label: `toolCount = ${check.equals}`,
      detail: ok ? `${toolCount}` : `BEKLENEN ${check.equals}, GELEN ${toolCount}`,
    };
  }
  if (check.check === "protocolsAgree") {
    if (!protocolCompare || protocolCompare.status === "unavailable") {
      return {
        ok: false,
        skipped: true,
        label: "protocolsAgree",
        detail:
          protocolCompare?.detail ??
          "Karşılaştırma yapılamadı — v1/v2 protokol adaptörleri bu implementasyonda henüz kurulu değil.",
      };
    }
    const ok = protocolCompare.agree === check.equals;
    return { ok, label: "protocolsAgree", detail: protocolCompare.detail };
  }
  const actual = readPath(value, check.path ?? "");
  if (check.exists === true) {
    const ok = actual !== undefined && actual !== null && actual !== "";
    return { ok, label: `${check.path} var`, detail: ok ? String(actual) : "YOK" };
  }
  const ok = JSON.stringify(actual) === JSON.stringify(check.equals);
  return {
    ok,
    label: `${check.path} = ${JSON.stringify(check.equals)}`,
    detail: ok ? String(actual) : `BEKLENEN ${JSON.stringify(check.equals)}, GELEN ${JSON.stringify(actual)}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// İki protokol kabuğu karşılaştırması
// ─────────────────────────────────────────────────────────────────────────────

export interface ProtocolCompareOutcome {
  status: "compared" | "unavailable";
  agree: boolean;
  detail: string;
}

/**
 * Aynı tool'u iki protokol adaptörü altında çalıştırıp sonuçları karşılaştırır.
 *
 * Adaptörler ayrı bir modülde yaşar (src/mcp/protocols.ts) ve BURADA DİNAMİK
 * import edilir. Sebep: bu sihirbaz, v2 adaptörü henüz kurulmamışken de
 * çalışabilmelidir — ders akışının geri kalanı ondan bağımsızdır.
 * Bulunamazsa uydurma bir "geçti" ÜRETMEYİZ; adımı açıkça ATLANDI diye işaretleriz.
 */
async function compareProtocols(
  ctx: ToolContext,
  spec: CompareProtocols,
): Promise<ProtocolCompareOutcome> {
  let mod: {
    runUnderProtocol?: (
      ctx: ToolContext,
      protocol: string,
      tool: string,
      args: Record<string, unknown>,
    ) => Promise<unknown>;
    AVAILABLE_PROTOCOLS?: string[];
  };
  // Değişken üzerinden import: modül henüz YOKKEN de derlensin diye.
  // Sabit string yazarsak TypeScript derleme anında modülü arar ve TS2307 verir.
  const specifier = "./mcp/protocols.js";
  try {
    mod = (await import(specifier)) as typeof mod;
  } catch {
    return {
      status: "unavailable",
      agree: false,
      detail:
        "src/mcp/protocols.ts bulunamadı — v1 (2025-11-25) / v2 (2026-07-28) adaptörleri henüz kurulmadı. " +
        "Bu adım, çift protokol katmanı eklendiğinde otomatik olarak çalışacaktır.",
    };
  }
  const run = mod.runUnderProtocol;
  if (!run) {
    return { status: "unavailable", agree: false, detail: "protocols modülü runUnderProtocol dışa aktarmıyor." };
  }

  const available = mod.AVAILABLE_PROTOCOLS ?? spec.protocols;
  const missing = spec.protocols.filter((p) => !available.includes(p));
  if (missing.length) {
    return {
      status: "unavailable",
      agree: false,
      detail: `Şu protokol adaptörleri kurulu değil: ${missing.join(", ")}`,
    };
  }

  const outputs: string[] = [];
  for (const protocol of spec.protocols) {
    const result = await run(ctx, protocol, spec.tool, spec.args);
    outputs.push(JSON.stringify(result));
  }
  const agree = outputs.every((o) => o === outputs[0]);
  return {
    status: "compared",
    agree,
    detail: agree
      ? `${spec.protocols.join(" ve ")} altında çıktı BİREBİR aynı.`
      : `Çıktılar FARKLI — protokol kabuğu iş mantığına sızmış demektir.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ana akış
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const autoYes = argv.includes("--yes") || argv.includes("-y");
  const interactive = process.stdin.isTTY === true && !autoYes;

  const cfg = loadConfig();
  const stepsFile = JSON.parse(
    readFileSync(join(cfg.repoRoot, "docs", "wizard", "steps.json"), "utf8"),
  ) as StepsFile;

  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

  /**
   * Sihirbazın onay fonksiyonu.
   * TTY varsa gerçekten sorar. TTY yoksa yalnızca MOCK modda otomatik onay verir —
   * canlı modda otomatik onay vermek, dersin kendi kuralını çiğnemek olurdu.
   */
  const confirm: ConfirmFn = async (req) => {
    const detail = Object.entries(req.fields)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join("\n");
    out();
    out(c(C.yellow, "  ONAY GEREKLİ"));
    out(`    ${req.summary}`);
    out(detail);
    if (!rl) {
      if (cfg.mode === "mock") {
        out(c(C.dim, "    (TTY yok → mock modda otomatik onaylandı)"));
        return { action: "accept" };
      }
      out(c(C.red, "    (TTY yok ve mod=live → REDDEDİLDİ)"));
      return { action: "decline", reason: "etkileşimsiz oturum" };
    }
    const answer = (await rl.question(c(C.yellow, "    Yazılsın mı? [e/H] "))).trim().toLowerCase();
    return answer === "e" || answer === "evet" ? { action: "accept" } : { action: "decline" };
  };

  const ctx = createToolContext(cfg, createXurrentAdapter(cfg), confirm);

  out();
  rule("═");
  out(c(C.bold, `  ${stepsFile.title}`));
  out(c(C.dim, `  ${stepsFile.subtitle}  •  ~${stepsFile.estimatedMinutes} dk  •  ${stepsFile.steps.length} adım`));
  out(c(C.dim, `  Sunucu: TypeScript  •  Mod: ${cfg.mode}  •  Strateji: ${cfg.backdateStrategy}  •  ${cfg.timeZone}`));
  rule("═");

  const chapterTitles = new Map(stepsFile.chapters.map((ch) => [ch.id, ch.title]));
  let currentChapter = "";
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: string[] = [];
  const skips: string[] = [];

  for (const [i, step] of stepsFile.steps.entries()) {
    if (step.chapter !== currentChapter) {
      currentChapter = step.chapter;
      out();
      out(c(C.blue + C.bold, `▌ BÖLÜM: ${chapterTitles.get(step.chapter) ?? step.chapter}`));
    }

    out();
    rule();
    out(c(C.bold, `${String(i + 1).padStart(2, "0")}/${stepsFile.steps.length}  ${step.title}`));
    rule();
    for (const line of step.narrate) out(`  ${line}`);

    // ── tools/list adımı ────────────────────────────────────────────────────
    let lastResult: unknown = null;
    if (step.listTools) {
      out();
      out(c(C.cyan, "  → tools/list"));
      TOOL_NAMES.forEach((n, idx) => out(`     ${idx + 1}. ${n}`));
    }

    // ── tool çağrıları ──────────────────────────────────────────────────────
    const calls: ToolCall[] = step.callToolSequence ?? (step.callTool ? [step.callTool] : []);
    for (const call of calls) {
      const args = resolvePlaceholders(call.args ?? {}, cfg.timeZone) as Record<string, unknown>;
      out();
      out(c(C.cyan, `  → ${call.label ? `[${call.label}] ` : ""}${call.name}(${JSON.stringify(args)})`));
      const fn = DISPATCH[call.name];
      if (!fn) {
        out(c(C.red, `  ✖ Bilinmeyen tool: ${call.name}`));
        failed++;
        failures.push(`${step.id}: bilinmeyen tool ${call.name}`);
        continue;
      }
      lastResult = await fn(ctx, args as Record<string, any>);
      out(c(C.dim, indent(JSON.stringify(lastResult, null, 2), "     ", 40)));
    }

    // ── iki protokol kabuğu karşılaştırması ─────────────────────────────────
    let protocolCompare: ProtocolCompareOutcome | null = null;
    if (step.compareProtocols) {
      out();
      out(
        c(
          C.cyan,
          `  → ${step.compareProtocols.tool} — protokoller: ${step.compareProtocols.protocols.join(", ")}`,
        ),
      );
      protocolCompare = await compareProtocols(ctx, step.compareProtocols);
      out(c(C.dim, `     ${protocolCompare.detail}`));
    }

    // ── tablo ───────────────────────────────────────────────────────────────
    if (step.table) {
      out();
      out(`  ${step.table.headers.map((h) => pad(h, 34)).join("")}`);
      for (const row of step.table.rows) out(`  ${row.map((cell) => pad(cell, 34)).join("")}`);
    }

    // ── beklentiler ─────────────────────────────────────────────────────────
    if (step.expect?.length) {
      out();
      for (const check of step.expect) {
        const outcome = evaluate(check, lastResult, TOOL_NAMES.length, protocolCompare);
        if (outcome.skipped) {
          // ATLANDI ≠ GEÇTİ. Uydurma bir başarı raporlamaktansa eksiği söyleriz.
          skipped++;
          skips.push(`${step.id}: ${outcome.label} — ${outcome.detail}`);
          out(c(C.yellow, `  ○ ${outcome.label}  →  ATLANDI: ${outcome.detail}`));
        } else if (outcome.ok) {
          passed++;
          out(c(C.green, `  ✓ ${outcome.label}  →  ${outcome.detail}`));
        } else {
          failed++;
          failures.push(`${step.id}: ${outcome.label} — ${outcome.detail}`);
          out(c(C.red, `  ✖ ${outcome.label}  →  ${outcome.detail}`));
        }
        if (check.explain) out(c(C.dim, `     ${check.explain}`));
      }
    }

    // ── reveal ──────────────────────────────────────────────────────────────
    if (step.reveal?.length) {
      out();
      for (const line of step.reveal) out(c(C.yellow, `  ▸ ${line}`));
    }

    // ── quiz ────────────────────────────────────────────────────────────────
    if (step.quiz) {
      out();
      out(c(C.bold, `  SORU: ${step.quiz.question}`));
      step.quiz.options.forEach((o, idx) => out(`    ${idx + 1}) ${o}`));
      if (rl) {
        const ans = (await rl.question("    Cevabınız [1-" + step.quiz.options.length + "]: ")).trim();
        const correct = Number(ans) - 1 === step.quiz.answer;
        out(correct ? c(C.green, "    ✓ Doğru.") : c(C.red, `    ✖ Doğru cevap: ${step.quiz.answer + 1}`));
      } else {
        out(c(C.dim, `    (etkileşimsiz mod — doğru cevap: ${step.quiz.answer + 1})`));
      }
      out(c(C.dim, `    ${step.quiz.explain}`));
    }

    if (step.docs) out(c(C.dim, `\n  Ayrıntı: ${step.docs}`));

    if (rl && i < stepsFile.steps.length - 1) {
      await rl.question(c(C.dim, "\n  [Enter] devam "));
    }
  }

  rl?.close();

  out();
  rule("═");
  // K3 — ÜÇ DURUMLU özet, üç dilde birebir aynı biçim:
  // "N geçti, M başarısız, K atlandı". ATLANDI ≠ GEÇTİ ve ATLANDI ≠ BAŞARISIZ:
  // bir kontrol ön koşulu sağlanmadığı için ÇALIŞTIRILAMADIYSA atlanmıştır.
  const summary = `${passed} geçti, ${failed} başarısız, ${skipped} atlandı`;
  out(
    failed === 0
      ? c(C.green + C.bold, `  TÜM BEKLENTİLER TUTTU — ${summary}.`)
      : c(C.red + C.bold, `  ${summary}.`),
  );
  for (const f of failures) out(c(C.red, `    ✖ ${f}`));
  for (const s of skips) out(c(C.yellow, `    ○ ${s}`));
  rule("═");
  out();

  if (failed > 0) process.exitCode = 1;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w - 1) + " " : s + " ".repeat(w - s.length);
}

function indent(text: string, prefix: string, maxLines: number): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines).map((l) => prefix + l);
  if (lines.length > maxLines) shown.push(`${prefix}... (${lines.length - maxLines} satır daha)`);
  return shown.join("\n");
}

main().catch((err) => {
  process.stderr.write(`Sihirbaz hatası: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
