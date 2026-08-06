/**
 * Canlı Xurrent adapter — REST v1 üzerinden (developer.xurrent.com/v1).
 *
 * AYNI XurrentAdapter arayüzü, İKİNCİ wire biçimi. GraphQL adaptörüyle
 * (live.ts) bilinçli farklar — dersin konusu (docs/16):
 *
 *   · Alan adları snake_case'tir (started_at, time_spent) — sourceID HARİÇ
 *     (Xurrent REST dokümantasyonu da sourceID yazar).
 *   · Referans alanları YAZARKEN İD'SİZ addır ve değeri düz id'dir:
 *     person, effort_class, time_allocation, service, customer
 *     (developer.xurrent.com/v1/time_entries — person_id DEĞİL).
 *   · Validation hataları HTTP 422 + {"message":"Validation Failed",
 *     "errors":[["alan","mesaj"], ...]} döner — İKİLİ DİZİLER, nesne değil
 *     (developer.xurrent.com/v1/#http-status-codes). GraphQL'in
 *     "HTTP 200 + payload.errors" modelinin TAM TERSİ. İstemci HTTP koduna
 *     BAKMAK zorundadır. İki model de aynı errors[] şekline normalize edilir;
 *     422 bir "kesin-reddedildi"dir ve ASLA retry edilmez.
 *   · Filtrelerde operatör DEĞERİN İÇİNDEDİR: ?date=>=2026-01-01<=2026-01-31
 *     (developer.xurrent.com/v1/general/filtering — date_from/date_to YOKTUR).
 *   · whoami tek istekte alınamaz: GET /me + GET /account = 2 istek
 *     (GraphQL'de 1 sorguydu). context 3 istektir: /timesheet_settings +
 *     /effort_classes + /time_allocations. "1 sorgu vs N istek" kontrastı.
 *   · "$me" özel değeri REST'te YOKTUR — GraphQL PersonReferenceFilter'ın
 *     lüksüydü. Kişi bazlı sorgulardan önce GET /me ile gerçek id çözülür.
 *
 * DEĞİŞMEYENLER — çünkü politika transportun değil OPERASYONUN özelliğidir
 * (contract/reliability.md):
 *   · retry.ts AYNEN kullanılır. Sınıflandırma: GET = query,
 *     POST /time_entries = guarded_create, PATCH /time_entries/:id =
 *     idempotent_update, PATCH /requests|tasks/:id = no_retry.
 *   · Gaz (throttle) aynı kapıdadır; [retry]/[dedup] izleri aynı biçimdedir.
 *   · Dedup geri-okuması GET /time_entries?sourceID= ile yapılır.
 *   · x-ratelimit-* başlıkları aynı şekilde yakalanır.
 *
 * Alan adları, hata gövdesi biçimi, filtre sözdizimi ve sayfalama 2026-08-06'da
 * developer.xurrent.com'a karşı DOĞRULANMIŞTIR. Canlıda kalan tek belirsizlik
 * sunucunun ürettiği değerlerin içeriğidir, şekli değil. Sahte sunucu
 * (tools/fake-xurrent/server.mjs → handleRest) bu dosyanın yürütülebilir
 * spesifikasyonudur.
 */

import type { AppConfig } from "../config.js";
import type {
  EffortClass,
  FindPersonResult,
  ListOpenWorkResult,
  Person,
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
  XurrentRequestError,
  classifyReason,
  retryingRequest,
  traceDedup,
  type OperationClass,
} from "./retry.js";
import { PENDING_TIME_ENTRY_ID } from "./strategies.js";

// GraphQL adaptörüyle AYNI kapalı-durum kümeleri: REST'te de eleme client'ta.
const REQUEST_CLOSED = new Set(["completed"]);
const TASK_CLOSED = new Set(["completed", "approved", "failed", "rejected", "canceled"]);

/** İstek toplamı için üst sınır (reliability.md §3): 30 sn. */
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Mutation path'i → operasyon sınıfı. GraphQL'dekiyle (live.ts) BİREBİR aynı
 * tablo — REST karşılıkları: timeEntryCreate = POST /time_entries,
 * timeEntryUpdate = PATCH /time_entries/:id, parent update'ler =
 * PATCH /requests|tasks|project_tasks|problems/:id. Sınıf değişmez, çünkü
 * "PATCH /requests/:id'nin time_spent'i ARTIMLIDIR" gerçeği transporttan bağımsız.
 */
function operationClassFor(path: string): OperationClass {
  if (path === "timeEntryCreate") return "guarded_create";
  if (path === "timeEntryUpdate") return "idempotent_update";
  return "no_retry"; // requestUpdate / taskUpdate / projectTaskUpdate / problemUpdate
}

