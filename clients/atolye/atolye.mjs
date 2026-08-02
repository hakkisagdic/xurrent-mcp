#!/usr/bin/env node
// -----------------------------------------------------------------------------
// xurrent-mcp — atölye koşucusu
//
// SİHİRBAZ ile ATÖLYE karıştırılmamalıdır:
//   clients/wizard/wizard.mjs  → uygulamanın NE YAPTIĞINI öğretir (bir MCP client'ı)
//   clients/atolye/atolye.mjs  → uygulamanın NASIL ÜRETİLDİĞİNİ öğretir (bu dosya)
//
// Ders içeriğinin hiçbir parçası burada gömülü DEĞİLDİR. Adımlar
// docs/atolye/adimlar.json dosyasından gelir ve docs/atolye/adimlar.schema.json
// sözleşmesine uyar. Bu script yalnızca "oku → anlat → kur → doğrula" döngüsünü
// yürütür.
//
// ★ EN ÖNEMLİ TASARIM KARARI — dosya İÇERİKLERİ veri dosyasında TUTULMAZ.
//   adimlar.json yalnızca repo köküne göreli YOL listeler; atölye o dosyaları
//   REPODAN okur. Sebep: içerik kopyalansaydı kod her değiştiğinde kılavuz
//   sessizce bayatlardı ve öğrenciye artık var olmayan bir kod öğretirdik.
//   Bu yüzden "üretilen dosya repoda yok" durumu bir UYARI değil, FAIL'dir.
//
// Kullanım:
//   node clients/atolye/atolye.mjs                 # anlat modu (varsayılan)
//   node clients/atolye/atolye.mjs --insa <dizin>  # gerçekten kur ve doğrula
//   node clients/atolye/atolye.mjs --auto --json   # CI
//   node clients/atolye/atolye.mjs --help
//
// SONUÇ MODELİ ÜÇ DURUMLUDUR (sihirbazla AYNI): PASS | FAIL | SKIP.
//   PASS — kontrol çalıştı ve tuttu
//   FAIL — kontrol çalıştı ve TUTMADI (gerçek bir uyumsuzluk)
//   SKIP — kontrol ÇALIŞTIRILAMADI (ön koşul yok: --insa verilmedi, komut
//          PATH'te yok, ANTHROPIC_API_KEY tanımsız, vb.)
// SKIP bir başarısızlık DEĞİLDİR; çıkış kodunu YALNIZCA FAIL etkiler.
// -----------------------------------------------------------------------------

import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

// ── Yol çözümleme ────────────────────────────────────────────────────────────
// clients/atolye/atolye.mjs → repo kökü iki seviye yukarıda.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

const VARSAYILAN_VERI = path.join(ROOT, "docs", "atolye", "adimlar.json");
const VARSAYILAN_SEMA = path.join(ROOT, "docs", "atolye", "adimlar.schema.json");

// Doğrulama komutları derleme çalıştırabilir; dotnet/uv soğuk başlangıcı uzundur.
const KOMUT_ZAMAN_ASIMI_MS = 10 * 60 * 1000;

// Glob gezinirken ASLA girilmeyecek dizinler. Build çıktısı ve bağımlılık ağacı
// "üretilen dosya" değildir; öğrenciye kopyalanması hem yanıltıcı hem devasadır.
const GEZINME_DISI = new Set([
  "node_modules", ".git", "dist", "bin", "obj", "__pycache__",
  ".venv", "venv", ".mypy_cache", ".pytest_cache", "target", ".next", "coverage",
]);

