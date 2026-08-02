/**
 * Tool girdi/çıktı şemaları (zod).
 *
 * MCP SDK KURALI: registerTool'un inputSchema/outputSchema alanları ZodRawShape
 * ister — yani ÇIPLAK bir nesne ({ a: z.string() }), z.object({...}) DEĞİL.
 * z.object geçirmek "shape" beklenen yerde tip hatası ya da bozuk JSON Schema üretir.
 *
 * outputSchema verildiğinde SDK, dönen structuredContent'i bu şemaya karşı
 * DOĞRULAR. Bu ücretsiz bir sözleşme testidir: alan adını yanlış yazarsan
 * tool çağrısı çalışma anında patlar, sessizce yanlış veri dönmez.
 */

import { z } from "zod";

// ── ortak parçalar ──────────────────────────────────────────────────────────

export const personSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  primaryEmail: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  timeZone: z.string().nullable().optional(),
  disabled: z.boolean().nullable().optional(),
  organization: z.object({ id: z.string(), name: z.string().nullable() }).nullable().optional(),
});

export const workItemSchema = z.object({
  kind: z.enum(["request", "task"]),
  id: z.string(),
  displayId: z.string(),
  subject: z.string().nullable(),
  status: z.string().nullable(),
  statusLabel: z.string().nullable(),
  isOpen: z.boolean(),
  targetAt: z.string().nullable(),
  team: z.string().nullable(),
  member: z.string().nullable(),
  parentLabel: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const workPageSchema = z.object({
  totalCount: z.number().int(),
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
  nodes: z.array(workItemSchema),
});

export const validationErrorSchema = z.object({
  message: z.string(),
  path: z.array(z.string()).nullable().optional(),
});

export const plannedMutationSchema = z.object({
  index: z.number().int().optional(),
  path: z.enum([
    "timeEntryCreate",
    "requestUpdate",
    "taskUpdate",
    "projectTaskUpdate",
    "problemUpdate",
    "timeEntryUpdate",
  ]),
  mutation: z.string(),
  input: z.record(z.string(), z.unknown()),
  warnings: z.array(z.string()),
  stepLabel: z.string().nullable(),
});

export const meetingSchema = z.object({
  source: z.enum(["mock", "ics", "google", "graph"]),
  id: z.string(),
  uid: z.string(),
  title: z.string(),
  start: z.string(),
  end: z.string(),
  minutes: z.number().int(),
  isAllDay: z.boolean(),
  isCancelled: z.boolean(),
  declined: z.boolean(),
  free: z.boolean(),
  skipped: z.boolean(),
  skipReason: z.string().nullable(),
  organizer: z.string().nullable(),
  attendeeCount: z.number().int(),
  categories: z.array(z.string()),
  seriesId: z.string().nullable(),
  joinUrl: z.string().nullable(),
});

// ── 1) xurrent_whoami ───────────────────────────────────────────────────────

export const whoamiInput = {} as const;

export const whoamiOutput = {
  person: personSchema,
  account: z.object({
    id: z.string(),
    name: z.string().nullable(),
    directory: z.boolean().nullable(),
  }),
  mode: z.enum(["mock", "live"]),
  rateLimit: z
    .object({
      limit: z.number(),
      cost: z.number(),
      remaining: z.number(),
      resetAt: z.number(),
    })
    .nullable(),
} as const;

// ── 2) xurrent_find_person ──────────────────────────────────────────────────

export const findPersonInput = {
  email: z
    .string()
    .describe("Birincil e-posta. TAM eşleşme yapılır (substring DEĞİL); büyük-küçük harf duyarlıdır."),
  view: z
    .enum(["all", "current_account"])
    .default("all")
    .describe("Varsayılan 'all'. 'current_account' kişinin diğer hesaplardaki kaydını gizler."),
} as const;

export const findPersonOutput = {
  totalCount: z.number().int(),
  people: z.array(personSchema),
  suggestFuzzy: z.boolean(),
} as const;

// ── 3) xurrent_list_open_work ───────────────────────────────────────────────

export const listOpenWorkInput = {
  personId: z.string().default("$me").describe("Person node ID veya '$me' (authenticated user)."),
  include: z.array(z.enum(["requests", "tasks"])).default(["requests", "tasks"]),
  first: z.number().int().min(1).max(100).default(25),
  afterRequests: z.string().optional().describe("Request sayfalama cursor'ı"),
  afterTasks: z.string().optional().describe("Task sayfalama cursor'ı"),
  view: z
    .enum(["all", "current_account"])
    .default("all")
    .describe("Xurrent varsayılanı 'current_account'tur; bu tool 'all' kullanır."),
} as const;

export const listOpenWorkOutput = {
  accountId: z.string(),
  requests: workPageSchema,
  tasks: workPageSchema,
} as const;

// ── 4) xurrent_get_time_tracking_context ────────────────────────────────────

export const timeTrackingContextInput = {
  personId: z.string().default("$me"),
} as const;

export const timeTrackingContextOutput = {
  unit: z.enum(["hours_and_minutes", "percentage_of_workday"]).nullable(),
  timeIncrement: z.number().int().nullable(),
  workday: z.number().int().nullable(),
  workweek: z.number().int().nullable(),
  allowWorkdayOvertime: z.boolean().nullable(),
  allowWorkweekOvertime: z.boolean().nullable(),
  allocationTimeTracking: z.boolean().nullable(),
  assignmentTimeTracking: z.boolean().nullable(),
  requireNote: z.boolean().nullable(),
  requireTimeEntryDescription: z.boolean().nullable(),
  effortClasses: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      position: z.number().int().nullable(),
      costMultiplier: z.number().nullable(),
      disabled: z.boolean().nullable(),
    }),
  ),
  timeAllocations: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      group: z.string().nullable(),
      descriptionRequired: z.boolean().nullable(),
    }),
  ),
  defaults: z.object({
    requestEffortClassId: z.string().nullable(),
    taskEffortClassId: z.string().nullable(),
    projectTaskEffortClassId: z.string().nullable(),
    problemEffortClassId: z.string().nullable(),
    timeAllocationEffortClassId: z.string().nullable(),
  }),
} as const;

