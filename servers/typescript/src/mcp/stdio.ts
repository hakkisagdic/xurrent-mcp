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
import { StdioServerTransport as StdioServerTransportV2, serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "../config.js";
import { log } from "../util/log.js";
import { createParseGuard } from "./parse-guard.js";
import { metaKoruyucusuTak } from "./meta-guard.js";
import { parametreKoruyucusuTak } from "./params-guard.js";
import { createV1Server } from "./v1/server.js";
import { createV2Server } from "./v2/server.js";

/**
 * stdin'i SDK'ya vermeden önce süzen koruyucu.
 *
 * Her iki SDK da ayrıştırılamayan satırı sessizce yutuyor; JSON-RPC ise
 * -32700 dönmeyi ZORUNLU kılıyor (bkz. src/mcp/parse-guard.ts). Sessiz yutma
 * istemciyi süresiz bekletir. C# SDK'sı aynı durumda -32700 döndürdüğü için
 * bunun protokolün değil implementasyonun eksiği olduğunu biliyoruz.
 */
function korumaliGirdi(): NodeJS.ReadableStream {
  const guard = createParseGuard({
    cikis: process.stdout,
    onDrop: (satir, id) =>
      log.warn("bozuk JSON satırı düşürüldü, -32700 döndürüldü", {
        id, onizleme: satir.slice(0, 80),
      }),
  });
  process.stdin.pipe(guard);
  return guard;
}

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
    const transport = new StdioServerTransport(korumaliGirdi() as never, process.stdout);
    await server.connect(transport);
    // connect'ten SONRA: Protocol.connect onmessage'i kendi işleyicisiyle değiştirir.
    // v1 SDK şema hatasını -32603'e sarmalıyor; spec -32602 istiyor (uyum J4).
    parametreKoruyucusuTak(transport as never, {
      onReject: (metot, id, hata) => log.warn("geçersiz params reddedildi, -32602 döndürüldü", { metot, id, detay: hata.message }),
      onSendError: (err) => log.error("-32602 yanıtı gönderilemedi", { error: err instanceof Error ? err.message : String(err) }),
    });
    log.info("stdio transport bağlandı (v1 / 2025-11-25)");
    return;
  }

  // v2: serveStdio bağlantının era'sını sahiplenir ve fabrikadan TEK bir örneği
  // bağlantı ömrü boyunca sabitler. legacy:'serve' varsayılanı sayesinde eski
  // bir client düz initialize gönderse bile cevapsız kalmaz.
  // Kendi transport'umuzu veriyoruz ki stdin koruyucudan geçsin; era seçimini
  // yine serveStdio yapar (legacy:'serve' varsayılanı korunur).
  const v2Transport = new StdioServerTransportV2(korumaliGirdi() as never, process.stdout);
  serveStdio(() => createV2Server(cfg).server, {
    transport: v2Transport,
    onerror: (err) => log.error("v2 stdio hatası", { error: err.message }),
  });
  // serveStdio'dan SONRA: serveStdio onmessage'i kendi kuyruğuyla değiştirir.
  // Zarf iddiası taşımayan bir istek serveStdio'ya ulaşırsa bağlantı SESSİZCE
  // v1'e sabitlenir ve -32601 döner; spec o kodu "2026 öncesi sunucu" sinyali
  // saydığı için uyumluluk sondası yanılır (uyum Y2b/Y3b).
  metaKoruyucusuTak(v2Transport as never, {
    onReject: (metot, id, hata) =>
      log.warn("_meta zarfı eksik, -32602 döndürüldü", { metot, id, eksik: hata.data.envelope.missing }),
    onLegacyPin: (metot) =>
      log.info("zarfsız el sıkışması görüldü — bağlantı 2025-11-25 era'sına sabitlendi", { metot }),
    onSendError: (err) => log.error("-32602 yanıtı gönderilemedi", { error: err instanceof Error ? err.message : String(err) }),
  });
  log.info("stdio transport bağlandı (v2 / 2026-07-28)");
}

main().catch((err) => {
  log.error("stdio sunucusu başlatılamadı", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
