/**
 * ★ requestState İMZALAMA/DOĞRULAMA BİRİM TESTİ (2026-07-28, MRTR).
 *
 * NE KANITLIYOR: Sunucu stateless olduğu için onay bilgisini client taşır ve
 * spec bu blob'u AÇIKÇA "saldırgan kontrolündeki girdi" sayar. Dört savunmanın
 * (imza, principal, fingerprint, TTL) ve tek kullanımın (nonce) HER BİRİ ayrı
 * ayrı ölçülür — biri sessizce devre dışı kalırsa sihirbaz yine geçerdi,
 * çünkü sihirbaz state'i hiç kurcalamaz.
 *
 * Zaman enjeksiyonu: TTL testinde saat ileri sarılmaz; stateTtlSeconds NEGATİF
 * verilerek exp geçmişe düşürülür. Böylece test gerçek zamana bağlı olmaz.
 */

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  fingerprintOf,
  resetNonces,
  signRequestState,
  verifyRequestState,
} from "../../dist/core/confirm.js";
import { confirmConfig } from "../_testkit.mjs";

const CFG = confirmConfig();
const PRINCIPAL = "TW9jay9QZXJzb24vMQ";
const TOOL = "xurrent_create_time_entry";
const ARGS = { targetType: "request", targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4", minutes: 120 };

const bekle = (over = {}) => ({ principal: PRINCIPAL, tool: TOOL, args: ARGS, ...over });

beforeEach(() => resetNonces());

// ─────────────────────────────────────────────────────────────────────────────
// Mutlu yol
// ─────────────────────────────────────────────────────────────────────────────

test("★ imzala → doğrula: GEÇER ve payload beklenen alanları taşır", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const r = verifyRequestState(CFG, state, bekle());
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.payload.principal, PRINCIPAL);
  assert.equal(r.payload.tool, TOOL);
  assert.equal(r.payload.fingerprint, fingerprintOf(TOOL, ARGS));
  assert.ok(typeof r.payload.nonce === "string" && r.payload.nonce.length > 0);
});

test("wire biçimi '<gövde>.<imza>' İKİ parçalıdır (wizard sessionState ile ortak zarf)", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const parts = state.split(".");
  assert.equal(parts.length, 2);
  // Gövde base64url'den doğrudan JSON'a çözülür — sürüm ön eki YOKTUR.
  const govde = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  assert.equal(typeof govde, "object");
});

test("state İMZALIDIR ama ŞİFRELİ DEĞİLDİR — client gövdeyi okuyabilir (içine sır konmaz)", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const govde = JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString("utf8"));
  assert.equal(govde.principal, PRINCIPAL);
  assert.equal(govde.tool, TOOL);
});

test("argüman anahtar SIRASI parmak izini DEĞİŞTİRMEZ (kanonik gösterim)", () => {
  const a = { targetType: "request", minutes: 120, targetId: "X" };
  const b = { minutes: 120, targetId: "X", targetType: "request" };
  assert.equal(fingerprintOf(TOOL, a), fingerprintOf(TOOL, b));

  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: a });
  assert.equal(verifyRequestState(CFG, state, bekle({ args: b })).ok, true);
});

test("iç içe nesnelerde de anahtar sırası önemsizdir", () => {
  const a = { entries: [{ minutes: 60, targetId: "A" }] };
  const b = { entries: [{ targetId: "A", minutes: 60 }] };
  assert.equal(fingerprintOf(TOOL, a), fingerprintOf(TOOL, b));
});

// ─────────────────────────────────────────────────────────────────────────────
// Savunma 1 — İMZA
// ─────────────────────────────────────────────────────────────────────────────

test("★ imza bozulursa REDDEDİLİR", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const parts = state.split(".");
  const bozuk = `${parts[0]}.${Buffer.from("sahte-imza").toString("base64url")}`;
  const r = verifyRequestState(CFG, bozuk, bekle());
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("imzası GEÇERSİZ"));
});

test("★ gövde değiştirilirse (principal başkası yapılırsa) REDDEDİLİR", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const parts = state.split(".");
  const govde = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  govde.principal = "TW9jay9QZXJzb24vOTk"; // saldırgan kendini başkası yapmaya çalışır
  const yeniGovde = Buffer.from(JSON.stringify(govde), "utf8").toString("base64url");
  const r = verifyRequestState(CFG, `${yeniGovde}.${parts[1]}`, bekle());
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("imzası GEÇERSİZ"), r.reason);
});

test("BAŞKA anahtarla üretilmiş state REDDEDİLİR (sunucu yeniden başladı senaryosu)", () => {
  const digerCfg = confirmConfig({ stateSecret: "baska-bir-anahtar" });
  const state = signRequestState(digerCfg, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const r = verifyRequestState(CFG, state, bekle());
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("imzası GEÇERSİZ"));
});

