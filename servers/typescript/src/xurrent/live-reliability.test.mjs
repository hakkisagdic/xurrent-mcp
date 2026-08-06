/**
 * ★ CANLI ADAPTÖRÜN GÜVENİLİRLİK TESTİ — fetch stub'lanır, ağ YOKTUR.
 *
 * NE KANITLIYOR: retry.test.mjs politikayı soyut olarak ölçer; burada ise
 * politikanın LiveXurrentAdapter'a GERÇEKTEN bağlandığı ölçülür:
 *   - execute() her adımı doğru operasyon sınıfıyla çalıştırıyor mu?
 *   - guarded_create'in 5xx kurtarması dedup geri-okumasını atıp mevcut kaydı
 *     İKİNCİ POST OLMADAN döndürüyor mu?
 *   - payload iş-kuralı hataları (HTTP 200 + errors dolu) retry katmanına
 *     hiç girmiyor mu?
 *
 * fetch globalThis üzerinden stub'lanır (repo DI kullanmıyor; adapter düz
 * global fetch çağırır) ve her testin sonunda GERİ KOYULUR.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LiveXurrentAdapter } from "../../dist/xurrent/live.js";

// ── yardımcılar ──────────────────────────────────────────────────────────────

function cfg(overrides = {}) {
  return {
    graphqlUrl: "http://127.0.0.1:1/", // stub'lı fetch'te hiç kullanılmaz
    token: "test-token",
    account: "test-hesap",
    timeZone: "Europe/Istanbul",
    // Testler beklemesiz koşsun: taban/tavan 0 → jitter 0. Retry SAYISI yine gerçek.
    retryMaxAttempts: 5,
    retryBaseMs: 0,
    retryCapMs: 0,
    minRequestGapMs: 0,
    ...overrides,
  };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/**
 * Sıralı fetch stub'u: her çağrının gövdesini kaydeder, script'ten yanıt döner.
 * Script biterse test hatalı — beklenenden fazla HTTP isteği atılmış demektir.
 */
function stubFetch(script) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const step = script.shift();
    assert.ok(step, `beklenenden fazla HTTP isteği: ${body.query.slice(0, 60)}...`);
    return typeof step === "function" ? step(body) : step;
  };
  return { calls, restore: () => (globalThis.fetch = orig) };
}

/** stderr'i sustur ve satırları topla ([retry]/[dedup] izleri buradan sayılır). */
function captureStderr() {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  return { lines, restore: () => (process.stderr.write = orig) };
}

const createStep = (sourceID = "xmcp-testsourceid1") => ({
  index: 0,
  path: "timeEntryCreate",
  mutation: "mutation CreateTimeEntry($input: TimeEntryCreateInput!) { timeEntryCreate(input: $input) { errors { message } timeEntry { id } } }",
  input: { input: { timeSpent: 30, timeAllocationId: "TA-1", source: "xurrent-mcp", sourceID } },
  warnings: [],
  stepLabel: null,
});

const parentStep = () => ({
  index: 0,
  path: "requestUpdate",
  mutation: "mutation AddTimeToRequest($input: RequestUpdateInput!) { requestUpdate(input: $input) { errors { message } request { id } } }",
  input: { input: { id: "REQ-1", timeSpent: 60 } },
  warnings: [],
  stepLabel: null,
});

// ─────────────────────────────────────────────────────────────────────────────

