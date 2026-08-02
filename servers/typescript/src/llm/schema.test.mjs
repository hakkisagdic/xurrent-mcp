/**
 * llm/schema.ts birim testi — BAĞIMLILIK YOK, yalnızca `node --test`.
 *
 * Çalıştırma:
 *   npm run build && npm run test:schema
 *
 * ★ NE KANITLIYOR: contract/tools.json'daki 8 tool'un HEPSİ Gemini lehçesine
 *   çevrilebiliyor, çeviri kayıpsız DEĞİL, ve kayıp LİSTELENEBİLİYOR. "Aynı
 *   sözleşme, iki farklı tool-calling lehçesi" tezinin ölçülebilir hâli budur.
 *
 * Not: derlenmiş dist/ okunur — kaynak .ts'i çalıştırmak için bir yükleyici
 * (loader) gerekirdi ve o da bir bağımlılıktır.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  mcpSchemaToGemini,
  formatTranslationReport,
  countDroppedKeywords,
} from "../../dist/llm/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const contract = JSON.parse(readFileSync(join(REPO_ROOT, "contract", "tools.json"), "utf8"));

/** Gemini'nin kabul ettiği anahtarlar. Bunun dışında bir anahtar kalırsa çeviri hatalıdır. */
const ALLOWED_KEYS = new Set(["type", "description", "enum", "properties", "required", "items", "ref", "defs"]);
const ALLOWED_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/** Çevrilmiş şemayı özyinelemeli olarak denetler. */
function assertGeminiClean(node, path = "#") {
  assert.equal(typeof node, "object", `${path}: şema düğümü nesne olmalı`);
  assert.ok(node !== null, `${path}: null olamaz`);

  for (const key of Object.keys(node)) {
    assert.ok(ALLOWED_KEYS.has(key), `${path}: '${key}' Gemini şemasında YASAK (dolar işaretli anahtar kaldı mı?)`);
    assert.ok(!key.startsWith("$"), `${path}: '${key}' dolar işareti taşıyor — $ref/$defs dönüştürülmemiş`);
  }
  if (node.type !== undefined) {
    assert.ok(typeof node.type === "string", `${path}: type dizi olamaz (birleşim düşürülmeliydi)`);
    assert.ok(ALLOWED_TYPES.has(node.type), `${path}: bilinmeyen tip ${node.type}`);
  }
  if (node.enum !== undefined) {
    assert.ok(Array.isArray(node.enum), `${path}: enum dizi olmalı`);
    for (const v of node.enum) assert.equal(typeof v, "string", `${path}: enum yalnızca string taşır`);
    assert.equal(node.type, "string", `${path}: enum varsa type STRING olmalı`);
  }
  if (node.ref !== undefined) {
    assert.match(node.ref, /^#\/defs\/[^/]+$/, `${path}: ref yalnızca defs'in doğrudan çocuğunu gösterebilir`);
  }
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    assertGeminiClean(child, `${path}/properties/${name}`);
  }
  if (node.items !== undefined) assertGeminiClean(node.items, `${path}/items`);
  for (const [name, child] of Object.entries(node.defs ?? {})) assertGeminiClean(child, `#/defs/${name}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) Sözleşmedeki 8 tool'un HEPSİ çevrilebilmeli
// ─────────────────────────────────────────────────────────────────────────────

test("contract/tools.json: 8 tool var", () => {
  assert.equal(contract.tools.length, 8, "sözleşme 8 tool içermeli");
});

test("8 tool'un input şeması Gemini lehçesine çevrilir ve temiz kalır", () => {
  const entries = [];
  for (const tool of contract.tools) {
    const tr = mcpSchemaToGemini(tool.input, { externalDefs: contract.$defs });
    assertGeminiClean(tr.schema, `#(${tool.name})`);
    assert.equal(tr.schema.type, "object", `${tool.name}: kök tip object olmalı`);
    entries.push({ name: tool.name, translation: tr });
  }
  assert.equal(entries.length, 8);
  // Rapor üretilebilmeli — ders artifaktı budur.
  const report = formatTranslationReport(entries);
  assert.match(report, /ŞEMA ÇEVİRİSİ/);
  assert.match(report, /TOPLAM \d+ düşürme, 8 tool/);
});

