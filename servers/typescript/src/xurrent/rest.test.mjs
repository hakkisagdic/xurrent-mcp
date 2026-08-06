/**
 * ★ REST v1 ADAPTÖRÜNÜN TESTİ — fetch stub'lanır, ağ YOKTUR.
 *
 * NE KANITLIYOR (live-reliability.test.mjs'in REST ikizi):
 *   - endpoint/param eşlemesi: /me + /account, /people?primary_email=,
 *     /requests?member= + /tasks?assignee=, üçlü context, /time_entries filtreleri
 *     (operatör DEĞERİN içinde: ?date=>=X<=Y — developer.xurrent.com/v1/general/filtering)
 *   - snake_case → içsel şekil normalizasyonu (started_at → startedAt, sourceID camel);
 *     yazarken referans alanları İD'SİZ (person, effort_class, time_allocation)
 *   - bağlı kayıt KOŞULLU request/task/problem/project_task referanslarından türetilir
 *     ("assignment" diye bir REST alanı yoktur)
 *   - 422 = {"message":"Validation Failed","errors":[["alan","mesaj"],...]} İKİLİLERİ →
 *     errors[] normalizasyonu: İSTİSNA DEĞİL, RETRY EDİLMEZ
 *   - operasyon sınıfları: GET=query, POST /time_entries=guarded_create,
 *     PATCH /time_entries/:id=idempotent_update, PATCH /requests|tasks/:id=no_retry
 *   - dedup geri-okuması GET /time_entries?sourceID= üzerinden
 *   - whoami'nin İKİ istekli akışı (GraphQL'in 1 sorgusuna öğretilen kontrast)
 *   - two_step: PATCH parent → GET en yeni kayıt → PATCH /time_entries/:id
 *   - Yol B'de time_entry_description parametresi YOKTUR: açıklama note'a düşer + uyarı
 *
 * fetch globalThis üzerinden stub'lanır (repo DI kullanmıyor) ve her testin
 * sonunda GERİ KOYULUR — mevcut güvenilirlik testlerinin deseniyle aynı.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { RestXurrentAdapter } from "../../dist/xurrent/rest.js";

// ── yardımcılar ──────────────────────────────────────────────────────────────

function cfg(overrides = {}) {
  return {
    restUrl: "http://127.0.0.1:1/v1", // stub'lı fetch'te hiç kullanılmaz
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
 * Sıralı fetch stub'u: URL + metot + gövde kaydeder, script'ten yanıt döner.
 * Script biterse test hatalı — beklenenden fazla HTTP isteği atılmış demektir.
 */
function stubFetch(script) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(init.body) : null,
      headers: init.headers ?? {},
    };
    calls.push(call);
    const step = script.shift();
    assert.ok(step, `beklenenden fazla HTTP isteği: ${call.method} ${call.url}`);
    return typeof step === "function" ? step(call) : step;
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

const ME_REST = {
  id: "P-ME",
  name: "Ayşe Demir",
  primary_email: "ayse.demir@ornek.com",
  job_title: "Kıdemli Sistem Uzmanı",
  time_zone: "Europe/Istanbul",
  disabled: false,
  organization: { id: "ORG-1", name: "Örnek A.Ş." },
};

const TE_REST = {
  id: "TE-1",
  date: "2026-08-04",
  started_at: "2026-08-04T14:00:00+03:00",
  time_spent: 60,
  description: "rest testi",
  correction: false,
  source: "xurrent-mcp",
  sourceID: "xmcp-abc123",
  person: { id: "P-ME", name: "Ayşe Demir" },
  effort_class: { id: "EC-1", name: "Normal mesai" },
  time_allocation: null,
  // ★ REST'te "assignment" alanı YOKTUR — bağlı kayıt koşullu referans nesnesidir.
  request: { id: "REQ-1" },
};

