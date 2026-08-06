#!/usr/bin/env node
/**
 * .env KURULUM SİHİRBAZI
 * ══════════════════════
 *
 * Soruları sırayla sorar, girilen değerleri GERÇEKTEN DOĞRULAR ve .env yazar.
 *
 * ★ İLK SÖYLEDİĞİ ŞEY: bu depo hiçbir şey doldurulmadan çalışır. Varsayılan
 *   mock moddur; token, hesap, internet gerekmez. Sihirbaz bunu baştan söyler
 *   ve "sadece varsayılanlarla devam et" seçeneği sunar. Bir kurulum aracının
 *   ilk görevi, kurulumun gerekli OLMADIĞINI söylemektir.
 *
 * ★ DOĞRULAR, VARSAYMAZ: Xurrent token'ı bir whoami sorgusuyla, Gemini anahtarı
 *   küçük bir generateContent çağrısıyla sınanır. "Kaydettim" demek yetmez —
 *   yanlış bir token'ı doğruymuş gibi kaydetmek, hiç kaydetmemekten kötüdür.
 *
 * Kullanım:
 *   node scripts/kurulum.mjs              # etkileşimli
 *   node scripts/kurulum.mjs --kontrol    # yazmaz; mevcut .env'i denetler
 *   node scripts/kurulum.mjs --dogrulama-yok   # ağ çağrısı yapma
 *   node scripts/kurulum.mjs --cikti .env.local
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { stdin as input, stdout as output } from "node:process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORNEK = path.join(ROOT, ".env.example");

const argv = process.argv.slice(2);
const bayrak = (a) => argv.includes(a);
const deger = (a, v) => { const i = argv.indexOf(a); return i >= 0 && argv[i + 1] ? argv[i + 1] : v; };

const KONTROL = bayrak("--kontrol");
const DOGRULAMA_YOK = bayrak("--dogrulama-yok");
const HEDEF = path.resolve(ROOT, deger("--cikti", ".env"));

/** Repo içindeyse göreli, dışındaysa mutlak yol göster — '../../../..' okunmuyor. */
const yol = (p) => {
  const r = path.relative(ROOT, p);
  return r.startsWith("..") ? p : r;
};

