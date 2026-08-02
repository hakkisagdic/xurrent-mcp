/**
 * Saat dilimi yardımcıları.
 *
 * NEDEN elle yazılıyor: bu proje kasıtlı olarak bağımlılık-fakiridir (SDK + zod dışında
 * hiçbir runtime paketi yok). Node 24'te Intl API'si IANA saat dilimlerini tam destekler;
 * luxon/date-fns-tz'ye ihtiyaç yoktur. Aynı hesaplama Python'da zoneinfo, C#'ta
 * TimeZoneInfo ile yapılır — üç dil de AYNI yerel saati üretmek zorundadır.
 *
 * TEMEL KURAL: Bir "instant" (Date) mutlak bir andır. "Yerel saat" ise bir instant'ın
 * belirli bir saat diliminde nasıl göründüğüdür. İkisini karıştırmak takvim
 * entegrasyonlarındaki bir numaralı hata kaynağıdır.
 */

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>();
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // hourCycle h23 ŞART: h12 kullanılırsa gece yarısı "24" olarak gelir ve
      // gün sınırı hesapları bir gün kayar.
      hourCycle: "h23",
    });
    partsFormatterCache.set(timeZone, f);
  }
  return f;
}

function offsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = offsetFormatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormatterCache.set(timeZone, f);
  }
  return f;
}

/** Bir instant'ın verilen saat dilimindeki takvim parçaları. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const map: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(instant)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map["year"]),
    month: Number(map["month"]),
    day: Number(map["day"]),
    hour: Number(map["hour"]),
    minute: Number(map["minute"]),
    second: Number(map["second"]),
  };
}

/** O instant'ta geçerli UTC offset'i, DAKİKA cinsinden (Europe/Istanbul → 180). */
export function offsetMinutes(instant: Date, timeZone: string): number {
  const part = offsetFormatter(timeZone)
    .formatToParts(instant)
    .find((p) => p.type === "timeZoneName");
  const value = part?.value ?? "GMT+00:00";
  // "GMT" (offset 0) veya "GMT+03:00" / "GMT-05:30" biçimleri gelir.
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(value);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? "0"));
}

/** 180 → "+03:00". ISO8601 timestamp'lerde offset ZORUNLUDUR. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** Verilen tarihteki (yerel) UTC offset'i, "+03:00" biçiminde. */
export function offsetStringForDate(dateISO: string, timeZone: string): string {
  const instant = zonedToInstant(dateISO, "12:00", timeZone); // öğle: DST sınırlarından uzak
  return formatOffset(offsetMinutes(instant, timeZone));
}

/**
 * Yerel tarih+saati mutlak instant'a çevirir.
 *
 * NEDEN döngü var: offset'i bilmek için instant'a, instant'ı bulmak için offset'e
 * ihtiyaç var — tavuk-yumurta. İki iterasyon DST geçişleri dahil her durumda yakınsar.
 */
export function zonedToInstant(dateISO: string, timeLocal: string, timeZone: string): Date {
  const [y, mo, d] = dateISO.split("-").map(Number);
  const [hh, mm] = timeLocal.split(":").map(Number);
  const asUtc = Date.UTC(y!, (mo ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0);
  let ts = asUtc;
  for (let i = 0; i < 3; i++) {
    const off = offsetMinutes(new Date(ts), timeZone);
    const next = asUtc - off * 60_000;
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/** Instant → "YYYY-MM-DD" (verilen saat diliminde). */
export function localDateISO(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Instant → "HH:mm" (verilen saat diliminde). */
export function localTimeHHmm(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/**
 * Instant → "YYYY-MM-DDTHH:mm:ss+03:00".
 * Sözleşme gereği çıplak timestamp ASLA üretilmez; offset her zaman gömülüdür.
 */
export function toOffsetISO(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  const off = formatOffset(offsetMinutes(instant, timeZone));
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${off}`;
}

/** "YYYY-MM-DD" + gün → "YYYY-MM-DD" (takvim aritmetiği, saat dilimi bağımsız). */
export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const t = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  t.setUTCDate(t.getUTCDate() + days);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** İki "YYYY-MM-DD" arasındaki gün farkı (a - b). */
export function diffDaysISO(a: string, b: string): number {
  const toUtc = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
}

/** Bugünün tarihi, verilen saat diliminde. */
export function todayISO(timeZone: string, now: Date = new Date()): string {
  return localDateISO(now, timeZone);
}

/** Haftanın başlangıcı (Pazartesi), "YYYY-MM-DD". Workweek kontrolü için. */
export function weekStartISO(dateISO: string): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const t = new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1));
  const dow = (t.getUTCDay() + 6) % 7; // Pazartesi = 0
  return addDaysISO(dateISO, -dow);
}

/**
 * Microsoft Graph dateTime alanını ayrıştırır.
 *
 * TUZAK: Graph'in dateTime alanı OFFSET TAŞIMAZ ve 7 kesirli hane içerir
 * ("2026-08-02T09:00:00.0000000"). new Date(...) bunu doğrudan yerse
 * SUNUCUNUN yerel saati sanar ve gün sessizce kayar.
 * Doğrusu: kesirli haneyi 3'e indir ve "Z" ekle — çünkü calendarView'ı
 * Prefer başlığı GÖNDERMEDEN çağırdığımızda Graph her zaman UTC döner.
 */
export function parseGraphDateTime(dateTime: string, timeZoneHint?: string | null): Date {
  const normalized = dateTime.replace(/(\.\d{3})\d+$/, "$1");
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(normalized);
  if (hasZone) return new Date(normalized);
  if (timeZoneHint && timeZoneHint.toUpperCase() !== "UTC") {
    // Graph "outlook.timezone" ile başka bir dilim döndürdüyse yerel kabul edip çeviririz.
    const [datePart, timePart = "00:00:00"] = normalized.split("T");
    return zonedToInstant(datePart!, timePart.slice(0, 5), timeZoneHint);
  }
  return new Date(normalized + "Z");
}

/** İki instant arası dakika (tam sayıya yuvarlanır). */
export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}
