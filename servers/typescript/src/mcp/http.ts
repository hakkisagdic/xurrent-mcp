#!/usr/bin/env node
/**
 * Streamable HTTP transport girişi.
 *
 * Aynı sunucu, aynı tool seti — sadece taşıyıcı değişir. Dersin "MCP bir
 * protokoldür" tezinin küçük ama somut bir kanıtı: stdio ve HTTP arasında
 * tool kodunda TEK BİR SATIR değişmez.
 *
 * YOL TABLOSU (WP6 — bkz. http-gate.ts):
 *   MCP_PROTOCOL=2026-07-28 → /mcp/v2 + /mcp (ikisi de v2)
 *   MCP_PROTOCOL=2025-11-25 → /mcp/v1 + /mcp (ikisi de v1)
 *   MCP_PROTOCOL=both       → /mcp/v1 + /mcp/v2 + /mcp → v2'nin TAKMA ADI
 *
 * OTURUM DURUŞU SÖZLEŞMENİN PARÇASIDIR:
 *   v1 (2025-11-25) SESSIONFUL'dur: initialize el sıkışması Mcp-Session-Id
 *   üretir; sonraki istekler bu başlıkla AYNI sunucu örneğine yönlenir.
 *   Elicitation (sunucu-başlatmalı onay) tam da bu kalıcı eşleşmeye dayanır.
 *   v2 (2026-07-28) STATELESS'tır: oturum kavramı YOKTUR, her istek kendi
 *   başına yaşar; onay MRTR ile (requestState) çözülür.
 *
 * MCP_API_KEY KAPISI (.env.example §8):
 *   boş → yalnız loopback'e bağlanılır (varsayılan duruş, kapı yok).
 *   dolu → 0.0.0.0'a bağlanılır ve HER /mcp* isteği X-MCP-Api-Key başlığında
 *   aynı değeri taşımak zorundadır (sabit-zamanlı karşılaştırma; aksi 401).
 *   Her iki era için de geçerlidir. Web chat portu (WEB_PORT) bundan ETKİLENMEZ.
 */

import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig, type AppConfig } from "../config.js";
import { log } from "../util/log.js";
import { apiKeyOk, bindHost, resolvePathTarget } from "./http-gate.js";
import { parametreKoruyucusuTak } from "./params-guard.js";
import { createV1Server } from "./v1/server.js";
import { createV2Server } from "./v2/server.js";

const PATH_V1 = "/mcp/v1";
const PATH_V2 = "/mcp/v2";
const PATH_DEFAULT = "/mcp";

async function readBody(req: IncomingMessage): Promise<{ raw: Buffer; parsed: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { raw, parsed: undefined };
  try {
    return { raw, parsed: JSON.parse(raw.toString("utf8")) };
  } catch {
    return { raw, parsed: undefined };
  }
}

/** Açık v1 oturumları: Mcp-Session-Id → (transport + sunucu). */
interface V1Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}

/**
 * v1 (2025-11-25): SESSIONFUL akış.
 *
 *   · initialize (session başlığı YOK) → taze sunucu + transport; SDK
 *     Mcp-Session-Id üretir ve yanıt başlığına yazar; oturum haritaya girer.
 *   · Sonraki istekler Mcp-Session-Id ile gelir → AYNI transport'a yönlenir
 *     (elicitation gibi sunucu-başlatmalı akışların ön koşulu).
 *   · DELETE oturumu kapatır (SDK yönetir; onclose haritadan düşürür).
 *
 * Eski hâli her istekte sessionIdGenerator: undefined ile TAZE transport
 * kuruyordu — yani v1 fiilen stateless'tı ve el sıkışmanın ürettiği hiçbir
 * kimlik ikinci isteğe taşınmıyordu. Bu, 2025-11-25 spec'inin oturum modelini
 * YANLIŞ anlatıyordu; WP6 bunu düzeltir.
 */
async function handleV1(
  cfg: AppConfig,
  sessions: Map<string, V1Session>,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const rawSid = req.headers["mcp-session-id"];
  const sid = Array.isArray(rawSid) ? rawSid[0] : rawSid;

  // Bilinen oturum → aynı transport devam eder (GET/POST/DELETE hepsi buradan).
  if (sid && sessions.has(sid)) {
    await sessions.get(sid)!.transport.handleRequest(req, res, body);
    return;
  }

  // Yeni oturum YALNIZCA initialize ile açılır (spec: diğer istekler 400/404).
  if (!sid && isInitializeRequest(body)) {
    const { server } = createV1Server(cfg);
    const transport = new StreamableHTTPServerTransport({
      // ★ WP6'nın özü: v1 artık GERÇEKTEN sessionful — SDK initialize yanıtına
      // Mcp-Session-Id başlığını bu üreticiyle koyar.
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (newSid) => {
        sessions.set(newSid, {
          transport,
          close: async () => {
            await transport.close();
            await server.close();
          },
        });
        log.info("v1 oturumu açıldı", { sessionId: newSid, toplam: sessions.size });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId && sessions.delete(transport.sessionId)) {
        log.info("v1 oturumu kapandı", { sessionId: transport.sessionId, kalan: sessions.size });
      }
    };
    await server.connect(transport);
    // stdio ile AYNI koruyucu — taşıyıcı değişse de spec değişmiyor (uyum J4).
    parametreKoruyucusuTak(transport as never, {
      onReject: (metot, id, hata) =>
        log.warn("geçersiz params reddedildi, -32602 döndürüldü", { metot, id, detay: hata.message }),
      onSendError: (err) =>
        log.error("-32602 yanıtı gönderilemedi", { error: err instanceof Error ? err.message : String(err) }),
    });
    await transport.handleRequest(req, res, body);
    return;
  }

  // Oturumsuz initialize-dışı istek (400) ya da tanınmayan oturum (404) —
  // spec'in stateful modu tam bu iki kodu şart koşar.
  const code = sid ? 404 : 400;
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: sid
          ? "Mcp-Session-Id tanınmadı — oturum kapanmış ya da sunucu yeniden başlamış olabilir. initialize ile yeni oturum açın."
          : "Bu uç SESSIONFUL'dur (2025-11-25): önce initialize gönderin, dönen Mcp-Session-Id başlığını sonraki isteklerde taşıyın.",
      },
      id: null,
    }),
  );
}

