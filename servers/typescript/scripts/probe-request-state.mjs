#!/usr/bin/env node
/**
 * probe:state — requestState'in GERÇEKTEN bir güvenlik sınırı olduğunu kanıtlar.
 *
 * v2 sunucusunu alt süreç olarak başlatır ve HAM JSON-RPC yazar (hiçbir SDK
 * client'ı araya girmez — saldırganın elindeki serbestlik tam olarak budur).
 * Altı senaryo:
 *
 *   1) onaysız çağrı            → InputRequiredResult + imzalı requestState
 *   2) imza kurcalanmış         → REDDEDİLİR
 *   3) argümanlar değiştirilmiş → REDDEDİLİR (parmak izi)
 *   4) geçerli state + onay     → YAZILIR
 *   5) aynı state tekrar        → REDDEDİLİR (nonce tek kullanımlık)
 *   6) onay reddedildi          → yazılmaz
 *
 * Kullanım:  npm run build && npm run probe:state
 *
 * Onay politikası dışarıdan verilebilir; verilmezse varsayılan "closed" kullanılır:
 *   XURRENT_CONFIRM_POLICY=strict npm run probe:state
 * strict, onayı mock modda da ZORUNLU kılar — aynı altı senaryo, hiçbir gevşeme yok.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const HERE = dirname(fileURLToPath(import.meta.url));
const STDIO_ENTRY = join(HERE, "..", "dist", "mcp", "stdio.js");

// 2026-07-28: zarf HER İSTEKTE gider. Bu üç anahtar ZORUNLUDUR; biri eksikse
// server/discover -32602 ile reddedilir.
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": { elicitation: {} },
  "io.modelcontextprotocol/clientInfo": { name: "state-probe", version: "1.0.0" },
};

const child = spawn(process.execPath, [STDIO_ENTRY], {
  env: {
    ...process.env,
    MCP_PROTOCOL: "2026-07-28",
    XURRENT_MODE: "mock",
    XURRENT_CONFIRM_POLICY: process.env.XURRENT_CONFIRM_POLICY ?? "closed",
  },
  stdio: ["pipe", "pipe", "ignore"],
});

const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const resolve = pending.get(msg.id);
  if (resolve) {
    pending.delete(msg.id);
    resolve(msg);
  }
});

let nextId = 1;
function call(params) {
  const id = nextId++; // MRTR kuralı: her tur YENİ bir JSON-RPC id ile gider.
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { ...params, _meta: META } }) + "\n",
    );
  });
}

const TOOL = "xurrent_create_time_entry";
const ARGS = {
  targetType: "request",
  targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4",
  minutes: 60,
  description: "requestState testi",
  dryRun: false,
};
const ACCEPT = { onay: { action: "accept", content: { onay: true } } };

function head(t) {
  console.log("\n" + "═".repeat(76) + "\n" + t + "\n" + "═".repeat(76));
}

function show(msg) {
  const res = msg.result ?? msg.error;
  if (res?.resultType === "input_required") {
    console.log("resultType   :", res.resultType);
    console.log("inputRequests:", Object.keys(res.inputRequests).join(", "), "→", res.inputRequests.onay.method);
    console.log("requestState :", res.requestState.slice(0, 58) + "…");
    return res.requestState;
  }
  console.log("isError      :", res?.isError === true);
  console.log(
    "metin        :",
    (res?.content?.[0]?.text ?? JSON.stringify(res)).split("\n").slice(0, 2).join("\n               "),
  );
  console.log("timeEntry    :", JSON.stringify(res?.structuredContent?.timeEntry ?? null).slice(0, 90));
  return null;
}

head("1) tools/call — onay yok → InputRequiredResult bekleniyor");
const state = show(await call({ name: TOOL, arguments: ARGS }));

head("2) İMZA KURCALANDI → yazma REDDEDİLMELİ");
// Biçimden bağımsız: imza HER ZAMAN son nokta-parçasıdır (ortak zarf
// "<gövde>.<imza>" — bkz. core/confirm.ts ve fixtures/state-vektorleri.json).
const parts = state.split(".");
const sig = Buffer.from(parts[parts.length - 1], "base64url");
sig[0] ^= 0xff; // imzanın ilk baytını çeviriyoruz
parts[parts.length - 1] = sig.toString("base64url");
show(
  await call({
    name: TOOL,
    arguments: ARGS,
    requestState: parts.join("."),
    inputResponses: ACCEPT,
  }),
);

head("3) GEÇERLİ state, ARGÜMANLAR DEĞİŞTİ (60 → 600 dk) → parmak izi tutmamalı");
show(await call({ name: TOOL, arguments: { ...ARGS, minutes: 600 }, requestState: state, inputResponses: ACCEPT }));

head("4) GEÇERLİ state + doğru argümanlar → YAZMA GERÇEKLEŞMELİ");
show(await call({ name: TOOL, arguments: ARGS, requestState: state, inputResponses: ACCEPT }));

head("5) AYNI state TEKRAR oynatıldı → REDDEDİLMELİ (nonce tek kullanımlık)");
show(await call({ name: TOOL, arguments: ARGS, requestState: state, inputResponses: ACCEPT }));

head("6) Kullanıcı REDDETTİ (action=decline) → yazma olmamalı");
const round6 = await call({ name: TOOL, arguments: ARGS });
show(
  await call({
    name: TOOL,
    arguments: ARGS,
    requestState: round6.result.requestState,
    inputResponses: { onay: { action: "decline" } },
  }),
);

child.kill();
process.exit(0);
