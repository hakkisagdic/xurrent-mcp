#!/usr/bin/env node
// -----------------------------------------------------------------------------
// xurrent-mcp — ders sihirbazı
//
// Bu dosya bir MCP *CLIENT*'ıdır. Ders içeriğinin hiçbir parçası burada gömülü
// DEĞİLDİR: adımlar docs/wizard/steps.json'dan, beklenen sayılar da yine oradan
// gelir. Sihirbaz sadece "bağlan → çağır → doğrula → anlat" döngüsünü yürütür.
//
// NEDEN böyle: dersin tezi "MCP bir protokoldür, dil bir detaydır". Bunu ancak
// TEK bir client'ın ÜÇ farklı sunucuya bağlanıp AYNI çıktıyı üretmesiyle
// kanıtlayabiliriz. Ders metni client'a gömülü olsaydı kanıt değersiz olurdu.
//
// Kullanım:
//   node wizard.mjs --server ts|py|cs [--auto] [--json] [--verbose]
//                   [--step <id>] [--only <id,id>] [--from <id>]
//
// SONUÇ MODELİ ÜÇ DURUMLUDUR: PASS | FAIL | SKIP.
//   PASS — kontrol çalıştı ve tuttu
//   FAIL — kontrol çalıştı ve TUTMADI (gerçek bir uyumsuzluk)
//   SKIP — kontrol ÇALIŞTIRILAMADI (ön koşul yok: kullanıcı adımı atladı,
//          sunucu ilgili protokol revizyonunu konuşmuyor, vb.)
// SKIP bir başarısızlık DEĞİLDİR; çıkış kodunu yalnızca FAIL etkiler.
// -----------------------------------------------------------------------------

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

// ── Yol çözümleme ────────────────────────────────────────────────────────────
// clients/wizard/wizard.mjs → repo kökü iki seviye yukarıda.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");

// ── Argüman ayrıştırma ───────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    server: "ts",
    auto: false,
    json: false,
    verbose: false,
    color: true,
    only: null, // sadece bu adım id'lerini çalıştır (kısmi eşleşme)
    from: null, // bu adımdan İTİBAREN sona kadar
    probe: true, // başlangıçta protokol uyumluluk sondası
    help: false,
    listSteps: false,
    exec: null, // gelişmiş: --server yerine rastgele bir MCP sunucu komutu
  };
  // --step ve --only aynı listeyi besler; --step tekil demeye alışkın olanlar için
  // vardır (docs/demo/senaryo.md bu adı kullanıyor).
  const pushSel = (raw) => {
    const items = String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!items.length) return;
    a.only = [...(a.only ?? []), ...items];
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case "--server":
      case "-s":
        a.server = String(argv[++i] ?? "").toLowerCase();
        break;
      case "--auto":
        a.auto = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--verbose":
      case "-v":
        a.verbose = true;
        break;
      case "--no-color":
        a.color = false;
        break;
      case "--only":
      case "--step":
        pushSel(argv[++i]);
        break;
      case "--from":
        a.from = String(argv[++i] ?? "").trim() || null;
        break;
      case "--no-probe":
        a.probe = false;
        break;
      case "--list-steps":
        a.listSteps = true;
        break;
      case "--exec":
        a.exec = String(argv[++i] ?? "");
        break;
      case "--help":
      case "-h":
        a.help = true;
        break;
      default:
        if (t.startsWith("--server=")) a.server = t.slice(9).toLowerCase();
        else if (t.startsWith("--only=")) pushSel(t.slice(7));
        else if (t.startsWith("--step=")) pushSel(t.slice(7));
        else if (t.startsWith("--from=")) a.from = t.slice(7).trim() || null;
        else if (t.startsWith("-")) {
          process.stderr.write(`Bilinmeyen parametre: ${t}\n`);
          process.exit(2);
        }
    }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));

// --json modunda STDOUT yalnızca makine-okunur özet içindir; tüm insan çıktısı
// stderr'e gider. (Aynı disiplin MCP stdio transport'unda da geçerlidir:
// stdout SADECE protokol içindir.)
const OUT = args.json ? process.stderr : process.stdout;

// ── Renk / biçim ─────────────────────────────────────────────────────────────
const USE_COLOR =
  args.color && !process.env.NO_COLOR && (args.json ? process.stderr.isTTY : process.stdout.isTTY);

const C = new Proxy(
  {
    reset: "[0m",
    bold: "[1m",
    dim: "[2m",
    italic: "[3m",
    red: "[31m",
    green: "[32m",
    yellow: "[33m",
    blue: "[34m",
    magenta: "[35m",
    cyan: "[36m",
    gray: "[90m",
    bgBlue: "[44m",
  },
  { get: (t, k) => (USE_COLOR ? t[k] ?? "" : "") },
);

function paint(code, s) {
  return USE_COLOR ? `${code}${s}${C.reset}` : String(s);
}

// Okunaklı sarma genişliği: 80–100 kolon arası.
function termWidth() {
  const raw = (args.json ? process.stderr.columns : process.stdout.columns) || 96;
  return Math.max(80, Math.min(100, raw));
}

function visibleLength(s) {
  // ANSI kaçış dizileri görünür genişliğe sayılmaz.
  return String(s).replace(/\[[0-9;]*m/g, "").length;
}

function wrapText(text, width) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    const lead = para.match(/^\s*/)[0]; // girinti korunur (asılı girinti)
    const words = para.trim().split(/\s+/);
    let line = lead;
    for (const w of words) {
      const cand = line === lead ? lead + w : line + " " + w;
      if (visibleLength(cand) > width && line !== lead) {
        out.push(line);
        line = lead + w;
      } else {
        line = cand;
      }
    }
    out.push(line);
  }
  return out;
}

function write(s = "") {
  OUT.write(s + "\n");
}

function para(text, { indent = "", color = "" } = {}) {
  const w = termWidth() - indent.length;
  for (const line of wrapText(text, w)) write(indent + (color ? paint(color, line) : line));
}

function rule(char = "─") {
  write(paint(C.gray, char.repeat(termWidth())));
}

function chapterBanner(title) {
  const w = termWidth();
  write("");
  write(paint(C.blue + C.bold, "━".repeat(w)));
  write(paint(C.blue + C.bold, "  " + title.toUpperCase()));
  write(paint(C.blue + C.bold, "━".repeat(w)));
}

function stepHeader(n, total, title) {
  write("");
  rule("═");
  write(paint(C.bold + C.cyan, `  ADIM ${n}/${total} — ${title}`));
  rule("═");
}

// ── Tablo çizici (hücre içi sarma destekli) ─────────────────────────────────
function renderTable(headers, rows, maxWidth = termWidth()) {
  const cols = headers.length;
  const all = [headers, ...rows];
  // Doğal genişlik: hücrenin en uzun satırı.
  const natural = new Array(cols).fill(0);
  for (const r of all) {
    for (let i = 0; i < cols; i++) {
      const cell = String(r[i] ?? "");
      for (const ln of cell.split("\n")) natural[i] = Math.max(natural[i], visibleLength(ln));
    }
  }
  const borders = cols * 3 + 1;
  let avail = maxWidth - borders;
  const widths = natural.slice();
  // Sığmıyorsa en geniş kolonu tek tek kısalt (min 10 karakter).
  let guard = 0;
  while (widths.reduce((a, b) => a + b, 0) > avail && guard++ < 5000) {
    let idx = 0;
    for (let i = 1; i < cols; i++) if (widths[i] > widths[idx]) idx = i;
    if (widths[idx] <= 10) break;
    widths[idx]--;
  }

  const line = (l, m, r) => paint(C.gray, l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const rowOut = [];
  rowOut.push(line("┌", "┬", "┐"));

  const emit = (cells, bold) => {
    // Her hücreyi kendi kolon genişliğine sar, satır sayısını eşitle.
    const wrapped = cells.map((c, i) => {
      const lines = [];
      for (const seg of String(c ?? "").split("\n")) lines.push(...wrapText(seg, widths[i]));
      return lines.length ? lines : [""];
    });
    const h = Math.max(...wrapped.map((x) => x.length));
    for (let k = 0; k < h; k++) {
      const parts = wrapped.map((x, i) => {
        const txt = x[k] ?? "";
        const pad = " ".repeat(Math.max(0, widths[i] - visibleLength(txt)));
        return " " + (bold ? paint(C.bold, txt) : txt) + pad + " ";
      });
      rowOut.push(paint(C.gray, "│") + parts.join(paint(C.gray, "│")) + paint(C.gray, "│"));
    }
  };

  emit(headers, true);
  rowOut.push(line("├", "┼", "┤"));
  for (const r of rows) emit(r, false);
  rowOut.push(line("└", "┴", "┘"));
  for (const l of rowOut) write(l);
}

// ── Tarih / saat dilimi yardımcıları ────────────────────────────────────────
function ymdInTz(date, tz) {
  // en-CA locale'i YYYY-MM-DD üretir — elle biçimlendirmeye gerek yok.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

// Belirli bir YEREL GÜN için UTC offset'i. DST geçişlerinde dün ile bugünün
// offset'i FARKLI olabilir; bu yüzden offset her zaman İLGİLİ GÜN için hesaplanır.
function tzOffsetFor(iso, tz) {
  const [y, m, d] = iso.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // öğle: geçiş saatlerinden uzak
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  }).formatToParts(probe);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const mm = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!mm) return "+00:00"; // saf "GMT" → UTC
  return `${mm[1]}${String(mm[2]).padStart(2, "0")}:${mm[3] ?? "00"}`;
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
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

