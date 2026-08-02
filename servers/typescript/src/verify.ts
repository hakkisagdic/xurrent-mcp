#!/usr/bin/env node
/**
 * Sözleşme doğrulaması.
 *
 * GERÇEK bir MCP client kurar (InMemoryTransport), tools/list çağırır ve çıkan
 * şemayı contract/tools.json'a karşı doğrular. Yani "kodda öyle yazıyor" değil,
 * "protokolden öyle geliyor" kontrol edilir.
 *
 * Kontroller:
 *   1. Tool sayısı ve adları birebir aynı mı?
 *   2. Her tool'un input alan adları sözleşmedekilerle örtüşüyor mu?
 *   3. annotations (readOnlyHint vb.) sözleşmedeki değerlerle aynı mı?
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { createV1Server } from "./mcp/v1/server.js";

interface ContractTool {
  name: string;
  annotations?: Record<string, boolean>;
  input?: { properties?: Record<string, unknown> };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const contract = JSON.parse(
    readFileSync(join(cfg.repoRoot, "contract", "tools.json"), "utf8"),
  ) as { tools: ContractTool[] };

  const { server } = createV1Server(cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "xurrent-contract-verifier", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const listed = await client.listTools();
  const problems: string[] = [];
  const outLines: string[] = [];

  const expected = contract.tools.map((t) => t.name).sort();
  const actual = listed.tools.map((t) => t.name).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    problems.push(`Tool listesi uyuşmuyor.\n  beklenen: ${expected.join(", ")}\n  gelen   : ${actual.join(", ")}`);
  }

  for (const ct of contract.tools) {
    const at = listed.tools.find((t) => t.name === ct.name);
    if (!at) {
      problems.push(`Eksik tool: ${ct.name}`);
      continue;
    }

    const expectedProps = Object.keys(ct.input?.properties ?? {}).sort();
    const actualProps = Object.keys(
      (at.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
    ).sort();
    const missing = expectedProps.filter((p) => !actualProps.includes(p));
    const extra = actualProps.filter((p) => !expectedProps.includes(p));
    if (missing.length) problems.push(`${ct.name}: eksik input alanı → ${missing.join(", ")}`);
    if (extra.length) problems.push(`${ct.name}: sözleşmede olmayan input alanı → ${extra.join(", ")}`);

    for (const [key, value] of Object.entries(ct.annotations ?? {})) {
      const got = (at.annotations as Record<string, unknown> | undefined)?.[key];
      if (got !== value) problems.push(`${ct.name}: annotations.${key} beklenen ${value}, gelen ${got}`);
    }

    outLines.push(
      `  ${problems.length === 0 || !problems.some((p) => p.startsWith(ct.name)) ? "✓" : "✖"} ${ct.name}` +
        `  (${actualProps.length} input alanı)`,
    );
  }

  process.stdout.write(`\nSözleşme: contract/tools.json (${contract.tools.length} tool)\n`);
  process.stdout.write(`Sunucu  : tools/list → ${listed.tools.length} tool\n\n`);
  process.stdout.write(outLines.join("\n") + "\n\n");

  if (problems.length) {
    process.stdout.write("SÖZLEŞME İHLALLERİ:\n" + problems.map((p) => "  ✖ " + p).join("\n") + "\n\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("SÖZLEŞME UYUMLU — tool adları, input alanları ve annotations birebir eşleşiyor.\n\n");
  }

  await client.close();
  await server.close();
}

main().catch((err) => {
  process.stderr.write(`Doğrulama hatası: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
