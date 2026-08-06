/**
 * XurrentAdapter arayüzü + mode'a göre factory.
 *
 * Tool'lar ASLA doğrudan HTTP yapmaz; hepsi bu arayüzü konuşur. Böylece
 * "mock mod" bir demo hilesi değil, birinci sınıf bir çalışma modu olur —
 * ders token'sız, internetsiz, deterministik çalışır.
 */

import type { AppConfig } from "../config.js";
import type {
  FindPersonResult,
  ListOpenWorkResult,
  PlannedMutation,
  TimeEntryRecord,
  TimeTrackingContext,
  ValidationError,
  ViewOption,
  WhoamiResult,
  XurrentMode,
} from "../types.js";
import { LiveXurrentAdapter } from "./live.js";
import { MockXurrentAdapter } from "./mock.js";
import { RestXurrentAdapter } from "./rest.js";

export interface ListOpenWorkArgs {
  personId?: string;
  include?: Array<"requests" | "tasks">;
  first?: number;
  afterRequests?: string;
  afterTasks?: string;
  view?: ViewOption;
}

export interface ExecuteResult {
  timeEntry: Record<string, unknown> | null;
  errors: ValidationError[];
  /** Kaç adım GERÇEKTEN çalıştı — kısmi başarıyı raporlamak için gerekli. */
  executed: number;
}

export interface ListTimeEntriesArgs {
  /** Kişi (opak id ya da "$me"). */
  personId?: string;
  /** Bu tarihten itibaren (dahil), YYYY-MM-DD. */
  dateFrom?: string;
  /** Bu tarihe kadar (dahil), YYYY-MM-DD. */
  dateTo?: string;
  /** İdempotency anahtarıyla nokta arama (dedup geri-okuması). */
  sourceId?: string;
  first?: number;
}

/** listTimeEntries'in adapter tarafı — totalMinutes ÇEKİRDEKTE hesaplanır (tek yer). */
export interface ListTimeEntriesPage {
  accountId: string;
  timeEntries: TimeEntryRecord[];
}

export interface XurrentAdapter {
  readonly mode: XurrentMode;
  whoami(signal?: AbortSignal): Promise<WhoamiResult>;
  findPerson(email: string, view: ViewOption, signal?: AbortSignal): Promise<FindPersonResult>;
  listOpenWork(args: ListOpenWorkArgs, signal?: AbortSignal): Promise<ListOpenWorkResult>;
  getTimeTrackingContext(personId: string, signal?: AbortSignal): Promise<TimeTrackingContext>;
  /** Ön kontrol için: hedef tarihte/haftada o kişiye ait mevcut dakika toplamları. */
  usage(personId: string, dateISO: string, signal?: AbortSignal): Promise<{ dayMinutes: number; weekMinutes: number }>;
  /**
   * Dedup geri-okuması (contract/reliability.md §5): deterministik sourceID ile
   * mevcut TimeEntry aranır. Bulunursa kayıt, bulunmazsa null döner.
   * Yazma-öncesi dedup ve guarded_create'in belirsiz-hata kurtarması buna dayanır.
   */
  findTimeEntryBySourceId(sourceID: string, signal?: AbortSignal): Promise<Record<string, unknown> | null>;
  /**
   * Yazılmış zaman girişlerini okur (contract #9 — xurrent_list_time_entries).
   * "query" sınıfıdır: yan etkisiz, retry politikasıyla serbestçe tekrarlanır.
   */
  listTimeEntries(args: ListTimeEntriesArgs, signal?: AbortSignal): Promise<ListTimeEntriesPage>;
  /** Planlanan mutation'ları SIRAYLA çalıştırır. Atomik DEĞİLDİR. */
  execute(planned: PlannedMutation[], signal?: AbortSignal): Promise<ExecuteResult>;
  /** İnsan-okunur hedef etiketi (uyarı metinleri ve onay diyaloğu için). */
  resolveTargetLabel(targetType: string, targetId: string, signal?: AbortSignal): Promise<string | null>;
}

let cached: { key: string; adapter: XurrentAdapter } | null = null;

export function createXurrentAdapter(cfg: AppConfig): XurrentAdapter {
  // api + restUrl anahtara DAHİLDİR: transport değişince adapter da değişmeli.
  const key = `${cfg.mode}|${cfg.api}|${cfg.fixturesDir}|${cfg.graphqlUrl}|${cfg.restUrl}|${cfg.account}`;
  if (cached && cached.key === key) return cached.adapter;
  // live modda transport seçimi (.env.example §1): graphql (varsayılan) | rest.
  // İkisi de AYNI arayüzü konuşur — tool'lar farkı GÖRMEZ (docs/16'nın tezi).
  const adapter: XurrentAdapter =
    cfg.mode === "live"
      ? cfg.api === "rest"
        ? new RestXurrentAdapter(cfg)
        : new LiveXurrentAdapter(cfg)
      : new MockXurrentAdapter(cfg);
  cached = { key, adapter };
  return adapter;
}

export function resetAdapterCache(): void {
  cached = null;
}
