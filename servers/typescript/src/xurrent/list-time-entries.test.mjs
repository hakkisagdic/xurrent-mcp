/**
 * xurrent_list_time_entries birim testleri — AĞSIZ.
 *
 * İKİ KATMAN ölçülür:
 *   1. Mock adapter: personId/dateFrom/dateTo/sourceId filtreleri gerçekten
 *      süzüyor mu, totalMinutes doğru mu, kayıt şekli sözleşmedeki
 *      TimeEntryRecord ile aynı mı.
 *   2. Live adapter (fetch stub'lu): TEK timeEntries sorgusu, değişken adları
 *      BİREBİR personId/dateFrom/dateTo/sourceID — sahte sunucu ve sözleşme
 *      bu adları okur; bir harf kayarsa filtre SESSİZCE yok sayılır.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { MockXurrentAdapter } from "../../dist/xurrent/mock.js";
import { LiveXurrentAdapter } from "../../dist/xurrent/live.js";
import { createToolContext } from "../../dist/core/context.js";
import { runCreateTimeEntry, runListTimeEntries } from "../../dist/core/toolimpl.js";
import { ALLOCATION_ID, FIXTURES_DIR, ME_ID, REPO_ROOT } from "../_testkit.mjs";

function testCfg(overrides = {}) {
  return {
    repoRoot: REPO_ROOT,
    fixturesDir: FIXTURES_DIR,
    mode: "mock",
    token: "",
    account: "test-hesap",
    graphqlUrl: "http://127.0.0.1:1/",
    forceDryRun: false,
    confirmPolicy: "open",
    source: "xurrent-mcp",
    backdateStrategy: "two_step",
    maxBackdateDays: 1,
    retryMaxAttempts: 5,
    retryBaseMs: 0,
    retryCapMs: 0,
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
    wizardTtlSeconds: 1800,
    ...overrides,
  };
}

function makeCtx() {
  const cfg = testCfg();
  return createToolContext(cfg, new MockXurrentAdapter(cfg), async () => ({ action: "accept" }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock filtreleri
// ─────────────────────────────────────────────────────────────────────────────

test("filtresiz çağrı: fixture'daki 5 kayıt döner, totalMinutes toplamdır", async () => {
  const ctx = makeCtx();
  const r = await runListTimeEntries(ctx, {});
  assert.equal(r.accountId, "ornek-bt", "accountId fixtures'taki hesaptır");
  assert.equal(r.timeEntries.length, 5);
  // fixtures/time-entries.json: 60 + 30 + 45 + 30 + 240 = 405
  assert.equal(r.totalMinutes, 405);
  assert.equal(
    r.totalMinutes,
    r.timeEntries.reduce((a, e) => a + e.timeSpent, 0),
    "totalMinutes dönen kayıtların toplamı OLMAK ZORUNDA",
  );
});

test("personId filtresi: başka kişi için kayıt yok; varsayılan $me'dir", async () => {
  const ctx = makeCtx();
  const baska = await runListTimeEntries(ctx, { personId: "TW9jay9QZXJzb24vMg" });
  assert.equal(baska.timeEntries.length, 0);
  assert.equal(baska.totalMinutes, 0);

  const me = await runListTimeEntries(ctx, { personId: "$me" });
  const varsayilan = await runListTimeEntries(ctx, {});
  assert.equal(me.timeEntries.length, varsayilan.timeEntries.length, "$me varsayılandır");
  assert.ok(me.timeEntries.every((e) => e.person?.id === ME_ID));
});

test("dateFrom/dateTo aralığı DAHİLDİR: iki uç da sonuca girer", async () => {
  const ctx = makeCtx();
  const hepsi = await runListTimeEntries(ctx, {});
  const tarihler = [...new Set(hepsi.timeEntries.map((e) => e.date))].sort();
  assert.ok(tarihler.length >= 3, "fixture'da en az 3 farklı gün olmalı");

  const from = tarihler[0];
  const to = tarihler[1];
  const aralik = await runListTimeEntries(ctx, { dateFrom: from, dateTo: to });
  assert.ok(aralik.timeEntries.length > 0);
  assert.ok(aralik.timeEntries.every((e) => e.date >= from && e.date <= to));
  // Uçlar dahil: from gününün kaydı da to gününün kaydı da listede.
  assert.ok(aralik.timeEntries.some((e) => e.date === from), "dateFrom DAHİL olmalı");
  assert.ok(aralik.timeEntries.some((e) => e.date === to), "dateTo DAHİL olmalı");

  const tek = await runListTimeEntries(ctx, { dateFrom: to, dateTo: to });
  assert.ok(tek.timeEntries.every((e) => e.date === to));
});

test("★ sourceId nokta araması: yazılan kaydı idempotency anahtarıyla bulur (dedup geri-okuması)", async () => {
  const ctx = makeCtx();
  const yaz = await runCreateTimeEntry(ctx, {
    targetType: "time_allocation",
    targetId: ALLOCATION_ID,
    minutes: 30,
    description: "geri-okuma testi",
    dryRun: false,
  });
  assert.equal(yaz.errors.length, 0);
  const sid = yaz.timeEntry?.sourceID;
  assert.ok(typeof sid === "string" && sid.startsWith("xmcp-"), "Yol A kaydı deterministik sourceID taşır");

  const r = await runListTimeEntries(ctx, { sourceId: sid });
  assert.equal(r.timeEntries.length, 1, "sourceId TAM eşleşmedir — tek kayıt döner");
  assert.equal(r.timeEntries[0].sourceID, sid);
  assert.equal(r.timeEntries[0].timeSpent, 30);
  assert.equal(r.totalMinutes, 30);
  // Yol A kaydı: assignment=null (dersin kalbi).
  assert.equal(r.timeEntries[0].assignment, null);

  const yok = await runListTimeEntries(ctx, { sourceId: "xmcp-olmayananahtar" });
  assert.equal(yok.timeEntries.length, 0);
});

test("first sayfa boyutunu sınırlar", async () => {
  const ctx = makeCtx();
  const r = await runListTimeEntries(ctx, { first: 2 });
  assert.equal(r.timeEntries.length, 2);
  assert.equal(
    r.totalMinutes,
    r.timeEntries.reduce((a, e) => a + e.timeSpent, 0),
    "totalMinutes DÖNEN kayıtların toplamıdır, store'un değil",
  );
});

test("Yol B yazması assignment ile döner: type/displayId dolu", async () => {
  const ctx = makeCtx();
  const yaz = await runCreateTimeEntry(ctx, {
    targetType: "request",
    targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4",
    minutes: 30,
    description: "bagli kayit",
    backdateStrategy: "link_first",
    dryRun: false,
  });
  assert.equal(yaz.errors.length, 0);

  const r = await runListTimeEntries(ctx, {});
  const bagli = r.timeEntries.find((e) => e.description === "bagli kayit");
  assert.ok(bagli, "yazılan kayıt geri-okunabilmeli");
  assert.equal(bagli.assignment?.type, "Request");
  assert.equal(bagli.assignment?.displayId, "70248", "displayId Request'te requestId'den gelir");
});

// ─────────────────────────────────────────────────────────────────────────────
// Live: sorgu şekli (fetch stub — ağ yok)
// ─────────────────────────────────────────────────────────────────────────────

function stubFetch(responses) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const next = responses.shift();
    assert.ok(next, "beklenenden fazla HTTP isteği");
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

const liveNode = {
  id: "TE-1",
  date: "2026-08-01",
  startedAt: "2026-08-01T14:00:00+03:00",
  timeSpent: 120,
  description: "canli kayit",
  correction: false,
  source: "xurrent-mcp",
  sourceID: "xmcp-abc",
  person: { id: "P-1", name: "Ayşe Demir" },
  effortClass: { id: "EC-1", name: "Normal" },
  assignment: { __typename: "Request", id: "R-1", requestId: 70248 },
};

test("★ live: TEK timeEntries sorgusu, değişken adları BİREBİR personId/dateFrom/dateTo/sourceID", async () => {
  const stub = stubFetch([{ data: { timeEntries: { nodes: [liveNode] } } }]);
  try {
    const adapter = new LiveXurrentAdapter(testCfg({ mode: "live", token: "t", account: "test-hesap" }));
    const r = await adapter.listTimeEntries({
      personId: "P-1",
      dateFrom: "2026-08-01",
      dateTo: "2026-08-02",
      sourceId: "xmcp-abc",
      first: 10,
    });

    assert.equal(stub.calls.length, 1, "TEK HTTP isteği — tek sorgu");
    const body = stub.calls[0];
    assert.match(body.query, /timeEntries\(/, "kök alan timeEntries olmalı");
    // Değişken ADLARI sözleşmenin parçasıdır (sahte sunucu tam bunları okur).
    assert.deepEqual(
      Object.keys(body.variables).sort(),
      ["dateFrom", "dateTo", "first", "personId", "sourceID"],
      "değişken adları sözleşmeyle birebir aynı olmalı",
    );
    assert.equal(body.variables.personId, "P-1");
    assert.equal(body.variables.dateFrom, "2026-08-01");
    assert.equal(body.variables.dateTo, "2026-08-02");
    assert.equal(body.variables.sourceID, "xmcp-abc");
    // personId yine String! deklare edilir (ID! değil) — PersonReferenceFilter.values [String]!
    assert.match(body.query, /\$personId:\s*String!/);

    // Eşleme: assignment.__typename → type, requestId → displayId (string).
    assert.equal(r.timeEntries.length, 1);
    assert.deepEqual(r.timeEntries[0].assignment, { type: "Request", id: "R-1", displayId: "70248" });
    assert.equal(r.timeEntries[0].person.name, "Ayşe Demir");
    assert.equal(r.accountId, "test-hesap");
  } finally {
    stub.restore();
  }
});

test("live: filtre verilmeyince personId=$me gider, diğer filtreler null (filtre YOK anlamında)", async () => {
  const stub = stubFetch([{ data: { timeEntries: { nodes: [] } } }]);
  try {
    const adapter = new LiveXurrentAdapter(testCfg({ mode: "live", token: "t", account: "test-hesap" }));
    await adapter.listTimeEntries({});
    const v = stub.calls[0].variables;
    assert.equal(v.personId, "$me", "personId varsayılanı $me — sihirli değer değişkenden geçer");
    assert.equal(v.dateFrom, null);
    assert.equal(v.dateTo, null);
    assert.equal(v.sourceID, null);
    assert.equal(v.first, 25);
  } finally {
    stub.restore();
  }
});
