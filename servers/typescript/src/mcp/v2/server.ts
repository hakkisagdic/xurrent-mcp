/**
 * v2 ADAPTÖRÜ — protokol revizyonu 2026-07-28.
 * Paketler: @modelcontextprotocol/{core,server,client}@2.0.0
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONAY BURADA BİR SONUÇTUR, İSTEK DEĞİL — MRTR (Multi Round-Trip Requests):
 *
 *   client ──── tools/call (id:1) ─────────▶ server
 *   client ◀─── InputRequiredResult ──────── server   ← bu bir SONUÇ
 *          ── kullanıcıya sorulur ──
 *   client ──── tools/call (id:2) ─────────▶ server   ← AYNI istek, YENİ id
 *                 + inputResponses + requestState
 *   client ◀─── CallToolResult ───────────── server
 *
 * İlk istek SONLANIR. Sunucu hiçbir state tutmaz; ihtiyacı olan her şeyi
 * requestState'e kodlar ve client onu geri getirir. Bu yüzden requestState
 * BİR GÜVENLİK SINIRIDIR ve HMAC-SHA256 ile imzalanır (core/confirm.ts).
 *
 * NEDEN paketler yan yana durabiliyor: v1 paketinin adı
 * @modelcontextprotocol/sdk, v2'ninki @modelcontextprotocol/server.
 * FARKLI paket adları → aynı node_modules'da çakışmadan yaşarlar.
 * (C#'ta aynı paket ID olduğu için üç proje, Python'da aynı paket adı olduğu
 * için ayrı ortam gerekir — aynı problem, üç ekosistemde üç çözüm.)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  acceptedContent,
  inputRequired,
  inputResponse,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { loadConfig, type AppConfig } from "../../config.js";
import { signRequestState, verifyRequestState } from "../../core/confirm.js";
import {
  createToolContext,
  resolveUnsupportedConfirm,
  type ConfirmOutcome,
  type ToolContext,
} from "../../core/context.js";
import { failure, ok, type ToolResult } from "../../core/result.js";
import { runToolCore, TOOL_SPECS, type ToolOutcome } from "../../core/toolimpl.js";
import { log } from "../../util/log.js";
import { createXurrentAdapter } from "../../xurrent/index.js";
import { CACHE_SCOPE, CACHE_TTL_MS, SERVER_INFO, SERVER_INSTRUCTIONS } from "../shared.js";

export const PROTOCOL_VERSION = "2026-07-28";

/** inputRequests içindeki anahtar — cevap bu anahtarla geri gelir. */
const CONFIRM_KEY = "onay";

/**
 * Client'a onay SORULABİLİR Mİ?
 *
 * İki era'yı da ele almak zorundayız, çünkü aynı v2 sunucusu eski bir client'a
 * da cevap verebiliyor (SDK'nın legacy shim'i input_required sonucunu otomatik
 * olarak sunucu-başlatmalı elicitation'a çevirir).
 *
 *   2026-07-28 → yetenekler HER İSTEKTE gelir (_meta zarfı). Stateless olmanın bedeli.
 *   2025-11-25 → yetenekler initialize el sıkışmasında BİR KEZ bildirilmiştir.
 *
 * Zarf yoksa istek eski era'dandır; o zaman handshake'te bildirileni okuruz.
 */
function clientCanBeAsked(server: McpServer, ctx: ServerContext): boolean {
  // envelope'un TS tipi bu SDK sürümünde boş bir nesne ({}) — anahtarlar
  // yalnızca çalışma anında var. Bu yüzden Record'a daraltıp okuyoruz;
  // anahtar adları SDK'nın kendi sabitlerinden gelir.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  if (envelope?.[PROTOCOL_VERSION_META_KEY] !== undefined) {
    const caps = envelope[CLIENT_CAPABILITIES_META_KEY] as Record<string, unknown> | undefined;
    return caps !== undefined && caps["elicitation"] !== undefined;
  }
  return server.server.getClientCapabilities()?.elicitation !== undefined;
}

function toToolResult(outcome: Extract<ToolOutcome, { kind: "ok" }>): ToolResult {
  return outcome.isError ? failure(outcome.text, outcome.structured) : ok(outcome.text, outcome.structured);
}

/** Onay cevabını (veya reddini) ConfirmOutcome'a çevirir. */
function readDecision(ctx: ServerContext): ConfirmOutcome {
  const view = inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY);
  if (view.kind !== "elicit") return { action: "cancel" };
  if (view.action === "decline") return { action: "decline" };
  if (view.action === "cancel") return { action: "cancel" };

  const content = acceptedContent(ctx.mcpReq.inputResponses, CONFIRM_KEY);
  if (content?.["onay"] === true) return { action: "accept" };
  const reason = content?.["gerekce"];
  return { action: "decline", ...(typeof reason === "string" && reason ? { reason } : {}) };
}

