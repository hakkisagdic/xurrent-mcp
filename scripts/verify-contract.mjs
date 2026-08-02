#!/usr/bin/env node
// -----------------------------------------------------------------------------
// verify-contract.mjs — üç sunucunun tools/list çıktısını contract/tools.json'a
// karşı doğrular.
//
// NEDEN: "MCP bir protokoldür, dil bir detaydır" iddiası ancak OTOMATİK
// doğrulanabilirse iddia olmaktan çıkıp olguya döner. Bu script tam olarak o
// doğrulamayı yapar: tool adları, parametre adları, zorunlu alanlar ve
// annotation'lar sözleşmeyle birebir örtüşmeli.
//
// ★ ÇIKTI TARAFI DA SÖZLEŞMEYE DAHİLDİR. Bu script uzun süre yalnızca GİRDİ
//   tarafını (tool adları, parametreler, annotation'lar) karşılaştırdı; bu
//   yüzden iki sunucunun hiç `outputSchema` bildirmediği ve dolayısıyla
//   `tools/call` cevabında `structuredContent` üretmediği KAÇIRILDI. Bir tool
//   sözleşmesi, çağıranın ne göndereceği kadar ne ALACAĞInı da tarif eder;
//   yoksa "üç dil aynı çıktıyı üretir" tezi ölçülemez bir slogandır.
//   Eklenen kontroller:
//     (a) her tool outputSchema BİLDİRİYOR mu
//     (b) outputSchema'nın üst seviye alanları contract/tools.json'daki
//         "output" ile örtüşüyor mu ($ref'ler çözülerek)
//     (c) gerçek bir okuma tool'u çağrılıp structuredContent DOLU geliyor mu
//         (ve yanında okunabilir bir text block var mı)
//     (d) v2'de tools/list zorunlu ttlMs + cacheScope taşıyor mu
//     (e) tools/list DETERMİNİSTİK sırada mı (sözleşmedeki sıra)
//
// BAĞIMLILIK YOKTUR. MCP SDK'sı yerine ~80 satırlık bir JSON-RPC stdio istemcisi
// kullanılır; böylece scripts/ klasörü npm install gerektirmez. Aynı zamanda
// protokolün ne kadar basit olduğunu göstermek de dersin bir parçasıdır.
//
// Kullanım:
//   node scripts/verify-contract.mjs --all
//   node scripts/verify-contract.mjs --server ts
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

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
      "verify-contract.mjs — tools/list çıktısını contract/tools.json ile karşılaştırır.",
      "",
      "KULLANIM",
      "  node scripts/verify-contract.mjs --all",
      "  node scripts/verify-contract.mjs --server ts|py|cs",
      "",
      "SEÇENEKLER",
      "  --all                Üç sunucuyu da doğrular",
      "  --server <ts|py|cs>  Tek bir sunucuyu doğrular",
      "  --skip-missing       Başlatılamayan sunucuyu HATA değil ATLANDI sayar",
      "  --no-call            tools/call yapmaz (structuredContent kontrolünü atlar)",
      '  --exec "<komut>"     Gelişmiş: hazır tanımlar yerine verilen komutu MCP sunucusu olarak başlatır',
      "  --timeout <ms>       Sunucu başlatma/yanıt zaman aşımı (varsayılan 60000, cs için 180000)",
      "  --json               Makine-okunur çıktı (stdout), rapor stderr'e gider",
      "  --no-color           ANSI renklerini kapatır",
      "",
      "ÇIKIŞ KODLARI",
      "  0  tüm sunucular sözleşmeye uygun",
      "  1  en az bir fark var (veya sunucu başlatılamadı)",
      "  2  hatalı parametre",
      "",
      "NE ZAMAN ÇALIŞTIRILIR",
      "  Her sunucu değişikliğinden sonra ve CI'da. Bir tool adı veya parametre adı",
      "  üç dilden birinde kayarsa sihirbaz sessizce yanlış çalışır — bu script onu",
      "  sessiz olmaktan çıkarır.",
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
const cyan = (s) => c("36", s);
const write = (s = "") => OUT.write(s + "\n");