test("★ guarded_create + 500: dedup geri-okuması mevcut kaydı bulur → İKİNCİ POST YOK, sonuç mevcut kayıt", async () => {
  const mevcut = { id: "TE-VAR", date: "2026-08-04", timeSpent: 30, sourceID: "xmcp-testsourceid1" };
  const fx = stubFetch([
    // 1) timeEntryCreate → 500 (belirsiz: yazma ULAŞMIŞ olabilir)
    json({ errors: [{ message: "patladı" }] }, 500),
    // 2) dedup geri-okuması (TimeEntryBySourceId) → kayıt BULUNDU
    json({ data: { timeEntries: { nodes: [mevcut] } } }),
    // ★ script burada biter: üçüncü bir istek (çift POST) atılırsa test düşer.
  ]);
  const cap = captureStderr();
  try {
    const adapter = new LiveXurrentAdapter(cfg());
    const out = await adapter.execute([createStep()]);
    assert.equal(out.errors.length, 0, "kurtarma BAŞARI sayılmalı");
    assert.equal(out.executed, 1);
    assert.deepEqual(out.timeEntry, mevcut, "mevcut kayıt döndürülmeli");
  } finally {
    cap.restore();
    fx.restore();
  }
  // POST sayısı: 1 create + 1 sorgu. Çift kayıt = tam olarak ikinci bir create olurdu.
  const createler = fx.calls.filter((c) => c.query.includes("timeEntryCreate"));
  assert.equal(createler.length, 1, "timeEntryCreate BİR kez gönderilmeli");
  const sorgular = fx.calls.filter((c) => c.query.includes("TimeEntryBySourceId"));
  assert.equal(sorgular.length, 1);
  assert.equal(sorgular[0].variables.sourceID, "xmcp-testsourceid1", "değişken adı BİREBİR 'sourceID' olmalı");
  const dedup = cap.lines.filter((l) => l.startsWith("[dedup]"));
  assert.deepEqual(dedup, ["[dedup] op=timeEntryCreate sourceID=xmcp-testsourceid1 hit=true\n"]);
});

test("guarded_create + 500: geri-okuma BOŞ dönerse retry devam eder ve yeni kayıt oluşur", async () => {
  const fx = stubFetch([
    json({ errors: [{ message: "patladı" }] }, 500), // create #1 → 500
    json({ data: { timeEntries: { nodes: [] } } }), // geri-okuma → yok
    json({ data: { timeEntryCreate: { errors: [], timeEntry: { id: "TE-YENI" } } } }), // create #2 → tamam
  ]);
  const cap = captureStderr();
  try {
    const adapter = new LiveXurrentAdapter(cfg());
    const out = await adapter.execute([createStep()]);
    assert.equal(out.errors.length, 0);
    assert.equal(out.timeEntry.id, "TE-YENI");
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.match(cap.lines.join(""), /\[dedup\] op=timeEntryCreate sourceID=xmcp-testsourceid1 hit=false\n/);
  assert.match(cap.lines.join(""), /\[retry\] op=timeEntryCreate attempt=1\/5 reason=5xx waitMs=\d+\n/);
});

test("★ 429 parent update'te BİLE retry edilir (kesin-işlenmedi) ve Retry-After'a uyulur", async () => {
  const fx = stubFetch([
    json({ errors: [{ message: "rate limit" }] }, 429, { "retry-after": "0" }),
    json({ data: { requestUpdate: { errors: [], request: { id: "REQ-1" } } } }),
  ]);
  const cap = captureStderr();
  try {
    const adapter = new LiveXurrentAdapter(cfg());
    const out = await adapter.execute([parentStep()]);
    assert.equal(out.errors.length, 0, "429 sonrası retry başarıyla bitmeli");
    assert.equal(out.executed, 1);
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 2);
  assert.match(cap.lines.join(""), /\[retry\] op=requestUpdate attempt=1\/5 reason=429 waitMs=0\n/);
});

test("★ 500 parent update'te ASLA retry edilmez; hata 'kayıt oluşmuş olabilir' uyarısı taşır", async () => {
  const fx = stubFetch([
    json({ errors: [{ message: "iç hata" }] }, 500),
    // script bitti: ikinci istek atılırsa (yasak retry) stub assert düşürür.
  ]);
  const cap = captureStderr();
  let out;
  try {
    const adapter = new LiveXurrentAdapter(cfg());
    out = await adapter.execute([parentStep()]);
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 1, "belirsiz hatada parent update TEKRARLANAMAZ — timeSpent artımlı");
  assert.equal(out.executed, 0);
  assert.equal(out.errors.length, 1);
  // Sözleşme: kullanıcıya yazmanın ULAŞMIŞ OLABİLECEĞİ ve ticket'ı kontrol etmesi söylenir.
  assert.match(out.errors[0].message, /ulaşmış ve İŞLENMİŞ olabilir/);
  assert.match(out.errors[0].message, /[Tt]icket/);
  assert.equal(cap.lines.filter((l) => l.startsWith("[retry]")).length, 0);
});

test("timeEntryUpdate (idempotent_update): 500 sonrası retry EDİLİR — mutlak SET tekrarı zararsız", async () => {
  const fx = stubFetch([
    json({ errors: [{ message: "iç hata" }] }, 500),
    json({ data: { timeEntryUpdate: { errors: [], timeEntry: { id: "TE-3" } } } }),
  ]);
  const step = {
    index: 0,
    path: "timeEntryUpdate",
    mutation: "mutation FixTimeEntry($input: TimeEntryUpdateInput!) { timeEntryUpdate(input: $input) { errors { message } timeEntry { id } } }",
    input: { input: { id: "TE-3", date: "2026-08-03" } },
    warnings: [],
    stepLabel: null,
  };
  const cap = captureStderr();
  try {
    const adapter = new LiveXurrentAdapter(cfg());
    const out = await adapter.execute([step]);
    assert.equal(out.errors.length, 0);
    assert.equal(out.timeEntry.id, "TE-3");
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 2);
  assert.match(cap.lines.join(""), /\[retry\] op=timeEntryUpdate attempt=1\/5 reason=5xx/);
});

test("★ iş-kuralı hatası (HTTP 200 + payload.errors dolu) ASLA retry edilmez", async () => {
  const fx = stubFetch([
    json({
      data: {
        timeEntryCreate: {
          errors: [{ message: "timeSpent (45) timeIncrement'in (30) katı değil.", path: ["timeSpent"] }],
          timeEntry: null,
        },
      },
    }),
  ]);
  const cap = captureStderr();
  let out;
  try {
    const adapter = new LiveXurrentAdapter(cfg());
    out = await adapter.execute([createStep()]);
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 1, "sunucu isteği ANLADI ve REDDETTİ — tekrar aynı reddi üretir");
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].message, /katı değil/);
  assert.equal(cap.lines.filter((l) => l.startsWith("[retry]")).length, 0);
});

