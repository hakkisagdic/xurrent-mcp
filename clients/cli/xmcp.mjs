#!/usr/bin/env node
// -----------------------------------------------------------------------------
// xmcp — xurrent-mcp'nin bağımsız MCP istemci CLI'ı
//
// NE OLDUĞU: Ham stdio JSON-RPC konuşan, ÇİFT ERA'lı (2026-07-28 ve 2025-11-25)
// bir MCP client'ı + timesheet_wizard için Ink TUI'li ince sohbet host'u.
// "İstemci de dilden bağımsızdır" tezinin dördüncü kanıtı: wizard (SDK'lı),
// inspector (tarayıcı), Claude Code (.mcp.json) ve şimdi xmcp (SDK'sız, ham tel).
//
// NEDEN SDK YOK: iki revizyonu aynı koddan konuşmak dersin kendisidir —
// bkz. lib/rpc.mjs ve contract/protocol.md.
//
// KULLANIM
//   xmcp tools        [--server ts|py|cs] [--era 2026|2025] [--json]
//   xmcp call <tool>  [--args '<json>'] [--dry-run] [...]
//   xmcp chat         [--script "cevap1\ncevap2..."] [...]
//   xmcp probe        [--json] [...]
//   xmcp conformance  [--json]
// -----------------------------------------------------------------------------

import path from "node:path";
import readline from "node:readline";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  McpClient,
  RpcError,
  serverDefs,
  buildChildEnv,
  extractStructured,
  isFailure,
  fillSchemaDefaults,
  V2_VERSION,
  V1_VERSION,
} from "./lib/rpc.mjs";
import {
  makePaint,
  renderTable,
  termWidth,
  firstSentence,
  annotationSummary,
  writeResultLines,
  wrapText,
} from "./lib/format.mjs";

// clients/cli/xmcp.mjs → repo kökü iki seviye yukarıda.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// ── Argüman ayrıştırma ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    verb: null,
    tool: null, // call <tool>
    server: "ts",
    exec: null,
    era: "auto", // auto | 2026 | 2025
    json: false,
    color: true,
    timeout: null,
    args: null, // call --args
    dryRun: false,
    script: null, // chat --script
    help: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    switch (t) {
      case "--server":
      case "-s":
        a.server = String(argv[++i] ?? "").toLowerCase();
        break;
      case "--exec":
        a.exec = String(argv[++i] ?? "");
        break;
      case "--era":
        a.era = String(argv[++i] ?? "").trim();
        break;
      case "--json":
        a.json = true;
        break;
      case "--no-color":
        a.color = false;
        break;
      case "--timeout":
        a.timeout = Number(argv[++i]);
        break;
      case "--args":
        a.args = String(argv[++i] ?? "");
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "--script":
        a.script = String(argv[++i] ?? "");
        break;
      case "--help":
      case "-h":
        a.help = true;
        break;
      default:
        if (t.startsWith("--server=")) a.server = t.slice(9).toLowerCase();
        else if (t.startsWith("--era=")) a.era = t.slice(6).trim();
        else if (t.startsWith("--args=")) a.args = t.slice(7);
        else if (t.startsWith("--script=")) a.script = t.slice(9);
        else if (t.startsWith("--exec=")) a.exec = t.slice(7);
        else if (t.startsWith("--timeout=")) a.timeout = Number(t.slice(10));
        else if (t.startsWith("-")) {
          process.stderr.write(`Bilinmeyen parametre: ${t}\n`);
          process.exit(2);
        } else positional.push(t);
    }
  }
  a.verb = positional[0] ?? null;
  a.tool = positional[1] ?? null;
  if (a.era === "2026-07-28") a.era = "2026";
  if (a.era === "2025-11-25") a.era = "2025";
  return a;
}

const args = parseArgs(process.argv.slice(2));