// ── Sunucu tanımları ─────────────────────────────────────────────────────────
// Üç sunucu da AYNI sözleşmeyi sunar; farkları yalnızca nasıl başlatıldıklarıdır.
const SERVERS = {
  ts: {
    label: "TypeScript",
    command: "node",
    args: [path.join(ROOT, "servers", "typescript", "dist", "mcp", "stdio.js")],
    hint: "cd servers/typescript && npm install && npm run build",
  },
  py: {
    label: "Python",
    command: "uv",
    args: ["--directory", path.join(ROOT, "servers", "python"), "run", "xurrent-mcp"],
    hint: "cd servers/python && uv sync",
  },
  cs: {
    label: "C#",
    command: "dotnet",
    args: ["run", "--project", path.join(ROOT, "servers", "csharp", "XurrentMcp.csproj"), "--", "stdio"],
    hint: "cd servers/csharp && dotnet build",
  },
};

// ── Yardım ──────────────────────────────────────────────────────────────────
function printHelp() {
  const w = termWidth();
  process.stdout.write(
    [
      "",
      paint(C.bold + C.cyan, "xurrent-mcp ders sihirbazı") + paint(C.gray, " — bir MCP client'ı"),
      paint(C.gray, "─".repeat(w)),
      "",
      paint(C.bold, "KULLANIM"),
      "  node clients/wizard/wizard.mjs [seçenekler]",
      "",
      paint(C.bold, "SEÇENEKLER"),
      "  -s, --server <ts|py|cs>   Bağlanılacak sunucu implementasyonu (varsayılan: ts)",
      "      --auto                Enter beklemez, onayları otomatik verir (CI için)",
      "      --json                STDOUT'a makine-okunur özet basar; anlatım stderr'e gider",
      "  -v, --verbose             Her tool çağrısının ham JSON çıktısını da gösterir",
      "      --step <id>           Sadece bu adımı çalıştırır. KISMİ eşleşme: --step 06 → 06-iki-yol",
      "      --only <id,id>        --step ile aynı; virgülle birden çok adım seçer",
      "      --from <id>           Bu adımdan İTİBAREN sona kadar çalıştırır",
      "      --list-steps          Adım listesini yazdırır ve çıkar (sunucuya bağlanmaz)",
      "      --no-probe            Başlangıçtaki protokol uyumluluk sondasını atlar",
      '      --exec "<komut>"      Gelişmiş: --server yerine verilen komutu MCP sunucusu olarak başlatır',
      "      --no-color            ANSI renklerini kapatır",
      "  -h, --help                Bu yardımı gösterir",
      "",
      paint(C.bold, "ADIM SEÇİMİ"),
      "  --step/--only/--from id'leri üç kademede eşleştirir: birebir → önek → içerik.",
      "  İlk dolu kademe kazanır, yani tam id yazan kişi kısmi eşleşmeye takılmaz.",
      "  Adım id'lerini görmek için: --list-steps",
      "",
      paint(C.bold, "SONUÇ MODELİ"),
      "  Her kontrol üç durumdan birini alır:",
      "    PASS  kontrol çalıştı ve tuttu",
      "    FAIL  kontrol çalıştı ve TUTMADI — gerçek bir uyumsuzluk",
      "    SKIP  kontrol ÇALIŞTIRILAMADI (ön koşul yok) — başarısızlık DEĞİLDİR",
      "  Özet satırı: \"N geçti, M başarısız, K atlandı\". Çıkış kodunu yalnızca FAIL etkiler.",
      "",
      paint(C.bold, "SUNUCU KOMUTLARI"),
      "  ts  → node servers/typescript/dist/mcp/stdio.js",
      "  py  → uv --directory servers/python run xurrent-mcp",
      "  cs  → dotnet run --project servers/csharp/XurrentMcp.csproj -- stdio",
      "",
      paint(C.bold, "PROTOKOL SONDASI"),
      "  Sihirbaz bağlanmadan önce sunucuya server/discover gönderir (zorunlu _meta ile):",
      "    başarılı                → sunucu 2026-07-28 (v2) konuşuyor",
      "    -32601 Method not found → sunucu v1; initialize el sıkışmasına düşülür",
      "    -32602 metadata eksik   → İSTEMCİ hatası; v1'e DÜŞÜLMEZ, net hata verilir",
      "  Konuşulan protokol ekranda gösterilir.",
      "",
      paint(C.bold, "PROTOKOL KARŞILAŞTIRMASI"),
      "  steps.json içindeki 'compareProtocols' adımları aynı tool'u İKİ MCP revizyonuyla",
      "  çağırır (sunucu MCP_PROTOCOL ile seçilir) ve structuredContent'lerin kanonik JSON",
      "  olarak birebir aynı olduğunu doğrular:",
      "    2025-11-25 → initialize el sıkışması + sunucu-başlatmalı elicitation/create",
      "    2026-07-28 → el sıkışma yok, server/discover + InputRequiredResult (MRTR)",
      "  Sunucu ikinci revizyonu konuşmuyorsa sonuç SKIP'tir — FAIL değil.",
      "",
      paint(C.bold, "ÖRNEKLER"),
      "  node clients/wizard/wizard.mjs --server ts",
      "  node clients/wizard/wizard.mjs --server py --auto --json",
      "  node clients/wizard/wizard.mjs --server py --step 06",
      "  node clients/wizard/wizard.mjs --server cs --only 04-acik-isler,05-zaman-baglami",
      "  node clients/wizard/wizard.mjs --server ts --from 12 --auto",
      "",
      paint(C.bold, "ÇIKIŞ KODLARI"),
      "  0  hiç FAIL yok (SKIP'ler çıkış kodunu etkilemez)",
      "  1  en az bir kontrol BAŞARISIZ (veya sunucuya bağlanılamadı)",
      "  2  hatalı parametre",
      "",
      paint(C.gray, "Ders içeriği docs/wizard/steps.json dosyasındadır; bu script onu yürütür."),
      paint(C.gray, "Beklenen sayılar fixtures/ klasöründen gelir — üç dil de aynı sayıları üretir."),
      "",
    ].join("\n"),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// PROTOKOL KARŞILAŞTIRMA — ham JSON-RPC istemcisi
//
// NEDEN SDK kullanmıyoruz: iki MCP revizyonunu YAN YANA konuşturmak istiyoruz.
// v1 (2025-11-25) ve v2 (2026-07-28) farklı SDK paketleri gerektirir; ikisini de
// sihirbaza bağlamak hem ağırlık hem de dersi gizlerdi. Protokolün tamamı zaten
// satır-sonlu JSON-RPC 2.0'dır — burada TELİ görüyoruz, dersin amacı da bu.
//
// Fark:
//   v1: initialize → notifications/initialized → tools/call
//       Onay: sunucu client'a İSTEK gönderir (elicitation/create)
//   v2: server/discover → tools/call (+ her istekte _meta)
//       Onay: sunucu SONUÇ döner (resultType:"input_required") ve client
//             AYNI çağrıyı YENİ id ile, inputResponses + requestState ile tekrarlar
// ═════════════════════════════════════════════════════════════════════════════

const PROTO_V2_META = "io.modelcontextprotocol/protocolVersion";
const PROTO_V2_CAPS = "io.modelcontextprotocol/clientCapabilities";
const PROTO_V2_INFO = "io.modelcontextprotocol/clientInfo";
const V2_FROM = "2026-07-28"; // bu tarihten itibaren v2 kuralları geçerli
const V1_VERSION = "2025-11-25";

const CLIENT_INFO = { name: "xurrent-wizard", version: "1.0.0" };
const CLIENT_CAPS = { elicitation: {} };

const isV2 = (proto) => String(proto) >= V2_FROM;

// v2'de HANDSHAKE YOKTUR. Bu yüzden protokol sürümü, client yetenekleri ve
// client kimliği HER İSTEKTE `_meta` içinde taşınır — bir kez söyleyip
// unutulabilecek bir şey değildir.
//
// ★ Bu üçü EKSİKSİZ gönderilmezse resmî SDK 2.0.0 sunucuları isteği REDDEDER
//   ve hata mesajı yanıltıcı olabilir:
//     python  → -32601 "Method not found"   (metot VAR; eksik olan _meta)
//     C#      → -32602 "The server/discover request requires per-request
//                       metadata declaring a supported protocol version."
//   Bu sihirbazın uzun süre "sunucu v2 konuşmuyor" sanmasının sebebi tam
//   olarak buydu: sonda YANLIŞ gönderiliyordu, sunucu suçsuzdu.
function v2Meta(protocol) {
  return {
    [PROTO_V2_META]: protocol,
    [PROTO_V2_CAPS]: CLIENT_CAPS,
    [PROTO_V2_INFO]: CLIENT_INFO,
  };
}

// Spec 2026-07-28 ile hata kodları yeniden numaralandı (-32020…-32099 spec'e
// ayrıldı). Sondanın doğru yorumlanabilmesi için gerekli olanlar:
const RPC = {
  METHOD_NOT_FOUND: -32601, // "bu RPC yok" → sunucu v2 konuşmuyor
  INVALID_PARAMS: -32602, // "_meta eksik/bozuk" → İSTEMCİ hatası
  UNSUPPORTED_PROTOCOL_VERSION: -32022, // v2 konuşuyor ama BU sürümü değil
  MISSING_CLIENT_CAPABILITY: -32021,
};

// ─────────────────────────────────────────────────────────────────────────────
// UYUMLULUK SONDASI
//
// Spec, stdio'da `server/discover`'ın geriye dönük uyumluluk sondası olarak
// kullanılmasını önerir:
//
//   server/discover (_meta İLE) gönder
//     ├─ başarılı                    → sunucu v2 konuşuyor; supportedVersions'a bak
//     ├─ -32601 Method not found     → sunucu v1; initialize el sıkışmasına DÜŞ
//     └─ -32602 metadata eksik/bozuk → BU BİR İSTEMCİ HATASIDIR. v1'e DÜŞÜLMEZ;
//                                      sondayı yanlış gönderdik demektir.
//
// Son madde önemlidir: -32602'yi "v1'e düş" diye yorumlarsak, v2 konuşan bir
// sunucuyu ömür boyu v1 sanarız ve kendi hatamızı sunucunun eksikliği gibi
// raporlarız. Sessiz hatanın ders kitabı örneği.
//
// Sonda AYRI ve KISA ÖMÜRLÜ bir süreçte çalışır. Sebebi ölçülmüş bir gerçektir:
// bir bağlantı üzerinde `initialize` yapıldıktan sonra aynı bağlantıya v2 zarflı
// istek göndermek reddedilir ("this connection serves the handshake protocol
// era"). Yani sonda, ders bağlantısının ÜZERİNE eklenemez.
// ─────────────────────────────────────────────────────────────────────────────
function probeServerProtocol({ srv, env, cwd, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const child = spawn(srv.command, srv.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // MCP_PROTOCOL'ü BİLEREK set etmiyoruz: sunucunun VARSAYILAN olarak neyi
      // ilan ettiğini öğrenmek istiyoruz.
      env: { ...env },
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    const pending = new Map();

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* zaten kapandı */
      }
      resolve({ stderr: stderrBuf.trim().split("\n").slice(-6).join("\n"), ...r });
    };

    const timer = setTimeout(
      () => finish({ ok: false, spoken: null, error: `Sonda zaman aşımı (${timeoutMs} ms)` }),
      timeoutMs,
    );

    child.on("error", (e) => finish({ ok: false, spoken: null, error: `Başlatılamadı: ${e.message}` }));
    child.on("exit", (code) => {
      if (!settled) finish({ ok: false, spoken: null, error: `Süreç kapandı (kod ${code}).` });
    });
    child.stderr.on("data", (d) => {
      stderrBuf += d.toString();
    });

    let nextId = 1;
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });

    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });

    (async () => {
      const disc = await request("server/discover", { _meta: v2Meta(V2_FROM) });

      if (!disc.error) {
        const versions = disc.result?.supportedVersions ?? [];
        return finish({
          ok: true,
          spoken: "v2",
          method: "server/discover",
          supportedVersions: versions,
          v2: true,
          v1: null, // aynı süreçte initialize denemiyoruz: zarf dönemleri karışmaz
          detail: `server/discover kabul edildi — supportedVersions=${JSON.stringify(versions)}`,
        });
      }

      const code = disc.error.code;

      if (code === RPC.INVALID_PARAMS || code === RPC.MISSING_CLIENT_CAPABILITY) {
        // v1'e DÜŞMÜYORUZ. Sunucu "metadata eksik" diyorsa metot VAR demektir;
        // eksik olan bizim gönderdiğimiz _meta'dır.
        return finish({
          ok: false,
          spoken: null,
          clientError: true,
          v2: true,
          error:
            `Sonda YANLIŞ gönderildi (${code}: ${disc.error.message}). ` +
            "Sunucu v2 konuşuyor; eksik olan istemcinin _meta bloğudur " +
            `(${PROTO_V2_META}, ${PROTO_V2_CAPS}, ${PROTO_V2_INFO}). Bu bir İSTEMCİ hatasıdır, v1'e düşülmez.`,
        });
      }

      if (code === RPC.UNSUPPORTED_PROTOCOL_VERSION) {
        return finish({
          ok: false,
          spoken: null,
          v2: true,
          error: `Sunucu v2 konuşuyor ama ${V2_FROM} sürümünü desteklemiyor (${code}: ${disc.error.message}).`,
        });
      }

      if (code !== RPC.METHOD_NOT_FOUND) {
        return finish({
          ok: false,
          spoken: null,
          error: `server/discover beklenmeyen hata (${code}: ${disc.error.message}).`,
        });
      }

      // -32601 → sunucu v2 konuşmuyor. Sondanın ikinci ayağı: v1 el sıkışması.
      const init = await request("initialize", {
        protocolVersion: V1_VERSION,
        capabilities: CLIENT_CAPS,
        clientInfo: CLIENT_INFO,
      });
      if (init.error) {
        return finish({
          ok: false,
          spoken: null,
          v2: false,
          error: `Ne server/discover ne initialize kabul edildi (${init.error.code}: ${init.error.message}).`,
        });
      }
      finish({
        ok: true,
        spoken: "v1",
        method: "initialize",
        v2: false,
        v1: init.result?.protocolVersion ?? null,
        supportedVersions: init.result?.protocolVersion ? [init.result.protocolVersion] : [],
        detail: `server/discover → -32601 Method not found; initialize kabul edildi (${init.result?.protocolVersion ?? "?"})`,
      });
    })().catch((e) => finish({ ok: false, spoken: null, error: String(e?.message ?? e) }));
  });
}

