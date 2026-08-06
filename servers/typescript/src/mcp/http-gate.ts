/**
 * HTTP yüzeyi kapısı + yol tablosu — http.ts'ten AYRI dosyada, çünkü http.ts
 * import edildiği anda sunucuyu başlatan bir giriş betiğidir; buradaki saf
 * fonksiyonlar ise birim testten (http-gate.test.mjs) çağrılır.
 *
 * ÜÇ KARAR BURADA YAŞAR (WP6 — HTTP yüzeyi uyumlaştırması):
 *
 *   1) YOL TABLOSU: MCP_PROTOCOL tek era ise o era /mcp'de servis edilir;
 *      both ise /mcp/v1 (2025-11-25, SESSIONFUL) + /mcp/v2 (2026-07-28,
 *      STATELESS) ayrı yaşar ve /mcp, v2'nin TAKMA ADIDIR (güncel spec kazanır).
 *
 *   2) API ANAHTARI: MCP_API_KEY boşsa kapı YOKTUR — sunucu zaten yalnız
 *      loopback'e bağlanır. Doluysa her /mcp* isteği X-MCP-Api-Key başlığında
 *      aynı değeri taşımak zorundadır; karşılaştırma SABİT ZAMANLIDIR.
 *
 *   3) BAĞLANMA ADRESİ: anahtar boş → 127.0.0.1 (mevcut güvenlik duruşu),
 *      dolu → 0.0.0.0 (tünel/dış istemci senaryosu — Copilot Studio vb.).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { McpProtocolOption } from "../types.js";

/**
 * Sabit-zamanlı API anahtarı karşılaştırması.
 *
 * NEDEN hash üzerinden: timingSafeEqual eşit uzunlukta buffer ister ve uzunluk
 * farkında fırlatır — "uzunluğu tutmadı" dalının kendisi bir zamanlama sızıntısı
 * olurdu. İki değeri de sha256'ya indirger, HER ZAMAN 32 baytı karşılaştırırız.
 *
 * expected BOŞ ise kapı kapalıdır: true döner (loopback duruşu; bkz. bindHost).
 */
export function apiKeyOk(expected: string, provided: string | string[] | undefined): boolean {
  if (!expected) return true;
  const value = Array.isArray(provided) ? provided[0] : provided;
  if (typeof value !== "string" || value.length === 0) return false;
  const a = createHash("sha256").update(expected, "utf8").digest();
  const b = createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** MCP_API_KEY duruşu: boş → yalnız loopback; dolu → dışa açık (kapı devrede). */
export function bindHost(mcpApiKey: string): string {
  return mcpApiKey ? "0.0.0.0" : "127.0.0.1";
}

export type PathTarget = "v1" | "v2" | null;

/**
 * Yol tablosu (WP6 sözleşmesi):
 *
 *   MCP_PROTOCOL      /mcp        /mcp/v1     /mcp/v2
 *   2026-07-28        v2          404         v2
 *   2025-11-25        v1          v1          404
 *   both              v2 (alias)  v1          v2
 *
 * Bilinmeyen yol her durumda null (404) döner.
 */
export function resolvePathTarget(path: string, protocol: McpProtocolOption): PathTarget {
  const wantV1 = protocol === "2025-11-25" || protocol === "both";
  const wantV2 = protocol === "2026-07-28" || protocol === "both";

  let target: PathTarget = null;
  if (path === "/mcp/v1") target = "v1";
  else if (path === "/mcp/v2") target = "v2";
  // /mcp: tek era'da o era; both'ta GÜNCEL spec (v2) kazanır — alias.
  else if (path === "/mcp") target = wantV2 ? "v2" : "v1";

  if (target === "v1" && !wantV1) return null;
  if (target === "v2" && !wantV2) return null;
  return target;
}
