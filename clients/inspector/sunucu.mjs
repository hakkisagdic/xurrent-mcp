#!/usr/bin/env node
// -----------------------------------------------------------------------------
// clients/inspector/sunucu.mjs — uygulama içi MCP Inspector'ın arka ucu
//
// NE YAPAR
//   1. clients/inspector/ altındaki statik dosyaları servis eder (index.html,
//      style.css, app.js). CDN yok, bağımlılık yok — Node 24 standart kütüphanesi.
//   2. Seçilen MCP sunucusunu (ts | py | cs) stdio ile başlatır ve tarayıcı ile
//      sunucu arasında bir JSON-RPC proxy'si olur.
//   3. HER istek ve HER cevabın HAM JSON-RPC'sini saklar ve döner. Ekranda
//      gösterilecek olan budur: bu araç "teli görmek" için vardır.
//
// NEDEN RESMÎ INSPECTOR YETMİYOR
//   @modelcontextprotocol/inspector genel amaçlıdır ve iyidir. Ama bizim
//   sözleşmemizi (contract/tools.json) bilmez, teachingNotes alanlarını
//   göstermez, iki protokol revizyonunu yan yana çalıştırmaz ve MRTR akışını
//   adım adım çizmez. Bu araç tam olarak o dört boşluğu doldurur.
//   Karşılaştırma tablosu: docs/13-inspector.md
//
// GÜVENLİK
//   - Varsayılan olarak yalnızca 127.0.0.1'e bağlanır (--host ile değiştirilebilir).
//   - Tarayıcıdan gelen "dil" değeri sabit bir ALLOWLIST'tir; keyfi komut
//     çalıştırılamaz. (Bir inspector'ın en kolay güvenlik hatası budur.)
//   - Statik dosya servisinde de allowlist vardır; path traversal imkânsızdır.
//
// KULLANIM
//   node clients/inspector/sunucu.mjs --port 5200
//   node clients/inspector/sunucu.mjs --port 5200 --host 0.0.0.0   (dikkat!)
//
// UÇLAR
//   GET  /                  → index.html
//   GET  /api/sunucular     → sunucu tanımları + hazır mı + protokol seçenekleri
//   GET  /api/sozlesme      → contract/tools.json (tarayıcı canlı doğrulama yapar)
//   POST /api/baglan        → {dil, protokol} — sunucuyu başlat, sonda at, tools/list
//   POST /api/cagir         → {metod, params} — ham JSON-RPC isteği ilet
//   POST /api/yanitla       → {id, sonuc, bekleId} — v1'de sunucunun SORDUĞU isteğe cevap
//   POST /api/karsilastir   → {dil, tool, args} — aynı tool'u İKİ revizyonla çalıştır
//   GET  /api/kayit         → o ana kadarki tüm ham JSON-RPC trafiği
//   GET  /api/kopar         → oturumu kapat
// -----------------------------------------------------------------------------

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// ── Argümanlar ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(name + "="));
  return inline ? inline.slice(name.length + 1) : fallback;
}

