/**
 * ÇEKİRDEK — 8 tool'un SAF hâli. Protokolden TAMAMEN bağımsızdır.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * KRİTİK TASARIM KURALI (dersin 13. adımının kanıtladığı şey):
 *
 *   Bir tool çalışırken onay gerekiyorsa bu modül { kind: "confirm" } döner.
 *   NASIL sorulacağını BİLMEZ. Onu protokole çeviren ADAPTÖRDÜR:
 *
 *       core/toolimpl ──┬─ mcp/v1 → elicitation/create  (sunucu İSTEK gönderir)
 *        "confirm"      └─ mcp/v2 → InputRequiredResult (sunucu SONUÇ döner)
 *
 *   28 Temmuz 2026 revizyonu onay akışını tamamen değiştirdi. Bu dosyada
 *   TEK BİR SATIR değişmedi. Ders açısından mesele budur.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Ayrıca burada yaşayan sözleşme parçası: TOOL_SPECS. Sıra contract/tools.json
 * sırasıdır ve DETERMİNİSTİKTİR — 2026-07-28 revizyonu tools/list'in
 * deterministik dönmesini şart koşar (LLM prompt cache isabetini artırır).
 */

import { z } from "zod";
import { listDay, type CalendarQuery } from "../calendar/index.js";
import type {
  CalendarDayResult,
  CreateTimeEntryInput,
  BulkResult,
  BulkResultRow,
  FindPersonResult,
  ListOpenWorkResult,
  Meeting,
  PlanProposal,
  PlanResult,
  PlannedMutation,
  RoundingMode,
  TimeAllocation,
  TimeTrackingContext,
  ViewOption,
  WhoamiResult,
  WorkItem,
  WriteResult,
} from "../types.js";
import { todayISO } from "../util/time.js";
import type { ListOpenWorkArgs } from "../xurrent/index.js";
import { planPlannedMutations } from "../xurrent/strategies.js";
import { preflight, roundToIncrement } from "../xurrent/validate.js";
import {
  getTimesheet,
  requiresConfirmation,
  resolveUnsupportedConfirm,
  type ConfirmOutcome,
  type ConfirmRequest,
  type ToolContext,
} from "./context.js";
import { bullet, humanMinutes } from "./result.js";
import * as S from "./schemas.js";

// ─────────────────────────────────────────────────────────────────────────────
// ToolOutcome — çekirdeğin protokole söylediği TEK şey
// ─────────────────────────────────────────────────────────────────────────────

/** Onay diyaloğunda sorulacak alanların DÜZ JSON Schema'sı (iç içe nesne YASAK). */
export const CONFIRM_SCHEMA = {
  type: "object",
  properties: {
    onay: {
      type: "boolean",
      title: "Onaylıyorum",
      description: "Zaman girişini Xurrent'a yaz.",
    },
    gerekce: {
      type: "string",
      title: "Not (isteğe bağlı)",
      description: "Reddediyorsanız kısa bir gerekçe yazabilirsiniz.",
    },
  },
  required: ["onay"],
} as const;

export type ToolOutcome =
  | {
      kind: "ok";
      structured: Record<string, unknown>;
      text: string;
      /** İş kuralı hatası: sonuç yine döner ama isError=true işaretlenir. */
      isError?: boolean;
    }
  | {
      kind: "confirm";
      /** Kullanıcıya gösterilecek Türkçe özet + alanlar. */
      prompt: ConfirmRequest;
      /** Onay yanıtının şeması — v1'de requestedSchema, v2'de inputRequests şeması. */
      schema: Record<string, unknown>;
      /** Onaydan sonra AYNI çağrının tekrarlanması için gereken her şey. */
      resume: { tool: string; args: Record<string, unknown> };
    };

function okOutcome(text: string, structured: unknown): ToolOutcome {
  return { kind: "ok", text, structured: structured as Record<string, unknown> };
}

function errOutcome(text: string, structured: unknown): ToolOutcome {
  return { kind: "ok", text, structured: structured as Record<string, unknown>, isError: true };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1) xurrent_whoami — "ben kimim ve nereye bağlıyım?"
//
// Her entegrasyonun ilk sorusu budur. Xurrent'ta tek bir GraphQL sorgusuyla
// cevaplanır, maliyeti 1 puandır ve aynı cevap rate limit durumunu da taşır.
// ═════════════════════════════════════════════════════════════════════════════

export async function runWhoami(ctx: ToolContext, signal?: AbortSignal): Promise<WhoamiResult> {
  return ctx.xurrent.whoami(signal);
}

