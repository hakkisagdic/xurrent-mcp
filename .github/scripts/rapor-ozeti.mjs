#!/usr/bin/env node
/**
 * RAPOR ÖZETİ — test-all --json çıktısını Markdown'a çevirir.
 * ═════════════════════════════════════════════════════════
 *
 * Neden ayrı bir script: bu özeti ÜÇ yer istiyor —
 *   1) ci.yml            → iş akışı özet sayfası (GITHUB_STEP_SUMMARY)
 *   2) release.yml       → GitHub Release notunun "doğrulama" bölümü
 *   3) elle koşu         → `node .github/scripts/rapor-ozeti.mjs rapor.json`
 * Aynı Markdown üretecini YAML içine üç kez gömmek, bir gün tablo değiştiğinde
 * ikisini güncelleyip birini unutmak demektir.
 *
 * Birden fazla rapor verilebilir: ci.yml doğrulamayı HIZLI ve YAVAŞ diye iki
 * işe böler, her iş kendi raporunu üretir. Bu script ikisini TEK tabloda
 * birleştirir — okuyan insan bölünmeyi bilmek zorunda değildir.
 *
 * KULLANIM
 *   node .github/scripts/rapor-ozeti.mjs [seçenekler] <rapor.json> [rapor2.json ...]
 *
 * SEÇENEKLER
 *   --baslik <metin>   Tablonun üstündeki başlık (varsayılan "test-all")
 *   --kisa             Adım tablosunu basmaz; yalnızca tek satırlık özet.
 *                      Release notu için — orada 16 satırlık tablo gürültüdür.
 *   --eksik-onemsiz    Okunamayan rapor dosyası çıkış kodunu ETKİLEMESİN.
 *                      (koşu erken kırıldıysa dosya hiç üretilmemiş olur ve
 *                      bunu zaten asıl iş kırmızıya boyar; özet adımının da
 *                      kırmızı yanması aynı olayı iki kez saymaktır)
 *
 * ÇIKIŞ KODLARI
 *   0  hiçbir adım KALMADI
 *   1  en az bir adım KALDI (ya da rapor okunamadı, --eksik-onemsiz yoksa)
 *
 * NOT: durum sözcükleri test-all ile AYNIDIR — GEÇTİ · KALDI · ATLANDI.
 * ATLANDI bir başarısızlık DEĞİLDİR (ön koşul yoktu) ve çıkış kodunu etkilemez.
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
    "kullanım: node .github/scripts/rapor-ozeti.mjs [--baslik M] [--kisa] [--eksik-onemsiz] rapor.json...\n",
  );
  process.exit(0);
}

const BASLIK = opt("--baslik", "test-all");
const KISA = has("--kisa");
const EKSIK_ONEMSIZ = has("--eksik-onemsiz");
const BAYRAKLI = new Set(["--baslik", "--kisa", "--eksik-onemsiz", "--yardim", "--help", "-h"]);

// --baslik'in DEĞERİ dosya listesine sızmasın diye bayrak değerlerini ayıkla.
const dosyalar = argv.filter((a, i) => {
  if (a.startsWith("--") || a === "-h") return false;
  return argv[i - 1] !== "--baslik";
});
for (const a of argv)
  if (a.startsWith("--") && !BAYRAKLI.has(a)) {
    process.stderr.write(`rapor-ozeti: bilinmeyen seçenek ${a}\n`);
    process.exit(2);
  }

if (!dosyalar.length) {
  process.stderr.write("rapor-ozeti: en az bir rapor dosyası verin.\n");
  process.exit(2);
}

// ── Raporları oku ───────────────────────────────────────────────────────────
const raporlar = [];
const okunamayan = [];
for (const d of dosyalar) {
  try {
    raporlar.push({ dosya: d, ...JSON.parse(readFileSync(d, "utf8")) });
  } catch (e) {
    okunamayan.push({ dosya: d, sebep: e?.message ?? String(e) });
  }
}

const satirlar = [];
const yaz = (s = "") => satirlar.push(s);
const kacir = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const sn = (ms) => `${(Number(ms ?? 0) / 1000).toFixed(1)}s`;

// Adımlar birden çok rapordan gelebilir. AYNI id iki raporda da varsa (hızlı iş
// derlemeyi koşar, yavaş iş de koşar — bkz. ci.yml) SONUNCUSU değil, KÖTÜ OLANI
// tutulur: bir adım bir koşuda geçip diğerinde kaldıysa özet "geçti" DEMEMELİDİR.
const agirlik = { "GEÇTİ": 0, ATLANDI: 1, KALDI: 2 };
const adimlar = new Map();
for (const r of raporlar)
  for (const a of r.adimlar ?? []) {
    const onceki = adimlar.get(a.id);
    if (!onceki || (agirlik[a.durum] ?? 0) > (agirlik[onceki.durum] ?? 0)) adimlar.set(a.id, a);
  }

const hepsi = [...adimlar.values()];
const ozet = {
  toplam: hepsi.length,
  gecti: hepsi.filter((a) => a.durum === "GEÇTİ").length,
  kaldi: hepsi.filter((a) => a.durum === "KALDI").length,
  atlandi: hepsi.filter((a) => a.durum === "ATLANDI").length,
};
const toplamSure = raporlar.reduce((t, r) => t + Number(r.sureMs ?? 0), 0);
const ok = ozet.kaldi === 0;

// ── Markdown ────────────────────────────────────────────────────────────────
const isaret = { "GEÇTİ": "✅", KALDI: "❌", ATLANDI: "⏭️" };

yaz(`## ${BASLIK}`);
yaz("");

if (okunamayan.length) {
  yaz(`> ⚠️ ${okunamayan.length} rapor okunamadı — koşu daha erken kırılmış olabilir:`);
  for (const o of okunamayan) yaz(`> - \`${kacir(o.dosya)}\` — ${kacir(o.sebep)}`);
  yaz("");
}

if (hepsi.length) {
  if (!KISA) {
    yaz("| adım | grup | durum | süre | kanıt |");
    yaz("|---|---|---|---|---|");
    for (const a of hepsi)
      yaz(
        `| \`${kacir(a.id)}\` | ${kacir(a.grup)} | ${isaret[a.durum] ?? ""} ${kacir(a.durum)} | ${sn(a.sureMs)} | ${kacir(a.kanit)} |`,
      );
    yaz("");
  }

  yaz(
    `**${ozet.gecti} geçti · ${ozet.kaldi} kaldı · ${ozet.atlandi} atlandı** ` +
      `— ${ozet.toplam} adım, ${sn(toplamSure)}`,
  );
  yaz("");

  if (ozet.kaldi) {
    yaz("### Kalan adımlar");
    yaz("");
    for (const a of hepsi.filter((a) => a.durum === "KALDI")) yaz(`- \`${kacir(a.id)}\` — ${kacir(a.kanit)}`);
    yaz("");
  }

  // ATLANDI bir başarısızlık değildir; ama SESSİZ de kalmamalıdır. Bir adım
  // "ön koşul yoktu" diye atlandıysa ve bunu kimse görmezse, o katman aylarca
  // hiç koşmamış olabilir.
  if (ozet.atlandi) {
    yaz("<details><summary>Atlanan adımlar (ön koşul yoktu — başarısızlık DEĞİL)</summary>");
    yaz("");
    for (const a of hepsi.filter((a) => a.durum === "ATLANDI")) yaz(`- \`${kacir(a.id)}\` — ${kacir(a.kanit)}`);
    yaz("");
    yaz("</details>");
    yaz("");
  }

  const ort = raporlar[0]?.ortam;
  if (ort) yaz(`<sub>node ${kacir(ort.node)} · ${kacir(ort.platform)} · TZ ${kacir(ort.tz)}</sub>`);
} else {
  yaz("_Hiç adım raporlanmadı._");
}

// ★ process.exit() KULLANILMIYOR: Node'da stdout bir BORUYA yazarken asenkrondur
// ve hemen ardından gelen process.exit() yazımı yarıda keser. Bu tuzağa bu
// repoda bir kez düşüldü (bkz. scripts/test-all.mjs `stdoutDosya` yorumu).
// exitCode atanır, süreç doğal olarak biter ve tampon boşalır.
process.stdout.write(satirlar.join("\n") + "\n");
process.exitCode = ok && (EKSIK_ONEMSIZ || !okunamayan.length) ? 0 : 1;