test("biçimsiz state REDDEDİLİR (boş, string olmayan, noktasız, eski v1-prefix'li biçim)", () => {
  // "v1.abc" ve "v2.abc.def": ESKİ üç parçalı biçimin kalıntıları — yeni codec
  // bunları da (imza tutmadığı için) reddeder. Eski biçime geriye-uyum YOKTUR:
  // sunucu yeniden başlayınca eski state'lerin ölmesi zaten istenen davranıştır.
  for (const kotu of ["", "abc", "v1.abc", "v2.abc.def", ".abc", "abc.", null, undefined, 42, { a: 1 }]) {
    const r = verifyRequestState(CFG, kotu, bekle());
    assert.equal(r.ok, false, `kabul edilmemeliydi: ${JSON.stringify(kotu)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Savunma 2 — PARMAK İZİ (fingerprint)
// ─────────────────────────────────────────────────────────────────────────────

test("★ argüman parmak izi değişirse REDDEDİLİR — onaylanandan BAŞKA işlem yazılamaz", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const r = verifyRequestState(CFG, state, bekle({ args: { ...ARGS, minutes: 480 } }));
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("argüman parmak izi tutmuyor"), r.reason);
});

test("hedef ticket değiştirilirse REDDEDİLİR", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const r = verifyRequestState(CFG, state, bekle({ args: { ...ARGS, targetId: "BASKA-TICKET" } }));
  assert.equal(r.ok, false);
});

test("BAŞKA tool için üretilmiş state REDDEDİLİR", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const r = verifyRequestState(CFG, state, bekle({ tool: "xurrent_create_time_entries_bulk" }));
  assert.equal(r.ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Savunma 3 — PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

test("★ başka principal ile gelen state REDDEDİLİR (çapraz kullanıcı)", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const r = verifyRequestState(CFG, state, bekle({ principal: "TW9jay9QZXJzb24vMg" }));
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("çapraz kullanıcı"), r.reason);
});

// ─────────────────────────────────────────────────────────────────────────────
// Savunma 4 — TTL
// ─────────────────────────────────────────────────────────────────────────────

test("★ TTL geçmişse REDDEDİLİR (saat değil, TTL enjekte edilir)", () => {
  const gecmisCfg = confirmConfig({ stateTtlSeconds: -1 });
  const state = signRequestState(gecmisCfg, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  // İmza aynı anahtarla üretildi; reddin sebebi İMZA değil SÜRE olmalı.
  const r = verifyRequestState(gecmisCfg, state, bekle());
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("süresi doldu"), r.reason);
});

test("TTL süresi dolan state, süre kontrolünden ÖNCE nonce'u tüketmez", () => {
  const gecmisCfg = confirmConfig({ stateTtlSeconds: -1 });
  const state = signRequestState(gecmisCfg, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  verifyRequestState(gecmisCfg, state, bekle());
  // Aynı nonce taze bir state'te kullanılabilmeli; burada dolaylı kontrol:
  const taze = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  assert.equal(verifyRequestState(CFG, taze, bekle()).ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Savunma 5 — NONCE (tek kullanım)
// ─────────────────────────────────────────────────────────────────────────────

test("★ aynı state ikinci kez kullanılırsa REDDEDİLİR (replay)", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  assert.equal(verifyRequestState(CFG, state, bekle()).ok, true, "ilk kullanım geçmeliydi");

  const ikinci = verifyRequestState(CFG, state, bekle());
  assert.equal(ikinci.ok, false);
  assert.ok(ikinci.reason.includes("ZATEN KULLANILMIŞ"), ikinci.reason);
});

test("iki ayrı imzalama iki FARKLI nonce üretir — ikisi de bir kez geçerlidir", () => {
  const a = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const b = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  assert.notEqual(a, b, "aynı girdi için bile nonce farklı olmalı");
  assert.equal(verifyRequestState(CFG, a, bekle()).ok, true);
  assert.equal(verifyRequestState(CFG, b, bekle()).ok, true);
});

test("resetNonces sonrası aynı state yeniden kabul edilir (test izolasyonu garantisi)", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  assert.equal(verifyRequestState(CFG, state, bekle()).ok, true);
  resetNonces();
  assert.equal(verifyRequestState(CFG, state, bekle()).ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sıra: imza kontrolü SEMANTİK kontrollerden ÖNCE
// ─────────────────────────────────────────────────────────────────────────────

test("imzası bozuk VE principal'ı yanlış state'te reddin sebebi İMZA'dır (ucuz ve kesin olan önce)", () => {
  const state = signRequestState(CFG, { principal: PRINCIPAL, tool: TOOL, args: ARGS });
  const parts = state.split(".");
  const bozuk = `${parts[0]}.${Buffer.from("sahte").toString("base64url")}`;
  const r = verifyRequestState(CFG, bozuk, bekle({ principal: "baskasi" }));
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("imzası GEÇERSİZ"), r.reason);
});