/** Parent path → REST koleksiyon adı. project_tasks/problems DOĞRULANMALI (fake desteklemez). */
const PARENT_COLLECTION: Record<string, string> = {
  requestUpdate: "requests",
  taskUpdate: "tasks",
  projectTaskUpdate: "project_tasks",
  problemUpdate: "problems",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * REST hata gövdesi → sözleşmenin errors[] şekli. Belgelenen biçim
 * (developer.xurrent.com/v1/#http-status-codes) 422'de İKİLİ DİZİLERDİR:
 *   {"message": "Validation Failed", "errors": [["alan", "yerel mesaj"], ...]}
 * Her ikili [alan, mesaj] → {message: mesaj, path: [alan]} olarak taşınır;
 * alan adı snake_case olarak AYNEN korunur (çevirmek yalan katmanı olurdu).
 * errors[] yoksa gövdedeki düz {"message": "..."} kullanılır — 404 ve benzeri
 * transport-dışı 4xx'ler bu biçimde gelir.
 */
function normalizeRestErrors(body: unknown, status: number): ValidationError[] {
  const list = (body as { errors?: unknown })?.errors;
  if (Array.isArray(list) && list.length > 0) {
    return list.map((e) => {
      // ★ Belgelenen ikili biçim: ["alan", "mesaj"] (nesne DEĞİL).
      if (Array.isArray(e) && e.length >= 2) {
        return { message: String(e[1]), path: [String(e[0])] };
      }
      if (typeof e === "string") return { message: e };
      // Savunmacı dal: belgelenmemiş bir nesne biçimi görülürse mesajı kurtar.
      const obj = e as { message?: unknown; attribute?: unknown };
      return {
        message: typeof obj.message === "string" ? obj.message : JSON.stringify(e),
        path: typeof obj.attribute === "string" && obj.attribute ? [obj.attribute] : null,
      };
    });
  }
  const msg = (body as { message?: unknown })?.message;
  if (typeof msg === "string" && msg) return [{ message: `Xurrent REST HTTP ${status}: ${msg}` }];
  return [{ message: `Xurrent REST HTTP ${status} (gövdede errors[] yok).` }];
}

/** null/undefined/boş alanları at — REST gövdesine boş alan göndermeyiz. */
function compactBody(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out;
}

/** Sorgu dizesi: null/boş parametreler hiç yazılmaz. */
function qs(params: Record<string, string | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/**
 * ★ REST filtre değeri: operatör DEĞERİN İÇİNDEDİR
 * (developer.xurrent.com/v1/general/filtering). date_from/date_to diye
 * parametreler GERÇEKTE YOKTUR — tek "date" parametresi taşınır:
 *   from=to        → "2026-01-15"                 (eşitlik)
 *   yalnız from    → ">=2026-01-01"
 *   yalnız to      → "<=2026-01-31"
 *   ikisi de       → ">=2026-01-01<=2026-01-31"   (kapalı aralık)
 * URL kodlaması URLSearchParams'a bırakılır (>= → %3E%3D — normal davranış).
 */
function restDateFilter(dateFrom?: string | null, dateTo?: string | null): string | null {
  if (dateFrom && dateTo) return dateFrom === dateTo ? dateFrom : `>=${dateFrom}<=${dateTo}`;
  if (dateFrom) return `>=${dateFrom}`;
  if (dateTo) return `<=${dateTo}`;
  return null;
}

/** Tek REST çağrısının sonucu. errors DOLU ⇔ kesin-reddedildi (4xx, 429 hariç). */
interface RestResult<T> {
  status: number;
  body: T;
  errors: ValidationError[];
  /** guarded_create dedup kurtarmasından sentezlendi — body ZATEN normalize kayıttır. */
  recovered?: boolean;
}

// ── snake_case → içsel şekil normalizasyonu ──────────────────────────────────
// Tool'lar transporttan habersizdir; adaptör sınırında HER ŞEY GraphQL yolunun
// ürettiği içsel şekle çevrilir. "Üç dil aynı çıktıyı üretir" tezi buna bağlı.

interface RestPerson {
  id: string;
  name?: string | null;
  primary_email?: string | null;
  job_title?: string | null;
  time_zone?: string | null;
  disabled?: boolean | null;
  organization?: { id: string; name: string | null } | null;
}

function personFromRest(p: RestPerson): Person {
  return {
    id: p.id,
    name: p.name ?? null,
    primaryEmail: p.primary_email ?? null,
    jobTitle: p.job_title ?? null,
    timeZone: p.time_zone ?? null,
    disabled: p.disabled ?? null,
    organization: p.organization ?? null,
  };
}

/**
 * ★ REST yanıtında "assignment" diye bir alan YOKTUR: bağlı kayıt KOŞULLU
 * request / task / problem / project_task referans nesneleri olarak gelir
 * (developer.xurrent.com/v1/time_entries). İçsel {type,id} şekli hangisi
 * mevcutsa ondan türetilir — GraphQL yolunun ürettiği şekle normalize edilir.
 */
const REST_ASSIGNMENT_REFS: ReadonlyArray<readonly [field: string, type: string]> = [
  ["request", "Request"],
  ["task", "Task"],
  ["problem", "Problem"],
  ["project_task", "ProjectTask"],
];

function assignmentFromRest(t: Record<string, any>): TimeEntryRecord["assignment"] {
  for (const [field, type] of REST_ASSIGNMENT_REFS) {
    const ref = t[field] as { id?: unknown } | null | undefined;
    if (ref && ref.id != null) {
      // UI numarası (displayId) bu uçta yoktur.
      return { type, id: String(ref.id), displayId: null };
    }
  }
  return null;
}

function timeEntryFromRest(t: Record<string, any>): TimeEntryRecord {
  return {
    id: String(t["id"]),
    date: String(t["date"]),
    startedAt: t["started_at"] ?? null,
    timeSpent: Number(t["time_spent"] ?? 0),
    description: t["description"] ?? null,
    correction: t["correction"] ?? null,
    source: t["source"] ?? null,
    sourceID: t["sourceID"] ?? null, // ★ REST'te de camel — tek istisna
    person: t["person"] ? { id: String(t["person"].id), name: t["person"].name ?? null } : null,
    assignment: assignmentFromRest(t),
    effortClass: t["effort_class"]
      ? { id: String(t["effort_class"].id), name: t["effort_class"].name ?? null }
      : null,
  };
}

export class RestXurrentAdapter implements XurrentAdapter {
  readonly mode = "live" as const;
  private readonly cfg: AppConfig;
  private lastRequestAt = 0;
  private lastRateLimit: RateLimitInfo | null = null;
  /** Session içi cache'ler — GraphQL yolundaki contextCache ile aynı gerekçe. */
  private contextCache: TimeTrackingContext | null = null;
  /**
   * whoami cache'i: REST'te whoami 2 istek olduğu için (ders kontrastı) her
   * yazma öncesi tekrarlamak rate-limit bütçesini boşa yakar. İlk çağrı iki
   * isteği GERÇEKTEN atar; sonrası cache'ten döner.
   */
  private whoamiCache: WhoamiResult | null = null;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
  }

  // ── HTTP çekirdeği ────────────────────────────────────────────────────────

  /**
   * Retry politikalı REST çağrısı. Varsayılan sınıf "query" (GET'ler yan
   * etkisizdir). Politika retry.ts'te yaşar — GraphQL adaptörüyle AYNI modül,
   * tek satırı değişmeden. Burada yalnızca tek denemenin şekli tanımlanır.
   */
  private async rest<T>(
    method: "GET" | "POST" | "PATCH",
    pathAndQuery: string,
    opts?: {
      body?: Record<string, unknown>;
      opClass?: OperationClass;
      label?: string;
      signal?: AbortSignal;
      /** guarded_create dedup kurtarması — bkz. execute(). */
      recoverUncertain?: () => Promise<RestResult<T> | null>;
    },
  ): Promise<RestResult<T>> {
    return retryingRequest({
      label: opts?.label ?? "query",
      opClass: opts?.opClass ?? "query",
      policy: {
        maxAttempts: this.cfg.retryMaxAttempts,
        baseMs: this.cfg.retryBaseMs,
        capMs: this.cfg.retryCapMs,
      },
      attempt: () => this.sendOnce<T>(method, pathAndQuery, opts?.body, opts?.signal),
      recoverUncertain: opts?.recoverUncertain,
      signal: opts?.signal,
    });
  }

  /**
   * TEK HTTP denemesi. Gaz (throttle) BURADADIR — retry tekrarları dahil her
   * istek aynı kapıdan geçer (reliability.md §4: gaz tek yerde yaşar).
   *
   * Hata modeli üç yola ayrılır:
   *   429 / 5xx / ağ / timeout → XurrentRequestError FIRLATILIR (retry katmanı karar verir)
   *   4xx (429 hariç)          → DEĞERLE döner, errors dolu (kesin-reddedildi;
   *                              422 iş-kuralı reddi de budur — retry katmanına HİÇ girmez)
   *   2xx                      → değerle döner, errors boş
   */
  private async sendOnce<T>(
    method: string,
    pathAndQuery: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<RestResult<T>> {
    const gap = Date.now() - this.lastRequestAt;
    if (gap < this.cfg.minRequestGapMs) await sleep(this.cfg.minRequestGapMs - gap);
    this.lastRequestAt = Date.now();

    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const composed = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(`${this.cfg.restUrl}/${pathAndQuery}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          "X-Xurrent-Account": this.cfg.account, // slug, numerik DEĞİL
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: composed,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeoutSignal.aborted) {
        throw new XurrentRequestError(
          `Xurrent REST isteği ${REQUEST_TIMEOUT_MS / 1000} sn içinde tamamlanmadı (zaman aşımı).`,
          { kind: "timeout" },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new XurrentRequestError(`Ağ hatası: ${msg}`, { kind: "network" });
    }

    this.captureRateLimit(res);

    const text = await res.text().catch(() => "");
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = {};
      }
    }

    if (res.status === 429 || res.status >= 500) {
      // Retry-After saniye cinsindendir (D15 varsayımı) → ms'e çevrilir.
      const rawRetryAfter = res.headers.get("retry-after");
      const retryAfterSec = rawRetryAfter !== null ? Number(rawRetryAfter) : NaN;
      throw new XurrentRequestError(`Xurrent REST HTTP ${res.status}: ${text.slice(0, 500)}`, {
        status: res.status,
        retryAfterMs: Number.isFinite(retryAfterSec) ? Math.max(0, retryAfterSec * 1000) : null,
        kind: "http",
      });
    }

    if (res.status >= 400) {
      // ★ 422 (ve diğer 4xx) FIRLATILMAZ: GraphQL yolunda payload.errors nasıl
      // değerle dönüyorsa burada da öyle. Yapısal olarak retry EDİLEMEZLER.
      return { status: res.status, body: json as T, errors: normalizeRestErrors(json, res.status) };
    }

    return { status: res.status, body: json as T, errors: [] };
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

  /**
   * "$me" → gerçek id. GraphQL'de PersonReferenceFilter "$me"yi sunucu tarafında
   * çözerdi; REST'te böyle bir özel değer YOKTUR — istemci GET /me ile kendisi
   * çözmek zorundadır. Bu, "zengin sorgu dili vs düz kaynak uçları" dersinin
   * küçük ama somut bir bedelidir.
   */
  private async resolveMe(personId: string | undefined, signal?: AbortSignal): Promise<string> {
    if (personId && personId !== "$me") return personId;
    return (await this.whoami(signal)).person.id;
  }

  // ── okuma ─────────────────────────────────────────────────────────────────

  async whoami(signal?: AbortSignal): Promise<WhoamiResult> {
    if (this.whoamiCache) return { ...this.whoamiCache, rateLimit: this.lastRateLimit };

    // ★ GraphQL'de tek sorguydu; REST'te İKİ istek. Ders kontrastının kendisi.
    const me = await this.rest<RestPerson>("GET", "me", { label: "whoami/me", ...(signal ? { signal } : {}) });
    if (me.errors.length) throw new Error(`whoami başarısız: ${me.errors.map((e) => e.message).join("; ")}`);
    const account = await this.rest<{ id?: string; name?: string | null; directory?: boolean | null }>(
      "GET",
      "account",
      { label: "whoami/account", ...(signal ? { signal } : {}) },
    );
    if (account.errors.length)
      throw new Error(`whoami başarısız: ${account.errors.map((e) => e.message).join("; ")}`);

    const result: WhoamiResult = {
      person: personFromRest(me.body),
      account: {
        id: account.body.id ?? this.cfg.account,
        name: account.body.name ?? null,
        directory: account.body.directory ?? null,
      },
      mode: "live",
      rateLimit: this.lastRateLimit,
    };
    this.whoamiCache = result;
    return result;
  }

  async findPerson(email: string, _view: ViewOption, signal?: AbortSignal): Promise<FindPersonResult> {
    // view parametresinin REST karşılığı DOĞRULANMADI — gönderilmez (docs/08).
    const res = await this.rest<RestPerson[]>("GET", `people${qs({ primary_email: email })}`, {
      label: "findPerson",
      ...(signal ? { signal } : {}),
    });
    if (res.errors.length)
      throw new Error(`findPerson başarısız: ${res.errors.map((e) => e.message).join("; ")}`);
    const people = (res.body ?? []).map(personFromRest);
    return {
      totalCount: people.length,
      people,
      // primary_email TAM eşleşmedir; sonuç yoksa serbest metin arama ÖNERİLİR.
      suggestFuzzy: people.length === 0,
    };
  }

  async listOpenWork(args: ListOpenWorkArgs, signal?: AbortSignal): Promise<ListOpenWorkResult> {
    const include = args.include ?? ["requests", "tasks"];
    // "$me" önce GERÇEK id'ye çözülür (GET /me) — REST'te sihirli değer yok.
    const personId = await this.resolveMe(args.personId, signal);

    const empty = { totalCount: 0, hasNextPage: false, endCursor: null, nodes: [] as WorkItem[] };
    const result: ListOpenWorkResult = {
      accountId: this.cfg.account,
      requests: { ...empty },
      tasks: { ...empty },
    };

    if (include.includes("requests")) {
      const res = await this.rest<Array<Record<string, any>>>(
        "GET",
        `requests${qs({ member: personId })}`,
        { label: "openRequests", ...(signal ? { signal } : {}) },
      );
      if (res.errors.length)
        throw new Error(`requests sorgusu başarısız: ${res.errors.map((e) => e.message).join("; ")}`);
      // Açık/kapalı elemesi GraphQL yolundaki gibi CLIENT tarafında da yapılır —
      // sunucu filtresinin varlığı DOĞRULANMADI, çifte eleme zararsızdır.
      const open = (res.body ?? []).filter((n) => !REQUEST_CLOSED.has(String(n["status"])));
      result.requests = {
        totalCount: open.length,
        hasNextPage: false, // REST sayfalaması DOĞRULANMADI; sahte yüzeyde tek sayfa.
        endCursor: null,
        nodes: open.map((n) => ({
          kind: "request" as const,
          id: n["id"],
          displayId: String(n["source_display_id"] ?? ""),
          subject: n["subject"] ?? null,
          status: n["status"] ?? null,
          statusLabel: n["status"] ?? null,
          isOpen: true,
          targetAt: n["next_target_at"] ?? null, // Request → next_target_at
          team: n["team"]?.name ?? null,
          member: n["member"]?.name ?? null,
          parentLabel: null,
          updatedAt: n["updated_at"] ?? null,
        })),
      };
    }

    if (include.includes("tasks")) {
      // ★ Filtre asimetrisi REST'te de yaşar: requests'te "member", tasks'ta "assignee".
      const res = await this.rest<Array<Record<string, any>>>(
        "GET",
        `tasks${qs({ assignee: personId })}`,
        { label: "openTasks", ...(signal ? { signal } : {}) },
      );
      if (res.errors.length)
        throw new Error(`tasks sorgusu başarısız: ${res.errors.map((e) => e.message).join("; ")}`);
      const open = (res.body ?? []).filter((n) => !TASK_CLOSED.has(String(n["status"])));
      result.tasks = {
        totalCount: open.length,
        hasNextPage: false,
        endCursor: null,
        nodes: open.map((n) => ({
          kind: "task" as const,
          id: n["id"],
          displayId: String(n["source_display_id"] ?? ""),
          subject: n["subject"] ?? null,
          status: n["status"] ?? null,
          statusLabel: n["status"] ?? null,
          isOpen: true,
          targetAt: n["completion_target_at"] ?? null, // Task → completion_target_at
          team: n["team"]?.name ?? null,
          member: n["member"]?.name ?? null,
          parentLabel: n["workflow"]?.subject ?? null,
          updatedAt: n["updated_at"] ?? null,
        })),
      };
    }

    return result;
  }

  async getTimeTrackingContext(_personId: string, signal?: AbortSignal): Promise<TimeTrackingContext> {
    if (this.contextCache) return this.contextCache;

    // ★ GraphQL'de TEK sorguydu; REST'te ÜÇ istek. whoami'deki kontrastın büyüğü.
    const sig = signal ? { signal } : {};
    const settings = await this.rest<Array<Record<string, any>>>("GET", "timesheet_settings", {
      label: "context/timesheet_settings",
      ...sig,
    });
    if (settings.errors.length)
      throw new Error(`timesheet bağlamı alınamadı: ${settings.errors.map((e) => e.message).join("; ")}`);
    const classes = await this.rest<Array<Record<string, any>>>("GET", "effort_classes", {
      label: "context/effort_classes",
      ...sig,
    });
    if (classes.errors.length)
      throw new Error(`timesheet bağlamı alınamadı: ${classes.errors.map((e) => e.message).join("; ")}`);
    const allocations = await this.rest<Array<Record<string, any>>>("GET", "time_allocations", {
      label: "context/time_allocations",
      ...sig,
    });
    if (allocations.errors.length)
      throw new Error(`timesheet bağlamı alınamadı: ${allocations.errors.map((e) => e.message).join("; ")}`);

    const s = (settings.body ?? [])[0] ?? {};
    const ecs: EffortClass[] = (classes.body ?? []).map((e) => ({
      id: e["id"],
      name: e["name"] ?? null,
      position: e["position"] ?? null,
      costMultiplier: e["cost_multiplier"] ?? null,
      disabled: e["disabled"] ?? false,
    }));

    const ctx: TimeTrackingContext = {
      unit: s["unit"] ?? null,
      // Değer TAHMİN EDİLMEZ, sorgulanır — GraphQL yolundaki gerekçenin aynısı.
      timeIncrement: s["time_increment"] ?? null,
      workday: s["workday"] ?? null,
      workweek: s["workweek"] ?? null,
      allowWorkdayOvertime: s["allow_workday_overtime"] ?? null,
      allowWorkweekOvertime: s["allow_workweek_overtime"] ?? null,
      allocationTimeTracking: s["allocation_time_tracking"] ?? null,
      assignmentTimeTracking: s["assignment_time_tracking"] ?? null,
      requireNote: s["require_note"] ?? null,
      requireTimeEntryDescription: s["require_time_entry_description"] ?? null,
      // ★ disabled eleme CLIENT tarafında — GraphQL'deki dersle AYNI: sunucu
      // tarafı "disabled" filtresinin varlığı iki yüzeyde de garanti değil.
      effortClasses: ecs.filter((ec) => ec.disabled !== true),
      timeAllocations: (allocations.body ?? []).map((a) => ({
        id: a["id"],
        name: a["name"] ?? null,
        // REST'te group düz string'dir (GraphQL'de group.name idi).
        group: a["group"] ?? null,
        descriptionRequired: a["description_required"] ?? null,
      })),
      defaults: {
        requestEffortClassId: s["request_effort_class"]?.id ?? null,
        taskEffortClassId: s["task_effort_class"]?.id ?? null,
        projectTaskEffortClassId: s["project_task_effort_class"]?.id ?? null,
        problemEffortClassId: s["problem_effort_class"]?.id ?? null,
        timeAllocationEffortClassId: s["time_allocation_effort_class"]?.id ?? null,
      },
    };

    this.contextCache = ctx;
    return ctx;
  }

  async usage(
    personId: string,
    dateISO: string,
    signal?: AbortSignal,
  ): Promise<{ dayMinutes: number; weekMinutes: number }> {
    const weekStart = weekStartISO(dateISO);
    const person = await this.resolveMe(personId, signal);
    // Hafta [weekStart, weekStart+7) — kapalı aralık için son gün weekStart+6.
    const res = await this.rest<Array<Record<string, any>>>(
      "GET",
      `time_entries${qs({ person, date: restDateFilter(weekStart, addDaysISO(weekStart, 6)) })}`,
      { label: "usage", ...(signal ? { signal } : {}) },
    );
    if (res.errors.length) {
      // usage bir ÖN KONTROL girdisidir; sorgu düşerse 0 varsaymak yazmayı
      // yanlışlıkla reddettirmez (workday tavanı sunucuda zaten uygulanır).
      log.warn("usage sorgusu başarısız — 0 varsayıldı", { errors: res.errors.map((e) => e.message) });
      return { dayMinutes: 0, weekMinutes: 0 };
    }
    const weekEnd = addDaysISO(weekStart, 7);
    let day = 0;
    let week = 0;
    for (const n of res.body ?? []) {
      const d = String(n["date"]);
      const m = Number(n["time_spent"] ?? 0);
      if (d === dateISO) day += m;
      if (d >= weekStart && d < weekEnd) week += m;
    }
    return { dayMinutes: day, weekMinutes: week };
  }

  async resolveTargetLabel(targetType: string, targetId: string): Promise<string | null> {
    // GraphQL yolundaki gerekçenin aynısı: etiket için ek istek atılmaz.
    return `${targetType} ${targetId}`;
  }

  async listTimeEntries(args: ListTimeEntriesArgs, signal?: AbortSignal): Promise<ListTimeEntriesPage> {
    const first = args.first ?? 25;
    // person filtresi yalnız verilmişse gönderilir; "$me" çözülür.
    const person = args.personId ? await this.resolveMe(args.personId, signal) : undefined;
    const res = await this.rest<Array<Record<string, any>>>(
      "GET",
      `time_entries${qs({
        person: person ?? null,
        // Operatör değerin içinde: ?date=>=X<=Y (date_from/date_to YOKTUR).
        date: restDateFilter(args.dateFrom, args.dateTo),
        sourceID: args.sourceId ?? null, // ★ camel istisnası burada da geçerli
      })}`,
      { label: "listTimeEntries", ...(signal ? { signal } : {}) },
    );
    if (res.errors.length) {
      throw new Error(`time_entries sorgusu başarısız: ${res.errors.map((e) => e.message).join("; ")}`);
    }
    return {
      accountId: this.cfg.account,
      timeEntries: (res.body ?? []).slice(0, first).map((n) => timeEntryFromRest(n)),
    };
  }

  /**
   * Dedup geri-okuması (reliability.md §5): GET /time_entries?sourceID=.
   * Kendisi query sınıfıdır — geri-okuma 429 yerse retry politikası onu da kurtarır.
   */
  async findTimeEntryBySourceId(sourceID: string, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    if (!sourceID) return null;
    let res: RestResult<Array<Record<string, any>>>;
    try {
      res = await this.rest<Array<Record<string, any>>>("GET", `time_entries${qs({ sourceID })}`, {
        label: "dedupReadback",
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // Fail-open (reliability.md §5): geri-okuma düşerse "kayıt yok" varsayılır.
      log.warn("dedup geri-okuması başarısız — kayıt yok varsayıldı", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (res.errors.length) {
      log.warn("dedup geri-okuması başarısız — kayıt yok varsayıldı", {
        errors: res.errors.map((e) => e.message),
      });
      return null;
    }
    const first = (res.body ?? [])[0];
    return first ? (timeEntryFromRest(first) as unknown as Record<string, unknown>) : null;
  }

  // ── yazma ─────────────────────────────────────────────────────────────────

  /**
   * Planlanan mutation'ları REST karşılıklarına çevirip SIRAYLA çalıştırır.
   * Plan (strategies.ts) transporttan HABERSİZDİR: path + input aynıdır, yalnız
   * wire biçimi değişir. two_step REST'te de aynı derstir:
   *   PATCH /requests/:id → GET /time_entries?person&date=bugün → PATCH /time_entries/:id
   */
  async execute(planned: PlannedMutation[], signal?: AbortSignal): Promise<ExecuteResult> {
    const errors: ValidationError[] = [];
    let timeEntry: Record<string, unknown> | null = null;
    let createdId: string | null = null;
    let executed = 0;

    for (const step of planned) {
      const inner = { ...((step.input["input"] ?? {}) as Record<string, unknown>) };

      // two_step 2. adımı: id 1. adımın yanıtından GELMEZ (parent PATCH yanıtı
      // TimeEntry döndürmez — GraphQL'deki payload kısıtının REST ikizi) →
      // araya bir GET girer ve en yeni kayıt bulunur.
      if (step.path === "timeEntryUpdate" && inner["id"] === PENDING_TIME_ENTRY_ID) {
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

      const opClass = operationClassFor(step.path);
      const sourceID = typeof inner["sourceID"] === "string" ? (inner["sourceID"] as string) : "";

      let res: RestResult<Record<string, any>>;
      try {
        res = await this.dispatchStep(step.path, inner, opClass, sourceID, signal);
      } catch (err) {
        errors.push(this.transportErrorToValidation(step.path, opClass, err));
        break;
      }

      // 422 (ve diğer kesin-red) BURAYA değerle düşer — GraphQL'in payload.errors
      // dalıyla aynı akış: hata raporlanır, retry katmanı hiç görmemiştir.
      if (res.errors.length) {
        errors.push(...res.errors);
        break;
      }

      executed++;
      if (step.path === "timeEntryCreate" || step.path === "timeEntryUpdate") {
        const record = res.recovered
          ? (res.body as unknown as Record<string, unknown>)
          : (timeEntryFromRest(res.body) as unknown as Record<string, unknown>);
        timeEntry = record;
        createdId = String(record["id"]);
      }
      // Parent PATCH yanıtı Request/Task gövdesidir; timeEntry TAŞIMAZ (parite).
    }

    if (executed > 0 && errors.length > 0) {
      log.warn("kısmi başarı: bazı adımlar çalıştı, sonrası başarısız", { executed, errors: errors.length });
    }

    return { timeEntry, errors, executed };
  }

  /** Tek adımın REST çağrısı — endpoint eşlemesi ve snake_case gövde burada. */
  private async dispatchStep(
    path: string,
    inner: Record<string, unknown>,
    opClass: OperationClass,
    sourceID: string,
    signal?: AbortSignal,
  ): Promise<RestResult<Record<string, any>>> {
    const sig = signal ? { signal } : {};

    if (path === "timeEntryCreate") {
      // Yol A: POST /time_entries — 201 beklenir. Alanlar snake_case, sourceID camel.
      // ★ Referans alanları İD'SİZ addır ve düz id taşır: person, effort_class,
      // time_allocation, service, customer (developer.xurrent.com/v1/time_entries
      // POST parametreleri — person_id/effort_class_id DEĞİL).
      const body = compactBody({
        time_spent: inner["timeSpent"],
        date: inner["date"],
        started_at: inner["startedAt"],
        person: inner["personId"],
        time_allocation: inner["timeAllocationId"],
        effort_class: inner["effortClassId"],
        description: inner["description"],
        customer: inner["customerId"],
        service: inner["serviceId"],
        organization: inner["organizationId"],
        team: inner["teamId"],
        correction: inner["correction"] === true ? true : undefined,
        source: inner["source"],
        sourceID: inner["sourceID"],
        // clientMutationId GraphQL kavramıdır — REST'e taşınmaz.
      });
      return this.rest<Record<string, any>>("POST", "time_entries", {
        body,
        opClass,
        label: path,
        ...sig,
        // guarded_create'in belirsiz-hata kurtarması: 5xx/ağ hatasında ÖNCE
        // "yazma aslında ulaştı mı?" sorusu sorulur (GET ?sourceID=). Kayıt
        // varsa retry İPTAL edilir — ikinci POST hiç atılmaz.
        ...(opClass === "guarded_create" && sourceID
          ? {
              recoverUncertain: async (): Promise<RestResult<Record<string, any>> | null> => {
                const found = await this.findTimeEntryBySourceId(sourceID, signal);
                traceDedup(sourceID, found !== null);
                if (!found) return null;
                return { status: 200, body: found as Record<string, any>, errors: [], recovered: true };
              },
            }
          : {}),
      });
    }

    if (path === "timeEntryUpdate") {
      // Path-B telafisi / düzeltme: PATCH /time_entries/:id (mutlak SET).
      // Referans alanları burada da İD'SİZDİR (person, effort_class).
      // two_step 2. adımı description'ı BURADA düzeltir — Yol B'de taşınamayan
      // açıklama nihai kayıtta böylece doğru yerde biter.
      const id = String(inner["id"]);
      const body = compactBody({
        time_spent: inner["timeSpent"],
        date: inner["date"],
        started_at: inner["startedAt"],
        person: inner["personId"],
        description: inner["description"],
        effort_class: inner["effortClassId"],
        // source/sourceID two_step 2. adımında yazılır — dedup kimliği burada doğar.
        source: inner["source"],
        sourceID: inner["sourceID"],
      });
      return this.rest<Record<string, any>>("PATCH", `time_entries/${encodeURIComponent(id)}`, {
        body,
        opClass,
        label: path,
        ...sig,
      });
    }

    const collection = PARENT_COLLECTION[path];
    if (collection) {
      // Yol B: PATCH /requests|tasks/:id — time_spent ARTIMLIDIR, date=bugün,
      // person=authenticated user (kontrol EDİLEMEZ). GraphQL ile aynı ders.
      // ★ Parametreler: time_spent + time_spent_effort_class (İD'SİZ) + note
      // (developer.xurrent.com/v1/requests). time_entry_description diye bir
      // REST parametresi YOKTUR — açıklama Yol B'de time entry'ye taşınamaz.
      const id = String(inner["id"]);
      const desc = typeof inner["timeEntryDescription"] === "string" ? inner["timeEntryDescription"] : null;
      const note = typeof inner["note"] === "string" && inner["note"] ? (inner["note"] as string) : null;
      let mergedNote = note;
      if (desc) {
        // Açıklama kaybolmasın diye note'a doğal bir önekle düşürülür.
        mergedNote = note ? `${note}\n\nZaman girişi açıklaması: ${desc}` : `Zaman girişi açıklaması: ${desc}`;
        log.warn(
          "REST Yol B'de açıklama time entry'ye taşınamaz; note'a yazıldı — two_step 2. adım düzeltir",
          { path, description: desc },
        );
      }
      const body = compactBody({
        time_spent: inner["timeSpent"],
        time_spent_effort_class: inner["timeSpentEffortClassId"],
        note: mergedNote,
      });
      return this.rest<Record<string, any>>("PATCH", `${collection}/${encodeURIComponent(id)}`, {
        body,
        opClass,
        label: path,
        ...sig,
      });
    }

    throw new Error(`Bilinmeyen mutation path'i REST'e çevrilemedi: ${path}`);
  }

  /** two_step ara sorgusunun REST hâli: bugünün en yeni kaydı (liste yeniden-eskiye gelir). */
  private async findLatestTimeEntryId(signal?: AbortSignal): Promise<string | null> {
    const person = await this.resolveMe("$me", signal);
    const res = await this.rest<Array<Record<string, any>>>(
      "GET",
      `time_entries${qs({ person, date: todayISO(this.cfg.timeZone) })}`,
      { label: "latestTimeEntry", ...(signal ? { signal } : {}) },
    );
    if (res.errors.length) return null;
    const first = (res.body ?? [])[0];
    return first ? String(first["id"]) : null;
  }

  /**
   * Retry katmanından KAÇAN transport hatası → kullanıcıya dönecek hata.
   * live.ts'teki metnin AYNISI — kullanıcıya görünen sözleşme transporttan bağımsız.
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
