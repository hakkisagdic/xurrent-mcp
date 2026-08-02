/**
 * Takvim normalizasyonu — dersin "gerçek dünya dağınık" bölümü.
 *
 * Buradaki kurallar sağlayıcıdan BAĞIMSIZDIR: Graph, Google ve ICS adapter'ları
 * kendi alanlarını RawEvent şekline çevirir, geri kalan her şey ortaktır.
 * Böylece "hangi toplantı gerçek?" sorusunun cevabı TEK bir yerde yaşar.
 */

import type { CalendarProvider, Meeting } from "../types.js";
import { minutesBetween, toOffsetISO } from "../util/time.js";

/** Sağlayıcıların ortak paydası — her adapter kendi alanlarını buna çevirir. */
export interface RawEvent {
  source: CalendarProvider;
  id: string;
  /** iCalUID. TEK BAŞINA dedup anahtarı DEĞİLDİR (aşağıya bak). */
  iCalUID: string;
  title: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  isCancelled: boolean;
  declined: boolean;
  /** showAs=free (Graph) veya transparency=transparent (Google). */
  free: boolean;
  organizer: string | null;
  attendeeCount: number;
  categories: string[];
  seriesId: string | null;
  joinUrl: string | null;
}

export interface FilterOptions {
  includeAllDay: boolean;
  includeDeclined: boolean;
  includeFree: boolean;
}

export interface Window {
  start: Date;
  end: Date;
}

/**
 * Bir etkinliğin GERÇEK toplantı sayılıp sayılmadığı.
 * skipReason Türkçe ve ÖĞRETİCİdir — kullanıcı neden elendiğini görmeli.
 */
export function evaluateSkip(ev: RawEvent, opts: FilterOptions): string | null {
  if (ev.isCancelled) {
    return "İptal edilmiş etkinlik — takvimde durur ama çalışılmamıştır.";
  }
  if (ev.declined && !opts.includeDeclined) {
    return "Reddedilmiş toplantı — her iki sağlayıcı da reddedilenleri döndürmeye devam eder; sunucu tarafında filtre YOKTUR.";
  }
  if (ev.isAllDay && !opts.includeAllDay) {
    return "Tüm gün etkinliği — süresi instant'lardan HESAPLANMAZ (her iki API de exclusive end date kullanır).";
  }
  if (ev.free && !opts.includeFree) {
    return "Meşgul değil (Graph: showAs=free, Google: transparency=transparent) — takvimde yer kaplar ama çalışma değildir.";
  }
  return null;
}

/**
 * Dedup anahtarı.
 *
 * TUZAK: iCalUID tek başına YETMEZ.
 *   - Microsoft Graph'te calendarView her occurrence için FARKLI bir iCalUID döner.
 *   - Google'da singleEvents=true ile seri boyunca AYNI iCalUID gelir.
 * İki davranışı da aynı anahtarla ele almanın tek yolu start instant'ı eklemektir.
 */
export function dedupeKey(iCalUID: string, start: Date): string {
  return `${iCalUID}|${start.toISOString()}`;
}

/**
 * Pencereye kırp.
 *
 * TUZAK: Sağlayıcı filtresi bir OVERLAP filtresidir — dün 23:00'te başlayıp bugün
 * 01:00'de biten toplantı da döner. Süreyi ham instant'lardan hesaplarsan
 * o toplantının DÜNKÜ kısmını da bugüne yazarsın.
 */
export function clipToWindow(start: Date, end: Date, win: Window): { start: Date; end: Date } {
  const s = start.getTime() < win.start.getTime() ? win.start : start;
  const e = end.getTime() > win.end.getTime() ? win.end : end;
  return { start: s, end: e.getTime() < s.getTime() ? s : e };
}

/** RawEvent → sözleşmedeki Meeting. */
export function toMeeting(
  ev: RawEvent,
  win: Window,
  opts: FilterOptions,
  timeZone: string,
): Meeting {
  const skipReason = evaluateSkip(ev, opts);
  const clipped = clipToWindow(ev.start, ev.end, win);

  // Tüm gün etkinliği: start = yerel gece yarısı, end = ERTESİ gün gece yarısı
  // (exclusive end date). Süresini "instant farkı" olarak raporlarız ama
  // zaman girişine ASLA çevrilmez — bu yüzden zaten skipped'tır.
  const minutes = Math.max(0, minutesBetween(clipped.start, clipped.end));

  return {
    source: ev.source,
    id: ev.id,
    uid: dedupeKey(ev.iCalUID, ev.start),
    title: ev.title,
    start: toOffsetISO(clipped.start, timeZone),
    end: toOffsetISO(clipped.end, timeZone),
    minutes,
    isAllDay: ev.isAllDay,
    isCancelled: ev.isCancelled,
    declined: ev.declined,
    free: ev.free,
    skipped: skipReason !== null,
    skipReason,
    organizer: ev.organizer,
    attendeeCount: ev.attendeeCount,
    categories: ev.categories,
    seriesId: ev.seriesId,
    joinUrl: ev.joinUrl,
  };
}

/** Aynı uid'ye sahip etkinlikleri teke indirir (sıra korunur). */
export function dedupeEvents(events: RawEvent[]): RawEvent[] {
  const seen = new Set<string>();
  const out: RawEvent[] = [];
  for (const ev of events) {
    const key = dedupeKey(ev.iCalUID, ev.start);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

/**
 * ÇAKIŞMALARI BİR KEZ sayan meşgul süre (interval merge).
 *
 * Naif toplam (her toplantının süresini toplamak) çakışan toplantılarda
 * FAZLA zaman yazdırır. Ders bu farkı ikisini birden raporlayarak gösterir.
 */
export function mergedBusyMinutes(intervals: Array<{ start: Date; end: Date }>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  let total = 0;
  let curStart = sorted[0]!.start.getTime();
  let curEnd = sorted[0]!.end.getTime();
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i]!.start.getTime();
    const e = sorted[i]!.end.getTime();
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    }
  }
  total += curEnd - curStart;
  return Math.round(total / 60_000);
}

/** Naif toplam — çakışmaları AYRI sayar. Kasıtlı olarak yanlış; farkı göstermek için. */
export function naiveSumMinutes(meetings: Meeting[]): number {
  return meetings.reduce((acc, m) => acc + m.minutes, 0);
}

/** Sözleşmede meetings dizisi elenenleri de İÇERİR — skipReason öğreticidir. */
export function realMeetings(meetings: Meeting[]): Meeting[] {
  return meetings.filter((m) => !m.skipped);
}
