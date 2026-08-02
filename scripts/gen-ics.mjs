#!/usr/bin/env node
// -----------------------------------------------------------------------------
// gen-ics.mjs — fixtures/calendar.json → fixtures/calendar.ics
//
// NEDEN bu script var: fixture'lardaki tarihler GÖRELİDİR (dayOffset: 0 = bugün,
// -1 = dün). Demo hangi gün çalıştırılırsa çalışsın aynı dersi versin diye.
// Ama `.ics` GERÇEK bir dosya formatıdır ve göreli tarih taşıyamaz — her VEVENT
// mutlak bir DTSTART içermek zorundadır. Bu yüzden .ics dosyası, sunumdan önce
// O ANKİ tarihe göre yeniden üretilir.
//
// Üretilen dosya .gitignore'dadır: kaynak calendar.json'dur, .ics türevdir.
//
// Kullanım:
//   node scripts/gen-ics.mjs [--out <yol>] [--date YYYY-MM-DD] [--tz <IANA>]
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ── Argümanlar ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(name + "="));
  return inline ? inline.slice(name.length + 1) : fallback;
}

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    [
      "",
      "gen-ics.mjs — fixtures/calendar.json dosyasından geçerli bir iCalendar (.ics) üretir.",
      "",
      "KULLANIM",
      "  node scripts/gen-ics.mjs [seçenekler]",
      "",
      "SEÇENEKLER",
      "  --in   <yol>         Kaynak JSON (varsayılan: fixtures/calendar.json)",
      "  --out  <yol>         Hedef .ics (varsayılan: fixtures/calendar.ics)",
      "  --date <YYYY-MM-DD>  'Bugün' kabul edilecek tarih (test için; varsayılan: gerçek bugün)",
      "  --tz   <IANA>        Saat dilimi (varsayılan: calendar.json içindeki, yoksa Europe/Istanbul)",
      "  --print              Dosyaya yazmadan çıktıyı ekrana basar",
      "",
      "NE ZAMAN ÇALIŞTIRILIR",
      "  Takvim sağlayıcısı 'ics' ile test edilecekse ve sunumdan hemen önce bir kez.",
      "  Fixture tarihleri göreli olduğu için dünkü .ics dosyası YANLIŞ günü gösterir.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const IN = path.resolve(opt("--in", path.join(ROOT, "fixtures", "calendar.json")));
const OUT = path.resolve(opt("--out", path.join(ROOT, "fixtures", "calendar.ics")));
const PRINT_ONLY = argv.includes("--print");

if (!existsSync(IN)) {
  process.stderr.write(`HATA: kaynak bulunamadı: ${IN}\n`);
  process.exit(1);
}

const src = JSON.parse(readFileSync(IN, "utf8"));
const TZ = opt("--tz", process.env.XURRENT_TIMEZONE || src.timeZone || "Europe/Istanbul");

// ── Tarih yardımcıları ───────────────────────────────────────────────────────
function ymdInTz(date, tz) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Bir YEREL gün için UTC offset'i, "+03:00" biçiminde.
function tzOffsetFor(iso, tz) {
  const [y, m, d] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(
    probe,
  );
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const mm = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!mm) return "+00:00";
  return `${mm[1]}${String(mm[2]).padStart(2, "0")}:${mm[3] ?? "00"}`;
}

const TODAY = opt("--date", ymdInTz(new Date(), TZ));
if (!/^\d{4}-\d{2}-\d{2}$/.test(TODAY)) {
  process.stderr.write(`HATA: --date değeri YYYY-MM-DD olmalı, gelen: ${TODAY}\n`);
  process.exit(1);
}