// --json modunda STDOUT yalnızca makine-okunur çıktı içindir; insan anlatısı
// stderr'e gider (repo disiplini — aynı kural MCP stdio'sunda da geçerli).
const OUT = args.json ? process.stderr : process.stdout;
const USE_COLOR =
  args.color && !process.env.NO_COLOR && (args.json ? process.stderr.isTTY : process.stdout.isTTY);
const { C, paint } = makePaint(USE_COLOR);
const write = (s = "") => OUT.write(s + "\n");
const emitJson = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + "\n");

// ── Yardım ──────────────────────────────────────────────────────────────────
function printHelp() {
  process.stdout.write(
    [
      "",
      paint(C.bold + C.cyan, "xmcp") + paint(C.gray, " — çift-era ham JSON-RPC MCP istemcisi + Ink TUI sohbet"),
      "",
      paint(C.bold, "KULLANIM"),
      "  xmcp <fiil> [seçenekler]",
      "",
      paint(C.bold, "FİİLLER"),
      "  tools                    tools/list → tablo (isim, tür, açıklama)",
      "  call <tool>              tools/call → structuredContent; errors[] doluysa çıkış 1",
      "  chat                     timesheet_wizard'ı süren ince sohbet host'u (TTY'de Ink TUI)",
      "  probe                    era/yetenek raporu: server/discover + initialize sondaları",
      "  conformance              verify-contract --all + mcp-uyum sarmalayıcısı",
      "",
      paint(C.bold, "ORTAK SEÇENEKLER"),
      "  -s, --server <ts|py|cs>  Spawn edilecek sunucu (varsayılan: ts)",
      '      --exec "<komut>"     Üçü dışında bir MCP sunucu komutu (gelişmiş)',
      "      --era <2026|2025>    Protokol revizyonunu sabitle. Varsayılan: auto —",
      "                           server/discover denenir, -32601'de initialize'a düşülür",
      "      --timeout <ms>       İstek başına zaman aşımı (varsayılan 60000; cs 180000)",
      "      --json               STDOUT'a ham/makine-okunur çıktı; anlatı stderr'e",
      "      --no-color           ANSI renklerini kapat",
      "",
      paint(C.bold, "FİİLE ÖZEL"),
      "  call:  --args '<json>'   Tool argümanları (JSON nesnesi)",
      "         --dry-run         Argümanlara {\"dryRun\":true} ekler — hiçbir mutation gitmez",
      '  chat:  --script "c1\\nc2" Cevapları satır satır bu metinden okur (test/CI modu);',
      "                           TTY yoksa da düz moda düşülür ve stdin satırları okunur",
      "",
      paint(C.bold, "ÖRNEKLER"),
      "  xmcp tools --server ts",
      "  xmcp call xurrent_whoami --server py",
      '  xmcp call xurrent_create_time_entry --server ts --dry-run \\',
      '       --args \'{"targetType":"time_allocation","targetId":"...","minutes":30}\'',
      "  xmcp chat --server ts",
      '  xmcp chat --server py --script "1\\n2 saat\\ndün 14:00 deneme\\ntwo_step\\nevet"',
      "  xmcp probe --server cs --json",
      "  xmcp call xurrent_whoami --server ts --era 2025   # v1 el sıkışmasıyla",
      "",
      paint(C.bold, "ÇIKIŞ KODLARI"),
      "  0  başarı · 1  hata/isError/errors dolu · 2  hatalı parametre",
      "",
      paint(C.gray, "Era farkının tamamı: contract/protocol.md · sohbet sözleşmesi: contract/wizard.md"),
      "",
    ].join("\n"),
  );
}

// ── Sunucu seçimi + bağlanma ────────────────────────────────────────────────
function resolveServer() {
  if (args.exec) {
    const parts = args.exec.split(/\s+/).filter(Boolean);
    if (!parts.length) {
      process.stderr.write("HATA: --exec boş.\n");
      process.exit(2);
    }
    return { label: `özel (${parts[0]})`, command: parts[0], args: parts.slice(1), defaultTimeout: 60000 };
  }
  const srv = serverDefs(ROOT)[args.server];
  if (!srv) {
    process.stderr.write(`HATA: bilinmeyen sunucu "${args.server}". Geçerli değerler: ts, py, cs\n`);
    process.exit(2);
  }
  return srv;
}