// ── Argüman ayrıştırma ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    veri: null,          // --veri <yol>       alternatif adım dosyası
    sema: null,          // --sema <yol>       alternatif şema
    insa: null,          // --insa <dizin>     GERÇEKTEN kur
    auto: false,         // --auto            beklemeden geç (CI)
    json: false,         // --json            makine-okunur özet
    live: false,         // --live            promptu gerçekten Claude'a gönder
    adim: null,          // --adim <id[,id]>  tek adım (kısmi eşleşme)
    from: null,          // --from <id>       o adımdan itibaren
    liste: false,        // --liste           adımları listele ve çık
    dogrulaSadece: false,// --dogrula         veri dosyasını doğrula ve çık
    uzerineYaz: false,   // --uzerine-yaz     dolu hedef dizini onaysız kabul et
    color: true,
    help: false,
  };
  const ekleAdim = (raw) => {
    const items = String(raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (items.length) a.adim = [...(a.adim ?? []), ...items];
  };
  // Değer bekleyen bir parametrenin değeri EKSİKSE sessizce "undefined" ile
  // devam etmek, --insa undefined gibi bir dizin yaratmak demektir. Erken patla.
  const deger = (argv, i, ad) => {
    const v = argv[i];
    if (v === undefined || String(v).startsWith("--")) {
      process.stderr.write(`HATA: ${ad} bir değer bekliyor.\n`);
      process.exit(2);
    }
    return String(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const t = String(argv[i]);
    if (t.startsWith("--") && t.includes("=")) {
      // --anahtar=deger biçimini tek yerde normalize et; aşağıdaki switch sade kalsın.
      const eq = t.indexOf("=");
      argv.splice(i, 1, t.slice(0, eq), t.slice(eq + 1));
    }
    switch (argv[i]) {
      case "--veri":
      case "--adimlar": a.veri = deger(argv, ++i, "--veri"); break;
      case "--sema": a.sema = deger(argv, ++i, "--sema"); break;
      case "--insa": a.insa = deger(argv, ++i, "--insa"); break;
      case "--auto": a.auto = true; break;
      case "--json": a.json = true; break;
      case "--live": a.live = true; break;
      case "--adim":
      case "--only":
      case "--step": ekleAdim(deger(argv, ++i, "--adim")); break;
      case "--from": a.from = deger(argv, ++i, "--from").trim() || null; break;
      case "--liste":
      case "--list-steps": a.liste = true; break;
      case "--dogrula": a.dogrulaSadece = true; break;
      case "--uzerine-yaz":
      case "--force": a.uzerineYaz = true; break;
      case "--no-color": a.color = false; break;
      case "--help":
      case "-h": a.help = true; break;
      default:
        if (String(argv[i]).startsWith("-")) {
          process.stderr.write(`Bilinmeyen parametre: ${argv[i]}\n`);
          process.stderr.write("Seçenekleri görmek için: node clients/atolye/atolye.mjs --help\n");
          process.exit(2);
        }
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const MOD = args.insa ? "insa" : "anlat";

// --json modunda STDOUT yalnızca makine-okunur özet içindir; tüm insan çıktısı
// stderr'e gider. (Aynı disiplin MCP stdio transport'unda da geçerlidir.)
const OUT = args.json ? process.stderr : process.stdout;

// ── Renk / biçim ─────────────────────────────────────────────────────────────
const USE_COLOR =
  args.color && !process.env.NO_COLOR && (args.json ? process.stderr.isTTY : process.stdout.isTTY);

const C = new Proxy(
  {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m",
    red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m",
    magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
  },
  { get: (t, k) => (USE_COLOR ? t[k] ?? "" : "") },
);

const paint = (code, s) => (USE_COLOR ? `${code}${s}${C.reset}` : String(s));

// Okunaklı sarma genişliği: 80–100 kolon arası.
function termWidth() {
  const raw = (args.json ? process.stderr.columns : process.stdout.columns) || 96;
  return Math.max(80, Math.min(100, raw));
}

// ANSI kaçış dizileri görünür genişliğe sayılmaz.
const gorunurUzunluk = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").length;

function wrapText(text, width) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    if (para.trim() === "") { out.push(""); continue; }
    const lead = para.match(/^\s*/)[0]; // girinti korunur (asılı girinti)
    let line = lead;
    for (const w of para.trim().split(/\s+/)) {
      const cand = line === lead ? lead + w : line + " " + w;
      if (gorunurUzunluk(cand) > width && line !== lead) { out.push(line); line = lead + w; }
      else line = cand;
    }
    out.push(line);
  }
  return out;
}

const write = (s = "") => OUT.write(s + "\n");

function para(text, { indent = "", color = "" } = {}) {
  for (const line of wrapText(text, termWidth() - indent.length)) {
    write(indent + (color ? paint(color, line) : line));
  }
}

const rule = (ch = "─") => write(paint(C.gray, ch.repeat(termWidth())));

// Repo içindeyse göreli, dışındaysa mutlak yol göster. "../../../private/tmp/..."
// biçimi kimseye yardım etmez.
function kisaYol(p) {
  const rel = path.relative(ROOT, p);
  return rel && !rel.startsWith("..") ? rel : p;
}

function fazBanner(baslik, ozet) {
  const w = termWidth();
  write("");
  write(paint(C.blue + C.bold, "━".repeat(w)));
  // toUpperCase() Türkçede yanlıştır: "veri" → "VERI". tr-TR yerel ayarı "VERİ" verir.
  write(paint(C.blue + C.bold, "  FAZ — " + String(baslik).toLocaleUpperCase("tr-TR")));
  if (ozet) para(ozet, { indent: "  ", color: C.blue });
  write(paint(C.blue + C.bold, "━".repeat(w)));
}

function adimBasligi(n, toplam, adim) {
  write("");
  rule("═");
  write(paint(C.bold + C.cyan, `  ADIM ${n}/${toplam} — ${adim.baslik}`));
  write(paint(C.gray, `  ${adim.id}`));
  rule("═");
}

// ── Tablo çizici (hücre içi sarma destekli) ─────────────────────────────────
function renderTable(headers, rows, maxWidth = termWidth()) {
  const cols = headers.length;
  const dogal = new Array(cols).fill(0);
  for (const r of [headers, ...rows]) {
    for (let i = 0; i < cols; i++) {
      for (const ln of String(r[i] ?? "").split("\n")) dogal[i] = Math.max(dogal[i], gorunurUzunluk(ln));
    }
  }
  const genislik = dogal.slice();
  const kullanilabilir = maxWidth - (cols * 3 + 1);
  let guard = 0;
  while (genislik.reduce((a, b) => a + b, 0) > kullanilabilir && guard++ < 5000) {
    let idx = 0;
    for (let i = 1; i < cols; i++) if (genislik[i] > genislik[idx]) idx = i;
    if (genislik[idx] <= 10) break;
    genislik[idx]--;
  }
  const cizgi = (l, m, r) => paint(C.gray, l + genislik.map((w) => "─".repeat(w + 2)).join(m) + r);
  write(cizgi("┌", "┬", "┐"));
  const emit = (cells, bold) => {
    const sarili = cells.map((c, i) => {
      const lines = [];
      for (const seg of String(c ?? "").split("\n")) lines.push(...wrapText(seg, genislik[i]));
      return lines.length ? lines : [""];
    });
    const h = Math.max(...sarili.map((x) => x.length));
    for (let k = 0; k < h; k++) {
      const parts = sarili.map((x, i) => {
        // Sarma boşluksuz uzun bir jetonu (örn. mutlak dosya yolu) bölemez;
        // bölmezsek tablo kenarlığı taşar. Kalanı sert kırpıyoruz.
        let txt = x[k] ?? "";
        if (gorunurUzunluk(txt) > genislik[i]) txt = txt.slice(0, Math.max(1, genislik[i] - 1)) + "…";
        return " " + (bold ? paint(C.bold, txt) : txt) + " ".repeat(Math.max(0, genislik[i] - gorunurUzunluk(txt))) + " ";
      });
      write(paint(C.gray, "│") + parts.join(paint(C.gray, "│")) + paint(C.gray, "│"));
    }
  };
  emit(headers, true);
  write(cizgi("├", "┼", "┤"));
  for (const r of rows) emit(r, false);
  write(cizgi("└", "┴", "┘"));
}

// ── Kullanıcı etkileşimi ─────────────────────────────────────────────────────
let rl = null;
const getRl = () =>
  (rl ??= readline.createInterface({ input: process.stdin, output: OUT, terminal: process.stdin.isTTY }));
function closeRl() { if (rl) { rl.close(); rl = null; } }
const ask = (q) => new Promise((res) => getRl().question(q, res));

async function enterBekle() {
  if (args.auto) return;
  if (!process.stdin.isTTY) return; // pipe içinde takılıp kalma
  await ask(paint(C.gray, "\n  ⏎ Devam etmek için Enter... "));
}

async function evetHayir(soru, varsayilanEvet = false) {
  if (!process.stdin.isTTY) return varsayilanEvet;
  const cevap = (await ask(soru + (varsayilanEvet ? " [E/h] " : " [e/H] "))).trim().toLowerCase();
  if (cevap === "") return varsayilanEvet;
  return ["e", "evet", "y", "yes", "1"].includes(cevap);
}

// ── .env yükleyici (bağımlılıksız; gerçek ortam değişkenlerini EZMEZ) ───────
function loadDotEnv(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[line.slice(0, eq).trim()] = v;
  }
  return env;
}

// ═════════════════════════════════════════════════════════════════════════════
// VERİ DOSYASI: yükleme + doğrulama
// ═════════════════════════════════════════════════════════════════════════════

/**
 * JSON.parse hatasını satır/sütuna çevirir — "position 4213" kimseye yardım etmez.
 * V8 sürüme göre iki biçim üretir: "at position N" ve "(line N column M)";
 * ikisi de ele alınır, hiçbiri yoksa konum gösterilmez (yine de çökmeyiz).
 */
function jsonHataKonumu(text, err) {
  const msg = String(err?.message ?? "");
  let satir, sutun;
  const lc = msg.match(/line (\d+) column (\d+)/);
  const pos = msg.match(/position (\d+)/);
  if (lc) {
    satir = Number(lc[1]);
    sutun = Number(lc[2]);
  } else if (pos) {
    const onceki = text.slice(0, Number(pos[1]));
    satir = onceki.split("\n").length;
    sutun = Number(pos[1]) - onceki.lastIndexOf("\n");
  } else return null;
  const icerik = text.split("\n")[satir - 1] ?? "";
  return { satir, sutun, icerik: icerik.length > 120 ? icerik.slice(0, 117) + "..." : icerik };
}

/**
 * Şema doğrulayıcısı repo içindedir (scripts/lib/mini-jsonschema.mjs) ve
 * bağımlılıksızdır. Dinamik import: dosya yoksa atölye ÇÖKMEZ, yapısal
 * doğrulamayı atlayıp anlamsal kontrollerle devam eder ve bunu SÖYLER.
 */
async function semaDogrulayici() {
  try {
    const mod = await import(path.join(ROOT, "scripts", "lib", "mini-jsonschema.mjs"));
    return mod.validate;
  } catch {
    return null;
  }
}

/**
 * Şemanın ifade EDEMEDİĞİ bütünlük kuralları. İhlaller ölümcül değildir
 * (uyarı olarak basılır) çünkü ders akışı yine de anlatılabilir — ama
 * sessizce yutulmaz.
 */
function anlamsalKontroller(veri) {
  const uyari = [];
  const fazIds = new Set((veri.fazlar ?? []).map((f) => f.id));
  const gorulen = new Set();
  const kullanilanFaz = new Set();

  for (const [i, a] of (veri.adimlar ?? []).entries()) {
    const nerede = `adimlar[${i}] (${a?.id ?? "?"})`;
    if (!a || typeof a !== "object") continue;

    if (gorulen.has(a.id)) uyari.push({ yol: nerede, mesaj: `adım id'si tekrar ediyor: ${a.id}` });
    gorulen.add(a.id);

    if (a.faz) {
      kullanilanFaz.add(a.faz);
      if (!fazIds.has(a.faz)) uyari.push({ yol: `${nerede}.faz`, mesaj: `fazlar[] içinde yok: "${a.faz}"` });
    }

    // Seçilen şık gerçekten seçeneklerden biri mi? Değilse ekranda hiçbir şık
    // "SEÇİLDİ" işaretlenmez ve öğrenci kararı göremez.
    if (a.karar && Array.isArray(a.karar.secenekler)) {
      const etiketler = a.karar.secenekler.map((s) => s?.etiket);
      if (!etiketler.includes(a.karar.secilen)) {
        uyari.push({
          yol: `${nerede}.karar.secilen`,
          mesaj: `"${a.karar.secilen}" seçenekler arasında yok (${etiketler.join(" | ")})`,
        });
      }
    }

    if (a.docs) {
      const rel = String(a.docs).split("#")[0];
      if (rel && !existsSync(path.join(ROOT, rel))) {
        uyari.push({ yol: `${nerede}.docs`, mesaj: `dosya diskte yok: ${rel}` });
      }
    }
  }

  for (const f of fazIds) {
    if (!kullanilanFaz.has(f)) uyari.push({ yol: "fazlar", mesaj: `hiçbir adım "${f}" fazına ait değil` });
  }
  return uyari;
}

/** @returns {{ok:boolean, veri:object|null, uyarilar:array, cikis:number}} */
async function veriYukle(veriYolu, semaYolu) {
  if (!existsSync(veriYolu)) {
    write("");
    write(paint(C.red + C.bold, "  ✘ Atölye veri dosyası bulunamadı."));
    write("");
    write(paint(C.red, `    Aranan yol: ${veriYolu}`));
    write("");
    para(
      "Bu dosya atölyenin ders içeriğidir; koşucu onsuz anlatacak bir şey bilmez. " +
        "Sözleşmesi docs/atolye/adimlar.schema.json dosyasındadır.",
      { indent: "    ", color: C.yellow },
    );
    write("");
    para("Başka bir dosyayla çalıştırmak için:", { indent: "    ", color: C.gray });
    write(paint(C.gray, "      node clients/atolye/atolye.mjs --veri <yol>"));
    write("");
    return { ok: false, veri: null, uyarilar: [], cikis: 2 };
  }

  const ham = readFileSync(veriYolu, "utf8");
  let veri;
  try {
    veri = JSON.parse(ham);
  } catch (err) {
    const konum = jsonHataKonumu(ham, err);
    write("");
    write(paint(C.red + C.bold, "  ✘ Veri dosyası geçerli JSON değil."));
    write("");
    write(paint(C.gray, `    Dosya : ${veriYolu}`));
    para(`Hata  : ${err.message}`, { indent: "    ", color: C.red });
    if (konum) {
      para(`Konum : satır ${konum.satir}, sütun ${konum.sutun}`, { indent: "    ", color: C.red });
      write(paint(C.gray, `      ${konum.satir} | ${konum.icerik}`));
      write(paint(C.red, `      ${" ".repeat(String(konum.satir).length)} | ${" ".repeat(Math.max(0, konum.sutun - 1))}^`));
    }
    write("");
    return { ok: false, veri: null, uyarilar: [], cikis: 2 };
  }

  // ── Yapısal doğrulama (JSON Schema) ─────────────────────────────────────
  const validate = await semaDogrulayici();
  let yapisal = [];
  if (!existsSync(semaYolu)) {
    write(paint(C.yellow, `  ⚠ Şema dosyası yok (${kisaYol(semaYolu)}) — yapısal doğrulama atlandı.`));
  } else if (!validate) {
    write(paint(C.yellow, "  ⚠ scripts/lib/mini-jsonschema.mjs okunamadı — yapısal doğrulama atlandı."));
  } else {
    const sema = JSON.parse(readFileSync(semaYolu, "utf8"));
    // ★ "$schema" bir META anahtardır, veri değildir: editöre hangi şemayla
    //   doğrulanacağını söyler (docs/wizard/steps.json da böyle yazılmıştır).
    //   Şemanın kökünde additionalProperties:false olduğu için doğrulamaya
    //   girseydi TEK BAŞINA tüm dosyayı reddettirirdi. Doğrulamadan önce
    //   ayıklıyoruz — gerçek hiçbir kontrol zayıflamaz.
    const { $schema, ...dogrulanacak } = veri;
    yapisal = validate(sema, dogrulanacak).errors;
  }

  if (yapisal.length) {
    write("");
    write(paint(C.red + C.bold, `  ✘ Veri dosyası şemaya UYMUYOR — ${yapisal.length} ihlal.`));
    write("");
    write(paint(C.gray, `    Dosya : ${kisaYol(veriYolu)}`));
    write(paint(C.gray, `    Şema  : ${kisaYol(semaYolu)}`));
    write("");
    for (const e of yapisal.slice(0, 30)) {
      write(paint(C.red, `    • ${e.path || "(kök)"}: ${e.message}`));
    }
    if (yapisal.length > 30) write(paint(C.gray, `    ... ve ${yapisal.length - 30} ihlal daha`));
    write("");
    para(
      "Sözleşme ihlali ölümcüldür: tanınmayan bir alanı sessizce yok saymak, " +
        "derste hiç çalışmayan bir bölüm demektir.",
      { indent: "    ", color: C.yellow },
    );
    write("");
    return { ok: false, veri: null, uyarilar: [], cikis: 2 };
  }

  return { ok: true, veri, uyarilar: anlamsalKontroller(veri), cikis: 0 };
}

// ═════════════════════════════════════════════════════════════════════════════
// GLOB + KOPYALAMA
// ═════════════════════════════════════════════════════════════════════════════

const globSihirli = (p) => /[*?[\]]/.test(p);

/** Glob desenini regex'e çevirir. `**` dizin sınırını aşar, `*` aşmaz. */
function globToRegex(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { i++; re += "(?:[^/]+/)*"; } else re += ".*";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}

/**
 * Repo köküne göreli deseni gerçek yollara açar.
 * Sihirli karakter yoksa doğrudan varlık kontrolü yapılır (dizin de olabilir).
 */
function globAc(desen) {
  const norm = String(desen).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!norm) return [];

  // ★ GÜVENLİK: veri dosyası repo dışına çıkamaz. "../../.ssh/id_rsa" gibi bir
  //   yol, ders dosyasını okuyan herkesin makinesinden dosya kopyalatabilirdi.
  const abs = path.resolve(ROOT, norm);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return { disari: true, yollar: [] };

  if (!globSihirli(norm)) {
    return { disari: false, yollar: existsSync(path.join(ROOT, norm)) ? [norm] : [] };
  }

  const sabit = [];
  for (const s of norm.split("/")) { if (globSihirli(s)) break; sabit.push(s); }
  const kokRel = sabit.join("/");
  const kokAbs = path.join(ROOT, kokRel);
  if (!existsSync(kokAbs)) return { disari: false, yollar: [] };

  const re = new RegExp("^" + globToRegex(norm) + "$");
  const bulunan = [];
  const gez = (dizinAbs, dizinRel) => {
    let girdiler;
    try { girdiler = readdirSync(dizinAbs, { withFileTypes: true }); } catch { return; }
    for (const e of girdiler) {
      if (GEZINME_DISI.has(e.name)) continue;
      const rel = dizinRel ? `${dizinRel}/${e.name}` : e.name;
      if (e.isDirectory()) gez(path.join(dizinAbs, e.name), rel);
      else if (re.test(rel)) bulunan.push(rel);
    }
  };
  if (statSync(kokAbs).isDirectory()) gez(kokAbs, kokRel);
  else if (re.test(kokRel)) bulunan.push(kokRel);
  return { disari: false, yollar: bulunan.sort() };
}