const createStep = (sourceID = "xmcp-abc123") => ({
  index: 0,
  path: "timeEntryCreate",
  mutation: "(graphql metni REST'te kullanılmaz)",
  input: {
    input: {
      timeSpent: 60,
      date: "2026-08-04",
      startedAt: "2026-08-04T14:00:00+03:00",
      timeAllocationId: "TA-1",
      effortClassId: "EC-1",
      description: "rest testi",
      source: "xurrent-mcp",
      sourceID,
      clientMutationId: sourceID, // REST gövdesine TAŞINMAMALI
    },
  },
  warnings: [],
  stepLabel: null,
});

const parentStep = (path = "requestUpdate", id = "REQ-1") => ({
  index: 0,
  path,
  mutation: "(graphql metni REST'te kullanılmaz)",
  input: {
    input: {
      id,
      timeSpent: 60,
      timeSpentEffortClassId: "EC-1",
      timeEntryDescription: "rest testi",
      clientMutationId: "x-1",
    },
  },
  warnings: [],
  stepLabel: "1/2",
});

// ─────────────────────────────────────────────────────────────────────────────
// Okuma uçları — endpoint/param eşlemesi + normalizasyon
// ─────────────────────────────────────────────────────────────────────────────

test("★ whoami: İKİ istek (GET /me + GET /account) — GraphQL'in tek sorgusuna öğretilen kontrast", async () => {
  const fx = stubFetch([
    json(ME_REST, 200, { "x-ratelimit-limit": "20", "x-ratelimit-remaining": "19", "x-ratelimit-reset": "2", "x-ratelimit-cost": "1" }),
    json({ id: "ornek-bt", name: "Örnek A.Ş. — BT", directory: false }),
  ]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const out = await adapter.whoami();
    assert.equal(fx.calls.length, 2, "whoami REST'te tam İKİ istektir");
    assert.match(fx.calls[0].url, /\/v1\/me$/);
    assert.equal(fx.calls[0].method, "GET");
    assert.match(fx.calls[1].url, /\/v1\/account$/);
    // Auth başlıkları GraphQL yolundakiyle aynı
    assert.equal(fx.calls[0].headers["Authorization"], "Bearer test-token");
    assert.equal(fx.calls[0].headers["X-Xurrent-Account"], "test-hesap");
    // snake_case → camelCase normalizasyonu
    assert.equal(out.person.primaryEmail, "ayse.demir@ornek.com");
    assert.equal(out.person.jobTitle, "Kıdemli Sistem Uzmanı");
    assert.equal(out.account.directory, false);
    // rate limit başlıkları GraphQL yolundaki gibi yakalanır
    assert.deepEqual(out.rateLimit, { limit: 20, cost: 1, remaining: 19, resetAt: 2 });

    // İkinci çağrı CACHE'ten döner — ek istek yok (bulk yazmada bütçe koruması).
    await adapter.whoami();
    assert.equal(fx.calls.length, 2, "whoami ikinci çağrıda istek ATMAMALI");
  } finally {
    fx.restore();
  }
});

test("findPerson: GET /people?primary_email= — TAM eşleşme parametresi, suggestFuzzy boşta true", async () => {
  const fx = stubFetch([json([ME_REST]), json([])]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const hit = await adapter.findPerson("ayse.demir@ornek.com", "all");
    assert.match(fx.calls[0].url, /\/v1\/people\?primary_email=ayse\.demir%40ornek\.com$/);
    assert.equal(hit.totalCount, 1);
    assert.equal(hit.people[0].primaryEmail, "ayse.demir@ornek.com");
    assert.equal(hit.suggestFuzzy, false);

    const miss = await adapter.findPerson("yok@ornek.com", "all");
    assert.equal(miss.totalCount, 0);
    assert.equal(miss.suggestFuzzy, true);
  } finally {
    fx.restore();
  }
});

