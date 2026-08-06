#!/usr/bin/env node
/**
 * TEST-ALL — bu repodaki BÜTÜN doğrulama katmanlarını tek komutta koşar.
 * ══════════════════════════════════════════════════════════════════════
 *
 * Neden var: repoda sekiz ayrı doğrulayıcı var ve her biri FARKLI bir hata
 * sınıfını yakalıyor (bkz. docs/14-test-ve-kalite.md). Ayrı ayrı çalıştırmak
 * "hangisini unuttum" sorusunu insana bırakır. Bu script o soruyu ortadan
 * kaldırır: tek komut, tek özet tablo, tek çıkış kodu.
 *
 * ÜÇ DURUM MODELİ — repodaki diğer koşucularla (sihirbaz, atölye) aynıdır:
 *   GEÇTİ    kontrol çalıştı ve tuttu
 *   KALDI    kontrol çalıştı ve TUTMADI  → gerçek başarısızlık, exit 1
 *   ATLANDI  kontrol ÇALIŞTIRILAMADI (ön koşul yok) → başarısızlık DEĞİLDİR
 *
 * Bu ayrım bilinçlidir. `dotnet` kurulu olmayan bir makinede C# adımlarının
 * KIRMIZI yanması, gerçek bir kırılmayı gürültüye gömer. Ön koşulu olmayan
 * adım ATLANDI'dır ve çıkış kodunu etkilemez.
 *
 * Kullanım:
 *   node scripts/test-all.mjs
 *   node scripts/test-all.mjs --hizli
 *   node scripts/test-all.mjs --sadece sozlesme,sihirbaz-ts
 *   node scripts/test-all.mjs --json
 *   node scripts/test-all.mjs --bilinen-ihlaller
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const IHLAL_DOSYASI = path.join(HERE, "bilinen-ihlaller.json");

// ── Bayraklar ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, def = null) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

if (has("--yardim") || has("--help") || has("-h")) {
  process.stdout.write(`
test-all.mjs — repodaki bütün doğrulama katmanlarını tek komutta koşar

KULLANIM
  node scripts/test-all.mjs [seçenekler]

SEÇENEKLER
  --hizli               Yavaş adımları (mcp-uyum, senaryolar, py/cs sihirbazı) ATLAR
  --sadece <ad[,ad]>    Sadece bu adımları koşar. Önek eşleşmesi: --sadece sihirbaz
  --json                Makine-okunur rapor stdout'a; anlatım stderr'e
  --bilinen-ihlaller    scripts/bilinen-ihlaller.json'daki MUST ihlallerini
                        KALDI değil ATLANDI sayar (liste görünür kalsın diye)
  --liste               Adımları listeler ve çıkar
  --zaman-asimi <ms>    Adım başına zaman aşımı (varsayılan 600000)
  --no-color            ANSI renklerini kapatır
  --yardim              Bu yardım

ÇIKIŞ KODLARI
  0  hiçbir adım KALMADI
  1  en az bir adım KALDI
  2  hatalı parametre

DURUM MODELİ
  GEÇTİ · KALDI · ATLANDI. Ön koşulu olmayan adım (dotnet yok, node_modules yok,
  test dosyası yok) ATLANDI'dır ve çıkış kodunu ETKİLEMEZ.
`);
  process.exit(0);
}

const HIZLI = has("--hizli");
const JSON_MODE = has("--json");
const BILINEN = has("--bilinen-ihlaller");
const LISTE = has("--liste");
const ZAMAN_ASIMI = Number(opt("--zaman-asimi", "600000"));
const SADECE = (opt("--sadece") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const OUT = JSON_MODE ? process.stderr : process.stdout;
const NO_COLOR = has("--no-color") || !!process.env["NO_COLOR"] || !OUT.isTTY;
const C = NO_COLOR
  ? { g: "", r: "", y: "", d: "", b: "", c: "", x: "" }
  : { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", c: "\x1b[36m", x: "\x1b[0m" };
const write = (s = "") => OUT.write(s + "\n");

const GECTI = "GEÇTİ";
const KALDI = "KALDI";
const ATLANDI = "ATLANDI";

// ── Alt süreç koşucusu ──────────────────────────────────────────────────────
/**
 * Bir komutu koşar; stdout/stderr'i TAMAMEN toplar (adım kanıtı oradan çıkar).
 * Zaman aşımında süreci öldürür ve `zamanAsimi: true` döner — asılı kalan bir
 * adımın CI'yı süresiz meşgul etmesi engellenir.
 */
function kos(komut, args, { cwd = REPO, env = {}, timeout = ZAMAN_ASIMI, stdin = null, stdoutDosya = null } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    // ★ stdoutDosya: çocuğun stdout'u BORU değil DOSYA olur.
    // Sebebi bir tuzak: Node'da `process.stdout.write()` boruya yazarken
    // ASENKRONDUR; hemen ardından gelen `process.exit()` yazımı YARIDA KESER.
    // Repodaki --json üreten script'ler tam olarak bu deseni kullanıyor, bu
    // yüzden büyük raporlar (mcp-uyum ~130 KB) boru üzerinden EKSİK gelir —
    // 64 KB'lık boru tamponu dolduğu anda kesilir. Dosyaya yazım POSIX'te
    // senkron olduğu için bu kesilme olmaz. Kabuk `> dosya.json` yazdığında
    // çalışıp koşucudan çalışmamasının sebebi buydu.
    const fd = stdoutDosya ? openSync(stdoutDosya, "w") : null;
    const p = spawn(komut, args, {
      cwd,
      env: { ...process.env, ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["pipe", fd ?? "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let asildi = false;
    const zamanlayici = setTimeout(() => {
      asildi = true;
      p.kill("SIGKILL");
    }, timeout);

    const bitir = (sonuc) => {
      clearTimeout(zamanlayici);
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* yut */
        }
        try {
          sonuc.out = readFileSync(stdoutDosya, "utf8");
        } catch {
          /* yut */
        }
      }
      resolve(sonuc);
    };

    if (!fd) p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", (e) =>
      bitir({ kod: -1, out, err: err + String(e?.message ?? e), sure: performance.now() - t0, baslatilamadi: true }),
    );
    p.on("close", (kod) => bitir({ kod: kod ?? -1, out, err, sure: performance.now() - t0, zamanAsimi: asildi }));

    if (stdin !== null) p.stdin.end(stdin);
    else p.stdin.end();
  });
}

