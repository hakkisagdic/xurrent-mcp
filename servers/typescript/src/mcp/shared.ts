/**
 * İki adaptörün de paylaştığı sunucu kimliği ve talimatlar.
 *
 * Buradaki metinler protokolden bağımsızdır: v1 bunları initialize sonucunda,
 * v2 server/discover sonucunda yayınlar. Aynı sunucu, iki farklı kabuk.
 */

export const SERVER_INFO = {
  name: "xurrent-mcp-typescript",
  version: "1.0.0",
  title: "Xurrent MCP (TypeScript)",
} as const;

export const SERVER_INSTRUCTIONS =
  "Xurrent (ITSM) zaman takibi. KURALLAR: (1) Zaman yazmadan ÖNCE mutlaka " +
  "xurrent_get_time_tracking_context çağır — timeIncrement bilinmeden süre seçilemez. " +
  "(2) Tüm süreler DAKİKA cinsindendir; '2 saat' → 120 ve bu dönüşüm kullanıcıya söylenir. " +
  "(3) Node id'leri ASLA uydurma; her id bir tool çıktısından gelir. " +
  "(4) Yazmadan önce dryRun=true ile planı göster. " +
  "(5) plan_time_entries_from_calendar sadece ÖNERİ üretir, yazmaz.";

/**
 * 2026-07-28 revizyonu liste sonuçlarında ttlMs + cacheScope ZORUNLU kılar.
 * Bizim tool listemiz statiktir → 5 dakika, paylaşılan cache'te tutulabilir.
 */
export const CACHE_TTL_MS = 300_000;
export const CACHE_SCOPE = "public" as const;