/** Bir dizini özyinelemeli olarak göreli dosya yollarına açar. */
function dizinAc(rel) {
  const out = [];
  const gez = (dizinRel) => {
    for (const e of readdirSync(path.join(ROOT, dizinRel), { withFileTypes: true })) {
      if (GEZINME_DISI.has(e.name)) continue;
      const r = `${dizinRel}/${e.name}`;
      if (e.isDirectory()) gez(r);
      else out.push(r);
    }
  };
  gez(rel);
  return out.sort();
}

/** Adımın uretilenDosyalar[] listesini gerçek dosya yollarına çözer. */
function dosyalariCoz(desenler) {
  const cozum = [];
  for (const desen of desenler ?? []) {
    const { disari, yollar } = globAc(desen);
    if (disari) {
      cozum.push({ desen, yollar: [], hata: "repo kökünün DIŞINA çıkıyor — reddedildi" });
      continue;
    }
    const genisletilmis = [];
    for (const y of yollar) {
      const abs = path.join(ROOT, y);
      if (statSync(abs).isDirectory()) genisletilmis.push(...dizinAc(y));
      else genisletilmis.push(y);
    }
    cozum.push({
      desen,
      yollar: [...new Set(genisletilmis)].sort(),
      hata: genisletilmis.length ? null : "repoda karşılığı yok",
    });
  }
  return cozum;
}

/** Repodan hedef dizine kopyalar. @returns {{kopyalanan:number, bayt:number, hatalar:string[]}} */
function dosyalariKopyala(yollar, hedefKok) {
  let kopyalanan = 0;
  let bayt = 0;
  const hatalar = [];
  for (const rel of yollar) {
    try {
      const kaynak = path.join(ROOT, rel);
      const hedef = path.resolve(hedefKok, rel);
      if (!hedef.startsWith(path.resolve(hedefKok) + path.sep)) {
        hatalar.push(`${rel}: hedef dizinin dışına çıkıyor — atlandı`);
        continue;
      }
      mkdirSync(path.dirname(hedef), { recursive: true });
      copyFileSync(kaynak, hedef);
      kopyalanan++;
      bayt += statSync(kaynak).size;
    } catch (e) {
      hatalar.push(`${rel}: ${e.message}`);
    }
  }
  return { kopyalanan, bayt, hatalar };
}