/** `kos` + JSON raporu. stdout GEÇİCİ DOSYAYA yönlendirilir (yukarıdaki tuzak). */
let gecici = 0;
async function kosJson(komut, args, secenekler = {}) {
  const yol = path.join(os.tmpdir(), `xurrent-test-all-${process.pid}-${gecici++}.json`);
  try {
    const r = await kos(komut, args, { ...secenekler, stdoutDosya: yol });
    return { r, rapor: jsonAyristir(r.out) };
  } finally {
    try {
      rmSync(yol, { force: true });
    } catch {
      /* yut */
    }
  }
}

const varMi = (p) => existsSync(path.join(REPO, p));
const oku = (p) => readFileSync(path.join(REPO, p), "utf8");

/** PATH'te bir komut var mı? `--version` denemesi en güvenilir yol. */
const komutCache = new Map();
async function komutVar(komut, args = ["--version"]) {
  if (komutCache.has(komut)) return komutCache.get(komut);
  const r = await kos(komut, args, { timeout: 30000 });
  const sonuc = !r.baslatilamadi;
  komutCache.set(komut, sonuc);
  return sonuc;
}

/** JSON stdout'u güvenle ayrıştırır — anlatım stderr'e gittiği için stdout temiz olmalı. */
function jsonAyristir(metin) {
  try {
    return JSON.parse(metin);
  } catch {
    // Bazı araçlar JSON'dan önce/sonra satır yazabilir; ilk { ile son } arasını dene.
    const a = metin.indexOf("{");
    const b = metin.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(metin.slice(a, b + 1));
      } catch {
        /* yut */
      }
    }
    return null;
  }
}

/** Bir hatanın ilk anlamlı satırını kanıt olarak çıkarır. */
function ilkHataSatiri(r, n = 160) {
  const kaynak = (r.err || "") + "\n" + (r.out || "");
  const satir = kaynak
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !/^[─═╌│└├┌]/.test(s))
    .find((s) => /error|hata|fail|kaldı|kaldi|✘|✗|Traceback|Exception/i.test(s));
  return (satir ?? kaynak.split("\n").filter(Boolean).slice(-1)[0] ?? "(çıktı yok)").slice(0, n);
}