export function renderWhoami(r: WhoamiResult): string {
  const lines = [
    `Kimlik: ${r.person.name ?? "(isimsiz)"}${r.person.jobTitle ? ` — ${r.person.jobTitle}` : ""}`,
    `E-posta: ${r.person.primaryEmail ?? "-"}`,
    `Node ID: ${r.person.id}`,
    `Hesap: ${r.account.name ?? r.account.id} (${r.account.id})${r.account.directory ? " [directory]" : ""}`,
    `Mod: ${r.mode === "mock" ? "mock — fixtures/ klasöründen okunuyor, internete çıkılmıyor" : "live — gerçek Xurrent API"}`,
  ];
  if (r.rateLimit) {
    lines.push(
      `Rate limit: ${r.rateLimit.remaining}/${r.rateLimit.limit} kaldı (bu sorgunun maliyeti ${r.rateLimit.cost}).`,
    );
  } else {
    // K4: mock modda rateLimit HER ZAMAN null'dır ve bu AÇIKÇA söylenir.
    // Uydurma bir sayaç (ya da gerçek epoch taşıyan bir resetAt) çıktıyı
    // deterministik olmaktan çıkarır ve üç dilin sonucu ayrışır.
    lines.push("Rate limit: mock modda rate limit yok — gerçek sayaç yalnızca canlı cevabın header'larından gelir.");
  }
  lines.push(
    "",
    "NOT: person.id opak bir GraphQL global node ID'sidir. Bu id'ler ASLA elle üretilmez veya tahmin edilmez; her id bir tool çıktısından gelmek zorundadır.",
  );
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// 2) xurrent_find_person
//
// TUZAK: PersonFilter.primaryEmail bir TextFilter'dır ve TAM EŞLEŞME yapar.
// "ayse" yazmak "ayse.demir@ornek.com" kaydını GETİRMEZ.
// ═════════════════════════════════════════════════════════════════════════════

export async function runFindPerson(
  ctx: ToolContext,
  args: { email: string; view?: ViewOption },
  signal?: AbortSignal,
): Promise<FindPersonResult> {
  return ctx.xurrent.findPerson(args.email, args.view ?? "all", signal);
}

export function renderFindPerson(r: FindPersonResult, email: string): string {
  if (r.totalCount === 0) {
    return [
      `"${email}" ile TAM eşleşen kişi bulunamadı.`,
      "",
      "Sebep büyük ihtimalle şu: PersonFilter.primaryEmail bir TextFilter'dır ve tam eşleşme arar —",
      "substring, isim veya büyük-küçük harf farkı çalışmaz. Adres birebir doğru mu kontrol edin.",
    ].join("\n");
  }
  const lines = [`${r.totalCount} kişi bulundu:`];
  for (const p of r.people) {
    lines.push(
      `  • ${p.name ?? "(isimsiz)"} — ${p.primaryEmail ?? "-"}${p.jobTitle ? ` (${p.jobTitle})` : ""}`,
      `    id: ${p.id}${p.disabled ? "  [DEVRE DIŞI]" : ""}`,
    );
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// 3) xurrent_list_open_work — İSTER #1
//
// BEŞ TUZAK, hepsi SESSİZ hata üretir (yanlış yaparsan hata almazsın, eksik
// veri alırsın — en kötü hata türü):
//   1) FİLTRE ASİMETRİSİ: RequestFilter'da "member", TaskFilter'da "assignee".
//   2) view varsayılanı "current_account" → "all" geçmezsen diğer hesaplar görünmez.
//   3) "open" diye bir view YOKTUR; ayrım SADECE status ile yapılır.
//   4) Request'te "completedAt", Task'ta "finishedAt".
//   5) personId GraphQL değişkeni String! olmalı (ID! DEĞİL).
// AYRICA: RequestStatus'ta TEK terminal durum var, TaskStatus'ta BEŞ.
// ═════════════════════════════════════════════════════════════════════════════

export async function runListOpenWork(
  ctx: ToolContext,
  args: ListOpenWorkArgs,
  signal?: AbortSignal,
): Promise<ListOpenWorkResult> {
  return ctx.xurrent.listOpenWork(
    {
      personId: args.personId ?? "$me",
      include: args.include ?? ["requests", "tasks"],
      first: args.first ?? 25,
      ...(args.afterRequests ? { afterRequests: args.afterRequests } : {}),
      ...(args.afterTasks ? { afterTasks: args.afterTasks } : {}),
      // view HER ZAMAN açıkça geçilir; varsayılana güvenmek TUZAK 2'dir.
      view: args.view ?? "all",
    },
    signal,
  );
}

function renderWorkItem(w: WorkItem): string {
  const head = `  • #${w.displayId} — ${w.subject ?? "(konusuz)"}`;
  const meta = [
    w.statusLabel ?? w.status ?? "-",
    w.team ? `ekip: ${w.team}` : null,
    w.parentLabel ? `bağlam: ${w.parentLabel}` : null,
    w.targetAt ? `hedef: ${w.targetAt.slice(0, 10)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  return `${head}\n    ${meta}\n    id: ${w.id}`;
}

export function renderListOpenWork(r: ListOpenWorkResult): string {
  const lines: string[] = [];
  lines.push(`Hesap: ${r.accountId}`);
  lines.push("");
  lines.push(`AÇIK REQUEST'LER (${r.requests.totalCount})`);
  lines.push(r.requests.nodes.length ? r.requests.nodes.map(renderWorkItem).join("\n") : "  (yok)");
  lines.push("");
  lines.push(`AÇIK TASK'LAR (${r.tasks.totalCount})`);
  lines.push(r.tasks.nodes.length ? r.tasks.nodes.map(renderWorkItem).join("\n") : "  (yok)");
  lines.push("");
  lines.push(
    "Not: Kapalı kayıtlar listede YOKTUR. Request'te tek terminal durum 'completed'tir;",
    "Task'ta beş tanedir (completed, approved, failed, rejected, canceled) — 'approved' bir task da KAPALIDIR.",
  );
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// 4) xurrent_get_time_tracking_context — YAZMADAN ÖNCE ZORUNLU
//
// timeIncrement zaman girişinin hem MİNİMUMU hem ADIMIDIR; varsayılanı 60'tır.
// Yani varsayılan yapılandırmalı bir hesapta 45 dakikalık giriş REDDEDİLİR.
// TUZAK: EffortClassFilter'da "disabled" filtresi YOKTUR → client tarafında elenir.
// ═════════════════════════════════════════════════════════════════════════════

export async function runTimeTrackingContext(
  ctx: ToolContext,
  args: { personId?: string },
  signal?: AbortSignal,
): Promise<TimeTrackingContext> {
  return getTimesheet(ctx, args.personId ?? "$me", signal);
}

export function renderTimeTrackingContext(r: TimeTrackingContext): string {
  const lines: string[] = [];
  const inc = r.timeIncrement;
  lines.push(
    `timeIncrement: ${inc ?? "bilinmiyor"} dakika` +
      (inc ? ` → yazılabilecek süreler: ${inc}, ${inc * 2}, ${inc * 3}, ... (${inc}'in katları)` : ""),
  );
  if (inc && 45 % inc !== 0) {
    lines.push(`  ⚠ 45 dakikalık bir toplantı OLDUĞU GİBİ yazılamaz — yuvarlanması gerekir.`);
  }
  lines.push(
    `Birim: ${r.unit ?? "-"} | Günlük: ${r.workday ? humanMinutes(r.workday) : "-"} | Haftalık: ${
      r.workweek ? humanMinutes(r.workweek) : "-"
    }`,
    `Fazla mesai: günlük ${r.allowWorkdayOvertime ? "AÇIK" : "KAPALI"}, haftalık ${
      r.allowWorkweekOvertime ? "AÇIK" : "KAPALI"
    }`,
    `Yol A (timeEntryCreate): ${r.allocationTimeTracking === false ? "KAPALI" : "açık"}` +
      ` | Yol B (requestUpdate/taskUpdate): ${r.assignmentTimeTracking === false ? "KAPALI" : "açık"}`,
    `Zorunlu alanlar: note=${r.requireNote ? "evet" : "hayır"}, description=${
      r.requireTimeEntryDescription ? "evet" : "hayır"
    }`,
    "",
    `Effort class'lar (${r.effortClasses.length} — disabled olanlar CLIENT tarafında elendi):`,
  );
  for (const ec of r.effortClasses) {
    lines.push(`  • ${ec.name ?? "(isimsiz)"} — çarpan ${ec.costMultiplier ?? 1} — id: ${ec.id}`);
  }
  lines.push("", `Time allocation'lar (Yol A hedefleri, ${r.timeAllocations.length}):`);
  for (const ta of r.timeAllocations) {
    lines.push(
      `  • ${ta.name ?? "(isimsiz)"}${ta.group ? ` [${ta.group}]` : ""}${
        ta.descriptionRequired ? " — AÇIKLAMA ZORUNLU" : ""
      } — id: ${ta.id}`,
    );
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// 5) xurrent_create_time_entry — İSTER #3
//
// AKIŞ (sırası önemlidir):
//   1. timesheet bağlamını al (timeIncrement bilinmeden hiçbir şey yapılamaz)
//   2. stratejiye göre mutation'ları PLANLA
//   3. ön kontrolleri çalıştır (errors → hiç gönderme)
//   4. dryRun ise dur ve planı döndür
//   5. ONAY — bu adım artık ÇEKİRDEĞİN İŞİ DEĞİL (bkz. ToolOutcome "confirm")
//   6. planı SIRAYLA çalıştır
//
// Dry-run üç katmanlıdır: (a) tool parametresi, (b) XURRENT_DRY_RUN env şalteri,
// (c) plan_time_entries_from_calendar gibi YAPISAL olarak yazamayan tool'lar.
// ═════════════════════════════════════════════════════════════════════════════

export interface PreparedEntry {
  input: CreateTimeEntryInput;
  date: string;
  targetLabel: string | null;
  result: WriteResult;
}

/** Planlama + ön kontrol. ONAY İSTEMEZ, HİÇBİR ŞEY YAZMAZ. */
export async function prepareTimeEntry(
  ctx: ToolContext,
  input: CreateTimeEntryInput,
  signal?: AbortSignal,
): Promise<PreparedEntry> {
  const cfg = ctx.cfg;
  const today = todayISO(cfg.timeZone);
  const date = input.date ?? today;

  // 1) Timesheet bağlamı — session içinde cache'lenir.
  const timesheet = await getTimesheet(ctx, input.personId ?? "$me", signal);
  const me = (await ctx.xurrent.whoami(signal)).person.id;

  // 2) Hedef etiketi + planlama
  const targetLabel = await ctx.xurrent.resolveTargetLabel(input.targetType, input.targetId, signal);
  const plan = planPlannedMutations(input, {
    strategy: input.backdateStrategy ?? cfg.backdateStrategy,
    timeZone: cfg.timeZone,
    today,
    meId: me,
    source: cfg.source,
    defaultTimeAllocationId: resolveDefaultAllocationId(ctx, timesheet),
    timesheet,
    targetLabel,
  });

  // 3) Ön kontroller
  const usage = await ctx.xurrent.usage(input.personId ?? "$me", date, signal);
  const allocation: TimeAllocation | null =
    plan.effectiveTargetType === "time_allocation"
      ? timesheet.timeAllocations.find((a) => a.id === plan.effectiveTargetId) ?? null
      : null;

  const checks = preflight(input, {
    timesheet,
    today,
    maxBackdateDays: cfg.maxBackdateDays,
    meId: me,
    strategy: plan.strategy,
    allocation,
    dayMinutes: usage.dayMinutes,
    weekMinutes: usage.weekMinutes,
  });

  const warnings = [...plan.warnings, ...checks.warnings];

  // 4) Dry-run: iki kaynaktan gelebilir (tool parametresi VEYA env şalteri).
  const dryRun = input.dryRun === true || cfg.forceDryRun;
  if (cfg.forceDryRun && input.dryRun !== true) {
    warnings.unshift("XURRENT_DRY_RUN=1 — env şalteri açık, hiçbir mutation HTTP'ye çıkmayacak.");
  }

  return {
    input,
    date,
    targetLabel,
    result: {
      dryRun,
      strategy: plan.strategy,
      strategyExplanation: plan.strategyExplanation,
      planned: plan.planned,
      warnings,
      timeEntry: null,
      errors: checks.errors,
    },
  };
}

/** Onay diyaloğunun metni — protokolden bağımsızdır, iki adaptör de bunu kullanır. */
export function confirmRequestForEntry(ctx: ToolContext, p: PreparedEntry): ConfirmRequest {
  const { input, date, targetLabel, result } = p;
  return {
    summary:
      `${targetLabel ?? `${input.targetType} ${input.targetId}`} kaydına ` +
      `${humanMinutes(input.minutes)} (${input.minutes} dk) zaman girişi yazılacak.`,
    fields: {
      strateji: result.strategy,
      tarih: date,
      dakika: input.minutes,
      "mutation sayısı": result.planned.length,
      mod: ctx.cfg.mode,
      ...(input.description ? { açıklama: input.description } : {}),
    },
  };
}

/**
 * Onay ALINDIKTAN SONRA çalışan kısım. Kararı kim verdiyse verdi — burada
 * yalnızca sonucuna uyulur. ATOMİK DEĞİLDİR.
 */
export async function finishTimeEntry(
  ctx: ToolContext,
  prepared: PreparedEntry,
  outcome: ConfirmOutcome,
  signal?: AbortSignal,
): Promise<WriteResult> {
  const base = prepared.result;
  const warnings = [...base.warnings];

  if (outcome.action === "decline") {
    return {
      ...base,
      warnings,
      errors: [{ message: `Kullanıcı yazmayı REDDETTİ${outcome.reason ? `: ${outcome.reason}` : "."}` }],
    };
  }
  if (outcome.action === "cancel") {
    return { ...base, warnings, errors: [{ message: "Onay diyaloğu iptal edildi — hiçbir şey yazılmadı." }] };
  }
  if (outcome.action === "unsupported") {
    const policy = resolveUnsupportedConfirm(ctx.cfg);
    if (!policy.allowed) return { ...base, warnings, errors: [{ message: policy.message }] };
    warnings.push(policy.message);
  }

  const exec = await ctx.xurrent.execute(base.planned, signal);
  if (exec.errors.length > 0 && exec.executed > 0) {
    warnings.push(
      `KISMİ BAŞARI: ${exec.executed}/${base.planned.length} adım çalıştı. ` +
        "Kalan adım(lar) başarısız — kayıt yarım kalmış olabilir, elle kontrol edin.",
    );
  }

  return { ...base, warnings, timeEntry: exec.timeEntry, errors: exec.errors };
}

/**
 * Onayı ctx.confirm üzerinden SORAN sürüm.
 * Sihirbaz ve chatbot bunu kullanır (onları taşıyan bir protokol yoktur —
 * terminalde readline sorar). MCP adaptörleri runToolCore'u kullanır.
 */
export async function runCreateTimeEntry(
  ctx: ToolContext,
  input: CreateTimeEntryInput,
  signal?: AbortSignal,
): Promise<WriteResult> {
  const prepared = await prepareTimeEntry(ctx, input, signal);
  if (prepared.result.errors.length > 0 || prepared.result.dryRun) return prepared.result;
  // XURRENT_CONFIRM_POLICY=open → soru HİÇ sorulmaz (CI/otomasyon).
  const outcome: ConfirmOutcome = requiresConfirmation(ctx.cfg, prepared.result.dryRun)
    ? await ctx.confirm(confirmRequestForEntry(ctx, prepared))
    : { action: "accept" };
  return finishTimeEntry(ctx, prepared, outcome, signal);
}

export function renderWriteResult(r: WriteResult): string {
  const lines: string[] = [];
  lines.push(r.dryRun ? "DRY-RUN — hiçbir mutation gönderilmedi." : "GERÇEK YAZMA");
  lines.push(`Strateji: ${r.strategy}`);
  lines.push(r.strategyExplanation);
  lines.push("");
  lines.push(`Planlanan mutation sayısı: ${r.planned.length}`);
  for (const p of r.planned) {
    lines.push("");
    lines.push(`── ${p.stepLabel ? `[${p.stepLabel}] ` : ""}${p.path} ──`);
    lines.push(p.mutation.trim());
    lines.push("Değişkenler:");
    lines.push(JSON.stringify(p.input, null, 2));
    if (p.warnings.length) lines.push(bullet(p.warnings));
  }
  if (r.warnings.length) {
    lines.push("", "UYARILAR:", bullet(r.warnings, "  ⚠ "));
  }
  if (r.errors.length) {
    lines.push("", "HATALAR (işlem BAŞARISIZ):", bullet(r.errors.map((e) => e.message), "  ✖ "));
  } else if (!r.dryRun) {
    const id = (r.timeEntry as { id?: string } | null)?.id;
    lines.push("", `Kayıt oluştu${id ? ` — TimeEntry id: ${id}` : ""}.`);
    lines.push(
      "HATIRLA: Yol B'de timeSpent ARTIMLIDIR — gönderilen değer 'toplamı bu yap' değil 'üzerine ekle' demektir.",
    );
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// 6) xurrent_create_time_entries_bulk
//
// ATOMİK DEĞİLDİR ve bu SAKLANMAZ. GraphQL istek başına 1 mutation kabul eder
// → bulk = N ayrı HTTP isteği. ONAY N kez değil, ÖZET üzerinden BİR KEZ sorulur:
// N kez sormak kullanıcıyı "hepsine evet" refleksine iter ve onayı anlamsızlaştırır.
// ═════════════════════════════════════════════════════════════════════════════

export interface BulkArgs {
  entries: Array<Record<string, unknown>>;
  dryRun?: boolean;
  stopOnError?: boolean;
  backdateStrategy?: "two_step" | "link_first" | "date_first";
}

export interface PreparedBulk {
  prepared: PreparedEntry[];
  planned: PlannedMutation[];
  totalMinutes: number;
  stopOnError: boolean;
  dryRun: boolean;
  /** dryRun ise sonuç burada hazırdır ve çalıştırılacak bir şey yoktur. */
  dryRunResult: BulkResult | null;
}

export async function prepareBulk(ctx: ToolContext, args: BulkArgs, signal?: AbortSignal): Promise<PreparedBulk> {
  const stopOnError = args.stopOnError ?? true;
  const dryRunRequested = args.dryRun === true || ctx.cfg.forceDryRun;

  // 1) Hepsini önce PLANLA (hiçbir şey yazmadan).
  const prepared: PreparedEntry[] = [];
  for (let i = 0; i < args.entries.length; i++) {
    const raw = { ...args.entries[i] } as Record<string, unknown>;
    // Sözleşme gereği satır bazında dryRun/backdateStrategy YOKTUR; üst seviyeden gelir.
    delete raw["dryRun"];
    delete raw["backdateStrategy"];
    const input: CreateTimeEntryInput = {
      ...(raw as unknown as CreateTimeEntryInput),
      ...(args.backdateStrategy ? { backdateStrategy: args.backdateStrategy } : {}),
      dryRun: dryRunRequested,
    };
    prepared.push(await prepareTimeEntry(ctx, input, signal));
  }

  const planned: PlannedMutation[] = [];
  for (let i = 0; i < prepared.length; i++) {
    for (const p of prepared[i]!.result.planned) planned.push({ ...p, index: i });
  }

  const totalMinutes = prepared.reduce((acc, p) => acc + (p.input.minutes ?? 0), 0);

  const dryRunResult: BulkResult | null = dryRunRequested
    ? {
        dryRun: true,
        planned,
        results: prepared.map((p, i) => ({
          index: i,
          status: p.result.errors.length > 0 ? ("failed" as const) : ("skipped" as const),
          timeEntryId: null,
          errors: p.result.errors,
        })),
        summary: {
          requested: prepared.length,
          created: 0,
          failed: prepared.filter((p) => p.result.errors.length > 0).length,
          skipped: prepared.filter((p) => p.result.errors.length === 0).length,
          totalMinutes,
        },
      }
    : null;

  return { prepared, planned, totalMinutes, stopOnError, dryRun: dryRunRequested, dryRunResult };
}

export function confirmRequestForBulk(ctx: ToolContext, b: PreparedBulk): ConfirmRequest {
  return {
    summary:
      `${b.prepared.length} zaman girişi yazılacak, toplam ${humanMinutes(b.totalMinutes)} (${b.totalMinutes} dk). ` +
      "Bu işlem ATOMİK DEĞİLDİR: kısmi başarı mümkündür.",
    fields: {
      "satır sayısı": b.prepared.length,
      "toplam dakika": b.totalMinutes,
      "mutation sayısı": b.planned.length,
      "ilk hatada dur": b.stopOnError,
      mod: ctx.cfg.mode,
    },
  };
}

export async function finishBulk(
  ctx: ToolContext,
  b: PreparedBulk,
  outcome: ConfirmOutcome,
  signal?: AbortSignal,
): Promise<BulkResult> {
  const refuse = (message: string): BulkResult => ({
    dryRun: false,
    planned: b.planned,
    results: b.prepared.map((_, i) => ({
      index: i,
      status: "skipped" as const,
      timeEntryId: null,
      errors: [{ message }],
    })),
    summary: {
      requested: b.prepared.length,
      created: 0,
      failed: 0,
      skipped: b.prepared.length,
      totalMinutes: b.totalMinutes,
    },
  });

  if (outcome.action === "decline") return refuse("Kullanıcı REDDETTİ.");
  if (outcome.action === "cancel") return refuse("Onay iptal edildi.");
  if (outcome.action === "unsupported") {
    const policy = resolveUnsupportedConfirm(ctx.cfg);
    if (!policy.allowed) return refuse(policy.message);
  }

  // SIRAYLA çalıştır. Her satır ayrı raporlanır.
  const results: BulkResultRow[] = [];
  let stopped = false;
  let createdMinutes = 0;

  for (let i = 0; i < b.prepared.length; i++) {
    const p = b.prepared[i]!;
    if (stopped) {
      results.push({
        index: i,
        status: "skipped",
        timeEntryId: null,
        errors: [{ message: "Önceki satırda hata oluştu ve stopOnError=true — bu satır GÖNDERİLMEDİ." }],
      });
      continue;
    }
    if (p.result.errors.length > 0) {
      results.push({ index: i, status: "failed", timeEntryId: null, errors: p.result.errors });
      if (b.stopOnError) stopped = true;
      continue;
    }

    const exec = await ctx.xurrent.execute(p.result.planned, signal);
    if (exec.errors.length > 0) {
      results.push({ index: i, status: "failed", timeEntryId: null, errors: exec.errors });
      if (b.stopOnError) stopped = true;
    } else {
      const id = (exec.timeEntry as { id?: string } | null)?.id ?? null;
      results.push({ index: i, status: "created", timeEntryId: id, errors: [] });
      createdMinutes += p.input.minutes ?? 0;
    }
  }

  return {
    dryRun: false,
    planned: b.planned,
    results,
    summary: {
      requested: b.prepared.length,
      created: results.filter((r) => r.status === "created").length,
      failed: results.filter((r) => r.status === "failed").length,
      skipped: results.filter((r) => r.status === "skipped").length,
      totalMinutes: createdMinutes,
    },
  };
}

/** Onayı ctx.confirm üzerinden SORAN sürüm (sihirbaz/chatbot). */
export async function runBulk(ctx: ToolContext, args: BulkArgs, signal?: AbortSignal): Promise<BulkResult> {
  const b = await prepareBulk(ctx, args, signal);
  if (b.dryRunResult) return b.dryRunResult;
  const outcome: ConfirmOutcome = requiresConfirmation(ctx.cfg, b.dryRun)
    ? await ctx.confirm(confirmRequestForBulk(ctx, b))
    : { action: "accept" };
  return finishBulk(ctx, b, outcome, signal);
}

export function renderBulk(r: BulkResult): string {
  const lines: string[] = [];
  lines.push(r.dryRun ? "DRY-RUN — hiçbir mutation gönderilmedi." : "TOPLU YAZMA — ATOMİK DEĞİL");
  lines.push(
    `İstenen: ${r.summary.requested} | Oluşan: ${r.summary.created} | Başarısız: ${r.summary.failed} | Atlanan: ${r.summary.skipped}`,
  );
  lines.push(`Toplam süre: ${humanMinutes(r.summary.totalMinutes)} (${r.summary.totalMinutes} dk)`);
  lines.push(`Planlanan mutation sayısı: ${r.planned.length}`);
  lines.push("");
  for (const row of r.results) {
    const head = `  [${row.index}] ${row.status}${row.timeEntryId ? ` — ${row.timeEntryId}` : ""}`;
    lines.push(head);
    if (row.errors.length) lines.push(bullet(row.errors.map((e) => e.message), "      ✖ "));
  }
  if (r.summary.failed > 0 && r.summary.created > 0) {
    lines.push(
      "",
      "DİKKAT: Kısmi başarı. Bazı kayıtlar oluştu, bazıları oluşmadı. GraphQL istek başına 1 mutation kabul ettiği için transaction YOKTUR.",
    );
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// 7) calendar_list_today — İSTER #4'ün ilk yarısı
//
// Ham veriyi ANLAMLI veriye çevirir ve nedenini SÖYLER. busyMinutes çakışmaları
// BİR KEZ sayar, naiveSumMinutes saymaz — farkı görmek dersin parçasıdır.
// ═════════════════════════════════════════════════════════════════════════════

export async function runCalendarListToday(
  ctx: ToolContext,
  args: Partial<CalendarQuery>,
  signal?: AbortSignal,
): Promise<CalendarDayResult> {
  return listDay(
    ctx.cfg,
    {
      provider: args.provider ?? ctx.cfg.calendarProvider,
      userEmail: args.userEmail,
      date: args.date,
      // timeZone verilmediyse yapılandırmadaki dilim kullanılır — sunucunun
      // yerel saati ASLA varsayılmaz.
      timeZone: args.timeZone ?? ctx.cfg.timeZone,
      includeAllDay: args.includeAllDay ?? false,
      includeDeclined: args.includeDeclined ?? false,
      includeFree: args.includeFree ?? false,
    },
    signal,
  );
}

export function renderCalendar(r: CalendarDayResult): string {
  const lines: string[] = [];
  lines.push(`Pencere: ${r.windowStart} → ${r.windowEnd}  (${r.timeZone}, sağlayıcı: ${r.provider})`);
  lines.push(
    `Ham etkinlik: ${r.totals.rawCount} | Gerçek toplantı: ${r.totals.count} | Elenen: ${r.totals.filteredOut}`,
  );
  lines.push(
    `Meşgul süre (çakışmalar BİR KEZ): ${humanMinutes(r.totals.busyMinutes)} (${r.totals.busyMinutes} dk)`,
  );
  lines.push(
    `Naif toplam (çakışmaları AYRI sayar): ${humanMinutes(r.totals.naiveSumMinutes)} (${r.totals.naiveSumMinutes} dk)`,
  );
  if (r.totals.naiveSumMinutes !== r.totals.busyMinutes) {
    lines.push(
      `  ⚠ Aradaki ${r.totals.naiveSumMinutes - r.totals.busyMinutes} dakika ÇAKIŞMADAN gelir. ` +
        "Naif toplama güvenirsen o kadar fazla zaman yazarsın.",
    );
  }
  lines.push("");
  lines.push("TOPLANTILAR:");
  for (const m of r.meetings) {
    const time = `${m.start.slice(11, 16)}–${m.end.slice(11, 16)}`;
    if (m.skipped) {
      lines.push(`  ✖ ${time}  ${m.title}  [ELENDİ]`);
      lines.push(`      ${m.skipReason}`);
    } else {
      lines.push(`  • ${time}  ${m.title}  (${m.minutes} dk)`);
      const meta = [
        m.organizer ? `düzenleyen: ${m.organizer}` : null,
        m.attendeeCount ? `${m.attendeeCount} katılımcı` : null,
        m.categories.length ? m.categories.join(", ") : null,
      ]
        .filter(Boolean)
        .join(" | ");
      if (meta) lines.push(`      ${meta}`);
    }
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// 8) plan_time_entries_from_calendar — İSTER #4'ün ikinci yarısı
//
// Bu tool ASLA YAZMAZ. Yapısal olarak yazma yeteneği yoktur — dry-run'ın
// üçüncü ve en güçlü katmanı budur.
// ═════════════════════════════════════════════════════════════════════════════

const FUZZY_THRESHOLD = 0.3; // altındaki benzerlik "eşleşme" sayılmaz
const AMBIGUITY_BAND = 0.15; // en iyi iki aday bu kadar yakınsa KULLANICI karar versin

const STOPWORDS = new Set([
  "ile", "için", "ve", "veya", "bir", "bu", "şu", "çok", "daha", "olan", "olarak",
  "the", "and", "for", "with", "hakkında", "üzerine",
]);

/** Başlığı karşılaştırılabilir token'lara indirger. Türkçe'ye duyarlı küçültme şart. */
export function normalizeTokens(text: string): string[] {
  return text
    .toLocaleLowerCase("tr")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * İki token "aynı kökten" mi?
 * Türkçe eklemeli bir dildir: "analiz"/"analizi" aynı şeydir ama string eşitliği
 * bunu göremez. Tam bir stemmer aşırıdır; ortak ön ek yeterlidir. Kısa kelimelerde
 * kural gevşetilmez — "gün" ile "günlük" eşleşirse her toplantı her ticket'a benzer.
 */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const p = commonPrefixLength(a, b);
  if (p >= 4) return true;
  return p >= 3 && a.length >= 5 && b.length >= 5;
}

/** Dice katsayısı (0..1). Açıklanabilir olması için kasıtlı olarak basit. */
export function similarity(aTokens: string[], bTokens: string[]): number {
  if (aTokens.length === 0 || bTokens.length === 0) return 0;
  let overlap = 0;
  for (const a of aTokens) {
    if (bTokens.some((b) => tokensMatch(a, b))) overlap++;
  }
  return (2 * overlap) / (aTokens.length + bTokens.length);
}

export interface PlanArgs {
  personId?: string;
  date?: string;
  timeZone?: string;
  provider?: "mock" | "ics" | "google" | "graph" | "auto";
  defaultTargetType?: "time_allocation" | "request" | "task";
  defaultTargetId?: string;
  roundingMode?: RoundingMode;
}

/**
 * K6 — YEDEK HEDEF ZİNCİRİ (üç dilde birebir aynı):
 *   1) çağrıdaki defaultTargetId
 *   2) DEFAULT_TIME_ALLOCATION_ID (hesapta GERÇEKTEN varsa)
 *   3) hesaptaki İLK TimeAllocation
 * Zincir olmadan, yapılandırmadaki id başka bir hesaba aitse öneri hiçbir
 * yere bağlanmayan bir id üretir — ve bu sessizce olur.
 */
function resolveDefaultAllocationId(
  ctx: ToolContext,
  timesheet: TimeTrackingContext,
  explicit?: string,
): string {
  if (explicit) return explicit;
  const configured = ctx.cfg.defaultTimeAllocationId;
  if (configured && timesheet.timeAllocations.some((a) => a.id === configured)) return configured;
  const first = timesheet.timeAllocations[0]?.id;
  if (first) return first;
  return configured;
}

export async function runPlanFromCalendar(
  ctx: ToolContext,
  args: PlanArgs,
  signal?: AbortSignal,
): Promise<PlanResult> {
  const timeZone = args.timeZone ?? ctx.cfg.timeZone;
  const date = args.date ?? todayISO(timeZone);
  const roundingMode = args.roundingMode ?? ctx.cfg.roundingMode;

  const [calendar, work, timesheet] = await Promise.all([
    runCalendarListToday(ctx, { provider: args.provider ?? ctx.cfg.calendarProvider, date, timeZone }, signal),
    runListOpenWork(ctx, { personId: args.personId ?? "$me", view: "all", first: 100 }, signal),
    getTimesheet(ctx, args.personId ?? "$me", signal),
  ]);

  const increment = timesheet.timeIncrement ?? 60;
  const items: WorkItem[] = [...work.requests.nodes, ...work.tasks.nodes];

  // Yalnızca GERÇEK toplantılar öneriye dönüşür — elenenler zaten çalışma değildir.
  const real: Meeting[] = calendar.meetings.filter((m) => !m.skipped);

  const fallbackType = args.defaultTargetType ?? "time_allocation";
  const fallbackId = resolveDefaultAllocationId(ctx, timesheet, args.defaultTargetId);
  const fallbackLabel =
    timesheet.timeAllocations.find((a) => a.id === fallbackId)?.name ?? "varsayılan TimeAllocation";

  const proposals: PlanProposal[] = [];
  const unmatched: string[] = [];

  for (const m of real) {
    const warnings: string[] = [];
    const rounded = roundToIncrement(m.minutes, increment, roundingMode);
    if (rounded !== m.minutes) {
      warnings.push(
        `Yuvarlama: ${m.minutes} dk → ${rounded} dk (timeIncrement=${increment}, mod=${roundingMode}). ` +
          "Xurrent bu hesapta ara değerleri KABUL ETMEZ; yuvarlama zorunludur ve sessizce yapılmaz.",
      );
    }

    // ── YOL 1: başlıkta ticket numarası ────────────────────────────────────
    // Not: match(...) null dönebilir; ?? [] ile boş diziye düşerken tipi açıkça
    // string[] yazmazsak TS bunu never[] birleşimi olarak çıkarır ve includes patlar.
    const numbers: string[] = m.title.match(/\b\d{4,6}\b/g) ?? [];
    const exact = items.find((it) => numbers.includes(it.displayId));
    if (exact) {
      proposals.push({
        meetingTitle: m.title,
        startedAt: m.start,
        rawMinutes: m.minutes,
        roundedMinutes: rounded,
        suggestedTargetType: exact.kind,
        suggestedTargetId: exact.id,
        suggestedTargetLabel: `#${exact.displayId} — ${exact.subject ?? ""}`.trim(),
        matchReason: `Toplantı başlığında "${exact.displayId}" numarası geçiyor — kesin eşleşme.`,
        matchConfidence: 1,
        needsUserDecision: false,
        warnings,
      });
      continue;
    }

    // ── YOL 2: metin benzerliği ────────────────────────────────────────────
    const titleTokens = normalizeTokens(m.title);
    const scored = items
      .map((it) => ({ item: it, score: similarity(titleTokens, normalizeTokens(it.subject ?? "")) }))
      .filter((c) => c.score >= FUZZY_THRESHOLD)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) {
      // ── YOL 3: hiçbiri tutmadı → kullanıcı karar versin ──────────────────
      unmatched.push(m.title);
      proposals.push({
        meetingTitle: m.title,
        startedAt: m.start,
        rawMinutes: m.minutes,
        roundedMinutes: rounded,
        suggestedTargetType: fallbackType,
        suggestedTargetId: fallbackId,
        suggestedTargetLabel: fallbackLabel,
        matchReason:
          "Hiçbir açık iş ile eşleşmedi. Varsayılan TimeAllocation önerildi — bu bir TAHMİN değil, güvenli bir varsayılandır.",
        matchConfidence: 0,
        needsUserDecision: true,
        warnings,
      });
      continue;
    }

    const best = scored[0]!;
    const second = scored[1];
    const ambiguous = second !== undefined && best.score - second.score < AMBIGUITY_BAND;

    if (ambiguous) {
      warnings.push(
        `Belirsizlik: "${best.item.subject}" (${best.score.toFixed(2)}) ve "${second!.item.subject}" ` +
          `(${second!.score.toFixed(2)}) birbirine çok yakın. Bot TAHMİN ETMEMELİ, kullanıcıya SORMALI.`,
      );
    }

    proposals.push({
      meetingTitle: m.title,
      startedAt: m.start,
      rawMinutes: m.minutes,
      roundedMinutes: rounded,
      suggestedTargetType: best.item.kind,
      suggestedTargetId: best.item.id,
      suggestedTargetLabel: `#${best.item.displayId} — ${best.item.subject ?? ""}`.trim(),
      matchReason: ambiguous
        ? `Birden fazla aday benzer skorda — en yükseği #${best.item.displayId}, ancak karar kullanıcıya ait.`
        : `Metin benzerliği ile eşleşti (skor ${best.score.toFixed(2)}) — BULANIK eşleşme, doğrulanması önerilir.`,
      matchConfidence: Number(best.score.toFixed(2)),
      needsUserDecision: ambiguous,
      warnings,
    });
  }

  return {
    date,
    timeIncrement: timesheet.timeIncrement,
    proposals,
    unmatchedMeetings: unmatched,
    totals: {
      meetingMinutes: proposals.reduce((a, p) => a + p.rawMinutes, 0),
      proposedMinutes: proposals.reduce((a, p) => a + p.roundedMinutes, 0),
    },
  };
}

export function renderPlan(r: PlanResult): string {
  const lines: string[] = [];
  lines.push(`Tarih: ${r.date} | timeIncrement: ${r.timeIncrement ?? "?"} dk`);
  lines.push(
    `Toplantı süresi: ${humanMinutes(r.totals.meetingMinutes)} → Önerilen: ${humanMinutes(r.totals.proposedMinutes)}`,
  );
  lines.push("");
  lines.push("BU TOOL HİÇBİR ŞEY YAZMAZ — yalnızca öneri üretir.");
  lines.push("");
  r.proposals.forEach((p, i) => {
    lines.push(
      `${i + 1}. ${p.meetingTitle}  (${p.startedAt.slice(11, 16)}, ${p.rawMinutes} dk → ${p.roundedMinutes} dk)`,
    );
    lines.push(
      `   Hedef: ${p.suggestedTargetLabel ?? "-"} [${p.suggestedTargetType ?? "-"}]` +
        (p.matchConfidence !== null ? ` — güven: ${p.matchConfidence}` : ""),
    );
    if (p.matchReason) lines.push(`   Gerekçe: ${p.matchReason}`);
    if (p.needsUserDecision) lines.push("   ⚠ KULLANICI KARARI GEREKLİ — bot kendiliğinden yazmamalı.");
    for (const w of p.warnings) lines.push(`   ⚠ ${w}`);
    lines.push("");
  });
  if (r.unmatchedMeetings.length) {
    lines.push(`Hiçbir açık işle eşleşmeyen toplantılar: ${r.unmatchedMeetings.join(", ")}`);
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// TOOL_SPECS — sözleşmenin kod içindeki karşılığı
//
// SIRA contract/tools.json SIRASIDIR ve deterministiktir. İki adaptör de bu
// diziyi gezerek kayıt yapar; yani "v1 ile v2'de farklı tool listesi" durumu
// YAPISAL OLARAK imkânsızdır.
// ═════════════════════════════════════════════════════════════════════════════

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  /** zod RAW SHAPE — z.object DEĞİL. İki SDK sürümü de bu biçimi kabul ediyor. */
  inputSchema: Record<string, z.ZodTypeAny>;
  outputSchema: Record<string, z.ZodTypeAny>;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Yazma tool'u mu — onay gerektirip gerektirmediğini adaptör buradan bilir. */
  write: boolean;
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: "xurrent_whoami",
    title: "Xurrent: kimlik ve bağlantı testi",
    description:
      "Authenticated kullanıcıyı, hesabı ve rate limit durumunu döner. Aynı zamanda bağlantı smoke test'idir. " +
      "Herhangi bir yazma işleminden önce çalıştırılması önerilir.",
    inputSchema: S.whoamiInput,
    outputSchema: S.whoamiOutput,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    write: false,
  },
  {
    name: "xurrent_find_person",
    title: "Xurrent: kişi bul (e-posta ile)",
    description:
      "Kişiyi birincil e-posta ile bulur. TAM eşleşme yapar (substring değil) — Xurrent PersonFilter.primaryEmail bir TextFilter'dır. " +
      "Sonuç boşsa suggestFuzzy=true döner; o durumda kullanıcıya adresi doğrulatmak gerekir.",
    inputSchema: S.findPersonInput,
    outputSchema: S.findPersonOutput,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    write: false,
  },
  {
    name: "xurrent_list_open_work",
    title: "Xurrent: açık talep ve görevler",
    description:
      "Bir kişinin üzerindeki AÇIK Request ve Task'ları id + açıklama ile listeler. " +
      "Filtre asimetriktir (Request: member, Task: assignee), view her zaman 'all' geçilir ve " +
      "açık/kapalı ayrımı yalnızca status ile yapılır. Zaman yazmadan önce hedef id'leri buradan alınır.",
    inputSchema: S.listOpenWorkInput,
    outputSchema: S.listOpenWorkOutput,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    write: false,
  },
  {
    name: "xurrent_get_time_tracking_context",
    title: "Xurrent: zaman yazma bağlamı (ZORUNLU ÖN ADIM)",
    description:
      "Zaman yazmadan ÖNCE çalıştırılması ZORUNLU olan bağlam sorgusu: timeIncrement, effort class'lar, " +
      "timesheet kısıtları ve Yol A/Yol B şalterleri. timeIncrement bilinmeden timeSpent SEÇİLEMEZ " +
      "(varsayılan 60'tır; yani 45 dakikalık giriş varsayılan yapılandırmada reddedilir). " +
      "Disabled effort class'lar client tarafında elenmiştir.",
    inputSchema: S.timeTrackingContextInput,
    outputSchema: S.timeTrackingContextOutput,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    write: false,
  },
  {
    name: "xurrent_create_time_entry",
    title: "Xurrent: zaman girişi oluştur",
    description:
      "Tek bir zaman girişi oluşturur. targetType='time_allocation' ise Yol A (timeEntryCreate), " +
      "request/task/project_task/problem ise Yol B (parent update) kullanılır. " +
      "Yol A ticket'a BAĞLANAMAZ; Yol B tarih/saat/kişi kontrolü VERMEZ — backdateStrategy bu çatalı çözer. " +
      "minutes DAKİKA cinsindendir ve timeIncrement'in katı olmalıdır. " +
      "dryRun=true ile hiçbir mutation gönderilmez, sadece plan ve uyarılar döner.",
    inputSchema: S.createTimeEntryInput,
    outputSchema: S.writeResultOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    write: true,
  },
  {
    name: "xurrent_create_time_entries_bulk",
    title: "Xurrent: toplu zaman girişi",
    description:
      "Birden çok zaman girişini SIRAYLA oluşturur. ATOMİK DEĞİLDİR — kısmi başarı normaldir ve her satır ayrı raporlanır. " +
      "GraphQL istek başına 1 mutation kabul ettiği için N ayrı HTTP isteği gönderilir; rate limit nedeniyle istekler arasında bekleme uygulanır. " +
      "Onay, satır başına değil ÖZET üzerinden BİR KEZ alınır.",
    inputSchema: S.bulkInput,
    outputSchema: S.bulkOutput,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    write: true,
  },
  {
    name: "calendar_list_today",
    title: "Takvim: günün toplantıları",
    description:
      "Kişinin belirtilen gündeki takvimini okur, normalize eder ve GERÇEK toplantıları filtreler. " +
      "Pencere yerel gece yarısından yerel gece yarısına, offset gömülü kurulur. " +
      "Tüm gün / meşgul-değil / reddedilmiş etkinlikler elenir ve her biri için Türkçe skipReason döner. " +
      "busyMinutes çakışmaları bir kez sayar; naiveSumMinutes düz toplamdır — ikisi de raporlanır.",
    inputSchema: S.calendarInput,
    outputSchema: S.calendarOutput,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    write: false,
  },
  {
    name: "plan_time_entries_from_calendar",
    title: "Takvim → zaman girişi ÖNERİSİ (asla yazmaz)",
    description:
      "Takvimi açık iş listesiyle birleştirip ÖNERİLEN zaman girişi planı üretir. ASLA YAZMAZ — yapısal olarak yazma yeteneği yoktur. " +
      "Eşleşme üç yolla denenir: başlıkta ticket numarası (kesin), metin benzerliği (bulanık), hiçbiri (needsUserDecision=true). " +
      "Süreler timeIncrement katına yuvarlanır ve her yuvarlama warnings'e yazılır.",
    inputSchema: S.planInput,
    outputSchema: S.planOutput,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    write: false,
  },
] as const;

/** Sözleşme testleri, sihirbaz ve web arayüzü için: tool adlarının kanonik listesi. */
export const TOOL_NAMES = TOOL_SPECS.map((t) => t.name);

// ═════════════════════════════════════════════════════════════════════════════
// runToolCore — adaptörlerin TEK giriş noktası
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Bir tool'u çalıştırır ve ToolOutcome döner.
 *
 * `approval` YOKSA ve tool onay gerektiriyorsa { kind: "confirm" } döner —
 * NASIL sorulacağını bilmez. `approval` VARSA onay alınmış kabul edilir ve
 * karara uyulur. Çekirdek hiçbir zaman ctx.confirm çağırmaz: onay kanalı
 * protokole aittir.
 */
export async function runToolCore(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
  approval?: ConfirmOutcome,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  switch (name) {
    case "xurrent_whoami": {
      const r = await runWhoami(ctx, signal);
      return okOutcome(renderWhoami(r), r);
    }

    case "xurrent_find_person": {
      const email = String(args["email"] ?? "");
      const r = await runFindPerson(ctx, { email, view: args["view"] as ViewOption | undefined }, signal);
      return okOutcome(renderFindPerson(r, email), r);
    }

    case "xurrent_list_open_work": {
      const r = await runListOpenWork(ctx, args as ListOpenWorkArgs, signal);
      return okOutcome(renderListOpenWork(r), r);
    }

    case "xurrent_get_time_tracking_context": {
      const r = await runTimeTrackingContext(ctx, { personId: args["personId"] as string | undefined }, signal);
      return okOutcome(renderTimeTrackingContext(r), r);
    }

    case "xurrent_create_time_entry": {
      const input = args as unknown as CreateTimeEntryInput;
      const prepared = await prepareTimeEntry(ctx, input, signal);
      // Hata varsa veya dry-run ise ONAY SORULMAZ — yazılacak bir şey yok.
      if (prepared.result.errors.length > 0) {
        return errOutcome(renderWriteResult(prepared.result), prepared.result);
      }
      if (prepared.result.dryRun) {
        return okOutcome(renderWriteResult(prepared.result), prepared.result);
      }
      // XURRENT_CONFIRM_POLICY=open ise onay HİÇ sorulmaz: adaptöre "confirm"
      // dönmeyiz, doğrudan yazarız. closed/strict'te karar protokole devredilir.
      if (!approval && requiresConfirmation(ctx.cfg, prepared.result.dryRun)) {
        return {
          kind: "confirm",
          prompt: confirmRequestForEntry(ctx, prepared),
          schema: CONFIRM_SCHEMA as unknown as Record<string, unknown>,
          resume: { tool: name, args },
        };
      }
      const r = await finishTimeEntry(ctx, prepared, approval ?? { action: "accept" }, signal);
      const text = renderWriteResult(r);
      return r.errors.length > 0 ? errOutcome(text, r) : okOutcome(text, r);
    }

    case "xurrent_create_time_entries_bulk": {
      const b = await prepareBulk(ctx, args as unknown as BulkArgs, signal);
      if (b.dryRunResult) return okOutcome(renderBulk(b.dryRunResult), b.dryRunResult);
      if (!approval && requiresConfirmation(ctx.cfg, b.dryRun)) {
        return {
          kind: "confirm",
          prompt: confirmRequestForBulk(ctx, b),
          schema: CONFIRM_SCHEMA as unknown as Record<string, unknown>,
          resume: { tool: name, args },
        };
      }
      const r = await finishBulk(ctx, b, approval ?? { action: "accept" }, signal);
      const text = renderBulk(r);
      return r.summary.failed > 0 ? errOutcome(text, r) : okOutcome(text, r);
    }

    case "calendar_list_today": {
      const r = await runCalendarListToday(ctx, args as Partial<CalendarQuery>, signal);
      return okOutcome(renderCalendar(r), r);
    }

    case "plan_time_entries_from_calendar": {
      const r = await runPlanFromCalendar(ctx, args as PlanArgs, signal);
      return okOutcome(renderPlan(r), r);
    }

    default:
      return errOutcome(`Bilinmeyen tool: ${name}`, { errors: [{ message: `Bilinmeyen tool: ${name}` }] });
  }
}
