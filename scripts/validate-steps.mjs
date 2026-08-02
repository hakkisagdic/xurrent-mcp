#!/usr/bin/env node
// -----------------------------------------------------------------------------
// validate-steps.mjs — docs/wizard/steps.json dosyasını
// docs/wizard/steps.schema.json şemasına karşı doğrular.
//
// NEDEN: steps.json'un "$schema": "./steps.schema.json" referansı uzun süre
// BOŞTA durdu — yani editörde kırmızı çizgi yoktu, CI'da kontrol yoktu ve
// sihirbaz tanımadığı bir anahtarı SESSİZCE yok sayıyordu. Ders dosyasında
// sessizce yok sayılan bir anahtar, derste hiç çalışmayan bir bölüm demektir.
//
// İki katman doğrulama yapılır:
//   1) YAPISAL — JSON Schema (scripts/lib/mini-jsonschema.mjs, bağımlılıksız)
//   2) ANLAMSAL — saf JSON Schema'nın ifade EDEMEDİĞİ referans bütünlüğü:
//      chapter id'leri, quiz cevap indeksi, tablo satır uzunlukları,
//      tool adlarının contract/tools.json'da var olması, docs yollarının
//      diskte gerçekten bulunması.
//
// Kullanım:
//   node scripts/validate-steps.mjs
//   node scripts/validate-steps.mjs --json
//   node scripts/validate-steps.mjs --steps docs/wizard/steps.json --schema docs/wizard/steps.schema.json
// -----------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validate } from "./lib/mini-jsonschema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(name + "="));
  return inline ? inline.slice(name.length + 1) : fallback;
}