test("★ listOpenWork($me): önce GET /me ile id çözülür, sonra ?member= ve ?assignee= — REST'te '$me' sihri YOK", async () => {
  const fx = stubFetch([
    json(ME_REST), // $me çözümü (whoami/me)
    json({ id: "ornek-bt", name: "x", directory: false }), // whoami/account
    json([
      { id: "REQ-1", subject: "VPN", status: "in_progress", next_target_at: "T1", updated_at: "T2", team: { name: "Ağ" }, member: { id: "P-ME", name: "Ayşe" }, time_spent: 30, source_display_id: "70248" },
      { id: "REQ-2", subject: "biten", status: "completed", team: null, member: null, source_display_id: "70249" },
    ]),
    json([
      { id: "TASK-1", subject: "Yama", status: "assigned", completion_target_at: "T3", updated_at: "T4", team: { name: "Ağ" }, member: { id: "P-ME", name: "Ayşe" }, workflow: { id: "W-1", subject: "Değişiklik" }, time_spent: 0, source_display_id: "9911" },
      { id: "TASK-2", subject: "iptal", status: "canceled", source_display_id: "9912" },
    ]),
  ]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const out = await adapter.listOpenWork({ personId: "$me" });
    assert.match(fx.calls[2].url, /\/v1\/requests\?member=P-ME$/, "member= GERÇEK id taşımalı, '$me' değil");
    assert.match(fx.calls[3].url, /\/v1\/tasks\?assignee=P-ME$/, "tasks'ta filtre adı assignee'dir (asimetri REST'te de yaşar)");
    // Kapalı durum elemesi client'ta: completed ve canceled düşer.
    assert.equal(out.requests.totalCount, 1);
    assert.equal(out.tasks.totalCount, 1);
    assert.equal(out.requests.nodes[0].displayId, "70248");
    assert.equal(out.requests.nodes[0].targetAt, "T1"); // next_target_at → targetAt
    assert.equal(out.tasks.nodes[0].targetAt, "T3"); // completion_target_at → targetAt
    assert.equal(out.tasks.nodes[0].parentLabel, "Değişiklik");
  } finally {
    fx.restore();
  }
});

test("getTimeTrackingContext: ÜÇ GET (timesheet_settings + effort_classes + time_allocations); disabled eleme CLIENT'ta", async () => {
  const fx = stubFetch([
    json([{
      id: "TS-1", name: "std", unit: "hours_and_minutes", workday: 480, workweek: 2400,
      time_increment: 30, percentage_increment: "12.5",
      allow_workday_overtime: false, allow_workweek_overtime: true,
      allocation_time_tracking: true, assignment_time_tracking: true,
      require_note: false, require_time_entry_description: false,
      request_effort_class: { id: "EC-1", name: "Normal" },
      task_effort_class: { id: "EC-1", name: "Normal" },
      project_task_effort_class: null, problem_effort_class: null,
      time_allocation_effort_class: { id: "EC-1", name: "Normal" },
    }]),
    json([
      { id: "EC-1", name: "Normal", position: 1, cost_multiplier: 1.0, disabled: false },
      { id: "EC-2", name: "Fazla mesai", position: 2, cost_multiplier: 1.5, disabled: false },
      { id: "EC-9", name: "Eski", position: 9, cost_multiplier: 1.0, disabled: true },
    ]),
    json([{ id: "TA-1", name: "İç toplantılar", group: "Genel", description_required: false }]),
  ]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const ctx = await adapter.getTimeTrackingContext("$me");
    assert.equal(fx.calls.length, 3, "context REST'te tam ÜÇ istektir");
    assert.match(fx.calls[0].url, /\/v1\/timesheet_settings$/);
    assert.match(fx.calls[1].url, /\/v1\/effort_classes$/);
    assert.match(fx.calls[2].url, /\/v1\/time_allocations$/);
    assert.equal(ctx.timeIncrement, 30, "time_increment → timeIncrement");
    assert.equal(ctx.allowWorkdayOvertime, false);
    assert.equal(ctx.effortClasses.length, 2, "disabled=true CLIENT tarafında elenmeli");
    assert.equal(ctx.timeAllocations[0].group, "Genel");
    assert.equal(ctx.defaults.requestEffortClassId, "EC-1");
    // Cache: ikinci çağrı istek atmaz.
    await adapter.getTimeTrackingContext("$me");
    assert.equal(fx.calls.length, 3);
  } finally {
    fx.restore();
  }
});