export function createV2Server(cfg: AppConfig = loadConfig()): { server: McpServer; ctx: ToolContext } {
  const server = new McpServer(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: SERVER_INSTRUCTIONS,
    // v2 ZORUNLULUĞU: tools/list ve server/discover sonuçlarında ttlMs + cacheScope.
    cacheHints: {
      "tools/list": { ttlMs: CACHE_TTL_MS, cacheScope: CACHE_SCOPE },
      "server/discover": { ttlMs: CACHE_TTL_MS, cacheScope: CACHE_SCOPE },
    },
    // requestState.verify KASITLI OLARAK BOŞ BIRAKILDI: SDK'nın hook'u
    // doğrulama başarısızlığını wire seviyesinde -32602 hatasına çevirir.
    // Sözleşmemiz ise isError=true + okunabilir TÜRKÇE açıklama istiyor —
    // öğrenci "neden reddedildi"yi görmeli. Bu yüzden doğrulama handler İÇİNDE yapılır.
  });

  const xurrent = createXurrentAdapter(cfg);
  const ctx = createToolContext(cfg, xurrent, async () => ({ action: "unsupported" }));

  // Sözleşmedeki SIRA korunur — v2 tools/list'in DETERMİNİSTİK dönmesini şart koşar.
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
      async (args: Record<string, unknown>, reqCtx: ServerContext) => {
        const signal = reqCtx.mcpReq.signal;
        const echoed = reqCtx.mcpReq.requestState<string>();

        // ── İKİNCİ TUR: client onayı ve requestState'i geri getirdi ──────────
        if (echoed !== undefined) {
          const principal = (await ctx.xurrent.whoami(signal)).person.id;
          const check = verifyRequestState(cfg, echoed, { principal, tool: spec.name, args });
          if (!check.ok) {
            log.warn("requestState doğrulaması BAŞARISIZ", { tool: spec.name, reason: check.reason });
            return failure(
              `Onay bilgisi (requestState) DOĞRULANAMADI — hiçbir şey yazılmadı.\n${check.reason}\n\n` +
                "Bu blob client üzerinden geçtiği için spec onu 'saldırgan kontrolündeki girdi' sayar; " +
                "imza, principal, argüman parmak izi, TTL ve tek kullanımlık nonce kontrollerinden biri tutmadı.",
              { errors: [{ message: check.reason }] },
            );
          }
          const decision = readDecision(reqCtx);
          const done = await runToolCore(ctx, spec.name, args, decision, signal);
          if (done.kind !== "ok") {
            return failure("Onay döngüsü çözülemedi — hiçbir şey yazılmadı.", {
              errors: [{ message: "Onay döngüsü çözülemedi." }],
            });
          }
          return toToolResult(done);
        }

        // ── BİRİNCİ TUR ──────────────────────────────────────────────────────
        const first = await runToolCore(ctx, spec.name, args, undefined, signal);
        if (first.kind === "ok") return toToolResult(first);

        // Client soru soramıyorsa politika devreye girer:
        //   open   → bu dala gelinmez (çekirdek "confirm" dönmez, doğrudan yazar)
        //   closed → mock'ta uyarıyla devam, live'da RED
        //   strict → mock'ta BİLE RED (onay akışını uçtan uca zorunlu kılan ders ayarı)
        if (!clientCanBeAsked(server, reqCtx)) {
          const policy = resolveUnsupportedConfirm(cfg);
          const done = await runToolCore(ctx, spec.name, args, { action: "unsupported" }, signal);
          if (done.kind !== "ok") {
            return failure(policy.message, { errors: [{ message: policy.message }] });
          }
          return toToolResult(done);
        }

        const detail = Object.entries(first.prompt.fields)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");

        return inputRequired({
          inputRequests: {
            [CONFIRM_KEY]: inputRequired.elicit({
              message: `${first.prompt.summary}\n\n${detail}\n\nOnaylıyor musunuz?`,
              requestedSchema: first.schema as never,
            }),
          },
          // İmzalı, süreli, argümana bağlı, tek kullanımlık. Bkz. core/confirm.ts
          requestState: signRequestState(cfg, {
            principal: (await ctx.xurrent.whoami(signal)).person.id,
            tool: spec.name,
            args: first.resume.args,
          }),
        });
      },
    );
  }

  log.info("MCP sunucusu hazır (v2 / 2026-07-28)", {
    mode: cfg.mode,
    strategy: cfg.backdateStrategy,
    calendar: cfg.calendarProvider,
    timeZone: cfg.timeZone,
    dryRun: cfg.forceDryRun,
    confirmPolicy: cfg.confirmPolicy,
    stateTtl: cfg.stateTtlSeconds,
  });

  return { server, ctx };
}
