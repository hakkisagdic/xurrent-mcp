/**
 * İKİ PROTOKOL KABUĞU — sihirbazın 13. adımının kancası.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NE YAPAR: Aynı tool'u, aynı argümanlarla, İKİ FARKLI protokol adaptörünün
 * altında GERÇEKTEN çalıştırır ve structuredContent'i döner. Sihirbaz iki çıktıyı
 * karşılaştırır; birebir aynıysa tez kanıtlanmıştır:
 *
 *     "Protokol revizyonu tool sözleşmeni bozmamalı. İş mantığını protokolden
 *      ayırdıysan, breaking change seni ince bir adaptör katmanında yakalar."
 *
 * Burada HİÇBİR ŞEY taklit edilmez: her iki yol da gerçek bir MCP client +
 * gerçek bir MCP server çifti kurar (InMemoryTransport) ve gerçek JSON-RPC
 * mesajları alışverişi yapar. Sahte bir "geçti" üretmek dersin amacını bozardı.
 *
 * v2 tarafında bir incelik var: bare `server.connect(transport)` YALNIZCA
 * 2025-era'yı servis eder. 2026-07-28 era'sını seçen şey `serveStdio`'dur
 * (açılış mesajına bakıp era'yı sabitler). serveStdio kendi transport'unu
 * kabul ettiği için onu InMemoryTransport ile besliyoruz — süreç içi, ağsız,
 * ama protokol olarak tamamen gerçek.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport as InMemoryV1 } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport as InMemoryV2 } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Client as ClientV2 } from "@modelcontextprotocol/client";
import type { ToolContext } from "../core/context.js";
import { createV1Server, PROTOCOL_VERSION as V1 } from "./v1/server.js";
import { createV2Server, PROTOCOL_VERSION as V2 } from "./v2/server.js";

/** Bu implementasyonda kurulu olan protokol adaptörleri. Sihirbaz bunu okur. */
export const AVAILABLE_PROTOCOLS: string[] = [V1, V2];

const CLIENT_INFO = { name: "xurrent-protocol-probe", version: "1.0.0" } as const;

/** Onay sorulursa otomatik kabul — karşılaştırma senaryosu dryRun olduğu için normalde çağrılmaz. */
const AUTO_ACCEPT = { action: "accept" as const, content: { onay: true } };

async function runV1(ctx: ToolContext, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const { server } = createV1Server(ctx.cfg);
  const [clientTransport, serverTransport] = InMemoryV1.createLinkedPair();
  const client = new ClientV1(CLIENT_INFO, { capabilities: { elicitation: {} } });
  client.setRequestHandler(ElicitRequestSchema, async () => AUTO_ACCEPT);

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    return (res as { structuredContent?: unknown }).structuredContent ?? null;
  } finally {
    await client.close();
    await server.close();
  }
}

async function runV2(ctx: ToolContext, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const [clientTransport, serverTransport] = InMemoryV2.createLinkedPair();
  // serveStdio era seçimini üstlenir: 2026-07-28 zarflı bir açılış gelirse
  // modern era'ya sabitlenir. Transport'u biz veriyoruz → süreç içi çalışır.
  const handle = serveStdio(() => createV2Server(ctx.cfg).server, { transport: serverTransport });

  const client = new ClientV2(CLIENT_INFO, {
    capabilities: { elicitation: {} },
    // PIN: geri düşme YOK. 2026-07-28 konuşulamıyorsa adım sessizce v1'e kaymasın,
    // gürültülü biçimde patlasın — sahte bir "geçti" üretmemenin bedeli budur.
    versionNegotiation: { mode: { pin: V2 } },
  });
  client.setRequestHandler("elicitation/create", async () => AUTO_ACCEPT);

  await client.connect(clientTransport);
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    return (res as { structuredContent?: unknown }).structuredContent ?? null;
  } finally {
    await client.close();
    await handle.close();
  }
}

/**
 * Bir tool'u verilen protokol revizyonu altında çalıştırır ve structuredContent döner.
 * Sihirbaz (src/wizard.ts) bu modülü DİNAMİK import eder.
 */
export async function runUnderProtocol(
  ctx: ToolContext,
  protocol: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  if (protocol === V1) return runV1(ctx, toolName, args);
  if (protocol === V2) return runV2(ctx, toolName, args);
  throw new Error(`Bilinmeyen protokol revizyonu: ${protocol}. Kurulu olanlar: ${AVAILABLE_PROTOCOLS.join(", ")}`);
}