const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", c: "\x1b[36m", x: "\x1b[0m" };
const yaz = (s = "") => output.write(s + "\n");
const baslik = (s) => { yaz(""); yaz(`${C.c}${C.b}── ${s} ${"─".repeat(Math.max(0, 62 - s.length))}${C.x}`); };
const ok = (s) => yaz(`  ${C.g}✔${C.x} ${s}`);
const uyar = (s) => yaz(`  ${C.y}!${C.x} ${s}`);
const hata = (s) => yaz(`  ${C.r}✘${C.x} ${s}`);
const not = (s) => yaz(`  ${C.d}${s}${C.x}`);

if (bayrak("--help") || bayrak("-h")) {
  yaz(`
${C.b}.env kurulum sihirbazı${C.x}

  node scripts/kurulum.mjs                 etkileşimli kurulum
  node scripts/kurulum.mjs --kontrol       yazmaz, mevcut .env'i denetler
  node scripts/kurulum.mjs --dogrulama-yok ağ çağrısı yapmadan sor
  node scripts/kurulum.mjs --cikti <yol>   varsayılan .env yerine başka dosya

${C.d}Bu depo hiçbir şey doldurulmadan çalışır (mock mod). Sihirbaz yalnızca
gerçek Xurrent/Gemini/takvim erişimi eklemek istediğinde gereklidir.${C.x}
`);
  process.exit(0);
}

// ── .env okuma/yazma ────────────────────────────────────────────────────────
function envOku(dosya) {
  if (!fs.existsSync(dosya)) return {};
  const o = {};
  for (const satir of fs.readFileSync(dosya, "utf8").split("\n")) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(satir);
    if (m) o[m[1]] = m[2].trim();
  }
  return o;
}

/** .env.example'daki bölüm başlıklarını koruyarak yazar — açıklamalar orada kalsın. */
function envYaz(dosya, degerler) {
  const satirlar = [
    "# xurrent-mcp — kurulum sihirbazı tarafından üretildi",
    "# Açıklamalar ve tüm seçenekler için: .env.example",
    `# Üretim tarihi bu dosyaya YAZILMAZ (gereksiz diff üretir).`,
    "",
  ];
  for (const [bolum, anahtarlar] of Object.entries(BOLUMLER)) {
    const dolu = anahtarlar.filter((k) => degerler[k] !== undefined && degerler[k] !== "");
    if (!dolu.length) continue;
    satirlar.push(`# ── ${bolum} ${"─".repeat(Math.max(0, 60 - bolum.length))}`);
    for (const k of dolu) satirlar.push(`${k}=${degerler[k]}`);
    satirlar.push("");
  }
  fs.writeFileSync(dosya, satirlar.join("\n"), { mode: 0o600 });
}

const BOLUMLER = {
  "Xurrent adapter": ["XURRENT_MODE", "XURRENT_TOKEN", "XURRENT_ACCOUNT", "XURRENT_GRAPHQL_URL"],
  "MCP protokolü": ["MCP_PROTOCOL", "XURRENT_STATE_SECRET", "XURRENT_STATE_TTL"],
  "Güvenlik": ["XURRENT_DRY_RUN", "XURRENT_CONFIRM_POLICY", "XURRENT_SOURCE"],
  "Backdating": ["XURRENT_BACKDATE_STRATEGY", "XURRENT_MAX_BACKDATE_DAYS"],
  "Takvim": ["CALENDAR_PROVIDER", "CALENDAR_ICS_PATH", "CALENDAR_ICS_URL",
             "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_PATH", "GOOGLE_CALENDAR_ID",
             "MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_IMPERSONATE_USER"],
  "Yerel ayarlar": ["XURRENT_TIMEZONE", "DEFAULT_TIME_ALLOCATION_ID", "ROUNDING_MODE"],
  "LLM (Gemini)": ["GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_BASE_URL"],
  "Portlar": ["WEB_PORT", "MCP_HTTP_PORT"],
};

// ── doğrulayıcılar — gerçek ağ çağrısı ──────────────────────────────────────

/** Xurrent: whoami. Token + hesap slug'ı + bölge birlikte sınanır. */
async function xurrentDogrula({ token, hesap, url }) {
  if (DOGRULAMA_YOK) return { atlandi: true };
  try {
    const r = await fetch(url.replace(/\/?$/, "/"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Xurrent-Account": hesap,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "{ me { id name primaryEmail } account { id name } }" }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 401) return { ok: false, mesaj: "401 — token geçersiz veya süresi dolmuş." };
    if (r.status === 403) return { ok: false, mesaj: "403 — token geçerli ama bu hesaba yetkisi yok." };
    const g = await r.json().catch(() => null);
    if (!g) return { ok: false, mesaj: `HTTP ${r.status} — yanıt JSON değil.` };
    if (g.errors?.length) return { ok: false, mesaj: g.errors.map((e) => e.message).join("; ") };
    const me = g.data?.me;
    if (!me) return { ok: false, mesaj: "Yanıtta 'me' yok; hesap slug'ı yanlış olabilir." };
    return { ok: true, mesaj: `${me.name} (${me.primaryEmail}) · hesap: ${g.data?.account?.name ?? hesap}` };
  } catch (e) {
    return { ok: false, mesaj: `Bağlantı kurulamadı: ${e.message}` };
  }
}

/** Gemini: minik bir generateContent. Anahtar + model adı birlikte sınanır. */
async function geminiDogrula({ anahtar, model, taban }) {
  if (DOGRULAMA_YOK) return { atlandi: true };
  try {
    const r = await fetch(`${taban.replace(/\/$/, "")}/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": anahtar, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ping" }] }] }),
      signal: AbortSignal.timeout(20000),
    });
    const g = await r.json().catch(() => null);
    if (r.status === 400 && /API key not valid/i.test(g?.error?.message ?? ""))
      return { ok: false, mesaj: "Anahtar geçersiz." };
    if (r.status === 404)
      return { ok: false, mesaj: `Model bulunamadı: '${model}'. Adı kontrol edin.` };
    if (!r.ok) return { ok: false, mesaj: g?.error?.message ?? `HTTP ${r.status}` };
    if (g?.error) return { ok: false, mesaj: g.error.message };
    return { ok: true, mesaj: `model yanıt verdi (${g?.modelVersion ?? model})` };
  } catch (e) {
    return { ok: false, mesaj: `Bağlantı kurulamadı: ${e.message}` };
  }
}

// ── --kontrol: mevcut .env'i denetle ────────────────────────────────────────
async function kontrolEt() {
  yaz(`${C.b}.env denetimi${C.x}  ${C.d}${HEDEF}${C.x}`);
  if (!fs.existsSync(HEDEF)) {
    hata(`.env yok. Oluşturmak için: node scripts/kurulum.mjs`);
    not("Not: dosya olmadan da her şey mock modda çalışır.");
    process.exit(1);
  }
  const e = envOku(HEDEF);
  let sorun = 0;

  baslik("Mod");
  const mod = e.XURRENT_MODE || "mock";
  ok(`XURRENT_MODE=${mod}`);
  if (mod === "live") {
    if (!e.XURRENT_TOKEN) { hata("XURRENT_TOKEN boş — live modda zorunlu."); sorun++; }
    if (!e.XURRENT_ACCOUNT) { hata("XURRENT_ACCOUNT boş — live modda zorunlu."); sorun++; }
    if (/^\d+$/.test(e.XURRENT_ACCOUNT ?? "")) {
      hata("XURRENT_ACCOUNT numerik görünüyor. Slug olmalı (örn. 'widget'), numerik id DEĞİL.");
      sorun++;
    }
    if (e.XURRENT_DRY_RUN !== "1") uyar("XURRENT_DRY_RUN=0 — yazmalar GERÇEKTEN gönderilecek.");
    if (e.XURRENT_TOKEN && e.XURRENT_ACCOUNT) {
      const r = await xurrentDogrula({
        token: e.XURRENT_TOKEN, hesap: e.XURRENT_ACCOUNT,
        url: e.XURRENT_GRAPHQL_URL || "https://graphql.xurrent.com",
      });
      if (r.atlandi) not("doğrulama atlandı (--dogrulama-yok)");
      else if (r.ok) ok(`Xurrent: ${r.mesaj}`);
      else { hata(`Xurrent: ${r.mesaj}`); sorun++; }
    }
  } else {
    not("mock mod — Xurrent kimlik bilgisi gerekmiyor.");
  }

  if (/eu\.xurrent/.test(e.XURRENT_GRAPHQL_URL ?? "")) {
    hata("'eu' diye bir Xurrent bölgesi YOK. Global zaten Avrupa'dır."); sorun++;
  }

  baslik("LLM");
  if (e.GEMINI_API_KEY) {
    const r = await geminiDogrula({
      anahtar: e.GEMINI_API_KEY,
      model: e.GEMINI_MODEL || "gemini-3.6-flash",
      taban: e.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
    });
    if (r.atlandi) not("doğrulama atlandı (--dogrulama-yok)");
    else if (r.ok) ok(`Gemini: ${r.mesaj}`);
    else { hata(`Gemini: ${r.mesaj}`); sorun++; }
  } else {
    not("GEMINI_API_KEY yok — chatbot sahte Gemini ile çalıştırılabilir:");
    not("  node tools/fake-gemini/server.mjs --mod zar");
  }

  baslik("Onay imzası");
  if (!e.XURRENT_STATE_SECRET) {
    uyar("XURRENT_STATE_SECRET boş — süreç başına rastgele üretilir.");
    not("Tek süreçte sorun yok. ÇOK REPLİKALI dağıtımda onay akışı sessizce kırılır");
    not("(bkz. docs/08 → D16). Sabit bir değer verin.");
  } else if (e.XURRENT_STATE_SECRET.length < 32) {
    uyar(`XURRENT_STATE_SECRET kısa (${e.XURRENT_STATE_SECRET.length} karakter). 32+ önerilir.`);
  } else ok("XURRENT_STATE_SECRET tanımlı.");

  baslik("Takvim");
  const sag = e.CALENDAR_PROVIDER || "mock";
  ok(`CALENDAR_PROVIDER=${sag}`);
  if (sag === "ics") {
    const p = path.resolve(ROOT, (e.CALENDAR_ICS_PATH || "./fixtures/calendar.ics").replace(/^\.\//, ""));
    if (!fs.existsSync(p)) { hata(`.ics bulunamadı: ${p} — 'node scripts/gen-ics.mjs' çalıştırın.`); sorun++; }
    else ok(".ics mevcut.");
  }
  if (sag === "google") {
    const t = (e.GOOGLE_TOKEN_PATH || "~/.xurrent-mcp/google-token.json").replace("~", process.env.HOME ?? "~");
    if (!fs.existsSync(t)) { hata(`Google token yok: ${t} — 'node scripts/google-auth.mjs' çalıştırın.`); sorun++; }
    else ok("Google token mevcut.");
  }

  yaz("");
  if (sorun) { hata(`${sorun} sorun bulundu.`); process.exit(1); }
  ok("Denetim temiz.");
  process.exit(0);
}

/**
 * Kullanıcı girdiyi kapattığında (Ctrl-D, boru sonu) fırlatılır.
 *
 * NEDEN gerekli: readline'ın question()'ı stdin kapanınca ÇÖZÜLMEZ ve süreç
 * "unsettled top-level await" ile asılı kalır. Boruyla besleyen ya da Ctrl-D
 * basan biri takılırdı; kurulum aracının en sinir bozucu davranışı budur.
 */
class GirdiKapandi extends Error {}

// ── etkileşimli kurulum ─────────────────────────────────────────────────────
async function kur() {
  const rl = readline.createInterface({ input, output });

  // stdin kapanırsa bekleyen soruyu ASILI BIRAKMA — reddet ve temiz çık.
  let kapandi = false;
  const kapanis = new Promise((_, red) => {
    rl.once("close", () => { kapandi = true; red(new GirdiKapandi()); });
  });
  kapanis.catch(() => {});                      // yakalanmamış reddi bastır

  /** question() ile kapanış yarışı: hangisi önce gelirse. */
  const iste = async (metin) => {
    if (kapandi) throw new GirdiKapandi();
    return Promise.race([rl.question(metin), kapanis]);
  };

  const sor = async (soru, vars = "") => {
    const c = (await iste(`  ${soru}${vars ? ` ${C.d}[${vars}]${C.x}` : ""}: `)).trim();
    return c || vars;
  };
  const evetMi = async (soru, vars = false) => {
    const c = (await iste(`  ${soru} ${C.d}(${vars ? "E/h" : "e/H"})${C.x} `)).trim().toLowerCase();
    if (!c) return vars;
    return ["e", "evet", "y", "yes"].includes(c);
  };
  const sirSor = async (soru) => {
    // Node readline maskeleme sunmuyor. En azından değeri EKRANA GERİ BASMIYORUZ
    // ve dosyayı 0600 ile yazıyoruz. Omuz sörfü riski kullanıcıya söylenir.
    const c = (await iste(`  ${soru} ${C.d}(ekranda görünür)${C.x}: `)).trim();
    return c;
  };

  yaz(`${C.b}xurrent-mcp — .env kurulumu${C.x}`);
  yaz("");
  yaz(`  ${C.g}Bu depo hiçbir şey doldurmadan çalışır.${C.x} Varsayılan mock moddur:`);
  yaz(`  token, hesap veya internet gerekmez. Sihirbaz, ders ve chatbot dahil`);
  yaz(`  her şeyi anahtarsız çalıştırabilirsiniz.`);
  yaz("");
  not("Bu sihirbaz yalnızca GERÇEK Xurrent / Gemini / takvim erişimi ekleyecekseniz gerekli.");
  yaz("");

  const mevcut = envOku(HEDEF);
  if (fs.existsSync(HEDEF)) {
    uyar(`${yol(HEDEF)} zaten var. Mevcut değerler varsayılan olarak sunulacak.`);
    const yedek = `${HEDEF}.yedek`;
    fs.copyFileSync(HEDEF, yedek);
    not(`Yedek alındı: ${yol(yedek)}`);
  }

  const v = { ...mevcut };
  const devam = await evetMi("Kuruluma devam edilsin mi? (hayır → sadece varsayılanlar yazılır)", true);

  if (!devam) {
    envYaz(HEDEF, {
      XURRENT_MODE: "mock", MCP_PROTOCOL: "2026-07-28", XURRENT_DRY_RUN: "0",
      XURRENT_CONFIRM_POLICY: "closed", XURRENT_BACKDATE_STRATEGY: "two_step",
      XURRENT_MAX_BACKDATE_DAYS: "1", CALENDAR_PROVIDER: "mock",
      XURRENT_TIMEZONE: "Europe/Istanbul", GEMINI_MODEL: "gemini-3.6-flash",
      XURRENT_STATE_SECRET: crypto.randomBytes(32).toString("base64url"),
      WEB_PORT: "8787", MCP_HTTP_PORT: "8788",
    });
    rl.close();
    yaz("");
    ok(`${yol(HEDEF)} yazıldı — tamamen mock, hemen çalışır.`);
    not("Dene: cd servers/typescript && npm run wizard");
    return;
  }

  // ── Xurrent ──
  baslik("1/5 · Xurrent");
  not("Xurrent ücretsiz değil. Hesabınız yoksa mock kalın ya da sahte sunucuyu kullanın:");
  not("  node tools/fake-xurrent/server.mjs   →   XURRENT_GRAPHQL_URL=http://127.0.0.1:4000");
  yaz("");
  const live = await evetMi("Gerçek bir Xurrent hesabına bağlanacak mısınız?", mevcut.XURRENT_MODE === "live");
  v.XURRENT_MODE = live ? "live" : "mock";

  if (live) {
    not("Token: Xurrent UI → kullanıcı menüsü → Personal Access Tokens");
    v.XURRENT_TOKEN = await sirSor("XURRENT_TOKEN") || mevcut.XURRENT_TOKEN || "";
    not("Hesap: Settings → Account Overview. SLUG'dır (örn. 'widget'), numerik DEĞİL.");
    v.XURRENT_ACCOUNT = await sor("XURRENT_ACCOUNT", mevcut.XURRENT_ACCOUNT || "");
    if (/^\d+$/.test(v.XURRENT_ACCOUNT)) uyar("Numerik girdiniz — bu büyük ihtimalle yanlış.");

    not("Bölge: global (varsayılan) · au · uk · ch · us   —   'eu' DİYE BİR BÖLGE YOK");
    const bolge = await sor("Bölge", "global");
    v.XURRENT_GRAPHQL_URL = bolge === "global"
      ? "https://graphql.xurrent.com"
      : `https://graphql.${bolge}.xurrent.com`;

    if (v.XURRENT_TOKEN && v.XURRENT_ACCOUNT) {
      yaz("");
      not("Doğrulanıyor…");
      const r = await xurrentDogrula({ token: v.XURRENT_TOKEN, hesap: v.XURRENT_ACCOUNT, url: v.XURRENT_GRAPHQL_URL });
      if (r.atlandi) not("atlandı (--dogrulama-yok)");
      else if (r.ok) ok(r.mesaj);
      else {
        hata(r.mesaj);
        if (!(await evetMi("Yine de bu değerlerle devam edilsin mi?", false))) {
          rl.close(); yaz(""); not("İptal edildi; dosya yazılmadı."); return;
        }
      }
    }

    yaz("");
    uyar("İlk bağlantıda XURRENT_DRY_RUN=1 şiddetle önerilir:");
    not("okuma sorguları gerçek çalışır, yazmalar yalnızca PLANLANIR.");
    v.XURRENT_DRY_RUN = (await evetMi("DRY_RUN açık kalsın mı?", true)) ? "1" : "0";
  } else {
    v.XURRENT_DRY_RUN = mevcut.XURRENT_DRY_RUN || "0";
  }

  // ── Gemini ──
  baslik("2/5 · LLM (Gemini)");
  not("Yalnızca terminal/web chatbot için gerekli. Sihirbaz ve atölye LLM KULLANMAZ.");
  not("Anahtarınız yoksa sahte Gemini ile uçtan uca çalışır:");
  not("  node tools/fake-gemini/server.mjs --mod zar --tohum 42");
  yaz("");
  const gem = await evetMi("Gerçek bir Gemini anahtarı gireceksiniz mi?", Boolean(mevcut.GEMINI_API_KEY));
  if (gem) {
    v.GEMINI_API_KEY = await sirSor("GEMINI_API_KEY") || mevcut.GEMINI_API_KEY || "";
    v.GEMINI_MODEL = await sor("GEMINI_MODEL", mevcut.GEMINI_MODEL || "gemini-3.6-flash");
    v.GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
    if (v.GEMINI_API_KEY) {
      yaz(""); not("Doğrulanıyor…");
      const r = await geminiDogrula({ anahtar: v.GEMINI_API_KEY, model: v.GEMINI_MODEL, taban: v.GEMINI_BASE_URL });
      if (r.atlandi) not("atlandı (--dogrulama-yok)");
      else if (r.ok) ok(r.mesaj);
      else hata(`${r.mesaj}  ${C.d}(değer yine de kaydedilecek)${C.x}`);
    }
  } else {
    v.GEMINI_MODEL = mevcut.GEMINI_MODEL || "gemini-3.6-flash";
    const sahte = await evetMi("GEMINI_BASE_URL sahte sunucuya ayarlansın mı? (127.0.0.1:5100)", false);
    v.GEMINI_BASE_URL = sahte ? "http://127.0.0.1:5100" : "https://generativelanguage.googleapis.com";
    if (sahte) v.GEMINI_API_KEY = "sahte";
  }

  // ── Takvim ──
  baslik("3/5 · Takvim");
  not("mock (kurulum yok) · ics (dosya) · google (OAuth) · graph (Azure AD)");
  v.CALENDAR_PROVIDER = await sor("CALENDAR_PROVIDER", mevcut.CALENDAR_PROVIDER || "mock");
  if (v.CALENDAR_PROVIDER === "ics") {
    v.CALENDAR_ICS_PATH = await sor("CALENDAR_ICS_PATH", mevcut.CALENDAR_ICS_PATH || "./fixtures/calendar.ics");
    not("Not: fixtures/calendar.ics üretildiği güne aittir — 'node scripts/gen-ics.mjs' ile tazeleyin.");
  }
  if (v.CALENDAR_PROVIDER === "google") {
    v.GOOGLE_CLIENT_ID = await sor("GOOGLE_CLIENT_ID", mevcut.GOOGLE_CLIENT_ID || "");
    v.GOOGLE_CLIENT_SECRET = await sirSor("GOOGLE_CLIENT_SECRET") || mevcut.GOOGLE_CLIENT_SECRET || "";
    v.GOOGLE_TOKEN_PATH = mevcut.GOOGLE_TOKEN_PATH || "~/.xurrent-mcp/google-token.json";
    v.GOOGLE_CALENDAR_ID = await sor("GOOGLE_CALENDAR_ID", mevcut.GOOGLE_CALENDAR_ID || "primary");
    not("Sonra bir kez: node scripts/google-auth.mjs");
  }
  if (v.CALENDAR_PROVIDER === "graph") {
    v.MS_TENANT_ID = await sor("MS_TENANT_ID", mevcut.MS_TENANT_ID || "");
    v.MS_CLIENT_ID = await sor("MS_CLIENT_ID", mevcut.MS_CLIENT_ID || "");
    v.MS_CLIENT_SECRET = await sirSor("MS_CLIENT_SECRET") || mevcut.MS_CLIENT_SECRET || "";
    v.MS_IMPERSONATE_USER = await sor("MS_IMPERSONATE_USER (app-only ise)", mevcut.MS_IMPERSONATE_USER || "");
    uyar("İzin 'Calendars.Read' olmalı — 'Calendars.Read.All' etkinlik OKUMAZ.");
  }

  // ── Davranış ──
  baslik("4/5 · Davranış");
  not("two_step: her şeyi korur, 2 istek · link_first: tarih bugün · date_first: ticket bağı yok");
  v.XURRENT_BACKDATE_STRATEGY = await sor("XURRENT_BACKDATE_STRATEGY", mevcut.XURRENT_BACKDATE_STRATEGY || "two_step");
  v.XURRENT_MAX_BACKDATE_DAYS = await sor("XURRENT_MAX_BACKDATE_DAYS", mevcut.XURRENT_MAX_BACKDATE_DAYS || "1");
  v.XURRENT_TIMEZONE = await sor("XURRENT_TIMEZONE", mevcut.XURRENT_TIMEZONE || "Europe/Istanbul");
  v.XURRENT_CONFIRM_POLICY = await sor("XURRENT_CONFIRM_POLICY (closed|open|strict)", mevcut.XURRENT_CONFIRM_POLICY || "closed");
  v.MCP_PROTOCOL = await sor("MCP_PROTOCOL (2026-07-28|2025-11-25)", mevcut.MCP_PROTOCOL || "2026-07-28");

  // ── Onay imzası ──
  baslik("5/5 · Onay imzası");
  not("MRTR onayı imzalı bir requestState üretir ve istemciye emanet eder.");
  not("Boş bırakılırsa süreç başına RASTGELE üretilir — çok replikalı dağıtımda");
  not("ikinci istek başka replikaya düşer, imza doğrulanamaz, onay SESSİZCE kırılır.");
  yaz("");
  if (mevcut.XURRENT_STATE_SECRET) {
    v.XURRENT_STATE_SECRET = mevcut.XURRENT_STATE_SECRET;
    ok("Mevcut değer korundu.");
  } else if (await evetMi("Rastgele bir sır üretilsin mi? (önerilir)", true)) {
    v.XURRENT_STATE_SECRET = crypto.randomBytes(32).toString("base64url");
    ok("32 baytlık sır üretildi.");
  }
  v.XURRENT_STATE_TTL = mevcut.XURRENT_STATE_TTL || "300";

  // varsayılanlar
  v.XURRENT_SOURCE = mevcut.XURRENT_SOURCE || "xurrent-mcp";
  v.ROUNDING_MODE = mevcut.ROUNDING_MODE || "nearest";
  v.DEFAULT_TIME_ALLOCATION_ID = mevcut.DEFAULT_TIME_ALLOCATION_ID || "TW9jay9UaW1lQWxsb2NhdGlvbi8x";
  v.WEB_PORT = mevcut.WEB_PORT || "8787";
  v.MCP_HTTP_PORT = mevcut.MCP_HTTP_PORT || "8788";

  rl.close();
  envYaz(HEDEF, v);

  yaz("");
  ok(`${yol(HEDEF)} yazıldı (izin 0600).`);
  not(".env .gitignore'da — commit edilmez.");
  yaz("");
  yaz(`  ${C.b}Sonraki adım:${C.x}`);
  yaz(`    node scripts/kurulum.mjs --kontrol      ${C.d}# doğrula${C.x}`);
  yaz(`    node scripts/test-all.mjs               ${C.d}# her şeyi koştur${C.x}`);
  if (v.XURRENT_MODE === "live" && v.XURRENT_DRY_RUN === "1")
    yaz(`    ${C.y}DRY_RUN=1 açık — yazmalar yalnızca planlanıyor.${C.x}`);
}

try {
  await (KONTROL ? kontrolEt() : kur());
} catch (e) {
  if (e instanceof GirdiKapandi) {
    yaz("");
    uyar("Girdi kapandı — kurulum yarıda kesildi. Hiçbir dosya yazılmadı.");
    not("Etkileşimsiz kurulum için: node scripts/kurulum.mjs --help");
    process.exit(130);                          // 128 + SIGINT geleneği
  }
  throw e;
}