// ── Sunucu tanımları (.mcp.json ve wizard.mjs ile birebir aynı) ─────────────
const SERVERS = {
  ts: {
    label: "TypeScript",
    command: "node",
    args: [path.join(ROOT, "servers", "typescript", "dist", "mcp", "stdio.js")],
    hint: "cd servers/typescript && npm install && npm run build",
    defaultTimeout: 60000,
  },
  py: {
    label: "Python",
    command: "uv",
    args: ["--directory", path.join(ROOT, "servers", "python"), "run", "xurrent-mcp"],
    hint: "cd servers/python && uv sync",
    defaultTimeout: 90000,
  },
  cs: {
    label: "C#",
    command: "dotnet",
    args: ["run", "--project", path.join(ROOT, "servers", "csharp", "XurrentMcp.csproj"), "--", "stdio"],
    hint: "cd servers/csharp && dotnet build",
    defaultTimeout: 180000,
  },
};

let targets;
const EXEC = opt("--exec", null);
if (EXEC) {
  // Serbest komut: sözleşme doğrulaması herhangi bir MCP sunucusuna uygulanabilir.
  const parts = EXEC.split(/\s+/).filter(Boolean);
  SERVERS.custom = {
    label: `özel (${parts[0]})`,
    command: parts[0],
    args: parts.slice(1),
    hint: EXEC,
    defaultTimeout: 60000,
  };
  targets = ["custom"];
} else if (has("--all")) targets = ["ts", "py", "cs"];
else {
  const s = String(opt("--server", "")).toLowerCase();
  if (!SERVERS[s]) {
    process.stderr.write("HATA: --all veya --server ts|py|cs verilmelidir. (--help)\n");
    process.exit(2);
  }
  targets = [s];
}

// ── Çift protokolü konuşan minimal MCP stdio istemcisi ──────────────────────
// Protokolün tamamı: satır-sonlu JSON-RPC 2.0.
//   v1 (2025-11-25): initialize → notifications/initialized → istek
//   v2 (2026-07-28): el sıkışma YOK; server/discover + HER İSTEKTE `_meta`
//
// Uyumluluk sondası (spec'in önerdiği akış):
//   server/discover (_meta İLE)
//     ├─ başarılı                → v2
//     ├─ -32601 Method not found → v1'e düş
//     └─ -32602 params geçersiz  → İSTEMCİ hatası; v1'e DÜŞÜLMEZ
const V2 = "2026-07-28";
const V1 = "2025-11-25";
const CLIENT_INFO = { name: "verify-contract", version: "1.0.0" };
const CLIENT_CAPS = { elicitation: {} };
const RPC_METHOD_NOT_FOUND = -32601;
const RPC_INVALID_PARAMS = -32602;
const RPC_UNSUPPORTED_PROTOCOL_VERSION = -32022; // spec 2026-07-28 (eski: -32004)
const RPC_MISSING_CLIENT_CAPABILITY = -32021; // spec 2026-07-28 (eski: -32003)

// v2'de sürüm/yetenek/kimlik her istekte taşınır — bunlar OLMADAN gönderilen
// server/discover resmî SDK 2.0.0 sunucularınca reddedilir.
const v2Meta = () => ({
  "io.modelcontextprotocol/protocolVersion": V2,
  "io.modelcontextprotocol/clientCapabilities": CLIENT_CAPS,
  "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
});

// Sözleşmede yer alan, argümansız ve YAN ETKİSİZ bir okuma tool'u.
// structuredContent kontrolü bunun üzerinden yapılır.
const PROBE_TOOL = "xurrent_whoami";