test("★ listTimeEntries: TEK date paramı, operatör değerin İÇİNDE (?date=>=X<=Y) + kayıt normalizasyonu", async () => {
  const fx = stubFetch([json([TE_REST])]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const page = await adapter.listTimeEntries({
      personId: "P-2", // "$me" DEĞİL → /me çözümü gerekmez
      dateFrom: "2026-08-01",
      dateTo: "2026-08-04",
      sourceId: "xmcp-abc123",
    });
    const u = new URL(fx.calls[0].url);
    assert.equal(u.pathname, "/v1/time_entries");
    assert.equal(u.searchParams.get("person"), "P-2");
    // ★ date_from/date_to diye parametreler YOKTUR (v1/general/filtering) —
    // kapalı aralık tek "date" değerinin içinde taşınır (URL kodlaması normal).
    assert.equal(u.searchParams.get("date_from"), null, "date_from GERÇEKTE YOK — gönderilmemeli");
    assert.equal(u.searchParams.get("date_to"), null, "date_to GERÇEKTE YOK — gönderilmemeli");
    assert.equal(u.searchParams.get("date"), ">=2026-08-01<=2026-08-04");
    assert.equal(u.searchParams.get("sourceID"), "xmcp-abc123", "sourceID camel KALIR — tek istisna");
    const rec = page.timeEntries[0];
    assert.equal(rec.startedAt, "2026-08-04T14:00:00+03:00", "started_at → startedAt");
    assert.equal(rec.timeSpent, 60, "time_spent → timeSpent");
    assert.equal(rec.sourceID, "xmcp-abc123");
    // ★ request:{id} referansından türetilir — REST'te "assignment" alanı yoktur.
    assert.deepEqual(rec.assignment, { type: "Request", id: "REQ-1", displayId: null });
    assert.deepEqual(rec.effortClass, { id: "EC-1", name: "Normal mesai" });
  } finally {
    fx.restore();
  }
});

test("listTimeEntries: tek uçlu aralıklar — yalnız from '>=X', yalnız to '<=X', from=to eşitlik", async () => {
  const fx = stubFetch([json([]), json([]), json([])]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    await adapter.listTimeEntries({ personId: "P-2", dateFrom: "2026-08-01" });
    await adapter.listTimeEntries({ personId: "P-2", dateTo: "2026-08-04" });
    await adapter.listTimeEntries({ personId: "P-2", dateFrom: "2026-08-04", dateTo: "2026-08-04" });
    assert.equal(new URL(fx.calls[0].url).searchParams.get("date"), ">=2026-08-01");
    assert.equal(new URL(fx.calls[1].url).searchParams.get("date"), "<=2026-08-04");
    assert.equal(new URL(fx.calls[2].url).searchParams.get("date"), "2026-08-04", "from=to → düz eşitlik");
  } finally {
    fx.restore();
  }
});