test("GraphQL top-level errors da retry edilmez (kesin-reddedildi)", async () => {
  const fx = stubFetch([json({ errors: [{ message: "Tanınmayan sorgu." }] })]);
  const cap = captureStderr();
  let out;
  try {
    const adapter = new LiveXurrentAdapter(cfg());
    out = await adapter.execute([parentStep()]);
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 1);
  assert.equal(out.errors.length, 1);
});

test("findTimeEntryBySourceId: bulunan ilk node döner, yoksa null", async () => {
  const fx = stubFetch([
    json({ data: { timeEntries: { nodes: [{ id: "TE-9", sourceID: "xmcp-aaa" }] } } }),
    json({ data: { timeEntries: { nodes: [] } } }),
  ]);
  try {
    const adapter = new LiveXurrentAdapter(cfg());
    const hit = await adapter.findTimeEntryBySourceId("xmcp-aaa");
    assert.equal(hit.id, "TE-9");
    const miss = await adapter.findTimeEntryBySourceId("xmcp-yok");
    assert.equal(miss, null);
  } finally {
    fx.restore();
  }
});

test("retryMaxAttempts=2 (senaryo g ayarı): kalıcı 500'lü create toplam 2 deneme + 2 geri-okuma yapar", async () => {
  const fx = stubFetch([
    json({ errors: [{ message: "kalıcı kırık" }] }, 500), // create #1
    json({ data: { timeEntries: { nodes: [] } } }), // geri-okuma #1 → yok
    json({ errors: [{ message: "kalıcı kırık" }] }, 500), // create #2 (son deneme)
    json({ data: { timeEntries: { nodes: [] } } }), // geri-okuma #2 → yok
  ]);
  const cap = captureStderr();
  let out;
  try {
    const adapter = new LiveXurrentAdapter(cfg({ retryMaxAttempts: 2 }));
    out = await adapter.execute([createStep()]);
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.filter((c) => c.query.includes("timeEntryCreate")).length, 2);
  assert.equal(out.errors.length, 1, "kalem düşer — bulk bunu 'failed' raporlar, tekrar-çalıştırma kurtarır");
  assert.match(cap.lines.join(""), /\[retry\] op=timeEntryCreate attempt=1\/2 reason=5xx/);
});
