/**
 * v1 ADAPTÖRÜ — protokol revizyonu 2025-11-25.
 * Paket: @modelcontextprotocol/sdk@1.30.0
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONAY BURADA SUNUCU-BAŞLATMALI BİR İSTEKTİR:
 *
 *   client ──── tools/call ─────────────────▶ server
 *   client ◀─── elicitation/create ───────── server   ← sunucu İSTEK gönderiyor
 *   client ──── ElicitResult ──────────────▶ server
 *   client ◀─── CallToolResult ───────────── server
 *
 * Sunucu, işlemin ORTASINDA client'a bir istek gönderir. Bu kalıcı, çift yönlü
 * bir bağlantı gerektirir — yani sunucu STATEFUL'dur. 2026-07-28 revizyonu tam
 * olarak bunu kaldırdı (bkz. ../v2/server.ts).
 *
 * Çekirdek bu farkı GÖRMEZ: core/toolimpl.ts { kind: "confirm" } döner, bu
 * dosya onu elicitInput'a çevirir. Tool sözleşmesi DEĞİŞMEZ.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type AppConfig } from "../../config.js";
import { createToolContext, type ConfirmOutcome, type ToolContext } from "../../core/context.js";
import { failure, ok, type ToolResult } from "../../core/result.js";
import { runToolCore, TOOL_SPECS, type ToolOutcome } from "../../core/toolimpl.js";
import { log } from "../../util/log.js";
import { createXurrentAdapter } from "../../xurrent/index.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS } from "../shared.js";

export const PROTOCOL_VERSION = "2025-11-25";

/**
 * ToolOutcome'un "confirm" hâlini protokole çevirir: elicitation/create.
 * Client bu yeteneği bildirmemişse "unsupported" döner ve politika devreye girer
 * (core/context.ts → resolveUnsupportedConfirm):
 *   open   → onaysız devam (bu dala zaten gelinmez; çekirdek "confirm" dönmez)
 *   closed → mock'ta uyarıyla devam, live'da RED
 *   strict → mock'ta BİLE RED
 */
async function askViaElicitation(server: McpServer, outcome: Extract<ToolOutcome, { kind: "confirm" }>): Promise<ConfirmOutcome> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation) return { action: "unsupported" };

  const detail = Object.entries(outcome.prompt.fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  try {
    const res = await server.server.elicitInput({
      message: `${outcome.prompt.summary}\n\n${detail}\n\nOnaylıyor musunuz?`,
      // requestedSchema DÜZ JSON Schema'dır — Zod DEĞİL ve İÇ İÇE NESNE İÇEREMEZ.
      // Spec yalnızca ilkel alanlara (string/number/boolean/enum) izin verir.
      requestedSchema: outcome.schema as never,
    });

    // Üç action'ın ÜÇÜ DE ele alınır. accept + onay=false da bir REDDİR.
    if (res.action === "accept") {
      const content = res.content as Record<string, unknown> | undefined;
      if (content?.["onay"] === true) return { action: "accept" };
      const reason = content?.["gerekce"];
      return { action: "decline", ...(typeof reason === "string" && reason ? { reason } : {}) };
    }
    if (res.action === "decline") return { action: "decline" };
    return { action: "cancel" };
  } catch (err) {
    log.warn("elicitation başarısız", { error: err instanceof Error ? err.message : String(err) });
    return { action: "unsupported" };
  }
}

function toToolResult(outcome: Extract<ToolOutcome, { kind: "ok" }>): ToolResult {
  return outcome.isError ? failure(outcome.text, outcome.structured) : ok(outcome.text, outcome.structured);
}

export function createV1Server(cfg: AppConfig = loadConfig()): { server: McpServer; ctx: ToolContext } {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {}, logging: {} },
    instructions: SERVER_INSTRUCTIONS,
  });

  const xurrent = createXurrentAdapter(cfg);
  // ctx.confirm bu yolda KULLANILMAZ — onay adaptörde, elicitation ile alınır.
  // Yine de bir değer gerekiyor: protokolün soramadığı durumu "unsupported" say.
  const ctx = createToolContext(cfg, xurrent, async () => ({ action: "unsupported" }));

  // Sözleşmedeki SIRA korunur (contract/tools.json): 4 okuma, 2 yazma, 1 takvim, 1 önizleme.
  for (const spec of TOOL_SPECS) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        outputSchema: spec.outputSchema,
        annotations: spec.annotations,
      },
      async (args: Record<string, unknown>, extra): Promise<ToolResult> => {
        const first = await runToolCore(ctx, spec.name, args, undefined, extra?.signal);
        if (first.kind === "ok") return toToolResult(first);

        // Onay gerekiyor → protokol seviyesinde SOR, sonra AYNI çağrıyı tekrarla.
        // Onayı LLM'e bırakmıyoruz: LLM ikna edilebilir, protokol seviyesindeki onay edilemez.
        const decision = await askViaElicitation(server, first);
        const second = await runToolCore(ctx, spec.name, first.resume.args, decision, extra?.signal);
        if (second.kind !== "ok") {
          // Çekirdek iki kez üst üste onay istemez; istese bile burada durulur.
          return failure("Onay döngüsü çözülemedi — hiçbir şey yazılmadı.", {
            errors: [{ message: "Onay döngüsü çözülemedi." }],
          });
        }
        return toToolResult(second);
      },
    );
  }

  log.info("MCP sunucusu hazır (v1 / 2025-11-25)", {
    mode: cfg.mode,
    strategy: cfg.backdateStrategy,
    calendar: cfg.calendarProvider,
    timeZone: cfg.timeZone,
    dryRun: cfg.forceDryRun,
    confirmPolicy: cfg.confirmPolicy,
  });

  return { server, ctx };
}
