#!/usr/bin/env node
/**
 * COPILOT STUDIO KONEKTÖR ÜRETİCİSİ
 * ══════════════════════════════════
 *
 * plugins/copilot-studio/connector.yaml dosyasını üretir: Copilot Studio'nun
 * "Custom connector" yolunda beklediği swagger 2.0 tanımı. Kritik satır
 * `x-ms-agentic-protocol: mcp-streamable-1.0` — Power Platform bu işaretle
 * endpoint'i sıradan bir REST operasyonu değil, MCP sunucusu olarak ele alır
 * ve tool'ları kendisi keşfeder.
 *
 * NEDEN ÜRETİLİYOR (elle yazılmıyor): host her demoda değişir (dev tunnel
 * adresi geçicidir). Elle düzenlenen YAML, tıpkı prompt defteri gibi sessizce
 * eskirdi; tek kaynak bu betik, taahhüt edilen dosya `--kontrol` ile denetlenir.
 *
 * NEDEN swagger 2.0 (OpenAPI 3 değil): Power Platform custom connector'ları
 * hâlâ swagger 2.0 ister; Microsoft'un kendi MCP örnekleri de bu şekildedir.
 *
 * NEDEN /mcp/v1: Copilot Studio OTURUMLU Streamable HTTP konuşur
 * (initialize + Mcp-Session-Id). Üç sunucunun /mcp/v1 yolu 2025-11-25
 * revizyonunu oturumlu servis eder; stateless 2026-07-28 ucu (/mcp/v2)
 * Copilot Studio'nun bugünkü istemcisiyle UYUMSUZDUR. Bkz. docs/09.
 *
 * Kullanım:
 *   node scripts/gen-connector.mjs --host abc123.devtunnels.ms          # üret + yaz
 *   node scripts/gen-connector.mjs --host abc123.devtunnels.ms --print  # stdout'a bas
 *   node scripts/gen-connector.mjs --kontrol                            # taahhütlü dosya güncel mi (CI)
 *
 * Bayraklar:
 *   --host <host>       Sunucunun HTTPS host'u (şema/yol OLMADAN). Zorunlu (--kontrol hariç).
 *   --base-path <yol>   MCP yolu (varsayılan /mcp/v1)
 *   --out <dosya>       Çıkış (varsayılan plugins/copilot-studio/connector.yaml)
 *   --api-key-header <ad> API anahtarı başlığı (varsayılan X-MCP-Api-Key; sunucudaki MCP_API_KEY ile eşleşir)
 *   --print             Dosyaya yazma, stdout'a bas
 *   --kontrol           Üret ve taahhütlü dosyayla karşılaştır; farklıysa exit 1
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

// Taahhüt edilen dosya bu yer tutucu host ile üretilir — gerçek bir tunnel
// adresi taahhüt etmek hem yanıltıcı hem gereksiz sık diff demektir.
const PLACEHOLDER_HOST = "ORNEK-TUNNEL.devtunnels.ms";

const OUT = path.resolve(REPO, opt("--out", "plugins/copilot-studio/connector.yaml"));
const BASE_PATH = opt("--base-path", "/mcp/v1");
const API_KEY_HEADER = opt("--api-key-header", "X-MCP-Api-Key");
const HOST = has("--kontrol") ? PLACEHOLDER_HOST : opt("--host", null);

if (!HOST) {
  console.error("HATA: --host zorunludur (ör. --host abc123.devtunnels.ms).");
  console.error("Dev tunnel açmak için: devtunnel host -p 8788 --allow-anonymous");
  process.exit(2);
}
if (/^https?:\/\//.test(HOST) || HOST.includes("/")) {
  console.error(`HATA: --host yalnızca host adı olmalı, şema/yol OLMADAN (verilen: ${HOST}).`);
  process.exit(2);
}

/**
 * YAML'ı şablonla üretiyoruz, kütüphaneyle değil — scripts/ dizininin kuralı
 * "npm install yok"tur (bkz. scripts/lib/mini-jsonschema.mjs'teki gerekçe).
 * Değerler sabit yapıda olduğu için kaçış sorunu yoktur; host regex ile doğrulanır.
 */
function connectorYaml(host) {
  return `# ÜRETİLMİŞ DOSYA — elle düzenleme. Kaynak: scripts/gen-connector.mjs
# Yeniden üretmek: node scripts/gen-connector.mjs --host <senin-tunnel-host'un>
swagger: '2.0'
info:
  title: Xurrent MCP
  description: >-
    Xurrent (ITSM) zaman takibi MCP sunucusu. Kişinin açık taleplerini listeler,
    süre müzakere eder, zaman girişlerini kaydeder ve günün takvimini zaman
    girişine çevirir. Bu konektör MCP protokolünü Copilot Studio'ya taşır;
    tool listesi sunucudan otomatik keşfedilir.
  version: 1.0.0
host: ${host}
basePath: /
schemes:
  - https
consumes:
  - application/json
produces:
  - application/json
paths:
  ${BASE_PATH}:
    post:
      summary: Xurrent MCP sunucusu (oturumlu Streamable HTTP, 2025-11-25)
      # ★ Kritik satır: Power Platform bu işaretle endpoint'i MCP sunucusu
      # olarak ele alır ve tools/list'i kendisi çağırır.
      x-ms-agentic-protocol: mcp-streamable-1.0
      operationId: InvokeMCP
      responses:
        '200':
          description: Success
securityDefinitions:
  api_key:
    type: apiKey
    in: header
    name: ${API_KEY_HEADER}
security:
  - api_key: []
`;
}

const uretilen = connectorYaml(HOST);

if (has("--kontrol")) {
  let mevcut = null;
  try { mevcut = fs.readFileSync(OUT, "utf8"); } catch { /* yok */ }
  if (mevcut === uretilen) {
    console.error(`[gen-connector] güncel: ${path.relative(REPO, OUT)}`);
    process.exit(0);
  }
  console.error(`[gen-connector] ESKİMİŞ: ${path.relative(REPO, OUT)} üreticiyle uyuşmuyor.`);
  console.error("Düzeltmek için: node scripts/gen-connector.mjs --host " + PLACEHOLDER_HOST);
  process.exit(1);
}

if (has("--print")) {
  process.stdout.write(uretilen);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, uretilen);
  console.error(`[gen-connector] yazıldı: ${path.relative(REPO, OUT)} (host: ${HOST})`);
}
