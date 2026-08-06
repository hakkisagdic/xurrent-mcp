#!/usr/bin/env node
// -----------------------------------------------------------------------------
// validate-plugins.mjs — plugins/*/manifest.json dosyalarını
// plugins/manifest.schema.json şemasına karşı doğrular.
//
// NEDEN: plugin modeli "konfigürasyonla seçilen adaptör + paketlenmiş yüzey
// tanımı"dır (bkz. docs/17). Manifest bir SÖZLEŞMEDİR: yanlış env adı yazan,
// var olmayan bir dokümana işaret eden ya da dizin adıyla uyuşmayan bir
// manifest, plugin'i sessizce kullanılamaz kılar. Steps/adimlar dosyalarında
// öğrenilen ders buraya da uygulanır: editörde kırmızı çizgi yoksa CI çizsin.
//
// İki katman doğrulama:
//   1) YAPISAL — JSON Schema (scripts/lib/mini-jsonschema.mjs, bağımlılıksız)
//   2) ANLAMSAL — şemanın ifade edemedikleri:
//      · ad == dizin adı
//      · dokuman yolu diskte var
//      · gerektirdigiEnv ve secimAnahtari.env anahtarları .env.example'da BELGELİ
//      · artefaktlar dosyaları diskte var
//      · yerlesik=true ise secimAnahtari zorunlu (env ile seçilemeyen yerleşik
//        plugin etkinleştirilemez)
//
// Kullanım:
//   node scripts/validate-plugins.mjs
//   node scripts/validate-plugins.mjs --json
// -----------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validate } from "./lib/mini-jsonschema.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");
const JSON_MODE = process.argv.includes("--json");

const sorunlar = [];
const sorun = (plugin, mesaj) => sorunlar.push({ plugin, mesaj });

// ── şema ────────────────────────────────────────────────────────────────────
const semaYolu = path.join(PLUGINS_DIR, "manifest.schema.json");
if (!existsSync(semaYolu)) {
  console.error(`HATA: şema bulunamadı: ${semaYolu}`);
  process.exit(2);
}
const sema = JSON.parse(readFileSync(semaYolu, "utf8"));

// ── .env.example'daki belgeli anahtarlar ────────────────────────────────────
// Yorum satırlarında da geçebilir (ör. FAKE_XURRENT_PORT gibi), ama sözleşme
// "belgelenmiş olmak"tır: KEY= atamasını VEYA satır başında yorum içinde açık
// anılmayı kabul ediyoruz — ikisi de dosyada aranabilir metindir.
const envMetni = readFileSync(path.join(ROOT, ".env.example"), "utf8");
const envBelgeli = (anahtar) => new RegExp(`(^|[^A-Z0-9_])${anahtar}([^A-Z0-9_]|$)`, "m").test(envMetni);

// ── manifest'leri topla ─────────────────────────────────────────────────────
const dizinler = readdirSync(PLUGINS_DIR)
  .filter((d) => statSync(path.join(PLUGINS_DIR, d)).isDirectory())
  .sort();

if (dizinler.length === 0) {
  console.error("HATA: plugins/ altında hiç plugin dizini yok — boş dizin sessizce geçmez.");
  process.exit(1);
}

let sayi = 0;
for (const dizin of dizinler) {
  const manifestYolu = path.join(PLUGINS_DIR, dizin, "manifest.json");
  if (!existsSync(manifestYolu)) {
    sorun(dizin, "manifest.json yok — plugin dizini manifest'siz olamaz");
    continue;
  }
  sayi++;

  let m;
  try {
    m = JSON.parse(readFileSync(manifestYolu, "utf8"));
  } catch (e) {
    sorun(dizin, `manifest.json geçerli JSON değil: ${e.message}`);
    continue;
  }

  // $schema alanı şemada tanımlı değil (additionalProperties: false) —
  // editör desteği için kaldırmadan önce doğrulamadan düşürüyoruz.
  const { $schema: _ignored, ...govde } = m;

  // 1) YAPISAL
  const yapisal = validate(sema, govde);
  for (const h of yapisal.errors) sorun(dizin, `şema: ${h.path || "(kök)"} — ${h.message}`);
  if (!yapisal.valid) continue; // anlamsal katman çöp veriyle uğraşmasın

  // 2) ANLAMSAL
  if (govde.ad !== dizin) {
    sorun(dizin, `ad ('${govde.ad}') dizin adıyla ('${dizin}') uyuşmuyor`);
  }
  if (!existsSync(path.join(ROOT, govde.dokuman))) {
    sorun(dizin, `dokuman diskte yok: ${govde.dokuman}`);
  }
  for (const anahtar of govde.gerektirdigiEnv ?? []) {
    if (!envBelgeli(anahtar)) {
      sorun(dizin, `gerektirdigiEnv '${anahtar}' .env.example'da belgeli değil`);
    }
  }
  if (govde.secimAnahtari && !envBelgeli(govde.secimAnahtari.env)) {
    sorun(dizin, `secimAnahtari.env '${govde.secimAnahtari.env}' .env.example'da belgeli değil`);
  }
  for (const dosya of govde.artefaktlar ?? []) {
    if (!existsSync(path.join(PLUGINS_DIR, dizin, dosya))) {
      sorun(dizin, `artefakt diskte yok: ${dosya}`);
    }
  }
  if (govde.yerlesik === true && !govde.secimAnahtari) {
    sorun(dizin, "yerlesik=true ama secimAnahtari yok — env ile seçilemeyen yerleşik plugin etkinleştirilemez");
  }
}

// ── rapor ───────────────────────────────────────────────────────────────────
if (JSON_MODE) {
  console.log(JSON.stringify({ pluginSayisi: sayi, sorunlar }, null, 2));
} else {
  console.error(`[validate-plugins] ${sayi} manifest incelendi (${dizinler.length} dizin)`);
  for (const s of sorunlar) console.error(`  ✘ [${s.plugin}] ${s.mesaj}`);
  if (!sorunlar.length) console.error("  ✔ tüm manifest'ler geçerli");
}
process.exit(sorunlar.length ? 1 : 0);
