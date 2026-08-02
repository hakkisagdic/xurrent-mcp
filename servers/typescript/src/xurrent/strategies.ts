/**
 * ★ DERSİN KALBİ — üç backdate stratejisi.
 *
 * Problem: İster #2 + #3 birlikte "ticket'a bağlı + başlangıç saatli + T-1 tarihli"
 * bir zaman girişi istiyor. Xurrent API'sinde bu TEK MUTATION İLE MÜMKÜN DEĞİL:
 *
 *   Yol A  timeEntryCreate          → date/startedAt/personId TAM KONTROL,
 *                                      ama ticket'a BAĞLANAMAZ (assignment=null)
 *   Yol B  requestUpdate/taskUpdate → ticket'a BAĞLAR,
 *                                      ama date="bugün", person=authenticated user
 *
 * Üç strateji bu çatalı üç farklı TAKAS ile çözer. Hiçbiri "doğru cevap" değildir;
 * hangisinin doğru olduğunu raporlama ihtiyacı belirler.
 */

import { createHash } from "node:crypto";
import type {
  BackdateStrategy,
  CreateTimeEntryInput,
  PlannedMutation,
  TargetType,
  TimeTrackingContext,
} from "../types.js";
import {
  PARENT_UPDATE_BY_TARGET,
  TIME_ENTRY_CREATE_MUTATION,
  TIME_ENTRY_UPDATE_MUTATION,
} from "./queries.js";

/**
 * 2. adımın id'si 1. adım çalışmadan BİLİNEMEZ.
 * Dry-run çıktısında bu yer tutucu görünür; gerçek çalıştırmada
 * LATEST_TIME_ENTRY_QUERY ile çözülür (bkz. queries.ts'teki gerekçe).
 */
export const PENDING_TIME_ENTRY_ID = "«1. adımda oluşan TimeEntry id'si — çalışma anında sorgulanır»";

export interface PlanContext {
  strategy: BackdateStrategy;
  timeZone: string;
  today: string;
  meId: string;
  source: string;
  defaultTimeAllocationId: string;
  timesheet: TimeTrackingContext;
  /** İnsan-okunur hedef etiketi (ör. "Request #70248") — uyarı metinlerinde kullanılır. */
  targetLabel?: string | null;
}

export interface PlanOutcome {
  strategy: BackdateStrategy;
  strategyExplanation: string;
  planned: PlannedMutation[];
  warnings: string[];
  effectiveTargetType: TargetType;
  effectiveTargetId: string;
}

/** Hedef tipine göre varsayılan effort class (timesheet ayarlarından). */
function defaultEffortClassId(targetType: TargetType, ts: TimeTrackingContext): string | null {
  switch (targetType) {
    case "request":
      return ts.defaults.requestEffortClassId;
    case "task":
      return ts.defaults.taskEffortClassId;
    case "project_task":
      return ts.defaults.projectTaskEffortClassId;
    case "problem":
      return ts.defaults.problemEffortClassId;
    case "time_allocation":
      return ts.defaults.timeAllocationEffortClassId;
  }
}

/**
 * Idempotency anahtarı. Aynı girdi aynı sourceID'yi üretir; ağ hatası sonrası
 * tekrar denemede çift kayıt oluşmasını Xurrent tarafında tespit edilebilir kılar.
 */
