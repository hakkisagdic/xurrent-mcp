#!/usr/bin/env node
/**
 * stdio transport girişi — .mcp.json bu dosyayı bekler: dist/mcp/stdio.js
 *
 * ALTIN KURAL: stdio'da stdout SADECE JSON-RPC içindir. Tek bir console.log
 * çerçeveyi bozar ve sunucu "bağlanamıyor" görünür. Tüm loglar stderr'e gider
 * (bkz. util/log.ts). 2026-07-28 revizyonu Logging'i deprecate ettiği için
 * bu kural artık yalnızca pratik değil, SPEC ÖNERİSİDİR.
 *
 * MCP_PROTOCOL:
 *   2026-07-28  → v2 adaptörü (VARSAYILAN). serveStdio era'yı açılış mesajından seçer:
 *                 zarflı bir istek gelirse modern, düz bir initialize gelirse 2025-era.
 *   2025-11-25  → v1 adaptörü (@modelcontextprotocol/sdk@1.30.0). Sunucu-başlatmalı elicitation.
 *   both        → GEÇERSİZ. Tek süreç tek protokol konuşur; "both" yalnızca HTTP'de anlamlıdır.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "../config.js";
import { log } from "../util/log.js";
import { createV1Server } from "./v1/server.js";
import { createV2Server } from "./v2/server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (cfg.mcpProtocol === "both") {
    process.stderr.write(
      "\nMCP_PROTOCOL=both stdio transport'ta GEÇERSİZDİR.\n" +
        "Sebep: stdio tek bir çift yönlü borudur; iki protokol revizyonunu aynı boruda\n" +
        "ayrıştıracak bir yol adresi (path) yoktur. Seçenekler:\n" +
        "  • MCP_PROTOCOL=2026-07-28  (varsayılan, güncel revizyon)\n" +
        "  • MCP_PROTOCOL=2025-11-25  (eski revizyon)\n" +
        "  • İkisini birden sunmak için HTTP kullanın: npm run http\n" +
        "    → /mcp/v1 ve /mcp/v2 yolları aynı anda açılır.\n\n",
    );
    process.exit(2);
  }

  if (cfg.mcpProtocol === "2025-11-25") {
    const { server } = createV1Server(cfg);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info("stdio transport bağlandı (v1 / 2025-11-25)");
    return;
  }

  // v2: serveStdio bağlantının era'sını sahiplenir ve fabrikadan TEK bir örneği
  // bağlantı ömrü boyunca sabitler. legacy:'serve' varsayılanı sayesinde eski
  // bir client düz initialize gönderse bile cevapsız kalmaz.
  serveStdio(() => createV2Server(cfg).server, {
    onerror: (err) => log.error("v2 stdio hatası", { error: err.message }),
  });
  log.info("stdio transport bağlandı (v2 / 2026-07-28)");
}

main().catch((err) => {
  log.error("stdio sunucusu başlatılamadı", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