test("★ timeEntry normalizasyonu: task/problem/project_task referansları da assignment'a çevrilir", async () => {
  const fx = stubFetch([
    json([{ ...TE_REST, request: undefined, task: { id: "TASK-1" } }]),
    json([{ ...TE_REST, request: undefined, project_task: { id: "PT-1" } }]),
    json([{ ...TE_REST, request: undefined }]), // hiçbiri yok → assignment null
  ]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const t1 = (await adapter.listTimeEntries({ personId: "P-2" })).timeEntries[0];
    assert.deepEqual(t1.assignment, { type: "Task", id: "TASK-1", displayId: null });
    const t2 = (await adapter.listTimeEntries({ personId: "P-2" })).timeEntries[0];
    assert.deepEqual(t2.assignment, { type: "ProjectTask", id: "PT-1", displayId: null });
    const t3 = (await adapter.listTimeEntries({ personId: "P-2" })).timeEntries[0];
    assert.equal(t3.assignment, null, "bağlı kayıt referansı yoksa assignment null");
  } finally {
    fx.restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Yazma — 422 modeli, retry sınıfları, dedup, two_step
// ─────────────────────────────────────────────────────────────────────────────

test("★ Yol A: POST /time_entries snake_case + İD'SİZ referans adlarıyla; clientMutationId gövdeye SIZMAZ", async () => {
  const fx = stubFetch([json(TE_REST, 201)]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const out = await adapter.execute([createStep()]);
    assert.equal(out.errors.length, 0);
    assert.equal(out.executed, 1);
    const call = fx.calls[0];
    assert.equal(call.method, "POST");
    assert.match(call.url, /\/v1\/time_entries$/);
    // ★ Referanslar İD'SİZ ad + düz id: time_allocation, effort_class
    // (developer.xurrent.com/v1/time_entries — time_allocation_id DEĞİL).
    assert.deepEqual(call.body, {
      time_spent: 60,
      date: "2026-08-04",
      started_at: "2026-08-04T14:00:00+03:00",
      time_allocation: "TA-1",
      effort_class: "EC-1",
      description: "rest testi",
      source: "xurrent-mcp",
      sourceID: "xmcp-abc123",
    });
    // Yanıt içsel şekle normalize edildi
    assert.equal(out.timeEntry.startedAt, "2026-08-04T14:00:00+03:00");
    assert.equal(out.timeEntry.timeSpent, 60);
  } finally {
    fx.restore();
  }
});

test("★ 422 = iş kuralı reddi: [alan, mesaj] İKİLİLERİ errors[]'a normalize edilir, İSTİSNA DEĞİL, RETRY YOK", async () => {
  const fx = stubFetch([
    // ★ Belgelenen gövde biçimi: message + İKİLİ DİZİLER (nesne değil)
    // (developer.xurrent.com/v1/#http-status-codes).
    json({
      message: "Validation Failed",
      errors: [["time_spent", "timeSpent (45) timeIncrement'in (30) katı değil."]],
    }, 422),
    // script bitti: retry edilirse stub assert düşürür.
  ]);
  const cap = captureStderr();
  let out;
  try {
    const adapter = new RestXurrentAdapter(cfg());
    out = await adapter.execute([createStep()]);
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 1, "422 kesin-reddedildi'dir — tekrar aynı reddi üretir");
  assert.equal(out.executed, 0);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].message, /katı değil/, "mesaj = ikilinin 2. elemanı");
  assert.deepEqual(out.errors[0].path, ["time_spent"], "path = [ikilinin 1. elemanı]");
  assert.equal(cap.lines.filter((l) => l.startsWith("[retry]")).length, 0);
});

test("★ guarded_create + 500: dedup geri-okuması (GET ?sourceID=) kaydı bulur → İKİNCİ POST YOK", async () => {
  const fx = stubFetch([
    json({ message: "patladı" }, 500), // POST → 500 (belirsiz)
    json([TE_REST]), // GET /time_entries?sourceID= → kayıt VAR
    // ★ script burada biter: üçüncü istek (çift POST) atılırsa test düşer.
  ]);
  const cap = captureStderr();
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const out = await adapter.execute([createStep()]);
    assert.equal(out.errors.length, 0, "kurtarma BAŞARI sayılmalı");
    assert.equal(out.executed, 1);
    assert.equal(out.timeEntry.id, "TE-1", "mevcut kayıt (normalize) dönmeli");
  } finally {
    cap.restore();
    fx.restore();
  }
  const posts = fx.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1, "POST /time_entries BİR kez gönderilmeli");
  const readback = fx.calls.find((c) => c.url.includes("sourceID="));
  assert.ok(readback, "geri-okuma sourceID paramıyla yapılmalı");
  assert.equal(new URL(readback.url).searchParams.get("sourceID"), "xmcp-abc123");
  const dedup = cap.lines.filter((l) => l.startsWith("[dedup]"));
  assert.deepEqual(dedup, ["[dedup] op=timeEntryCreate sourceID=xmcp-abc123 hit=true\n"]);
});