export function deterministicSourceId(input: CreateTimeEntryInput, today: string): string {
  const material = [
    input.targetType,
    input.targetId,
    String(input.minutes),
    input.date ?? today,
    input.startedAt ?? "",
    input.personId ?? "",
    input.description ?? "",
  ].join("|");
  return "xmcp-" + createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** null/undefined alanları temizler — GraphQL input'una boş alan göndermeyiz. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

export function planPlannedMutations(input: CreateTimeEntryInput, ctx: PlanContext): PlanOutcome {
  const requested = input.backdateStrategy ?? ctx.strategy;
  const date = input.date ?? ctx.today;
  const sourceId = input.sourceId ?? deterministicSourceId(input, ctx.today);
  const label = ctx.targetLabel ?? `${input.targetType} ${input.targetId}`;

  // ── Hedef zaten bir TimeAllocation ise tek yol Yol A'dır. ───────────────────
  // Bu durumda "strateji seçimi" diye bir şey yoktur: timeEntryCreate zaten
  // date/startedAt/personId'nin tamamını verir. Stratejiyi date_first olarak
  // raporlamak semantik olarak DOĞRUDUR (aynı mutation, aynı takas).
  if (input.targetType === "time_allocation") {
    const planned = [buildTimeEntryCreate(input, ctx, date, sourceId, input.targetId, null)];
    return {
      strategy: "date_first",
      strategyExplanation:
        "Hedef bir TimeAllocation olduğu için tek yol Yol A'dır (timeEntryCreate). " +
        "date, startedAt ve personId tam kontrol edilebilir; kayıt zaten bir ticket'a bağlanmaz — " +
        "TimeAllocation'ın amacı da budur (toplantı, eğitim, idari iş gibi ticket'sız çalışma).",
      planned,
      warnings: [
        "Bu kayıt bir Request/Task'a BAĞLANMAZ (assignment=null) — TimeAllocation hedefinde bu beklenen davranıştır.",
      ],
      effectiveTargetType: "time_allocation",
      effectiveTargetId: input.targetId,
    };
  }

  switch (requested) {
    case "two_step":
      return planTwoStep(input, ctx, date, sourceId, label);
    case "link_first":
      return planLinkFirst(input, ctx, date, sourceId, label);
    case "date_first":
      return planDateFirst(input, ctx, date, sourceId, label);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// two_step — İKİ ADIMLI TELAFİ
// ─────────────────────────────────────────────────────────────────────────────

function planTwoStep(
  input: CreateTimeEntryInput,
  ctx: PlanContext,
  date: string,
  sourceId: string,
  label: string,
): PlanOutcome {
  const parent = PARENT_UPDATE_BY_TARGET[input.targetType as keyof typeof PARENT_UPDATE_BY_TARGET];
  const effortClassId = input.effortClassId ?? defaultEffortClassId(input.targetType, ctx.timesheet);

  const step1: PlannedMutation = {
    index: 0,
    path: parent.path,
    mutation: parent.mutation,
    input: {
      input: compact({
        id: input.targetId,
        // ARTIMLI: "üzerine ekle", "toplamı bu yap" DEĞİL.
        timeSpent: input.minutes,
        timeSpentEffortClassId: effortClassId,
        timeEntryDescription: input.description,
        note: input.note,
        clientMutationId: sourceId + "-1",
      }),
    },
    warnings: [
      `1/2 — ${label} kaydına ${input.minutes} dakika ARTIMLI olarak eklenir; oluşan TimeEntry ticket'a BAĞLIDIR.`,
      "Bu adımda date SUNUCU tarafından bugüne, person authenticated user'a sabitlenir — kontrol edilemez.",
      `${parent.inputType} içinde date/startedAt/personId alanı YOKTUR; bu yüzden 2. adım gereklidir.`,
    ],
    stepLabel: "1/2",
  };

  const step2: PlannedMutation = {
    index: 1,
    path: "timeEntryUpdate",
    mutation: TIME_ENTRY_UPDATE_MUTATION,
    input: {
      input: compact({
        id: PENDING_TIME_ENTRY_ID,
        date,
        startedAt: input.startedAt,
        personId: input.personId,
        description: input.description,
        source: ctx.source,
        sourceID: sourceId,
        clientMutationId: sourceId + "-2",
      }),
    },
    warnings: [
      `2/2 — date=${date}${input.startedAt ? `, startedAt=${input.startedAt}` : ""} olarak düzeltilir.`,
      "TimeEntryUpdateInput içinde assignment alanı YOKTUR → bu adım ticket bağını BOZAMAZ. Stratejinin dayandığı garanti budur.",
      "id, 1. adımın payload'ından GELMEZ (RequestUpdatePayload TimeEntry döndürmez) → araya bir sorgu girer; ek istek ve teorik yarış koşulu demektir.",
    ],
    stepLabel: "2/2",
  };

  const warnings: string[] = [
    "two_step ATOMİK DEĞİLDİR: 1. adım başarılı olup 2. adım başarısız olabilir. O durumda ticket'a bağlı ama tarihi BUGÜN olan bir kayıt kalır ve elle düzeltilmesi gerekir.",
    "İki adım = iki HTTP isteği. GraphQL istek başına 1 mutation kabul eder; transaction YOKTUR.",
  ];
  if (date !== ctx.today) {
    warnings.push(
      `Kayıt önce ${ctx.today} tarihiyle oluşur, sonra ${date} tarihine çekilir — geçici olarak yanlış günde görünür.`,
    );
  }
  if (input.personId && input.personId !== ctx.meId && input.personId !== "$me") {
    warnings.push(
      "Başkası adına yazma: 2. adımda personId değiştiriliyor. Bu işlem manager / substitute / Account Administrator yetkisi gerektirir.",
    );
  }

  return {
    strategy: "two_step",
    strategyExplanation:
      "two_step: önce Yol B ile ticket'a bağlı entry oluşturulur, hemen ardından timeEntryUpdate ile " +
      "date/startedAt/personId düzeltilir. Ticket bağını, geçmiş tarihi, başlangıç saatini ve başkası adına " +
      "yazmayı KORUR. Bedeli: 2 HTTP isteği + atomik olmaması. Çalışmasının sebebi, " +
      "TimeEntryUpdateInput içinde assignment alanının BULUNMAMASIDIR.",
    planned: [step1, step2],
    warnings,
    effectiveTargetType: input.targetType,
    effectiveTargetId: input.targetId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// link_first — TICKET BAĞI ÖNCELİKLİ
// ─────────────────────────────────────────────────────────────────────────────

function planLinkFirst(
  input: CreateTimeEntryInput,
  ctx: PlanContext,
  date: string,
  sourceId: string,
  label: string,
): PlanOutcome {
  const parent = PARENT_UPDATE_BY_TARGET[input.targetType as keyof typeof PARENT_UPDATE_BY_TARGET];
  const effortClassId = input.effortClassId ?? defaultEffortClassId(input.targetType, ctx.timesheet);

  const step: PlannedMutation = {
    index: 0,
    path: parent.path,
    mutation: parent.mutation,
    input: {
      input: compact({
        id: input.targetId,
        timeSpent: input.minutes,
        timeSpentEffortClassId: effortClassId,
        timeEntryDescription: input.description,
        note: input.note,
        clientMutationId: sourceId,
      }),
    },
    warnings: [
      `${label} kaydına ${input.minutes} dakika ARTIMLI olarak eklenir.`,
      "Tek istek, atomik. Ticket bağı garanti.",
    ],
    stepLabel: null,
  };

  const warnings: string[] = [
    `Tarih SUNUCU tarafından ${ctx.today} (bugün) olarak atanacak — link_first'te date kontrol edilemez.`,
  ];
  if (date !== ctx.today) {
    warnings.push(
      `İSTENEN TARİH KARŞILANAMADI: ${date} istendi, kayıt ${ctx.today} tarihiyle oluşacak. ` +
        "T-1 gerekiyorsa two_step veya date_first kullanılmalıdır — bot bunu kullanıcıya SÖYLEMEK zorundadır.",
    );
  }
  if (input.startedAt) {
    warnings.push(
      `Başlangıç saati KAYDEDİLEMEDİ: ${input.startedAt}. RequestUpdateInput/TaskUpdateInput içinde startedAt alanı YOKTUR.`,
    );
  }
  if (input.personId && input.personId !== ctx.meId && input.personId !== "$me") {
    warnings.push(
      `Başkası adına yazma KARŞILANAMADI: kayıt her zaman authenticated user adına oluşur (istenen: ${input.personId}).`,
    );
  }

  return {
    strategy: "link_first",
    strategyExplanation:
      "link_first: yalnızca Yol B. Tek istek, atomik, en dayanıklı yol. Ticket bağını korur; " +
      "buna karşılık tarih her zaman BUGÜN, kişi her zaman authenticated user olur ve başlangıç saati kaydedilmez. " +
      "İster #2'deki T-1 bu strateji ile KARŞILANAMAZ.",
    planned: [step],
    warnings,
    effectiveTargetType: input.targetType,
    effectiveTargetId: input.targetId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// date_first — TARİH ÖNCELİKLİ
// ─────────────────────────────────────────────────────────────────────────────

function planDateFirst(
  input: CreateTimeEntryInput,
  ctx: PlanContext,
  date: string,
  sourceId: string,
  label: string,
): PlanOutcome {
  // Yol A bir ticket'ı hedefleyemediği için hedef, varsayılan TimeAllocation'a
  // ÇEVRİLİR. Bu sessiz bir dönüşüm değildir — uyarı ZORUNLUDUR.
  const allocationId = ctx.defaultTimeAllocationId;

  const step = buildTimeEntryCreate(input, ctx, date, sourceId, allocationId, label);

  return {
    strategy: "date_first",
    strategyExplanation:
      "date_first: yalnızca Yol A (timeEntryCreate). Tek istek, atomik; date/startedAt/personId tam kontrol. " +
      "Bedeli: kayıt ticket'a BAĞLANMAZ (assignment=null). Ticket bazlı raporlama yapılıyorsa bu strateji UYGUN DEĞİLDİR.",
    planned: [step],
    warnings: [
      `Hedef otomatik olarak varsayılan TimeAllocation'a çevrildi (${allocationId}) — ${label} ile BAĞ KURULMAYACAK.`,
      "Oluşan kaydın assignment değeri null olur: 'her ticket'a ne kadar zaman harcandı' raporunda GÖRÜNMEZ.",
      "TimeEntryCreateInput içinde requestId/taskId/assignmentId alanı YOKTUR — bu bir eksiklik değil, API'nin modeli.",
    ],
    effectiveTargetType: "time_allocation",
    effectiveTargetId: allocationId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function buildTimeEntryCreate(
  input: CreateTimeEntryInput,
  ctx: PlanContext,
  date: string,
  sourceId: string,
  timeAllocationId: string,
  label: string | null,
): PlannedMutation {
  const effortClassId = input.effortClassId ?? ctx.timesheet.defaults.timeAllocationEffortClassId;
  return {
    index: 0,
    path: "timeEntryCreate",
    mutation: TIME_ENTRY_CREATE_MUTATION,
    input: {
      input: compact({
        // timeSpent şema seviyesinde TEK zorunlu alandır ve DAKİKA cinsindendir.
        timeSpent: input.minutes,
        date,
        startedAt: input.startedAt,
        personId: input.personId === "$me" ? undefined : input.personId,
        timeAllocationId,
        effortClassId,
        description: input.description,
        customerId: input.customerId,
        serviceId: input.serviceId,
        organizationId: input.organizationId,
        teamId: input.teamId,
        correction: input.correction === true ? true : undefined,
        source: ctx.source,
        sourceID: sourceId,
        clientMutationId: sourceId,
      }),
    },
    warnings: label
      ? [`Kayıt ${label} yerine TimeAllocation ${timeAllocationId} altına yazılır.`]
      : ["date, startedAt ve personId tam kontrol edilir — Yol A'nın tek avantajı budur."],
    stepLabel: null,
  };
}
