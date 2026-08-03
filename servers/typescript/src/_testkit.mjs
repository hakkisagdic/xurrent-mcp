/**
 * Birim testlerinin ortak malzemesi. TEST DEĞİLDİR — bu yüzden adı `_` ile başlar
 * ve `node --test` dosya desenlerinin (`*.test.mjs`, `test-*.mjs`, `test/**`)
 * HİÇBİRİNE uymaz; kosucu bunu ayrı bir test dosyası sanmaz.
 *
 * KURALLAR (üç dilde de aynı):
 *   - Ağ YOK. Zaman girişi/mutation YOK. Yalnızca fixtures/ okunur.
 *   - "Şimdi" ASLA new Date() değildir: SABIT_SIMDI enjekte edilir.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..", "..");
export const FIXTURES_DIR = join(REPO_ROOT, "fixtures");

export function fixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), "utf8"));
}

/**
 * ★ SABİT "ŞİMDİ" — testlerin günün saatine bağlı olmamasının tek yolu.
 *
 * 2026-08-03T22:30:00Z, Europe/Istanbul'da (+03:00) 2026-08-04 01:30'dur.
 * Yani YEREL TARİH ile UTC TARİHİ FARKLIDIR. Bu enjekte edilebilir olmasaydı
 * test gündüz geçer, gece 00:00–03:00 arasında kırılırdı — bu repoda tam olarak
 * o yaşandı. Sabit değer seçilmesinin sebebi budur, süs değil.
 */
export const SABIT_SIMDI = new Date("2026-08-03T22:30:00Z");
export const SABIT_YEREL_TARIH = "2026-08-04"; // Europe/Istanbul'daki karşılığı
export const TZ = "Europe/Istanbul";

/** fixtures/timesheet-settings.json → TimeTrackingContext (mock adapter ile aynı şekil). */
export function timesheetFixture(overrides = {}) {
  const ts = fixture("timesheet-settings.json").timesheetSetting;
  const allocations = fixture("time-allocations.json").timeAllocations;
  const effortClasses = fixture("effort-classes.json").effortClasses ?? [];
  return {
    unit: ts.unit,
    timeIncrement: ts.timeIncrement,
    workday: ts.workday,
    workweek: ts.workweek,
    allowWorkdayOvertime: ts.allowWorkdayOvertime,
    allowWorkweekOvertime: ts.allowWorkweekOvertime,
    allocationTimeTracking: ts.allocationTimeTracking,
    assignmentTimeTracking: ts.assignmentTimeTracking,
    requireNote: ts.requireNote,
    requireTimeEntryDescription: ts.requireTimeEntryDescription,
    effortClasses: effortClasses
      .filter((ec) => ec.disabled !== true)
      .map((ec) => ({
        id: ec.id,
        name: ec.name,
        position: ec.position ?? null,
        costMultiplier: ec.costMultiplier ?? null,
        disabled: ec.disabled ?? false,
      })),
    timeAllocations: allocations.map((ta) => ({
      id: ta.id,
      name: ta.name,
      group: ta.group ?? null,
      descriptionRequired: ta.descriptionRequired ?? null,
    })),
    defaults: { ...ts.defaults },
    ...overrides,
  };
}

export const ME_ID = "TW9jay9QZXJzb24vMQ";
export const ALLOCATION_ID = "TW9jay9UaW1lQWxsb2NhdGlvbi8x";
export const ALLOCATION_DESC_REQUIRED_ID = "TW9jay9UaW1lQWxsb2NhdGlvbi8y";

/** strategies.planPlannedMutations için PlanContext. */
export function planContext(overrides = {}) {
  return {
    strategy: "two_step",
    timeZone: TZ,
    today: SABIT_YEREL_TARIH,
    meId: ME_ID,
    source: "xurrent-mcp",
    defaultTimeAllocationId: ALLOCATION_ID,
    timesheet: timesheetFixture(),
    targetLabel: null,
    ...overrides,
  };
}

/** validate.preflight için PreflightContext. */
export function preflightContext(overrides = {}) {
  const { timesheet: tsOverride, ...rest } = overrides;
  return {
    timesheet: tsOverride ?? timesheetFixture(),
    today: SABIT_YEREL_TARIH,
    maxBackdateDays: 1,
    meId: ME_ID,
    strategy: "two_step",
    allocation: null,
    dayMinutes: 0,
    weekMinutes: 0,
    ...rest,
  };
}

/** Minimum geçerli CreateTimeEntryInput. */
export function entry(overrides = {}) {
  return {
    targetType: "request",
    targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4",
    minutes: 60,
    ...overrides,
  };
}

/** fixtures/requests.json + tasks.json → eşleştirmede kullanılan WorkItem listesi (AÇIK olanlar). */
export function openWorkItems() {
  const requests = fixture("requests.json").requests;
  const tasks = fixture("tasks.json").tasks;
  const openRequests = requests.filter((r) => r.status !== "completed");
  const closedTaskStatuses = new Set(["completed", "approved", "failed", "rejected", "canceled"]);
  const openTasks = tasks.filter((t) => !closedTaskStatuses.has(t.status));
  return [
    ...openRequests.map((r) => workItem("request", r)),
    ...openTasks.map((t) => workItem("task", t)),
  ];
}

function workItem(kind, raw) {
  return {
    kind,
    id: raw.id,
    displayId: String(raw.requestId ?? raw.taskId ?? raw.displayId),
    subject: raw.subject,
    status: raw.status,
    statusLabel: raw.status,
    team: null,
    parentLabel: null,
    targetAt: null,
    updatedAt: null,
  };
}

/** Elle WorkItem kurmak için (saf eşleştirme testleri). */
export function makeWorkItem(displayId, subject, kind = "request") {
  return {
    kind,
    id: `id-${displayId}`,
    displayId: String(displayId),
    subject,
    status: "assigned",
    statusLabel: "assigned",
    team: null,
    parentLabel: null,
    targetAt: null,
    updatedAt: null,
  };
}

/** confirm.ts yalnızca bu iki alanı okur — tam AppConfig kurmaya gerek yok. */
export function confirmConfig(overrides = {}) {
  return { stateSecret: "birim-testi-sabit-anahtari", stateTtlSeconds: 300, ...overrides };
}