test("guarded_create + 500: geri-okuma BOŞ dönerse retry devam eder ve yeni kayıt oluşur", async () => {
  const fx = stubFetch([
    json({ message: "patladı" }, 500), // POST #1 → 500
    json([]), // geri-okuma → yok
    json(TE_REST, 201), // POST #2 → tamam
  ]);
  const cap = captureStderr();
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const out = await adapter.execute([createStep()]);
    assert.equal(out.errors.length, 0);
    assert.equal(out.timeEntry.id, "TE-1");
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.match(cap.lines.join(""), /\[dedup\] op=timeEntryCreate sourceID=xmcp-abc123 hit=false\n/);
  assert.match(cap.lines.join(""), /\[retry\] op=timeEntryCreate attempt=1\/5 reason=5xx waitMs=\d+\n/);
});

test("★ PATCH /requests/:id + 500: ASLA retry (no_retry) — hata 'ulaşmış olabilir' uyarısı taşır", async () => {
  const fx = stubFetch([
    json({ message: "iç hata" }, 500),
    // script bitti: ikinci istek atılırsa (yasak retry) stub assert düşürür.
  ]);
  const cap = captureStderr();
  let out;
  try {
    const adapter = new RestXurrentAdapter(cfg());
    out = await adapter.execute([parentStep()]);
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 1, "belirsiz hatada parent PATCH TEKRARLANAMAZ — time_spent artımlı");
  assert.equal(fx.calls[0].method, "PATCH");
  assert.match(fx.calls[0].url, /\/v1\/requests\/REQ-1$/);
  assert.equal(out.executed, 0);
  assert.match(out.errors[0].message, /ulaşmış ve İŞLENMİŞ olabilir/);
  assert.equal(cap.lines.filter((l) => l.startsWith("[retry]")).length, 0);
});

test("PATCH /requests/:id + 429: retry EDİLİR (kesin-işlenmedi) ve Retry-After'a uyulur", async () => {
  const fx = stubFetch([
    // Transport hataları gövdeyi {"message": "..."} biçiminde taşır (dokümandaki 429 örneği).
    json({ message: "Too Many Requests" }, 429, { "retry-after": "0" }),
    json({ id: "REQ-1", subject: "VPN", status: "in_progress", time_spent: 90 }),
  ]);
  const cap = captureStderr();
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const out = await adapter.execute([parentStep()]);
    assert.equal(out.errors.length, 0, "429 sonrası retry başarıyla bitmeli");
    assert.equal(out.executed, 1);
    assert.equal(out.timeEntry, null, "parent PATCH yanıtı timeEntry TAŞIMAZ (GraphQL paritesi)");
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 2);
  assert.match(cap.lines.join(""), /\[retry\] op=requestUpdate attempt=1\/5 reason=429 waitMs=0\n/);
});

test("★ Yol B gövdesi: time_spent + time_spent_effort_class (İD'SİZ) + note — time_entry_description YOK, açıklama note'a düşer + uyarı", async () => {
  const fx = stubFetch([json({ id: "REQ-1", subject: "VPN", status: "in_progress", time_spent: 90 })]);
  const cap = captureStderr();
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const out = await adapter.execute([parentStep()]);
    assert.equal(out.errors.length, 0);
  } finally {
    cap.restore();
    fx.restore();
  }
  // ★ Parametre adları developer.xurrent.com/v1/requests'teki update parametreleri:
  // time_spent_effort_class_id DEĞİL, time_entry_description diye bir parametre HİÇ YOK.
  assert.deepEqual(fx.calls[0].body, {
    time_spent: 60,
    time_spent_effort_class: "EC-1",
    note: "Zaman girişi açıklaması: rest testi",
  });
  // Kayıp bilgi SESSİZ geçilmez: adaptör stderr'e uyarı düşer.
  assert.match(
    cap.lines.join(""),
    /Yol B'de açıklama time entry'ye taşınamaz; note'a yazıldı/,
    "açıklamanın note'a düştüğü uyarıyla söylenmeli",
  );
});

