/**
 * Canlı Xurrent adapter — GraphQL üzerinden gerçek API.
 *
 * ENDPOINT: POST https://graphql.xurrent.com/ — TÜM operasyonlar POST'tur (query dahil).
 * BÖLGELER: global (varsayılan), au, uk, ch, us. "eu" DİYE BİR BÖLGE YOKTUR.
 * HEADER: Authorization: Bearer <token> + X-Xurrent-Account: <slug> + Content-Type: application/json
 *
 * HATA MODELİ — İKİ AYRI YER:
 *   1) top-level "errors" → sorgu/şema/auth hatası.
 *   2) payload.errors     → İŞ KURALI hatası. HTTP 200 ile gelir ve payload.timeEntry null olur.
 *      Sadece HTTP status'a bakan bir istemci bunu BAŞARILI sanar. En sinsi hata sınıfı.
 *
 * RATE LIMIT: 20 istek / 2 saniye. Bulk yazmada istekler arası >= 110 ms beklenir.
 *
 * NOT: Bu adapter gerçek bir Xurrent hesabına karşı ÇALIŞTIRILMAMIŞTIR; şema
 * resmi dokümantasyondan çıkarılmıştır. İlk canlı bağlantıda XURRENT_DRY_RUN=1 ile
 * başlanmalıdır (bkz. README "Durum ve sınırlar").
 */

import type { AppConfig } from "../config.js";
import type {
  EffortClass,
  FindPersonResult,
  ListOpenWorkResult,
  PlannedMutation,
  RateLimitInfo,
  TimeEntryRecord,
  TimeTrackingContext,
  ValidationError,
  ViewOption,
  WhoamiResult,
  WorkItem,
} from "../types.js";
import { log } from "../util/log.js";
import { addDaysISO, todayISO, weekStartISO } from "../util/time.js";
import type {
  ExecuteResult,
  ListOpenWorkArgs,
  ListTimeEntriesArgs,
  ListTimeEntriesPage,
  XurrentAdapter,
} from "./index.js";
import {
  FIND_PERSON_QUERY,
  LATEST_TIME_ENTRY_QUERY,
  LIST_TIME_ENTRIES_QUERY,
  ME_QUERY,
  OPEN_REQUESTS_QUERY,
  OPEN_TASKS_QUERY,
  TIME_ENTRY_BY_SOURCE_ID_QUERY,
  TIME_TRACKING_CONTEXT_QUERY,
} from "./queries.js";
import {
  XurrentRequestError,
  classifyReason,
  retryingRequest,
  traceDedup,
  type OperationClass,
} from "./retry.js";
import { PENDING_TIME_ENTRY_ID } from "./strategies.js";

const REQUEST_CLOSED = new Set(["completed"]);
const TASK_CLOSED = new Set(["completed", "approved", "failed", "rejected", "canceled"]);

/** İstek toplamı için üst sınır (reliability.md §3): 30 sn. */
const REQUEST_TIMEOUT_MS = 30000;

interface GraphQLResponse<T> {
  data?: T;
  errors?: unknown;
}

/**
 * Mutation path'i → operasyon sınıfı (contract/reliability.md §2).
 *
 * AYNI HTTP HATASI farklı operasyonlarda farklı karar üretir:
 *   timeEntryCreate  → guarded_create   (dedup geri-okumalı retry)
 *   timeEntryUpdate  → idempotent_update (mutlak SET — tekrar zararsız)
 *   parent update'ler → no_retry         (timeSpent ARTIMLI — tekrar = çift sayım)
 */