const sn = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)}s`);

// ── Bilinen ihlaller ────────────────────────────────────────────────────────
/**
 * Bilinen MUST ihlalleri AYRI BİR DOSYADA tutulur. Sebebi: bir istisnayı koda
 * gömmek onu görünmez kılar. Ayrı dosya listeyi bir ENVANTERE dönüştürür —
 * gözden geçirilebilir, küçültülebilir, PR'da diff'i görünür.
 */
function bilinenIhlalleriYukle() {
  if (!existsSync(IHLAL_DOSYASI)) return { maddeler: [] };
  try {
    return JSON.parse(readFileSync(IHLAL_DOSYASI, "utf8"));
  } catch (e) {
    write(C.y + `  uyarı: ${path.relative(REPO, IHLAL_DOSYASI)} okunamadı — ${e.message}` + C.x);
    return { maddeler: [] };
  }
}

// ── Adım tanımları ──────────────────────────────────────────────────────────
// Her adım: id, ad (insan okur), yavas (hizli modda atlanır), gerektirir (adım
// bağımlılığı), kos (async → {durum, kanit, detay?}).
//
// `gerektirir` bağımlılığı KALDI ya da ATLANDI ise adım ATLANDI olur. Yani
// tsc kırıldığında ondan türeyen sekiz adım kırmızı yanmaz; bir kök neden
// gösterilir. Gürültüyü azaltan tek şey budur.

const ADIMLAR = [
  // ── Derleme ───────────────────────────────────────────────────────────────
  {
    id: "derle-ts",
    ad: "TypeScript derleme",
    grup: "derleme",
    async kos() {
      if (!varMi("servers/typescript/node_modules"))
        return { durum: ATLANDI, kanit: "servers/typescript/node_modules yok — önce `npm install`" };
      if (!(await komutVar("npm"))) return { durum: ATLANDI, kanit: "npm PATH'te yok" };
      const r = await kos("npm", ["run", "build", "--silent"], { cwd: path.join(REPO, "servers/typescript") });
      if (r.kod !== 0) return { durum: KALDI, kanit: ilkHataSatiri(r), detay: r.out + r.err };
      const hedef = "servers/typescript/dist/mcp/stdio.js";
      if (!varMi(hedef)) return { durum: KALDI, kanit: `derleme 0 döndü ama ${hedef} yok` };
      return { durum: GECTI, kanit: `tsc temiz · ${hedef} üretildi` };
    },
  },
  {
    id: "derle-py",
    ad: "Python ortam senkronu",
    grup: "derleme",
    async kos() {
      if (!(await komutVar("uv"))) return { durum: ATLANDI, kanit: "uv PATH'te yok" };
      const r = await kos("uv", ["sync", "--quiet"], { cwd: path.join(REPO, "servers/python") });
      if (r.kod !== 0) return { durum: KALDI, kanit: ilkHataSatiri(r), detay: r.out + r.err };
      return { durum: GECTI, kanit: "uv sync tamam · .venv hazır" };
    },
  },
  {
    id: "derle-cs",
    ad: "C# derleme",
    grup: "derleme",
    async kos() {
      if (!(await komutVar("dotnet"))) return { durum: ATLANDI, kanit: "dotnet PATH'te yok" };
      const r = await kos("dotnet", ["build", "servers/csharp/XurrentMcp.csproj", "--nologo", "-v", "quiet"]);
      if (r.kod !== 0) return { durum: KALDI, kanit: ilkHataSatiri(r), detay: r.out + r.err };
      const uyari = (r.out.match(/warning/gi) ?? []).length;
      return { durum: GECTI, kanit: `derleme başarılı${uyari ? ` · ${uyari} uyarı` : " · uyarı yok"}` };
    },
  },

  // ── Birim testler (çekirdek iş mantığı) ───────────────────────────────────
  {
    id: "birim-ts",
    ad: "TypeScript birim testleri",
    grup: "birim",
    gerektirir: ["derle-ts"],
    async kos() {
      const pkg = JSON.parse(oku("servers/typescript/package.json"));
      const scripts = pkg.scripts ?? {};
      // "test" varsa o TOPLAYICIDIR; yoksa test:* olan HER script koşulur.
      // Böylece paralel eklenen yeni bir test script'i sessizce dışarıda kalmaz.
      const hedefler = scripts["test"] ? ["test"] : Object.keys(scripts).filter((k) => /^test[:-]/.test(k));
      if (!hedefler.length)
        return { durum: ATLANDI, kanit: "package.json'da test / test:* script'i yok" };

      let gecti = 0;
      let kaldi = 0;
      const parcalar = [];
      for (const s of hedefler) {
        const r = await kos("npm", ["run", s, "--silent"], { cwd: path.join(REPO, "servers/typescript") });
        const metin = r.out + r.err;
        const p = Number(metin.match(/(?:#|ℹ)\s*pass\s+(\d+)/)?.[1] ?? 0);
        const f = Number(metin.match(/(?:#|ℹ)\s*fail\s+(\d+)/)?.[1] ?? (r.kod === 0 ? 0 : 1));
        gecti += p;
        kaldi += f;
        parcalar.push(`${s}: ${p || (r.kod === 0 ? "ok" : "?")}${f ? `/${f} kaldı` : ""}`);
        if (r.kod !== 0 && !f) kaldi += 1;
        if (r.kod !== 0) parcalar.push(ilkHataSatiri(r, 100));
      }
      return {
        durum: kaldi ? KALDI : GECTI,
        kanit: `${hedefler.length} script · ${gecti} geçti${kaldi ? ` · ${kaldi} KALDI` : ""} — ${parcalar.join(" | ")}`,
      };
    },
  },
  {
    id: "birim-py",
    ad: "Python birim testleri",
    grup: "birim",
    gerektirir: ["derle-py"],
    async kos() {
      const dizinler = ["servers/python/tests", "servers/python/src/xurrent_mcp"];
      const testVar = dizinler.some((d) => varMi(d) && testDosyasiAra(path.join(REPO, d)));
      if (!testVar) return { durum: ATLANDI, kanit: "servers/python altında test_*.py bulunamadı" };
      const r = await kos("uv", ["run", "--quiet", "pytest", "-q"], { cwd: path.join(REPO, "servers/python") });
      const metin = r.out + r.err;
      const p = metin.match(/(\d+)\s+passed/)?.[1];
      const f = metin.match(/(\d+)\s+failed/)?.[1];
      if (r.kod !== 0) return { durum: KALDI, kanit: `${f ?? "?"} test KALDI — ${ilkHataSatiri(r)}`, detay: metin };
      return { durum: GECTI, kanit: `pytest: ${p ?? "?"} geçti` };
    },
  },
  {
    id: "birim-cs",
    ad: "C# birim testleri",
    grup: "birim",
    gerektirir: ["derle-cs"],
    async kos() {
      const sonuclar = [];
      // 1) Gerçek bir test projesi varsa `dotnet test`.
      const testProjeleri = csTestProjeleriBul();
      for (const proj of testProjeleri) {
        const r = await kos("dotnet", ["test", proj, "--nologo", "-v", "quiet"]);
        sonuclar.push({ ad: path.relative(REPO, proj), kod: r.kod, kanit: ozetCsTest(r) });
      }
      // 2) Program.cs'te tanımlı test modları (bu repo test projesi yerine
      //    `dotnet run -- <mod>` kullanıyor; sebebi docs/06'da anlatılıyor).
      const prog = varMi("servers/csharp/Program.cs") ? oku("servers/csharp/Program.cs") : "";
      const adaylar = ["birim-testi", "testler", "sema-testi"].filter((m) => prog.includes(`"${m}"`));
      for (const mod of adaylar) {
        const r = await kos("dotnet", [
          "run",
          "--project",
          "servers/csharp/XurrentMcp.csproj",
          "--no-build",
          "--",
          mod,
        ]);
        sonuclar.push({ ad: `dotnet run -- ${mod}`, kod: r.kod, kanit: r.kod === 0 ? "geçti" : ilkHataSatiri(r, 90) });
      }
      if (!sonuclar.length)
        return { durum: ATLANDI, kanit: "ne test projesi ne de Program.cs'te test modu bulundu" };
      const kaldi = sonuclar.filter((s) => s.kod !== 0);
      return {
        durum: kaldi.length ? KALDI : GECTI,
        kanit: sonuclar.map((s) => `${s.ad}: ${s.kanit}`).join(" | "),
      };
    },
  },

  // ── Sözleşme ──────────────────────────────────────────────────────────────
  {
    id: "sozlesme",
    ad: "Sözleşme doğrulaması (3 dil)",
    grup: "sozlesme",
    async kos() {
      const { r, rapor } = await kosJson("node", ["scripts/verify-contract.mjs", "--all", "--json", "--no-color"]);
      if (!rapor) return { durum: KALDI, kanit: `JSON rapor okunamadı — ${ilkHataSatiri(r)}`, detay: r.err };
      const sunucular = Object.entries(rapor.servers ?? {});
      const atlanan = sunucular.filter(([, v]) => v.skipped).map(([k]) => k);
      const bozuk = sunucular.filter(([, v]) => !v.skipped && !v.ok).map(([k]) => k);
      const kanit =
        `${sunucular.length - atlanan.length}/${sunucular.length} sunucu doğrulandı · ` +
        `${rapor.expectedToolCount} tool bekleniyor` +
        (atlanan.length ? ` · atlanan: ${atlanan.join(",")}` : "") +
        (bozuk.length ? ` · İHLAL: ${bozuk.join(",")}` : "");
      if (rapor.ok === false || bozuk.length) return { durum: KALDI, kanit, detay: r.err };
      return { durum: GECTI, kanit };
    },
  },

  // ── Protokol uyumu ────────────────────────────────────────────────────────
  {
    id: "mcp-uyum",
    ad: "MCP spec uyumu (ham JSON-RPC)",
    grup: "protokol",
    yavas: true,
    async kos() {
      const { r, rapor } = await kosJson("node", [
        "scripts/mcp-uyum.mjs",
        "--hepsi",
        "--protokol",
        "ikisi",
        "--json",
        "--no-color",
      ]);
      if (!rapor) return { durum: KALDI, kanit: `JSON rapor okunamadı — ${ilkHataSatiri(r)}`, detay: r.err };

      // Tüm MUST-KALDI maddelerini topla.
      const mustKalanlar = [];
      for (const k of rapor.kosular ?? [])
        for (const m of k.maddeler ?? [])
          if (m.durum === "KALDI" && m.seviye === "MUST")
            mustKalanlar.push({ sunucu: k.sunucu, protokol: k.protokol, madde: m.id, aciklama: m.madde });

      const toplamGecti = (rapor.kosular ?? []).reduce((a, k) => a + (k.ozet?.gecti ?? 0), 0);
      const ozetBasi = `${(rapor.kosular ?? []).length} koşu · ${toplamGecti} madde geçti`;

      if (!mustKalanlar.length) return { durum: GECTI, kanit: `${ozetBasi} · MUST ihlali yok` };

      if (!BILINEN) {
        const liste = [...new Set(mustKalanlar.map((m) => m.madde))].join(", ");
        return {
          durum: KALDI,
          kanit: `${ozetBasi} · ${mustKalanlar.length} MUST ihlali (${liste}) — bilerek görmezden gelmek için --bilinen-ihlaller`,
          ihlaller: mustKalanlar,
        };
      }

      // --bilinen-ihlaller: listedekiler ATLANDI'ya döner, listede OLMAYAN kalır.
      const kayit = bilinenIhlalleriYukle();
      const bilinen = (kayit.maddeler ?? []).filter((m) => (m.arac ?? "mcp-uyum") === "mcp-uyum");
      const eslesir = (ihlal, kural) =>
        kural.madde === ihlal.madde &&
        (kural.sunucu === "*" || kural.sunucu === ihlal.sunucu) &&
        (kural.protokol === "*" || kural.protokol === ihlal.protokol);

      const beklenmedik = mustKalanlar.filter((i) => !bilinen.some((k) => eslesir(i, k)));
      const kullanilan = bilinen.filter((k) => mustKalanlar.some((i) => eslesir(i, k)));
      // Listede olup ARTIK GÖRÜLMEYEN madde = düzelmiş demektir; listeyi küçültme çağrısı.
      const cozulmus = bilinen.filter((k) => !mustKalanlar.some((i) => eslesir(i, k)));

      const kuyruk =
        `${kullanilan.length} bilinen ihlal maskelendi` +
        (cozulmus.length
          ? ` · ★ ${cozulmus.length} kayıt ARTIK GÖRÜLMÜYOR (listeden çıkarın: ${cozulmus
              .map((k) => `${k.sunucu}/${k.protokol}/${k.madde}`)
              .join(", ")})`
          : "");

      if (beklenmedik.length) {
        const liste = beklenmedik.map((m) => `${m.sunucu}/${m.protokol}/${m.madde}`).join(", ");
        return {
          durum: KALDI,
          kanit: `${ozetBasi} · LİSTEDE OLMAYAN ${beklenmedik.length} MUST ihlali: ${liste} · ${kuyruk}`,
          ihlaller: beklenmedik,
        };
      }
      return {
        durum: ATLANDI,
        kanit: `${ozetBasi} · tüm MUST ihlalleri bilinen listede · ${kuyruk}`,
        ihlaller: mustKalanlar,
        cozulmus,
      };
    },
  },

  // ── Veri şemaları ─────────────────────────────────────────────────────────
  {
    id: "adimlar",
    ad: "Sihirbaz adım şeması",
    grup: "sema",
    async kos() {
      const { r, rapor } = await kosJson("node", ["scripts/validate-steps.mjs", "--json"]);
      if (r.kod !== 0) return { durum: KALDI, kanit: ilkHataSatiri(r), detay: r.out + r.err };
      const n = rapor?.stepCount ?? rapor?.steps?.length ?? rapor?.adimSayisi ?? null;
      return { durum: GECTI, kanit: `docs/wizard/steps.json şemaya uygun${n ? ` · ${n} adım` : ""}` };
    },
  },
  {
    id: "adimlar-atolye",
    ad: "Atölye adım şeması",
    grup: "sema",
    async kos() {
      // Uzun süre yalnızca wizard şeması CI'daydı; atölye şeması runtime'da
      // okunuyor ama hiç DOĞRULANMIYORDU — "editörde kırmızı çizgi yoksa CI
      // çizsin" kuralının atladığı köşe. (Semantik katman wizard'a özgüdür;
      // burada değerli olan YAPISAL katmandır.)
      const r = await kos("node", [
        "scripts/validate-steps.mjs",
        "--steps", "docs/atolye/adimlar.json",
        "--schema", "docs/atolye/adimlar.schema.json",
      ]);
      if (r.kod !== 0) return { durum: KALDI, kanit: ilkHataSatiri(r), detay: r.out + r.err };
      return { durum: GECTI, kanit: "docs/atolye/adimlar.json şemaya uygun" };
    },
  },
  {
    id: "prompt-defteri",
    ad: "Prompt defteri güncelliği",
    grup: "sema",
    async kos() {
      const r = await kos("node", ["scripts/gen-prompt-defteri.mjs", "--kontrol"]);
      if (r.kod !== 0)
        return {
          durum: KALDI,
          kanit: `docs/11-prompt-defteri.md kaynağıyla ayrışmış — düzeltme: node scripts/gen-prompt-defteri.mjs`,
          detay: r.out + r.err,
        };
      return { durum: GECTI, kanit: "docs/11 ↔ docs/atolye/adimlar.json güncel" };
    },
  },
  {
    id: "pluginler",
    ad: "Plugin manifest'leri",
    grup: "sema",
    async kos() {
      const { r, rapor } = await kosJson("node", ["scripts/validate-plugins.mjs", "--json"]);
      if (r.kod !== 0) {
        const ilk = rapor?.sorunlar?.[0];
        return {
          durum: KALDI,
          kanit: ilk ? `[${ilk.plugin}] ${ilk.mesaj}` : ilkHataSatiri(r),
          detay: r.out + r.err,
        };
      }
      return { durum: GECTI, kanit: `${rapor?.pluginSayisi ?? "?"} manifest şemaya ve anlamsal kurallara uygun` };
    },
  },
  {
    id: "konektor",
    ad: "Copilot Studio konektör güncelliği",
    grup: "sema",
    async kos() {
      const r = await kos("node", ["scripts/gen-connector.mjs", "--kontrol"]);
      if (r.kod !== 0)
        return {
          durum: KALDI,
          kanit: "plugins/copilot-studio/connector.yaml üreticisiyle ayrışmış — düzeltme: node scripts/gen-connector.mjs --host ORNEK-TUNNEL.devtunnels.ms",
          detay: r.out + r.err,
        };
      return { durum: GECTI, kanit: "connector.yaml ↔ gen-connector.mjs senkron" };
    },
  },

  // ── Uçtan uca ─────────────────────────────────────────────────────────────
  ...["ts", "py", "cs"].map((dil) => ({
    id: `sihirbaz-${dil}`,
    ad: `Sihirbaz uçtan uca (${dil})`,
    grup: "uctan-uca",
    yavas: dil !== "ts",
    gerektirir: { ts: ["derle-ts"], py: ["derle-py"], cs: ["derle-cs"] }[dil],
    async kos() {
      const { r, rapor } = await kosJson("node", [
        "clients/wizard/wizard.mjs",
        "--server",
        dil,
        "--auto",
        "--json",
        "--no-color",
      ]);
      if (!rapor) return { durum: KALDI, kanit: `JSON rapor okunamadı — ${ilkHataSatiri(r)}`, detay: r.err };
      const t = rapor.totals ?? {};
      const kanit =
        `${t.passed ?? "?"} geçti, ${t.failed ?? "?"} başarısız, ${t.skipped ?? "?"} atlandı` +
        (rapor.protocol?.negotiated ? ` · protokol ${rapor.protocol.negotiated}` : "");
      if (rapor.ok === false || (t.failed ?? 0) > 0) return { durum: KALDI, kanit, detay: r.err };
      return { durum: GECTI, kanit };
    },
  })),
  {
    id: "senaryolar",
    ad: "Sahte Xurrent live-yol senaryoları",
    grup: "uctan-uca",
    yavas: true,
    gerektirir: ["derle-ts", "derle-py", "derle-cs"],
    async kos() {
      const r = await kos("node", ["tools/fake-xurrent/senaryolar.mjs"]);
      const metin = r.out + r.err;
      const g = metin.match(/(\d+)\s+geçti/)?.[1];
      const b = metin.match(/(\d+)\s+başarısız/)?.[1];
      const kanit = `${g ?? "?"} geçti, ${b ?? "?"} başarısız (live kod yolu, HTTP + GraphQL wire)`;
      if (r.kod !== 0) return { durum: KALDI, kanit, detay: metin };
      return { durum: GECTI, kanit };
    },
  },
  {
    id: "atolye",
    ad: "Atölye akışı",
    grup: "uctan-uca",
    async kos() {
      const { r, rapor } = await kosJson("node", ["clients/atolye/atolye.mjs", "--auto", "--json", "--no-color"]);
      if (!rapor) return { durum: KALDI, kanit: `JSON rapor okunamadı — ${ilkHataSatiri(r)}`, detay: r.err };
      const t = rapor.toplam ?? {};
      const kanit = `${t.adim ?? "?"} adım · ${t.gecti ?? "?"} geçti, ${t.basarisiz ?? "?"} başarısız, ${t.atlandi ?? "?"} atlandı`;
      if (rapor.ok === false || (t.basarisiz ?? 0) > 0) return { durum: KALDI, kanit, detay: r.err };
      return { durum: GECTI, kanit };
    },
  },

  // ── HTTP kabuğu ───────────────────────────────────────────────────────────
  {
    id: "kabuk-http",
    ad: "HTTP yüzeyi: çift çağ + API anahtarı kapısı",
    grup: "uctan-uca",
    yavas: true,
    gerektirir: ["derle-ts", "derle-py", "derle-cs"],
    async kos() {
      // Üç dilde AYNI yol/oturum matrisi (WP6 sözleşmesi):
      //   /mcp/v1 → 2025-11-25, OTURUMLU (initialize yanıtı Mcp-Session-Id taşır)
      //   /mcp/v2 → 2026-07-28, STATELESS (_meta zorunlu, resultType döner)
      //   MCP_API_KEY doluysa X-MCP-Api-Key başlıksız istek 401 alır.
      // Copilot Studio'nun bağlanma ön koşulu tam olarak bu üçlüdür (docs/17);
      // tenant gerektirmeyen kısmı CI'da budur.
      const ANAHTAR = "kabuk-smoke-anahtari";
      const DILLER_HTTP = [
        ["ts", (port) => ["node", ["servers/typescript/dist/mcp/http.js"], { MCP_HTTP_PORT: String(port) }]],
        ["py", (port) => ["uv", ["--directory", "servers/python", "run", "xurrent-mcp", "--http", "--port", String(port)], {}]],
        ["cs", (port) => ["dotnet", ["run", "--project", "servers/csharp/XurrentMcp.csproj", "--no-build", "--", "http"], { MCP_HTTP_PORT: String(port) }]],
      ];
      const kanitlar = [];
      for (const [dil, komut] of DILLER_HTTP) {
        const port = 8300 + Math.floor(Math.random() * 500);
        const [cmd, argv, ekEnv] = komut(port);
        const p = (await import("node:child_process")).spawn(cmd, argv, {
          cwd: REPO,
          env: { ...process.env, XURRENT_MODE: "mock", MCP_PROTOCOL: "both", MCP_API_KEY: ANAHTAR, ...ekEnv },
          stdio: ["ignore", "ignore", "pipe"],
        });
        try {
          // Port dinlenene kadar bekle (dotnet soğuk başlangıcı yavaş olabilir).
          const uc = `http://127.0.0.1:${port}`;
          let hazir = false;
          for (let i = 0; i < 120 && !hazir; i++) {
            await new Promise((z) => setTimeout(z, 500));
            try { await fetch(uc + "/mcp/v2", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); hazir = true; }
            catch { /* henüz değil */ }
          }
          if (!hazir) return { durum: KALDI, kanit: `${dil}: HTTP sunucusu ${port} portunda açılmadı` };

          // 0) /healthz — ANAHTARSIZ çalışmalı (konteyner sağlık probu; docs/17).
          const r0 = await fetch(uc + "/healthz");
          const s0 = await r0.json().catch(() => null);
          if (r0.status !== 200 || s0?.status !== "ok")
            return { durum: KALDI, kanit: `${dil}: /healthz → HTTP ${r0.status}, status=${s0?.status ?? "?"}` };

          // 0b) v2 HTTP üzerinden server/discover — paralel altyapı ölçümü eski
          // kodda Python'un HTTP'de v2 KONUŞMADIĞINI bulmuştu; bu kontrol o
          // gerilemeyi kalıcı olarak yakalar.
          const rd = await fetch(uc + "/mcp/v2", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
              "x-mcp-api-key": ANAHTAR, "mcp-method": "server/discover", "mcp-name": "xurrent-mcp",
              "mcp-protocol-version": "2026-07-28" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "server/discover", params: { _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "kabuk-smoke", version: "1.0.0" } } } }),
          });
          const dMetin = await rd.text();
          const dJson = (() => { try {
            const satir = dMetin.split("\n").find((l) => l.startsWith("data:"));
            return JSON.parse(satir ? satir.slice(5) : dMetin);
          } catch { return null; } })();
          const surumler = JSON.stringify(dJson?.result ?? {});
          if (!rd.ok || !surumler.includes("2026-07-28"))
            return { durum: KALDI, kanit: `${dil}: HTTP server/discover → ${rd.status}, 2026-07-28 görünmüyor` };

          // 1) v1 oturumlu el sıkışma
          const r1 = await fetch(uc + "/mcp/v1", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "x-mcp-api-key": ANAHTAR },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
              protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "kabuk-smoke", version: "1.0.0" } } }),
          });
          const oturum = r1.headers.get("mcp-session-id");
          if (!r1.ok || !oturum) return { durum: KALDI, kanit: `${dil}: /mcp/v1 initialize → HTTP ${r1.status}, Mcp-Session-Id ${oturum ? "var" : "YOK"}` };

          // 2) v2 stateless tools/list
          // MCP-Protocol-Version başlığı: _meta zaten sürümü taşır ama C# SDK'sı
          // HTTP'de başlığı da bekliyor (ölçülmüş SDK davranışı); TS/Py tolere
          // ediyor. Gerçek istemciler de geriye-uyum için başlığı gönderir.
          const r2 = await fetch(uc + "/mcp/v2", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
              "x-mcp-api-key": ANAHTAR, "mcp-method": "tools/list", "mcp-name": "xurrent-mcp",
              "mcp-protocol-version": "2026-07-28" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "kabuk-smoke", version: "1.0.0" } } } }),
          });
          const govde2 = await r2.text();
          const json2 = (() => { try {
            const satir = govde2.split("\n").find((l) => l.startsWith("data:"));
            return JSON.parse(satir ? satir.slice(5) : govde2);
          } catch { return null; } })();
          const toolSayisi = json2?.result?.tools?.length ?? 0;
          if (!r2.ok || toolSayisi !== 10)
            return { durum: KALDI, kanit: `${dil}: /mcp/v2 tools/list → HTTP ${r2.status}, tool=${toolSayisi} (beklenen 10)` };

          // 3) anahtarsız istek reddedilir
          const r3 = await fetch(uc + "/mcp/v2", { method: "POST",
            headers: { "content-type": "application/json" }, body: "{}" });
          if (r3.status !== 401)
            return { durum: KALDI, kanit: `${dil}: anahtarsız istek ${r3.status} aldı (beklenen 401)` };

          // 4) Host koruması: anahtar DOLUYKEN yabancı Host kabul edilmeli
          // (konteynerler arası çağrının 421 ile ölmesi bulgusunun kapanışı).
          const r4 = await fetch(uc + "/mcp/v2", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
              "x-mcp-api-key": ANAHTAR, "mcp-method": "tools/list", "mcp-name": "xurrent-mcp",
              "mcp-protocol-version": "2026-07-28", host: "konteyner-a.internal:8788" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: { _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "kabuk-smoke", version: "1.0.0" } } } }),
          });
          if (!r4.ok)
            return { durum: KALDI, kanit: `${dil}: yabancı Host + anahtar → HTTP ${r4.status} (beklenen 200; DNS-rebinding kapısı anahtarlı modda gevşemeli)` };

          kanitlar.push(`${dil}: healthz ✓ discover ✓ v1 oturum ✓ v2 10 tool ✓ 401 ✓ Host ✓`);
        } finally {
          try { p.kill(); } catch { /* zaten ölmüş olabilir */ }
          await new Promise((z) => setTimeout(z, 300));
        }
      }
      return { durum: GECTI, kanit: kanitlar.join(" · ") };
    },
  },

  // ── Wire ──────────────────────────────────────────────────────────────────
  {
    id: "wire-denetimi",
    ad: "Gemini wire formatı denetimi",
    grup: "wire",
    gerektirir: ["derle-ts"],
    async kos() {
      // Sonda portu SABİTTİR (tools/fake-gemini/wire-denetimi.mjs içinde 5104).
      // Aynı repoda paralel çalışan başka bir koşu portu tutuyor olabilir; bir
      // süre bekleyip yeniden dene, sonra ATLANDI de. Meşgul port bir kusur
      // değildir — ölçüm yapılamamasıdır.
      const PORT = 5104;
      const sonKontrol = Date.now() + 20000;
      let bos = await portBosMu(PORT);
      while (!bos && Date.now() < sonKontrol) {
        await new Promise((z) => setTimeout(z, 1000));
        bos = await portBosMu(PORT);
      }
      if (!bos) return { durum: ATLANDI, kanit: `port ${PORT} 20 sn boyunca meşgul — sonda başlatılamıyor` };
      return await wireDenetimiKos(PORT);
    },
  },
];