// ── iCalendar biçimlendirme ──────────────────────────────────────────────────
// RFC 5545 §3.3.11 — metin değerlerinde \ ; , ve satır sonu KAÇIRILIR.
function esc(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// RFC 5545 §3.1 — satırlar 75 OKTET'i geçemez; devam satırları BOŞLUKLA başlar.
// Karakter değil OKTET sayılır: "ş" 2 bayttır, Türkçe içerikte fark yaratır.
function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // UTF-8 devam baytının (10xxxxxx) ortasından kesme.
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push((start === 0 ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74; // devam satırlarında baştaki boşluk da 1 oktettir
  }
  return out.join("\r\n");
}

const lines = [];
const put = (l) => lines.push(fold(l));

// ── VTIMEZONE ────────────────────────────────────────────────────────────────
// Zonun DST kullanıp kullanmadığını Ocak/Temmuz offset'lerini karşılaştırarak
// tespit ediyoruz. Europe/Istanbul 2016'dan beri KALICI +03'tür (DST yok), bu
// yüzden tek bir STANDARD bileşeni yeterlidir ve doğrudur.
const year = Number(TODAY.slice(0, 4));
const janOff = tzOffsetFor(`${year}-01-15`, TZ);
const julOff = tzOffsetFor(`${year}-07-15`, TZ);
const compact = (off) => off.replace(":", ""); // "+03:00" → "+0300"

// TZNAME olarak offset kısaltması kullanılır ("+03"). Intl'in "short" adı
// ("GMT+3") iCalendar okuyucularında standart değildir; gerçek takvim
// dosyaları Europe/Istanbul için "+03" yazar.
function tzShortName(iso) {
  const off = tzOffsetFor(iso, TZ); // "+03:00"
  return off.endsWith(":00") ? off.slice(0, 3) : off.replace(":", "");
}

put("BEGIN:VCALENDAR");
put("VERSION:2.0");
put("PRODID:-//xurrent-mcp//gen-ics.mjs//TR");
put("CALSCALE:GREGORIAN");
put("METHOD:PUBLISH");
put(`X-WR-CALNAME:${esc(`xurrent-mcp demo takvimi (${src.owner ?? ""})`)}`);
put(`X-WR-TIMEZONE:${TZ}`);

put("BEGIN:VTIMEZONE");
put(`TZID:${TZ}`);
if (janOff === julOff) {
  // DST yok — tek, sabit STANDARD bileşeni.
  put("BEGIN:STANDARD");
  put("DTSTART:19700101T000000");
  put(`TZOFFSETFROM:${compact(janOff)}`);
  put(`TZOFFSETTO:${compact(janOff)}`);
  put(`TZNAME:${esc(tzShortName(`${year}-01-15`))}`);
  put("END:STANDARD");
} else {
  // DST var. Geçiş kuralı AB standardına göre yazılır (Mart'ın son Pazar'ı /
  // Ekim'in son Pazar'ı). Offset değerleri her zaman doğrudur; kural yalnızca
  // Avrupa zonları için birebir tutar — bu proje Europe/Istanbul kullanır.
  const stdOff = janOff;
  const dstOff = julOff;
  put("BEGIN:DAYLIGHT");
  put("DTSTART:19700329T020000");
  put("RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU");
  put(`TZOFFSETFROM:${compact(stdOff)}`);
  put(`TZOFFSETTO:${compact(dstOff)}`);
  put(`TZNAME:${esc(tzShortName(`${year}-07-15`))}`);
  put("END:DAYLIGHT");
  put("BEGIN:STANDARD");
  put("DTSTART:19701025T030000");
  put("RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU");
  put(`TZOFFSETFROM:${compact(dstOff)}`);
  put(`TZOFFSETTO:${compact(stdOff)}`);
  put(`TZNAME:${esc(tzShortName(`${year}-01-15`))}`);
  put("END:STANDARD");
}
put("END:VTIMEZONE");

// ── VEVENT'ler ───────────────────────────────────────────────────────────────
const DTSTAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const owner = src.owner ?? "user@example.com";
let count = 0;
let allDayCount = 0;
let declinedCount = 0;
let freeCount = 0;

for (const ev of src.events ?? []) {
  const date = addDaysISO(TODAY, ev.dayOffset ?? 0);
  const localDate = date.replace(/-/g, "");

  put("BEGIN:VEVENT");
  put(`UID:${esc(ev.iCalUID ?? `${ev.id}@xurrent-mcp`)}`);
  put(`DTSTAMP:${DTSTAMP}`);
  put(`SEQUENCE:0`);

  if (ev.isAllDay) {
    // TÜM GÜN ETKİNLİĞİ — süresi instant farkından HESAPLANMAZ.
    // iCalendar (ve hem Graph hem Google) EXCLUSIVE bitiş tarihi kullanır:
    // tek günlük bir etkinlikte DTEND = ertesi gündür.
    allDayCount++;
    put(`DTSTART;VALUE=DATE:${localDate}`);
    put(`DTEND;VALUE=DATE:${addDaysISO(date, 1).replace(/-/g, "")}`);
    put("X-MICROSOFT-CDO-ALLDAYEVENT:TRUE");
  } else {
    const s = (ev.startLocal ?? "00:00").replace(":", "");
    const e = (ev.endLocal ?? "00:00").replace(":", "");
    // TZID'li yerel saat: "09:00'da başlar" demek; UTC'ye çevirmek DST günlerinde
    // sessizce yanlış instant üretir. Bu yüzden yerel saat + TZID yazıyoruz.
    put(`DTSTART;TZID=${TZ}:${localDate}T${s}00`);
    put(`DTEND;TZID=${TZ}:${localDate}T${e}00`);
  }

  put(`SUMMARY:${esc(ev.title ?? "(başlıksız)")}`);
  // free → TRANSPARENT: takvimde yer kaplar ama MEŞGUL saymaz.
  // Graph'te showAs='free', Google'da transparency='transparent' karşılığıdır.
  put(`TRANSP:${ev.free ? "TRANSPARENT" : "OPAQUE"}`);
  put(`STATUS:${ev.isCancelled ? "CANCELLED" : "CONFIRMED"}`);
  if (ev.free) freeCount++;

  if (ev.organizer) put(`ORGANIZER;CN=${esc(ev.organizer)}:mailto:${ev.organizer}`);

  if (ev.declined) {
    // REDDEDİLEN toplantı takvimde DURMAYA devam eder. Sunucu tarafında filtre
    // yoktur; ics okuyucusu kendi adresini ATTENDEE listesinde bulup
    // PARTSTAT=DECLINED olup olmadığına BAKMAK zorundadır.
    declinedCount++;
    put(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=DECLINED;CN=${esc(owner)}:mailto:${owner}`);
  } else if (!ev.isAllDay) {
    put(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=${esc(owner)}:mailto:${owner}`);
  }

  if (Array.isArray(ev.categories) && ev.categories.length) {
    put(`CATEGORIES:${ev.categories.map(esc).join(",")}`);
  }
  if (ev.joinUrl) put(`URL;VALUE=URI:${ev.joinUrl}`);
  if (ev.seriesId) put(`X-XURRENT-SERIES-ID:${esc(ev.seriesId)}`);
  if (typeof ev.attendeeCount === "number") put(`X-XURRENT-ATTENDEE-COUNT:${ev.attendeeCount}`);
  put(`X-XURRENT-EVENT-ID:${esc(ev.id ?? "")}`);

  put("END:VEVENT");
  count++;
}

put("END:VCALENDAR");

// RFC 5545: satır sonu CRLF'tir ve dosya CRLF ile biter.
const ics = lines.join("\r\n") + "\r\n";

if (PRINT_ONLY) {
  process.stdout.write(ics);
} else {
  writeFileSync(OUT, ics, "utf8");
  process.stdout.write(
    [
      `✔ ${OUT} üretildi`,
      `  kaynak            : ${IN}`,
      `  saat dilimi       : ${TZ}  (offset ${tzOffsetFor(TODAY, TZ)}, DST ${janOff === julOff ? "yok" : "var"})`,
      `  'bugün' kabul     : ${TODAY}`,
      `  VEVENT sayısı     : ${count}  (tüm gün: ${allDayCount}, reddedilen: ${declinedCount}, free: ${freeCount})`,
      `  bayt              : ${Buffer.byteLength(ics, "utf8")}`,
      "",
      "  Test: CALENDAR_PROVIDER=ics ile sunucuyu çalıştır; calendar_list_today aynı",
      "  sayıları üretmelidir (rawCount=8, count=5, busyMinutes=225).",
      "",
    ].join("\n"),
  );
}