if (has("--help") || has("-h")) {
  process.stdout.write(
    [
      "",
      "xurrent-mcp — uygulama içi MCP Inspector",
      "",
      "KULLANIM",
      "  node clients/inspector/sunucu.mjs [--port 5200] [--host 127.0.0.1]",
      "",
      "SEÇENEKLER",
      "  --port <n>    Dinlenecek port (varsayılan 5200)",
      "  --host <h>    Dinlenecek adres (varsayılan 127.0.0.1)",
      "  --open        Tarayıcıyı aç (macOS/Linux)",
      "  -h, --help    Bu yardım",
      "",
      "NE İŞE YARAR",
      "  Resmî inspector'ın göstermediklerini gösterir: protokol pazarlığının HAM",
      "  sondası, contract/tools.json'a karşı CANLI sözleşme doğrulaması, sözleşmedeki",
      "  teachingNotes, şemadan üretilmiş form, cevabın parça parça anatomisi ve",
      "  MRTR onay akışının adım adım çizimi.",
      "",
      "  Ayrıntı: docs/13-inspector.md",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const PORT = Number(opt("--port", 5200));
const HOST = String(opt("--host", "127.0.0.1"));

// ── Sunucu tanımları — ALLOWLIST ────────────────────────────────────────────
// .mcp.json, wizard.mjs ve verify-contract.mjs ile birebir aynı komutlar.
// Tarayıcı yalnızca bu anahtarlardan birini seçebilir; komutu KENDİSİ veremez.
const SERVERS = {
  ts: {
    etiket: "TypeScript",
    command: "node",
    args: [path.join(ROOT, "servers", "typescript", "dist", "mcp", "stdio.js")],
    hazirlikIpucu: "cd servers/typescript && npm install && npm run build",
    // Bu dosya yoksa sunucu derlenmemiştir.
    kanit: path.join(ROOT, "servers", "typescript", "dist", "mcp", "stdio.js"),
    baslangicTimeoutMs: 60000,
    sdk: "@modelcontextprotocol/sdk 1.30.0 (v1) + @modelcontextprotocol/{core,server} 2.0.0 (v2)",
  },
  py: {
    etiket: "Python",
    command: "uv",
    args: ["--directory", path.join(ROOT, "servers", "python"), "run", "xurrent-mcp"],
    hazirlikIpucu: "cd servers/python && uv sync",
    kanit: path.join(ROOT, "servers", "python", "pyproject.toml"),
    baslangicTimeoutMs: 120000,
    sdk: "mcp 2.0.0",
  },
  cs: {
    etiket: "C#",
    command: "dotnet",
    args: ["run", "--project", path.join(ROOT, "servers", "csharp", "XurrentMcp.csproj"), "--no-build", "--", "stdio"],
    hazirlikIpucu: "cd servers/csharp && dotnet build",
    kanit: path.join(ROOT, "servers", "csharp", "XurrentMcp.csproj"),
    baslangicTimeoutMs: 180000,
    sdk: "ModelContextProtocol 2.0.0",
  },
};

const PROTOKOLLER = [
  {
    kod: "2026-07-28",
    etiket: "v2 — 2026-07-28",
    aciklama: "El sıkışma YOK. Keşif server/discover ile. Onay: InputRequiredResult (MRTR).",
  },
  {
    kod: "2025-11-25",
    etiket: "v1 — 2025-11-25",
    aciklama: "initialize el sıkışması. Onay: sunucu-başlatmalı elicitation/create isteği.",
  },
];

// ── Protokol sabitleri ──────────────────────────────────────────────────────
const V2_FROM = "2026-07-28";
const V1_VERSION = "2025-11-25";
const META_PROTOCOL = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_INFO = "io.modelcontextprotocol/clientInfo";
const CLIENT_INFO = { name: "xurrent-inspector", version: "1.0.0" };
const CLIENT_CAPS = { elicitation: {} };

const RPC = {
  METHOD_NOT_FOUND: -32601, // "bu RPC yok" → sunucu v2 konuşmuyor
  INVALID_PARAMS: -32602, // "_meta eksik/bozuk" → İSTEMCİ hatası
  UNSUPPORTED_PROTOCOL_VERSION: -32022, // v2 konuşuyor ama BU sürümü değil
  MISSING_CLIENT_CAPABILITY: -32021,
};

const isV2 = (p) => String(p) >= V2_FROM;

// v2'de el sıkışma YOKTUR: sürüm, yetenek ve kimlik HER İSTEKTE taşınır.
// Bu üçünden biri eksikse resmî SDK 2.0.0 sunucuları isteği REDDEDER ve hata
// mesajı YANILTICI olur (python -32601, C# -32602). Ölçülmüş bir gerçektir.
const v2Meta = (protokol) => ({
  [META_PROTOCOL]: protokol,
  [META_CAPS]: CLIENT_CAPS,
  [META_INFO]: CLIENT_INFO,
});

// ── Sözleşme ────────────────────────────────────────────────────────────────
const CONTRACT_FILE = path.join(ROOT, "contract", "tools.json");
function sozlesmeOku() {
  return JSON.parse(readFileSync(CONTRACT_FILE, "utf8"));
}

// ── Çocuk süreç ortamı ───────────────────────────────────────────────────────
// .env okunmaz: inspector KASITLI olarak mock modda çalışır. Canlı bir Xurrent
// hesabına yazan bir "inceleme aracı" ders ortamında olmamalıdır.
function cocukEnv(protokol) {
  return {
    ...process.env,
    XURRENT_MODE: process.env.XURRENT_MODE ?? "mock",
    CALENDAR_PROVIDER: process.env.CALENDAR_PROVIDER ?? "mock",
    XURRENT_TIMEZONE: process.env.XURRENT_TIMEZONE ?? "Europe/Istanbul",
    XURRENT_FIXTURES_DIR: process.env.XURRENT_FIXTURES_DIR ?? path.join(ROOT, "fixtures"),
    XURRENT_BACKDATE_STRATEGY: process.env.XURRENT_BACKDATE_STRATEGY ?? "two_step",
    MCP_PROTOCOL: protokol,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// OTURUM — tek bir MCP sunucusuna açık stdio bağlantısı
//
// Aynı anda TEK oturum tutulur. Sebebi ders aracı olması: ekranda "hangi
// sunucuya bağlıyım" sorusunun tek bir cevabı olmalı.
// ═════════════════════════════════════════════════════════════════════════════
let oturum = null;

function kayitEkle(o, yon, tur, ham, not = null) {
  const kayit = {
    sira: o.kayit.length + 1,
    yon, // "→" istemciden sunucuya · "←" sunucudan istemciye
    tur, // istek | yanit | bildirim | sunucu-istegi | sunucu-yaniti | cop
    zaman: new Date().toISOString(),
    ham,
    not,
  };
  o.kayit.push(kayit);
  // Bellek koruması: ders oturumunda 2000 mesajı geçmesi beklenmez.
  if (o.kayit.length > 2000) o.kayit.splice(0, o.kayit.length - 2000);
  return kayit;
}

function oturumBaslat(dil, protokol) {
  const srv = SERVERS[dil];
  const child = spawn(srv.command, srv.args, {
    cwd: ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env: cocukEnv(protokol),
  });

  const o = {
    id: crypto.randomUUID(),
    dil,
    protokol,
    mod: isV2(protokol) ? "v2" : "v1", // KONUŞULAN revizyon (sonda sonrası netleşir)
    child,
    nextId: 1,
    kayit: [], // ham JSON-RPC trafiği
    stderr: [], // sunucunun stderr'i: stdio'da log BURAYA akmak zorundadır
    cevaplar: new Map(), // gelmiş ama beklenmemiş cevaplar
    cevapBekleyen: new Map(), // id -> cb
    sunucuIstekleri: [], // sunucunun bize sorduğu, henüz cevaplanmamış istekler (v1)
    sunucuIstegiBekleyen: [], // cb listesi
    copSatirlar: [], // stdout'a düşen JSON OLMAYAN satırlar → protokol ihlali
    baslangic: Date.now(),
    kapandi: false,
    cikisKodu: null,
    serverInfo: null,
    supportedVersions: [],
    sonda: null,
    baslangicHatasi: null,
  };

  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const satir = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!satir) continue;
      let msg;
      try {
        msg = JSON.parse(satir);
      } catch {
        // stdio transport'ta stdout SADECE JSON-RPC içindir. Buraya düşen her
        // satır protokol ihlalidir ve ekranda KIRMIZI gösterilir.
        o.copSatirlar.push(satir.slice(0, 400));
        kayitEkle(o, "←", "cop", { _copSatir: satir.slice(0, 400) }, "stdout'a JSON olmayan satır düştü — stdio transport ihlali");
        continue;
      }
      gelenMesaj(o, msg);
    }
  });

  child.stderr.on("data", (d) => {
    for (const l of d.toString().split("\n")) {
      if (l.trim()) o.stderr.push(l);
    }
    if (o.stderr.length > 500) o.stderr.splice(0, o.stderr.length - 500);
  });

  child.on("error", (err) => {
    o.baslangicHatasi = `Başlatılamadı: ${err.message}`;
    o.kapandi = true;
  });
  child.on("exit", (code, sig) => {
    o.kapandi = true;
    o.cikisKodu = code ?? sig ?? null;
    // Bekleyen herkesi serbest bırak; aksi hâlde tarayıcı timeout'a kadar bekler.
    for (const [, cb] of o.cevapBekleyen) cb({ _sureçKapandi: true, kod: o.cikisKodu });
    o.cevapBekleyen.clear();
  });

  return o;
}

function gelenMesaj(o, msg) {
  // 1) Sunucudan gelen İSTEK (yalnızca v1'de olur: elicitation/create)
  if (msg.method && msg.id !== undefined) {
    kayitEkle(o, "←", "sunucu-istegi", msg, "Sunucu bize bir JSON-RPC İSTEĞİ gönderdi — v1'in onay yolu budur.");
    o.sunucuIstekleri.push(msg);
    const bekleyenler = o.sunucuIstegiBekleyen.splice(0);
    for (const cb of bekleyenler) cb(msg);
    return;
  }
  // 2) Bildirim (id yok)
  if (msg.method) {
    kayitEkle(o, "←", "bildirim", msg);
    return;
  }
  // 3) Bizim isteğimizin cevabı
  kayitEkle(o, "←", "yanit", msg);
  if (o.cevapBekleyen.has(msg.id)) {
    const cb = o.cevapBekleyen.get(msg.id);
    o.cevapBekleyen.delete(msg.id);
    cb(msg);
  } else {
    o.cevaplar.set(msg.id, msg);
  }
}

function gonder(o, mesaj, not = null) {
  kayitEkle(o, "→", mesaj.method ? (mesaj.id === undefined ? "bildirim" : "istek") : "sunucu-yaniti", mesaj, not);
  try {
    o.child.stdin.write(JSON.stringify(mesaj) + "\n");
  } catch (e) {
    /* süreç kapandıysa exit handler zaten temizler */
  }
}

/**
 * Bir cevabı bekler. AMA arada sunucu bize bir İSTEK gönderirse (v1 elicitation)
 * onu döner — çünkü o istek cevaplanmadan bizim cevabımız asla gelmez.
 * Deadlock'un ders hâli budur: sunucu bizden cevap bekliyor, biz sunucudan.
 */
function bekle(o, id, timeoutMs) {
  return new Promise((resolve) => {
    let bitti = false;
    let temizle = () => {};
    const fin = (v) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(timer);
      temizle();
      resolve(v);
    };

    // Cevaplanmamış bir sunucu isteği zaten kuyruktaysa önce onu göster.
    if (o.sunucuIstekleri.length) {
      return fin({ tur: "sunucu-istegi", sunucuIstegi: o.sunucuIstekleri[0], bekleId: id });
    }
    if (o.cevaplar.has(id)) {
      const m = o.cevaplar.get(id);
      o.cevaplar.delete(id);
      return fin({ tur: "yanit", cevap: m });
    }

    const cevapCb = (m) => {
      if (m?._sureçKapandi) return fin({ tur: "hata", hata: `Sunucu süreci kapandı (kod ${m.kod}).` });
      fin({ tur: "yanit", cevap: m });
    };
    const istekCb = (req) => fin({ tur: "sunucu-istegi", sunucuIstegi: req, bekleId: id });

    o.cevapBekleyen.set(id, cevapCb);
    o.sunucuIstegiBekleyen.push(istekCb);
    temizle = () => {
      if (o.cevapBekleyen.get(id) === cevapCb) o.cevapBekleyen.delete(id);
      const i = o.sunucuIstegiBekleyen.indexOf(istekCb);
      if (i >= 0) o.sunucuIstegiBekleyen.splice(i, 1);
    };

    var timer = setTimeout(() => fin({ tur: "hata", hata: `Zaman aşımı (${timeoutMs} ms) — sunucu yanıt vermedi.` }), timeoutMs);
  });
}

