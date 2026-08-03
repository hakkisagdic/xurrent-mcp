/**
 * ★ ÜÇ BACKDATE STRATEJİSİNİN BİRİM TESTİ — dersin kalbi.
 *
 * NE KANITLIYOR: planPlannedMutations SAF bir fonksiyondur; ağ, saat veya
 * Xurrent hesabı olmadan "hangi mutation'lar hangi sırayla gider" sorusunun
 * cevabı ölçülebilir. Sihirbaz bu mantığı yalnızca DOLAYLI olarak geçirir:
 * two_step'in 2. adımına yanlışlıkla assignment eklense sihirbaz yine geçerdi,
 * çünkü mock adapter alanı görmezden gelir. Burada geçmez.
 *
 * Çalıştırma: npm run build && npm test
 * Not: derlenmiş dist/ okunur — kaynağı çalıştırmak bir yükleyici (loader)
 * bağımlılığı gerektirirdi; repo kasıtlı olarak bağımlılık-fakiridir.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { planPlannedMutations, deterministicSourceId, PENDING_TIME_ENTRY_ID } from "../../dist/xurrent/strategies.js";
import { ALLOCATION_ID, ME_ID, SABIT_YEREL_TARIH, entry, planContext } from "../_testkit.mjs";

const DUN = "2026-08-03"; // SABIT_YEREL_TARIH - 1

// ─────────────────────────────────────────────────────────────────────────────
// two_step
// ─────────────────────────────────────────────────────────────────────────────

test("two_step tam olarak 2 mutation planlar", () => {
  const out = planPlannedMutations(entry({ date: DUN }), planContext({ strategy: "two_step" }));
  assert.equal(out.strategy, "two_step");
  assert.equal(out.planned.length, 2);
});

test("two_step 1. adımı parent update, 2. adımı timeEntryUpdate'tir", () => {
  const out = planPlannedMutations(entry({ date: DUN }), planContext({ strategy: "two_step" }));
  assert.equal(out.planned[0].path, "requestUpdate");
  assert.equal(out.planned[1].path, "timeEntryUpdate");
  assert.equal(out.planned[0].index, 0);
  assert.equal(out.planned[1].index, 1);
});

test("two_step adım etiketleri 1/2 ve 2/2'dir", () => {
  const out = planPlannedMutations(entry({ date: DUN }), planContext({ strategy: "two_step" }));
  assert.equal(out.planned[0].stepLabel, "1/2");
  assert.equal(out.planned[1].stepLabel, "2/2");
});

test("★ two_step ikinci adımda assignment ALANI GÖNDERMEZ — stratejinin dayandığı garanti budur", () => {
  const out = planPlannedMutations(
    entry({ date: DUN, startedAt: `${DUN}T14:00:00+03:00` }),
    planContext({ strategy: "two_step" }),
  );
  const step2 = out.planned[1].input.input;
  for (const yasak of ["assignment", "assignmentId", "requestId", "taskId"]) {
    assert.equal(step2[yasak], undefined, `2. adımda '${yasak}' bulunmamalı — ticket bağı BOZULABİLİRDİ`);
  }
  // Buna karşılık 1. adımın DÜZELTEMEDİĞİ üç alan burada OLMALI.
  assert.equal(step2.date, DUN);
  assert.equal(step2.startedAt, `${DUN}T14:00:00+03:00`);
  assert.equal(step2.id, PENDING_TIME_ENTRY_ID);
});

test("two_step 1. adımda date/startedAt/personId GÖNDERMEZ (parent input'ta bu alanlar yoktur)", () => {
  const out = planPlannedMutations(
    entry({ date: DUN, startedAt: `${DUN}T14:00:00+03:00`, personId: "TW9jay9QZXJzb24vMg" }),
    planContext({ strategy: "two_step" }),
  );
  const step1 = out.planned[0].input.input;
  assert.equal(step1.date, undefined);
  assert.equal(step1.startedAt, undefined);
  assert.equal(step1.personId, undefined);
  assert.equal(step1.timeSpent, 60);
});

test("two_step geçmiş tarihte 'geçici olarak yanlış günde görünür' uyarısı üretir", () => {
  const out = planPlannedMutations(entry({ date: DUN }), planContext({ strategy: "two_step" }));
  assert.ok(
    out.warnings.some((w) => w.includes(DUN) && w.includes(SABIT_YEREL_TARIH)),
    "önce bugün oluşup sonra geçmişe çekildiği söylenmeli",
  );
});

test("two_step ATOMİK DEĞİLDİR uyarısını her durumda verir", () => {
  const out = planPlannedMutations(entry(), planContext({ strategy: "two_step" }));
  assert.ok(out.warnings.some((w) => w.includes("ATOMİK DEĞİLDİR")));
});

test("two_step başkası adına yazmada yetki uyarısı ekler", () => {
  const baskasi = planPlannedMutations(
    entry({ personId: "TW9jay9QZXJzb24vMg" }),
    planContext({ strategy: "two_step" }),
  );
  assert.ok(baskasi.warnings.some((w) => w.includes("Başkası adına yazma")));

  const kendisi = planPlannedMutations(entry({ personId: ME_ID }), planContext({ strategy: "two_step" }));
  assert.ok(!kendisi.warnings.some((w) => w.includes("Başkası adına yazma")), "$me/kendisi uyarı üretmemeli");
});

// ─────────────────────────────────────────────────────────────────────────────
// link_first
// ─────────────────────────────────────────────────────────────────────────────

test("link_first tek mutation planlar ve stepLabel taşımaz", () => {
  const out = planPlannedMutations(entry(), planContext({ strategy: "link_first" }));
  assert.equal(out.strategy, "link_first");
  assert.equal(out.planned.length, 1);
  assert.equal(out.planned[0].path, "requestUpdate");
  assert.equal(out.planned[0].stepLabel, null);
});

test("★ link_first date istenmiş olsa bile UYARI üretir — istenen tarih sessizce yutulmaz", () => {
  const out = planPlannedMutations(entry({ date: DUN }), planContext({ strategy: "link_first" }));
  assert.ok(
    out.warnings.some((w) => w.includes("İSTENEN TARİH KARŞILANAMADI")),
    "T-1 istendiğinde karşılanamadığı AÇIKÇA söylenmeli",
  );
});

test("link_first startedAt istendiğinde 'kaydedilemedi' uyarısı verir", () => {
  const out = planPlannedMutations(
    entry({ startedAt: `${SABIT_YEREL_TARIH}T09:00:00+03:00` }),
    planContext({ strategy: "link_first" }),
  );
  assert.ok(out.warnings.some((w) => w.includes("Başlangıç saati KAYDEDİLEMEDİ")));
});

test("link_first başkası adına yazmayı KARŞILAYAMADIĞINI söyler", () => {
  const out = planPlannedMutations(
    entry({ personId: "TW9jay9QZXJzb24vMg" }),
    planContext({ strategy: "link_first" }),
  );
  assert.ok(out.warnings.some((w) => w.includes("Başkası adına yazma KARŞILANAMADI")));
});

test("link_first bugüne yazarken bile 'tarih sunucu tarafından atanacak' uyarısını bırakır", () => {
  const out = planPlannedMutations(entry(), planContext({ strategy: "link_first" }));
  assert.ok(out.warnings.some((w) => w.includes("SUNUCU tarafından")));
});

// ─────────────────────────────────────────────────────────────────────────────
// date_first
// ─────────────────────────────────────────────────────────────────────────────

test("date_first tek timeEntryCreate planlar", () => {
  const out = planPlannedMutations(entry({ date: DUN }), planContext({ strategy: "date_first" }));
  assert.equal(out.strategy, "date_first");
  assert.equal(out.planned.length, 1);
  assert.equal(out.planned[0].path, "timeEntryCreate");
});

test("★ date_first hedefi TimeAllocation'a ÇEVİRİR ve 'bağlanmayacak' uyarısı verir", () => {
  const out = planPlannedMutations(
    entry({ date: DUN }),
    planContext({ strategy: "date_first", targetLabel: "Request #70248" }),
  );
  assert.equal(out.effectiveTargetType, "time_allocation");
  assert.equal(out.effectiveTargetId, ALLOCATION_ID);
  assert.equal(out.planned[0].input.input.timeAllocationId, ALLOCATION_ID);
  assert.ok(
    out.warnings.some((w) => w.includes("BAĞ KURULMAYACAK")),
    "sessiz dönüşüm YASAK — ticket'a bağlanmayacağı söylenmeli",
  );
});

test("date_first date/startedAt/personId'yi mutation'a GERÇEKTEN koyar", () => {
  const out = planPlannedMutations(
    entry({ date: DUN, startedAt: `${DUN}T11:00:00+03:00`, personId: "TW9jay9QZXJzb24vMg" }),
    planContext({ strategy: "date_first" }),
  );
  const inp = out.planned[0].input.input;
  assert.equal(inp.date, DUN);
  assert.equal(inp.startedAt, `${DUN}T11:00:00+03:00`);
  assert.equal(inp.personId, "TW9jay9QZXJzb24vMg");
});

test("date_first personId='$me' iken personId GÖNDERMEZ ('$me' bir node id değildir)", () => {
  const out = planPlannedMutations(entry({ personId: "$me" }), planContext({ strategy: "date_first" }));
  assert.equal(out.planned[0].input.input.personId, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Hedef tipleri
// ─────────────────────────────────────────────────────────────────────────────

test("targetType time_allocation stratejiden BAĞIMSIZ olarak date_first'e düşer", () => {
  for (const istenen of ["two_step", "link_first", "date_first"]) {
    const out = planPlannedMutations(
      entry({ targetType: "time_allocation", targetId: ALLOCATION_ID }),
      planContext({ strategy: istenen }),
    );
    assert.equal(out.strategy, "date_first", `${istenen} istendiğinde bile tek yol Yol A'dır`);
    assert.equal(out.planned.length, 1);
    assert.equal(out.planned[0].path, "timeEntryCreate");
    assert.equal(out.effectiveTargetId, ALLOCATION_ID, "varsayılana DEĞİL, istenen allocation'a yazılmalı");
  }
});

test("two_step dört ticket hedefinin her biri için doğru parent mutation'ı seçer", () => {
  const beklenen = {
    request: "requestUpdate",
    task: "taskUpdate",
    project_task: "projectTaskUpdate",
    problem: "problemUpdate",
  };
  for (const [targetType, path] of Object.entries(beklenen)) {
    const out = planPlannedMutations(entry({ targetType }), planContext({ strategy: "two_step" }));
    assert.equal(out.planned[0].path, path, `${targetType} → ${path}`);
    assert.equal(out.planned[1].path, "timeEntryUpdate");
    assert.equal(out.effectiveTargetType, targetType);
  }
});

test("her hedef tipi kendi varsayılan effortClass'ını kullanır", () => {
  const timesheet = planContext().timesheet;
  timesheet.defaults = {
    requestEffortClassId: "ec-request",
    taskEffortClassId: "ec-task",
    projectTaskEffortClassId: "ec-ptask",
    problemEffortClassId: "ec-problem",
    timeAllocationEffortClassId: "ec-alloc",
  };
  const ctx = planContext({ strategy: "link_first", timesheet });
  const cift = {
    request: "ec-request",
    task: "ec-task",
    project_task: "ec-ptask",
    problem: "ec-problem",
  };
  for (const [targetType, ec] of Object.entries(cift)) {
    const out = planPlannedMutations(entry({ targetType }), ctx);
    assert.equal(out.planned[0].input.input.timeSpentEffortClassId, ec);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

test("deterministicSourceId aynı girdi için AYNI değeri üretir (ağ hatası sonrası çift kayıt tespiti)", () => {
  const a = deterministicSourceId(entry({ date: DUN }), SABIT_YEREL_TARIH);
  const b = deterministicSourceId(entry({ date: DUN }), SABIT_YEREL_TARIH);
  assert.equal(a, b);
  assert.match(a, /^xmcp-[0-9a-f]{16}$/);
});

test("deterministicSourceId süre değişince DEĞİŞİR", () => {
  const a = deterministicSourceId(entry({ minutes: 60 }), SABIT_YEREL_TARIH);
  const b = deterministicSourceId(entry({ minutes: 90 }), SABIT_YEREL_TARIH);
  assert.notEqual(a, b);
});

test("planlayıcı SAF: girdiyi mutasyona uğratmaz ve iki çağrı aynı planı verir", () => {
  const input = entry({ date: DUN, description: "Aynı girdi" });
  const once = JSON.stringify(input);
  const a = planPlannedMutations(input, planContext({ strategy: "two_step" }));
  const b = planPlannedMutations(input, planContext({ strategy: "two_step" }));
  assert.equal(JSON.stringify(input), once, "girdi DEĞİŞMEMELİ");
  assert.deepEqual(a.planned, b.planned);
});

test("boş/null alanlar mutation input'una hiç KONMAZ", () => {
  const out = planPlannedMutations(entry({ description: "", note: undefined }), planContext({ strategy: "link_first" }));
  const inp = out.planned[0].input.input;
  assert.ok(!("timeEntryDescription" in inp), "boş açıklama gönderilmemeli");
  assert.ok(!("note" in inp), "tanımsız note gönderilmemeli");
});
