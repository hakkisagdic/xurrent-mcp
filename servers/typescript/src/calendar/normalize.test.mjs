/**
 * ★ TAKVİM NORMALİZASYONUNUN BİRİM TESTİ.
 *
 * NE KANITLIYOR: "hangi etkinlik gerçek toplantı?" ve "kaç dakika meşguldüm?"
 * sorularının cevabı sağlayıcıdan bağımsız, tek bir yerde ve ÖLÇÜLEBİLİR.
 *
 * Bu testlerde ağ YOKTUR: Graph/Google adapter'larının HTTP kısmı değil,
 * MAP kısmı (mapGraphEvent / mapGoogleEvent) çağrılır. Tuzaklar orada yaşar.
 *
 * "Şimdi" her yerde SABIT_SIMDI'dir (bkz. _testkit.mjs) — mock takvim göreli
 * tarihlerle çalıştığı için sabit bir an olmadan test gündüz geçer, gece kırılır.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  clipToWindow,
  dedupeEvents,
  dedupeKey,
  evaluateSkip,
  mergedBusyMinutes,
  naiveSumMinutes,
  realMeetings,
  toMeeting,
} from "../../dist/calendar/types.js";
import { buildWindow } from "../../dist/calendar/index.js";
import { mockEvents } from "../../dist/calendar/mock.js";
import { mapGraphEvent } from "../../dist/calendar/graph.js";
import { mapGoogleEvent } from "../../dist/calendar/google.js";
import { parseGraphDateTime, todayISO } from "../../dist/util/time.js";
import { FIXTURES_DIR, SABIT_SIMDI, SABIT_YEREL_TARIH, TZ, fixture } from "../_testkit.mjs";

const HEPSI_KAPALI = { includeAllDay: false, includeDeclined: false, includeFree: false };

function ham(over = {}) {
  return {
    source: "mock",
    id: "e1",
    iCalUID: "uid-1@ornek.com",
    title: "Toplantı",
    start: new Date("2026-08-04T06:00:00Z"),
    end: new Date("2026-08-04T07:00:00Z"),
    isAllDay: false,
    isCancelled: false,
    declined: false,
    free: false,
    organizer: null,
    attendeeCount: 0,
    categories: [],
    seriesId: null,
    joinUrl: null,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Atlama kuralları — her biri farklı bir gerçek dünya kuralı
// ─────────────────────────────────────────────────────────────────────────────

test("normal toplantı ATLANMAZ (skipReason null)", () => {
  assert.equal(evaluateSkip(ham(), HEPSI_KAPALI), null);
});

test("★ isCancelled → atlanır ve gerekçe 'iptal' der (includeDeclined bile kurtaramaz)", () => {
  const sebep = evaluateSkip(ham({ isCancelled: true }), {
    includeAllDay: true,
    includeDeclined: true,
    includeFree: true,
  });
  assert.ok(sebep && sebep.includes("İptal"), `gerekçe: ${sebep}`);
});

test("★ declined → atlanır; includeDeclined=true ile atlanmaz", () => {
  assert.ok(evaluateSkip(ham({ declined: true }), HEPSI_KAPALI)?.includes("Reddedilmiş"));
  assert.equal(evaluateSkip(ham({ declined: true }), { ...HEPSI_KAPALI, includeDeclined: true }), null);
});

test("★ isAllDay → atlanır; includeAllDay=true ile atlanmaz", () => {
  assert.ok(evaluateSkip(ham({ isAllDay: true }), HEPSI_KAPALI)?.includes("Tüm gün"));
  assert.equal(evaluateSkip(ham({ isAllDay: true }), { ...HEPSI_KAPALI, includeAllDay: true }), null);
});

test("★ free → atlanır; includeFree=true ile atlanmaz", () => {
  assert.ok(evaluateSkip(ham({ free: true }), HEPSI_KAPALI)?.includes("Meşgul değil"));
  assert.equal(evaluateSkip(ham({ free: true }), { ...HEPSI_KAPALI, includeFree: true }), null);
});

test("toMeeting atlanan etkinliği skipped=true + skipReason DOLU olarak işaretler", () => {
  const win = buildWindow(SABIT_YEREL_TARIH, TZ);
  const m = toMeeting(ham({ free: true }), win, HEPSI_KAPALI, TZ);
  assert.equal(m.skipped, true);
  assert.ok(typeof m.skipReason === "string" && m.skipReason.length > 0);
});

test("realMeetings yalnızca atlanmayanları döndürür ama liste atlananları da TAŞIR", () => {
  const win = buildWindow(SABIT_YEREL_TARIH, TZ);
  const hepsi = [ham(), ham({ id: "e2", iCalUID: "uid-2", declined: true })].map((e) =>
    toMeeting(e, win, HEPSI_KAPALI, TZ),
  );
  assert.equal(hepsi.length, 2, "atlananlar çıktıdan SİLİNMEZ — skipReason öğreticidir");
  assert.equal(realMeetings(hepsi).length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) busyMinutes — çakışan aralıklar BİR KEZ
// ─────────────────────────────────────────────────────────────────────────────

const aralik = (s, e) => ({ start: new Date(s), end: new Date(e) });

test("mergedBusyMinutes boş listede 0 döner", () => {
  assert.equal(mergedBusyMinutes([]), 0);
});

test("mergedBusyMinutes çakışmayan iki aralığı TOPLAR", () => {
  const v = mergedBusyMinutes([
    aralik("2026-08-04T06:00:00Z", "2026-08-04T06:30:00Z"),
    aralik("2026-08-04T07:00:00Z", "2026-08-04T08:00:00Z"),
  ]);
  assert.equal(v, 90);
});

test("★ mergedBusyMinutes çakışan aralığı BİR KEZ sayar (10:00-11:00 + 10:30-11:30 = 90, 120 değil)", () => {
  const v = mergedBusyMinutes([
    aralik("2026-08-04T07:00:00Z", "2026-08-04T08:00:00Z"),
    aralik("2026-08-04T07:30:00Z", "2026-08-04T08:30:00Z"),
  ]);
  assert.equal(v, 90);
});

test("mergedBusyMinutes tamamen içine düşen aralığı yutar", () => {
  const v = mergedBusyMinutes([
    aralik("2026-08-04T06:00:00Z", "2026-08-04T09:00:00Z"),
    aralik("2026-08-04T07:00:00Z", "2026-08-04T07:30:00Z"),
  ]);
  assert.equal(v, 180);
});

test("mergedBusyMinutes girdi sırasından BAĞIMSIZDIR", () => {
  const a = aralik("2026-08-04T07:30:00Z", "2026-08-04T08:30:00Z");
  const b = aralik("2026-08-04T07:00:00Z", "2026-08-04T08:00:00Z");
  assert.equal(mergedBusyMinutes([a, b]), mergedBusyMinutes([b, a]));
});

test("mergedBusyMinutes girdi dizisini MUTASYONA UĞRATMAZ", () => {
  const list = [
    aralik("2026-08-04T07:30:00Z", "2026-08-04T08:30:00Z"),
    aralik("2026-08-04T07:00:00Z", "2026-08-04T08:00:00Z"),
  ];
  const once = list.map((i) => i.start.toISOString()).join(",");
  mergedBusyMinutes(list);
  assert.equal(list.map((i) => i.start.toISOString()).join(","), once);
});

test("uç uca değen aralıklar (11:00 biter, 11:00 başlar) TEK aralık sayılır", () => {
  const v = mergedBusyMinutes([
    aralik("2026-08-04T07:00:00Z", "2026-08-04T08:00:00Z"),
    aralik("2026-08-04T08:00:00Z", "2026-08-04T09:00:00Z"),
  ]);
  assert.equal(v, 120);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Fixture'ın vaat ettiği sayılar — 225 vs 255
// ─────────────────────────────────────────────────────────────────────────────

/** listDay'in saf adımları; ağ ve gerçek saat yok, "şimdi" enjekte edilir. */
function gunuHesapla(dateISO, now) {
  const win = buildWindow(dateISO, TZ);
  const raw = mockEvents(FIXTURES_DIR, TZ, now);
  const pencerede = raw.filter(
    (ev) => ev.end.getTime() > win.start.getTime() && ev.start.getTime() < win.end.getTime(),
  );
  const meetings = dedupeEvents(pencerede)
    .map((ev) => toMeeting(ev, win, HEPSI_KAPALI, TZ))
    .sort((a, b) => a.start.localeCompare(b.start));
  const real = realMeetings(meetings);
  return {
    rawCount: meetings.length,
    realCount: real.length,
    filteredOut: meetings.length - real.length,
    busyMinutes: mergedBusyMinutes(real.map((m) => ({ start: new Date(m.start), end: new Date(m.end) }))),
    naiveSumMinutes: naiveSumMinutes(real),
  };
}