/**
 * v2 (2026-07-28): createMcpHandler web-standard Request/Response konuşur ve
 * STATELESS'tır — oturum başlığı ne beklenir ne üretilir. Node'un
 * IncomingMessage/ServerResponse'unu ikisine köprülemek gerekir — Node 22+
 * global Request/Response taşıdığı için ek bağımlılık gerekmez.
 */
async function handleV2(
  handler: { fetch: (req: Request, opts?: { parsedBody?: unknown }) => Promise<Response> },
  req: IncomingMessage,
  res: ServerResponse,
  raw: Buffer,
  parsed: unknown,
): Promise<void> {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const one of v) headers.append(k, one);
    else headers.set(k, v);
  }

  const method = req.method ?? "GET";
  const webReq = new Request(url, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: raw.length ? raw : undefined }),
  });

  const webRes = await handler.fetch(webReq, { parsedBody: parsed });

  const outHeaders: Record<string, string> = {};
  webRes.headers.forEach((value, key) => {
    outHeaders[key] = value;
  });
  res.writeHead(webRes.status, outHeaders);

  if (!webRes.body) {
    res.end();
    return;
  }
  // SSE dahil: gövde bir ReadableStream'dir, akıtarak yazılır.
  const reader = webRes.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const wantV1 = cfg.mcpProtocol === "2025-11-25" || cfg.mcpProtocol === "both";
  const wantV2 = cfg.mcpProtocol === "2026-07-28" || cfg.mcpProtocol === "both";

  // v2 handler bir kez kurulur; her istek için fabrikadan taze bir McpServer üretir.
  const v2Handler = wantV2
    ? createMcpHandler(() => createV2Server(cfg).server, {
        onerror: (err) => log.error("v2 HTTP hatası", { error: err.message }),
      })
    : null;

  // v1 oturumları süreç ömrünce yaşar; DELETE ya da transport kapanışı düşürür.
  const v1Sessions = new Map<string, V1Session>();

  const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // ── MCP_API_KEY kapısı: TÜM /mcp* istekleri, HER İKİ era ──────────────
      if (cfg.mcpApiKey && !apiKeyOk(cfg.mcpApiKey, req.headers["x-mcp-api-key"])) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "X-MCP-Api-Key başlığı eksik veya yanlış." }));
        return;
      }

      const target = resolvePathTarget(path, cfg.mcpProtocol);
      if (target === null) {
        const open = [wantV1 ? PATH_V1 : null, wantV2 ? PATH_V2 : null, PATH_DEFAULT]
          .filter(Boolean)
          .join(", ");
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: `Bilinmeyen yol. Açık MCP uç noktaları: ${open}` }));
        return;
      }

      try {
        const { raw, parsed } = await readBody(req);
        if (target === "v1") await handleV1(cfg, v1Sessions, req, res, parsed);
        else await handleV2(v2Handler!, req, res, raw, parsed);
      } catch (err) {
        log.error("HTTP isteği işlenemedi", { error: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Sunucu hatası" }));
        }
      }
    })();
  });

  // Anahtar boş → yalnız loopback (mevcut duruş). Dolu → 0.0.0.0 + başlık zorunlu.
  const host = bindHost(cfg.mcpApiKey);
  http.listen(cfg.mcpHttpPort, host, () => {
    const base = `http://${host === "0.0.0.0" ? "0.0.0.0" : "localhost"}:${cfg.mcpHttpPort}`;
    if (wantV1) log.info(`MCP v1 (2025-11-25, sessionful) dinliyor: ${base}${PATH_V1}`);
    if (wantV2) log.info(`MCP v2 (2026-07-28, stateless) dinliyor: ${base}${PATH_V2}`);
    log.info(
      cfg.mcpProtocol === "both"
        ? `Kısayol: ${base}${PATH_DEFAULT} → v2 (güncel spec)`
        : `Kısayol: ${base}${PATH_DEFAULT}`,
    );
    log.info(
      cfg.mcpApiKey
        ? "MCP_API_KEY DOLU: 0.0.0.0'a bağlanıldı, her istekte X-MCP-Api-Key zorunlu."
        : "MCP_API_KEY boş: yalnız loopback (127.0.0.1) dinleniyor.",
    );
  });
}

main().catch((err) => {
  log.error("HTTP sunucusu başlatılamadı", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
