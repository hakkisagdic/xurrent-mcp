/**
 * Mock Xurrent adapter — fixtures/ klasöründen okur, yazmaları BELLEKTE tutar.
 *
 * Bu adapter'ın tek işi "gerçek API gibi davranmak" değil, GERÇEK API'nin
 * KISITLARINI da taklit etmektir:
 *   - requestUpdate/taskUpdate ile yazılan kayıt her zaman BUGÜN tarihli olur
 *     ve authenticated user adına yazılır (Yol B'nin gerçek davranışı).
 *   - timeEntryCreate ile yazılan kaydın assignment'ı null'dır.
 *   - timeEntryUpdate assignment'a DOKUNMAZ.
 * Bu üçü taklit edilmezse ders yalan söyler.
 *
 * Göreli tarih sözleşmesi: fixture'larda mutlak tarih yoktur; dayOffset + "HH:mm"
 * yükleme anında kişinin saat diliminde materyalize edilir (bkz. fixtures/README.md).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import type {
  EffortClass,
  FindPersonResult,
  ListOpenWorkResult,
  Person,
  PlannedMutation,
  TimeAllocation,
  TimeEntryRecord,
  TimeTrackingContext,
  ValidationError,
  WhoamiResult,
  WorkItem,
} from "../types.js";
import { log } from "../util/log.js";
import { addDaysISO, todayISO, toOffsetISO, weekStartISO, zonedToInstant } from "../util/time.js";
import { PENDING_TIME_ENTRY_ID } from "./strategies.js";
import type {
  ExecuteResult,
  ListOpenWorkArgs,
  ListTimeEntriesArgs,
  ListTimeEntriesPage,
  XurrentAdapter,
} from "./index.js";

// Terminal (kapalı) durumlar — açık/kapalı ayrımının TEK kaynağı budur.
// RequestStatus'ta TEK terminal değer vardır.
const REQUEST_CLOSED = new Set(["completed"]);
// TaskStatus'ta BEŞ terminal değer vardır. Sadece "completed"ı elemek YETMEZ.
const TASK_CLOSED = new Set(["completed", "approved", "failed", "rejected", "canceled"]);

interface FixturePerson extends Person {
  employeeID?: string;
  costPerHour?: number;
  manager?: { id: string; name: string } | null;
}

interface FixtureRequest {
  id: string;
  requestId: string;
  subject: string;
  status: string;
  statusLabel: string;
  memberId: string;
  team: string;
  serviceName: string;
  updatedAtOffsetDays: number;
  targetAtOffsetDays: number;
  completedAtOffsetDays?: number;
  timeSpentTotalMinutes: number;
}

interface FixtureTask {
  id: string;
  taskId: string;
  subject: string;
  status: string;
  statusLabel: string;
  assigneeId: string;
  team: string;
  workflowSubject: string | null;
  linkedRequestId: string | null;
  updatedAtOffsetDays: number;
  targetAtOffsetDays: number;
  finishedAtOffsetDays?: number;
  timeSpentTotalMinutes: number;
}

interface FixtureTimeEntry {
  id: string;
  personId: string;
  assignmentType: string | null;
  assignmentId: string | null;
  dayOffset: number;
  startedAtLocal: string | null;
  timeSpent: number;
  description: string | null;
  effortClassId: string | null;
  correction: boolean;
  source: string | null;
  sourceID: string | null;
}

interface MockTimeEntry {
  id: string;
  personId: string;
  assignmentType: string | null;
  assignmentId: string | null;
  date: string;
  startedAt: string | null;
  timeSpent: number;
  description: string | null;
  effortClassId: string | null;
  timeAllocationId: string | null;
  correction: boolean;
  source: string | null;
  sourceID: string | null;
}

function readJson<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
}

export class MockXurrentAdapter implements XurrentAdapter {
  readonly mode = "mock" as const;

  private readonly cfg: AppConfig;
  private readonly people: FixturePerson[];
  private readonly meId: string;
  private readonly account: { id: string; name: string; directory: boolean };
  private readonly requests: FixtureRequest[];
  private readonly tasks: FixtureTask[];
  private readonly effortClasses: EffortClass[];
  private readonly timeAllocationsRaw: Array<TimeAllocation & { effortClassId: string }>;
  private readonly timesheet: Record<string, unknown>;
  private entries: MockTimeEntry[];
  private nextEntrySeq = 1000;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    const dir = cfg.fixturesDir;

    const peopleFile = readJson<{ me: string; account: { id: string; name: string; directory: boolean }; people: FixturePerson[] }>(
      dir,
      "people.json",
    );
    this.people = peopleFile.people;
    this.meId = peopleFile.me;
    this.account = peopleFile.account;

    this.requests = readJson<{ requests: FixtureRequest[] }>(dir, "requests.json").requests;
    this.tasks = readJson<{ tasks: FixtureTask[] }>(dir, "tasks.json").tasks;
    this.effortClasses = readJson<{ effortClasses: EffortClass[] }>(dir, "effort-classes.json").effortClasses;
    this.timeAllocationsRaw = readJson<{
      timeAllocations: Array<TimeAllocation & { effortClassId: string }>;
    }>(dir, "time-allocations.json").timeAllocations;
    this.timesheet = readJson<{ timesheetSetting: Record<string, unknown> }>(dir, "timesheet-settings.json")
      .timesheetSetting;

    const entriesFile = readJson<{ timeEntries: FixtureTimeEntry[] }>(dir, "time-entries.json");
    this.entries = entriesFile.timeEntries.map((e) => this.materializeEntry(e));
  }

  // ── yardımcılar ───────────────────────────────────────────────────────────

  private get tz(): string {
    return this.cfg.timeZone;
  }

  private today(): string {
    return todayISO(this.tz);
  }

  private materializeEntry(e: FixtureTimeEntry): MockTimeEntry {
    const date = addDaysISO(this.today(), e.dayOffset);
    return {
      id: e.id,
      personId: e.personId,
      assignmentType: e.assignmentType,
      assignmentId: e.assignmentId,
      date,
      startedAt: e.startedAtLocal ? toOffsetISO(zonedToInstant(date, e.startedAtLocal, this.tz), this.tz) : null,
      timeSpent: e.timeSpent,
      description: e.description,
      effortClassId: e.effortClassId,
      timeAllocationId: null,
      correction: e.correction,
      source: e.source,
      sourceID: e.sourceID,
    };
  }

  private resolvePersonId(personId?: string): string {
    return !personId || personId === "$me" ? this.meId : personId;
  }

  private offsetIso(dateISO: string, timeLocal: string): string {
    return toOffsetISO(zonedToInstant(dateISO, timeLocal, this.tz), this.tz);
  }

  // ── okuma ─────────────────────────────────────────────────────────────────

  async whoami(): Promise<WhoamiResult> {
    const me = this.people.find((p) => p.id === this.meId)!;
    return {
      person: {
        id: me.id,
        name: me.name,
        primaryEmail: me.primaryEmail ?? null,
        jobTitle: me.jobTitle ?? null,
        timeZone: me.timeZone ?? null,
        disabled: me.disabled ?? false,
        organization: me.organization ?? null,
      },
      account: { id: this.account.id, name: this.account.name, directory: this.account.directory },
      mode: "mock",
      // Mock modda rate limit UYDURULMAZ. Gerçek değer yalnızca canlı cevabın
      // header'larından gelir; olmayan bir sayıyı raporlamak öğrenciyi yanıltır.
      rateLimit: null,
    };
  }

  async findPerson(email: string): Promise<FindPersonResult> {
    // PersonFilter.primaryEmail bir TextFilter'dır → TAM eşleşme, substring DEĞİL.
    const matches = this.people.filter((p) => p.primaryEmail === email);
    return {
      totalCount: matches.length,
      people: matches.map((p) => ({
        id: p.id,
        name: p.name,
        primaryEmail: p.primaryEmail ?? null,
        jobTitle: p.jobTitle ?? null,
        timeZone: p.timeZone ?? null,
        disabled: p.disabled ?? false,
        organization: p.organization ?? null,
      })),
      suggestFuzzy: matches.length === 0,
    };
  }

  async listOpenWork(args: ListOpenWorkArgs): Promise<ListOpenWorkResult> {
    const personId = this.resolvePersonId(args.personId);
    const include = args.include ?? ["requests", "tasks"];
    const first = args.first ?? 25;

    const emptyPage = { totalCount: 0, hasNextPage: false, endCursor: null, nodes: [] as WorkItem[] };

    // Request tarafında atanan kişi alanı "member"dır.
    const openRequests = include.includes("requests")
      ? this.requests.filter((r) => r.memberId === personId && !REQUEST_CLOSED.has(r.status))
      : [];

    // Task tarafında atanan kişi alanı "assignee"dir — "member" YOKTUR.
    const openTasks = include.includes("tasks")
      ? this.tasks.filter((t) => t.assigneeId === personId && !TASK_CLOSED.has(t.status))
      : [];

    const memberName = this.people.find((p) => p.id === personId)?.name ?? null;

    const requestNodes: WorkItem[] = openRequests.slice(0, first).map((r) => ({
      kind: "request",
      id: r.id,
      displayId: r.requestId, // Request'te UI numarası requestId
      subject: r.subject,
      status: r.status,
      statusLabel: r.statusLabel,
      isOpen: true,
      targetAt: this.offsetIso(addDaysISO(this.today(), r.targetAtOffsetDays), "17:00"), // Request → nextTargetAt
      team: r.team,
      member: memberName,
      parentLabel: r.serviceName ?? null,
      updatedAt: this.offsetIso(addDaysISO(this.today(), r.updatedAtOffsetDays), "12:00"),
    }));

    const taskNodes: WorkItem[] = openTasks.slice(0, first).map((t) => ({
      kind: "task",
      id: t.id,
      displayId: t.taskId, // Task'ta UI numarası taskId
      subject: t.subject,
      status: t.status,
      statusLabel: t.statusLabel,
      isOpen: true,
      targetAt: this.offsetIso(addDaysISO(this.today(), t.targetAtOffsetDays), "17:00"), // Task → completionTargetAt
      team: t.team,
      member: memberName,
      parentLabel:
        t.workflowSubject ??
        (t.linkedRequestId
          ? `Request #${this.requests.find((r) => r.id === t.linkedRequestId)?.requestId ?? "?"}`
          : null),
      updatedAt: this.offsetIso(addDaysISO(this.today(), t.updatedAtOffsetDays), "12:00"),
    }));

    return {
      // Cache anahtarı (accountId, nodeId) olmalıdır: status/member/team alanları
      // account-specific'tir; aynı node farklı hesapta farklı görünür.
      accountId: this.account.id,
      requests: include.includes("requests")
        ? { totalCount: openRequests.length, hasNextPage: openRequests.length > first, endCursor: null, nodes: requestNodes }
        : emptyPage,
      tasks: include.includes("tasks")
        ? { totalCount: openTasks.length, hasNextPage: openTasks.length > first, endCursor: null, nodes: taskNodes }
        : emptyPage,
    };
  }

  async getTimeTrackingContext(): Promise<TimeTrackingContext> {
    const ts = this.timesheet as Record<string, any>;
    return {
      unit: ts["unit"] ?? null,
      timeIncrement: ts["timeIncrement"] ?? null,
      workday: ts["workday"] ?? null,
      workweek: ts["workweek"] ?? null,
      allowWorkdayOvertime: ts["allowWorkdayOvertime"] ?? null,
      allowWorkweekOvertime: ts["allowWorkweekOvertime"] ?? null,
      allocationTimeTracking: ts["allocationTimeTracking"] ?? null,
      assignmentTimeTracking: ts["assignmentTimeTracking"] ?? null,
      requireNote: ts["requireNote"] ?? null,
      requireTimeEntryDescription: ts["requireTimeEntryDescription"] ?? null,
      // EffortClassFilter'da "disabled" filtresi YOKTUR → CLIENT TARAFINDA eleriz.
      effortClasses: this.effortClasses
        .filter((ec) => ec.disabled !== true)
        .map((ec) => ({
          id: ec.id,
          name: ec.name,
          position: ec.position ?? null,
          costMultiplier: ec.costMultiplier ?? null,
          disabled: ec.disabled ?? false,
        })),
      timeAllocations: this.timeAllocationsRaw.map((ta) => ({
        id: ta.id,
        name: ta.name,
        group: ta.group ?? null,
        descriptionRequired: ta.descriptionRequired ?? null,
      })),
      defaults: {
        requestEffortClassId: ts["defaults"]?.requestEffortClassId ?? null,
        taskEffortClassId: ts["defaults"]?.taskEffortClassId ?? null,
        projectTaskEffortClassId: ts["defaults"]?.projectTaskEffortClassId ?? null,
        problemEffortClassId: ts["defaults"]?.problemEffortClassId ?? null,
        timeAllocationEffortClassId: ts["defaults"]?.timeAllocationEffortClassId ?? null,
      },
    };
  }

  async usage(personId: string, dateISO: string): Promise<{ dayMinutes: number; weekMinutes: number }> {
    const pid = this.resolvePersonId(personId);
    const weekStart = weekStartISO(dateISO);
    const weekEnd = addDaysISO(weekStart, 7);
    let day = 0;
    let week = 0;
    for (const e of this.entries) {
      if (e.personId !== pid) continue;
      if (e.date === dateISO) day += e.timeSpent;
      if (e.date >= weekStart && e.date < weekEnd) week += e.timeSpent;
    }
    return { dayMinutes: day, weekMinutes: week };
  }

  async findTimeEntryBySourceId(sourceID: string): Promise<Record<string, unknown> | null> {
    // Mock'ta geri-okuma bellek içi store'dan yapılır — davranış canlıyla AYNI:
    // aynı sourceID'li kayıt varsa döner, yoksa null. Birim testlerin dedup'ı
    // ağsız kanıtlayabilmesi bu simetriye dayanır.
    if (!sourceID) return null;
    const found = this.entries.find((e) => e.sourceID === sourceID);
    return found ? ({ ...found } as unknown as Record<string, unknown>) : null;
  }

  /**
   * Geri-okuma listesi (contract #9): bellek içi store, canlı sorgunun
   * filtreleriyle BİREBİR aynı anlamda süzülür — personId/dateFrom/dateTo/sourceID.
   * TimeEntryRecord eşlemesi TEK yerde (toTimeEntryRecord) yaşar; dedup
   * geri-okuması ile aynı store'u okur, ayrı bir "görüş" üretmez.
   */
  async listTimeEntries(args: ListTimeEntriesArgs): Promise<ListTimeEntriesPage> {
    const pid = this.resolvePersonId(args.personId);
    const first = args.first ?? 25;
    const rows = this.entries
      .filter(
        (e) =>
          e.personId === pid &&
          (!args.dateFrom || e.date >= args.dateFrom) &&
          (!args.dateTo || e.date <= args.dateTo) &&
          (!args.sourceId || e.sourceID === args.sourceId),
      )
      .slice(0, first);
    return {
      accountId: this.account.id,
      timeEntries: rows.map((e) => this.toTimeEntryRecord(e)),
    };
  }

  private toTimeEntryRecord(e: MockTimeEntry): TimeEntryRecord {
    let assignment: TimeEntryRecord["assignment"] = null;
    if (e.assignmentType && e.assignmentId) {
      // displayId gerçek API'deki gibi tipe göre çözülür: Request→requestId, Task→taskId.
      const displayId =
        e.assignmentType === "Request"
          ? this.requests.find((r) => r.id === e.assignmentId)?.requestId ?? null
          : e.assignmentType === "Task"
            ? this.tasks.find((t) => t.id === e.assignmentId)?.taskId ?? null
            : null;
      assignment = { type: e.assignmentType, id: e.assignmentId, displayId };
    }
    const ec = e.effortClassId ? this.effortClasses.find((c) => c.id === e.effortClassId) ?? null : null;
    return {
      id: e.id,
      date: e.date,
      startedAt: e.startedAt,
      timeSpent: e.timeSpent,
      description: e.description,
      correction: e.correction,
      source: e.source,
      sourceID: e.sourceID,
      person: {
        id: e.personId,
        name: this.people.find((p) => p.id === e.personId)?.name ?? null,
      },
      assignment,
      effortClass: ec ? { id: ec.id, name: ec.name } : null,
    };
  }

  async resolveTargetLabel(targetType: string, targetId: string): Promise<string | null> {
    if (targetType === "request") {
      const r = this.requests.find((x) => x.id === targetId);
      return r ? `Request #${r.requestId} — ${r.subject}` : null;
    }
    if (targetType === "task") {
      const t = this.tasks.find((x) => x.id === targetId);
      return t ? `Task #${t.taskId} — ${t.subject}` : null;
    }
    if (targetType === "time_allocation") {
      const a = this.timeAllocationsRaw.find((x) => x.id === targetId);
      return a ? `TimeAllocation "${a.name}"` : null;
    }
    return null;
  }

  getTimeAllocation(id: string): TimeAllocation | null {
    const a = this.timeAllocationsRaw.find((x) => x.id === id);
    return a ? { id: a.id, name: a.name, group: a.group ?? null, descriptionRequired: a.descriptionRequired ?? null } : null;
  }

  // ── yazma ─────────────────────────────────────────────────────────────────

  async execute(planned: PlannedMutation[]): Promise<ExecuteResult> {
    const errors: ValidationError[] = [];
    let createdId: string | null = null;
    let executed = 0;

    for (const step of planned) {
      const vars = (step.input["input"] ?? {}) as Record<string, any>;

      if (step.path === "timeEntryCreate") {
        const entry = this.createEntry({
          personId: this.resolvePersonId(vars["personId"]),
          assignmentType: null, // Yol A ticket'a BAĞLANAMAZ — assignment null.
          assignmentId: null,
          date: vars["date"] ?? this.today(),
          startedAt: vars["startedAt"] ?? null,
          timeSpent: Number(vars["timeSpent"] ?? 0),
          description: vars["description"] ?? null,
          effortClassId: vars["effortClassId"] ?? null,
          timeAllocationId: vars["timeAllocationId"] ?? null,
          correction: vars["correction"] === true,
          source: vars["source"] ?? null,
          sourceID: vars["sourceID"] ?? null,
        });
        createdId = entry.id;
        executed++;
        continue;
      }

      if (
        step.path === "requestUpdate" ||
        step.path === "taskUpdate" ||
        step.path === "projectTaskUpdate" ||
        step.path === "problemUpdate"
      ) {
        const targetId = String(vars["id"] ?? "");
        const kind =
          step.path === "requestUpdate"
            ? "Request"
            : step.path === "taskUpdate"
              ? "Task"
              : step.path === "projectTaskUpdate"
                ? "ProjectTask"
                : "Problem";

        const exists =
          kind === "Request"
            ? this.requests.some((r) => r.id === targetId)
            : kind === "Task"
              ? this.tasks.some((t) => t.id === targetId)
              : true;
        if (!exists) {
          errors.push({ message: `Kayıt bulunamadı: ${kind} ${targetId}`, path: ["id"] });
          break;
        }

        const minutes = Number(vars["timeSpent"] ?? 0);
        const entry = this.createEntry({
          // Yol B: person HER ZAMAN authenticated user. Kontrol edilemez.
          personId: this.meId,
          assignmentType: kind,
          assignmentId: targetId,
          // Yol B: date HER ZAMAN bugün. Kontrol edilemez.
          date: this.today(),
          startedAt: null,
          timeSpent: minutes,
          description: vars["timeEntryDescription"] ?? null,
          effortClassId: vars["timeSpentEffortClassId"] ?? null,
          timeAllocationId: null,
          correction: false,
          source: null,
          sourceID: null,
        });

        // timeSpent ARTIMLIDIR: toplamın ÜZERİNE eklenir.
        if (kind === "Request") {
          const r = this.requests.find((x) => x.id === targetId)!;
          r.timeSpentTotalMinutes += minutes;
        } else if (kind === "Task") {
          const t = this.tasks.find((x) => x.id === targetId)!;
          t.timeSpentTotalMinutes += minutes;
        }

        createdId = entry.id;
        executed++;
        continue;
      }

      if (step.path === "timeEntryUpdate") {
        // 1. adımda oluşan id'yi yerine koy — gerçek hayatta bu id bir SORGU ile bulunur.
        const rawId = String(vars["id"] ?? "");
        const id: string | null = rawId === PENDING_TIME_ENTRY_ID ? createdId : rawId;
        const entry: MockTimeEntry | undefined = this.entries.find((e) => e.id === id);
        if (!entry) {
          errors.push({
            message: `TimeEntry bulunamadı: ${id ?? "(id çözümlenemedi)"} — two_step'in 2. adımı başarısız.`,
            path: ["id"],
          });
          break;
        }
        // TimeEntryUpdateInput'ta assignment ALANI YOKTUR → assignment'a DOKUNMUYORUZ.
        if (vars["date"]) entry.date = String(vars["date"]);
        if (vars["startedAt"]) entry.startedAt = String(vars["startedAt"]);
        if (vars["personId"]) entry.personId = this.resolvePersonId(String(vars["personId"]));
        if (vars["description"]) entry.description = String(vars["description"]);
        if (vars["timeSpent"] !== undefined) entry.timeSpent = Number(vars["timeSpent"]);
        if (vars["source"]) entry.source = String(vars["source"]);
        if (vars["sourceID"]) entry.sourceID = String(vars["sourceID"]);
        createdId = entry.id;
        executed++;
        continue;
      }

      errors.push({ message: `Bilinmeyen mutation: ${step.path}` });
      break;
    }

    this.persist();
    const timeEntry = createdId ? this.entries.find((e) => e.id === createdId) ?? null : null;
    return { timeEntry: timeEntry as unknown as Record<string, unknown> | null, errors, executed };
  }

  private createEntry(e: Omit<MockTimeEntry, "id">): MockTimeEntry {
    const entry: MockTimeEntry = { id: `TW9jay9UaW1lRW50cnkv${this.nextEntrySeq++}`, ...e };
    this.entries.push(entry);
    return entry;
  }

  /** XURRENT_MOCK_PERSIST=1 ise yazılanlar diske de düşer (demo sonrası incelemek için). */
  private persist(): void {
    if (!this.cfg.mockPersist) return;
    try {
      // Dosya adı .gitignore ile UYUMLU olmalı (fixtures/.time-entries.local.json),
      // yoksa demo sonrası üretilen kayıtlar yanlışlıkla commit'lenir.
      writeFileSync(
        join(this.cfg.fixturesDir, ".time-entries.local.json"),
        JSON.stringify({ generatedAt: new Date().toISOString(), timeEntries: this.entries }, null, 2),
        "utf8",
      );
    } catch (err) {
      log.warn("mock persist başarısız", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Ders/sihirbaz için: bir hedefin güncel toplam süresi. */
  totalMinutesFor(targetType: string, targetId: string): number | null {
    if (targetType === "request") return this.requests.find((r) => r.id === targetId)?.timeSpentTotalMinutes ?? null;
    if (targetType === "task") return this.tasks.find((t) => t.id === targetId)?.timeSpentTotalMinutes ?? null;
    return null;
  }
}
