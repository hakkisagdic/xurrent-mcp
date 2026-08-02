/**
 * Takvim cephesi: sağlayıcı seçimi + ortak normalizasyon.
 *
 * Pencere HER ZAMAN yerel gece yarısından ertesi yerel gece yarısına kurulur ve
 * offset gömülü gönderilir. "Bugünün takvimi" cümlesi ancak bir saat dilimiyle
 * birlikte anlamlıdır — sunucunun saat dilimi ASLA varsayılmaz.
 */

import { existsSync } from "node:fs";
import type { AppConfig } from "../config.js";
import type { CalendarDayResult, CalendarProvider, CalendarProviderOption, Meeting } from "../types.js";
import { log } from "../util/log.js";
import { addDaysISO, todayISO, toOffsetISO, zonedToInstant } from "../util/time.js";
import { googleEvents } from "./google.js";
import { graphEvents } from "./graph.js";
import { icsEvents } from "./ics.js";
import { mockEvents } from "./mock.js";
import {
  dedupeEvents,
  mergedBusyMinutes,
  naiveSumMinutes,
  realMeetings,
  toMeeting,
  type FilterOptions,
  type RawEvent,
  type Window,
} from "./types.js";

export interface CalendarQuery {
  provider: CalendarProviderOption;
  userEmail?: string | undefined;
  date?: string | undefined;
  timeZone?: string | undefined;
  includeAllDay?: boolean | undefined;
  includeDeclined?: boolean | undefined;
  includeFree?: boolean | undefined;
}

/** İstenen günün YEREL gece yarısından ertesi YEREL gece yarısına kadar. */
export function buildWindow(dateISO: string, timeZone: string): Window {
  return {
    start: zonedToInstant(dateISO, "00:00", timeZone),
    end: zonedToInstant(addDaysISO(dateISO, 1), "00:00", timeZone),
  };
}

async function fetchRaw(
  cfg: AppConfig,
  provider: CalendarProvider,
  win: Window,
  timeZone: string,
  userEmail: string | undefined,
  signal?: AbortSignal,
): Promise<RawEvent[]> {
  switch (provider) {
    case "mock":
      return mockEvents(cfg.fixturesDir, timeZone);
    case "ics":
      return icsEvents({ path: cfg.icsPath, url: cfg.icsUrl }, timeZone, signal);
    case "google":
      return googleEvents(cfg, win, userEmail, signal);
    case "graph":
      return graphEvents(cfg, win, userEmail, signal);
  }
}

/**
 * auto: graph → google → ics → mock. İlk çalışan kazanır; sebebi stderr'e yazılır.
 * Zinciri yapılandırmanın GERÇEKTEN mümkün kıldığı sağlayıcılarla sınırlarız:
 * var olmayan bir .ics dosyasını denemek her çağrıda gereksiz bir hata üretirdi.
 */
function autoChain(cfg: AppConfig): CalendarProvider[] {
  const chain: CalendarProvider[] = [];
  if (cfg.ms.tenantId && cfg.ms.clientId && cfg.ms.clientSecret) chain.push("graph");
  if ((cfg.google.clientId && cfg.google.clientSecret) || cfg.google.saClientEmail) chain.push("google");
  if (cfg.icsUrl || (cfg.icsPath && existsSync(cfg.icsPath))) chain.push("ics");
  chain.push("mock");
  return chain;
}

export async function listDay(
  cfg: AppConfig,
  query: CalendarQuery,
  signal?: AbortSignal,
): Promise<CalendarDayResult> {
  const timeZone = query.timeZone || cfg.timeZone;
  const dateISO = query.date || todayISO(timeZone);
  const win = buildWindow(dateISO, timeZone);

  const opts: FilterOptions = {
    includeAllDay: query.includeAllDay ?? false,
    includeDeclined: query.includeDeclined ?? false,
    includeFree: query.includeFree ?? false,
  };

  const requested = query.provider === "auto" ? "auto" : query.provider;
  const candidates: CalendarProvider[] =
    requested === "auto" ? autoChain(cfg) : [requested as CalendarProvider];

  let raw: RawEvent[] | null = null;
  let used: CalendarProvider = "mock";
  let lastError: unknown = null;

  for (const p of candidates) {
    try {
      raw = await fetchRaw(cfg, p, win, timeZone, query.userEmail, signal);
      used = p;
      break;
    } catch (err) {
      lastError = err;
      log.warn(`takvim sağlayıcısı "${p}" başarısız, sıradakine geçiliyor`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!raw) {
    throw new Error(
      `Hiçbir takvim sağlayıcısı çalışmadı. Son hata: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
  }

  // 1) Pencere ile ÇAKIŞANLARI al (içinde olanları değil).
  //    Dün 23:00 → bugün 01:00 toplantısı da gelir; süresi sonra pencereye kırpılır.
  const inWindow = raw.filter(
    (ev) => ev.end.getTime() > win.start.getTime() && ev.start.getTime() < win.end.getTime(),
  );

  // 2) Dedup: iCalUID + start instant.
  const unique = dedupeEvents(inWindow);

  // 3) Normalizasyon + eleme gerekçeleri.
  const meetings: Meeting[] = unique
    .map((ev) => toMeeting(ev, win, opts, timeZone))
    .sort((a, b) => a.start.localeCompare(b.start));

  const real = realMeetings(meetings);

  // busyMinutes: interval merge → çakışmalar BİR KEZ.
  const busy = mergedBusyMinutes(real.map((m) => ({ start: new Date(m.start), end: new Date(m.end) })));
  // naiveSumMinutes: kasıtlı olarak "yanlış" toplam — farkı göstermek dersin parçası.
  const naive = naiveSumMinutes(real);

  return {
    windowStart: toOffsetISO(win.start, timeZone),
    windowEnd: toOffsetISO(win.end, timeZone),
    timeZone,
    provider: used,
    meetings,
    totals: {
      count: real.length,
      busyMinutes: busy,
      naiveSumMinutes: naive,
      rawCount: meetings.length,
      filteredOut: meetings.length - real.length,
    },
  };
}