// ── Yardımcılar (adımlara özel) ─────────────────────────────────────────────

function testDosyasiAra(dizin, derinlik = 4) {
  if (derinlik < 0) return false;
  let girdiler;
  try {
    girdiler = readdirSync(dizin);
  } catch {
    return false;
  }
  for (const g of girdiler) {
    if (g === "__pycache__" || g === ".venv" || g === "node_modules") continue;
    const tam = path.join(dizin, g);
    let st;
    try {
      st = statSync(tam);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (testDosyasiAra(tam, derinlik - 1)) return true;
    } else if (/^test_.*\.py$/.test(g) || /_test\.py$/.test(g)) return true;
  }
  return false;
}

function csTestProjeleriBul(dizin = path.join(REPO, "servers/csharp"), derinlik = 3) {
  const bulunan = [];
  if (derinlik < 0) return bulunan;
  let girdiler;
  try {
    girdiler = readdirSync(dizin);
  } catch {
    return bulunan;
  }
  for (const g of girdiler) {
    if (g === "bin" || g === "obj") continue;
    const tam = path.join(dizin, g);
    let st;
    try {
      st = statSync(tam);
    } catch {
      continue;
    }
    if (st.isDirectory()) bulunan.push(...csTestProjeleriBul(tam, derinlik - 1));
    else if (/\.(Tests?|UnitTests)\.csproj$/i.test(g)) bulunan.push(tam);
  }
  return bulunan;
}

