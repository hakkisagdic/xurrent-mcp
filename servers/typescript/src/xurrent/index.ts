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
  TimeTrackingContext,
  ValidationError,
  ViewOption,
  WhoamiResult,
  XurrentMode,
} from "../types.js";
import { LiveXurrentAdapter } from "./live.js";
import { MockXurrentAdapter } from "./mock.js";

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

export interface XurrentAdapter {
  readonly mode: XurrentMode;
  whoami(signal?: AbortSignal): Promise<WhoamiResult>;
  findPerson(email: string, view: ViewOption, signal?: AbortSignal): Promise<FindPersonResult>;
  listOpenWork(args: ListOpenWorkArgs, signal?: AbortSignal): Promise<ListOpenWorkResult>;
  getTimeTrackingContext(personId: string, signal?: AbortSignal): Promise<TimeTrackingContext>;
  /** Ön kontrol için: hedef tarihte/haftada o kişiye ait mevcut dakika toplamları. */
  usage(personId: string, dateISO: string, signal?: AbortSignal): Promise<{ dayMinutes: number; weekMinutes: number }>;
  /** Planlanan mutation'ları SIRAYLA çalıştırır. Atomik DEĞİLDİR. */
  execute(planned: PlannedMutation[], signal?: AbortSignal): Promise<ExecuteResult>;
  /** İnsan-okunur hedef etiketi (uyarı metinleri ve onay diyaloğu için). */
  resolveTargetLabel(targetType: string, targetId: string, signal?: AbortSignal): Promise<string | null>;
}

let cached: { key: string; adapter: XurrentAdapter } | null = null;

export function createXurrentAdapter(cfg: AppConfig): XurrentAdapter {
  const key = `${cfg.mode}|${cfg.fixturesDir}|${cfg.graphqlUrl}|${cfg.account}`;
  if (cached && cached.key === key) return cached.adapter;
  const adapter: XurrentAdapter =
    cfg.mode === "live" ? new LiveXurrentAdapter(cfg) : new MockXurrentAdapter(cfg);
  cached = { key, adapter };
  return adapter;
}

export function resetAdapterCache(): void {
  cached = null;
}