test("★ fixture BUGÜN: 8 ham → 5 gerçek, busyMinutes=225, naif=255 (fark tam olarak çakışma)", () => {
  const beklenen = fixture("calendar.json")._expectedTotals.today;
  const olan = gunuHesapla(SABIT_YEREL_TARIH, SABIT_SIMDI);

  assert.equal(olan.rawCount, beklenen.rawCount);
  assert.equal(olan.realCount, beklenen.realCount);
  assert.equal(olan.filteredOut, beklenen.filteredOut);
  assert.equal(olan.busyMinutes, beklenen.busyMinutes, "çakışma BİR KEZ sayılmalı");
  assert.equal(olan.naiveSumMinutes, beklenen.naiveSumMinutes);
  assert.equal(olan.naiveSumMinutes - olan.busyMinutes, 30, "fark 30 dakikalık çakışmadır");
});

test("fixture DÜN: 2 toplantı, çakışma yok → busyMinutes = naif = 180", () => {
  const beklenen = fixture("calendar.json")._expectedTotals.yesterday;
  const olan = gunuHesapla("2026-08-03", SABIT_SIMDI);
  assert.equal(olan.rawCount, beklenen.rawCount);
  assert.equal(olan.busyMinutes, beklenen.busyMinutes);
  assert.equal(olan.naiveSumMinutes, beklenen.naiveSumMinutes);
});

