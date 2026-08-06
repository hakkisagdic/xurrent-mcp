/**
 * ★ YAZMA ÖNCESİ DEDUP'IN BİRİM TESTİ — tool katmanı + mock adapter, AĞSIZ.
 *
 * NE KANITLIYOR: dedup canlıya özgü bir hile değil, TOOL KATMANININ davranışıdır
 * (contract/reliability.md §5). Mock adapter da findTimeEntryBySourceId'yi
 * implemente ettiği için "aynı komut ikinci kez çalıştırıldığında çift kayıt
 * oluşmaz" garantisi burada, fixtures ile ölçülür:
 *   - tekil yazma: 2. çağrı deduped=true + MEVCUT kayıt döner.
 *   - bulk: 2. koşuda kalemler "deduped", summary.deduped doğru sayar.
 *   - asimetri: two_step planı (ilk adım parent update) dedup'a GİRMEZ —
 *     Yol B'nin koruması dedup değil retry YASAĞIDIR.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { MockXurrentAdapter } from "../../dist/xurrent/mock.js";
import { createToolContext } from "../../dist/core/context.js";
import { runCreateTimeEntry, runBulk } from "../../dist/core/toolimpl.js";
import { deterministicSourceId } from "../../dist/xurrent/strategies.js";
import { ALLOCATION_ID, FIXTURES_DIR, REPO_ROOT, SABIT_YEREL_TARIH } from "../_testkit.mjs";

/** Testin ihtiyaç duyduğu alanlarla sınırlı AppConfig. Ağ alanları KASITLI çöp. */
function testCfg(overrides = {}) {
  return {
    repoRoot: REPO_ROOT,
    fixturesDir: FIXTURES_DIR,
    mode: "mock",
    token: "",
    account: "",
    graphqlUrl: "http://127.0.0.1:1/",
    forceDryRun: false,
    confirmPolicy: "open", // birim testte onay kanalı yok — soru SORULMAZ
    source: "xurrent-mcp",
    backdateStrategy: "two_step",
    maxBackdateDays: 1,
    retryMaxAttempts: 5,
    retryBaseMs: 500,
    retryCapMs: 8000,
    minRequestGapMs: 0,
    calendarProvider: "mock",
    icsPath: "",
    icsUrl: "",
    google: {},
    ms: {},
    timeZone: "Europe/Istanbul",
    defaultTimeAllocationId: ALLOCATION_ID,
    roundingMode: "nearest",
    mockPersist: false,
    mcpProtocol: "2026-07-28",
    stateSecret: "test",
    stateTtlSeconds: 300,
    ...overrides,
  };
}

function makeCtx() {
  const cfg = testCfg();
  return createToolContext(cfg, new MockXurrentAdapter(cfg), async () => ({ action: "accept" }));
}

/** stderr yakalayıcı — [dedup] izleri buradan doğrulanır. */
function captureStderr() {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return { lines, restore: () => (process.stderr.write = orig) };
}