/** İstek gönderir ve cevabı (veya araya giren sunucu isteğini) bekler. */
async function istekYap(o, metod, params, timeoutMs = 60000) {
  const id = o.nextId++;
  // v2'de _meta İSTİSNASIZ her isteğe eklenir. Bir tanesinde unutmak o isteği
  // reddettirir; ekranda bu blok her zaman görünür olsun diye burada üretiyoruz.
  const p = o.mod === "v2" ? { ...(params ?? {}), _meta: v2Meta(o.protokol) } : (params ?? {});
  const mesaj = { jsonrpc: "2.0", id, method: metod, params: p };
  const t0 = Date.now();
  gonder(o, mesaj, o.mod === "v2" ? "v2: _meta bloğu HER isteğe eklenir (el sıkışma yoktur)." : null);
  const sonuc = await bekle(o, id, timeoutMs);
  return { ...sonuc, istek: mesaj, sureMs: Date.now() - t0 };
}

function oturumKapat() {
  if (!oturum) return null;
  const ozet = {
    id: oturum.id,
    dil: oturum.dil,
    protokol: oturum.protokol,
    mod: oturum.mod,
    mesajSayisi: oturum.kayit.length,
    sureMs: Date.now() - oturum.baslangic,
    stderrSonSatirlar: oturum.stderr.slice(-20),
    copSatirlar: oturum.copSatirlar,
  };
  try {
    oturum.child.kill("SIGTERM");
  } catch {
    /* zaten ölmüş */
  }
  oturum = null;
  return ozet;
}

