/**
 * contract/tools.json'daki tiplerin TypeScript karşılıkları.
 *
 * Bu dosya SÖZLEŞMENİN yansımasıdır — burada uydurma alan olmaz.
 * Python ve C# implementasyonları da aynı alan adlarını kullanır; bir alanı
 * burada yeniden adlandırmak üç dili birden bozar.
 */

export type XurrentMode = "mock" | "live";
export type BackdateStrategy = "two_step" | "link_first" | "date_first";
export type TargetType = "time_allocation" | "request" | "task" | "project_task" | "problem";
export type CalendarProvider = "mock" | "ics" | "google" | "graph";
export type CalendarProviderOption = CalendarProvider | "auto";
export type RoundingMode = "nearest" | "up" | "down";
export type ViewOption = "all" | "current_account";

/** MCP revizyonu. "both" YALNIZCA HTTP transport'ta anlamlıdır — stdio tek protokol konuşur. */
export type McpProtocolOption = "2026-07-28" | "2025-11-25" | "both";

/**
 * XURRENT_CONFIRM_POLICY — yazma öncesi onayın ne kadar zorunlu olduğu.
 * Üç dil de AYNI üç değeri tanır (bkz. .env.example):
 *
 *   closed → VARSAYILAN. Onay kanalı yoksa: live REDDEDİLİR, mock uyarıyla devam eder.
 *   open   → onay hiç sorulmaz. YALNIZCA CI/otomasyon.
 *   strict → onay MOCK modda da ZORUNLUDUR; kanal yoksa mock'ta bile REDDEDİLİR.
 */
export type ConfirmPolicy = "closed" | "open" | "strict";

export interface Person {
  id: string;
  name: string | null;
  primaryEmail?: string | null;
  jobTitle?: string | null;
  timeZone?: string | null;
  disabled?: boolean | null;
  organization?: { id: string; name: string | null } | null;
}

export interface RateLimitInfo {
  limit: number;
  cost: number;
  remaining: number;
  resetAt: number;
}

export interface WhoamiResult {
  person: Person;
  account: { id: string; name: string | null; directory: boolean | null };
  mode: XurrentMode;
  rateLimit: RateLimitInfo | null;
}

export interface FindPersonResult {
  totalCount: number;
  people: Person[];
  suggestFuzzy: boolean;
}

export interface WorkItem {
  kind: "request" | "task";
  id: string;
  /** UI'da görünen numara: Request'te requestId, Task'ta taskId. */
  displayId: string;
  subject: string | null;
  status: string | null;
  statusLabel: string | null;
  isOpen: boolean;
  /** Request'te nextTargetAt, Task'ta completionTargetAt. */
  targetAt: string | null;
  team: string | null;
  member: string | null;
  parentLabel: string | null;
  updatedAt: string | null;
}

export interface WorkPage {
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  nodes: WorkItem[];
}

export interface ListOpenWorkResult {
  accountId: string;
  requests: WorkPage;
  tasks: WorkPage;
}

export interface EffortClass {
  id: string;
  name: string | null;
  position: number | null;
  costMultiplier: number | null;
  disabled: boolean | null;
}

export interface TimeAllocation {
  id: string;
  name: string | null;
  group: string | null;
  descriptionRequired: boolean | null;
}

export interface TimeTrackingContext {
  unit: "hours_and_minutes" | "percentage_of_workday" | null;
  /** timeSpent'in hem MİNİMUMU hem ADIMI (dakika). Bilinmeden yazma yapılamaz. */
  timeIncrement: number | null;
  workday: number | null;
  workweek: number | null;
  allowWorkdayOvertime: boolean | null;
  allowWorkweekOvertime: boolean | null;
  allocationTimeTracking: boolean | null;
  assignmentTimeTracking: boolean | null;
  requireNote: boolean | null;
  requireTimeEntryDescription: boolean | null;
  effortClasses: EffortClass[];
  timeAllocations: TimeAllocation[];
  defaults: {
    requestEffortClassId: string | null;
    taskEffortClassId: string | null;
    projectTaskEffortClassId: string | null;
    problemEffortClassId: string | null;
    timeAllocationEffortClassId: string | null;
  };
}