if (has("--help") || has("-h")) {
  process.stdout.write(
    [
      "",
      "validate-steps.mjs — ders adım dosyasını şemasına karşı doğrular.",
      "",
      "KULLANIM",
      "  node scripts/validate-steps.mjs [--json] [--steps <yol>] [--schema <yol>]",
      "",
      "ÇIKIŞ KODLARI",
      "  0  şemaya ve anlamsal kurallara uygun",
      "  1  en az bir ihlal",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const JSON_MODE = has("--json");
const OUT = JSON_MODE ? process.stderr : process.stdout;
const USE_COLOR = !has("--no-color") && !process.env.NO_COLOR && OUT.isTTY;
const c = (code, s) => (USE_COLOR ? `[${code}m${s}[0m` : String(s));
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const write = (s = "") => OUT.write(s + "\n");

const stepsFile = path.resolve(ROOT, opt("--steps", "docs/wizard/steps.json"));
const schemaFile = path.resolve(ROOT, opt("--schema", "docs/wizard/steps.schema.json"));
const contractFile = path.join(ROOT, "contract", "tools.json");

for (const f of [stepsFile, schemaFile]) {
  if (!existsSync(f)) {
    process.stderr.write(`HATA: dosya bulunamadı: ${f}\n`);
    process.exit(1);
  }
}

const steps = JSON.parse(readFileSync(stepsFile, "utf8"));
const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
const contractTools = existsSync(contractFile)
  ? new Set((JSON.parse(readFileSync(contractFile, "utf8")).tools ?? []).map((t) => t.name))
  : null;

// ── 1) Yapısal doğrulama ─────────────────────────────────────────────────────
const structural = validate(schema, steps);

// ── 2) Anlamsal doğrulama ────────────────────────────────────────────────────
const semantic = [];
const warn = [];

const chapterIds = new Set((steps.chapters ?? []).map((ch) => ch.id));
const seenIds = new Set();
const usedChapters = new Set();

for (const [i, s] of (steps.steps ?? []).entries()) {
  const where = `steps[${i}] (${s?.id ?? "?"})`;

  if (!s || typeof s !== "object") continue;

  if (seenIds.has(s.id)) semantic.push({ path: where, message: `adım id'si tekrar ediyor: ${s.id}` });
  seenIds.add(s.id);

  if (s.chapter) {
    usedChapters.add(s.chapter);
    if (!chapterIds.has(s.chapter)) {
      semantic.push({ path: `${where}.chapter`, message: `chapters[] içinde yok: "${s.chapter}"` });
    }
  }

  // Tool adları sözleşmede var mı? (Sihirbaz olmayan bir tool'u çağırırsa
  // hata alır; ama bunu DERS SIRASINDA öğrenmek en kötü zamandır.)
  const toolRefs = [];
  if (s.callTool?.name) toolRefs.push([`${where}.callTool.name`, s.callTool.name]);
  for (const [j, cc] of (s.callToolSequence ?? []).entries()) {
    if (cc?.name) toolRefs.push([`${where}.callToolSequence[${j}].name`, cc.name]);
  }
  if (s.compareProtocols?.tool) toolRefs.push([`${where}.compareProtocols.tool`, s.compareProtocols.tool]);
  if (contractTools) {
    for (const [p, name] of toolRefs) {
      if (!contractTools.has(name)) {
        semantic.push({ path: p, message: `contract/tools.json içinde böyle bir tool yok: "${name}"` });
      }
    }
  }

  // Quiz cevap indeksi sınır içinde mi?
  if (s.quiz && Array.isArray(s.quiz.options) && Number.isInteger(s.quiz.answer)) {
    if (s.quiz.answer >= s.quiz.options.length) {
      semantic.push({
        path: `${where}.quiz.answer`,
        message: `indeks ${s.quiz.answer}, ama yalnızca ${s.quiz.options.length} seçenek var (0 tabanlı)`,
      });
    }
  }

  // Tablo satır uzunlukları başlık sayısıyla eşleşiyor mu?
  if (s.table && Array.isArray(s.table.headers) && Array.isArray(s.table.rows)) {
    const n = s.table.headers.length;
    for (const [j, row] of s.table.rows.entries()) {
      if (Array.isArray(row) && row.length !== n) {
        semantic.push({
          path: `${where}.table.rows[${j}]`,
          message: `${row.length} hücre var, başlık sayısı ${n}`,
        });
      }
    }
  }

  // expect ön koşulları: kontrol edilecek bir veri kaynağı var mı?
  const hasResultSource = Boolean(s.callTool?.name || s.callToolSequence?.length || s.compareProtocols);
  for (const [j, e] of (s.expect ?? []).entries()) {
    const p = `${where}.expect[${j}]`;
    if (e?.check === "protocolsAgree" && !s.compareProtocols) {
      semantic.push({ path: p, message: "protocolsAgree kontrolü var ama adımda compareProtocols yok" });
    }
    if (e?.check === "toolCount" && !s.listTools) {
      warn.push({ path: p, message: "toolCount kontrolü var ama adımda listTools yok — sihirbaz tools/list'i ayrıca çağırır" });
    }
    if (e?.path && !hasResultSource) {
      semantic.push({ path: p, message: `"${e.path}" yol kontrolü var ama adımda hiç tool çağrısı yok — kontrol SKIP olur` });
    }
  }

  // docs yolu diskte var mı? (#anchor kısmı atılır)
  if (s.docs) {
    const rel = String(s.docs).split("#")[0];
    if (rel && !existsSync(path.join(ROOT, rel))) {
      semantic.push({ path: `${where}.docs`, message: `dosya diskte yok: ${rel}` });
    }
  }
}

for (const ch of chapterIds) {
  if (!usedChapters.has(ch)) warn.push({ path: "chapters", message: `hiçbir adım "${ch}" bölümüne ait değil` });
}

// steps.json'un $schema referansı gerçekten bu şemayı gösteriyor mu?
if (steps.$schema) {
  const target = path.resolve(path.dirname(stepsFile), steps.$schema);
  if (!steps.$schema.startsWith("http") && target !== schemaFile) {
    warn.push({ path: "$schema", message: `"${steps.$schema}" doğruladığımız şemayı göstermiyor (${path.relative(ROOT, schemaFile)})` });
  }
} else {
  warn.push({ path: "$schema", message: "steps.json bir $schema referansı taşımıyor — editör desteği kaybolur" });
}

// ── Rapor ────────────────────────────────────────────────────────────────────
const errors = [...structural.errors, ...semantic];
const ok = errors.length === 0;

write("");
write(bold("  Ders adım dosyası doğrulaması"));
write(dim(`  adımlar : ${path.relative(ROOT, stepsFile)}`));
write(dim(`  şema    : ${path.relative(ROOT, schemaFile)}`));
write(dim(`  adım sayısı: ${(steps.steps ?? []).length}   bölüm sayısı: ${chapterIds.size}`));
write("");

if (structural.errors.length) {
  write(red(bold(`  ✘ YAPISAL: ${structural.errors.length} ihlal`)));
  for (const e of structural.errors) write(red(`    • ${e.path || "(kök)"}: ${e.message}`));
  write("");
}
if (semantic.length) {
  write(red(bold(`  ✘ ANLAMSAL: ${semantic.length} ihlal`)));
  for (const e of semantic) write(red(`    • ${e.path}: ${e.message}`));
  write("");
}
if (warn.length) {
  write(yellow(bold(`  ⚠ ${warn.length} uyarı (çıkış kodunu etkilemez)`)));
  for (const e of warn) write(yellow(`    • ${e.path}: ${e.message}`));
  write("");
}
if (ok) {
  write(green(bold("  ✔ steps.json ŞEMAYA UYGUN.")));
  write(dim("  Yapısal + anlamsal kontrollerin tamamı geçti."));
  write("");
}

if (JSON_MODE) {
  process.stdout.write(
    JSON.stringify(
      {
        ok,
        stepsFile: path.relative(ROOT, stepsFile),
        schemaFile: path.relative(ROOT, schemaFile),
        stepCount: (steps.steps ?? []).length,
        structuralErrors: structural.errors,
        semanticErrors: semantic,
        warnings: warn,
      },
      null,
      2,
    ) + "\n",
  );
}

process.exit(ok ? 0 : 1);