// ═════════════════════════════════════════════════════════════════════════════
// SONDA — hangi revizyon konuşuluyor, NASIL anlaşıldı
//
// Spec'in önerdiği akış (contract/protocol.md §Seçim ve pazarlık):
//   server/discover (_meta İLE) gönder
//     ├─ başarılı                    → v2. supportedVersions'a bak
//     ├─ -32601 Method not found     → v1. initialize el sıkışmasına DÜŞ
//     └─ -32602 / -32021 metadata    → İSTEMCİ hatası. v1'e DÜŞÜLMEZ.
//
// Son madde bu repoda gerçekten yaşanmış bir hatadır: -32602'yi "v1'e düş" diye
// yorumlayan bir sonda, v2 konuşan sunucuyu ömür boyu v1 sanar.
// ═════════════════════════════════════════════════════════════════════════════
async function sondaAt(o, timeoutMs) {
  const adimlar = [];

  if (o.mod === "v2") {
    const d = await istekYap(o, "server/discover", {}, timeoutMs);
    if (d.tur === "hata") {
      return { ok: false, hata: d.hata, adimlar };
    }
    adimlar.push({
      baslik: "1. server/discover (zorunlu _meta ile)",
      istek: d.istek,
      cevap: d.cevap,
      sureMs: d.sureMs,
    });

    if (!d.cevap.error) {
      const r = d.cevap.result ?? {};
      o.serverInfo = r.serverInfo ?? r._meta?.["io.modelcontextprotocol/serverInfo"] ?? null;
      o.supportedVersions = r.supportedVersions ?? [];
      return {
        ok: true,
        konusulan: "v2",
        yontem: "server/discover",
        supportedVersions: o.supportedVersions,
        serverInfo: o.serverInfo,
        instructions: r.instructions ?? null,
        capabilities: r.capabilities ?? null,
        cacheHint: { ttlMs: r.ttlMs ?? null, cacheScope: r.cacheScope ?? null },
        yorum:
          "server/discover KABUL EDİLDİ. El sıkışma yapılmadı; sunucu kimliğini sonucun " +
          "_meta.io.modelcontextprotocol/serverInfo alanında bildirdi. Bundan sonraki HER istekte " +
          "_meta bloğu tekrar gönderilecek.",
        adimlar,
      };
    }

    const kod = d.cevap.error.code;
    if (kod === RPC.INVALID_PARAMS || kod === RPC.MISSING_CLIENT_CAPABILITY) {
      return {
        ok: false,
        istemciHatasi: true,
        konusulan: null,
        yorum:
          `Sunucu ${kod} döndü ("${d.cevap.error.message}"). Bu BİZİM hatamızdır: server/discover metodu VAR, ` +
          "eksik olan _meta bloğudur. v1'e DÜŞÜLMEZ — düşersek v2 konuşan bir sunucuyu v1 sanarız.",
        adimlar,
      };
    }
    if (kod === RPC.UNSUPPORTED_PROTOCOL_VERSION) {
      return {
        ok: false,
        konusulan: null,
        yorum: `Sunucu v2 konuşuyor ama ${o.protokol} sürümünü desteklemiyor (${kod}: ${d.cevap.error.message}).`,
        adimlar,
      };
    }
    if (kod !== RPC.METHOD_NOT_FOUND) {
      return { ok: false, konusulan: null, yorum: `Beklenmeyen hata (${kod}: ${d.cevap.error.message}).`, adimlar };
    }

    // -32601 → sunucu v2 konuşmuyor. v1'e düş.
    o.mod = "v1";
  }

  const init = await istekYap(o, "initialize", {
    protocolVersion: o.mod === "v1" && !isV2(o.protokol) ? o.protokol : V1_VERSION,
    capabilities: CLIENT_CAPS,
    clientInfo: CLIENT_INFO,
  }, timeoutMs);

  if (init.tur === "hata") return { ok: false, hata: init.hata, adimlar };
  adimlar.push({
    baslik: adimlar.length ? "2. initialize (v2 reddedildi, v1'e düşüldü)" : "1. initialize (el sıkışması)",
    istek: init.istek,
    cevap: init.cevap,
    sureMs: init.sureMs,
  });

  if (init.cevap.error) {
    return {
      ok: false,
      konusulan: null,
      yorum: `initialize da reddedildi (${init.cevap.error.code}: ${init.cevap.error.message}).`,
      adimlar,
    };
  }

  const r = init.cevap.result ?? {};
  o.serverInfo = r.serverInfo ?? null;
  o.supportedVersions = r.protocolVersion ? [r.protocolVersion] : [];
  gonder(o, { jsonrpc: "2.0", method: "notifications/initialized" }, "El sıkışmanın üçüncü ayağı: bildirim, cevabı yoktur.");
  adimlar.push({
    baslik: `${adimlar.length + 1}. notifications/initialized (bildirim — cevabı yoktur)`,
    istek: { jsonrpc: "2.0", method: "notifications/initialized" },
    cevap: null,
  });

  return {
    ok: true,
    konusulan: "v1",
    yontem: "initialize",
    supportedVersions: o.supportedVersions,
    serverInfo: o.serverInfo,
    instructions: r.instructions ?? null,
    capabilities: r.capabilities ?? null,
    cacheHint: { ttlMs: null, cacheScope: null },
    yorum:
      "initialize el sıkışması tamamlandı. Sürüm ve yetenekler BİR KEZ bildirildi; bundan sonraki isteklerde " +
      "_meta bloğu gönderilmez. Sunucu kimliği initialize sonucunun serverInfo alanındadır.",
    adimlar,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// TEK SEFERLİK ÇAĞRI — protokol karşılaştırması için
//
// Ayrı ve KISA ÖMÜRLÜ bir süreçte çalışır. Sebebi ölçülmüş bir gerçektir:
// initialize yapılmış bir bağlantıya v2 zarflı istek göndermek reddedilir
// ("this connection serves the handshake protocol era"). Yani iki revizyon
// AYNI bağlantı üzerinde denenemez — iki süreç şarttır.
// ═════════════════════════════════════════════════════════════════════════════
function tekSeferlikCagri({ dil, protokol, tool, args, otoOnay = true, timeoutMs = 90000 }) {
  return new Promise((resolve) => {
    const srv = SERVERS[dil];
    const child = spawn(srv.command, srv.args, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], env: cocukEnv(protokol) });

    const tel = []; // ham trafik
    const pending = new Map();
    let nextId = 1;
    let buf = "";
    let stderr = "";
    let bitti = false;
    let onayAkisi = "onay istenmedi";
    let turSayisi = 1;

    const fin = (r) => {
      if (bitti) return;
      bitti = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* zaten kapandı */
      }
      resolve({ protokol, tel, onayAkisi, turSayisi, stderr: stderr.trim().split("\n").slice(-8).join("\n"), ...r });
    };
    const timer = setTimeout(() => fin({ ok: false, hata: `Zaman aşımı (${timeoutMs} ms)` }), timeoutMs);

    child.on("error", (e) => fin({ ok: false, hata: `Başlatılamadı: ${e.message}` }));
    child.on("exit", (code) => {
      if (!bitti) fin({ ok: false, hata: `Süreç kapandı (kod ${code}).` });
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const send = (m, not) => {
      tel.push({ yon: "→", tur: m.method ? (m.id === undefined ? "bildirim" : "istek") : "sunucu-yaniti", ham: m, not: not ?? null });
      child.stdin.write(JSON.stringify(m) + "\n");
    };
    const request = (metod, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        const p = isV2(protokol) ? { ...(params ?? {}), _meta: v2Meta(protokol) } : (params ?? {});
        send({ jsonrpc: "2.0", id, method: metod, params: p });
      });

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const satir = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!satir) continue;
        let msg;
        try {
          msg = JSON.parse(satir);
        } catch {
          tel.push({ yon: "←", tur: "cop", ham: { _copSatir: satir.slice(0, 300) } });
          continue;
        }
        if (msg.method && msg.id !== undefined) {
          tel.push({ yon: "←", tur: "sunucu-istegi", ham: msg, not: "v1: sunucu KULLANICIYA SORMAK için bize istek gönderdi." });
          if (msg.method === "elicitation/create") {
            onayAkisi = "v1 — sunucu→client İSTEĞİ (elicitation/create)";
            const content = {};
            for (const [k, spec] of Object.entries(msg.params?.requestedSchema?.properties ?? {})) {
              if (Array.isArray(spec?.enum)) content[k] = spec.enum[0];
              else if (spec?.type === "boolean") content[k] = true;
              else content[k] = spec?.default ?? "";
            }
            send({ jsonrpc: "2.0", id: msg.id, result: otoOnay ? { action: "accept", content } : { action: "decline" } });
          } else {
            send({ jsonrpc: "2.0", id: msg.id, error: { code: RPC.METHOD_NOT_FOUND, message: "desteklenmiyor" } });
          }
          continue;
        }
        if (msg.method) {
          tel.push({ yon: "←", tur: "bildirim", ham: msg });
          continue;
        }
        tel.push({ yon: "←", tur: "yanit", ham: msg });
        if (pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });

    (async () => {
      let elSikisma;
      if (isV2(protokol)) {
        const disc = await request("server/discover", {});
        if (disc.error) {
          return fin({
            ok: false,
            elSikisma: "server/discover reddedildi",
            hata: `${disc.error.code}: ${disc.error.message}`,
          });
        }
        elSikisma = "server/discover — EL SIKIŞMA YOK, _meta her istekte";
      } else {
        const init = await request("initialize", {
          protocolVersion: protokol,
          capabilities: CLIENT_CAPS,
          clientInfo: CLIENT_INFO,
        });
        if (init.error) {
          return fin({ ok: false, elSikisma: "initialize reddedildi", hata: `${init.error.code}: ${init.error.message}` });
        }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        elSikisma = `initialize → notifications/initialized (${init.result?.protocolVersion ?? "?"})`;
      }

      const baseParams = { name: tool, arguments: args ?? {} };
      let res = await request("tools/call", baseParams);
      if (res.error) return fin({ ok: false, elSikisma, hata: `${res.error.code}: ${res.error.message}` });

      // v2 MRTR: "input_required" bir HATA değil, bir SONUÇ türüdür.
      while (res.result?.resultType === "input_required" && turSayisi < 4) {
        onayAkisi = "v2 — InputRequiredResult + isteğin YENİ id ile tekrarı (MRTR)";
        if (!otoOnay) return fin({ ok: true, elSikisma, sonuc: res.result, reddedildi: true });
        const inputResponses = {};
        for (const [key, req] of Object.entries(res.result.inputRequests ?? {})) {
          // ★ DİKKAT: şema req.params.requestedSchema altındadır, req.requestedSchema DEĞİL.
          //   InputRequest zarfı {method, params:{message, requestedSchema, mode}} biçimindedir.
          const sema = req?.params?.requestedSchema ?? req?.requestedSchema ?? {};
          const content = {};
          for (const [k, spec] of Object.entries(sema.properties ?? {})) {
            if (Array.isArray(spec?.enum)) content[k] = spec.enum[0];
            else if (spec?.type === "boolean") content[k] = true;
            else content[k] = spec?.default ?? "";
          }
          inputResponses[key] = { action: "accept", content };
        }
        res = await request("tools/call", { ...baseParams, inputResponses, requestState: res.result.requestState });
        turSayisi++;
        if (res.error) return fin({ ok: false, elSikisma, hata: `${res.error.code}: ${res.error.message}` });
      }

      fin({ ok: true, elSikisma, sonuc: res.result });
    })().catch((e) => fin({ ok: false, hata: String(e?.message ?? e) }));
  });
}