/**
 * Verilen protokol revizyonuyla TEK bir tool çağrısı yapar ve kapanır.
 * Sunucu tarafındaki revizyon MCP_PROTOCOL ortam değişkeniyle seçilir.
 */
function rawProtocolCall({ srv, env, cwd, protocol, toolName, toolArgs, autoAccept, timeoutMs = 60000 }) {
  return new Promise((resolve) => {
    const child = spawn(srv.command, srv.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...env, MCP_PROTOCOL: protocol },
    });

    const wire = []; // ders için: hangi mesajlar gitti/geldi
    const pending = new Map();
    let nextId = 1;
    let stdoutBuf = "";
    let stderrBuf = "";
    let settled = false;
    let confirmFlow = "onay istenmedi";

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* zaten kapandı */
      }
      resolve({ protocol, wire, confirmFlow, stderr: stderrBuf.trim().split("\n").slice(-6).join("\n"), ...r });
    };

    const timer = setTimeout(() => finish({ ok: false, error: `Zaman aşımı (${timeoutMs} ms)` }), timeoutMs);

    child.on("error", (e) => finish({ ok: false, error: `Başlatılamadı: ${e.message}` }));
    child.on("exit", (code) => {
      if (!settled) finish({ ok: false, error: `Süreç kapandı (kod ${code}).` });
    });
    child.stderr.on("data", (d) => {
      stderrBuf += d.toString();
    });

    const send = (msg) => {
      wire.push({ dir: "→", method: msg.method ?? "(yanıt)", id: msg.id });
      child.stdin.write(JSON.stringify(msg) + "\n");
    };
    // v2'de _meta YALNIZCA server/discover'a değil, İSTİSNASIZ HER İSTEĞE eklenir.
    // El sıkışma olmadığı için sunucunun sürümü/yetenekleri öğrenebileceği başka
    // bir an yoktur; tek bir istekte unutmak o isteği reddettirir.
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        const p = isV2(protocol) ? { ...(params ?? {}), _meta: { ...v2Meta(protocol), ...(params?._meta ?? {}) } } : params;
        send({ jsonrpc: "2.0", id, method, params: p });
      });

    child.stdout.on("data", (d) => {
      stdoutBuf += d.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // JSON olmayan satır (protokol ihlali) — verify-contract raporlar
        }
        // Sunucudan gelen İSTEK (yalnızca v1'de olur: elicitation/create)
        if (msg.method && msg.id !== undefined) {
          wire.push({ dir: "←", method: msg.method, id: msg.id });
          if (msg.method === "elicitation/create") {
            confirmFlow = "v1: sunucu → client İSTEĞİ (elicitation/create)";
            const content = {};
            for (const [k, spec] of Object.entries(msg.params?.requestedSchema?.properties ?? {})) {
              if (Array.isArray(spec?.enum)) content[k] = spec.enum[0];
              else if (spec?.type === "boolean") content[k] = true;
              else content[k] = spec?.default ?? "";
            }
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: autoAccept ? { action: "accept", content } : { action: "decline" },
            });
          } else {
            send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "desteklenmiyor" } });
          }
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          wire.push({ dir: "←", method: "(yanıt)", id: msg.id });
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });

    // ── Akış ─────────────────────────────────────────────────────────────────
    (async () => {
      let handshake;
      if (isV2(protocol)) {
        // v2: el sıkışma YOK. server/discover hem keşif hem uyumluluk sondasıdır.
        // _meta request() tarafından otomatik eklenir — buradaki {} boş DEĞİLDİR.
        const disc = await request("server/discover", {});
        if (disc.error) {
          const code = disc.error.code;
          // Ayrım kritik: "metot yok" sunucunun eksikliğidir (ATLANABİLİR),
          // "params geçersiz" bizim hatamızdır (ATLANAMAZ, düzeltilmeli).
          const unsupported = code === RPC.METHOD_NOT_FOUND || code === RPC.UNSUPPORTED_PROTOCOL_VERSION;
          return finish({
            ok: false,
            unsupported,
            clientError: code === RPC.INVALID_PARAMS || code === RPC.MISSING_CLIENT_CAPABILITY,
            handshake: "server/discover reddedildi",
            error: unsupported
              ? `Sunucu ${protocol} konuşmuyor (server/discover → ${code}: ${disc.error.message}).`
              : `server/discover reddedildi (${code}: ${disc.error.message}) — istemci tarafı _meta hatası olabilir.`,
          });
        }
        handshake = "server/discover (el sıkışma yok)";
      } else {
        const init = await request("initialize", {
          protocolVersion: protocol,
          capabilities: CLIENT_CAPS,
          clientInfo: CLIENT_INFO,
        });
        if (init.error) {
          return finish({
            ok: false,
            unsupported: true, // v1 el sıkışmasını reddeden sunucu v1 konuşmuyordur
            handshake: "initialize reddedildi",
            error: `Sunucu ${protocol} konuşmuyor (initialize → ${init.error.code}: ${init.error.message}).`,
          });
        }
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        handshake = `initialize → notifications/initialized (sunucu: ${init.result?.protocolVersion ?? "?"})`;
      }

      // tools/call — v2'de protokol sürümü ve yetenekler HER İSTEKTE _meta ile
      // gider; bunu request() ekler, burada tekrarlamıyoruz.
      const baseParams = { name: toolName, arguments: toolArgs };

      let res = await request("tools/call", baseParams);
      if (res.error) return finish({ ok: false, handshake, error: res.error.message });

      // v2 MRTR: "input_required" bir HATA değil, bir SONUÇ türüdür. İlk istek
      // SONLANIR; client aynı çağrıyı YENİ bir id ile, requestState'i geri
      // getirerek tekrarlar. Sunucu arada hiçbir state tutmaz.
      let rounds = 1;
      while (res.result?.resultType === "input_required" && rounds < 4) {
        confirmFlow = "v2: InputRequiredResult + isteğin tekrarı (MRTR)";
        if (!autoAccept) {
          return finish({ ok: true, handshake, rounds, result: res.result, declined: true });
        }
        const inputResponses = {};
        for (const [key, req] of Object.entries(res.result.inputRequests ?? {})) {
          const content = {};
          for (const [k, spec] of Object.entries(req?.requestedSchema?.properties ?? {})) {
            if (Array.isArray(spec?.enum)) content[k] = spec.enum[0];
            else if (spec?.type === "boolean") content[k] = true;
            else content[k] = spec?.default ?? "";
          }
          inputResponses[key] = { action: "accept", content };
        }
        res = await request("tools/call", {
          ...baseParams,
          inputResponses,
          requestState: res.result.requestState, // imzalı blob — aynen geri gider
        });
        rounds++;
        if (res.error) return finish({ ok: false, handshake, error: res.error.message });
      }

      finish({ ok: true, handshake, rounds, result: res.result });
    })().catch((e) => finish({ ok: false, error: String(e?.message ?? e) }));
  });
}

