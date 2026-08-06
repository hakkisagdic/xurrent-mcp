#!/usr/bin/env node
/**
 * GÜVENLİK EŞİĞİ — üç paket yöneticisinin denetim çıktısını TEK karara indirger.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Sorun: `npm audit`, `pip-audit` ve `dotnet list package --vulnerable` üç ayrı
 * JSON şeması, üç ayrı şiddet sözlüğü ve üç ayrı çıkış kodu politikası kullanır.
 * Bunları YAML içinde ayrı ayrı yorumlamak üç ayrı yanlış yorum üretir.
 *
 * Bu script hepsini AYNI bulgu modeline çevirir ve TEK eşiği uygular:
 *
 *   kritik · yüksek   → KIRAR   (çıkış kodu 1)
 *   orta · düşük      → RAPOR EDER (çıkış kodu 0)
 *   bilinmeyen        → varsayılan KIRAR, --bilinmeyen rapor ile yumuşatılır
 *
 * ★ "bilinmeyen" NEDEN VAR: pip-audit bir şiddet alanı ÜRETMEZ. OSV kaydında
 *   CVSS olsa bile pip-audit onu dışarı vermez. Elimizde "bir Python bağımlılığı
 *   için danışma kaydı var" bilgisinden fazlası yoktur. İki seçenek vardı:
 *     (a) bilinmeyeni düşük say → gerçek bir kritik CVE sessizce geçer,
 *     (b) bilinmeyeni yüksek say → önemsiz bir danışma kaydı ders günü CI'yı kırar.
 *   Varsayılan (b)'dir: sessiz geçmek, gürültüden DAHA PAHALIDIR. (a)'ya geçmek
 *   bir KARAR olmalıdır, bir alışkanlık değil — bu yüzden bayrakla açılır.
 *   Ayrıntı: .github/KARARLAR-CICD.md § K-5
 *
 * KULLANIM
 *   node .github/scripts/guvenlik-esigi.mjs --kaynak npm   --dosya npm-audit.json
 *   node .github/scripts/guvenlik-esigi.mjs --kaynak pip   --dosya pip-audit.json
 *   node .github/scripts/guvenlik-esigi.mjs --kaynak nuget --dosya dotnet-vuln.json
 *
 * SEÇENEKLER
 *   --esik <kritik|yuksek|orta|dusuk>   Bu seviye ve ÜSTÜ kırar (varsayılan yuksek)
 *   --bilinmeyen <kir|rapor>            Şiddeti bilinmeyen bulgu ne olsun (varsayılan kir)
 *   --ad <metin>                        Başlıkta görünecek ad (varsayılan kaynak adı)
 *
 * ÇIKIŞ KODLARI
 *   0  eşiği aşan bulgu yok
 *   1  eşiği aşan en az bir bulgu var
 *   2  hatalı parametre / okunamayan girdi
 */

import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, def = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

if (has("--yardim") || has("--help") || has("-h")) {
  process.stdout.write(
    "kullanım: node .github/scripts/guvenlik-esigi.mjs --kaynak <npm|pip|nuget> --dosya <rapor.json> " +
      "[--esik yuksek] [--bilinmeyen kir|rapor] [--ad metin]\n",
  );
  process.exit(0);
}

const KAYNAK = opt("--kaynak");
const DOSYA = opt("--dosya");
const ESIK = opt("--esik", "yuksek");
const BILINMEYEN = opt("--bilinmeyen", "kir");
const AD = opt("--ad", KAYNAK);

if (!KAYNAK || !DOSYA) {
  process.stderr.write("guvenlik-esigi: --kaynak ve --dosya zorunludur.\n");
  process.exit(2);
}
if (!["npm", "pip", "nuget"].includes(KAYNAK)) {
  process.stderr.write(`guvenlik-esigi: bilinmeyen kaynak "${KAYNAK}" (npm|pip|nuget)\n`);
  process.exit(2);
}

