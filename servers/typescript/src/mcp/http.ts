#!/usr/bin/env node
/**
 * Streamable HTTP transport girişi.
 *
 * Aynı sunucu, aynı 8 tool — sadece taşıyıcı değişir. Dersin "MCP bir
 * protokoldür" tezinin küçük ama somut bir kanıtı: stdio ve HTTP arasında
 * tool kodunda TEK BİR SATIR değişmez.
 *
 * MCP_PROTOCOL:
 *   2026-07-28  → yalnızca /mcp/v2   (varsayılan; /mcp de buraya yönlenir)
 *   2025-11-25  → yalnızca /mcp/v1   (/mcp de buraya yönlenir)
 *   both        → İKİSİ BİRDEN. stdio'da imkânsız olan şey HTTP'de doğaldır:
 *                 yol adresi (path) iki revizyonu ayırmaya yeter.
 *
 * STATELESS mod kullanılır: v1'de sessionIdGenerator=undefined, v2'de zaten
 * oturum kavramı YOKTUR. Ders ortamı için en basit ve en dayanıklı seçenek.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig, type AppConfig } from "../config.js";
import { log } from "../util/log.js";
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

/** v1 (2025-11-25): her istek için TAZE sunucu + transport — oturum sızıntısı olmaz. */
async function handleV1(cfg: AppConfig, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const { server } = createV1Server(cfg);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * v2 (2026-07-28): createMcpHandler web-standard Request/Response konuşur.
 * Node'un IncomingMessage/ServerResponse'unu ikisine köprülemek gerekir —
 * Node 22+ global Request/Response taşıdığı için ek bağımlılık gerekmez.
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

  const http = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      // /mcp → yapılandırmadaki tek protokole yönlenir. "both" modunda belirsizdir.
      let target: "v1" | "v2" | null = null;
      if (path === PATH_V1) target = "v1";
      else if (path === PATH_V2) target = "v2";
      else if (path === PATH_DEFAULT) target = cfg.mcpProtocol === "both" ? null : wantV1 ? "v1" : "v2";

      if (target === null || (target === "v1" && !wantV1) || (target === "v2" && !wantV2)) {
        const open = [wantV1 ? PATH_V1 : null, wantV2 ? PATH_V2 : null].filter(Boolean).join(", ");
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            error:
              path === PATH_DEFAULT
                ? `MCP_PROTOCOL=both iken /mcp belirsizdir — revizyonu açıkça seçin. Açık yollar: ${open}`
                : `Bilinmeyen yol. Açık MCP uç noktaları: ${open}`,
          }),
        );
        return;
      }

      try {
        const { raw, parsed } = await readBody(req);
        if (target === "v1") await handleV1(cfg, req, res, parsed);
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

  http.listen(cfg.mcpHttpPort, () => {
    const base = `http://localhost:${cfg.mcpHttpPort}`;
    if (wantV1) log.info(`MCP v1 (2025-11-25) dinliyor: ${base}${PATH_V1}`);
    if (wantV2) log.info(`MCP v2 (2026-07-28) dinliyor: ${base}${PATH_V2}`);
    if (cfg.mcpProtocol !== "both") log.info(`Kısayol: ${base}${PATH_DEFAULT}`);
  });
}

main().catch((err) => {
  log.error("HTTP sunucusu başlatılamadı", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