async function mcpInspect(srv, timeoutMs, { call = true } = {}) {
  return new Promise((resolve) => {
    const child = spawn(srv.command, srv.args, {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        XURRENT_MODE: process.env.XURRENT_MODE ?? "mock",
        CALENDAR_PROVIDER: process.env.CALENDAR_PROVIDER ?? "mock",
        XURRENT_TIMEZONE: process.env.XURRENT_TIMEZONE ?? "Europe/Istanbul",
        XURRENT_FIXTURES_DIR: process.env.XURRENT_FIXTURES_DIR ?? path.join(ROOT, "fixtures"),
      },
    });

    let stderrBuf = "";
    let stdoutBuf = "";
    const pending = new Map();
    // stdio transport'ta stdout SADECE JSON-RPC içindir. Buraya düşen her
    // JSON olmayan satır protokol ihlalidir ve raporlanır.
    const junkLines = [];
    let settled = false;
    let nextId = 1;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
      } catch {
        /* zaten öldü */
      }
      resolve({ ...res, stderr: stderrBuf.trim(), junkLines });
    };

    const timer = setTimeout(
      () => finish({ ok: false, error: `Zaman aşımı (${timeoutMs} ms) — sunucu yanıt vermedi.` }),
      timeoutMs,
    );

    child.on("error", (err) => finish({ ok: false, error: `Başlatılamadı: ${err.message}` }));
    child.on("exit", (code, sig) => {
      if (!settled) finish({ ok: false, error: `Süreç beklenmedik şekilde kapandı (kod ${code}${sig ? ", " + sig : ""}).` });
    });
    child.stderr.on("data", (d) => {
      stderrBuf += d.toString();
    });

    const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

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
          junkLines.push(line.slice(0, 200));
          continue;
        }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const cb = pending.get(msg.id);
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });

    // v2 modunda _meta İSTİSNASIZ her isteğe eklenir.
    let mode = null;
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        pending.set(id, res);
        const p = mode === "v2" ? { ...(params ?? {}), _meta: v2Meta() } : (params ?? {});
        send({ jsonrpc: "2.0", id, method, params: p });
      });

    (async () => {
      // 1) Uyumluluk sondası
      mode = "v2";
      const disc = await request("server/discover", {});
      let serverInfo = null;
      let protocolVersion = null;
      let supportedVersions = [];

      if (!disc.error) {
        // v2'de sunucu kimliği ya doğrudan sonuçta ya da _meta içinde taşınır —
        // el sıkışma olmadığı için initialize'ın serverInfo alanı yoktur.
        serverInfo =
          disc.result?.serverInfo ?? disc.result?._meta?.["io.modelcontextprotocol/serverInfo"] ?? null;
        supportedVersions = disc.result?.supportedVersions ?? [];
        protocolVersion = supportedVersions[0] ?? V2;
      } else if (disc.error.code === RPC_INVALID_PARAMS || disc.error.code === RPC_MISSING_CLIENT_CAPABILITY) {
        // Sunucu "metadata eksik" diyorsa metot VAR; eksik olan bizim _meta'mız.
        // Bunu "v1" diye yorumlamak, kendi hatamızı sunucuya yıkmak olur.
        return finish({
          ok: false,
          clientError: true,
          error:
            `server/discover ${disc.error.code} ile reddedildi ("${disc.error.message}"). ` +
            "Bu bir İSTEMCİ hatasıdır: _meta bloğu eksik/bozuk. v1'e düşülmedi.",
        });
      } else if (disc.error.code === RPC_UNSUPPORTED_PROTOCOL_VERSION) {
        return finish({
          ok: false,
          error: `Sunucu v2 konuşuyor ama ${V2} sürümünü desteklemiyor (${disc.error.code}: ${disc.error.message}).`,
        });
      } else if (disc.error.code !== RPC_METHOD_NOT_FOUND) {
        return finish({ ok: false, error: `server/discover beklenmeyen hata (${disc.error.code}: ${disc.error.message}).` });
      } else {
        // -32601 → v1'e düş
        mode = "v1";
        const init = await request("initialize", {
          protocolVersion: V1,
          capabilities: CLIENT_CAPS,
          clientInfo: CLIENT_INFO,
        });
        if (init.error) return finish({ ok: false, error: `initialize hatası: ${init.error.message}` });
        serverInfo = init.result?.serverInfo ?? null;
        protocolVersion = init.result?.protocolVersion ?? null;
        supportedVersions = protocolVersion ? [protocolVersion] : [];
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
      }

      // 2) tools/list
      const list = await request("tools/list", {});
      if (list.error) return finish({ ok: false, mode, error: `tools/list hatası: ${list.error.message}` });

      // 3) tools/call — sözleşmenin ÇIKTI tarafını ancak gerçek bir çağrı ölçer.
      let callResult = null;
      let callError = null;
      if (call) {
        const res = await request("tools/call", { name: PROBE_TOOL, arguments: {} });
        if (res.error) callError = `${res.error.code}: ${res.error.message}`;
        else callResult = res.result ?? null;
      }

      finish({
        ok: true,
        mode,
        tools: list.result?.tools ?? [],
        listResult: list.result ?? {},
        callTool: PROBE_TOOL,
        callResult,
        callError,
        serverInfo,
        protocolVersion,
        supportedVersions,
      });
    })().catch((e) => finish({ ok: false, error: String(e?.stack ?? e) }));
  });
}