function ozetCsTest(r) {
  const metin = r.out + r.err;
  const m = metin.match(/Passed!?\s*-?\s*Failed:\s*(\d+),\s*Passed:\s*(\d+)/i);
  if (m) return `${m[2]} geçti, ${m[1]} kaldı`;
  return r.kod === 0 ? "geçti" : ilkHataSatiri(r, 90);
}

function portBosMu(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

/**
 * Wire denetimi tek başına koşamaz: sonda PASİF bir HTTP sunucusudur, istemcinin
 * kendisine konuşmasını bekler. Bu yüzden burada ikisini birlikte kaldırıyoruz —
 * sonda dinlemeye başlayınca TypeScript chatbot'u ona yönlendiriyoruz.
 * Sonda ikinci turdan sonra kendini sonlandırır ve iddia dökümünü stdout'a basar.
 */
async function wireDenetimiKos(port) {
  const sonda = spawn("node", ["tools/fake-gemini/wire-denetimi.mjs"], {
    cwd: REPO,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let sOut = "";
  let sErr = "";
  sonda.stdout.on("data", (c) => (sOut += c));
  sonda.stderr.on("data", (c) => (sErr += c));

  const bittiSozu = new Promise((resolve) => sonda.on("close", (kod) => resolve(kod)));
  // "probe dinliyor 5104" stderr'e düşene kadar bekle.
  const hazir = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 15000);
    const bak = setInterval(() => {
      if (/dinliyor/.test(sErr)) {
        clearInterval(bak);
        clearTimeout(t);
        resolve(true);
      }
    }, 100);
    sonda.on("close", () => {
      clearInterval(bak);
      clearTimeout(t);
      resolve(false);
    });
  });
  if (!hazir) {
    sonda.kill("SIGKILL");
    return { durum: ATLANDI, kanit: `sonda ${port} portunda dinlemeye başlamadı` };
  }

  const istemci = await kos("node", ["dist/agent/cli.js"], {
    cwd: path.join(REPO, "servers/typescript"),
    env: {
      GEMINI_BASE_URL: `http://127.0.0.1:${port}`,
      GEMINI_API_KEY: "sahte",
      XURRENT_MODE: "mock",
      CALENDAR_PROVIDER: "mock",
    },
    stdin: "acik islerim\n\n",
    timeout: 120000,
  });

  const kod = await Promise.race([
    bittiSozu,
    new Promise((r) => setTimeout(() => r(null), 10000)),
  ]);
  if (kod === null) {
    sonda.kill("SIGKILL");
    return {
      durum: KALDI,
      kanit: `sonda ikinci tura ulaşmadı — istemci konuşmayı tamamlamadı (${ilkHataSatiri(istemci, 100)})`,
      detay: sOut + sErr + istemci.err,
    };
  }

  const satirlar = sOut.split("\n").filter((s) => /^(GECTI|KALDI)\s/.test(s.trim()));
  const kalanlar = satirlar.filter((s) => s.trim().startsWith("KALDI"));
  const kanit = `${satirlar.length} iddia · ${satirlar.length - kalanlar.length} geçti${
    kalanlar.length ? ` · ${kalanlar.length} KALDI` : ""
  }`;
  if (kod !== 0 || kalanlar.length)
    return { durum: KALDI, kanit: `${kanit} — ${kalanlar.slice(0, 3).join(" | ")}`, detay: sOut };
  return { durum: GECTI, kanit };
}