/** Karşılaştırma için kararlı (anahtarları sıralı) JSON. */
function kanonik(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(kanonik).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + kanonik(v[k])).join(",") + "}";
}

// ═════════════════════════════════════════════════════════════════════════════
// HTTP
// ═════════════════════════════════════════════════════════════════════════════
const STATIK = {
  "/": { dosya: "index.html", tip: "text/html; charset=utf-8" },
  "/index.html": { dosya: "index.html", tip: "text/html; charset=utf-8" },
  "/style.css": { dosya: "style.css", tip: "text/css; charset=utf-8" },
  "/app.js": { dosya: "app.js", tip: "text/javascript; charset=utf-8" },
};

function json(res, kod, govde) {
  const g = JSON.stringify(govde);
  res.writeHead(kod, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(g),
  });
  res.end(g);
}

function govdeOku(req, maxBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const parcalar = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > maxBytes) {
        reject(new Error("Gövde çok büyük"));
        req.destroy();
        return;
      }
      parcalar.push(c);
    });
    req.on("end", () => {
      const s = Buffer.concat(parcalar).toString("utf8");
      if (!s.trim()) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch (e) {
        reject(new Error("Gövde geçerli JSON değil"));
      }
    });
    req.on("error", reject);
  });
}

function oturumOzeti() {
  if (!oturum) return null;
  return {
    id: oturum.id,
    dil: oturum.dil,
    etiket: SERVERS[oturum.dil]?.etiket ?? oturum.dil,
    protokol: oturum.protokol,
    mod: oturum.mod,
    serverInfo: oturum.serverInfo,
    supportedVersions: oturum.supportedVersions,
    kapandi: oturum.kapandi,
    mesajSayisi: oturum.kayit.length,
    bekleyenSunucuIstegi: oturum.sunucuIstekleri.length,
    copSatirlar: oturum.copSatirlar,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const yol = url.pathname;

  // Tarayıcı aynı origin'den konuşur; CORS'a gerek yok. Yine de basit koruma:
  res.setHeader("x-content-type-options", "nosniff");

  try {
    // ── Statik ───────────────────────────────────────────────────────────────
    if (req.method === "GET" && STATIK[yol]) {
      const { dosya, tip } = STATIK[yol];
      const tam = path.join(__dirname, dosya);
      if (!existsSync(tam)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        return res.end(`Bulunamadı: ${dosya}`);
      }
      const govde = readFileSync(tam);
      res.writeHead(200, { "content-type": tip, "cache-control": "no-store", "content-length": govde.length });
      return res.end(govde);
    }

    // ── GET /api/sunucular ───────────────────────────────────────────────────
    if (req.method === "GET" && yol === "/api/sunucular") {
      const sozlesme = sozlesmeOku();
      return json(res, 200, {
        sunucular: Object.entries(SERVERS).map(([kod, s]) => ({
          kod,
          etiket: s.etiket,
          komut: [s.command, ...s.args.map((a) => a.replace(ROOT + path.sep, ""))].join(" "),
          sdk: s.sdk,
          hazir: existsSync(s.kanit),
          hazirlikIpucu: s.hazirlikIpucu,
          baslangicTimeoutMs: s.baslangicTimeoutMs,
        })),
        protokoller: PROTOKOLLER,
        sozlesme: {
          surum: sozlesme.contractVersion ?? null,
          baslik: sozlesme.title ?? null,
          toolSayisi: (sozlesme.tools ?? []).length,
          sira: (sozlesme.tools ?? []).map((t) => t.name),
        },
        mod: cocukEnv("2026-07-28").XURRENT_MODE,
        aktifOturum: oturumOzeti(),
      });
    }

    // ── GET /api/sozlesme ────────────────────────────────────────────────────
    if (req.method === "GET" && yol === "/api/sozlesme") {
      return json(res, 200, sozlesmeOku());
    }

    // ── POST /api/baglan ─────────────────────────────────────────────────────
    if (req.method === "POST" && yol === "/api/baglan") {
      const g = await govdeOku(req);
      const dil = String(g.dil ?? "");
      const protokol = String(g.protokol ?? V2_FROM);
      if (!SERVERS[dil]) {
        return json(res, 400, { hata: `Bilinmeyen dil "${dil}". Geçerli: ${Object.keys(SERVERS).join(", ")}` });
      }
      if (!PROTOKOLLER.some((p) => p.kod === protokol)) {
        return json(res, 400, { hata: `Bilinmeyen protokol "${protokol}".` });
      }
      if (!existsSync(SERVERS[dil].kanit)) {
        return json(res, 409, {
          hata: `${SERVERS[dil].etiket} sunucusu hazır değil.`,
          ipucu: SERVERS[dil].hazirlikIpucu,
        });
      }

      oturumKapat();
      oturum = oturumBaslat(dil, protokol);
      const timeoutMs = SERVERS[dil].baslangicTimeoutMs;

      const sonda = await sondaAt(oturum, timeoutMs);
      oturum.sonda = sonda;
      if (!sonda.ok) {
        const kayit = oturum.kayit.slice();
        const stderr = oturum.stderr.slice(-25);
        oturumKapat();
        return json(res, 502, { hata: sonda.yorum ?? sonda.hata ?? "Bağlanılamadı.", sonda, kayit, stderr });
      }

      const liste = await istekYap(oturum, "tools/list", {}, timeoutMs);
      if (liste.tur !== "yanit" || liste.cevap.error) {
        return json(res, 502, {
          hata: `tools/list başarısız: ${liste.hata ?? liste.cevap?.error?.message ?? "?"}`,
          sonda,
          kayit: oturum.kayit,
        });
      }

      return json(res, 200, {
        oturum: oturumOzeti(),
        sonda,
        toolsList: { istek: liste.istek, cevap: liste.cevap, sureMs: liste.sureMs },
        kayit: oturum.kayit,
        stderr: oturum.stderr.slice(-25),
      });
    }

    // ── POST /api/cagir ──────────────────────────────────────────────────────
    if (req.method === "POST" && yol === "/api/cagir") {
      const g = await govdeOku(req);
      if (!oturum || oturum.kapandi) return json(res, 409, { hata: "Açık oturum yok. Önce /api/baglan çağırın." });
      const metod = String(g.metod ?? "");
      if (!metod) return json(res, 400, { hata: "metod zorunludur." });
      const timeoutMs = Number(g.timeoutMs ?? 60000);

      const r = await istekYap(oturum, metod, g.params ?? {}, timeoutMs);
      return json(res, 200, {
        tur: r.tur, // yanit | sunucu-istegi | hata
        istek: r.istek,
        cevap: r.cevap ?? null,
        sunucuIstegi: r.sunucuIstegi ?? null,
        bekleId: r.bekleId ?? null,
        hata: r.hata ?? null,
        sureMs: r.sureMs,
        oturum: oturumOzeti(),
        stderr: oturum.stderr.slice(-10),
      });
    }

    // ── POST /api/yanitla ────────────────────────────────────────────────────
    // v1'de sunucu bize elicitation/create İSTEĞİ gönderir. O istek cevaplanmadan
    // tools/call cevabı ASLA gelmez. Bu uç, cevabı gönderip asıl cevabı bekler.
    if (req.method === "POST" && yol === "/api/yanitla") {
      const g = await govdeOku(req);
      if (!oturum || oturum.kapandi) return json(res, 409, { hata: "Açık oturum yok." });
      const id = g.id;
      const idx = oturum.sunucuIstekleri.findIndex((r) => r.id === id);
      if (idx < 0) return json(res, 409, { hata: `Bekleyen sunucu isteği bulunamadı (id=${JSON.stringify(id)}).` });
      oturum.sunucuIstekleri.splice(idx, 1);

      const cevap = g.hata
        ? { jsonrpc: "2.0", id, error: g.hata }
        : { jsonrpc: "2.0", id, result: g.sonuc ?? { action: "decline" } };
      gonder(oturum, cevap, "v1: sunucunun SORDUĞU isteğe cevabımız. Bu cevap gitmeden tools/call cevabı gelmez.");

      const bekleId = g.bekleId;
      if (bekleId === undefined || bekleId === null) {
        return json(res, 200, { tur: "gonderildi", oturum: oturumOzeti(), kayit: oturum.kayit.slice(-6) });
      }
      const r = await bekle(oturum, bekleId, Number(g.timeoutMs ?? 60000));
      return json(res, 200, {
        tur: r.tur,
        cevap: r.cevap ?? null,
        sunucuIstegi: r.sunucuIstegi ?? null,
        bekleId: r.bekleId ?? null,
        hata: r.hata ?? null,
        oturum: oturumOzeti(),
        stderr: oturum.stderr.slice(-10),
      });
    }

    // ── POST /api/karsilastir ────────────────────────────────────────────────
    // AYNI tool'u İKİ revizyonla, İKİ ayrı süreçte çalıştırır.
    if (req.method === "POST" && yol === "/api/karsilastir") {
      const g = await govdeOku(req);
      const dil = String(g.dil ?? "");
      if (!SERVERS[dil]) return json(res, 400, { hata: `Bilinmeyen dil "${dil}".` });
      if (!existsSync(SERVERS[dil].kanit)) {
        return json(res, 409, { hata: `${SERVERS[dil].etiket} sunucusu hazır değil.`, ipucu: SERVERS[dil].hazirlikIpucu });
      }
      const tool = String(g.tool ?? "xurrent_whoami");
      const args = g.args ?? {};
      const otoOnay = g.otoOnay !== false;
      const timeoutMs = Number(g.timeoutMs ?? SERVERS[dil].baslangicTimeoutMs);

      // Sıralı çalıştırılır: iki dotnet/uv sürecini aynı anda başlatmak yavaş
      // makinelerde zaman aşımına yol açıyor.
      const v2 = await tekSeferlikCagri({ dil, protokol: V2_FROM, tool, args, otoOnay, timeoutMs });
      const v1 = await tekSeferlikCagri({ dil, protokol: V1_VERSION, tool, args, otoOnay, timeoutMs });

      const s2 = v2.sonuc?.structuredContent ?? null;
      const s1 = v1.sonuc?.structuredContent ?? null;
      const ayni = s1 !== null && s2 !== null && kanonik(s1) === kanonik(s2);

      return json(res, 200, {
        tool,
        args,
        v2,
        v1,
        karsilastirma: {
          structuredContentAyni: ayni,
          v2Var: s2 !== null,
          v1Var: s1 !== null,
          yorum: ayni
            ? "İki revizyonun structuredContent'i KANONİK OLARAK AYNI. Protokol değişti, tool sözleşmesi değişmedi — dersin ana mesajı budur."
            : s1 === null || s2 === null
              ? "Bir tarafta structuredContent yok; karşılaştırma yapılamadı."
              : "structuredContent FARKLI — bu bir sözleşme ihlalidir, protokol farkı çıktıyı değiştirmemelidir.",
        },
      });
    }

    // ── GET /api/kayit ───────────────────────────────────────────────────────
    if (req.method === "GET" && yol === "/api/kayit") {
      if (!oturum) return json(res, 200, { kayit: [], oturum: null });
      return json(res, 200, { kayit: oturum.kayit, oturum: oturumOzeti(), stderr: oturum.stderr.slice(-40) });
    }

    // ── GET /api/kopar ───────────────────────────────────────────────────────
    if ((req.method === "GET" || req.method === "POST") && yol === "/api/kopar") {
      const kayit = oturum ? oturum.kayit.slice() : [];
      const ozet = oturumKapat();
      return json(res, 200, { koparildi: Boolean(ozet), ozet, kayit });
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Bulunamadı");
  } catch (err) {
    json(res, 500, { hata: String(err?.message ?? err) });
  }
});

server.listen(PORT, HOST, () => {
  const adres = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
  process.stdout.write(
    [
      "",
      "  xurrent-mcp — uygulama içi MCP Inspector",
      `  ${adres}`,
      "",
      `  Repo kökü : ${ROOT}`,
      `  Sözleşme  : contract/tools.json`,
      `  Mod       : ${cocukEnv("2026-07-28").XURRENT_MODE} (inspector KASITLI olarak mock'ta çalışır)`,
      "",
      "  Kapatmak için Ctrl+C.",
      "",
    ].join("\n"),
  );
  if (has("--open")) {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    try {
      spawn(cmd, [adres], { stdio: "ignore", detached: true }).unref();
    } catch {
      /* tarayıcı açılamadıysa önemli değil */
    }
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    oturumKapat();
    process.exit(0);
  });
}