function operationClassFor(path: string): OperationClass {
  if (path === "timeEntryCreate") return "guarded_create";
  if (path === "timeEntryUpdate") return "idempotent_update";
  return "no_retry"; // requestUpdate / taskUpdate / projectTaskUpdate / problemUpdate
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GraphQL "errors" alanı SPEC'te dizidir ama pratikte bazı gateway'ler tek bir
 * nesne de döndürebilir. İki şekli de aynı listeye indirger.
 */
function normalizeGraphQLErrors(errors: unknown): ValidationError[] {
  if (!errors) return [];
  const list = Array.isArray(errors) ? errors : [errors];
  return list.map((e) => {
    if (typeof e === "string") return { message: e };
    const obj = e as { message?: unknown; path?: unknown };
    return {
      message: typeof obj.message === "string" ? obj.message : JSON.stringify(e),
      path: Array.isArray(obj.path) ? obj.path.map(String) : null,
    };
  });
}

export class LiveXurrentAdapter implements XurrentAdapter {
  readonly mode = "live" as const;
  private readonly cfg: AppConfig;
  private lastRequestAt = 0;
  private lastRateLimit: RateLimitInfo | null = null;
  /** Session içi cache: timesheet ayarları her yazmada tekrar sorgulanmaz. */
  private contextCache: TimeTrackingContext | null = null;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
  }

  /**
   * Retry politikalı GraphQL çağrısı. Varsayılan sınıf "query"dir (yan etkisiz,
   * serbestçe tekrarlanabilir); mutation'lar execute() içinden kendi sınıflarını
   * geçirir. Politikanın kendisi retry.ts'tedir — burada yalnızca tek denemenin
   * nasıl atılacağı (sendOnce) tanımlanır.
   */
  private async gql<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
    op?: {
      opClass?: OperationClass;
      label?: string;
      /** guarded_create dedup kurtarması — bkz. execute(). */
      recoverUncertain?: () => Promise<{ data: T; errors: ValidationError[] } | null>;
    },
  ): Promise<{ data: T; errors: ValidationError[] }> {
    return retryingRequest({
      label: op?.label ?? "query",
      opClass: op?.opClass ?? "query",
      policy: {
        maxAttempts: this.cfg.retryMaxAttempts,
        baseMs: this.cfg.retryBaseMs,
        capMs: this.cfg.retryCapMs,
      },
      attempt: () => this.sendOnce<T>(query, variables, signal),
      recoverUncertain: op?.recoverUncertain,
      signal,
    });
  }

  /**
   * TEK HTTP denemesi. Gaz (throttle) BURADADIR — yani retry tekrarları dahil
   * HER istek aynı kapıdan geçer (reliability.md §4: gaz tek yerde yaşar).
   */
  private async sendOnce<T>(
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ data: T; errors: ValidationError[] }> {
    // Rate limit koruması: istekler arası minimum boşluk (XURRENT_MIN_REQUEST_GAP_MS).
    const gap = Date.now() - this.lastRequestAt;
    if (gap < this.cfg.minRequestGapMs) await sleep(this.cfg.minRequestGapMs - gap);
    this.lastRequestAt = Date.now();

    // Zaman aşımı çağıranın iptaliyle BİRLEŞTİRİLİR: hangisi önce gelirse.
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(this.cfg.graphqlUrl, {
        method: "POST", // Xurrent GraphQL'de GET YOKTUR.
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.cfg.token}`,
          // Slug'dır, numerik DEĞİL. İç personelin time entry'leri DIRECTORY hesabında yaşar.
          "X-Xurrent-Account": this.cfg.account,
        },
        body: JSON.stringify({ query, variables }),
        signal: composed,
      });
    } catch (err) {
      // Çağıranın iptali retry EDİLMEZ — sınıflandırılamayan hata olarak yükselir.
      if (signal?.aborted) throw err;
      if (timeoutSignal.aborted) {
        throw new XurrentRequestError(
          `Xurrent isteği ${REQUEST_TIMEOUT_MS / 1000} sn içinde tamamlanmadı (zaman aşımı).`,
          { kind: "timeout" },
        );
      }
      // Tüm ağ hataları BELİRSİZ sayılır (reliability.md §1 notu): fetch'in ham
      // TypeError'ı sarmalanır ki sınıflandırma bizim kontrolümüzde kalsın.
      const msg = err instanceof Error ? err.message : String(err);
      throw new XurrentRequestError(`Ağ hatası: ${msg}`, { kind: "network" });
    }

    this.captureRateLimit(res);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Retry-After saniye cinsindendir (D15 varsayımı) → ms'e çevrilir.
      const rawRetryAfter = res.headers.get("retry-after");
      const retryAfterSec = rawRetryAfter !== null ? Number(rawRetryAfter) : NaN;
      throw new XurrentRequestError(`Xurrent GraphQL HTTP ${res.status}: ${text.slice(0, 500)}`, {
        status: res.status,
        retryAfterMs: Number.isFinite(retryAfterSec) ? Math.max(0, retryAfterSec * 1000) : null,
        kind: "http",
      });
    }

    const json = (await res.json()) as GraphQLResponse<T>;
    // Top-level GraphQL errors ve payload errors FIRLATILMAZ, değerle döner:
    // ikisi de "kesin-reddedildi" sınıfıdır ve retry katmanına hiç girmez.
    return { data: (json.data ?? {}) as T, errors: normalizeGraphQLErrors(json.errors) };
  }

  private captureRateLimit(res: Response): void {
    const limit = Number(res.headers.get("x-ratelimit-limit") ?? "");
    const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "");
    const reset = Number(res.headers.get("x-ratelimit-reset") ?? "");
    const cost = Number(res.headers.get("x-ratelimit-cost") ?? "");
    if (Number.isFinite(limit) && limit > 0) {
      this.lastRateLimit = {
        limit,
        cost: Number.isFinite(cost) ? cost : 0,
        remaining: Number.isFinite(remaining) ? remaining : 0,
        resetAt: Number.isFinite(reset) ? reset : 0,
      };
    }
  }

  // ── okuma ─────────────────────────────────────────────────────────────────

  async whoami(signal?: AbortSignal): Promise<WhoamiResult> {
    const { data, errors } = await this.gql<{
      me: { id: string; name: string; primaryEmail: string; jobTitle: string; timeZone: string; disabled: boolean; organization: { id: string; name: string } | null };
      account: { id: string; name: string; directory: boolean } | null;
    }>(ME_QUERY, {}, signal);
    if (errors.length) throw new Error(`whoami başarısız: ${errors.map((e) => e.message).join("; ")}`);
    return {
      person: {
        id: data.me.id,
        name: data.me.name,
        primaryEmail: data.me.primaryEmail,
        jobTitle: data.me.jobTitle,
        timeZone: data.me.timeZone,
        disabled: data.me.disabled,
        organization: data.me.organization,
      },
      account: {
        id: data.account?.id ?? this.cfg.account,
        name: data.account?.name ?? null,
        directory: data.account?.directory ?? null,
      },
      mode: "live",
      rateLimit: this.lastRateLimit,
    };
  }

  async findPerson(email: string, view: ViewOption, signal?: AbortSignal): Promise<FindPersonResult> {
    const { data, errors } = await this.gql<{
      people: { totalCount: number; nodes: Array<{ id: string; name: string; primaryEmail: string; jobTitle: string; timeZone: string; disabled: boolean; organization: { id: string; name: string } | null }> };
    }>(FIND_PERSON_QUERY, { email, view }, signal);
    if (errors.length) throw new Error(`findPerson başarısız: ${errors.map((e) => e.message).join("; ")}`);
    return {
      totalCount: data.people.totalCount,
      people: data.people.nodes,
      // TAM eşleşme yapıldığı için sonuç yoksa serbest metin arama ÖNERİLİR.
      suggestFuzzy: data.people.totalCount === 0,
    };
  }

  async listOpenWork(args: ListOpenWorkArgs, signal?: AbortSignal): Promise<ListOpenWorkResult> {
    const personId = args.personId ?? "$me";
    const include = args.include ?? ["requests", "tasks"];
    const first = args.first ?? 25;
    // view VARSAYILANI "current_account"tur → "all" geçmezsek diğer hesaplardaki işler görünmez.
    const view = args.view ?? "all";

    const empty = { totalCount: 0, hasNextPage: false, endCursor: null, nodes: [] as WorkItem[] };
    const result: ListOpenWorkResult = {
      accountId: this.cfg.account,
      requests: { ...empty },
      tasks: { ...empty },
    };

    if (include.includes("requests")) {
      const { data, errors } = await this.gql<{
        requests: {
          totalCount: number;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<any>;
        };
      }>(
        OPEN_REQUESTS_QUERY,
        // personId String! olarak deklare edilir (ID! DEĞİL) — PersonReferenceFilter.values [String]!
        { personId, first, after: args.afterRequests ?? null, view },
        signal,
      );
      if (errors.length) throw new Error(`requests sorgusu başarısız: ${errors.map((e) => e.message).join("; ")}`);
      // "open" diye bir view YOKTUR → açık/kapalı ayrımı status ile client'ta yapılır.
      const open = data.requests.nodes.filter((n) => !REQUEST_CLOSED.has(String(n.status)));
      result.requests = {
        totalCount: open.length,
        hasNextPage: data.requests.pageInfo.hasNextPage,
        endCursor: data.requests.pageInfo.endCursor,
        nodes: open.map((n) => ({
          kind: "request" as const,
          id: n.id,
          displayId: String(n.requestId ?? ""),
          subject: n.subject ?? null,
          status: n.status ?? null,
          statusLabel: n.status ?? null,
          isOpen: true,
          targetAt: n.nextTargetAt ?? null, // Request → nextTargetAt
          team: n.team?.name ?? null,
          member: n.member?.name ?? null,
          parentLabel: null,
          updatedAt: n.updatedAt ?? null,
        })),
      };
    }

    if (include.includes("tasks")) {
      const { data, errors } = await this.gql<{
        tasks: {
          totalCount: number;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<any>;
        };
      }>(OPEN_TASKS_QUERY, { personId, first, after: args.afterTasks ?? null, view }, signal);
      if (errors.length) throw new Error(`tasks sorgusu başarısız: ${errors.map((e) => e.message).join("; ")}`);
      // Task'ta BEŞ terminal durum vardır; sadece "completed"ı elemek YETMEZ.
      const open = data.tasks.nodes.filter((n) => !TASK_CLOSED.has(String(n.status)));
      result.tasks = {
        totalCount: open.length,
        hasNextPage: data.tasks.pageInfo.hasNextPage,
        endCursor: data.tasks.pageInfo.endCursor,
        nodes: open.map((n) => ({
          kind: "task" as const,
          id: n.id,
          displayId: String(n.taskId ?? ""),
          subject: n.subject ?? null,
          status: n.status ?? null,
          statusLabel: n.status ?? null,
          isOpen: true,
          targetAt: n.completionTargetAt ?? null, // Task → completionTargetAt (completedAt YOKTUR)
          team: n.team?.name ?? null,
          member: n.member?.name ?? null,
          parentLabel: n.workflow?.subject ?? null,
          updatedAt: n.updatedAt ?? null,
        })),
      };
    }

    return result;
  }

  async getTimeTrackingContext(_personId: string, signal?: AbortSignal): Promise<TimeTrackingContext> {
    if (this.contextCache) return this.contextCache;

    const { data, errors } = await this.gql<any>(TIME_TRACKING_CONTEXT_QUERY, { first: 100 }, signal);
    if (errors.length) {
      throw new Error(`timesheet bağlamı alınamadı: ${errors.map((e) => e.message).join("; ")}`);
    }
    const setting = data?.me?.organization?.timesheetSetting ?? {};
    const classes: EffortClass[] = (data?.effortClasses?.nodes ?? []) as EffortClass[];

    const ctx: TimeTrackingContext = {
      unit: setting.unit ?? null,
      // Bilinmiyorsa Xurrent varsayılanı 60'tır — ve 60 varsaymak 45 dakikalık
      // girişleri reddettirir. Bu yüzden değer TAHMİN EDİLMEZ, sorgulanır.
      timeIncrement: setting.timeIncrement ?? null,
      workday: setting.workday ?? null,
      workweek: setting.workweek ?? null,
      allowWorkdayOvertime: setting.allowWorkdayOvertime ?? null,
      allowWorkweekOvertime: setting.allowWorkweekOvertime ?? null,
      allocationTimeTracking: setting.allocationTimeTracking ?? null,
      assignmentTimeTracking: setting.assignmentTimeTracking ?? null,
      requireNote: setting.requireNote ?? null,
      requireTimeEntryDescription: setting.requireTimeEntryDescription ?? null,
      // EffortClassFilter'da "disabled" filtresi YOKTUR → client-side eleme ŞART.
      effortClasses: classes
        .filter((ec) => ec.disabled !== true)
        .map((ec) => ({
          id: ec.id,
          name: ec.name ?? null,
          position: ec.position ?? null,
          costMultiplier: ec.costMultiplier ?? null,
          disabled: ec.disabled ?? false,
        })),
      timeAllocations: (data?.timeAllocations?.nodes ?? []).map((ta: any) => ({
        id: ta.id,
        name: ta.name ?? null,
        group: ta.group?.name ?? null,
        descriptionRequired: ta.descriptionRequired ?? null,
      })),
      defaults: {
        requestEffortClassId: setting.requestEffortClass?.id ?? null,
        taskEffortClassId: setting.taskEffortClass?.id ?? null,
        projectTaskEffortClassId: setting.projectTaskEffortClass?.id ?? null,
        problemEffortClassId: setting.problemEffortClass?.id ?? null,
        timeAllocationEffortClassId: setting.timeAllocationEffortClass?.id ?? null,
      },
    };

    this.contextCache = ctx; // Session içi cache — sözleşmede açıkça isteniyor.
    return ctx;
  }

  async usage(
    personId: string,
    dateISO: string,
    signal?: AbortSignal,
  ): Promise<{ dayMinutes: number; weekMinutes: number }> {
    const weekStart = weekStartISO(dateISO);
    const { data } = await this.gql<any>(
      LATEST_TIME_ENTRY_QUERY,
      { personId: personId || "$me", dateFrom: weekStart },
      signal,
    );
    const nodes: Array<{ date: string; timeSpent: number }> = data?.timeEntries?.nodes ?? [];
    const weekEnd = addDaysISO(weekStart, 7);
    let day = 0;
    let week = 0;
    for (const n of nodes) {
      if (n.date === dateISO) day += n.timeSpent ?? 0;
      if (n.date >= weekStart && n.date < weekEnd) week += n.timeSpent ?? 0;
    }
    return { dayMinutes: day, weekMinutes: week };
  }

  async resolveTargetLabel(targetType: string, targetId: string): Promise<string | null> {
    // Canlı modda etiket için ayrı bir sorgu ATMIYORUZ: her ek sorgu rate limit
    // bütçesinden yer ve gecikme demektir. Opak id yeterince tanımlayıcıdır.
    return `${targetType} ${targetId}`;
  }

  /**
   * Geri-okuma listesi (contract #9). TEK timeEntries sorgusu; değişken adları
   * sözleşme gereği personId/dateFrom/dateTo/sourceID'dir. Sınıf "query" —
   * yan etkisiz, retry politikası serbestçe uygulanır (reliability.md §2).
   */
  async listTimeEntries(args: ListTimeEntriesArgs, signal?: AbortSignal): Promise<ListTimeEntriesPage> {
    const first = args.first ?? 25;
    const { data, errors } = await this.gql<any>(
      LIST_TIME_ENTRIES_QUERY,
      {
        // personId String! — "$me" özel değeri de bu değişkenden geçer.
        personId: args.personId || "$me",
        dateFrom: args.dateFrom ?? null,
        dateTo: args.dateTo ?? null,
        sourceID: args.sourceId ?? null,
        first,
      },
      signal,
      { label: "listTimeEntries" },
    );
    if (errors.length) {
      throw new Error(`timeEntries sorgusu başarısız: ${errors.map((e) => e.message).join("; ")}`);
    }
    const nodes: Array<Record<string, any>> = data?.timeEntries?.nodes ?? [];
    return {
      accountId: this.cfg.account,
      timeEntries: nodes.slice(0, first).map((n) => this.toTimeEntryRecord(n)),
    };
  }

  private toTimeEntryRecord(n: Record<string, any>): TimeEntryRecord {
    const a = n["assignment"];
    return {
      id: String(n["id"]),
      date: String(n["date"]),
      startedAt: n["startedAt"] ?? null,
      timeSpent: Number(n["timeSpent"] ?? 0),
      description: n["description"] ?? null,
      correction: n["correction"] ?? null,
      source: n["source"] ?? null,
      sourceID: n["sourceID"] ?? null,
      person: n["person"] ? { id: String(n["person"].id), name: n["person"].name ?? null } : null,
      // ★ Yol A kayıtlarında assignment null'dır — bu alan dersin kalbidir.
      assignment: a
        ? {
            type: a["__typename"] ?? null,
            id: a["id"] ?? null,
            // Request'te requestId, Task'ta taskId — UI numarası tipe göre değişir.
            displayId:
              a["requestId"] !== undefined && a["requestId"] !== null
                ? String(a["requestId"])
                : a["taskId"] !== undefined && a["taskId"] !== null
                  ? String(a["taskId"])
                  : null,
          }
        : null,
      effortClass: n["effortClass"]
        ? { id: String(n["effortClass"].id), name: n["effortClass"].name ?? null }
        : null,
    };
  }

  // ── yazma ─────────────────────────────────────────────────────────────────

  async execute(planned: PlannedMutation[], signal?: AbortSignal): Promise<ExecuteResult> {
    const errors: ValidationError[] = [];
    let timeEntry: Record<string, unknown> | null = null;
    let createdId: string | null = null;
    let executed = 0;

    for (const step of planned) {
      let variables = step.input;

      // two_step 2. adımı: id 1. adımın PAYLOAD'INDAN GELMEZ (payload TimeEntry
      // döndürmez) → araya bir sorgu koyup en yeni kaydı buluruz.
      if (step.path === "timeEntryUpdate") {
        const inner = { ...((step.input["input"] ?? {}) as Record<string, unknown>) };
        if (inner["id"] === PENDING_TIME_ENTRY_ID) {
          const resolved = createdId ?? (await this.findLatestTimeEntryId(signal));
          if (!resolved) {
            errors.push({
              message:
                "2. adım için TimeEntry id'si bulunamadı. 1. adım muhtemelen başarılı oldu → ticket'a bağlı ama BUGÜN tarihli bir kayıt kalmış olabilir.",
            });
            break;
          }
          inner["id"] = resolved;
        }
        variables = { input: inner };
      }

      // ★ Her adım KENDİ operasyon sınıfıyla çalışır: aynı 500 hatası
      // timeEntryUpdate'te retry, requestUpdate'te "asla" demektir.
      const opClass = operationClassFor(step.path);
      const inner = (variables["input"] ?? {}) as Record<string, unknown>;
      const sourceID = typeof inner["sourceID"] === "string" ? (inner["sourceID"] as string) : "";

      let data: any;
      let topLevel: ValidationError[];
      try {
        const res = await this.gql<any>(step.mutation, variables, signal, {
          opClass,
          label: step.path,
          // guarded_create'in belirsiz-hata kurtarması: 5xx/ağ hatasında ÖNCE
          // "yazma aslında ulaştı mı?" sorusu sorulur. Kayıt bulunursa retry
          // İPTAL edilir ve mevcut kayıt başarı sayılır — ikinci POST atılmaz.
          recoverUncertain:
            opClass === "guarded_create" && sourceID
              ? async () => {
                  const found = await this.findTimeEntryBySourceId(sourceID, signal);
                  traceDedup(sourceID, found !== null);
                  if (!found) return null;
                  return {
                    data: { timeEntryCreate: { clientMutationId: null, errors: [], timeEntry: found } },
                    errors: [],
                  };
                }
              : undefined,
        });
        data = res.data;
        topLevel = res.errors;
      } catch (err) {
        errors.push(this.transportErrorToValidation(step.path, opClass, err));
        break;
      }
      if (topLevel.length) {
        errors.push(...topLevel);
        break;
      }

      const payloadKey = step.path;
      const payload = data?.[payloadKey];
      // İŞ KURALI hataları BURADA yaşar: HTTP 200 + payload.errors dolu + timeEntry null.
      const payloadErrors = normalizeGraphQLErrors(payload?.errors);
      if (payloadErrors.length) {
        errors.push(...payloadErrors);
        break;
      }

      executed++;
      if (payload?.timeEntry) {
        timeEntry = payload.timeEntry as Record<string, unknown>;
        createdId = String(payload.timeEntry.id);
      }
    }

    if (executed > 0 && errors.length > 0) {
      log.warn("kısmi başarı: bazı adımlar çalıştı, sonrası başarısız", { executed, errors: errors.length });
    }

    return { timeEntry, errors, executed };
  }

  private async findLatestTimeEntryId(signal?: AbortSignal): Promise<string | null> {
    const { data } = await this.gql<any>(
      LATEST_TIME_ENTRY_QUERY,
      { personId: "$me", dateFrom: todayISO(this.cfg.timeZone) },
      signal,
    );
    const nodes: Array<{ id: string }> = data?.timeEntries?.nodes ?? [];
    return nodes[0]?.id ?? null;
  }

  /**
   * Dedup geri-okuması (reliability.md §5): sourceID ile mevcut kayıt aranır.
   * Kendisi query sınıfıdır — yani BU sorgu da retry politikasından geçer
   * (geri-okumanın kendisi 429 yerse politika onu da kurtarır).
   */
  async findTimeEntryBySourceId(sourceID: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!sourceID) return null;
    const { data, errors } = await this.gql<any>(TIME_ENTRY_BY_SOURCE_ID_QUERY, { sourceID }, signal);
    if (errors.length) {
      // Geri-okuma sorgu hatası "kayıt yok" DEMEK DEĞİLDİR ama güvenli taraf
      // "bulunamadı"dır: dedup kaçarsa en kötü ihtimalle çift kayıt Xurrent
      // tarafında sourceID ile TESPİT EDİLEBİLİR kalır; ters yönde hata
      // (var sanıp yazmamak) kaybolan zaman girişi demektir.
      log.warn("dedup geri-okuması başarısız — kayıt yok varsayıldı", {
        errors: errors.map((e) => e.message),
      });
      return null;
    }
    const nodes: Array<Record<string, unknown>> = data?.timeEntries?.nodes ?? [];
    return nodes[0] ?? null;
  }

  /**
   * Retry katmanından KAÇAN (tüketilmiş ya da hiç yapılmamış) transport hatasını
   * kullanıcıya dönecek ValidationError'a çevirir. no_retry sınıfında mesaj,
   * sözleşmenin şart koştuğu uyarıyı taşır: yazma ULAŞMIŞ da olabilir.
   */
  private transportErrorToValidation(path: string, opClass: OperationClass, err: unknown): ValidationError {
    const base = err instanceof Error ? err.message : String(err);
    const reason = classifyReason(err);
    if (opClass === "no_retry" && (reason === "5xx" || reason === "network")) {
      return {
        message:
          `${path} BELİRSİZ hatayla düştü (${base}). Bu operasyonda timeSpent ARTIMLIDIR ve ` +
          "otomatik tekrar ÇİFT SAYIM riski taşıdığı için YAPILMADI. DİKKAT: istek sunucuya " +
          "ulaşmış ve İŞLENMİŞ olabilir — kayıt oluşmuş da olabilir, oluşmamış da. " +
          "Ticket'ın zaman girişlerini kontrol edip elle karar verin.",
      };
    }
    if (reason !== null && this.cfg.retryMaxAttempts > 1) {
      return {
        message: `${path} ${this.cfg.retryMaxAttempts} denemede başarılamadı: ${base}`,
      };
    }
    return { message: `${path} başarısız: ${base}` };
  }
}
