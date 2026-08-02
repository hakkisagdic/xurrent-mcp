#!/usr/bin/env node
/**
 * Terminal chatbot.
 *
 * GEMINI_API_KEY gerektirir. Yalnızca MCP sunucusunu bir host uygulamaya
 * (Claude Code, Claude Desktop, Gemini CLI...) takacaksanız GEREKMEZ — o durumda
 * LLM'i host sağlar.
 *
 * Anahtarsız uçtan uca deneme:
 *   node tools/fake-gemini/server.mjs --mod otomatik --port 5100
 *   GEMINI_BASE_URL=http://127.0.0.1:5100 GEMINI_API_KEY=sahte npm run chat
 *
 * Onay (yazma izni) burada readline ile sorulur: LLM'e "onay aldın mı?" diye
 * güvenmeyiz, kullanıcıya doğrudan sorarız.
 */

import { createInterface } from "node:readline/promises";
import { loadConfig } from "../config.js";
import { createToolContext, type ConfirmFn } from "../core/context.js";
import { createGeminiClient } from "../llm/gemini.js";
import { createXurrentAdapter } from "../xurrent/index.js";
import { createAgent } from "./core.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const confirm: ConfirmFn = async (req) => {
    process.stdout.write(`\n${C.yellow}ONAY GEREKLİ${C.reset}\n  ${req.summary}\n`);
    for (const [k, v] of Object.entries(req.fields)) process.stdout.write(`  ${k}: ${v}\n`);
    const answer = (await rl.question(`${C.yellow}  Yazılsın mı? [e/H] ${C.reset}`)).trim().toLowerCase();
    return answer === "e" || answer === "evet" ? { action: "accept" } : { action: "decline" };
  };

  const ctx = createToolContext(cfg, createXurrentAdapter(cfg), confirm);
  const client = createGeminiClient(cfg);
  const agent = createAgent(cfg, ctx, client);

  process.stdout.write(
    `\n${C.bold}Xurrent zaman takibi asistanı${C.reset} ${C.dim}(TypeScript)${C.reset}\n` +
      `${C.dim}Mod: ${cfg.mode} · Strateji: ${cfg.backdateStrategy} · Takvim: ${cfg.calendarProvider} · Model: ${cfg.geminiModel}${C.reset}\n` +
      `${C.dim}LLM: ${client.baseUrl}${C.reset}\n` +
      `${C.dim}Örnek: "bugünkü toplantılarımı Xurrent'a yaz" · Çıkmak için: /q${C.reset}\n\n`,
  );

  // stdin kapandığında (boruyla beslenen betikler, CI) readline artık soru soramaz.
  // Bunu hata olarak değil, oturumun bitişi olarak ele alıyoruz.
  let stdinClosed = false;
  rl.on("close", () => {
    stdinClosed = true;
  });

  for (;;) {
    if (stdinClosed) break;
    let raw: string;
    try {
      raw = await rl.question(`${C.green}sen> ${C.reset}`);
    } catch {
      break; // EOF
    }
    const input = raw.trim();
    if (!input) continue;
    if (input === "/q" || input === "/exit" || input === "/quit") break;

    process.stdout.write(`${C.cyan}bot>${C.reset} `);
    await agent.ask(input, (e) => {
      if (e.type === "text") process.stdout.write(e.delta + "\n");
      else if (e.type === "tool_use")
        process.stdout.write(`${C.dim}  [tool] ${e.name} ${JSON.stringify(e.args)}${C.reset}\n`);
      else if (e.type === "tool_result")
        process.stdout.write(`${C.dim}  [sonuç] ${e.summary ?? e.name} (${e.durationMs} ms)${C.reset}\n`);
      else if (e.type === "error") process.stdout.write(`${C.red}  HATA: ${e.message}${C.reset}\n`);
    });
    process.stdout.write("\n");
  }

  rl.close();
}

main().catch((err) => {
  process.stderr.write(`Chatbot hatası: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