test("PATCH /time_entries/:id (idempotent_update) + 500: retry EDİLİR — mutlak SET tekrarı zararsız", async () => {
  const fx = stubFetch([
    json({ message: "iç hata" }, 500),
    json({ ...TE_REST, id: "TE-3", date: "2026-08-03" }),
  ]);
  const step = {
    index: 0,
    path: "timeEntryUpdate",
    mutation: "(kullanılmaz)",
    input: { input: { id: "TE-3", date: "2026-08-03", timeSpent: 90 } },
    warnings: [],
    stepLabel: null,
  };
  const cap = captureStderr();
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const out = await adapter.execute([step]);
    assert.equal(out.errors.length, 0);
    assert.equal(out.timeEntry.id, "TE-3");
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.length, 2);
  assert.equal(fx.calls[0].method, "PATCH");
  assert.match(fx.calls[0].url, /\/v1\/time_entries\/TE-3$/);
  assert.deepEqual(fx.calls[0].body, { time_spent: 90, date: "2026-08-03" }, "gövde snake_case");
  assert.match(cap.lines.join(""), /\[retry\] op=timeEntryUpdate attempt=1\/5 reason=5xx/);
});

test("★ two_step REST'te: PATCH parent → GET ?person&date=bugün (en yeni) → PATCH /time_entries/:id (source/sourceID yazılır)", async () => {
  const PENDING = (await import("../../dist/xurrent/strategies.js")).PENDING_TIME_ENTRY_ID;
  const fx = stubFetch([
    // 1/2: parent PATCH — yanıt TimeEntry TAŞIMAZ → id bilinmiyor
    json({ id: "REQ-1", subject: "VPN", status: "in_progress", time_spent: 60 }),
    // ara: $me çözümü (whoami: /me + /account)
    json(ME_REST),
    json({ id: "ornek-bt", name: "x", directory: false }),
    // ara: bugünün kayıtları — liste YENİDEN-ESKİYE gelir, ilk eleman en yenidir
    json([{ ...TE_REST, id: "TE-YENI", sourceID: null }, { ...TE_REST, id: "TE-ESKI" }]),
    // 2/2: düzeltme PATCH'i
    json({ ...TE_REST, id: "TE-YENI", date: "2026-08-03" }),
  ]);
  const cap = captureStderr(); // 1/2'nin "açıklama note'a düştü" uyarısı stderr'e gider
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const step2 = {
      index: 1,
      path: "timeEntryUpdate",
      mutation: "(kullanılmaz)",
      input: {
        input: {
          id: PENDING,
          date: "2026-08-03",
          startedAt: "2026-08-03T14:00:00+03:00",
          description: "rest testi", // ★ 2. adım description'ı DÜZELTİR (Yol B taşıyamamıştı)
          source: "xurrent-mcp",
          sourceID: "xmcp-abc123",
          clientMutationId: "xmcp-abc123-2",
        },
      },
      warnings: [],
      stepLabel: "2/2",
    };
    const out = await adapter.execute([parentStep(), step2]);
    assert.equal(out.errors.length, 0);
    assert.equal(out.executed, 2);
    // 1/2: Yol B gövdesi — açıklama note içinde gider (time_entry_description YOK)
    assert.equal(fx.calls[0].body.note, "Zaman girişi açıklaması: rest testi");
    assert.equal(fx.calls[0].body.time_entry_description, undefined);
    // Ara sorgu: date= paramı BUGÜN olmalı (tam eşleşme; aralık operatörü değil)
    const ara = fx.calls.find((c) => c.url.includes("/time_entries?"));
    const sp = new URL(ara.url).searchParams;
    assert.equal(sp.get("person"), "P-ME");
    const gun = sp.get("date");
    assert.match(gun ?? "", /^\d{4}-\d{2}-\d{2}$/, "bugünün kayıtları düz eşitlikle sorgulanır");
    // Son çağrı: çözülen id'ye PATCH + source/sourceID/description gövdede
    const last = fx.calls[fx.calls.length - 1];
    assert.equal(last.method, "PATCH");
    assert.match(last.url, /\/v1\/time_entries\/TE-YENI$/, "en yeni kayıt (ilk eleman) seçilmeli");
    assert.equal(last.body.sourceID, "xmcp-abc123", "dedup kimliği 2. adımda yazılır");
    assert.equal(last.body.source, "xurrent-mcp");
    assert.equal(last.body.date, "2026-08-03");
    assert.equal(last.body.description, "rest testi", "nihai kayıtta description DOĞRU yerde biter");
  } finally {
    cap.restore();
    fx.restore();
  }
});