// ── 5) xurrent_create_time_entry ────────────────────────────────────────────

export const createTimeEntryInput = {
  targetType: z
    .enum(["time_allocation", "request", "task", "project_task", "problem"])
    .describe("'time_allocation' → Yol A (timeEntryCreate). Diğerleri → Yol B (parent update)."),
  targetId: z.string().describe("Opak node ID. ASLA tahmin edilmez; bir tool çıktısından gelir."),
  minutes: z
    .number()
    .int()
    .describe("DAKİKA. timeIncrement'in KATI olmalı. Negatif değer yalnızca correction=true ile."),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("ISO8601 tarih. Boşsa bugün. T-1'den eski değerler reddedilir."),
  startedAt: z
    .string()
    .optional()
    .describe("ISO8601 timestamp, offset ZORUNLU. Sadece metadata; timesheet gününü DEĞİŞTİRMEZ."),
  personId: z.string().optional().describe("Boşsa authenticated user. Farklıysa ek yetki gerekir."),
  effortClassId: z.string().optional(),
  description: z.string().max(80).optional().describe("En fazla 80 karakter."),
  note: z.string().optional().describe("Yalnızca Yol B'de anlamlıdır."),
  customerId: z.string().optional().describe("Yalnızca Yol A"),
  serviceId: z.string().optional().describe("Yalnızca Yol A"),
  organizationId: z.string().optional().describe("Yalnızca Yol A. Kişinin KENDİ organizasyonu."),
  teamId: z.string().optional().describe("Yalnızca Yol A"),
  correction: z.boolean().default(false),
  sourceId: z.string().optional().describe("Idempotency anahtarı. Boşsa deterministik üretilir."),
  backdateStrategy: z
    .enum(["two_step", "link_first", "date_first"])
    .optional()
    .describe("Boşsa XURRENT_BACKDATE_STRATEGY env değeri kullanılır."),
  dryRun: z.boolean().default(false).describe("true ise HİÇBİR mutation gönderilmez."),
} as const;

