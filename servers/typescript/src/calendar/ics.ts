/**
 * ICS (iCalendar) sağlayıcısı — dosya veya yayınlanmış URL.
 *
 * Minimal ama doğru bir ayrıştırıcı: RFC 5545'in tamamı değil, bir takvim
 * dışa aktarımını okumak için gereken alt kümesi.
 *
 * ICS'in ders açısından önemi: .ics GÖRELİ TARİH TAŞIYAMAZ. Bu yüzden
 * fixtures/calendar.ics dosyası calendar.json'dan `npm run gen:ics` ile
 * o anki tarihe göre yeniden üretilir. Bir dosya formatının "bugün" kavramı yoktur.
 */

import { readFileSync } from "node:fs";
import type { CalendarProvider } from "../types.js";
import { zonedToInstant } from "../util/time.js";
import type { RawEvent } from "./types.js";

/** Katlanmış (folded) satırları birleştirir — RFC 5545 satırları 75 oktette böler. */
function unfold(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseProp(line: string): IcsProp | null {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = left.split(";");
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: (name ?? "").toUpperCase(), params, value };
}

function unescapeText(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** DTSTART/DTEND değerini instant'a çevirir. */
function parseIcsDate(prop: IcsProp, fallbackZone: string): { instant: Date; dateOnly: boolean } {
  const v = prop.value.trim();
  const tzid = prop.params["TZID"];

  // VALUE=DATE → tüm gün (YYYYMMDD)
  if (prop.params["VALUE"] === "DATE" || /^\d{8}$/.test(v)) {
    const dateISO = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    return { instant: zonedToInstant(dateISO, "00:00", tzid ?? fallbackZone), dateOnly: true };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return { instant: new Date(v), dateOnly: false };

  const dateISO = `${m[1]}-${m[2]}-${m[3]}`;
  const timeLocal = `${m[4]}:${m[5]}`;

  if (m[7] === "Z") {
    // UTC — doğrudan parse edilebilir.
    return { instant: new Date(`${dateISO}T${m[4]}:${m[5]}:${m[6]}Z`), dateOnly: false };
  }
  // TZID varsa o dilimde, yoksa "floating time" → yapılandırılmış dilimde yorumlanır.
  return { instant: zonedToInstant(dateISO, timeLocal, tzid ?? fallbackZone), dateOnly: false };
}

export function parseIcs(text: string, fallbackZone: string): RawEvent[] {
  const source: CalendarProvider = "ics";
  const lines = unfold(text);
  const events: RawEvent[] = [];

  let current: Partial<RawEvent> & { _dtstart?: Date; _dtend?: Date; _dateOnly?: boolean } | null = null;

  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) {
      current = { source, categories: [], attendeeCount: 0 };
      continue;
    }
    if (line.startsWith("END:VEVENT")) {
      if (current && current._dtstart) {
        const start = current._dtstart;
        const end = current._dtend ?? new Date(start.getTime() + 30 * 60_000);
        events.push({
          source,
          id: current.id ?? current.iCalUID ?? `ics-${events.length}`,
          iCalUID: current.iCalUID ?? current.id ?? `ics-${events.length}`,
          title: current.title ?? "(başlıksız)",
          start,
          end,
          isAllDay: current._dateOnly ?? false,
          isCancelled: current.isCancelled ?? false,
          declined: current.declined ?? false,
          free: current.free ?? false,
          organizer: current.organizer ?? null,
          attendeeCount: current.attendeeCount ?? 0,
          categories: current.categories ?? [],
          seriesId: current.seriesId ?? null,
          joinUrl: current.joinUrl ?? null,
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const prop = parseProp(line);
    if (!prop) continue;

    switch (prop.name) {
      case "UID":
        current.iCalUID = prop.value.trim();
        current.id = prop.value.trim();
        break;
      case "SUMMARY":
        current.title = unescapeText(prop.value);
        break;
      case "DTSTART": {
        const r = parseIcsDate(prop, fallbackZone);
        current._dtstart = r.instant;
        current._dateOnly = r.dateOnly;
        break;
      }
      case "DTEND": {
        const r = parseIcsDate(prop, fallbackZone);
        current._dtend = r.instant;
        break;
      }
      case "STATUS":
        // STATUS:CANCELLED tek başına iptal göstergesidir.
        if (prop.value.trim().toUpperCase() === "CANCELLED") current.isCancelled = true;
        break;
      case "TRANSP":
        // TRANSP:TRANSPARENT = "meşgul değil". Google'ın transparency alanının ICS karşılığı.
        current.free = prop.value.trim().toUpperCase() === "TRANSPARENT";
        break;
      case "ORGANIZER":
        current.organizer = prop.value.replace(/^mailto:/i, "").trim();
        break;
      case "ATTENDEE": {
        current.attendeeCount = (current.attendeeCount ?? 0) + 1;
        // PARTSTAT=DECLINED → kullanıcı reddetmiş. ICS'te katılımcı bazlıdır;
        // sahibin kaydını ayırt edemediğimiz için herhangi bir DECLINED'ı işaretleriz.
        if ((prop.params["PARTSTAT"] ?? "").toUpperCase() === "DECLINED") current.declined = true;
        break;
      }
      case "CATEGORIES":
        current.categories = prop.value.split(",").map((s) => unescapeText(s.trim())).filter(Boolean);
        break;
      case "RECURRENCE-ID":
      case "RRULE":
        current.seriesId = current.iCalUID ?? null;
        break;
      case "X-XURRENT-DECLINED":
        current.declined = prop.value.trim().toUpperCase() === "TRUE";
        break;
      case "X-XURRENT-SERIES":
        current.seriesId = prop.value.trim() || null;
        break;
      case "URL":
      case "X-MICROSOFT-ONLINEMEETINGCONFERENCEID":
        if (!current.joinUrl && /^https?:/i.test(prop.value)) current.joinUrl = prop.value.trim();
        break;
      case "X-XURRENT-JOINURL":
        current.joinUrl = prop.value.trim() || null;
        break;
      case "X-XURRENT-ATTENDEECOUNT":
        current.attendeeCount = Number(prop.value.trim()) || 0;
        break;
      default:
        break;
    }
  }

  return events;
}

export async function icsEvents(
  opts: { path: string; url: string },
  fallbackZone: string,
  signal?: AbortSignal,
): Promise<RawEvent[]> {
  if (opts.url) {
    const res = await fetch(opts.url, { signal });
    if (!res.ok) throw new Error(`ICS URL okunamadı: HTTP ${res.status}`);
    return parseIcs(await res.text(), fallbackZone);
  }
  return parseIcs(readFileSync(opts.path, "utf8"), fallbackZone);
}
