/**
 * ★ SAAT DİLİMİ VE GÖRELİ TARİH YARDIMCILARININ BİRİM TESTİ.
 *
 * NE KANITLIYOR: "bugün" bir saat dilimiyle birlikte anlamlıdır ve bu repodaki
 * göreli fixture sözleşmesi (dayOffset + startLocal) enjekte edilebilir bir
 * "şimdi" ile deterministik çalışır.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ BU DOSYANIN VAROLUŞ SEBEBİ — GECE KIRILAN TEST
 *
 * Yerel saat 00:00–03:00 arasındayken (Europe/Istanbul = UTC+03) UTC TARİHİ
 * BİR GÜN GERİDEDİR. new Date().toISOString().slice(0,10) ile todayISO(tz)
 * O SAATLERDE FARKLI DEĞER DÖNER. Gerçek zamana bağlı bir test gündüz geçer,
 * gece 00:00–03:00 arasında kırılır — bu repoda tam olarak bu yaşandı.
 *
 * Çözüm: "şimdi" ASLA new Date() değil, ENJEKTE edilen SABIT_SIMDI'dir.
 * Aşağıdaki testler bunu hem doğrular hem de kural olarak sabitler.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  addDaysISO,
  diffDaysISO,
  formatOffset,
  localDateISO,
  localTimeHHmm,
  minutesBetween,
  offsetMinutes,
  offsetStringForDate,
  toOffsetISO,
  todayISO,
  weekStartISO,
  zonedParts,
  zonedToInstant,
} from "../../dist/util/time.js";
import { mockEvents } from "../../dist/calendar/mock.js";
import { FIXTURES_DIR, SABIT_SIMDI, SABIT_YEREL_TARIH, TZ } from "../_testkit.mjs";

// ═════════════════════════════════════════════════════════════════════════════
// ★ GECE YARISI TUZAĞI
// ═════════════════════════════════════════════════════════════════════════════

test("★ yerel 01:30'da (UTC 22:30) YEREL TARİH, UTC tarihinden BİR GÜN İLERİDEDİR", () => {
  // SABIT_SIMDI = 2026-08-03T22:30:00Z → Europe/Istanbul'da 2026-08-04 01:30
  assert.equal(SABIT_SIMDI.toISOString().slice(0, 10), "2026-08-03", "UTC tarihi");
  assert.equal(todayISO(TZ, SABIT_SIMDI), "2026-08-04", "yerel tarih");
  assert.notEqual(
    todayISO(TZ, SABIT_SIMDI),
    SABIT_SIMDI.toISOString().slice(0, 10),
    "toISOString().slice(0,10) 'bugün' DEĞİLDİR — testin gece kırılmasının sebebi tam olarak budur",
  );
});

test("★ aynı an, üç dilimde ÜÇ farklı yerel tarih verebilir", () => {
  assert.equal(todayISO("Europe/Istanbul", SABIT_SIMDI), "2026-08-04");
  assert.equal(todayISO("UTC", SABIT_SIMDI), "2026-08-03");
  assert.equal(todayISO("America/New_York", SABIT_SIMDI), "2026-08-03");
});

test("★ negatif offsetli dilimde tuzak TERS yönde çalışır (yerel 21:00, UTC ertesi gün)", () => {
  const an = new Date("2026-08-05T01:00:00Z"); // New York: 04 Ağustos 21:00
  assert.equal(todayISO("America/New_York", an), "2026-08-04");
  assert.equal(an.toISOString().slice(0, 10), "2026-08-05");
});

test("todayISO enjekte edilen 'şimdi' olmadan da çalışır ama testler ASLA öyle kullanmaz", () => {
  // Sadece imzayı doğruluyoruz; değeri iddia etmiyoruz — çünkü gerçek zamana bağlı olurdu.
  assert.match(todayISO(TZ), /^\d{4}-\d{2}-\d{2}$/);
});

// ═════════════════════════════════════════════════════════════════════════════
// Göreli tarih materyalizasyonu (fixtures/README.md sözleşmesi)
// ═════════════════════════════════════════════════════════════════════════════

test("★ dayOffset + startLocal → instant: fixture 09:00 toplantısı YEREL 09:00'dur, UTC 09:00 değil", () => {
  const olaylar = mockEvents(FIXTURES_DIR, TZ, SABIT_SIMDI);
  const standup = olaylar.find((e) => e.id === "evt-001");
  assert.equal(standup.start.toISOString(), "2026-08-04T06:00:00.000Z", "yerel 09:00 = UTC 06:00 (+03)");
  assert.equal(localTimeHHmm(standup.start, TZ), "09:00");
  assert.equal(localDateISO(standup.start, TZ), SABIT_YEREL_TARIH);
});

test("★ gece 01:30'da çalıştırıldığında dayOffset=0 YEREL bugüne düşer (UTC dününe DEĞİL)", () => {
  const olaylar = mockEvents(FIXTURES_DIR, TZ, SABIT_SIMDI);
  const standup = olaylar.find((e) => e.id === "evt-001");
  assert.equal(localDateISO(standup.start, TZ), "2026-08-04");
  assert.notEqual(localDateISO(standup.start, TZ), "2026-08-03");
});

test("dayOffset=-1 etkinliği yerel DÜNE materyalize olur", () => {
  const olaylar = mockEvents(FIXTURES_DIR, TZ, SABIT_SIMDI);
  const dun = olaylar.find((e) => e.id === "evt-101");
  assert.equal(localDateISO(dun.start, TZ), "2026-08-03");
  assert.equal(localTimeHHmm(dun.start, TZ), "11:00");
});

test("tüm gün etkinliği [bugün, yarın) olarak materyalize olur (exclusive end date)", () => {
  const olaylar = mockEvents(FIXTURES_DIR, TZ, SABIT_SIMDI);
  const dogumGunu = olaylar.find((e) => e.id === "evt-008");
  assert.equal(dogumGunu.isAllDay, true);
  assert.equal(localDateISO(dogumGunu.start, TZ), "2026-08-04");
  assert.equal(localDateISO(dogumGunu.end, TZ), "2026-08-05");
  assert.equal(minutesBetween(dogumGunu.start, dogumGunu.end), 1440);
});

test("★ materyalizasyon 'şimdi'ye göre KAYAR — demo hangi gün çalışırsa çalışsın senaryo aynıdır", () => {
  const noel = new Date("2026-12-25T09:00:00Z");
  const olaylar = mockEvents(FIXTURES_DIR, TZ, noel);
  const standup = olaylar.find((e) => e.id === "evt-001");
  assert.equal(localDateISO(standup.start, TZ), "2026-12-25");
  assert.equal(localTimeHHmm(standup.start, TZ), "09:00", "yerel saat DST'den bağımsız olarak sabit kalır");
});

// ═════════════════════════════════════════════════════════════════════════════
// zonedToInstant / offset
// ═════════════════════════════════════════════════════════════════════════════

test("zonedToInstant yerel saati doğru instant'a çevirir (+03:00)", () => {
  assert.equal(zonedToInstant("2026-08-04", "09:00", TZ).toISOString(), "2026-08-04T06:00:00.000Z");
  assert.equal(zonedToInstant("2026-08-04", "00:00", TZ).toISOString(), "2026-08-03T21:00:00.000Z");
});

test("★ zonedToInstant DST sınırının iki yakasında FARKLI offset kullanır (Europe/Berlin)", () => {
  // AB'de yaz saati 2026'da 29 Mart'ta başlar.
  assert.equal(offsetStringForDate("2026-03-28", "Europe/Berlin"), "+01:00");
  assert.equal(offsetStringForDate("2026-03-29", "Europe/Berlin"), "+02:00");
  assert.equal(zonedToInstant("2026-03-28", "12:00", "Europe/Berlin").toISOString(), "2026-03-28T11:00:00.000Z");
  assert.equal(zonedToInstant("2026-03-29", "12:00", "Europe/Berlin").toISOString(), "2026-03-29T10:00:00.000Z");
});

test("offsetMinutes DST'ye göre değişir (America/New_York: kış -300, yaz -240)", () => {
  assert.equal(offsetMinutes(new Date("2026-01-15T17:00:00Z"), "America/New_York"), -300);
  assert.equal(offsetMinutes(new Date("2026-07-15T17:00:00Z"), "America/New_York"), -240);
});

test("yarım/çeyrek saatlik offsetler doğru biçimlenir (Asia/Kathmandu +05:45)", () => {
  assert.equal(offsetStringForDate("2026-08-04", "Asia/Kathmandu"), "+05:45");
  assert.equal(formatOffset(345), "+05:45");
  assert.equal(formatOffset(-330), "-05:30");
  assert.equal(formatOffset(0), "+00:00");
});

test("zonedParts gece yarısını 24 değil 00 olarak verir (hourCycle h23)", () => {
  const p = zonedParts(zonedToInstant("2026-08-04", "00:00", TZ), TZ);
  assert.equal(p.hour, 0, "h12 kullanılsaydı 24 gelir ve gün sınırı bir gün kayardı");
  assert.equal(p.day, 4);
});

test("★ toOffsetISO ASLA çıplak timestamp üretmez — offset her zaman gömülüdür", () => {
  const s = toOffsetISO(new Date("2026-08-04T06:00:00Z"), TZ);
  assert.equal(s, "2026-08-04T09:00:00+03:00");
  assert.match(s, /[Zz]$|[+-]\d{2}:\d{2}$/);
});

test("toOffsetISO UTC'de '+00:00' yazar", () => {
  assert.equal(toOffsetISO(new Date("2026-08-04T06:00:00Z"), "UTC"), "2026-08-04T06:00:00+00:00");
});

// ═════════════════════════════════════════════════════════════════════════════
// Takvim aritmetiği — saat diliminden BAĞIMSIZ
// ═════════════════════════════════════════════════════════════════════════════

test("addDaysISO ay ve yıl sınırlarını doğru geçer", () => {
  assert.equal(addDaysISO("2026-08-31", 1), "2026-09-01");
  assert.equal(addDaysISO("2026-03-01", -1), "2026-02-28");
  assert.equal(addDaysISO("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysISO("2026-08-04", 0), "2026-08-04");
});

test("addDaysISO artık yılı bilir (2028 şubat 29 çeker)", () => {
  assert.equal(addDaysISO("2028-02-28", 1), "2028-02-29");
  assert.equal(addDaysISO("2028-03-01", -1), "2028-02-29");
});

test("addDaysISO DST geçiş günlerinde de tam gün ekler (saat aritmetiği DEĞİL)", () => {
  assert.equal(addDaysISO("2026-03-28", 1), "2026-03-29");
  assert.equal(addDaysISO("2026-10-24", 1), "2026-10-25");
});

test("diffDaysISO pozitif = geçmiş (a - b)", () => {
  assert.equal(diffDaysISO("2026-08-04", "2026-08-02"), 2);
  assert.equal(diffDaysISO("2026-08-04", "2026-08-04"), 0);
  assert.equal(diffDaysISO("2026-08-04", "2026-08-05"), -1);
  assert.equal(diffDaysISO("2026-03-30", "2026-03-28"), 2, "DST geçişi gün sayısını bozmamalı");
});

test("weekStartISO haftayı PAZARTESİ'den başlatır (pazar aynı haftadadır)", () => {
  assert.equal(weekStartISO("2026-08-03"), "2026-08-03", "pazartesi kendisi");
  assert.equal(weekStartISO("2026-08-04"), "2026-08-03", "salı");
  assert.equal(weekStartISO("2026-08-09"), "2026-08-03", "pazar — ABD tarzı hafta olsaydı yeni hafta sayılırdı");
  assert.equal(weekStartISO("2026-08-10"), "2026-08-10", "sonraki pazartesi");
});

test("minutesBetween tam sayıya yuvarlar ve negatif olabilir", () => {
  assert.equal(minutesBetween(new Date("2026-08-04T06:00:00Z"), new Date("2026-08-04T07:30:00Z")), 90);
  assert.equal(minutesBetween(new Date("2026-08-04T07:00:00Z"), new Date("2026-08-04T06:00:00Z")), -60);
  assert.equal(minutesBetween(new Date("2026-08-04T06:00:00Z"), new Date("2026-08-04T06:00:29Z")), 0);
});