export const writeResultOutput = {
  dryRun: z.boolean(),
  strategy: z.enum(["two_step", "link_first", "date_first"]),
  strategyExplanation: z.string(),
  planned: z.array(plannedMutationSchema),
  warnings: z.array(z.string()),
  timeEntry: z.record(z.string(), z.unknown()).nullable(),
  errors: z.array(validationErrorSchema),
} as const;

// ── 6) xurrent_create_time_entries_bulk ─────────────────────────────────────

export const bulkInput = {
  entries: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(50)
    .describe("xurrent_create_time_entry input'ları (dryRun ve backdateStrategy hariç)."),
  dryRun: z.boolean().default(false),
  stopOnError: z.boolean().default(true).describe("true ise ilk hatada durur — yarım kalan durumu netleştirir."),
  backdateStrategy: z.enum(["two_step", "link_first", "date_first"]).optional(),
} as const;

export const bulkOutput = {
  dryRun: z.boolean(),
  planned: z.array(plannedMutationSchema),
  results: z.array(
    z.object({
      index: z.number().int(),
      status: z.enum(["created", "failed", "skipped"]),
      timeEntryId: z.string().nullable(),
      errors: z.array(validationErrorSchema),
    }),
  ),
  summary: z.object({
    requested: z.number().int(),
    created: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
    totalMinutes: z.number().int(),
  }),
} as const;

// ── 7) calendar_list_today ──────────────────────────────────────────────────

export const calendarInput = {
  provider: z.enum(["mock", "ics", "google", "graph", "auto"]).default("auto"),
  userEmail: z.string().optional().describe("app-only / domain-wide-delegation modunda impersonate edilecek kullanıcı"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Boşsa bugün"),
  timeZone: z.string().default("Europe/Istanbul").describe("IANA saat dilimi"),
  includeAllDay: z.boolean().default(false),
  includeDeclined: z.boolean().default(false),
  includeFree: z.boolean().default(false),
} as const;

export const calendarOutput = {
  windowStart: z.string(),
  windowEnd: z.string(),
  timeZone: z.string(),
  provider: z.string(),
  meetings: z.array(meetingSchema),
  totals: z.object({
    count: z.number().int(),
    busyMinutes: z.number().int(),
    naiveSumMinutes: z.number().int(),
    rawCount: z.number().int(),
    filteredOut: z.number().int(),
  }),
} as const;

// ── 8) plan_time_entries_from_calendar ──────────────────────────────────────

export const planInput = {
  personId: z.string().default("$me"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  timeZone: z.string().default("Europe/Istanbul"),
  provider: z.enum(["mock", "ics", "google", "graph", "auto"]).default("auto"),
  defaultTargetType: z.enum(["time_allocation", "request", "task"]).optional(),
  defaultTargetId: z.string().optional(),
  roundingMode: z.enum(["nearest", "up", "down"]).default("nearest"),
} as const;

export const planOutput = {
  date: z.string(),
  timeIncrement: z.number().int().nullable(),
  proposals: z.array(
    z.object({
      meetingTitle: z.string(),
      startedAt: z.string(),
      rawMinutes: z.number().int(),
      roundedMinutes: z.number().int(),
      suggestedTargetType: z.string().nullable(),
      suggestedTargetId: z.string().nullable(),
      suggestedTargetLabel: z.string().nullable(),
      matchReason: z.string().nullable(),
      matchConfidence: z.number().min(0).max(1).nullable(),
      needsUserDecision: z.boolean(),
      warnings: z.array(z.string()),
    }),
  ),
  unmatchedMeetings: z.array(z.string()),
  totals: z.object({
    meetingMinutes: z.number().int(),
    proposedMinutes: z.number().int(),
  }),
} as const;