export interface ValidationError {
  message: string;
  path?: string[] | null;
}

export type MutationPath =
  | "timeEntryCreate"
  | "requestUpdate"
  | "taskUpdate"
  | "projectTaskUpdate"
  | "problemUpdate"
  | "timeEntryUpdate";

export interface PlannedMutation {
  index?: number;
  path: MutationPath;
  /** Gönderilecek GraphQL metni — derste birebir gösterilir. */
  mutation: string;
  input: Record<string, unknown>;
  warnings: string[];
  /** two_step stratejisinde "1/2" veya "2/2". */
  stepLabel: string | null;
}

export interface WriteResult {
  dryRun: boolean;
  strategy: BackdateStrategy;
  strategyExplanation: string;
  planned: PlannedMutation[];
  warnings: string[];
  timeEntry: Record<string, unknown> | null;
  errors: ValidationError[];
}

export interface BulkResultRow {
  index: number;
  status: "created" | "failed" | "skipped";
  timeEntryId: string | null;
  errors: ValidationError[];
}

export interface BulkResult {
  dryRun: boolean;
  planned: PlannedMutation[];
  results: BulkResultRow[];
  summary: {
    requested: number;
    created: number;
    failed: number;
    skipped: number;
    totalMinutes: number;
  };
}

export interface Meeting {
  source: CalendarProvider;
  id: string;
  /** Dedup anahtarı: iCalUID + start instant. Tek başına iCalUID YETMEZ. */
  uid: string;
  title: string;
  /** ISO8601, offset'li mutlak instant. */
  start: string;
  end: string;
  minutes: number;
  isAllDay: boolean;
  isCancelled: boolean;
  declined: boolean;
  /** showAs=free veya transparency=transparent. */
  free: boolean;
  skipped: boolean;
  skipReason: string | null;
  organizer: string | null;
  attendeeCount: number;
  categories: string[];
  seriesId: string | null;
  joinUrl: string | null;
}

export interface CalendarDayResult {
  windowStart: string;
  windowEnd: string;
  timeZone: string;
  provider: string;
  meetings: Meeting[];
  totals: {
    count: number;
    /** Çakışmalar BİR KEZ sayılır (interval merge). */
    busyMinutes: number;
    /** Çakışmaları ayrı sayan naif toplam — farkı göstermek öğreticidir. */
    naiveSumMinutes: number;
    rawCount: number;
    filteredOut: number;
  };
}

export interface PlanProposal {
  meetingTitle: string;
  startedAt: string;
  rawMinutes: number;
  roundedMinutes: number;
  suggestedTargetType: string | null;
  suggestedTargetId: string | null;
  suggestedTargetLabel: string | null;
  matchReason: string | null;
  matchConfidence: number | null;
  needsUserDecision: boolean;
  warnings: string[];
}

export interface PlanResult {
  date: string;
  timeIncrement: number | null;
  proposals: PlanProposal[];
  unmatchedMeetings: string[];
  totals: { meetingMinutes: number; proposedMinutes: number };
}

/** xurrent_create_time_entry girdisi (sözleşmedeki input şemasının aynısı). */
export interface CreateTimeEntryInput {
  targetType: TargetType;
  targetId: string;
  minutes: number;
  date?: string;
  startedAt?: string;
  personId?: string;
  effortClassId?: string;
  description?: string;
  note?: string;
  customerId?: string;
  serviceId?: string;
  organizationId?: string;
  teamId?: string;
  correction?: boolean;
  sourceId?: string;
  backdateStrategy?: BackdateStrategy;
  dryRun?: boolean;
}