const bayt = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function dizinBos(dizin) {
  if (!existsSync(dizin)) return true;
  try { return readdirSync(dizin).length === 0; } catch { return true; }
}

// ═════════════════════════════════════════════════════════════════════════════
// KOMUT ÇALIŞTIRMA
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Bilinen ön koşullar. `atlanabilir: true` olan doğrulamalarda bunlardan biri
 * eksikse komut hiç çalıştırılmaz ve sonuç SKIP olur (FAIL değil).
 * Liste bilinçli olarak KISA: tahmine dayalı bir "ön koşul yok" kararı, gerçek
 * bir başarısızlığı affetmek anlamına gelir.
 */
const BILINEN_ANAHTARLAR = [
  "ANTHROPIC_API_KEY", "XURRENT_TOKEN", "XURRENT_ACCOUNT",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GRAPH_CLIENT_ID",
];

function binVarMi(bin) {
  try {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { encoding: "utf8" });
    return r.status === 0;
  } catch { return false; }
}

function eksikOnKosul(komut, env) {
  // 1) Komutta $VAR / ${VAR} biçiminde geçen ortam değişkenleri
  for (const m of String(komut).matchAll(/\$\{?([A-Z][A-Z0-9_]{2,})\}?/g)) {
    if (!env[m[1]]) return `ortam değişkeni tanımsız: ${m[1]}`;
  }
  // 2) Komut metninde adı geçen bilinen gizli anahtarlar
  for (const k of BILINEN_ANAHTARLAR) {
    if (komut.includes(k) && !env[k]) return `ortam değişkeni tanımsız: ${k}`;
  }
  // 3) İlk çalıştırılabilir PATH'te var mı?
  const bin = String(komut).trim().split(/\s+/)[0];
  if (/^[A-Za-z0-9_.-]+$/.test(bin) && !binVarMi(bin)) return `komut PATH'te yok: ${bin}`;
  return null;
}

function komutCalistir(komut, cwd, env, timeoutMs = KOMUT_ZAMAN_ASIMI_MS) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // shell:true — doğrulama komutları `&&`, boru ve tırnak içerebilir; veri
    // dosyası bunları düz metin olarak yazar, biz ayrıştırmayız.
    const child = spawn(komut, { cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let cikti = "";
    const topla = (d) => { cikti += d.toString(); };
    child.stdout.on("data", topla);
    child.stderr.on("data", topla);
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* zaten kapandı */ }
    }, timeoutMs);
    let baslatmaHatasi = null;
    child.on("error", (e) => { baslatmaHatasi = e.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        kod: code,
        sinyal: signal,
        cikti,
        ms: Date.now() - t0,
        baslatmaHatasi,
        zamanAsimi: signal === "SIGTERM" && Date.now() - t0 >= timeoutMs - 50,
      });
    });
  });
}

/** Uzun çıktıyı baş+son olarak kırpar — build logu ekranı yutmasın. */
function ciktiBas(cikti, indent = "      ", bas = 40, son = 15) {
  const lines = String(cikti).replace(/\s+$/, "").split("\n");
  if (!lines.length || (lines.length === 1 && lines[0] === "")) {
    write(paint(C.gray, indent + "(çıktı yok)"));
    return;
  }
  if (lines.length <= bas + son) {
    for (const l of lines) write(paint(C.gray, indent + l));
    return;
  }
  for (const l of lines.slice(0, bas)) write(paint(C.gray, indent + l));
  write(paint(C.yellow, `${indent}… ${lines.length - bas - son} satır gizlendi …`));
  for (const l of lines.slice(-son)) write(paint(C.gray, indent + l));
}

// ═════════════════════════════════════════════════════════════════════════════
// --live : promptu GERÇEKTEN Claude'a gönder
// ═════════════════════════════════════════════════════════════════════════════

// ANTHROPIC_BASE_URL yaygın bir sözleşmedir (proxy / kurumsal ağ geçidi). Ayrıca
// --live yolunu yerel bir sahte uçla test edilebilir kılar — tıpkı
// XURRENT_GRAPHQL_URL'in live Xurrent yolunu tools/fake-xurrent ile test
// edilebilir kılması gibi. Aynı desen, aynı sebep.
const API_BASE = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "");
const API_URL = `${API_BASE}/v1/messages`;
const API_MODEL = "claude-opus-5";
const API_VERSION = "2023-06-01";

async function claudeCagir(apiKey, prompt, sistem) {
  const govde = {
    model: API_MODEL,
    max_tokens: 8000,
    system: sistem,
    messages: [{ role: "user", content: prompt }],
  };
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(govde),
    signal: AbortSignal.timeout(180000),
  });
  const metin = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${metin.slice(0, 400)}`);
  const json = JSON.parse(metin);
  const parcalar = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text);
  return { metin: parcalar.join("\n"), kullanim: json.usage ?? null };
}

/** İki metni gerçekten YAN YANA basar. Satırlar sarılmaz, kırpılır — hizalama korunur. */
function yanYana(solBaslik, solMetin, sagBaslik, sagMetin, maxSatir = 45) {
  const w = termWidth();
  const kolon = Math.floor((w - 3) / 2);
  const kirp = (s) => {
    const t = String(s).replace(/\t/g, "  ");
    return t.length > kolon ? t.slice(0, kolon - 1) + "…" : t.padEnd(kolon, " ");
  };
  const sol = String(solMetin).split("\n");
  const sag = String(sagMetin).split("\n");
  const n = Math.min(Math.max(sol.length, sag.length), maxSatir);

  write("");
  write("  " + paint(C.bold + C.cyan, kirp(solBaslik)) + " " + paint(C.bold + C.magenta, kirp(sagBaslik)));
  write(paint(C.gray, "  " + "─".repeat(kolon) + "─┼─" + "─".repeat(kolon)));
  for (let i = 0; i < n; i++) {
    const a = sol[i] ?? "";
    const b = sag[i] ?? "";
    const ayrac = a === b ? paint(C.gray, " │ ") : paint(C.yellow, " ┃ ");
    write("  " + paint(a === b ? C.gray : C.cyan, kirp(a)) + ayrac + paint(a === b ? C.gray : C.magenta, kirp(b)));
  }
  if (Math.max(sol.length, sag.length) > n) {
    write(paint(C.yellow, `  … ${Math.max(sol.length, sag.length) - n} satır daha (kırpıldı)`));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ADIM SEÇİMİ — sihirbazla AYNI üç kademeli kısmi eşleşme
//   1) birebir id   2) id bu önekle başlıyor   3) id bu metni içeriyor
// İlk dolu kademe kazanır; tam id yazan kişi kısmi eşleşmenin gürültüsüne
// yakalanmaz. Sebep pratiktir: sunum sırasında kimse "05-fixture" yazmaz, "05" yazar.
// ═════════════════════════════════════════════════════════════════════════════
function eslesenler(adimlar, token) {
  const t = String(token).toLowerCase();
  const birebir = adimlar.filter((a) => a.id.toLowerCase() === t);
  if (birebir.length) return birebir;
  const onek = adimlar.filter((a) => a.id.toLowerCase().startsWith(t));
  if (onek.length) return onek;
  return adimlar.filter((a) => a.id.toLowerCase().includes(t));
}

function adimSec(hepsi, { adim, from }) {
  const notlar = [];
  let secim = hepsi;

  if (from) {
    const m = eslesenler(secim, from);
    if (!m.length) return { adimlar: [], notlar, hata: `--from "${from}" hiçbir adımla eşleşmedi.` };
    secim = secim.slice(secim.indexOf(m[0]));
    notlar.push(`--from ${from} → "${m[0].id}" adımından sonuna kadar (${secim.length} adım)`);
  }

  if (adim?.length) {
    const secilen = new Set();
    for (const tok of adim) {
      const m = eslesenler(secim, tok);
      if (!m.length) {
        return {
          adimlar: [], notlar,
          hata: `--adim "${tok}" hiçbir adımla eşleşmedi. Geçerli id'ler: ${hepsi.map((a) => a.id).join(", ")}`,
        };
      }
      notlar.push(m.length > 1 ? `"${tok}" → ${m.length} adım: ${m.map((a) => a.id).join(", ")}` : `"${tok}" → ${m[0].id}`);
      for (const a of m) secilen.add(a);
    }
    secim = secim.filter((a) => secilen.has(a)); // orijinal sıra korunur — ders sırası anlamlıdır
  }

  return { adimlar: secim, notlar, hata: null };
}

