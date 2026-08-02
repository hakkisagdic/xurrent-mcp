/**
 * Mock takvim sağlayıcısı — fixtures/calendar.json.
 *
 * Fixture'da MUTLAK TARİH YOKTUR: her etkinlik dayOffset (bugüne göre gün farkı) +
 * startLocal/endLocal ("HH:mm") taşır. Materyalizasyon kuralı üç dilde de aynıdır:
 *     instant = zonedDateTime(today + dayOffset, startLocal, timeZone)
 * Böylece demo hangi gün çalıştırılırsa çalıştırılsın aynı senaryo üretilir.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CalendarProvider } from "../types.js";
import { addDaysISO, todayISO, zonedToInstant } from "../util/time.js";
import type { RawEvent } from "./types.js";

interface MockEvent {
  id: string;
  iCalUID: string;
  title: string;
  dayOffset: number;
  startLocal: string;
  endLocal: string;
  isAllDay: boolean;
  isCancelled: boolean;
  declined: boolean;
  free: boolean;
  organizer: string | null;
  attendeeCount: number;
  categories: string[];
  seriesId: string | null;
  joinUrl: string | null;
}

interface MockCalendarFile {
  timeZone: string;
  owner: string;
  events: MockEvent[];
}

export function loadMockCalendar(fixturesDir: string): MockCalendarFile {
  const raw = readFileSync(join(fixturesDir, "calendar.json"), "utf8");
  return JSON.parse(raw) as MockCalendarFile;
}

export function mockEvents(fixturesDir: string, timeZone: string, now = new Date()): RawEvent[] {
  const file = loadMockCalendar(fixturesDir);
  const today = todayISO(timeZone, now);
  const source: CalendarProvider = "mock";

  return file.events.map((ev) => {
    const dateISO = addDaysISO(today, ev.dayOffset);
    const start = zonedToInstant(dateISO, ev.startLocal, timeZone);

    // Tüm gün etkinliği: end = ERTESİ günün yerel gece yarısı (exclusive end date).
    // Fixture'da endLocal "00:00" verilir; naif bir "end - start" hesabı 0 dakika
    // üretirdi. Her iki gerçek API de bu etkinliği [bugün, yarın) olarak döner.
    const end = ev.isAllDay
      ? zonedToInstant(addDaysISO(dateISO, 1), "00:00", timeZone)
      : zonedToInstant(dateISO, ev.endLocal, timeZone);

    return {
      source,
      id: ev.id,
      iCalUID: ev.iCalUID,
      title: ev.title,
      start,
      end,
      isAllDay: ev.isAllDay,
      isCancelled: ev.isCancelled,
      declined: ev.declined,
      free: ev.free,
      organizer: ev.organizer,
      attendeeCount: ev.attendeeCount,
      categories: ev.categories ?? [],
      seriesId: ev.seriesId,
      joinUrl: ev.joinUrl,
    } satisfies RawEvent;
  });
}
