#!/usr/bin/env node
/**
 * fixtures/calendar.json → fixtures/calendar.ics
 *
 * NEDEN GEREKLİ: .ics GERÇEK bir dosya formatıdır ve GÖRELİ TARİH TAŞIYAMAZ.
 * Fixture'lardaki dayOffset ("0 = bugün") kavramı bir dosyaya yazılamaz; bu yüzden
 * .ics dosyası çalıştırma anındaki tarihe göre YENİDEN ÜRETİLİR.
 * Sunumdan hemen önce bir kez çalıştırmak yeterlidir.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadMockCalendar } from "./calendar/mock.js";
import { addDaysISO, todayISO, zonedToInstant } from "./util/time.js";

/** ICS "floating"/UTC damgası: 20260802T090000Z */
function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsDate(dateISO: string): string {
  return dateISO.replace(/-/g, "");
}

/** RFC 5545: virgül, noktalı virgül, ters bölü ve satır sonu KAÇIRILIR. */
function esc(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** 75 oktetten uzun satırlar katlanır (folding) — aksi halde bazı parser'lar reddeder. */
function fold(line: string): string {
  if (line.length <= 73) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 73));
  rest = rest.slice(73);
  while (rest.length > 72) {
    parts.push(" " + rest.slice(0, 72));
    rest = rest.slice(72);
  }
  if (rest.length) parts.push(" " + rest);
  return parts.join("\r\n");
}

function main(): void {
  const cfg = loadConfig();
  const file = loadMockCalendar(cfg.fixturesDir);
  const tz = file.timeZone || cfg.timeZone;
  const today = todayISO(tz);

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//xurrent-mcp//gen-ics//TR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(file.owner ?? "xurrent-mcp demo")}`,
    `X-WR-TIMEZONE:${tz}`,
  ];

  const now = new Date();
  for (const ev of file.events) {
    const dateISO = addDaysISO(today, ev.dayOffset);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.iCalUID}`);
    lines.push(`DTSTAMP:${icsStamp(now)}`);

    if (ev.isAllDay) {
      // Tüm gün etkinliği DATE değeriyle ve EXCLUSIVE end date ile yazılır.
      lines.push(`DTSTART;VALUE=DATE:${icsDate(dateISO)}`);
      lines.push(`DTEND;VALUE=DATE:${icsDate(addDaysISO(dateISO, 1))}`);
    } else {
      lines.push(`DTSTART:${icsStamp(zonedToInstant(dateISO, ev.startLocal, tz))}`);
      lines.push(`DTEND:${icsStamp(zonedToInstant(dateISO, ev.endLocal, tz))}`);
    }

    lines.push(fold(`SUMMARY:${esc(ev.title)}`));
    if (ev.isCancelled) lines.push("STATUS:CANCELLED");
    // TRANSP:TRANSPARENT = "meşgul değil" (Graph showAs=free / Google transparency).
    lines.push(`TRANSP:${ev.free ? "TRANSPARENT" : "OPAQUE"}`);
    if (ev.organizer) lines.push(`ORGANIZER:mailto:${ev.organizer}`);
    if (ev.categories?.length) lines.push(fold(`CATEGORIES:${ev.categories.map(esc).join(",")}`));
    // ICS'te "sahibin bu daveti reddettiği" bilgisi standart bir alanla taşınmaz;
    // demo verisini kayıpsız aktarmak için özel bir X- alanı kullanıyoruz.
    lines.push(`X-XURRENT-DECLINED:${ev.declined ? "TRUE" : "FALSE"}`);
    lines.push(`X-XURRENT-ATTENDEECOUNT:${ev.attendeeCount ?? 0}`);
    if (ev.seriesId) lines.push(`X-XURRENT-SERIES:${ev.seriesId}`);
    if (ev.joinUrl) lines.push(fold(`X-XURRENT-JOINURL:${ev.joinUrl}`));
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  const target = join(cfg.fixturesDir, "calendar.ics");
  // ICS satır sonu CRLF'tir — LF yazan üreticiler bazı takvim uygulamalarında bozulur.
  writeFileSync(target, lines.join("\r\n") + "\r\n", "utf8");
  process.stdout.write(`calendar.ics üretildi: ${target}\n  ${file.events.length} etkinlik, referans gün: ${today} (${tz})\n`);
}

main();