// ── Tablo çizici (küçük ve bağımsız) ────────────────────────────────────────
function table(headers, rows) {
  if (!rows.length) return;
  const cols = headers.length;
  const vis = (s) => String(s ?? "").replace(/\[[0-9;]*m/g, "").length;
  const w = new Array(cols).fill(0);
  for (const r of [headers, ...rows]) for (let i = 0; i < cols; i++) w[i] = Math.max(w[i], vis(r[i]));
  const max = Math.max(80, Math.min(120, OUT.columns || 100));
  let guard = 0;
  while (w.reduce((a, b) => a + b, 0) + cols * 3 + 1 > max && guard++ < 5000) {
    let idx = 0;
    for (let i = 1; i < cols; i++) if (w[i] > w[idx]) idx = i;
    if (w[idx] <= 10) break;
    w[idx]--;
  }
  const clip = (s, n) => {
    const t = String(s ?? "");
    return vis(t) <= n ? t + " ".repeat(n - vis(t)) : t.slice(0, Math.max(0, n - 1)) + "…";
  };
  const line = (l, m, r) => dim(l + w.map((x) => "─".repeat(x + 2)).join(m) + r);
  write(line("┌", "┬", "┐"));
  write(dim("│") + headers.map((h, i) => " " + bold(clip(h, w[i])) + " ").join(dim("│")) + dim("│"));
  write(line("├", "┼", "┤"));
  for (const r of rows) {
    write(dim("│") + r.map((cell, i) => " " + clip(cell, w[i]) + " ").join(dim("│")) + dim("│"));
  }
  write(line("└", "┴", "┘"));
}

// ── Sözleşme ─────────────────────────────────────────────────────────────────
const contractFile = path.join(ROOT, "contract", "tools.json");
if (!existsSync(contractFile)) {
  process.stderr.write(`HATA: sözleşme bulunamadı: ${contractFile}\n`);
  process.exit(1);
}
const contract = JSON.parse(readFileSync(contractFile, "utf8"));
const expectedTools = contract.tools ?? [];
const expectedByName = new Map(expectedTools.map((t) => [t.name, t]));

// ── Karşılaştırma ────────────────────────────────────────────────────────────
function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x));
}