// ── Adım seçimi ─────────────────────────────────────────────────────────────
if (LISTE) {
  write("");
  write(C.b + "  test-all adımları" + C.x);
  write("");
  for (const a of ADIMLAR)
    write(`  ${a.id.padEnd(18)} ${C.d}${a.grup.padEnd(11)}${a.yavas ? "yavaş" : "     "}${C.x}  ${a.ad}`);
  write("");
  process.exit(0);
}

function secildiMi(a) {
  if (SADECE.length) return SADECE.some((s) => a.id === s || a.id.startsWith(s) || a.grup === s);
  if (HIZLI && a.yavas) return false;
  return true;
}

const secilenler = ADIMLAR.filter(secildiMi);
if (SADECE.length && !secilenler.length) {
  process.stderr.write(`test-all: --sadece "${SADECE.join(",")}" hiçbir adımla eşleşmedi. --liste ile bakın.\n`);
  process.exit(2);
}

// ── Koşu ────────────────────────────────────────────────────────────────────
const rapor = {
  ok: true,
  baslangic: new Date().toISOString(),
  bayraklar: { hizli: HIZLI, sadece: SADECE, bilinenIhlaller: BILINEN },
  ortam: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  },
  adimlar: [],
  ozet: { toplam: 0, gecti: 0, kaldi: 0, atlandi: 0 },
};