test("8 tool'un output şeması da çevrilir; $ref'ler defs'e içe alınır", () => {
  for (const tool of contract.tools) {
    const tr = mcpSchemaToGemini(tool.output, { externalDefs: contract.$defs });
    assertGeminiClean(tr.schema, `#(${tool.name} output)`);
  }
  // whoami output'u #/$defs/Person referansı taşır → defs'e kopyalanmış olmalı.
  const whoami = contract.tools.find((t) => t.name === "xurrent_whoami");
  const tr = mcpSchemaToGemini(whoami.output, { externalDefs: contract.$defs });
  assert.deepEqual(tr.inlinedDefs, ["Person"]);
  assert.equal(tr.schema.properties.person.ref, "#/defs/Person");
  assert.ok(tr.schema.defs.Person, "Person tanımı şemanın KENDİ defs'ine kopyalanmalı (dış referans yasak)");
  assert.ok(tr.renamed.some((r) => r.from === "$ref" && r.to === "ref"));
});

test("geçişli $ref: WorkPage → WorkItem zinciri de içe alınır", () => {
  const listOpenWork = contract.tools.find((t) => t.name === "xurrent_list_open_work");
  const tr = mcpSchemaToGemini(listOpenWork.output, { externalDefs: contract.$defs });
  assert.deepEqual(tr.inlinedDefs.sort(), ["WorkItem", "WorkPage"]);
  assert.equal(tr.schema.defs.WorkPage.properties.nodes.items.ref, "#/defs/WorkItem");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Atılan anahtarlar LİSTELENEBİLMELİ
// ─────────────────────────────────────────────────────────────────────────────

test("atılan anahtarlar raporlanır: additionalProperties, pattern, maxLength, minimum, maximum, default", () => {
  const entries = contract.tools.map((t) => ({
    name: t.name,
    translation: mcpSchemaToGemini(t.input, { externalDefs: contract.$defs }),
  }));
  const counts = countDroppedKeywords(entries);

  for (const kw of ["additionalProperties", "default", "pattern", "maxLength", "minimum", "maximum"]) {
    assert.ok((counts.get(kw) ?? 0) > 0, `'${kw}' en az bir kez düşürülmüş olmalı`);
  }
  // Toplam düşürme sayısı sıfır olamaz: kayıpsız bir çeviri olsaydı tez de olmazdı.
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  assert.ok(total > 10, `beklenenden az düşürme: ${total}`);
});

test("default değeri KAYBOLMAZ: açıklamaya metin olarak taşınır", () => {
  const listOpenWork = contract.tools.find((t) => t.name === "xurrent_list_open_work");
  const tr = mcpSchemaToGemini(listOpenWork.input, { externalDefs: contract.$defs });

  const personId = tr.schema.properties.personId;
  assert.match(personId.description, /varsayılan: \$me/);
  assert.equal(personId.default, undefined, "default anahtarı şemada KALMAMALI");

  const preserved = tr.dropped.filter((d) => d.keyword === "default" && d.preserved);
  assert.ok(preserved.length >= 3, "default düşürmeleri 'preserved' işaretli olmalı");

  const first = tr.schema.properties.first;
  assert.equal(first.type, "integer");
  assert.match(first.description ?? "", /varsayılan: 25/);
  // minimum/maximum GERÇEKTEN kaybolur — ve bunu biliyoruz, çünkü raporlanıyor.
  assert.equal(first.minimum, undefined);
  assert.ok(tr.dropped.some((d) => d.keyword === "minimum" && d.path.endsWith("/first")));
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Kenar durumlar
// ─────────────────────────────────────────────────────────────────────────────

test("tipsiz enum'a type: string eklenir", () => {
  const tr = mcpSchemaToGemini({
    type: "object",
    properties: { view: { enum: ["all", "current_account"], default: "all" } },
  });
  assert.equal(tr.schema.properties.view.type, "string");
  assert.deepEqual(tr.schema.properties.view.enum, ["all", "current_account"]);
});

test("tip birleşimi ['string','null'] → 'string' + açıklamada 'null olabilir'", () => {
  const tr = mcpSchemaToGemini({ type: "object", properties: { name: { type: ["string", "null"] } } });
  assert.equal(tr.schema.properties.name.type, "string");
  assert.match(tr.schema.properties.name.description, /null olabilir/);
  assert.ok(tr.dropped.some((d) => d.keyword === "type[null]" && d.preserved));
});

test("enum içindeki null düşürülür", () => {
  const tr = mcpSchemaToGemini({ type: "string", enum: ["a", "b", null] });
  assert.deepEqual(tr.schema.enum, ["a", "b"]);
  assert.match(tr.schema.description, /null olabilir/);
});

test("oneOf/anyOf/allOf/const/format atılır ve raporlanır", () => {
  const tr = mcpSchemaToGemini({
    type: "object",
    $schema: "https://json-schema.org/draft/2020-12/schema",
    additionalProperties: false,
    properties: {
      x: { type: "string", format: "date-time", const: "a" },
      y: { oneOf: [{ type: "string" }, { type: "number" }] },
      z: { anyOf: [{ type: "string" }] },
      w: { allOf: [{ type: "string" }] },
    },
  });
  const kws = new Set(tr.dropped.map((d) => d.keyword));
  for (const k of ["$schema", "additionalProperties", "format", "const", "oneOf", "anyOf", "allOf"]) {
    assert.ok(kws.has(k), `'${k}' raporlanmalı`);
  }
  assertGeminiClean(tr.schema);
});

test("dış referans (#/$defs/... dışındaki ref) düşürülür, sessizce geçilmez", () => {
  const tr = mcpSchemaToGemini({
    type: "object",
    properties: { a: { $ref: "https://example.com/x.json#/Foo" }, b: { $ref: "#/$defs/A/properties/x" } },
  });
  assert.equal(tr.schema.properties.a.ref, undefined);
  assert.equal(tr.schema.properties.b.ref, undefined);
  assert.equal(tr.dropped.filter((d) => d.keyword === "$ref").length, 2);
});

test("derinlik sınırı aşılırsa dal budanır ve raporlanır", () => {
  // 40 seviye iç içe nesne kur.
  let node = { type: "string" };
  for (let i = 0; i < 40; i++) node = { type: "object", properties: { n: node } };
  const tr = mcpSchemaToGemini(node, { maxDepth: 32 });
  assert.ok(tr.dropped.some((d) => d.keyword === "(derinlik)"), "derinlik budaması raporlanmalı");
});

test("çevirici SAF: girdi mutasyona uğramaz ve aynı girdi aynı çıktıyı verir", () => {
  const input = contract.tools[4].input;
  const before = JSON.stringify(input);
  const a = mcpSchemaToGemini(input, { externalDefs: contract.$defs });
  const b = mcpSchemaToGemini(input, { externalDefs: contract.$defs });
  assert.equal(JSON.stringify(input), before, "girdi DEĞİŞMEMELİ");
  assert.deepEqual(a.schema, b.schema);
  assert.deepEqual(a.dropped, b.dropped);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) Çalışan sunucunun GERÇEKTEN gönderdiği şemalar
// ─────────────────────────────────────────────────────────────────────────────

test("agent/core.ts'in ürettiği 8 functionDeclaration Gemini'ye uygundur", async () => {
  const { buildTools } = await import("../../dist/agent/core.js");
  const { loadConfig } = await import("../../dist/config.js");
  const { createToolContext } = await import("../../dist/core/context.js");
  const { createXurrentAdapter } = await import("../../dist/xurrent/index.js");

  const cfg = loadConfig();
  const ctx = createToolContext(cfg, createXurrentAdapter(cfg), async () => ({ action: "decline" }));
  const tools = buildTools(ctx);

  assert.equal(tools.length, 8);
  const contractNames = contract.tools.map((t) => t.name).sort();
  assert.deepEqual(tools.map((t) => t.name).sort(), contractNames, "tool adları sözleşmeyle BİREBİR aynı olmalı");

  for (const t of tools) {
    assert.ok(t.declaration.description.length > 0, `${t.name}: açıklama boş olamaz`);
    assertGeminiClean(t.declaration.parameters, `#(${t.name})`);
  }
});