/** "#/$defs/WriteResult" → contract.$defs.WriteResult (yalnızca yerel referanslar). */
function jsonPointer(root, ref) {
  if (!ref?.startsWith("#/")) return null;
  let cur = root;
  for (const seg of ref.slice(2).split("/")) {
    if (cur == null) return null;
    cur = cur[seg.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return cur ?? null;
}

/** Sözleşmedeki "output" bloğunun $ref zincirini çözer (ör. WriteResult). */
function resolveOutput(schema, root) {
  let s = schema;
  let guard = 0;
  while (s && typeof s === "object" && s.$ref && guard++ < 10) s = jsonPointer(root, s.$ref);
  return s && typeof s === "object" ? s : null;
}

// v2'de tools/list cevabı ZORUNLU cache alanları taşır. Değerler
// contract/protocol.md'de sabitlenmiştir: tool listemiz statiktir.
const V2_LIST_TTL_MS = 300000;
const V2_LIST_CACHE_SCOPE = "public";

function compare(actualTools) {
  const diffs = []; // { tool, kind, detail }
  const actualByName = new Map(actualTools.map((t) => [t.name, t]));
  const expNames = new Set(expectedByName.keys());
  const actNames = new Set(actualByName.keys());

  if (actualTools.length !== expectedTools.length) {
    diffs.push({
      tool: "(genel)",
      kind: "tool sayısı",
      detail: `beklenen ${expectedTools.length}, gelen ${actualTools.length}`,
    });
  }
  for (const n of setDiff(expNames, actNames)) diffs.push({ tool: n, kind: "EKSİK tool", detail: "sunucuda yok" });
  for (const n of setDiff(actNames, expNames)) diffs.push({ tool: n, kind: "FAZLA tool", detail: "sözleşmede yok" });

  for (const name of [...expNames].filter((n) => actNames.has(n))) {
    const exp = expectedByName.get(name);
    const act = actualByName.get(name);
    const schema = act.inputSchema ?? {};

    if (schema.type !== "object") {
      diffs.push({ tool: name, kind: "inputSchema.type", detail: `beklenen "object", gelen ${JSON.stringify(schema.type)}` });
    }

    // Parametre adları
    const expProps = new Set(Object.keys(exp.input?.properties ?? {}));
    const actProps = new Set(Object.keys(schema.properties ?? {}));
    for (const p of setDiff(expProps, actProps)) {
      diffs.push({ tool: name, kind: "EKSİK parametre", detail: p });
    }
    for (const p of setDiff(actProps, expProps)) {
      diffs.push({ tool: name, kind: "FAZLA parametre", detail: p });
    }

    // Zorunlu alanlar
    const expReq = new Set(exp.input?.required ?? []);
    const actReq = new Set(schema.required ?? []);
    for (const p of setDiff(expReq, actReq)) {
      diffs.push({ tool: name, kind: "required kaybolmuş", detail: `${p} sözleşmede zorunlu, sunucuda değil` });
    }
    for (const p of setDiff(actReq, expReq)) {
      diffs.push({ tool: name, kind: "required fazladan", detail: `${p} sunucuda zorunlu, sözleşmede değil` });
    }

    // Annotation'lar — Claude Code izin isterken bunlara bakar; readOnlyHint'in
    // yanlış olması "yazan bir tool'u onaysız çalıştırmak" demektir.
    const expAnn = exp.annotations ?? {};
    const actAnn = act.annotations ?? {};
    for (const [k, v] of Object.entries(expAnn)) {
      if (actAnn[k] !== v) {
        diffs.push({
          tool: name,
          kind: `annotations.${k}`,
          detail: `beklenen ${JSON.stringify(v)}, gelen ${JSON.stringify(actAnn[k])}`,
        });
      }
    }

    // description zorunlu değil ama boş olması LLM için ciddi bir kalite sorunudur.
    if (!act.description || String(act.description).trim().length < 10) {
      diffs.push({ tool: name, kind: "description", detail: "boş veya çok kısa — LLM tool'u yanlış kullanır" });
    }

    // ── ÇIKTI SÖZLEŞMESİ ─────────────────────────────────────────────────────
    // outputSchema bildirmeyen bir sunucu, tools/call cevabında
    // structuredContent üretmez; çağıran taraf JSON'ı metinden AYRIŞTIRMAK
    // zorunda kalır. "Üç dil aynı çıktıyı üretir" tezi tam burada kırılır.
    const expOut = resolveOutput(exp.output, contract);
    const actOut = act.outputSchema;

    if (!actOut || typeof actOut !== "object") {
      diffs.push({
        tool: name,
        kind: "outputSchema YOK",
        detail: "sözleşmede 'output' tanımlı ama sunucu outputSchema bildirmiyor → structuredContent üretilmez",
      });
    } else if (expOut) {
      if (actOut.type !== undefined && actOut.type !== "object") {
        diffs.push({ tool: name, kind: "outputSchema.type", detail: `beklenen "object", gelen ${JSON.stringify(actOut.type)}` });
      }
      const expOutProps = new Set(Object.keys(expOut.properties ?? {}));
      const actOutProps = new Set(Object.keys(actOut.properties ?? {}));
      for (const p of setDiff(expOutProps, actOutProps)) {
        diffs.push({ tool: name, kind: "EKSİK çıktı alanı", detail: p });
      }
      for (const p of setDiff(actOutProps, expOutProps)) {
        diffs.push({ tool: name, kind: "FAZLA çıktı alanı", detail: `${p} — sözleşmede yok` });
      }
      const expOutReq = new Set(expOut.required ?? []);
      const actOutReq = new Set(actOut.required ?? []);
      for (const p of setDiff(expOutReq, actOutReq)) {
        diffs.push({ tool: name, kind: "çıktı required kaybolmuş", detail: `${p} sözleşmede zorunlu, outputSchema'da değil` });
      }
    }
  }

  // tools/list DETERMİNİSTİK sırada dönmelidir (LLM prompt cache isabeti).
  // Sözleşmedeki sıra kanonik sıradır.
  const expOrder = expectedTools.map((t) => t.name);
  const actOrder = actualTools.map((t) => t.name);
  if (actOrder.length === expOrder.length && actOrder.join("|") !== expOrder.join("|")) {
    const firstBad = actOrder.findIndex((n, i) => n !== expOrder[i]);
    diffs.push({
      tool: "(genel)",
      kind: "tools/list sırası",
      detail: `sözleşme sırası korunmuyor; ${firstBad + 1}. sırada "${expOrder[firstBad]}" beklenirken "${actOrder[firstBad]}" geldi`,
    });
  }

  return diffs;
}

// ── tools/list zarfı (v2'ye özgü zorunlu alanlar) ───────────────────────────
function checkListEnvelope(mode, listResult) {
  const diffs = [];
  if (mode !== "v2") return diffs; // v1'de böyle bir alan yok
  if (listResult?.ttlMs !== V2_LIST_TTL_MS) {
    diffs.push({
      tool: "(tools/list)",
      kind: "ttlMs",
      detail: `beklenen ${V2_LIST_TTL_MS}, gelen ${JSON.stringify(listResult?.ttlMs)} — v2'de liste cache alanları ZORUNLUDUR`,
    });
  }
  if (listResult?.cacheScope !== V2_LIST_CACHE_SCOPE) {
    diffs.push({
      tool: "(tools/list)",
      kind: "cacheScope",
      detail: `beklenen "${V2_LIST_CACHE_SCOPE}", gelen ${JSON.stringify(listResult?.cacheScope)} — tool listemiz statiktir, kullanıcıya özel değildir`,
    });
  }
  return diffs;
}

// ── tools/call cevabı: structuredContent GERÇEKTEN geliyor mu? ──────────────
// Şema bildirmek yetmez; çağrının kendisi de yapılandırılmış veri döndürmeli.
function checkCallResult(mode, toolName, callResult, callError) {
  const diffs = [];
  if (callError) {
    diffs.push({ tool: toolName, kind: "tools/call hatası", detail: callError });
    return diffs;
  }
  if (!callResult) return diffs; // --no-call ile atlandı

  const sc = callResult.structuredContent;
  if (sc == null || typeof sc !== "object" || Array.isArray(sc) || Object.keys(sc).length === 0) {
    diffs.push({
      tool: toolName,
      kind: "structuredContent YOK",
      detail: "tools/call cevabında yapılandırılmış çıktı yok — çağıran taraf metni ayrıştırmak zorunda kalır",
    });
  } else {
    const exp = resolveOutput(expectedByName.get(toolName)?.output, contract);
    for (const r of exp?.required ?? []) {
      if (!(r in sc)) {
        diffs.push({ tool: toolName, kind: "structuredContent alanı eksik", detail: `${r} — sözleşmede zorunlu` });
      }
    }
  }

  // structuredContent'in YANI SIRA okunabilir bir metin bloğu da olmalıdır:
  // yapılandırılmış veriyi okuyamayan client'lar (ve insanlar) hâlâ vardır.
  const texts = (callResult.content ?? []).filter((c) => c?.type === "text");
  if (!texts.length) {
    diffs.push({ tool: toolName, kind: "text block YOK", detail: "structuredContent'in yanında okunabilir metin yayınlanmıyor" });
  }

  // v2'de sonuç zarfı resultType taşımak ZORUNDADIR.
  if (mode === "v2" && callResult.resultType !== "complete") {
    diffs.push({
      tool: toolName,
      kind: "resultType",
      detail: `beklenen "complete", gelen ${JSON.stringify(callResult.resultType)} — v2'de resultType zorunludur`,
    });
  }
  return diffs;
}

// ── Ana akış ─────────────────────────────────────────────────────────────────
const report = { contractVersion: contract.contractVersion ?? null, expectedToolCount: expectedTools.length, servers: {}, ok: true };

write("");
write(bold(`  Sözleşme doğrulaması — contract/tools.json v${contract.contractVersion ?? "?"}`));
write(dim(`  Beklenen tool sayısı: ${expectedTools.length}`));

for (const key of targets) {
  const srv = SERVERS[key];
  const timeoutMs = Number(opt("--timeout", srv.defaultTimeout));
  write("");
  write(dim("─".repeat(Math.max(80, Math.min(120, OUT.columns || 100)))));
  write(bold(`  ${srv.label}  (--server ${key})`));
  write(dim(`  ${srv.command} ${srv.args.map((a) => a.replace(ROOT + path.sep, "")).join(" ")}`));
  write("");

  const res = await mcpInspect(srv, timeoutMs, { call: !has("--no-call") });

  if (!res.ok) {
    // İstemci hatası ASLA "atlandı" sayılmaz: bizim düzeltmemiz gereken bir şey var.
    const skipped = has("--skip-missing") && !res.clientError;
    write((skipped ? yellow("  ○ ATLANDI  ") : red("  ✘ BAŞARISIZ  ")) + res.error);
    if (res.stderr) {
      write(dim("  sunucu stderr (son 15 satır):"));
      for (const l of res.stderr.split("\n").slice(-15)) write(dim("    " + l));
    }
    write(yellow(`  İpucu: ${srv.hint}`));
    report.servers[key] = { ok: false, skipped, error: res.error, diffs: [] };
    if (!skipped) report.ok = false;
    continue;
  }

  write(
    green("  ✔ Bağlandı  ") +
      dim(`${res.serverInfo?.name ?? "?"} v${res.serverInfo?.version ?? "?"}  ·  protokol ${res.protocolVersion ?? "?"}`),
  );
  write(
    dim(
      `  Uyumluluk sondası: ${res.mode === "v2" ? "server/discover kabul edildi → v2" : "server/discover → -32601, initialize'a düşüldü → v1"}` +
        (res.supportedVersions?.length ? `  ·  supportedVersions=${JSON.stringify(res.supportedVersions)}` : ""),
    ),
  );

  const diffs = [
    ...compare(res.tools),
    ...checkListEnvelope(res.mode, res.listResult),
    ...checkCallResult(res.mode, res.callTool, res.callResult, res.callError),
  ];

  // stdout kirliliği: stdio transport'ta ölümcül bir hatadır.
  if (res.junkLines.length) {
    diffs.push({
      tool: "(transport)",
      kind: "stdout kirliliği",
      detail: `${res.junkLines.length} JSON olmayan satır — stdio'da stdout SADECE JSON-RPC içindir: ${res.junkLines[0]}`,
    });
  }

  write("");
  table(
    ["#", "Tool", "Salt okunur", "outputSchema", "Parametreler", "Durum"],
    expectedTools.map((et, i) => {
      const act = res.tools.find((t) => t.name === et.name);
      const toolDiffs = diffs.filter((d) => d.tool === et.name);
      const status = !act ? red("EKSİK") : toolDiffs.length ? red(`${toolDiffs.length} fark`) : green("OK");
      const props = act ? Object.keys(act.inputSchema?.properties ?? {}) : [];
      const outCount = act?.outputSchema ? Object.keys(act.outputSchema.properties ?? {}).length : null;
      return [
        String(i + 1),
        et.name,
        et.annotations?.readOnlyHint === true ? "evet" : "HAYIR",
        outCount === null ? red("YOK") : green(`${outCount} alan`),
        props.length ? props.join(", ") : "—",
        status,
      ];
    }),
  );

  const withOutput = res.tools.filter((t) => t.outputSchema && typeof t.outputSchema === "object").length;
  write("");
  write(
    (withOutput === expectedTools.length ? green("  outputSchema: ") : red("  outputSchema: ")) +
      `${withOutput}/${expectedTools.length} tool bildiriyor` +
      dim(
        res.callResult
          ? `   ·   ${res.callTool} → structuredContent ${
              res.callResult.structuredContent && Object.keys(res.callResult.structuredContent).length ? "DOLU" : "YOK"
            }`
          : "   ·   tools/call atlandı (--no-call)",
      ),
  );

  const extra = res.tools.filter((t) => !expectedByName.has(t.name));
  if (extra.length) {
    write("");
    write(red(`  Sözleşmede olmayan ${extra.length} tool: ${extra.map((t) => t.name).join(", ")}`));
  }

  if (diffs.length) {
    write("");
    write(red(bold(`  ${diffs.length} FARK BULUNDU`)));
    write("");
    table(
      ["Tool", "Fark türü", "Ayrıntı"],
      diffs.map((d) => [d.tool, red(d.kind), d.detail]),
    );
    report.ok = false;
  } else {
    write("");
    write(green(bold("  ✔ SÖZLEŞMEYE TAM UYUMLU")));
  }

  report.servers[key] = {
    ok: diffs.length === 0,
    skipped: false,
    serverInfo: res.serverInfo ?? null,
    protocolMode: res.mode,
    protocolVersion: res.protocolVersion ?? null,
    supportedVersions: res.supportedVersions ?? [],
    toolCount: res.tools.length,
    tools: res.tools.map((t) => t.name),
    outputSchemaCount: withOutput,
    listEnvelope: { ttlMs: res.listResult?.ttlMs ?? null, cacheScope: res.listResult?.cacheScope ?? null },
    probeCall: res.callResult
      ? {
          tool: res.callTool,
          hasStructuredContent: Boolean(res.callResult.structuredContent && Object.keys(res.callResult.structuredContent).length),
          textBlocks: (res.callResult.content ?? []).filter((c) => c?.type === "text").length,
          resultType: res.callResult.resultType ?? null,
        }
      : null,
    diffs,
  };
}

// ── Çapraz karşılaştırma (birden çok sunucu doğrulandıysa) ──────────────────
const verified = Object.entries(report.servers).filter(([, v]) => !v.skipped && v.tools);
if (verified.length > 1) {
  write("");
  write(dim("─".repeat(Math.max(80, Math.min(120, OUT.columns || 100)))));
  write(bold("  ÇAPRAZ KARŞILAŞTIRMA — aynı tool üç dilde de var mı?"));
  write("");
  table(
    ["Tool", ...verified.map(([k]) => SERVERS[k].label)],
    expectedTools.map((et) => [
      et.name,
      ...verified.map(([, v]) => (v.tools.includes(et.name) ? green("✔") : red("✘"))),
    ]),
  );

  // Protokol ve çıktı tarafı: "dil bir detaydır" iddiasının ölçüldüğü yer.
  write("");
  write(bold("  ÇAPRAZ KARŞILAŞTIRMA — protokol ve çıktı sözleşmesi"));
  write("");
  table(
    ["", ...verified.map(([k]) => SERVERS[k].label)],
    [
      ["Konuşulan revizyon", ...verified.map(([, v]) => (v.protocolMode === "v2" ? "v2 (2026-07-28)" : "v1 (2025-11-25)"))],
      [
        "outputSchema bildiren tool",
        ...verified.map(([, v]) =>
          v.outputSchemaCount === expectedTools.length
            ? green(`${v.outputSchemaCount}/${expectedTools.length}`)
            : red(`${v.outputSchemaCount}/${expectedTools.length}`),
        ),
      ],
      [
        "structuredContent (gerçek çağrı)",
        ...verified.map(([, v]) =>
          v.probeCall ? (v.probeCall.hasStructuredContent ? green("DOLU") : red("YOK")) : dim("—"),
        ),
      ],
      ["tools/list ttlMs", ...verified.map(([, v]) => String(v.listEnvelope?.ttlMs ?? "—"))],
      ["tools/list cacheScope", ...verified.map(([, v]) => String(v.listEnvelope?.cacheScope ?? "—"))],
      [
        "Tool sırası sözleşmeyle aynı mı?",
        ...verified.map(([, v]) => (v.diffs.some((d) => d.kind === "tools/list sırası") ? red("HAYIR") : green("evet"))),
      ],
    ],
  );
}

// ── Özet ─────────────────────────────────────────────────────────────────────
write("");
write(dim("─".repeat(Math.max(80, Math.min(120, OUT.columns || 100)))));
if (report.ok) {
  write(green(bold("  ✔ TÜM SUNUCULAR SÖZLEŞMEYE UYUMLU.")));
  write(dim("  Aynı tool adları, aynı parametreler, aynı annotation'lar. Dil gerçekten bir detay."));
} else {
  write(red(bold("  ✘ SÖZLEŞME İHLALİ VAR — yukarıdaki farkları giderin.")));
}
write("");

if (JSON_MODE) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exit(report.ok ? 0 : 1);