// Sıralama: büyük sayı = daha ağır. "bilinmeyen" bilerek en TEPEDE değil —
// yerini --bilinmeyen bayrağı belirler, sabit bir ağırlığı yoktur.
const SIRA = { dusuk: 1, orta: 2, yuksek: 3, kritik: 4 };
if (!SIRA[ESIK]) {
  process.stderr.write(`guvenlik-esigi: bilinmeyen eşik "${ESIK}" (kritik|yuksek|orta|dusuk)\n`);
  process.exit(2);
}
if (!["kir", "rapor"].includes(BILINMEYEN)) {
  process.stderr.write(`guvenlik-esigi: --bilinmeyen kir|rapor olmalı ("${BILINMEYEN}" verildi)\n`);
  process.exit(2);
}

let ham;
try {
  const metin = readFileSync(DOSYA, "utf8").trim();
  // Denetim aracı hiç çalışmadıysa dosya BOŞ olabilir. Boş dosyayı "bulgu yok"
  // saymak, aracın çökmesini temiz koşu gibi göstermek olurdu.
  if (!metin) throw new Error("dosya boş — denetim aracı çıktı üretmedi");
  ham = JSON.parse(metin);
} catch (e) {
  process.stderr.write(`guvenlik-esigi: ${DOSYA} okunamadı — ${e?.message ?? e}\n`);
  process.exit(2);
}

// ── Normalleştiriciler ──────────────────────────────────────────────────────
/** @typedef {{paket:string, surum:string, seviye:string, id:string, not:string}} Bulgu */

/** npm audit --json (auditReportVersion 2) */
function npmBulgulari(r) {
  const harita = { critical: "kritik", high: "yuksek", moderate: "orta", low: "dusuk", info: "dusuk" };
  const cikti = [];
  for (const [ad, v] of Object.entries(r.vulnerabilities ?? {})) {
    // `via` ya bir danışma nesnesi ya da BAŞKA BİR PAKET ADI (string) olabilir —
    // ikincisi "bu paket şu yüzünden etkilendi" zinciridir, kendi başına bulgu değil.
    const danismalar = (v.via ?? []).filter((x) => typeof x === "object");
    const idler = danismalar.map((d) => d.url ?? d.source ?? d.title).filter(Boolean);
    cikti.push({
      paket: ad,
      surum: v.range ?? "",
      seviye: harita[String(v.severity ?? "").toLowerCase()] ?? "bilinmeyen",
      id: idler.slice(0, 2).join(", ") || "—",
      not:
        (danismalar[0]?.title ?? "") +
        (v.fixAvailable ? " · düzeltme var" : " · düzeltme YOK") +
        (v.isDirect ? " · doğrudan bağımlılık" : ""),
    });
  }
  return cikti;
}

/** pip-audit --format json */
function pipBulgulari(r) {
  const cikti = [];
  for (const d of r.dependencies ?? [])
    for (const v of d.vulns ?? [])
      cikti.push({
        paket: d.name ?? "?",
        surum: d.version ?? "",
        // ★ pip-audit ŞİDDET ÜRETMEZ. Uydurmuyoruz.
        seviye: "bilinmeyen",
        id: [v.id, ...(v.aliases ?? [])].filter(Boolean).slice(0, 2).join(", ") || "—",
        not:
          (v.fix_versions?.length ? `düzeltme: ${v.fix_versions.join(", ")}` : "düzeltme YOK") +
          (v.description ? ` · ${String(v.description).split(/\r?\n/)[0].slice(0, 120)}` : ""),
      });
  return cikti;
}