write("");
write(C.b + "  xurrent-mcp — bütün doğrulama katmanları" + C.x);
write(
  C.d +
    `  node ${process.version} · ${rapor.ortam.platform} · TZ ${rapor.ortam.tz}` +
    (HIZLI ? " · HIZLI mod" : "") +
    (BILINEN ? " · bilinen ihlaller maskeli" : "") +
    C.x,
);
write("");

const durumlar = new Map();
const t0Genel = performance.now();

for (const adim of secilenler) {
  // Bağımlılık: gerekli adım GEÇMEDİYSE bu adım ATLANDI (kırmızı gürültü üretme).
  const eksik = (adim.gerektirir ?? []).filter((d) => durumlar.has(d) && durumlar.get(d) !== GECTI);
  // --sadece ile bir ön koşul HİÇ koşmamış olabilir. Bu bir hata değil ama
  // sonuç yorumlanırken bilinmeli: bayat bir derleme çıktısı ölçülüyor olabilir.
  const kosulmamis = (adim.gerektirir ?? []).filter((d) => !durumlar.has(d));

  let sonuc;
  let sure = 0;
  if (eksik.length) {
    sonuc = { durum: ATLANDI, kanit: `ön koşul adımı geçmedi: ${eksik.join(", ")}` };
  } else {
    const t0 = performance.now();
    try {
      sonuc = await adim.kos();
    } catch (e) {
      sonuc = { durum: KALDI, kanit: `koşucu istisnası: ${e?.message ?? e}`, detay: String(e?.stack ?? "") };
    }
    sure = performance.now() - t0;
    if (kosulmamis.length && sonuc.durum !== GECTI)
      sonuc.kanit += ` · not: ön koşul bu koşuda çalışmadı (${kosulmamis.join(", ")})`;
  }

  durumlar.set(adim.id, sonuc.durum);
  rapor.adimlar.push({
    id: adim.id,
    ad: adim.ad,
    grup: adim.grup,
    durum: sonuc.durum,
    sureMs: Math.round(sure),
    kanit: sonuc.kanit,
    ...(sonuc.ihlaller ? { ihlaller: sonuc.ihlaller } : {}),
    ...(sonuc.cozulmus ? { cozulmusIhlaller: sonuc.cozulmus } : {}),
  });
  rapor.ozet.toplam++;
  if (sonuc.durum === GECTI) rapor.ozet.gecti++;
  else if (sonuc.durum === KALDI) {
    rapor.ozet.kaldi++;
    rapor.ok = false;
  } else rapor.ozet.atlandi++;

  const isaret = sonuc.durum === GECTI ? C.g + "✔" : sonuc.durum === KALDI ? C.r + "✘" : C.y + "○";
  const renk = sonuc.durum === GECTI ? C.g : sonuc.durum === KALDI ? C.r + C.b : C.y;
  write(
    `  ${isaret}${C.x} ${adim.id.padEnd(16)} ${C.d}${sn(sure).padStart(6)}${C.x}  ${renk}${sonuc.durum.padEnd(7)}${C.x}  ${C.d}${sonuc.kanit}${C.x}`,
  );
  if (sonuc.durum === KALDI && sonuc.detay) {
    for (const l of String(sonuc.detay).split("\n").filter(Boolean).slice(-6))
      write(C.d + "      │ " + l.slice(0, 150) + C.x);
  }
}