// ═════════════════════════════════════════════════════════════════════════════
// YARDIM
// ═════════════════════════════════════════════════════════════════════════════
function printHelp() {
  const w = termWidth();
  process.stdout.write(
    [
      "",
      paint(C.bold + C.cyan, "xurrent-mcp atölyesi") + paint(C.gray, " — bu proje NASIL üretildi?"),
      paint(C.gray, "─".repeat(w)),
      "",
      paint(C.bold, "SİHİRBAZ mı, ATÖLYE mi?"),
      "  clients/wizard/wizard.mjs   uygulamanın NE YAPTIĞINI öğretir (canlı MCP client'ı)",
      "  clients/atolye/atolye.mjs   uygulamanın NASIL ÜRETİLDİĞİNİ öğretir (bu script)",
      "",
      paint(C.bold, "KULLANIM"),
      "  node clients/atolye/atolye.mjs [seçenekler]",
      "",
      paint(C.bold, "MODLAR"),
      "  (varsayılan)              ANLAT — adım adım ilerler; anlatım, prompt, karar,",
      "                            öğrenim ve tuzak basılır, her adımda Enter beklenir.",
      "  --insa <dizin>            ★ GERÇEKTEN İNŞA EDER. Her adımda uretilenDosyalar[]",
      "                            REPODAN okunup hedef dizine kopyalanır (glob destekli),",
      "                            ardından dogrulama.komut HEDEF DİZİNDE çalıştırılır ve",
      "                            GERÇEK çıktısı gösterilir. Öğrenci sonunda çalışan bir",
      "                            kopyaya sahip olur VE sırayı öğrenir.",
      "                            Hedef dizin boş değilse UYARI + onay istenir; onay",
      "                            verilmeden asla üzerine yazılmaz (--uzerine-yaz ile geçilir).",
      "",
      paint(C.bold, "SEÇENEKLER"),
      "  --auto                    Beklemeden geçer (CI). Onay soran her yerde varsayılan alınır.",
      "  --json                    STDOUT'a makine-okunur özet basar; anlatım stderr'e gider.",
      "  --adim <id[,id]>          Tek adım (veya virgüllü liste). KISMİ eşleşme: 05 → 05-...",
      "  --from <id>               Bu adımdan İTİBAREN sona kadar çalıştırır.",
      "  --live                    OPSİYONEL. ANTHROPIC_API_KEY varsa adımın promptunu",
      "                            GERÇEKTEN Claude'a gönderir ve üretileni repodaki gerçek",
      "                            dosyayla yan yana gösterir. Anahtar yoksa net bir mesajla",
      "                            ATLANIR (SKIP) — hata vermez.",
      `                            POST ${API_URL}  ·  model: ${API_MODEL}`,
      "                            Uç nokta ANTHROPIC_BASE_URL ile değiştirilebilir (proxy",
      "                            veya test için).",
      "  --veri <yol>              Alternatif adım dosyası (varsayılan: docs/atolye/adimlar.json)",
      "  --sema <yol>              Alternatif şema (varsayılan: docs/atolye/adimlar.schema.json)",
      "  --liste                   Adımları listeler ve çıkar.",
      "  --dogrula                 Veri dosyasını şemaya karşı doğrular ve çıkar.",
      "  --uzerine-yaz             --insa hedef dizini boş değilse onay sormadan devam eder.",
      "  --no-color                ANSI renklerini kapatır.",
      "  -h, --help                Bu yardımı gösterir.",
      "",
      paint(C.bold, "SONUÇ MODELİ"),
      "  Her kontrol üç durumdan birini alır (sihirbazla AYNI model):",
      "    PASS  kontrol çalıştı ve tuttu",
      "    FAIL  kontrol çalıştı ve TUTMADI — gerçek bir uyumsuzluk",
      "    SKIP  kontrol ÇALIŞTIRILAMADI (ön koşul yok) — başarısızlık DEĞİLDİR",
      '  Özet satırı: "N geçti, M başarısız, K atlandı". Çıkış kodunu YALNIZCA FAIL etkiler.',
      "",
      paint(C.bold, "HANGİ KONTROLLER ÇALIŞIR?"),
      "  dosyalar   uretilenDosyalar[] repoda gerçekten var mı? (her modda çalışır)",
      "  kopyalama  dosyalar hedef dizine kopyalandı mı?        (yalnızca --insa)",
      "  dogrulama  dogrulama.komut çalıştı ve tuttu mu?        (yalnızca --insa)",
      "  canli      prompt Claude'a gönderilebildi mi?          (yalnızca --live)",
      "  --insa yokken doğrulama kontrolleri SKIP'tir; bu bir başarısızlık değildir.",
      "",
      paint(C.bold, "ÇALIŞMA DİZİNİ"),
      "  --insa modunda doğrulama komutu HEDEF DİZİNDE çalışır — inşa edilen kopyayı",
      "  doğrulamak istiyoruz, kaynağı değil. Kullanılan dizin her koşuda ekrana basılır,",
      `  komut zaman aşımı ${KOMUT_ZAMAN_ASIMI_MS / 60000} dakikadır.`,
      "  Repo kökündeki bir dosyaya ihtiyaç duyan komutlar ATOLYE_KOK ortam değişkenini",
      "  kullanabilir, örn:  node $ATOLYE_KOK/scripts/verify-contract.mjs --all",
      "  (Dikkat: $ATOLYE_KOK yazan bir komut 'atlanabilir' ise ön koşul kontrolüne takılmaz;",
      "   değişken atölye tarafından her zaman set edilir.)",
      "",
      paint(C.bold, "ÖRNEKLER"),
      "  node clients/atolye/atolye.mjs",
      "  node clients/atolye/atolye.mjs --auto --json",
      "  node clients/atolye/atolye.mjs --insa /tmp/atolye-demo",
      "  node clients/atolye/atolye.mjs --adim 05",
      "  node clients/atolye/atolye.mjs --from 04 --auto",
      "  node clients/atolye/atolye.mjs --live --adim 02",
      "",
      paint(C.bold, "ÇIKIŞ KODLARI"),
      "  0  hiç FAIL yok (SKIP'ler çıkış kodunu etkilemez)",
      "  1  en az bir kontrol BAŞARISIZ",
      "  2  hatalı parametre, eksik/bozuk veri dosyası veya reddedilen hedef dizin",
      "",
      paint(C.gray, "Ders içeriği docs/atolye/adimlar.json dosyasındadır; bu script onu yürütür."),
      paint(C.gray, "Dosya İÇERİKLERİ veri dosyasında TUTULMAZ — repodan okunur, böylece bayatlamaz."),
      "",
    ].join("\n"),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ADIM BÖLÜMLERİNİ BAS
// ═════════════════════════════════════════════════════════════════════════════

function anlatBas(adim) {
  for (const p of adim.anlat ?? []) {
    write("");
    para(p, { indent: "  " });
  }
}

/**
 * ★ Prompt bloğu BİREBİR basılır: girinti yok, sarma yok.
 *   Sebep: öğrenci bu metni kopyalayacak. Sararsak veya girintilersek
 *   kopyalanan metin AI'a verilenden FARKLI olur — dersin malzemesi bozulur.
 *   Bu yüzden çerçeve yalnızca üst/alt çizgidir, sol sütunda gutter yoktur.
 */
function promptBas(prompt) {
  const w = termWidth();
  const baslik = "╭─ PROMPT ";
  write("");
  write(paint(C.yellow + C.bold, baslik + "─".repeat(Math.max(0, w - baslik.length))));
  write(paint(C.gray, "   AI'a GERÇEKTEN verilen metin — birebir, kopyalanabilir:"));
  write("");
  for (const satir of String(prompt).split("\n")) write(paint(C.yellow, satir));
  write("");
  write(paint(C.yellow + C.bold, "╰" + "─".repeat(w - 1)));
}

/** Seçilmeyen şıklar da gösterilir — mühendislik "doğru cevap" değil, TAKAS demektir. */
function kararBas(karar) {
  write("");
  write(paint(C.bold + C.blue, "  ◇ KARAR ") + paint(C.gray, "(bu adımı insan verdi)"));
  write("");
  para(karar.soru, { indent: "    ", color: C.bold });
  for (const s of karar.secenekler ?? []) {
    const secili = s.etiket === karar.secilen;
    write("");
    write(
      "    " +
        (secili
          ? paint(C.green + C.bold, "✔ SEÇİLDİ  ") + paint(C.green + C.bold, s.etiket)
          : paint(C.gray, "○ alınmadı ") + paint(C.gray, s.etiket)),
    );
    if (s.artisi) para("+ " + s.artisi, { indent: "        ", color: secili ? C.green : C.gray });
    if (s.eksisi) para("− " + s.eksisi, { indent: "        ", color: secili ? C.yellow : C.gray });
  }
  write("");
  para("NEDEN: " + karar.neden, { indent: "    ", color: C.blue });
}

function ogrenimBas(adim) {
  write("");
  write(paint(C.magenta + C.bold, "  ◆ NE ÖĞRENDİK"));
  for (const l of adim.ogrenim ?? []) {
    write("");
    para("• " + l, { indent: "    ", color: C.magenta });
  }
  if (adim.tuzak) {
    write("");
    write(paint(C.yellow + C.bold, "  ⚠ TUZAK"));
    write("");
    para(adim.tuzak, { indent: "    ", color: C.yellow });
  }
  if (adim.docs) {
    write("");
    write(paint(C.gray, `  » Ayrıntı: ${adim.docs}`));
  }
}

function sonucBas(kontrol) {
  write("");
  if (kontrol.durum === "pass") {
    write(paint(C.green + C.bold, "  ✔ PASS  ") + paint(C.green, `${kontrol.etiket} — ${kontrol.detay}`));
  } else if (kontrol.durum === "skip") {
    write(paint(C.yellow + C.bold, "  ○ SKIP  ") + paint(C.yellow, `${kontrol.etiket} — ${kontrol.detay}`));
  } else {
    write(paint(C.red + C.bold, "  ✘ FAIL  ") + paint(C.red, `${kontrol.etiket} — ${kontrol.detay}`));
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// ANA AKIŞ
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  if (args.help) { printHelp(); return 0; }

  const veriYolu = path.resolve(ROOT, args.veri ?? VARSAYILAN_VERI);
  const semaYolu = path.resolve(ROOT, args.sema ?? VARSAYILAN_SEMA);

  const yuk = await veriYukle(veriYolu, semaYolu);
  if (!yuk.ok) {
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, veriDosyasi: veriYolu, hata: "veri dosyası yüklenemedi veya şemaya uymuyor" }, null, 2) + "\n",
      );
    }
    return yuk.cikis;
  }
  const veri = yuk.veri;
  const hepsi = veri.adimlar ?? [];
  const fazlar = new Map((veri.fazlar ?? []).map((f) => [f.id, f]));

  if (args.dogrulaSadece) {
    write("");
    write(paint(C.green + C.bold, "  ✔ Veri dosyası şemaya UYGUN."));
    write(paint(C.gray, `    dosya: ${kisaYol(veriYolu)}`));
    write(paint(C.gray, `    ${hepsi.length} adım, ${fazlar.size} faz`));
    if (yuk.uyarilar.length) {
      write("");
      write(paint(C.yellow + C.bold, `  ⚠ ${yuk.uyarilar.length} anlamsal uyarı (çıkış kodunu etkilemez)`));
      for (const u of yuk.uyarilar) write(paint(C.yellow, `    • ${u.yol}: ${u.mesaj}`));
    }
    write("");
    if (args.json) {
      process.stdout.write(JSON.stringify({ ok: true, veriDosyasi: veriYolu, adimSayisi: hepsi.length, uyarilar: yuk.uyarilar }, null, 2) + "\n");
    }
    return 0;
  }

  const sec = adimSec(hepsi, { adim: args.adim, from: args.from });
  if (sec.hata) {
    process.stderr.write(`HATA: ${sec.hata}\n`);
    return 2;
  }
  const adimlar = sec.adimlar;
  if (!adimlar.length) {
    process.stderr.write("HATA: seçim sonucunda çalıştırılacak adım kalmadı.\n");
    return 2;
  }

  if (args.liste) {
    for (const [i, a] of adimlar.entries()) {
      process.stdout.write(
        `${String(i + 1).padStart(2, "0")}  ${a.id.padEnd(24)}  ${String(a.faz).padEnd(14)}  ${a.baslik}\n`,
      );
    }
    return 0;
  }

  // ── Ortam ─────────────────────────────────────────────────────────────────
  // .env → gerçek process.env (gerçek env HER ZAMAN kazanır).
  const dotenv = loadDotEnv(path.join(ROOT, ".env"));
  const childEnv = {
    ...dotenv,
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
    ATOLYE_KOK: ROOT, // doğrulama komutları repo köküne ihtiyaç duyarsa
  };
  const apiKey = childEnv.ANTHROPIC_API_KEY ?? null;

  // ── Hedef dizin (yalnızca --insa) ─────────────────────────────────────────
  let hedef = null;
  if (args.insa) {
    hedef = path.resolve(process.cwd(), args.insa);
    if (hedef === ROOT || ROOT.startsWith(hedef + path.sep)) {
      process.stderr.write(
        `HATA: hedef dizin repo kökünü kapsıyor (${hedef}). Atölye kendi kaynağının üzerine yazamaz.\n`,
      );
      return 2;
    }
    if (!dizinBos(hedef)) {
      write("");
      write(paint(C.yellow + C.bold, "  ⚠ HEDEF DİZİN BOŞ DEĞİL"));
      write("");
      write(paint(C.yellow, `    Dizin: ${hedef}`));
      para(
        `İçinde ${readdirSync(hedef).length} girdi var. Atölye bu dizine dosya KOPYALAYACAK ve ` +
          "aynı adlı dosyalar ÜZERİNE YAZILACAK.",
        { indent: "    ", color: C.yellow },
      );
      write("");
      if (args.uzerineYaz) {
        write(paint(C.yellow, "  --uzerine-yaz verildi → devam ediliyor."));
      } else if (args.auto || !process.stdin.isTTY) {
        // ★ --auto "onay sorma" demektir, "onayı varsay" demek DEĞİL. Yıkıcı bir
        //   işlemi sessizce yapmak, CI'da fark edilmeyen veri kaybı üretir.
        write(paint(C.red + C.bold, "  ✘ Reddedildi: etkileşimsiz modda dolu bir dizinin üzerine yazılmaz."));
        write("");
        para("Yapılabilecekler: boş bir dizin ver, ya da bilinçliyse --uzerine-yaz ekle.", { indent: "    ", color: C.gray });
        write("");
        if (args.json) {
          process.stdout.write(JSON.stringify({ ok: false, mod: "insa", hedefDizin: hedef, hata: "hedef dizin boş değil; --uzerine-yaz verilmedi" }, null, 2) + "\n");
        }
        return 2;
      } else {
        const devam = await evetHayir(paint(C.yellow, "  Üzerine yazılsın mı?"), false);
        if (!devam) {
          write(paint(C.gray, "  İptal edildi. Hiçbir dosya yazılmadı."));
          write("");
          return 2;
        }
      }
    }
    mkdirSync(hedef, { recursive: true });
  }

  // ── Başlık ────────────────────────────────────────────────────────────────
  write("");
  write(paint(C.bold + C.magenta, `  ${veri.title ?? "xurrent-mcp atölyesi"}`));
  if (veri.subtitle) write(paint(C.gray, `  ${veri.subtitle}`));
  write("");
  renderTable(
    ["", ""],
    [
      ["Mod", MOD === "insa" ? "İNŞA — dosyalar kopyalanır, doğrulamalar ÇALIŞTIRILIR" : "ANLAT — hiçbir dosya yazılmaz"],
      ...(hedef ? [["Hedef dizin", hedef]] : []),
      ["Veri dosyası", kisaYol(veriYolu)],
      ["Sürüm", String(veri.version ?? "?")],
      ["Adım sayısı", `${adimlar.length}${adimlar.length !== hepsi.length ? ` / ${hepsi.length} (seçildi)` : ""}`],
      ...(veri.tahminiDakika ? [["Tahmini süre", `${veri.tahminiDakika} dk`]] : []),
      ["--live", args.live ? (apiKey ? `açık — ${API_MODEL}` : "istendi ama ANTHROPIC_API_KEY yok → atlanacak") : "kapalı"],
    ],
    Math.min(termWidth(), 92),
  );
  for (const n of sec.notlar) write(paint(C.gray, `  seçim: ${n}`));

  if (yuk.uyarilar.length) {
    write("");
    write(paint(C.yellow + C.bold, `  ⚠ ${yuk.uyarilar.length} anlamsal uyarı (ders yine de çalışır)`));
    for (const u of yuk.uyarilar) write(paint(C.yellow, `    • ${u.yol}: ${u.mesaj}`));
  }

  if (args.live && !apiKey) {
    write("");
    para(
      "--live istendi ama ANTHROPIC_API_KEY tanımlı değil. Canlı prompt gönderimi ATLANACAK " +
        "(SKIP) — atölye normal şekilde devam eder. Anahtarı .env dosyasına ekleyebilir veya " +
        "ANTHROPIC_API_KEY=... biçiminde ortamdan verebilirsin.",
      { indent: "  ", color: C.yellow },
    );
  }

  // ── Rapor iskeleti ────────────────────────────────────────────────────────
  const rapor = {
    ok: true,
    mod: MOD,
    hedefDizin: hedef,
    veriDosyasi: kisaYol(veriYolu),
    surum: veri.version ?? null,
    baslik: veri.title ?? null,
    live: args.live,
    baslangic: new Date().toISOString(),
    uyarilar: yuk.uyarilar,
    adimlar: [],
    toplam: { adim: 0, kontrol: 0, gecti: 0, basarisiz: 0, atlandi: 0, kopyalananDosya: 0, kopyalananBayt: 0 },
  };

  let sonFaz = null;

  // ── Ders döngüsü ──────────────────────────────────────────────────────────
  for (const [idx, adim] of adimlar.entries()) {
    const kayit = { id: adim.id, faz: adim.faz, baslik: adim.baslik, durum: "pass", kontroller: [], dosyalar: [] };
    const kontrolEkle = (etiket, durum, detay, ekstra = {}) => {
      const k = { etiket, durum, detay, ...ekstra };
      kayit.kontroller.push(k);
      rapor.toplam.kontrol++;
      if (durum === "pass") rapor.toplam.gecti++;
      else if (durum === "skip") {
        rapor.toplam.atlandi++;
        if (kayit.durum === "pass") kayit.durum = "skip";
      } else {
        rapor.toplam.basarisiz++;
        kayit.durum = "fail";
        rapor.ok = false;
      }
      sonucBas(k);
      return k;
    };

    if (adim.faz && adim.faz !== sonFaz) {
      const f = fazlar.get(adim.faz);
      fazBanner(f?.baslik ?? adim.faz, f?.ozet);
      sonFaz = adim.faz;
    }
    adimBasligi(idx + 1, adimlar.length, adim);

    // 1) Anlatım
    anlatBas(adim);

    // 2) Prompt (dersin asıl malzemesi)
    if (adim.prompt) promptBas(adim.prompt);

    // 3) Karar
    if (adim.karar) kararBas(adim.karar);

    // 4) Üretilen dosyalar — HER MODDA kontrol edilir.
    //    "Kılavuz repoda olmayan bir dosyayı gösteriyor" gerçek bir hatadır;
    //    --insa verilmedi diye affetmek, bayatlamayı görünmez yapardı.
    let cozulmus = [];
    if (adim.uretilenDosyalar?.length) {
      cozulmus = dosyalariCoz(adim.uretilenDosyalar);
      const tumYollar = [...new Set(cozulmus.flatMap((c) => c.yollar))];
      const eksikler = cozulmus.filter((c) => c.hata);
      kayit.dosyalar = tumYollar;

      write("");
      write(paint(C.bold + C.cyan, "  ▸ ÜRETİLEN DOSYALAR ") + paint(C.gray, "(içerik repodan okunur, veri dosyasından DEĞİL)"));
      write("");
      for (const c of cozulmus) {
        if (c.hata) {
          write(paint(C.red, `    ✘ ${c.desen}  → ${c.hata}`));
          continue;
        }
        // Tek dosyaya çözülen düz bir yol için deseni ayrıca yazmak gürültüdür;
        // glob ise kaç dosyaya açıldığı bilgisi dersin parçasıdır.
        const globMu = c.yollar.length !== 1 || c.yollar[0] !== c.desen;
        const girinti = globMu ? "      " : "    ";
        if (globMu) write(paint(C.gray, `    ${c.desen}  → ${c.yollar.length} dosya`));
        for (const y of c.yollar) {
          const st = statSync(path.join(ROOT, y));
          write(paint(C.cyan, girinti + y) + paint(C.gray, `  (${bayt(st.size)})`));
        }
      }

      kontrolEkle(
        "dosyalar",
        eksikler.length ? "fail" : "pass",
        eksikler.length
          ? `${eksikler.length} desen çözülemedi → ${eksikler.map((e) => `${e.desen} (${e.hata})`).join("; ")}`
          : `${tumYollar.length} dosya repoda mevcut (${cozulmus.length} desen)`,
        { desenler: adim.uretilenDosyalar, cozulen: tumYollar },
      );

      // 5) Kopyalama — yalnızca --insa
      if (hedef) {
        if (!tumYollar.length) {
          kontrolEkle("kopyalama", "skip", "kopyalanacak dosya çözülemedi");
        } else {
          const sonuc = dosyalariKopyala(tumYollar, hedef);
          rapor.toplam.kopyalananDosya += sonuc.kopyalanan;
          rapor.toplam.kopyalananBayt += sonuc.bayt;
          write("");
          write(paint(C.gray, `    → ${sonuc.kopyalanan} dosya kopyalandı (${bayt(sonuc.bayt)}) → ${hedef}`));
          for (const h of sonuc.hatalar) write(paint(C.red, `      ✘ ${h}`));
          kontrolEkle(
            "kopyalama",
            sonuc.hatalar.length ? "fail" : "pass",
            sonuc.hatalar.length
              ? `${sonuc.hatalar.length} dosya kopyalanamadı`
              : `${sonuc.kopyalanan} dosya hedefe yazıldı (${bayt(sonuc.bayt)})`,
            { kopyalanan: sonuc.kopyalanan, bayt: sonuc.bayt, hatalar: sonuc.hatalar },
          );
        }
      } else {
        kontrolEkle("kopyalama", "skip", "--insa verilmedi, dosya kopyalanmaz");
      }
    }

    // 6) Doğrulama
    if (adim.dogrulama) {
      const d = adim.dogrulama;
      const beklenenKod = Number.isInteger(d.cikisKodu) ? d.cikisKodu : 0;

      write("");
      write(paint(C.bold + C.cyan, "  ▶ DOĞRULAMA"));
      write("");
      write(paint(C.gray, "    komut    : ") + paint(C.bold, d.komut));
      write(paint(C.gray, "    beklenen : ") + d.beklenen);
      write(paint(C.gray, `    çıkış kodu: ${beklenenKod}${d.atlanabilir ? "   (atlanabilir: ön koşul yoksa SKIP)" : ""}`));

      if (!hedef) {
        kontrolEkle("dogrulama", "skip", "doğrulama yalnızca --insa modunda çalıştırılır");
      } else {
        const eksik = d.atlanabilir ? eksikOnKosul(d.komut, childEnv) : null;
        if (eksik) {
          kontrolEkle("dogrulama", "skip", `ön koşul sağlanmadı → ${eksik}`);
        } else {
          // ★ Komut NEREDE koşar? Adımın kendi beyanı belirler (dogrulama.calismaDizini).
          //
          //   "hedef" → --insa ile inşa edilen dizin. O adıma kadar KOPYALANMIŞ dosyalarla
          //             kendi kendine yeten kontroller için. İnşa edilenin gerçekten
          //             doğrulandığının kanıtı bu adımlardır.
          //   "repo"  → bu deponun kökü (VARSAYILAN). Entegrasyon komutları — sihirbaz,
          //             verify-contract, npm build — tam depoyu ister; node_modules'ı ve
          //             derlenmiş çıktıları hedefe kopyalamak ne gerçekçi ne de öğretici.
          //
          // Bu ayrım baştan emirle çözülmedi; ilk koşuda --insa'daki HER doğrulama düştü
          // çünkü komutlar repo köküne göre yazılmıştı ama hedef dizinde koşuyordu.
          // Çözüm, tarafları hizalamak yerine sözleşmeye alan eklemek oldu.
          const calismaDizini = d.calismaDizini === "hedef" ? hedef : ROOT;
          const nerede = d.calismaDizini === "hedef" ? "inşa edilen dizin" : "repo kökü";
          write(paint(C.gray, `    çalışma dizini: ${calismaDizini}  (${nerede})`));
          write("");
          write(paint(C.gray, "    çalıştırılıyor..."));
          const r = await komutCalistir(d.komut, calismaDizini, childEnv);
          write("");
          write(paint(C.gray, `    ── GERÇEK ÇIKTI ── (${r.ms} ms, çıkış kodu ${r.kod ?? "—"}${r.sinyal ? `, sinyal ${r.sinyal}` : ""})`));
          ciktiBas(r.cikti);

          const beklenenBulundu = String(r.cikti).includes(String(d.beklenen));
          if (r.baslatmaHatasi) {
            kontrolEkle("dogrulama", d.atlanabilir ? "skip" : "fail", `komut başlatılamadı: ${r.baslatmaHatasi}`, {
              komut: d.komut, cwd: calismaDizini, cikisKodu: r.kod, ms: r.ms,
            });
          } else if (r.zamanAsimi) {
            kontrolEkle("dogrulama", "fail", `zaman aşımı (${KOMUT_ZAMAN_ASIMI_MS / 60000} dk)`, {
              komut: d.komut, cwd: calismaDizini, ms: r.ms,
            });
          } else if (r.kod !== beklenenKod) {
            kontrolEkle("dogrulama", "fail", `çıkış kodu ${r.kod}, beklenen ${beklenenKod}`, {
              komut: d.komut, cwd: calismaDizini, cikisKodu: r.kod, ms: r.ms, beklenenBulundu,
            });
          } else {
            // ★ Çıkış kodu SERT kapıdır. `beklenen` ise şemaya göre "çıktıda
            //   aranan metin VEYA insan-okunur beklenti" olabilir; birebir
            //   bulunamaması tek başına FAIL sayılmaz — ama SESSİZ de geçilmez.
            kontrolEkle(
              "dogrulama",
              "pass",
              beklenenBulundu
                ? `çıkış kodu ${r.kod} ve beklenen metin çıktıda bulundu (${r.ms} ms)`
                : `çıkış kodu ${r.kod} (${r.ms} ms) — beklenen metin çıktıda BİREBİR geçmiyor`,
              { komut: d.komut, cwd: calismaDizini, cikisKodu: r.kod, ms: r.ms, beklenenBulundu },
            );
            if (!beklenenBulundu) {
              para(
                `⚠ "beklenen" alanı çıktıda birebir geçmiyor. Şemaya göre bu alan insan-okunur ` +
                  "bir beklenti de olabilir; çıkış kodu tuttuğu için adım PASS sayıldı.",
                { indent: "          ", color: C.yellow },
              );
            }
          }
        }
      }
    }

    // 7) --live : promptu gerçekten gönder
    if (args.live) {
      if (!adim.prompt) {
        kontrolEkle("canli", "skip", "bu adımda prompt yok (saf insan kararı)");
      } else if (!apiKey) {
        kontrolEkle("canli", "skip", "ANTHROPIC_API_KEY tanımsız");
      } else {
        write("");
        write(paint(C.bold + C.cyan, "  ⟳ CANLI — prompt Claude'a gönderiliyor") + paint(C.gray, `  (${API_MODEL})`));
        try {
          const t0 = Date.now();
          const cevap = await claudeCagir(
            apiKey,
            adim.prompt,
            "Sen bir yazılım geliştirme atölyesinde örnek üretiyorsun. Yorumları TÜRKÇE, " +
              "tanımlayıcıları İNGİLİZCE yaz. Yalnızca istenen çıktıyı üret, açıklama ekleme.",
          );
          const ms = Date.now() - t0;
          const ilkDosya = kayit.dosyalar[0] ?? null;
          if (ilkDosya) {
            yanYana(
              `AI ÇIKTISI (${API_MODEL})`,
              cevap.metin,
              `REPODAKİ GERÇEK — ${ilkDosya}`,
              readFileSync(path.join(ROOT, ilkDosya), "utf8"),
            );
          } else {
            write("");
            for (const l of cevap.metin.split("\n").slice(0, 60)) write(paint(C.cyan, "    " + l));
          }
          kontrolEkle(
            "canli",
            "pass",
            `yanıt alındı (${ms} ms, ${cevap.metin.split("\n").length} satır` +
              `${cevap.kullanim ? `, ${cevap.kullanim.output_tokens} çıktı token` : ""})`,
            { karsilastirilan: ilkDosya },
          );
        } catch (e) {
          kontrolEkle("canli", "fail", `API çağrısı başarısız: ${e.message}`);
        }
      }
    }

    // 8) Öğrenim + tuzak + docs — adımın varlık sebebi EN SONA basılır ki
    //    öğrenci önce olanı görsün, sonra dersi okusun.
    ogrenimBas(adim);

    rapor.adimlar.push(kayit);
    rapor.toplam.adim++;
    await enterBekle();
  }

  // ── Kapanış özeti ─────────────────────────────────────────────────────────
  rapor.bitis = new Date().toISOString();
  rapor.sureMs = new Date(rapor.bitis) - new Date(rapor.baslangic);
  // Çıkış kodunu YALNIZCA FAIL belirler. SKIP "bu ortamda ölçülemedi" demektir;
  // ölçülemeyeni başarısız saymak, yeşil olması gereken CI'ları kırmızıya boyar.
  rapor.ok = rapor.toplam.basarisiz === 0;
  rapor.ozet = `${rapor.toplam.gecti} geçti, ${rapor.toplam.basarisiz} başarısız, ${rapor.toplam.atlandi} atlandı`;

  write("");
  rule("═");
  write(paint(C.bold, "  ÖZET"));
  rule("═");
  write("");
  renderTable(
    ["", ""],
    [
      ["Mod", MOD === "insa" ? "İNŞA" : "ANLAT"],
      ...(hedef ? [["Hedef dizin", hedef], ["Kopyalanan dosya", `${rapor.toplam.kopyalananDosya} (${bayt(rapor.toplam.kopyalananBayt)})`]] : []),
      ["Adım", String(rapor.toplam.adim)],
      ["Kontrol", String(rapor.toplam.kontrol)],
      ["PASS", String(rapor.toplam.gecti)],
      ["FAIL", String(rapor.toplam.basarisiz)],
      ["SKIP", String(rapor.toplam.atlandi)],
      ["Süre", `${Math.round(rapor.sureMs / 100) / 10} sn`],
    ],
    Math.min(termWidth(), 74),
  );
  write("");
  write(
    paint(C.bold, "  SONUÇ: ") +
      paint(C.green, `${rapor.toplam.gecti} geçti`) + paint(C.gray, ", ") +
      paint(rapor.toplam.basarisiz ? C.red + C.bold : C.gray, `${rapor.toplam.basarisiz} başarısız`) + paint(C.gray, ", ") +
      paint(rapor.toplam.atlandi ? C.yellow : C.gray, `${rapor.toplam.atlandi} atlandı`),
  );
  write("");

  if (rapor.toplam.atlandi) {
    write(paint(C.yellow + C.bold, "  ○ ATLANAN KONTROLLER (başarısızlık değildir)"));
    for (const a of rapor.adimlar) {
      for (const k of a.kontroller) {
        if (k.durum === "skip") write(paint(C.yellow, `    • ${a.id} → ${k.etiket}: ${k.detay}`));
      }
    }
    write("");
  }

  if (rapor.ok) {
    write(paint(C.green + C.bold, "  ✔ BAŞARISIZ KONTROL YOK."));
    if (hedef) {
      write(paint(C.gray, `  Kurulan kopya: ${hedef}`));
      write(paint(C.gray, "  Sırayı da öğrendin: her adım bir öncekinin üzerine kuruldu."));
    } else {
      write(paint(C.gray, "  Aynı akışı GERÇEKTEN kurmak için: --insa <bos-dizin>"));
    }
  } else {
    write(paint(C.red + C.bold, `  ✘ ${rapor.toplam.basarisiz} KONTROL BAŞARISIZ.`));
    for (const a of rapor.adimlar) {
      for (const k of a.kontroller) {
        if (k.durum === "fail") write(paint(C.red, `    • ${a.id} → ${k.etiket}: ${k.detay}`));
      }
    }
  }
  write("");

  if (args.json) process.stdout.write(JSON.stringify(rapor, null, 2) + "\n");
  return rapor.ok ? 0 : 1;
}

main()
  .then((code) => { closeRl(); process.exit(code); })
  .catch((err) => {
    closeRl();
    process.stderr.write(`\nBEKLENMEYEN HATA: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