/**
 * Terminal elicitation/onay istemi. v1'de sunucu-başlatmalı elicitation/create,
 * v2'de MRTR inputRequest'i buraya düşer — kullanıcıya SORULUR, LLM'e değil.
 * TTY yoksa dürüstçe decline edilir (sessiz kabul, onay mimarisini deler).
 */
async function terminalElicit({ message, requestedSchema }) {
  write("");
  write(paint(C.yellow + C.bold, "┏━ ONAY İSTEĞİ (sunucudan) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  for (const ln of wrapText(message, termWidth(OUT) - 4)) write(paint(C.yellow, "┃ " + ln));
  write(paint(C.yellow + C.bold, "┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  if (!process.stdin.isTTY) {
    write(paint(C.red, "TTY yok — onay sorulamıyor, istek REDDEDİLİYOR (fail-closed)."));
    return { action: "decline" };
  }
  const rl = readline.createInterface({ input: process.stdin, output: OUT });
  const answer = await new Promise((res) => rl.question(paint(C.yellow, "Onaylıyor musun? [e/H] "), res));
  rl.close();
  const yes = ["e", "evet", "y", "yes", "1"].includes(answer.trim().toLowerCase());
  if (!yes) return { action: "decline" };
  return { action: "accept", content: fillSchemaDefaults(requestedSchema) };
}

/** Sunucuyu başlatır, era pazarlığını yapar, bağlı istemciyi döner. */
async function connect({ quiet = false } = {}) {
  const srv = resolveServer();
  const env = buildChildEnv(ROOT);
  // Era sabitlenmişse sunucuya da söylenir: stdio'da tek süreç TEK protokol
  // konuşur (MCP_PROTOCOL, bkz. contract/protocol.md). auto'da dokunulmaz —
  // sunucu varsayılanıyla açılır, sonda hangisini konuştuğunu bulur.
  if (args.era === "2026") env.MCP_PROTOCOL = V2_VERSION;
  else if (args.era === "2025") env.MCP_PROTOCOL = V1_VERSION;
  else if (args.era !== "auto") {
    process.stderr.write(`HATA: --era "${args.era}" geçersiz. Geçerli değerler: 2026, 2025 (veya auto).\n`);
    process.exit(2);
  }
  const client = new McpClient({
    srv,
    cwd: ROOT,
    env,
    timeoutMs: args.timeout ?? srv.defaultTimeout,
    onElicit: terminalElicit,
  }).start();
  const opened = await client.open(args.era);
  if (!quiet) {
    write(
      paint(C.gray, `sunucu: ${srv.label} · era: `) +
        paint(C.bold, client.protocolVersion) +
        paint(C.gray, ` (${opened.method})`),
    );
  }
  return { client, srv, opened };
}

// ── FİİL: tools ─────────────────────────────────────────────────────────────
async function verbTools() {
  const { client } = await connect({ quiet: args.json });
  try {
    const res = await client.listTools();
    const tools = res?.tools ?? [];
    if (args.json) {
      emitJson(res);
      return 0;
    }
    const rows = tools.map((t) => [
      paint(C.cyan, t.name),
      annotationSummary(t),
      firstSentence(t.description),
    ]);
    for (const line of renderTable(["tool", "tür", "açıklama"], rows, { maxWidth: termWidth(OUT), paint, C }))
      write(line);
    write(paint(C.gray, `${tools.length} tool · ttlMs=${res?.ttlMs ?? "(yok)"} · cacheScope=${res?.cacheScope ?? "(yok)"}`));
    return 0;
  } finally {
    client.close();
  }
}

// ── FİİL: call ──────────────────────────────────────────────────────────────
async function verbCall() {
  if (!args.tool) {
    process.stderr.write("HATA: xmcp call <tool> — tool adı gerekli. (xmcp tools ile listeleyin)\n");
    return 2;
  }
  let toolArgs = {};
  if (args.args) {
    try {
      toolArgs = JSON.parse(args.args);
      if (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
        throw new Error("JSON nesnesi bekleniyor");
      }
    } catch (e) {
      process.stderr.write(`HATA: --args JSON olarak ayrıştırılamadı: ${e.message}\n`);
      return 2;
    }
  }
  if (args.dryRun) toolArgs = { ...toolArgs, dryRun: true };

  const { client } = await connect({ quiet: args.json });
  try {
    const result = await client.callTool(args.tool, toolArgs);
    const failed = isFailure(result);
    if (args.json) {
      emitJson(result);
    } else {
      const { data, text } = extractStructured(result);
      if (data) write(JSON.stringify(data, null, 2));
      else write(text ?? "(boş yanıt)");
      if (result?.isError) write(paint(C.red + C.bold, "isError: true"));
      const errs = data?.errors ?? [];
      if (errs.length) {
        for (const e of errs) write(paint(C.red, `HATA: ${e?.message ?? JSON.stringify(e)}`));
      }
      write(
        failed
          ? paint(C.red + C.bold, "SONUÇ: BAŞARISIZ (errors[] dolu veya isError=true → çıkış 1)")
          : paint(C.green, "SONUÇ: BAŞARILI"),
      );
    }
    return failed ? 1 : 0;
  } finally {
    client.close();
  }
}

// ── FİİL: chat ──────────────────────────────────────────────────────────────
function splitScript(s) {
  // Gerçek satır sonları VE kaçışlı "\n" — ikisi de kabul (shell alışkanlıkları değişir).
  return s
    .split(/\r?\n|\\n/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

/**
 * stdin'i satır kuyruğuna çevirir. readline.question() burada KULLANILMAZ:
 * borulanmış stdin'de EOF, soru sorulmadan önce gelir ve tamponlanmış satırlar
 * use-after-close hatasıyla kaybolur. Kuyruk hem erken gelen satırları saklar
 * hem de kapanıştan sonra null döner (= girdi bitti).
 */
function makeStdinLines() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on("line", (l) => {
    const w = waiters.shift();
    if (w) w(l);
    else queue.push(l);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiters.splice(0)) w(null);
  });
  return {
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : closed
          ? Promise.resolve(null)
          : new Promise((r) => waiters.push(r)),
    close: () => rl.close(),
  };
}

async function chatPlain(client, script) {
  // Düz mod: CI'ın ve boruların modu. Her tur: reply + soru bas, cevabı script'ten
  // ya da stdin'den al, utterance + sessionState'i AYNEN geri gönder. İnce host'un
  // tüm sözleşmesi bu döngüdür (contract/wizard.md §5).
  const turns = [];
  let stdinLines = null;
  const nextAnswer = async () => {
    if (script) return script.shift() ?? null;
    if (!stdinLines) stdinLines = makeStdinLines();
    return stdinLines.next();
  };

  try {
    let result = await client.callTool("timesheet_wizard", {});
    for (let turn = 0; turn < 60; turn++) {
      const { data } = extractStructured(result);
      if (!data) {
        write(paint(C.red, "HATA: wizard yanıtı ayrıştırılamadı."));
        return 1;
      }
      turns.push(data);
      write("");
      write(paint(C.gray, `[${data.step}]`) + " " + paint(C.cyan, data.reply ?? ""));
      for (const e of data.errors ?? []) write(paint(C.red, `  hata: ${e?.message ?? JSON.stringify(e)}`));

      if (data.done) {
        write("");
        if (data.writeResult) {
          write(paint(C.bold, "── Yazma sonucu ──"));
          for (const ln of writeResultLines(data.writeResult)) write("  " + ln);
        }
        if (args.json) emitJson({ turns, writeResult: data.writeResult ?? null });
        const bad = (data.writeResult?.errors ?? []).length > 0;
        return bad ? 1 : 0;
      }

      const q = data.nextQuestion;
      if (q) {
        write(paint(C.bold, `  soru: ${q.prompt}`));
        for (const [i, ch] of (q.choices ?? []).entries()) {
          write(`   ${i + 1}) ${ch.label}` + (ch.detail ? paint(C.gray, ` — ${ch.detail}`) : ""));
        }
      }
      const answer = await nextAnswer();
      if (answer == null) {
        write(paint(C.red, script ? "HATA: script tükendi, sohbet bitmedi." : "HATA: stdin kapandı, sohbet bitmedi."));
        return 1;
      }
      write(paint(C.green, `> ${answer}`));
      // ★ İnce host sözleşmesi: sessionState AYNEN geri gönderilir; imzalı ve
      //   opaktır — içine bakmayız, değiştirmeyiz (contract/wizard.md §4).
      result = await client.callTool("timesheet_wizard", { utterance: answer, sessionState: data.sessionState });
    }
    write(paint(C.red, "HATA: 60 turda done=true'ya ulaşılamadı — döngü kesildi."));
    return 1;
  } finally {
    if (stdinLines) stdinLines.close();
  }
}

async function verbChat() {
  const script = args.script != null ? splitScript(args.script) : null;
  const useTui = !script && process.stdin.isTTY && process.stdout.isTTY && !args.json;
  const { client, srv } = await connect({ quiet: useTui || args.json });
  try {
    if (useTui) {
      const { runChatTui } = await import("./lib/tui.mjs");
      return await runChatTui({ client, serverLabel: srv.label });
    }
    return await chatPlain(client, script);
  } finally {
    client.close();
  }
}

// ── FİİL: probe ─────────────────────────────────────────────────────────────
// İki KISA ÖMÜRLÜ süreçle iki era ayrı ayrı yoklanır. Aynı süreçte ikisini
// denemek yanıltır: bağlantı ilk mesajla bir era'ya sabitlenir (wizard.mjs'in
// ölçtüğü gerçek). Sunucu ortamına DOKUNULMAZ — varsayılanı neyi kabul ediyor,
// onu raporlarız.
async function verbProbe() {
  const srv = resolveServer();
  const env = buildChildEnv(ROOT);
  const timeoutMs = args.timeout ?? srv.defaultTimeout;
  const report = {
    server: args.exec ? "exec" : args.server,
    label: srv.label,
    v2: { supported: false, detail: null, supportedVersions: [] },
    v1: { supported: false, detail: null, protocolVersion: null },
    serverInfo: null,
    toolCount: null,
  };

  // 1. sonda — v2: server/discover (_meta İLE; onsuz -32601/-32602 yanıltır).
  {
    const c = new McpClient({ srv, cwd: ROOT, env, timeoutMs }).start();
    try {
      await c.open("2026");
      report.v2.supported = true;
      report.v2.supportedVersions = c.supportedVersions;
      report.v2.detail = `server/discover kabul edildi — supportedVersions=${JSON.stringify(c.supportedVersions)}`;
      report.serverInfo = c.serverInfo ?? report.serverInfo;
      const res = await c.listTools();
      report.toolCount = (res?.tools ?? []).length;
    } catch (e) {
      report.v2.detail = e.message;
    } finally {
      c.close();
    }
  }

  // 2. sonda — v1: TAZE süreçte düz initialize el sıkışması.
  {
    const c = new McpClient({ srv, cwd: ROOT, env, timeoutMs }).start();
    try {
      await c.open("2025");
      report.v1.supported = true;
      report.v1.protocolVersion = c.protocolVersion;
      report.v1.detail = `initialize kabul edildi (sunucu: ${c.protocolVersion})`;
      report.serverInfo = report.serverInfo ?? c.serverInfo;
      if (report.toolCount == null) {
        const res = await c.listTools();
        report.toolCount = (res?.tools ?? []).length;
      }
    } catch (e) {
      report.v1.detail = e.message;
    } finally {
      c.close();
    }
  }

  const eras = [
    ...(report.v2.supported ? [V2_VERSION] : []),
    ...(report.v1.supported ? [V1_VERSION] : []),
  ];
  report.eras = eras;

  if (args.json) {
    emitJson(report);
  } else {
    write(paint(C.bold, `Sunucu: ${srv.label}` + (args.exec ? "" : ` (--server ${args.server})`)));
    const mark = (ok) => (ok ? paint(C.green, "✔") : paint(C.red, "✘"));
    write(`  ${mark(report.v2.supported)} v2 ${V2_VERSION} — ${report.v2.detail}`);
    write(`  ${mark(report.v1.supported)} v1 ${V1_VERSION} — ${report.v1.detail}`);
    if (report.serverInfo) {
      write(paint(C.gray, `  serverInfo: ${report.serverInfo.name ?? "?"} ${report.serverInfo.version ?? ""}`));
    }
    write(paint(C.gray, `  tool sayısı: ${report.toolCount ?? "?"}`));
    write(
      paint(C.bold, "Konuşulan era(lar): ") +
        (eras.length ? eras.join(", ") : paint(C.red, "hiçbiri — sunucu erişilemez olabilir")),
    );
  }
  return eras.length ? 0 : 1;
}

// ── FİİL: conformance ───────────────────────────────────────────────────────
// İnce sarmalayıcı: sözleşme + protokol uyum denetimlerinin tek kapısı.
// Çıktılar olduğu gibi akar (inherit); --json her iki script'e de geçirilir.
function verbConformance() {
  const steps = [
    ["node", [path.join(ROOT, "scripts", "verify-contract.mjs"), "--all", ...(args.json ? ["--json"] : [])]],
    ["node", [path.join(ROOT, "scripts", "mcp-uyum.mjs"), "--hepsi", ...(args.json ? ["--json"] : [])]],
  ];
  let failed = false;
  for (const [cmd, argv] of steps) {
    // Yalnızca MUTLAK yollar kısaltılır; "--all" gibi bayraklar path.relative'e
    // sokulursa cwd'ye göre yanlış bir "yol"a dönüşür (clients/cli/--all).
    const shown = argv.map((a) => (path.isAbsolute(a) ? path.relative(ROOT, a) : a));
    write(paint(C.bold + C.blue, `\n▶ ${[cmd, ...shown].join(" ")}`));
    const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) {
      failed = true;
      write(paint(C.red, `✘ çıkış kodu ${r.status ?? "?"}`));
    }
  }
  return failed ? 1 : 0;
}

// ── Ana akış ────────────────────────────────────────────────────────────────
async function main() {
  if (args.help || !args.verb) {
    printHelp();
    return args.verb ? 0 : 2;
  }
  switch (args.verb) {
    case "tools":
      return verbTools();
    case "call":
      return verbCall();
    case "chat":
      return verbChat();
    case "probe":
      return verbProbe();
    case "conformance":
      return verbConformance();
    default:
      process.stderr.write(`HATA: bilinmeyen fiil "${args.verb}". Geçerli: tools, call, chat, probe, conformance\n`);
      return 2;
  }
}

// ★ process.exit() ÇAĞRILMAZ: borulanmış stdout'ta kuyruktaki yazımları KESER
//   (--json çıktısı yarıda kalır). Bunun yerine exitCode set edilir ve döngünün
//   doğal boşalması beklenir; çocuk süreç inat ederse unref'li emniyet sayacı
//   3 sn sonra zorla çıkar — sayaç unref'li olduğu için normalde süre EKLEMEZ.
function finish(code) {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
}

main()
  .then((code) => finish(code ?? 0))
  .catch((e) => {
    if (e instanceof RpcError) process.stderr.write(paint(C.red, `HATA: ${e.message}`) + "\n");
    else process.stderr.write(paint(C.red, `BEKLENMEYEN HATA: ${e?.stack ?? e}`) + "\n");
    finish(1);
  });