const entryArgs = (description) => ({
  targetType: "time_allocation",
  targetId: ALLOCATION_ID,
  minutes: 30,
  description,
  dryRun: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// Tekil yazma
// ─────────────────────────────────────────────────────────────────────────────

test("★ aynı tekil yazma İKİNCİ kez çalıştırılınca deduped=true + MEVCUT kayıt döner", async () => {
  const ctx = makeCtx();
  const cap = captureStderr();
  let ilk, ikinci;
  try {
    ilk = await runCreateTimeEntry(ctx, entryArgs("dedup tekil"));
    ikinci = await runCreateTimeEntry(ctx, entryArgs("dedup tekil"));
  } finally {
    cap.restore();
  }
  assert.equal(ilk.errors.length, 0);
  assert.notEqual(ilk.deduped, true, "ilk yazma dedup DEĞİLDİR");
  assert.ok(ilk.timeEntry?.id, "ilk yazma kayıt oluşturmalı");

  assert.equal(ikinci.deduped, true, "ikinci çalıştırma deduped işaretlenmeli");
  assert.equal(ikinci.errors.length, 0, "dedup HATA değildir — güvenli tekrar");
  assert.equal(ikinci.timeEntry.id, ilk.timeEntry.id, "MEVCUT kayıt dönmeli, yenisi değil");
  assert.ok(
    ikinci.warnings.some((w) => w.includes("dedup") && w.includes("ATLANDI")),
    "Türkçe dedup uyarısı olmalı (yazmanın atlandığı AÇIKÇA söylenir)",
  );

  // İz biçimi: ilk koşu hit=false, ikinci koşu hit=true — ikisi de sözleşme biçiminde.
  const izler = cap.lines.filter((l) => l.startsWith("[dedup]"));
  assert.equal(izler.length, 2);
  const RE = /^\[dedup\] op=timeEntryCreate sourceID=xmcp-[0-9a-f]{16} hit=(true|false)\n$/;
  for (const iz of izler) assert.match(iz, RE);
  assert.match(izler[0], /hit=false\n$/);
  assert.match(izler[1], /hit=true\n$/);
});

test("farklı girdi farklı sourceID üretir → dedup TETİKLENMEZ, iki ayrı kayıt oluşur", async () => {
  const ctx = makeCtx();
  const cap = captureStderr();
  let a, b;
  try {
    a = await runCreateTimeEntry(ctx, entryArgs("kayit bir"));
    b = await runCreateTimeEntry(ctx, entryArgs("kayit iki"));
  } finally {
    cap.restore();
  }
  assert.notEqual(a.deduped, true);
  assert.notEqual(b.deduped, true);
  assert.notEqual(a.timeEntry.id, b.timeEntry.id);
});

test("★ asimetri: two_step (ilk adım parent update) dedup'a GİRMEZ — Yol B'nin koruması retry yasağıdır", async () => {
  const ctx = makeCtx();
  const args = {
    targetType: "request",
    targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4",
    minutes: 30,
    description: "yol b tekrar",
    dryRun: false,
  };
  const cap = captureStderr();
  let ilk, ikinci;
  try {
    ilk = await runCreateTimeEntry(ctx, args);
    ikinci = await runCreateTimeEntry(ctx, args);
  } finally {
    cap.restore();
  }
  assert.equal(ilk.errors.length, 0);
  assert.equal(ikinci.errors.length, 0);
  // Dedup YOK: iki koşu iki AYRI kayıt üretir (timeSpent artımlıdır; bunu
  // engelleyecek sourceID parent update input'una YAZILAMAZ).
  assert.notEqual(ikinci.deduped, true);
  assert.notEqual(ikinci.timeEntry.id, ilk.timeEntry.id);
  assert.equal(cap.lines.filter((l) => l.startsWith("[dedup]")).length, 0, "Yol B'de [dedup] izi olmamalı");
});

test("dryRun=true iken dedup geri-okuması YAPILMAZ (hiçbir yan etki yok)", async () => {
  const ctx = makeCtx();
  const cap = captureStderr();
  let r;
  try {
    r = await runCreateTimeEntry(ctx, { ...entryArgs("dry"), dryRun: true });
  } finally {
    cap.restore();
  }
  assert.equal(r.dryRun, true);
  assert.notEqual(r.deduped, true);
  assert.equal(cap.lines.filter((l) => l.startsWith("[dedup]")).length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bulk
// ─────────────────────────────────────────────────────────────────────────────

test("★ bulk tekrar-çalıştırma güvencesi: 2. koşu created=0 deduped=N, çift kayıt yok", async () => {
  const ctx = makeCtx();
  const entries = [1, 2, 3].map((i) => ({
    targetType: "time_allocation",
    targetId: ALLOCATION_ID,
    minutes: 30,
    description: `bulk kalem ${i}`,
  }));

  const cap = captureStderr();
  let r1, r2;
  try {
    r1 = await runBulk(ctx, { entries, dryRun: false, stopOnError: false });
    r2 = await runBulk(ctx, { entries, dryRun: false, stopOnError: false });
  } finally {
    cap.restore();
  }

  assert.equal(r1.summary.created, 3);
  assert.equal(r1.summary.deduped, 0, "sayaç 0 iken de RAPORLANIR");
  assert.ok(r1.results.every((row) => row.status === "created"));

  assert.equal(r2.summary.created, 0);
  assert.equal(r2.summary.deduped, 3);
  assert.equal(r2.summary.failed, 0);
  assert.ok(r2.results.every((row) => row.status === "deduped"), "her satır 'deduped' olmalı");
  // deduped satır MEVCUT kaydın id'sini taşır — kullanıcı hangi kayda çakıştığını görür.
  const ilkIdler = r1.results.map((row) => row.timeEntryId).sort();
  const ikinciIdler = r2.results.map((row) => row.timeEntryId).sort();
  assert.deepEqual(ikinciIdler, ilkIdler);
});

test("bulk KISMİ tekrar: yeni kalem 'created', eskiler 'deduped' — senaryo g'nin birim hâli", async () => {
  const ctx = makeCtx();
  const eskiler = [1, 2].map((i) => ({
    targetType: "time_allocation",
    targetId: ALLOCATION_ID,
    minutes: 30,
    description: `kismi kalem ${i}`,
  }));
  const r1 = await runBulk(ctx, { entries: eskiler, dryRun: false, stopOnError: false });
  assert.equal(r1.summary.created, 2);

  const hepsi = [
    ...eskiler,
    { targetType: "time_allocation", targetId: ALLOCATION_ID, minutes: 30, description: "kismi kalem yeni" },
  ];
  const r2 = await runBulk(ctx, { entries: hepsi, dryRun: false, stopOnError: false });
  assert.equal(r2.summary.deduped, 2);
  assert.equal(r2.summary.created, 1);
  assert.deepEqual(
    r2.results.map((row) => row.status),
    ["deduped", "deduped", "created"],
  );
  // totalMinutes yalnızca BU koşuda yazılan dakikaları sayar.
  assert.equal(r2.summary.totalMinutes, 30);
});

// ─────────────────────────────────────────────────────────────────────────────
// deterministicSourceId — dedup'ın temeli DEĞİŞMEMELİ
// ─────────────────────────────────────────────────────────────────────────────

test("★ deterministicSourceId formülü sabit: 'xmcp-' + sha256(targetType|targetId|minutes|date|startedAt|personId|description)[:16]", () => {
  const input = {
    targetType: "time_allocation",
    targetId: ALLOCATION_ID,
    minutes: 30,
    date: "2026-08-03",
    startedAt: "2026-08-03T09:00:00+03:00",
    personId: "TW9jay9QZXJzb24vMQ",
    description: "formül sabit",
  };
  const material = [
    input.targetType,
    input.targetId,
    String(input.minutes),
    input.date,
    input.startedAt,
    input.personId,
    input.description,
  ].join("|");
  const beklenen = "xmcp-" + createHash("sha256").update(material).digest("hex").slice(0, 16);
  assert.equal(deterministicSourceId(input, SABIT_YEREL_TARIH), beklenen);

  // Boş alanlar boş string'e düşer, date boşsa today kullanılır — bu da sabittir.
  const eksik = { targetType: "request", targetId: "R1", minutes: 60 };
  const materialEksik = ["request", "R1", "60", SABIT_YEREL_TARIH, "", "", ""].join("|");
  assert.equal(
    deterministicSourceId(eksik, SABIT_YEREL_TARIH),
    "xmcp-" + createHash("sha256").update(materialEksik).digest("hex").slice(0, 16),
  );
});