rapor.sureMs = Math.round(performance.now() - t0Genel);

// ── Özet tablo ──────────────────────────────────────────────────────────────
write("");
write(C.d + "─".repeat(100) + C.x);
write(C.b + "  ÖZET" + C.x);
write("");
const w = { id: 18, grup: 12, sure: 8, durum: 9 };
write(
  C.d +
    "  " +
    "adım".padEnd(w.id) +
    "grup".padEnd(w.grup) +
    "süre".padStart(w.sure) +
    "  " +
    "durum".padEnd(w.durum) +
    "kanıt" +
    C.x,
);
write(C.d + "  " + "─".repeat(96) + C.x);
for (const a of rapor.adimlar) {
  const renk = a.durum === GECTI ? C.g : a.durum === KALDI ? C.r + C.b : C.y;
  write(
    "  " +
      a.id.padEnd(w.id) +
      C.d +
      a.grup.padEnd(w.grup) +
      C.x +
      sn(a.sureMs).padStart(w.sure) +
      "  " +
      renk +
      a.durum.padEnd(w.durum) +
      C.x +
      C.d +
      (a.kanit.length > 62 ? a.kanit.slice(0, 61) + "…" : a.kanit) +
      C.x,
  );
}
write("");
write(
  `  ${C.g}${rapor.ozet.gecti} geçti${C.x} · ` +
    `${rapor.ozet.kaldi ? C.r + C.b : C.d}${rapor.ozet.kaldi} kaldı${C.x} · ` +
    `${rapor.ozet.atlandi ? C.y : C.d}${rapor.ozet.atlandi} atlandı${C.x}` +
    C.d +
    `   (${sn(rapor.sureMs)})` +
    C.x,
);
write("");
if (rapor.ok) {
  write(C.g + C.b + "  ✔ KALAN ADIM YOK." + C.x);
  if (rapor.ozet.atlandi)
    write(C.d + "  ○ ATLANDI = ön koşul yoktu (araç kurulu değil / test dosyası yok / bilinen ihlal). Başarısızlık DEĞİL." + C.x);
} else {
  write(C.r + C.b + `  ✘ ${rapor.ozet.kaldi} ADIM KALDI.` + C.x);
  for (const a of rapor.adimlar.filter((a) => a.durum === KALDI))
    write(C.r + `    • ${a.id}: ${a.kanit}` + C.x);
}
write("");

if (JSON_MODE) process.stdout.write(JSON.stringify(rapor, null, 2) + "\n");
// Çıkış kodunu YALNIZCA KALDI etkiler. ATLANDI asla 1 döndürmez.
process.exit(rapor.ozet.kaldi ? 1 : 0);