/** Karşılaştırma için kararlı (anahtarları sıralı) JSON. */
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

// ── Placeholder çözümleme ────────────────────────────────────────────────────
// {{today}}, {{yesterday}}, {{tzOffset}}
// DİKKAT: {{tzOffset}} aynı metinde {{yesterday}} geçiyorsa DÜNÜN offset'ine
// çözülür. DST geçiş gününde bu fark gerçektir ve sessizce yanlış instant üretir.
function resolvePlaceholders(value, ctx) {
  if (typeof value === "string") {
    const usesYesterday = value.includes("{{yesterday}}");
    const off = usesYesterday ? ctx.tzOffsetYesterday : ctx.tzOffsetToday;
    return value
      .replaceAll("{{today}}", ctx.today)
      .replaceAll("{{yesterday}}", ctx.yesterday)
      .replaceAll("{{tzOffset}}", off);
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v, ctx);
    return out;
  }
  return value;
}

// ── Sonuç okuma ──────────────────────────────────────────────────────────────
// MCP tools/call iki şekilde veri döndürebilir: structuredContent (outputSchema
// varsa) veya content[].text. Sihirbaz ikisini de kabul eder ki üç sunucu
// implementasyonu bu noktada birbirinden ayrışabilsin.
function extractResultWithSource(res) {
  if (res && res.structuredContent != null && typeof res.structuredContent === "object") {
    return { data: res.structuredContent, source: "structuredContent" };
  }
  const texts = (res?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text);
  for (const t of texts) {
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object") return { data: parsed, source: "content[].text (JSON)" };
    } catch {
      /* metin JSON değil — bir sonrakini dene */
    }
  }
  return { data: { _text: texts.join("\n") }, source: "content[].text (düz metin)" };
}

function extractResult(res) {
  return extractResultWithSource(res).data;
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of String(dotted).split(".")) {
    if (cur == null) return undefined;
    if (seg === "length" && (Array.isArray(cur) || typeof cur === "string")) {
      cur = cur.length;
      continue;
    }
    cur = cur[seg];
  }
  return cur;
}

function fmtVal(v) {
  if (v === undefined) return "(yok)";
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// ── Adım seçimi ──────────────────────────────────────────────────────────────
// --step / --only / --from KISMİ id eşleşmesi yapar: "06" → "06-iki-yol".
// Sebep: ders sırasında sunum yapan kişi "06-iki-yol" yazacak vakit bulamaz;
// docs/demo/senaryo.md de zaten "--step 06" yazıyor.
//
// Eşleşme üç kademelidir ve İLK dolu kademe kazanır — böylece tam id yazan
// kişi, kısmi eşleşmenin gürültüsüne yakalanmaz:
//   1) birebir id
//   2) id bu önekle başlıyor
//   3) id bu metni içeriyor
function matchSteps(steps, token) {
  const t = String(token).toLowerCase();
  const exact = steps.filter((s) => s.id.toLowerCase() === t);
  if (exact.length) return exact;
  const prefix = steps.filter((s) => s.id.toLowerCase().startsWith(t));
  if (prefix.length) return prefix;
  return steps.filter((s) => s.id.toLowerCase().includes(t));
}

/**
 * @returns {{steps: object[], notes: string[], error: string|null}}
 */
function selectSteps(allSteps, { only, from }) {
  const notes = [];
  let steps = allSteps;

  if (from) {
    const m = matchSteps(steps, from);
    if (!m.length) {
      return { steps: [], notes, error: `--from "${from}" hiçbir adımla eşleşmedi.` };
    }
    const startIdx = steps.indexOf(m[0]);
    steps = steps.slice(startIdx);
    notes.push(`--from ${from} → "${m[0].id}" adımından sonuna kadar (${steps.length} adım)`);
  }

  if (only?.length) {
    const picked = new Set();
    for (const tok of only) {
      const m = matchSteps(steps, tok);
      if (!m.length) {
        return {
          steps: [],
          notes,
          error:
            `--step/--only "${tok}" hiçbir adımla eşleşmedi. ` +
            `Geçerli id'ler: ${allSteps.map((s) => s.id).join(", ")}`,
        };
      }
      if (m.length > 1) notes.push(`"${tok}" → ${m.length} adım: ${m.map((s) => s.id).join(", ")}`);
      else notes.push(`"${tok}" → ${m[0].id}`);
      for (const s of m) picked.add(s);
    }
    // Orijinal sırayı koru — ders sırası anlamlıdır.
    steps = steps.filter((s) => picked.has(s));
  }

  return { steps, notes, error: null };
}

// ── Kullanıcı etkileşimi ─────────────────────────────────────────────────────
let rl = null;
function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: OUT, terminal: process.stdin.isTTY });
  }
  return rl;
}
function closeRl() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