test("mock sağlayıcı 'şimdi' enjekte edilince göreli tarihleri O ANA göre materyalize eder", () => {
  const baskaGun = new Date("2026-12-25T09:00:00Z");
  const olan = gunuHesapla(todayISO(TZ, baskaGun), baskaGun);
  assert.equal(olan.busyMinutes, 225, "senaryo hangi gün çalışırsa çalışsın aynı olmalı");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Pencereye kırpma — gece yarısını aşan toplantı
// ─────────────────────────────────────────────────────────────────────────────

test("★ dün 23:00 → bugün 01:00 toplantısı pencereye KIRPILIR (120 değil 60 dakika)", () => {
  const win = buildWindow(SABIT_YEREL_TARIH, TZ); // 2026-08-04 00:00 → 08-05 00:00 (+03:00)
  const ev = ham({
    start: new Date("2026-08-03T20:00:00Z"), // yerel 03 Ağustos 23:00
    end: new Date("2026-08-03T22:00:00Z"), // yerel 04 Ağustos 01:00
  });
  const m = toMeeting(ev, win, HEPSI_KAPALI, TZ);
  assert.equal(m.minutes, 60, "yalnızca bugüne düşen kısım sayılmalı");
  assert.equal(m.start.slice(0, 16), "2026-08-04T00:00");
});

test("bugün 23:00 → yarın 01:00 toplantısı da kırpılır (sonundan)", () => {
  const win = buildWindow(SABIT_YEREL_TARIH, TZ);
  const ev = ham({
    start: new Date("2026-08-04T20:00:00Z"), // yerel 23:00
    end: new Date("2026-08-04T22:00:00Z"), // yerel ertesi gün 01:00
  });
  const m = toMeeting(ev, win, HEPSI_KAPALI, TZ);
  assert.equal(m.minutes, 60);
  assert.equal(m.end.slice(0, 16), "2026-08-05T00:00");
});

test("clipToWindow tamamen pencere dışındaki aralığı NEGATİF süreye düşürmez", () => {
  const win = buildWindow(SABIT_YEREL_TARIH, TZ);
  const c = clipToWindow(new Date("2026-08-01T06:00:00Z"), new Date("2026-08-01T07:00:00Z"), win);
  assert.ok(c.end.getTime() >= c.start.getTime());
});

test("pencere içinde tamamen duran toplantı KIRPILMAZ", () => {
  const win = buildWindow(SABIT_YEREL_TARIH, TZ);
  const m = toMeeting(ham(), win, HEPSI_KAPALI, TZ);
  assert.equal(m.minutes, 60);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Dedup anahtarı
// ─────────────────────────────────────────────────────────────────────────────

test("★ dedup anahtarı iCalUID + start instant'tır (tek başına iCalUID YETMEZ)", () => {
  const s1 = new Date("2026-08-04T06:00:00Z");
  const s2 = new Date("2026-08-05T06:00:00Z");
  assert.equal(dedupeKey("uid-a", s1), dedupeKey("uid-a", s1));
  assert.notEqual(dedupeKey("uid-a", s1), dedupeKey("uid-a", s2), "Google: seri boyunca AYNI uid, farklı start");
  assert.notEqual(dedupeKey("uid-a", s1), dedupeKey("uid-b", s1), "Graph: her occurrence FARKLI uid");
});

test("dedupeEvents aynı uid+start'ı teke indirir, sırayı korur", () => {
  const a = ham({ id: "a", iCalUID: "uid-x" });
  const kopya = ham({ id: "b", iCalUID: "uid-x" });
  const farkliGun = ham({ id: "c", iCalUID: "uid-x", start: new Date("2026-08-05T06:00:00Z") });
  const out = dedupeEvents([a, kopya, farkliGun]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "a");
  assert.equal(out[1].id, "c");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Microsoft Graph tuzakları
// ─────────────────────────────────────────────────────────────────────────────

test("★ Graph dateTime: offset YOK + 7 kesirli hane → UTC olarak doğru instant", () => {
  const d = parseGraphDateTime("2026-08-02T09:00:00.0000000", "UTC");
  assert.equal(d.toISOString(), "2026-08-02T09:00:00.000Z");
  assert.equal(Number.isNaN(d.getTime()), false, "new Date(...) doğrudan yerse Invalid Date olurdu");
});

test("Graph dateTime: timeZone UTC değilse o dilimde YEREL kabul edilip çevrilir", () => {
  const d = parseGraphDateTime("2026-08-02T09:00:00.0000000", "Europe/Istanbul");
  assert.equal(d.toISOString(), "2026-08-02T06:00:00.000Z");
});

test("Graph dateTime: zaten offset taşıyorsa olduğu gibi ayrıştırılır", () => {
  assert.equal(parseGraphDateTime("2026-08-02T09:00:00+03:00").toISOString(), "2026-08-02T06:00:00.000Z");
  assert.equal(parseGraphDateTime("2026-08-02T09:00:00Z").toISOString(), "2026-08-02T09:00:00.000Z");
});

test("mapGraphEvent showAs='free' → free=true, responseStatus='declined' → declined=true", () => {
  const ev = mapGraphEvent({
    id: "g1",
    iCalUId: "uid-g1",
    subject: "Öğle",
    start: { dateTime: "2026-08-04T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-08-04T10:00:00.0000000", timeZone: "UTC" },
    showAs: "Free",
    responseStatus: { response: "Declined" },
  });
  assert.equal(ev.free, true, "büyük/küçük harf farkı yutulmalı");
  assert.equal(ev.declined, true);
  assert.equal(ev.start.toISOString(), "2026-08-04T09:00:00.000Z");
});

test("mapGraphEvent showAs YOKSA 'busy' varsayar (free=false)", () => {
  const ev = mapGraphEvent({
    id: "g2",
    start: { dateTime: "2026-08-04T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-08-04T10:00:00.0000000", timeZone: "UTC" },
  });
  assert.equal(ev.free, false);
  assert.equal(ev.iCalUID, "g2", "iCalUId yoksa id'ye düşülür");
  assert.equal(ev.title, "(başlıksız)");
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) Google tuzakları
// ─────────────────────────────────────────────────────────────────────────────

test("★ Google transparency alanı YOKSA 'opaque' varsayılır → free=false", () => {
  const ev = mapGoogleEvent({
    id: "gc1",
    iCalUID: "uid-gc1",
    summary: "Tasarım",
    start: { dateTime: "2026-08-04T09:00:00+03:00" },
    end: { dateTime: "2026-08-04T10:00:00+03:00" },
  });
  assert.equal(ev.free, false, "alanın YOKLUĞU 'meşgul değil' anlamına GELMEZ");
});

test("Google transparency='transparent' → free=true", () => {
  const ev = mapGoogleEvent({
    id: "gc2",
    start: { dateTime: "2026-08-04T09:00:00+03:00" },
    end: { dateTime: "2026-08-04T10:00:00+03:00" },
    transparency: "transparent",
  });
  assert.equal(ev.free, true);
});

test("Google: yalnızca SELF katılımcının 'declined' cevabı sayılır", () => {
  const baskasiReddetti = mapGoogleEvent({
    id: "gc3",
    start: { dateTime: "2026-08-04T09:00:00+03:00" },
    end: { dateTime: "2026-08-04T10:00:00+03:00" },
    attendees: [
      { email: "ben@ornek.com", self: true, responseStatus: "accepted" },
      { email: "baskasi@ornek.com", responseStatus: "declined" },
    ],
  });
  assert.equal(baskasiReddetti.declined, false);

  const benReddettim = mapGoogleEvent({
    id: "gc4",
    start: { dateTime: "2026-08-04T09:00:00+03:00" },
    end: { dateTime: "2026-08-04T10:00:00+03:00" },
    attendees: [{ email: "ben@ornek.com", self: true, responseStatus: "declined" }],
  });
  assert.equal(benReddettim.declined, true);
});

test("Google: date (dateTime değil) alanı gelirse isAllDay=true", () => {
  const ev = mapGoogleEvent({
    id: "gc5",
    start: { date: "2026-08-04" },
    end: { date: "2026-08-05" },
  });
  assert.equal(ev.isAllDay, true);
});

test("Google: status='cancelled' → isCancelled=true; status YOKSA confirmed sayılır", () => {
  const base = { start: { dateTime: "2026-08-04T09:00:00+03:00" }, end: { dateTime: "2026-08-04T10:00:00+03:00" } };
  assert.equal(mapGoogleEvent({ id: "a", ...base, status: "cancelled" }).isCancelled, true);
  assert.equal(mapGoogleEvent({ id: "b", ...base }).isCancelled, false);
});