/** dotnet list package --vulnerable --format json */
function nugetBulgulari(r) {
  const harita = { critical: "kritik", high: "yuksek", moderate: "orta", medium: "orta", low: "dusuk" };
  // Bazı .NET sürümleri şiddeti SAYI olarak verir (0=Low … 3=Critical).
  const sayidan = ["dusuk", "orta", "yuksek", "kritik"];
  const cikti = [];
  for (const p of r.projects ?? [])
    for (const f of p.frameworks ?? [])
      for (const kume of ["topLevelPackages", "transitivePackages"])
        for (const pkg of f[kume] ?? [])
          for (const v of pkg.vulnerabilities ?? []) {
            const s = v.severity;
            const seviye =
              typeof s === "number" ? (sayidan[s] ?? "bilinmeyen") : (harita[String(s ?? "").toLowerCase()] ?? "bilinmeyen");
            cikti.push({
              paket: pkg.id ?? "?",
              surum: pkg.resolvedVersion ?? pkg.requestedVersion ?? "",
              seviye,
              id: v.advisoryurl ?? v.advisoryUrl ?? "—",
              not: `${f.framework ?? ""}${kume === "transitivePackages" ? " · transitif" : " · doğrudan"}`,
            });
          }
  return cikti;
}

const bulgular = { npm: npmBulgulari, pip: pipBulgulari, nuget: nugetBulgulari }[KAYNAK](ham);

// ── Karar ───────────────────────────────────────────────────────────────────
const kirar = (b) =>
  b.seviye === "bilinmeyen" ? BILINMEYEN === "kir" : (SIRA[b.seviye] ?? 0) >= SIRA[ESIK];

const kiranlar = bulgular.filter(kirar);
const raporlananlar = bulgular.filter((b) => !kirar(b));

const sayim = {};
for (const b of bulgular) sayim[b.seviye] = (sayim[b.seviye] ?? 0) + 1;

// ── Markdown ────────────────────────────────────────────────────────────────
const kacir = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const isaret = { kritik: "🟥", yuksek: "🟧", orta: "🟨", dusuk: "⬜", bilinmeyen: "❔" };
const satirlar = [];
const yaz = (s = "") => satirlar.push(s);

yaz(`### ${AD}`);
yaz("");

if (!bulgular.length) {
  yaz("✅ Bilinen açık yok.");
} else {
  const dagilim = Object.entries(sayim)
    .sort((a, b) => (SIRA[b[0]] ?? 9) - (SIRA[a[0]] ?? 9))
    .map(([s, n]) => `${isaret[s] ?? ""} ${n} ${s}`)
    .join(" · ");
  yaz(`${kiranlar.length ? "❌" : "⚠️"} ${bulgular.length} bulgu — ${dagilim}`);
  yaz("");
  yaz("| seviye | paket | sürüm/aralık | kayıt | not |");
  yaz("|---|---|---|---|---|");
  for (const b of [...kiranlar, ...raporlananlar])
    yaz(
      `| ${isaret[b.seviye] ?? ""} ${kacir(b.seviye)} | \`${kacir(b.paket)}\` | ${kacir(b.surum)} | ${kacir(b.id)} | ${kacir(b.not)} |`,
    );
  yaz("");
  yaz(
    `Eşik: **${ESIK}** ve üstü kırar · şiddeti bilinmeyen bulgu: **${BILINMEYEN === "kir" ? "kırar" : "yalnızca raporlanır"}**` +
      (KAYNAK === "pip"
        ? " — `pip-audit` şiddet alanı üretmez, bu yüzden Python bulguları her zaman *bilinmeyen*dir."
        : ""),
  );
}

process.stdout.write(satirlar.join("\n") + "\n");
// stderr: iş akışı LOGUNDA da görünsün — özet sayfasına inmeden fark edilsin.
process.stderr.write(
  `guvenlik-esigi[${KAYNAK}]: ${bulgular.length} bulgu · ${kiranlar.length} eşiği aştı · eşik=${ESIK} bilinmeyen=${BILINMEYEN}\n`,
);
// ★ process.exit() değil exitCode: stdout boruya yazılıyorsa exit() yazımı keser.
process.exitCode = kiranlar.length ? 1 : 0;