test("findTimeEntryBySourceId: bulunan ilk kayıt normalize döner; boşta null; hata fail-open null", async () => {
  const fx = stubFetch([
    json([TE_REST]),
    json([]),
    json({ message: "kapı yok" }, 404),
  ]);
  const cap = captureStderr();
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const hit = await adapter.findTimeEntryBySourceId("xmcp-abc123");
    assert.equal(hit.id, "TE-1");
    assert.equal(hit.timeSpent, 60, "normalize kayıt dönmeli (time_spent → timeSpent)");
    const miss = await adapter.findTimeEntryBySourceId("xmcp-yok");
    assert.equal(miss, null);
    const fail = await adapter.findTimeEntryBySourceId("xmcp-hata");
    assert.equal(fail, null, "geri-okuma hatası fail-open'dır: kayıt yok varsayılır");
  } finally {
    cap.restore();
    fx.restore();
  }
});

test("usage: GET /time_entries?person&date=>=haftabaşı<=haftasonu — gün ve hafta toplamları", async () => {
  const fx = stubFetch([
    json([
      { date: "2026-08-04", time_spent: 60 },
      { date: "2026-08-04", time_spent: 30 },
      { date: "2026-08-03", time_spent: 120 },
    ]),
  ]);
  try {
    const adapter = new RestXurrentAdapter(cfg());
    const u = await adapter.usage("P-2", "2026-08-04");
    const sp = new URL(fx.calls[0].url).searchParams;
    assert.equal(sp.get("person"), "P-2");
    // ★ Kapalı hafta aralığı TEK date değerinin içinde: Pzt 08-03 .. Paz 08-09.
    assert.equal(sp.get("date"), ">=2026-08-03<=2026-08-09");
    assert.equal(sp.get("date_from"), null, "date_from GERÇEKTE YOK — gönderilmemeli");
    assert.equal(u.dayMinutes, 90);
    assert.equal(u.weekMinutes, 210);
  } finally {
    fx.restore();
  }
});

test("retryMaxAttempts=2 (senaryo g ayarı): kalıcı 500'lü POST toplam 2 deneme + 2 geri-okuma yapar", async () => {
  const fx = stubFetch([
    json({ message: "kalıcı kırık" }, 500), // POST #1
    json([]), // geri-okuma #1 → yok
    json({ message: "kalıcı kırık" }, 500), // POST #2 (son deneme)
    json([]), // geri-okuma #2 → yok
  ]);
  const cap = captureStderr();
  let out;
  try {
    const adapter = new RestXurrentAdapter(cfg({ retryMaxAttempts: 2 }));
    out = await adapter.execute([createStep()]);
  } finally {
    cap.restore();
    fx.restore();
  }
  assert.equal(fx.calls.filter((c) => c.method === "POST").length, 2);
  assert.equal(out.errors.length, 1, "kalem düşer — bulk 'failed' raporlar, tekrar-çalıştırma kurtarır");
  assert.match(cap.lines.join(""), /\[retry\] op=timeEntryCreate attempt=1\/2 reason=5xx/);
});