function ask(question) {
  return new Promise((resolve) => getRl().question(question, (a) => resolve(a)));
}

async function pressEnter() {
  if (args.auto) return;
  if (!process.stdin.isTTY) return; // pipe içinde takılıp kalma
  await ask(paint(C.gray, "\n  ⏎ Devam etmek için Enter... "));
}

async function askYesNo(question, defaultYes = false) {
  if (args.auto) return true; // CI: onaylar otomatik verilir
  if (!process.stdin.isTTY) return defaultYes;
  const suffix = defaultYes ? " [E/h] " : " [e/H] ";
  const a = (await ask(question + suffix)).trim().toLowerCase();
  if (a === "") return defaultYes;
  return ["e", "evet", "y", "yes", "1"].includes(a);
}

// ── Ana akış ─────────────────────────────────────────────────────────────────
async function main() {
  if (args.help) {
    printHelp();
    return 0;
  }

  const stepsFile = path.join(ROOT, "docs", "wizard", "steps.json");
  if (!existsSync(stepsFile)) {
    process.stderr.write(`HATA: ders dosyası bulunamadı: ${stepsFile}\n`);
    return 1;
  }
  const lesson = JSON.parse(readFileSync(stepsFile, "utf8"));
  const chapters = new Map((lesson.chapters ?? []).map((c) => [c.id, c.title]));
  const allSteps = lesson.steps ?? [];

  const sel = selectSteps(allSteps, { only: args.only, from: args.from });
  if (sel.error) {
    process.stderr.write(`HATA: ${sel.error}\n`);
    return 2;
  }
  const steps = sel.steps;
  if (!steps.length) {
    process.stderr.write("HATA: seçim sonucunda çalıştırılacak adım kalmadı.\n");
    return 2;
  }

  if (args.listSteps) {
    for (const [i, s] of steps.entries()) {
      process.stdout.write(`${String(i + 1).padStart(2, "0")}  ${s.id.padEnd(26)}  ${s.title}\n`);
    }
    return 0;
  }

  // --exec verildiyse hazır tanımlar yerine serbest komut kullanılır. Bu, dersin
  // "aynı client herhangi bir MCP sunucusuna bağlanır" iddiasının canlı kanıtıdır.
  let srv;
  if (args.exec) {
    const parts = args.exec.split(/\s+/).filter(Boolean);
    srv = { label: `özel (${parts[0]})`, command: parts[0], args: parts.slice(1), hint: args.exec };
  } else {
    srv = SERVERS[args.server];
    if (!srv) {
      process.stderr.write(`HATA: bilinmeyen sunucu "${args.server}". Geçerli değerler: ts, py, cs\n`);
      return 2;
    }
  }

  // Ortam: .env → varsayılanlar → gerçek process.env (gerçek env her zaman kazanır).
  const dotenv = loadDotEnv(path.join(ROOT, ".env"));
  const childEnv = {
    ...dotenv,
    XURRENT_MODE: process.env.XURRENT_MODE ?? dotenv.XURRENT_MODE ?? "mock",
    XURRENT_TIMEZONE: process.env.XURRENT_TIMEZONE ?? dotenv.XURRENT_TIMEZONE ?? "Europe/Istanbul",
    CALENDAR_PROVIDER: process.env.CALENDAR_PROVIDER ?? dotenv.CALENDAR_PROVIDER ?? "mock",
    XURRENT_BACKDATE_STRATEGY:
      process.env.XURRENT_BACKDATE_STRATEGY ?? dotenv.XURRENT_BACKDATE_STRATEGY ?? "two_step",
    XURRENT_FIXTURES_DIR:
      process.env.XURRENT_FIXTURES_DIR ?? dotenv.XURRENT_FIXTURES_DIR ?? path.join(ROOT, "fixtures"),
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
  };

  const tz = childEnv.XURRENT_TIMEZONE;
  const today = ymdInTz(new Date(), tz);
  const yesterday = addDaysISO(today, -1);
  const ctx = {
    today,
    yesterday,
    tzOffsetToday: tzOffsetFor(today, tz),
    tzOffsetYesterday: tzOffsetFor(yesterday, tz),
  };

  // ── Başlık ─────────────────────────────────────────────────────────────────
  write("");
  write(paint(C.bold + C.magenta, `  ${lesson.title ?? "xurrent-mcp"}`));
  if (lesson.subtitle) write(paint(C.gray, `  ${lesson.subtitle}`));
  write("");
  renderTable(
    ["", ""],
    [
      ["Sunucu", args.exec ? srv.label : `${srv.label}  (--server ${args.server})`],
      ["Komut", [srv.command, ...srv.args.map((a) => a.replace(ROOT + path.sep, ""))].join(" ")],
      ["Mod", childEnv.XURRENT_MODE],
      ["Takvim sağlayıcısı", childEnv.CALENDAR_PROVIDER],
      ["Backdate stratejisi", childEnv.XURRENT_BACKDATE_STRATEGY],
      ["Saat dilimi", `${tz}  (bugün ${today}, offset ${ctx.tzOffsetToday})`],
      ["Adım sayısı", `${steps.length}${steps.length !== allSteps.length ? ` / ${allSteps.length} (seçildi)` : ""}`],
    ],
    Math.min(termWidth(), 92),
  );
  for (const n of sel.notes) write(paint(C.gray, `  seçim: ${n}`));

  // ── Uyumluluk sondası ──────────────────────────────────────────────────────
  // Ders bağlantısı kurulmadan ÖNCE çalışır (v2 zarflı istek, initialize yapılmış
  // bir bağlantıya eklenemez). Sonuç ekranda gösterilir — dersin bir parçasıdır.
  let probe = null;
  if (args.probe) {
    write("");
    write(paint(C.bold, "  → server/discover ") + paint(C.gray, "(uyumluluk sondası, zorunlu _meta ile)"));
    probe = await probeServerProtocol({
      srv,
      env: childEnv,
      cwd: ROOT,
      timeoutMs: args.server === "cs" ? 180000 : 60000,
    });
    if (probe.clientError) {
      // ★ v1'e DÜŞMÜYORUZ. Bu bizim hatamız; sunucuyu suçlamak sessiz hataya yol açar.
      write(paint(C.red + C.bold, "  ✘ SONDA HATALI GÖNDERİLDİ"));
      para(probe.error, { indent: "    ", color: C.red });
      if (args.json) {
        process.stdout.write(JSON.stringify({ ok: false, server: args.server, probe }, null, 2) + "\n");
      }
      return 1;
    }
    if (probe.ok && probe.spoken === "v2") {
      write(
        paint(C.green, "  ✔ v2 ") +
          paint(C.gray, `(${V2_FROM}) — server/discover kabul edildi, supportedVersions=${JSON.stringify(probe.supportedVersions ?? [])}`),
      );
    } else if (probe.ok && probe.spoken === "v1") {
      write(paint(C.yellow, `  ○ v1 `) + paint(C.gray, `— ${probe.detail}`));
    } else {
      write(paint(C.yellow, "  ○ Sonda sonuçsuz ") + paint(C.gray, `— ${probe.error}`));
    }
  }

  // ── Bağlan ─────────────────────────────────────────────────────────────────
  const client = new Client(
    CLIENT_INFO,
    // elicitation yeteneğini BİLDİRİYORUZ: sunucu yazma öncesi onayı doğrudan
    // kullanıcıdan isteyebilsin. Bildirmezsek sunucu fail-closed davranır.
    { capabilities: CLIENT_CAPS },
  );

  const elicitLog = [];
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const message = req.params?.message ?? "Sunucu onay istiyor.";
    const schema = req.params?.requestedSchema ?? {};
    write("");
    write(paint(C.yellow + C.bold, "  ┏━ ONAY İSTEĞİ (MCP elicitation) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    para(message, { indent: "  ┃ ", color: C.yellow });
    write(paint(C.yellow + C.bold, "  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    const accepted = await askYesNo(paint(C.yellow, "  Onaylıyor musun?"), false);
    elicitLog.push({ message, accepted });
    if (!accepted) {
      write(paint(C.red, "  → Reddedildi. Sunucu yazma işlemini iptal edecek."));
      return { action: "decline" };
    }
    // Şemadaki alanları makul varsayılanlarla doldur — onay diyalogları
    // tipik olarak tek bir boolean alan içerir.
    const content = {};
    for (const [k, spec] of Object.entries(schema.properties ?? {})) {
      if (Array.isArray(spec?.enum)) content[k] = spec.enum[0];
      else if (spec?.type === "boolean") content[k] = true;
      else if (spec?.type === "number" || spec?.type === "integer") content[k] = spec.default ?? 0;
      else content[k] = spec?.default ?? "";
    }
    write(paint(C.green, "  → Onaylandı."));
    return { action: "accept", content };
  });

  const transport = new StdioClientTransport({
    command: srv.command,
    args: srv.args,
    env: childEnv,
    cwd: ROOT,
    // Sunucu logları stderr'e akar. stdio transport'ta stdout SADECE JSON-RPC
    // içindir; sunucunun oraya tek bir karakter yazması protokolü bozar.
    stderr: "inherit",
  });

  // SDK, pazarlık sonucunu (negotiated protocolVersion) dışarı açmıyor. Teli
  // dinlemek bir satırlık iş: Protocol.connect() transport.onmessage'ı atarken
  // araya giriyoruz. Ders açısından da doğru mesaj — protokol bir kutu değil,
  // okunabilir bir mesaj akışıdır.
  let negotiatedVersion = null;
  Object.defineProperty(transport, "onmessage", {
    configurable: true,
    get() {
      return this._wizardOnMessage;
    },
    set(fn) {
      this._wizardOnMessage = (msg, extra) => {
        if (negotiatedVersion === null && typeof msg?.result?.protocolVersion === "string") {
          negotiatedVersion = msg.result.protocolVersion;
        }
        return fn(msg, extra);
      };
    },
  });

  write("");
  write(paint(C.gray, `  Bağlanılıyor: ${srv.command} ${srv.args.join(" ")}`));
  try {
    await client.connect(transport);
  } catch (err) {
    write("");
    write(paint(C.red + C.bold, "  ✘ Sunucuya bağlanılamadı."));
    para(String(err?.message ?? err), { indent: "    ", color: C.red });
    write("");
    para(`Bu sunucu önce derlenmelidir:  ${srv.hint}`, { indent: "    ", color: C.yellow });
    write("");
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ ok: false, server: args.server, probe, error: String(err?.message ?? err) }, null, 2) + "\n",
      );
    }
    return 1;
  }
  const si = client.getServerVersion?.();
  write(paint(C.green, `  ✔ Bağlandı: ${si?.name ?? "?"} v${si?.version ?? "?"}`));
  // Sihirbaz KONUŞTUĞU protokolü açıkça söyler — dersin en somut çıktısı bu.
  write(
    paint(C.bold, "  Konuşulan protokol: ") +
      paint(C.cyan, negotiatedVersion ?? "?") +
      paint(C.gray, "  (initialize el sıkışması — SDK @modelcontextprotocol/sdk 1.x)"),
  );
  if (probe) {
    write(
      paint(C.gray, "  Sunucunun ilan ettiği: ") +
        paint(C.gray, probe.ok ? `${probe.spoken} — ${probe.detail}` : `sonda sonuçsuz (${probe.error})`),
    );
  }

  // ── Ders döngüsü ───────────────────────────────────────────────────────────
  const report = {
    server: args.server,
    serverLabel: srv.label,
    serverInfo: si ?? null,
    mode: childEnv.XURRENT_MODE,
    calendarProvider: childEnv.CALENDAR_PROVIDER,
    backdateStrategy: childEnv.XURRENT_BACKDATE_STRATEGY,
    timeZone: tz,
    today,
    yesterday,
    startedAt: new Date().toISOString(),
    // Sondanın ve pazarlığın sonucu rapora da girer: CI'da "hangi protokolü
    // konuştuk" sorusunun cevabı, ders çıktısının parçasıdır.
    protocol: {
      probe: probe ?? null,
      spoken: probe?.spoken ?? null,
      negotiated: negotiatedVersion,
      supportsV2: probe?.v2 ?? null,
    },
    toolCount: null,
    tools: [],
    steps: [],
    elicitations: elicitLog,
    totals: { steps: 0, checks: 0, passed: 0, failed: 0, skipped: 0, quizzes: 0, quizzesCorrect: 0 },
    ok: true,
  };

  let toolsCache = null;
  let lastChapter = null;

  for (const [idx, step] of steps.entries()) {
    const rec = {
      id: step.id,
      title: step.title,
      chapter: step.chapter,
      calls: [],
      checks: [],
      status: "pass", // adım özeti: fail > skip > pass önceliğiyle güncellenir
      pass: true,
      skipped: false,
      skipReason: null,
    };

    if (step.chapter && step.chapter !== lastChapter) {
      chapterBanner(chapters.get(step.chapter) ?? step.chapter);
      lastChapter = step.chapter;
    }
    stepHeader(idx + 1, steps.length, step.title);

    // 1) Anlatım
    for (const line of step.narrate ?? []) {
      write("");
      para(line, { indent: "  " });
    }

    // 2) tools/list
    if (step.listTools) {
      write("");
      write(paint(C.bold, "  → tools/list"));
      if (!toolsCache) {
        const r = await client.listTools();
        toolsCache = r.tools ?? [];
        report.toolCount = toolsCache.length;
        report.tools = toolsCache.map((t) => t.name);
      }
      write("");
      renderTable(
        ["#", "Tool", "Salt okunur", "Parametreler", "Özet"],
        toolsCache.map((t, i) => {
          const props = Object.keys(t.inputSchema?.properties ?? {});
          const ro = t.annotations?.readOnlyHint === true;
          return [
            String(i + 1),
            t.name,
            ro ? "evet" : "HAYIR",
            props.length ? props.join(", ") : "—",
            String(t.description ?? "").split("\n")[0],
          ];
        }),
      );
    }

    // 3) callTool
    const doCall = async (name, rawArgs, label) => {
      const callArgs = resolvePlaceholders(rawArgs ?? {}, ctx);
      write("");
      write(
        paint(C.bold, `  → tools/call `) +
          paint(C.cyan + C.bold, name) +
          (label ? paint(C.gray, `   [${label}]`) : ""),
      );
      for (const l of wrapText(JSON.stringify(callArgs), termWidth() - 6)) {
        write(paint(C.gray, "     " + l));
      }
      const t0 = Date.now();
      let res, data, isError = false, errText = null;
      try {
        res = await client.callTool({ name, arguments: callArgs });
        isError = res?.isError === true;
        data = extractResult(res);
      } catch (err) {
        isError = true;
        errText = String(err?.message ?? err);
        data = { _error: errText };
      }
      const ms = Date.now() - t0;
      rec.calls.push({ tool: name, label: label ?? null, args: callArgs, ms, isError, result: data });

      if (isError) {
        write(paint(C.red, `  ✘ Tool hatası (${ms} ms)`));
        para(errText ?? JSON.stringify(data), { indent: "    ", color: C.red });
      } else {
        write(paint(C.gray, `  ✔ ${ms} ms`));
      }
      if (args.verbose || isError) {
        write("");
        for (const l of JSON.stringify(data, null, 2).split("\n")) write(paint(C.gray, "    " + l));
      }
      return data;
    };

    let lastData = null;
    if (step.callTool && step.callTool.name) {
      // Gerçekten yazacak adımlarda önce kullanıcıyı uyar.
      if (step.confirmable) {
        write("");
        write(paint(C.yellow, "  ⚠ Bu adım GERÇEKTEN yazma yapar (mock modda güvenlidir)."));
        const go = await askYesNo(paint(C.yellow, "  Devam edilsin mi?"), true);
        if (!go) {
          write(paint(C.gray, "  Adım atlandı."));
          rec.skipped = true;
          rec.skipReason = "kullanıcı yazma adımını onaylamadı";
        }
      }
      if (!rec.skipped) lastData = await doCall(step.callTool.name, step.callTool.args);
    }

    // 4) callToolSequence → yan yana karşılaştırma
    if (Array.isArray(step.callToolSequence) && step.callToolSequence.length) {
      const results = [];
      for (const c of step.callToolSequence) {
        const d = await doCall(c.name, c.args, c.label);
        results.push({ label: c.label ?? c.name, data: d });
      }
      lastData = results.at(-1)?.data ?? null;

      // WriteResult şekli için anlamlı karşılaştırma satırları.
      const COMPARE_ROWS = [
        ["Strateji", (r) => r?.strategy],
        ["Planlanan mutation sayısı", (r) => (Array.isArray(r?.planned) ? r.planned.length : undefined)],
        [
          "Mutation zinciri",
          (r) =>
            Array.isArray(r?.planned)
              ? r.planned.map((p) => `${p.stepLabel ? p.stepLabel + " " : ""}${p.path}`).join("\n→ ")
              : undefined,
        ],
        ["Uyarı sayısı", (r) => (Array.isArray(r?.warnings) ? r.warnings.length : undefined)],
        [
          "Uyarılar",
          (r) => (Array.isArray(r?.warnings) && r.warnings.length ? r.warnings.map((w, i) => `${i + 1}. ${w}`).join("\n") : undefined),
        ],
        ["Gerekçe", (r) => r?.strategyExplanation],
        ["Hata sayısı", (r) => (Array.isArray(r?.errors) ? r.errors.length : undefined)],
      ];
      const rows = [];
      for (const [label, get] of COMPARE_ROWS) {
        const cells = results.map((r) => get(r.data));
        if (cells.every((c) => c === undefined || c === null)) continue; // ilgisiz satırı gösterme
        rows.push([label, ...cells.map((c) => (c === undefined || c === null ? "—" : String(c)))]);
      }
      if (rows.length) {
        write("");
        write(paint(C.bold, "  YAN YANA KARŞILAŞTIRMA"));
        write("");
        renderTable(["", ...results.map((r) => r.label)], rows);
      }
    }

    // 4b) compareProtocols → AYNI tool'u iki protokol revizyonuyla çağır
    //
    // protocolsAgree üç değerlidir:
    //   true  → iki revizyon da çalıştı ve çıktılar BİREBİR aynı
    //   false → ikisi de çalıştı ama çıktılar FARKLI (gerçek bir hata)
    //   null  → karşılaştırma YAPILAMADI (sunucu bir revizyonu konuşmuyor) → SKIP
    let protocolsAgree = null;
    let protocolsSkipReason = null;
    if (step.compareProtocols) {
      const cp = step.compareProtocols;
      const cpArgs = resolvePlaceholders(cp.args ?? {}, ctx);
      const runs = [];
      for (const proto of cp.protocols ?? []) {
        write("");
        write(paint(C.bold, "  → ") + paint(C.cyan + C.bold, `MCP_PROTOCOL=${proto}`) + paint(C.gray, `  ${cp.tool}`));

        // Sonda zaten "bu sunucu v2 konuşmuyor" dediyse süreci hiç başlatmayalım:
        // dotnet/uv soğuk başlangıcı 10–180 sn sürebiliyor ve sonuç belli.
        if (args.probe && probe?.ok && isV2(proto) && probe.v2 === false) {
          const r = {
            protocol: proto,
            ok: false,
            unsupported: true,
            wire: [],
            confirmFlow: "—",
            handshake: "—",
            error: `Sonda bu sunucunun ${proto} konuşmadığını gösterdi (server/discover → -32601). Süreç başlatılmadı.`,
          };
          runs.push(r);
          write(paint(C.yellow, `     ○ ${r.error}`));
          rec.calls.push({ tool: cp.tool, label: `protokol ${proto}`, args: cpArgs, protocol: proto, ok: false, unsupported: true, error: r.error });
          continue;
        }

        const r = await rawProtocolCall({
          srv,
          env: childEnv,
          cwd: ROOT,
          protocol: proto,
          toolName: cp.tool,
          toolArgs: cpArgs,
          autoAccept: true, // dryRun planı için onay her zaman verilir
          timeoutMs: args.server === "cs" ? 180000 : 60000,
        });
        runs.push(r);
        if (r.ok) {
          write(paint(C.gray, `     el sıkışma : ${r.handshake}`));
          write(paint(C.gray, `     tur sayısı : ${r.rounds}`));
          write(paint(C.gray, `     onay yolu  : ${r.confirmFlow}`));
          write(paint(C.gray, `     çıktı kaynağı: ${extractResultWithSource(r.result).source}`));
        } else if (r.unsupported) {
          write(paint(C.yellow, `     ○ ${r.error}`));
        } else {
          write(paint(C.red, `     ✘ ${r.error}`));
          if (r.stderr && args.verbose) for (const l of r.stderr.split("\n")) write(paint(C.gray, "       " + l));
        }
        rec.calls.push({ tool: cp.tool, label: `protokol ${proto}`, args: cpArgs, protocol: proto, ok: r.ok, unsupported: r.unsupported ?? false, handshake: r.handshake ?? null, rounds: r.rounds ?? null, confirmFlow: r.confirmFlow, error: r.error ?? null });
      }

      // Tool ÇIKTISI iki protokolde de birebir aynı olmalı. Değişmesi gereken
      // tek şey onayın SORULMA BİÇİMİYDİ — sonuç değil.
      const okRuns = runs.filter((r) => r.ok);
      const extracted = okRuns.map((r) => extractResultWithSource(r.result));
      const payloads = extracted.map((e) => e.data);
      const unsupportedRuns = runs.filter((r) => !r.ok && r.unsupported);

      if (okRuns.length === runs.length && runs.length > 1) {
        protocolsAgree = payloads.every((p) => canonical(p) === canonical(payloads[0]));
      } else if (unsupportedRuns.length) {
        protocolsAgree = null;
        protocolsSkipReason =
          `sunucu şu revizyon(lar)ı konuşmuyor: ${unsupportedRuns.map((r) => r.protocol).join(", ")} — ` +
          "karşılaştırma yapılamadı (bu bir başarısızlık değil)";
      } else {
        protocolsAgree = false; // gerçek bir hata (çökme, zaman aşımı, istemci hatası)
        protocolsSkipReason = null;
      }

      write("");
      write(paint(C.bold, "  YAN YANA — AYNI TOOL, İKİ PROTOKOL"));
      write("");
      renderTable(
        ["", ...runs.map((r) => r.protocol)],
        [
          ["Bağlanabildi mi?", ...runs.map((r) => (r.ok ? "evet" : r.unsupported ? "konuşmuyor" : "HAYIR"))],
          ["El sıkışma", ...runs.map((r) => r.handshake ?? "—")],
          ["Onayın sorulma biçimi", ...runs.map((r) => r.confirmFlow ?? "—")],
          ["HTTP/JSON-RPC tur sayısı", ...runs.map((r) => String(r.rounds ?? "—"))],
          ["Wire mesaj sayısı", ...runs.map((r) => String(r.wire?.length ?? 0))],
          [
            "Çıktı kaynağı",
            ...runs.map((r) => (r.ok ? extractResultWithSource(r.result).source : "—")),
          ],
          [
            "Tool çıktısı (özet)",
            ...runs.map((r) => {
              if (!r.ok) return "—";
              const p = extractResult(r.result);
              return `strategy=${p?.strategy ?? "?"}  planned=${Array.isArray(p?.planned) ? p.planned.length : "?"}  warnings=${Array.isArray(p?.warnings) ? p.warnings.length : "?"}`;
            }),
          ],
          [
            "Kanonik JSON özdeş mi?",
            ...runs.map(() => (protocolsAgree === null ? "karşılaştırılamadı" : protocolsAgree ? "EVET" : "HAYIR")),
          ],
          ["Hata", ...runs.map((r) => r.error ?? "—")],
        ],
      );
      lastData = payloads[0] ?? null;
    }

    // 5) Statik tablo (steps.json içinde tanımlı)
    if (step.table) {
      write("");
      renderTable(step.table.headers ?? [], step.table.rows ?? []);
    }

    // 6) expect kontrolleri — PASS | FAIL | SKIP
    //
    // SKIP'in tanımı dar tutulmuştur: kontrol ÇALIŞTIRILAMADIĞI durumdur.
    // "Çalıştı ve tutmadı" asla SKIP olamaz — yoksa sihirbaz kendi hatalarını
    // kendisi affeder ve ders yalan söyler.
    for (const e of step.expect ?? []) {
      let actual = null;
      let label;
      let expected;
      let status; // "pass" | "fail" | "skip"
      let skipReason = null;

      if (rec.skipped) {
        // Adımın kendisi çalıştırılmadı → tüm kontrolleri SKIP.
        label = e.check ?? e.path;
        expected = e.equals ?? (e.exists ? "(dolu)" : null);
        status = "skip";
        skipReason = rec.skipReason ?? "adım çalıştırılmadı";
      } else if (e.check === "toolCount") {
        if (!toolsCache) {
          const r = await client.listTools();
          toolsCache = r.tools ?? [];
          report.toolCount = toolsCache.length;
          report.tools = toolsCache.map((t) => t.name);
        }
        actual = toolsCache.length;
        label = "toolCount";
        expected = e.equals;
        status = actual === e.equals ? "pass" : "fail";
      } else if (e.check === "protocolsAgree") {
        label = "protocolsAgree";
        expected = e.equals ?? true;
        if (protocolsAgree === null) {
          // Karşılaştırma hiç yapılamadı → SKIP. FAIL demek, henüz v2 adaptörü
          // yazılmamış bir sunucuyu "sözleşmeyi ihlal ediyor" diye suçlamak olurdu.
          status = "skip";
          skipReason = protocolsSkipReason ?? "protokol karşılaştırması yapılamadı";
        } else {
          actual = protocolsAgree;
          status = actual === expected ? "pass" : "fail";
        }
      } else if (lastData == null) {
        // Yol kontrolü var ama ortada sonuç yok (adımda tool çağrısı yapılmadı
        // veya çağrı hiç sonuç üretmedi) → ön koşul yok → SKIP.
        label = e.path;
        expected = e.equals ?? (e.exists ? "(dolu)" : null);
        status = "skip";
        skipReason = "adımda değerlendirilecek bir tool sonucu yok";
      } else if (e.exists === true) {
        actual = getPath(lastData, e.path);
        label = e.path;
        expected = "(dolu)";
        status = actual !== undefined && actual !== null && actual !== "" ? "pass" : "fail";
      } else {
        actual = getPath(lastData, e.path);
        label = e.path;
        expected = e.equals;
        // Sayı/metin karşılaştırmasında gevşek eşitlik: "3" ile 3 aynı sayılır.
        const eq = actual === e.equals || (actual != null && String(actual) === String(e.equals));
        status = eq ? "pass" : "fail";
      }

      rec.checks.push({
        label,
        expected,
        actual: actual ?? null,
        status,
        pass: status === "pass",
        skipped: status === "skip",
        skipReason,
        explain: e.explain ?? null,
      });
      report.totals.checks++;
      if (status === "pass") report.totals.passed++;
      else if (status === "skip") {
        report.totals.skipped++;
        if (rec.status === "pass") rec.status = "skip";
      } else {
        report.totals.failed++;
        rec.status = "fail";
        rec.pass = false;
        report.ok = false;
      }

      write("");
      if (status === "pass") {
        write(paint(C.green + C.bold, `  ✔ PASS  `) + paint(C.green, `${label} = ${fmtVal(actual)}`));
      } else if (status === "skip") {
        write(paint(C.yellow + C.bold, `  ○ SKIP  `) + paint(C.yellow, `${label} — ${skipReason}`));
      } else {
        write(
          paint(C.red + C.bold, `  ✘ FAIL  `) +
            paint(C.red, `${label}: beklenen ${fmtVal(expected)}, gelen ${fmtVal(actual)}`),
        );
      }
      if (e.explain) {
        // SKIP'te açıklama "olan"ı değil "olması beklenen"i anlatır; etiketlemezsek
        // kullanıcı kontrolün geçtiğini sanır.
        const text = status === "skip" ? `(bu kontrol geçseydi: ${e.explain})` : e.explain;
        para(text, { indent: "          ", color: status === "pass" ? C.gray : status === "skip" ? C.gray : C.yellow });
      }
    }

    // 7) reveal
    if (step.reveal?.length) {
      write("");
      write(paint(C.magenta + C.bold, "  ◆ AÇIKLAMA"));
      for (const line of step.reveal) {
        write("");
        para(line, { indent: "    ", color: C.magenta });
      }
    }

    // 8) Serbest soru (cevabı değerlendirilmez, düşündürmek içindir)
    if (step.prompt && !args.auto && process.stdin.isTTY) {
      write("");
      await ask(paint(C.cyan, `  ? ${step.prompt}\n  > `));
    }

    // 9) Quiz
    if (step.quiz) {
      report.totals.quizzes++;
      write("");
      write(paint(C.cyan + C.bold, "  ? SORU"));
      para(step.quiz.question, { indent: "    ", color: C.cyan });
      write("");
      step.quiz.options.forEach((o, i) => {
        for (const l of wrapText(`${i + 1}) ${o}`, termWidth() - 6)) write("    " + l);
      });

      let correct = null;
      if (!args.auto && process.stdin.isTTY) {
        const a = (await ask(paint(C.cyan, `\n  Cevabın (1-${step.quiz.options.length}): `))).trim();
        const picked = Number(a) - 1;
        correct = picked === step.quiz.answer;
        write("");
        if (correct) write(paint(C.green + C.bold, "  ✔ DOĞRU"));
        else
          write(
            paint(C.red + C.bold, "  ✘ YANLIŞ") +
              paint(C.red, `  — doğru cevap: ${step.quiz.answer + 1}) ${step.quiz.options[step.quiz.answer]}`),
          );
      } else {
        write("");
        write(
          paint(C.gray, `  Doğru cevap: ${step.quiz.answer + 1}) ${step.quiz.options[step.quiz.answer]}`),
        );
      }
      if (correct === true) report.totals.quizzesCorrect++;
      para(step.quiz.explain, { indent: "    ", color: C.gray });
      rec.quiz = { question: step.quiz.question, answer: step.quiz.answer, userCorrect: correct };
    }

    if (step.docs) {
      write("");
      write(paint(C.gray, `  📖 Ayrıntı: ${step.docs}`));
    }

    report.steps.push(rec);
    report.totals.steps++;
    await pressEnter();
  }

  // ── Kapanış özeti ──────────────────────────────────────────────────────────
  report.finishedAt = new Date().toISOString();
  report.durationMs = new Date(report.finishedAt) - new Date(report.startedAt);
  // Çıkış kodunu YALNIZCA FAIL belirler. SKIP "bu ortamda ölçülemedi" demektir;
  // ölçülemeyen bir şeyi başarısız saymak, yeşil olması gereken CI'ları
  // kırmızıya boyayıp asıl kırmızıları görünmez yapar.
  report.ok = report.totals.failed === 0;
  report.summaryLine = `${report.totals.passed} geçti, ${report.totals.failed} başarısız, ${report.totals.skipped} atlandı`;

  write("");
  rule("═");
  write(paint(C.bold, "  ÖZET"));
  rule("═");
  write("");
  renderTable(
    ["", ""],
    [
      ["Sunucu", args.exec ? srv.label : `${srv.label} (${args.server})`],
      ["Protokol (sonda)", probe?.ok ? `${probe.spoken} — ${(probe.supportedVersions ?? []).join(", ") || "?"}` : "sonda yapılmadı"],
      ["Protokol (ders bağlantısı)", negotiatedVersion ?? "?"],
      ["Adım", String(report.totals.steps)],
      ["Kontrol", String(report.totals.checks)],
      ["PASS", String(report.totals.passed)],
      ["FAIL", String(report.totals.failed)],
      ["SKIP", String(report.totals.skipped)],
      ["Süre", `${Math.round(report.durationMs / 100) / 10} sn`],
    ],
    Math.min(termWidth(), 70),
  );
  write("");
  write(
    paint(C.bold, "  SONUÇ: ") +
      paint(C.green, `${report.totals.passed} geçti`) +
      paint(C.gray, ", ") +
      paint(report.totals.failed ? C.red + C.bold : C.gray, `${report.totals.failed} başarısız`) +
      paint(C.gray, ", ") +
      paint(report.totals.skipped ? C.yellow : C.gray, `${report.totals.skipped} atlandı`),
  );
  write("");

  if (report.totals.skipped) {
    write(paint(C.yellow + C.bold, "  ○ ATLANAN KONTROLLER (başarısızlık değildir)"));
    for (const s of report.steps) {
      for (const c of s.checks) {
        if (c.status === "skip") write(paint(C.yellow, `    • ${s.id} → ${c.label}: ${c.skipReason}`));
      }
    }
    write("");
  }

  if (report.ok) {
    write(paint(C.green + C.bold, "  ✔ BAŞARISIZ KONTROL YOK."));
    write(
      paint(
        C.gray,
        "  Aynı komutu --server py veya --server cs ile çalıştır: tek bir sayı değişmeyecek.",
      ),
    );
  } else {
    write(paint(C.red + C.bold, `  ✘ ${report.totals.failed} KONTROL BAŞARISIZ.`));
    for (const s of report.steps) {
      for (const c of s.checks) {
        if (c.status === "fail") {
          write(
            paint(C.red, `    • ${s.id} → ${c.label}: beklenen ${fmtVal(c.expected)}, gelen ${fmtVal(c.actual)}`),
          );
        }
      }
    }
  }
  write("");

  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");

  await client.close().catch(() => {});
  return report.ok ? 0 : 1;
}

main()
  .then((code) => {
    closeRl();
    process.exit(code);
  })
  .catch((err) => {
    closeRl();
    process.stderr.write(`\nBEKLENMEYEN HATA: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
