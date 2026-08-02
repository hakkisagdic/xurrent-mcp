/**
 * Loglama.
 *
 * KRİTİK KURAL — stdio transport'ta stdout SADECE JSON-RPC içindir.
 * stdout'a tek bir "\n" bile yazarsan client'ın çerçeve ayrıştırıcısı bozulur ve
 * sunucu sessizce "bağlanamıyor" duruma düşer. Bu yüzden bu projede
 * TÜM loglar stderr'e gider — hiçbir istisna yok.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const raw = (process.env["XURRENT_LOG_LEVEL"] ?? "info").toLowerCase();
  return (["debug", "info", "warn", "error"].includes(raw) ? raw : "info") as LogLevel;
}

/**
 * Sır maskeleme: token/secret/key içeren değerleri asla loglamayız.
 * Bir ders materyalinde bile bu alışkanlık kazandırılmalıdır.
 */
const SECRET_KEY_PATTERN = /(token|secret|key|password|authorization|bearer)/i;

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    // Bearer token'ları ve uzun opak string'leri kısalt.
    if (/^Bearer\s+/i.test(value)) return "Bearer ***";
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "***" : redact(v);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const line =
    meta === undefined
      ? `[xurrent-mcp:${level}] ${message}`
      : `[xurrent-mcp:${level}] ${message} ${JSON.stringify(redact(meta))}`;
  // process.stderr.write — console.log ASLA kullanılmaz (stdout'u kirletir).
  process.stderr.write(line + "\n");
}

export const log = {
  debug: (m: string, meta?: unknown) => emit("debug", m, meta),
  info: (m: string, meta?: unknown) => emit("info", m, meta),
  warn: (m: string, meta?: unknown) => emit("warn", m, meta),
  error: (m: string, meta?: unknown) => emit("error", m, meta),
};
