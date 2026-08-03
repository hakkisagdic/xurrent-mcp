/**
 * ★ ÖN KONTROLLERİN (preflight) BİRİM TESTİ.
 *
 * NE KANITLIYOR: Sunucunun reddedeceği istek GÖNDERİLMEDEN yakalanıyor ve
 * "hata" ile "uyarı" ayrımı korunuyor. Bu ayrım bozulursa (bir uyarı hataya
 * dönerse) sihirbaz yine geçer — çünkü sihirbaz geçerli girdiler kullanır.
 * Kenar durumlar yalnızca burada ölçülür.
 *
 * Fixture: timeIncrement=30, workday=480, allowWorkdayOvertime=false.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { preflight, roundToIncrement } from "../../dist/xurrent/validate.js";
import {
  ALLOCATION_DESC_REQUIRED_ID,
  ME_ID,
  SABIT_YEREL_TARIH,
  entry,
  preflightContext,
  timesheetFixture,
} from "../_testkit.mjs";

const T = SABIT_YEREL_TARIH; // 2026-08-04
const T_1 = "2026-08-03";
const T_2 = "2026-08-02";

const mesajlar = (r) => r.errors.map((e) => e.message).join(" | ");
const hataVarMi = (r, parca) => r.errors.some((e) => e.message.includes(parca));

// ─────────────────────────────────────────────────────────────────────────────
// 1) timeIncrement — entegrasyonlardaki en yaygın SESSİZ hata
// ─────────────────────────────────────────────────────────────────────────────

test("timeIncrement=30 iken 45 dakika HATA üretir", () => {
  const r = preflight(entry({ minutes: 45 }), preflightContext());
  assert.equal(r.errors.length > 0, true, mesajlar(r));
  assert.ok(hataVarMi(r, "timeIncrement"));
});

test("timeIncrement=30 iken 7 dakika HATA üretir", () => {
  const r = preflight(entry({ minutes: 7 }), preflightContext());
  assert.ok(hataVarMi(r, "timeIncrement"));
});

test("timeIncrement=30 iken 30/60/90 dakika HATASIZ geçer", () => {
  for (const minutes of [30, 60, 90]) {
    const r = preflight(entry({ minutes }), preflightContext());
    assert.equal(r.errors.length, 0, `${minutes} dk geçmeliydi: ${mesajlar(r)}`);
  }
});

test("timeIncrement hatası kullanıcıya AŞAĞI ve YUKARI öneri verir", () => {
  const r = preflight(entry({ minutes: 45 }), preflightContext());
  const msg = mesajlar(r);
  assert.ok(msg.includes("30") && msg.includes("60"), `öneriler eksik: ${msg}`);
});

test("0 dakika HATA üretir", () => {
  const r = preflight(entry({ minutes: 0 }), preflightContext());
  assert.ok(hataVarMi(r, "0 dakika olamaz"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Negatif süre / düzeltme
// ─────────────────────────────────────────────────────────────────────────────

test("negatif süre correction olmadan HATA üretir", () => {
  const r = preflight(entry({ minutes: -60 }), preflightContext());
  assert.ok(hataVarMi(r, "correction=true"));
});

test("negatif süre correction=true ile GEÇER ve uyarı bırakır", () => {
  const r = preflight(entry({ minutes: -60, correction: true }), preflightContext());
  assert.equal(r.errors.length, 0, mesajlar(r));
  assert.ok(r.warnings.some((w) => w.includes("Düzeltme")));
});

test("negatif süre de timeIncrement katı olmak zorundadır (-45 HATA)", () => {
  const r = preflight(entry({ minutes: -45, correction: true }), preflightContext());
  assert.ok(hataVarMi(r, "timeIncrement"));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Geriye yazma sınırı
// ─────────────────────────────────────────────────────────────────────────────

test("★ maxBackdateDays=1 iken T ve T-1 geçer, T-2 HATA üretir", () => {
  const ctx = preflightContext({ maxBackdateDays: 1 });

  const bugun = preflight(entry({ date: T }), ctx);
  assert.equal(bugun.errors.length, 0, `T geçmeliydi: ${mesajlar(bugun)}`);

  const dun = preflight(entry({ date: T_1 }), ctx);
  assert.equal(dun.errors.length, 0, `T-1 geçmeliydi: ${mesajlar(dun)}`);

  const oncekiGun = preflight(entry({ date: T_2 }), ctx);
  assert.ok(hataVarMi(oncekiGun, "geriye yazma sınırının dışında"), `T-2 reddedilmeliydi`);
});

test("gelecek tarih HATA değil UYARI üretir", () => {
  const r = preflight(entry({ date: "2026-08-05" }), preflightContext());
  assert.equal(r.errors.length, 0, mesajlar(r));
  assert.ok(r.warnings.some((w) => w.includes("GELECEK")));
});

test("link_first + geçmiş tarih: karşılanamayacağı UYARI olarak söylenir", () => {
  const r = preflight(entry({ date: T_1 }), preflightContext({ strategy: "link_first" }));
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => w.includes("link_first")));
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Açıklama / zorunlu alanlar
// ─────────────────────────────────────────────────────────────────────────────

test("★ 80 karakteri aşan açıklama HATA üretir; tam 80 karakter GEÇER", () => {
  const seksenBir = "a".repeat(81);
  const seksen = "a".repeat(80);

  const asan = preflight(entry({ description: seksenBir }), preflightContext());
  assert.ok(hataVarMi(asan, "80 karakterdir"), mesajlar(asan));

  const sinir = preflight(entry({ description: seksen }), preflightContext());
  assert.equal(sinir.errors.length, 0, `tam 80 geçmeliydi: ${mesajlar(sinir)}`);
});

test("★ descriptionRequired allocation'a açıklamasız yazma HATA üretir", () => {
  const allocation = {
    id: ALLOCATION_DESC_REQUIRED_ID,
    name: "Eğitim ve gelişim",
    group: "Genel",
    descriptionRequired: true,
  };
  const ctx = preflightContext({ strategy: "date_first", allocation });

  const acikamasiz = preflight(
    entry({ targetType: "time_allocation", targetId: ALLOCATION_DESC_REQUIRED_ID }),
    ctx,
  );
  assert.ok(hataVarMi(acikamasiz, "descriptionRequired=true"), mesajlar(acikamasiz));

  const aciklamali = preflight(
    entry({ targetType: "time_allocation", targetId: ALLOCATION_DESC_REQUIRED_ID, description: "Kurs" }),
    ctx,
  );
  assert.equal(aciklamali.errors.length, 0, mesajlar(aciklamali));
});

test("requireNote=true iken note olmadan HATA üretir", () => {
  const ctx = preflightContext({ timesheet: timesheetFixture({ requireNote: true }) });
  assert.ok(hataVarMi(preflight(entry(), ctx), "requireNote=true"));
  assert.equal(preflight(entry({ note: "not" }), ctx).errors.length, 0);
});

test("requireTimeEntryDescription=true iken açıklama olmadan HATA üretir", () => {
  const ctx = preflightContext({ timesheet: timesheetFixture({ requireTimeEntryDescription: true }) });
  assert.ok(hataVarMi(preflight(entry(), ctx), "requireTimeEntryDescription=true"));
});

test("date_first + note: note'un gönderilemeyeceği UYARI olarak söylenir", () => {
  const r = preflight(entry({ note: "bir not" }), preflightContext({ strategy: "date_first" }));
  assert.ok(r.warnings.some((w) => w.includes("note alanı yalnızca Yol B'de anlamlıdır")));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5) Mesai sınırları
// ─────────────────────────────────────────────────────────────────────────────

test("★ allowWorkdayOvertime=false iken günlük 480 dakikayı aşan yazma HATA üretir", () => {
  // 450 mevcut + 60 yeni = 510 > 480
  const r = preflight(entry({ minutes: 60 }), preflightContext({ dayMinutes: 450 }));
  assert.ok(hataVarMi(r, "günlük sınır"), mesajlar(r));
});

test("allowWorkdayOvertime=false iken TAM 480 dakika GEÇER (sınır dahil)", () => {
  const r = preflight(entry({ minutes: 30 }), preflightContext({ dayMinutes: 450 }));
  assert.equal(r.errors.length, 0, mesajlar(r));
});

test("allowWorkdayOvertime=true iken aşım HATA değil UYARI olur", () => {
  const ctx = preflightContext({
    dayMinutes: 450,
    timesheet: timesheetFixture({ allowWorkdayOvertime: true }),
  });
  const r = preflight(entry({ minutes: 60 }), ctx);
  assert.equal(r.errors.length, 0, mesajlar(r));
  assert.ok(r.warnings.some((w) => w.includes("günlük toplam")));
});

test("allowWorkweekOvertime=false iken haftalık aşım HATA üretir", () => {
  const ctx = preflightContext({
    weekMinutes: 2380,
    timesheet: timesheetFixture({ allowWorkweekOvertime: false }),
  });
  assert.ok(hataVarMi(preflight(entry({ minutes: 30 }), ctx), "Haftalık toplam"));
});

test("negatif (düzeltme) süre günlük toplamı ARTIRMAZ", () => {
  const r = preflight(entry({ minutes: -60, correction: true }), preflightContext({ dayMinutes: 480 }));
  assert.equal(r.errors.length, 0, mesajlar(r));
});

// ─────────────────────────────────────────────────────────────────────────────
// 6) Yol A / Yol B şalterleri
// ─────────────────────────────────────────────────────────────────────────────

test("allocationTimeTracking=false iken date_first HATA üretir", () => {
  const ctx = preflightContext({
    strategy: "date_first",
    timesheet: timesheetFixture({ allocationTimeTracking: false }),
  });
  assert.ok(hataVarMi(preflight(entry(), ctx), "Yol A (timeEntryCreate) TAMAMEN kapalıdır"));
});

test("assignmentTimeTracking=false iken two_step ve link_first HATA üretir", () => {
  const ts = timesheetFixture({ assignmentTimeTracking: false });
  for (const strategy of ["two_step", "link_first"]) {
    const r = preflight(entry(), preflightContext({ strategy, timesheet: ts }));
    assert.ok(hataVarMi(r, "Yol B"), `${strategy}: ${mesajlar(r)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) personId — UYARI, hata DEĞİL
// ─────────────────────────────────────────────────────────────────────────────

test("★ personId authenticated user'dan farklıysa UYARI üretir, HATA ÜRETMEZ", () => {
  const r = preflight(entry({ personId: "TW9jay9QZXJzb24vMg" }), preflightContext());
  assert.equal(r.errors.length, 0, `hata olmamalıydı: ${mesajlar(r)}`);
  assert.ok(r.warnings.some((w) => w.includes("yetkisi gerektirir")));
});

test("personId '$me' veya kendi id'si iken uyarı YOKTUR", () => {
  for (const personId of ["$me", ME_ID]) {
    const r = preflight(entry({ personId }), preflightContext());
    assert.ok(!r.warnings.some((w) => w.includes("yetkisi gerektirir")), personId);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8) startedAt biçimi
// ─────────────────────────────────────────────────────────────────────────────

test("startedAt offset taşımıyorsa HATA üretir", () => {
  const r = preflight(entry({ date: T, startedAt: `${T}T09:00:00` }), preflightContext());
  assert.ok(hataVarMi(r, "offset TAŞIMIYOR"));
});

test("startedAt offsetli ise (+03:00 veya Z) GEÇER", () => {
  for (const s of [`${T}T09:00:00+03:00`, `${T}T06:00:00Z`]) {
    const r = preflight(entry({ date: T, startedAt: s }), preflightContext());
    assert.equal(r.errors.length, 0, `${s}: ${mesajlar(r)}`);
  }
});

test("startedAt günü date'ten farklıysa UYARI üretir", () => {
  const r = preflight(entry({ date: T, startedAt: `${T_1}T09:00:00+03:00` }), preflightContext());
  assert.equal(r.errors.length, 0, mesajlar(r));
  assert.ok(r.warnings.some((w) => w.includes("farklı günler")));
});

// ─────────────────────────────────────────────────────────────────────────────
// 9) roundToIncrement
// ─────────────────────────────────────────────────────────────────────────────

test("roundToIncrement nearest: 45 → 60, 44 → 30 (increment 30)", () => {
  assert.equal(roundToIncrement(45, 30, "nearest"), 60); // .5 yukarı yuvarlanır
  assert.equal(roundToIncrement(44, 30, "nearest"), 30);
});

test("roundToIncrement up: 45 → 60, 31 → 60", () => {
  assert.equal(roundToIncrement(45, 30, "up"), 60);
  assert.equal(roundToIncrement(31, 30, "up"), 60);
});

test("roundToIncrement down: 45 → 30, 59 → 30", () => {
  assert.equal(roundToIncrement(45, 30, "down"), 30);
  assert.equal(roundToIncrement(59, 30, "down"), 30);
});

test("★ roundToIncrement sonucu ASLA 0 olmaz — 5 dakikalık toplantı en az bir birim yazılır", () => {
  assert.equal(roundToIncrement(5, 30, "down"), 30);
  assert.equal(roundToIncrement(1, 60, "nearest"), 60);
});

test("roundToIncrement katı olan değeri DEĞİŞTİRMEZ", () => {
  for (const mode of ["nearest", "up", "down"]) {
    assert.equal(roundToIncrement(90, 30, mode), 90, mode);
  }
});

test("roundToIncrement increment<=0 iken süreyi olduğu gibi bırakır", () => {
  assert.equal(roundToIncrement(47, 0, "nearest"), 47);
});
