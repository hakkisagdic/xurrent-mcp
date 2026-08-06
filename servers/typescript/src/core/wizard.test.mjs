/**
 * timesheet_wizard birim testleri — mock adapter, AĞSIZ, LLM'siz.
 *
 * NE KANITLIYOR (contract/wizard.md):
 *   §2 — adım dizisi: start → pick_work → duration → detail → strategy → write(done)
 *   §3 — Türkçe ayrıştırma: "2 saat"→120 (çevirim SÖYLENİR), "1,5 saat"→90,
 *        evet/hayır kümeleri, bugün/dün, HH:MM, anlaşılmayan cevap adımı İLERLETMEZ
 *   §4 — sessionState: imza ÖNCE ham byte'larda; kurcalanmış/expired state
 *        start'a AÇIK açıklamayla döner (sessiz sıfırlama YOK);
 *        plannedFingerprint uyuşmazsa write REDDEDİLİR
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { MockXurrentAdapter } from "../../dist/xurrent/mock.js";
import { createToolContext } from "../../dist/core/context.js";
import { runWizard, parseSure, parseEvetHayir, parseDetay, katla } from "../../dist/core/wizard.js";
import { signWizardState, verifyWizardState } from "../../dist/core/wizard-state.js";
import { ALLOCATION_ID, FIXTURES_DIR, REPO_ROOT } from "../_testkit.mjs";

const SIR = "sihirbaz-birim-testi-sirri";

function testCfg(overrides = {}) {
  return {
    repoRoot: REPO_ROOT,
    fixturesDir: FIXTURES_DIR,
    mode: "mock",
    token: "",
    account: "",
    graphqlUrl: "http://127.0.0.1:1/",
    forceDryRun: false,
    // BİLEREK "closed": sihirbazın confirm adımı onayın KENDİSİDİR; protokol
    // seviyesinde ikinci bir onay istenmediğini bu ayar kanıtlar (elicitation
    // kanalı olmadan da write çalışır).
    confirmPolicy: "closed",
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
    stateSecret: SIR,
    stateTtlSeconds: 300,
    wizardTtlSeconds: 1800,
    ...overrides,
  };
}

function makeCtx(overrides = {}) {
  const cfg = testCfg(overrides);
  // confirm KANALI YOK — sihirbaz onu hiç çağırmamalı; çağırırsa test patlar.
  const ctx = createToolContext(cfg, new MockXurrentAdapter(cfg), async () => {
    throw new Error("sihirbaz protokol onayı İSTEMEMELİ — kendi confirm adımı onaydır");
  });
  return ctx;
}

/** sessionState payload'ını (imzasız kısmı) çözer — blob imzalıdır, ŞİFRELİ DEĞİL. */
function decodePayload(state) {
  return JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString("utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// §3 — ayrıştırma birim testleri
// ─────────────────────────────────────────────────────────────────────────────

test("parseSure: '2 saat'→120, '2 sa'→120, '1,5 saat'→90, '90'→90, '45 dk'→45", () => {
  assert.equal(parseSure("2 saat").minutes, 120);
  assert.equal(parseSure("2 saat").fromHours, true, "saat girişi çevirim olarak işaretlenir");
  assert.equal(parseSure("2 sa").minutes, 120);
  assert.equal(parseSure("1,5 saat").minutes, 90, "ondalık VİRGÜL kabul edilir");
  assert.equal(parseSure("1.5 saat").minutes, 90);
  assert.equal(parseSure("90").minutes, 90, "çıplak sayı DAKİKADIR");
  assert.equal(parseSure("90").fromHours, false);
  assert.equal(parseSure("45 dk").minutes, 45);
  assert.equal(parseSure("45 dakika").minutes, 45);
  assert.equal(parseSure("abc"), null);
  assert.equal(parseSure("1,5"), null, "ondalık DAKİKA anlamsız — reddedilir");
  assert.equal(parseSure("0"), null);
});

test("parseEvetHayir: kümeler + Türkçe katlama (İ→i, I→ı)", () => {
  for (const e of ["evet", "onay", "onaylıyorum", "tamam", "e", "EVET", "Tamam"]) {
    assert.equal(parseEvetHayir(e), true, `'${e}' evet sayılmalı`);
  }
  for (const h of ["hayır", "iptal", "vazgeç", "h", "HAYIR", "İPTAL"]) {
    assert.equal(parseEvetHayir(h), false, `'${h}' hayır sayılmalı`);
  }
  assert.equal(parseEvetHayir("belki"), null);
  // Katlamanın kendisi: 'HAYIR'daki I→ı, 'İPTAL'deki İ→i.
  assert.equal(katla("HAYIR"), "hayır");
  assert.equal(katla("İPTAL"), "iptal");
});

test("parseDetay: 'dün 14:00 VPN bakımı' → dün + saat + açıklama; tarih yoksa bugün", () => {
  const bugun = "2026-08-04";
  const d = parseDetay("dün 14:00 VPN bakımı", bugun);
  assert.equal(d.date, "2026-08-03");
  assert.equal(d.time, "14:00");
  assert.equal(d.description, "VPN bakımı");

  const sadeAciklama = parseDetay("rapor yazımı", bugun);
  assert.equal(sadeAciklama.date, bugun, "tarih verilmezse bugün");
  assert.equal(sadeAciklama.time, null);
  assert.equal(sadeAciklama.description, "rapor yazımı");

  const iso = parseDetay("2026-08-04 09:30 test", bugun);
  assert.equal(iso.date, "2026-08-04");
  assert.equal(iso.time, "09:30");
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — sessionState codec
// ─────────────────────────────────────────────────────────────────────────────

test("★ codec: wire biçimi b64url(payload).b64url(HMAC(secret, payloadBytes)) — kanonikleştirme YOK", () => {
  const cfg = testCfg();
  const state = signWizardState(cfg, "duration", { personId: "$me", minutes: 120 });
  const [payloadB64, macB64] = state.split(".");
  assert.equal(state.split(".").length, 2, "iki parça: payload.imza (requestState'in v1.x.y üçlüsü DEĞİL)");

  // İmza HAM payload byte'ları üzerindedir — bağımsız yeniden hesaplama tutmalı.
  const payloadBytes = Buffer.from(payloadB64, "base64url");
  const beklenen = createHmac("sha256", SIR).update(payloadBytes).digest().toString("base64url");
  assert.equal(macB64, beklenen, "HMAC payload BYTE'LARI üzerinde hesaplanmalı (çapraz-dil devrin temeli)");

  const payload = JSON.parse(payloadBytes.toString("utf8"));
  assert.equal(payload.v, 1);
  assert.equal(payload.kind, "wizard");
  assert.equal(payload.step, "duration");
  assert.ok(payload.exp > Math.floor(Date.now() / 1000), "exp gelecekte olmalı");

  const check = verifyWizardState(cfg, state);
  assert.equal(check.ok, true);
  assert.equal(check.payload.data.minutes, 120);
});

test("codec: BAŞKA dilin ürettiği byte'lar da doğrulanır (payload JSON üslubu önemsiz)", () => {
  const cfg = testCfg();
  // Anahtar sırası ve boşluklar TS'in üreteceğinden FARKLI — yine de geçmeli,
  // çünkü doğrulayan taraf parse etmeden önce BYTE'ları imzalar.
  const yabanciJson = `{ "kind": "wizard", "data": {"minutes": 90}, "exp": ${Math.floor(Date.now() / 1000) + 60}, "step": "duration", "v": 1 }`;
  const bytes = Buffer.from(yabanciJson, "utf8");
  const mac = createHmac("sha256", SIR).update(bytes).digest().toString("base64url");
  const state = `${bytes.toString("base64url")}.${mac}`;
  const check = verifyWizardState(cfg, state);
  assert.equal(check.ok, true, "kanonikleştirme gerekmemeli — ham byte imzası yeterli");
  assert.equal(check.payload.data.minutes, 90);
});

test("codec: tek byte oynanmış payload → bad-signature (imza ÖNCE, parse SONRA)", () => {
  const cfg = testCfg();
  const state = signWizardState(cfg, "duration", { minutes: 120 });
  const [p, m] = state.split(".");
  const bozuk = (p[5] === "A" ? p.slice(0, 5) + "B" + p.slice(6) : p.slice(0, 5) + "A" + p.slice(6)) + "." + m;
  const check = verifyWizardState(cfg, bozuk);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "bad-signature");
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — mutlu yol: start → pick_work → duration → detail → strategy → write
// ─────────────────────────────────────────────────────────────────────────────

test("★ mutlu yol: adım dizisi + '2 saat'→120 söylenir + write'ta done/writeResult/geri-okuma", async () => {
  const ctx = makeCtx();

  // Tur 1 — merhaba: whoami + timeIncrement + açık işler listesi.
  const t1 = await runWizard(ctx, {});
  assert.equal(t1.step, "start");
  assert.equal(t1.done, false);
  assert.ok(t1.sessionState, "her tur imzalı state döner");
  assert.match(t1.reply, /timeIncrement.*30/, "timeIncrement SÖYLENİR (wizard.md §2 start)");
  assert.ok(t1.nextQuestion?.choices?.length >= 7, "6 açık iş + takvim seçeneği");
  assert.ok(t1.nextQuestion.choices.some((c) => c.id === "takvim"));
  assert.equal(decodePayload(t1.sessionState).step, "start", "state.step = yanıtın step'i");

  // Tur 2 — '1' → ilk iş (Request #70248) seçilir.
  const t2 = await runWizard(ctx, { utterance: "1", sessionState: t1.sessionState });
  assert.equal(t2.step, "pick_work");
  assert.match(t2.reply, /#70248/);
  assert.equal(t2.nextQuestion?.expectsFreeText, true);

  // Tur 3 — '2 saat' → 120 dk; çevirim reply'da AÇIKÇA söylenir.
  const t3 = await runWizard(ctx, { utterance: "2 saat", sessionState: t2.sessionState });
  assert.equal(t3.step, "duration");
  assert.match(t3.reply, /120/, "çevirim (2 saat → 120 dk) reply'da geçmeli");
  assert.equal(decodePayload(t3.sessionState).data.minutes, 120);

  // Tur 4 — detay: dün + 14:00 + açıklama → 3 strateji seçeneği sunulur.
  const t4 = await runWizard(ctx, { utterance: "dün 14:00 VPN bakımı", sessionState: t3.sessionState });
  assert.equal(t4.step, "detail");
  assert.equal(t4.nextQuestion?.choices?.length, 3, "two_step/link_first/date_first");
  assert.ok(t4.nextQuestion.choices.every((c) => typeof c.detail === "string"), "her seçeneğin bedeli yazılı");
  const t4data = decodePayload(t4.sessionState).data;
  assert.equal(t4data.minutes, 120);
  assert.match(t4data.startedAt, /T14:00:00\+03:00$/, "saat offset'li startedAt'e çevrilir");
  assert.equal(t4data.description, "VPN bakımı");

  // Tur 5 — strateji seçimi → dry-run planı + evet/hayır.
  const t5 = await runWizard(ctx, { utterance: "two_step", sessionState: t4.sessionState });
  assert.equal(t5.step, "strategy");
  assert.match(t5.reply, /DRY-RUN/);
  assert.match(t5.reply, /two_step/);
  const t5data = decodePayload(t5.sessionState).data;
  assert.ok(/^[0-9a-f]{16}$/.test(t5data.plannedFingerprint), "onaylanan planın parmak izi state'e yazılır");

  // Tur 6 — evet → GERÇEK yazma + geri-okuma; done=true, state ve soru YOK.
  const t6 = await runWizard(ctx, { utterance: "evet", sessionState: t5.sessionState });
  assert.equal(t6.step, "write");
  assert.equal(t6.done, true);
  assert.equal(t6.sessionState, null, "done=true → sessionState null");
  assert.equal(t6.nextQuestion, null, "done=true → nextQuestion null");
  assert.equal(t6.errors.length, 0);
  assert.ok(t6.writeResult, "writeResult dolu olmalı");
  assert.equal(t6.writeResult.dryRun, false);
  assert.ok(t6.writeResult.timeEntry?.id, "kayıt GERÇEKTEN oluştu");
  assert.match(t6.reply, /GERİ-OKUMA/, "yazma sonrası xurrent_list_time_entries geri-okuması raporlanır");
  assert.match(t6.reply, /120 dk/);

  // Adım dizisi bir bütün olarak sözleşmedeki sırada.
  assert.deepEqual(
    [t1, t2, t3, t4, t5, t6].map((r) => r.step),
    ["start", "pick_work", "duration", "detail", "strategy", "write"],
  );
});

test("mutlu yol '1,5 saat' → 90 dakika (ondalık virgül)", async () => {
  const ctx = makeCtx();
  const t1 = await runWizard(ctx, {});
  const t2 = await runWizard(ctx, { utterance: "1", sessionState: t1.sessionState });
  const t3 = await runWizard(ctx, { utterance: "1,5 saat", sessionState: t2.sessionState });
  assert.equal(t3.step, "duration");
  assert.match(t3.reply, /90/, "1,5 saat → 90 dk çevirimi söylenir");
  assert.equal(decodePayload(t3.sessionState).data.minutes, 90);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sağlamlık
// ─────────────────────────────────────────────────────────────────────────────

test("anlaşılmayan cevap adımı İLERLETMEZ: aynı step + aynı nextQuestion döner", async () => {
  const ctx = makeCtx();
  const t1 = await runWizard(ctx, {});
  const t2 = await runWizard(ctx, { utterance: "1", sessionState: t1.sessionState });

  // Süre beklenirken saçmalık: adım pick_work'te KALIR, soru AYNEN tekrar döner.
  const bozuk = await runWizard(ctx, { utterance: "fışkırtma pompası", sessionState: t2.sessionState });
  assert.equal(bozuk.step, "pick_work", "adım DEĞİŞMEMELİ");
  assert.equal(bozuk.done, false);
  assert.equal(bozuk.nextQuestion.prompt, t2.nextQuestion.prompt, "nextQuestion AYNEN tekrar");
  assert.match(bozuk.reply, /anlaşılamadı/i);

  // Aynı state'ten geçerli cevapla devam EDİLEBİLİR.
  const devam = await runWizard(ctx, { utterance: "60", sessionState: bozuk.sessionState });
  assert.equal(devam.step, "duration");
});

test("timeIncrement katı olmayan süre: sessizce yuvarlanmaz, SORULUR ve adım ilerlemez", async () => {
  const ctx = makeCtx();
  const t1 = await runWizard(ctx, {});
  const t2 = await runWizard(ctx, { utterance: "1", sessionState: t1.sessionState });
  const r = await runWizard(ctx, { utterance: "45", sessionState: t2.sessionState });
  assert.equal(r.step, "pick_work", "kat olmayan süre adımı İLERLETMEZ");
  assert.match(r.reply, /timeIncrement=30/);
  assert.match(r.reply, /30 veya 60/, "iki yuvarlama adayı ÖNERİLİR, seçim kullanıcıya bırakılır");
});

test("★ kurcalanmış sessionState (tek byte) → start'a AÇIK açıklamayla döner, sessiz sıfırlama YOK", async () => {
  const ctx = makeCtx();
  const t1 = await runWizard(ctx, {});
  const t2 = await runWizard(ctx, { utterance: "1", sessionState: t1.sessionState });

  const [p, m] = t2.sessionState.split(".");
  // Payload'da tek karakteri çevir — imza artık tutmaz.
  const oynak = (p[10] === "A" ? p.slice(0, 10) + "B" + p.slice(11) : p.slice(0, 10) + "A" + p.slice(11)) + "." + m;
  const r = await runWizard(ctx, { utterance: "2 saat", sessionState: oynak });

  assert.equal(r.step, "start", "geçersiz state akışı start'tan başlatır");
  assert.equal(r.done, false);
  assert.match(r.reply, /DOĞRULANAMADI/, "yeniden başlama sebebi AÇIKÇA söylenir");
  assert.ok(r.sessionState, "yeni, GEÇERLİ bir state verilir — sohbet sürdürülebilir");
});

test("süresi dolmuş state → nazik yeniden başlama (sebep söylenir)", async () => {
  const ctx = makeCtx();
  // Geçmiş exp'li state'i AYNI sırla üret: TTL'i negatif bir cfg ile imzala.
  const eskiCfg = testCfg({ wizardTtlSeconds: -10 });
  const eskiState = signWizardState(eskiCfg, "pick_work", { personId: "$me", targetType: "request" });

  const r = await runWizard(ctx, { utterance: "2 saat", sessionState: eskiState });
  assert.equal(r.step, "start");
  assert.equal(r.done, false);
  assert.match(r.reply, /süresi doldu/i, "expired durumu açıkça söylenir");
  assert.match(r.reply, /1800/, "geçerli TTL değeri söylenir (XURRENT_WIZARD_TTL)");
});

test("★ plannedFingerprint uyuşmazsa write REDDEDER: onaylanandan farklı plan yazılamaz", async () => {
  const ctx = makeCtx();
  const t1 = await runWizard(ctx, {});
  const t2 = await runWizard(ctx, { utterance: "1", sessionState: t1.sessionState });
  const t3 = await runWizard(ctx, { utterance: "2 saat", sessionState: t2.sessionState });
  const t4 = await runWizard(ctx, { utterance: "bugün planlı bakım", sessionState: t3.sessionState });
  const t5 = await runWizard(ctx, { utterance: "two_step", sessionState: t4.sessionState });

  // Saldırı: payload'daki minutes değiştirilir ama onaylanan plannedFingerprint
  // korunur; state AYNI sırla yeniden imzalanır (imza kontrolünden geçer).
  const payload = decodePayload(t5.sessionState);
  const sahte = signWizardState(testCfg(), payload.step, { ...payload.data, minutes: 480 });

  const r = await runWizard(ctx, { utterance: "evet", sessionState: sahte });
  assert.equal(r.done, true);
  assert.ok(r.errors.length > 0, "fingerprint uyuşmazlığı HATADIR");
  assert.match(r.reply, /plannedFingerprint/);
  assert.match(r.reply, /REDDEDİLDİ/);
  assert.equal(r.writeResult, null, "hiçbir şey yazılmadı");

  // Kanıt: mock store'a 480 dakikalık kayıt DÜŞMEDİ.
  const { runListTimeEntries } = await import("../../dist/core/toolimpl.js");
  const page = await runListTimeEntries(ctx, {});
  assert.ok(!page.timeEntries.some((e) => e.timeSpent === 480), "onaylanmayan plan yazılmamalı");
});

test("confirm'de 'hayır' → done, hiçbir şey yazılmaz", async () => {
  const ctx = makeCtx();
  const t1 = await runWizard(ctx, {});
  const t2 = await runWizard(ctx, { utterance: "1", sessionState: t1.sessionState });
  const t3 = await runWizard(ctx, { utterance: "60", sessionState: t2.sessionState });
  const t4 = await runWizard(ctx, { utterance: "bugün", sessionState: t3.sessionState });
  const t5 = await runWizard(ctx, { utterance: "link_first", sessionState: t4.sessionState });
  const r = await runWizard(ctx, { utterance: "hayır", sessionState: t5.sessionState });
  assert.equal(r.step, "done");
  assert.equal(r.done, true);
  assert.equal(r.errors.length, 0, "vazgeçmek hata değildir");
  assert.equal(r.writeResult, null);
  assert.match(r.reply, /HİÇBİR mutation/i);
});

test("takvim dalı: 'takvim' → calendar_plan → calendar_confirm → bulk write (done)", async () => {
  const ctx = makeCtx();
  const t1 = await runWizard(ctx, {});
  const t2 = await runWizard(ctx, { utterance: "takvim", sessionState: t1.sessionState });
  assert.equal(t2.step, "calendar_plan");
  assert.equal(t2.done, false);
  assert.match(t2.reply, /öneri/);

  const t3 = await runWizard(ctx, { utterance: "evet", sessionState: t2.sessionState });
  assert.equal(t3.step, "calendar_confirm");
  assert.match(t3.reply, /ATOMİK DEĞİLDİR/, "bulk'un atomik olmadığı AÇIKÇA söylenir");
  assert.ok(/^[0-9a-f]{16}$/.test(decodePayload(t3.sessionState).data.plannedFingerprint));

  const t4 = await runWizard(ctx, { utterance: "evet", sessionState: t3.sessionState });
  assert.equal(t4.step, "write");
  assert.equal(t4.done, true);
  assert.ok(t4.writeResult, "bulk sonucu WriteResult şekline eşlenir");
  assert.equal(t4.writeResult.dryRun, false);
  assert.match(t4.reply, /GERİ-OKUMA/);
});

test("takvim dalı: 'N hariç' elemesi öneri sayısını düşürür, adım calendar_plan'da kalır", async () => {
  const ctx = makeCtx();
  const t1 = await runWizard(ctx, {});
  const t2 = await runWizard(ctx, { utterance: "takvim", sessionState: t1.sessionState });
  const onceki = decodePayload(t2.sessionState).data.calendarDraft.entries.length;
  assert.ok(onceki >= 2, "fixture takviminde en az 2 öneri olmalı");

  const t3 = await runWizard(ctx, { utterance: "1 hariç", sessionState: t2.sessionState });
  assert.equal(t3.step, "calendar_plan", "eleme bir İLERLEME değildir");
  assert.equal(decodePayload(t3.sessionState).data.calendarDraft.entries.length, onceki - 1);
});
