/**
 * Yapılandırma: .env okuma + zod ile doğrulama.
 *
 * TÜM VARSAYILANLAR .env.example ile BİREBİR AYNIDIR. Bir varsayılanı burada
 * değiştirmek dökümantasyonu yalancı çıkarır; ikisi birlikte değişir.
 *
 * NOT: dotenv paketi KULLANILMIYOR. Proje kasıtlı olarak bağımlılık-fakiri
 * (MCP SDK + zod; LLM sağlayıcısı için SDK bile yok, düz fetch). .env ayrıştırıcısı
 * 20 satır; bir bağımlılık eklemeye değmez ve Python/C# tarafında da aynı basitlikte
 * yazılabilir.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  BackdateStrategy,
  CalendarProviderOption,
  ConfirmPolicy,
  McpProtocolOption,
  RoundingMode,
  XurrentMode,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Repo kökünü bul
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Repo kökü = içinde hem contract/tools.json hem fixtures/ olan ilk üst dizin.
 * Böylece kod src/ içinden de dist/ içinden de aynı köke ulaşır — derleme
 * çıktısının derinliğine bağlı "../../.." sayma hatası olmaz.
 */
export function findRepoRoot(startDir?: string): string {
  let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "contract", "tools.json")) && existsSync(join(dir, "fixtures"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Bulunamazsa cwd'ye düş — testler ve tek dosya çalıştırmaları için.
  return process.cwd();
}

// ─────────────────────────────────────────────────────────────────────────────
// .env ayrıştırıcı
// ─────────────────────────────────────────────────────────────────────────────

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // Çok satırlı private key'ler tek satırda "\n" kaçışıyla tutulur.
    out[key] = value.replace(/\\n/g, "\n");
  }
  return out;
}

/** .env dosyasını okur ama MEVCUT process.env değerlerini EZMEZ. */
function loadDotEnvInto(env: Record<string, string | undefined>, repoRoot: string): void {
  for (const candidate of [join(repoRoot, ".env"), join(process.cwd(), ".env")]) {
    if (!existsSync(candidate)) continue;
    const parsed = parseDotEnv(readFileSync(candidate, "utf8"));
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] === undefined || env[k] === "") env[k] = v;
    }
    break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Şema
// ─────────────────────────────────────────────────────────────────────────────

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return fallback;
      return ["1", "true", "yes", "on", "evet"].includes(v.toLowerCase());
    });

const intish = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === "") return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? Math.trunc(n) : fallback;
    });

const withDefault = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : v));

const EnvSchema = z.object({
  XURRENT_MODE: z
    .string()
    .optional()
    .transform((v) => (v === "live" ? "live" : "mock") as XurrentMode),
  XURRENT_TOKEN: withDefault(""),
  XURRENT_ACCOUNT: withDefault(""),
  XURRENT_GRAPHQL_URL: withDefault("https://graphql.xurrent.com"),

  // ── API transport seçimi (bkz. docs/16 + .env.example §1) ─────────────────
  // graphql (varsayılan) → tek istekte zengin sorgu, hatalar 200+payload.errors.
  // rest → developer.xurrent.com/v1: snake_case alanlar, 422 hata modeli,
  //        whoami/context N ayrı istek. İkisi de AYNI tool sözleşmesini servis
  //        eder — transport bir adaptör detayıdır. Tanınmayan değer sessizce
  //        graphql'e düşer; validateSemantics uyarı basar.
  XURRENT_API: z
    .string()
    .optional()
    .transform((v) => (v === "rest" ? "rest" : "graphql") as XurrentApi),
  XURRENT_REST_URL: withDefault("https://api.xurrent.com/v1"),

  XURRENT_DRY_RUN: boolish(false),
  // ÜÇ değer vardır ve üçü de üç dilde AYNI anlama gelir (bkz. types.ts → ConfirmPolicy):
  //   closed (varsayılan) · open (CI) · strict (mock modda da onay ZORUNLU).
  // Tanınmayan değer sessizce "closed"a düşer — güvenli taraf — ama stderr'e
  // uyarı basılır (validateSemantics), çünkü sessiz düşüş yapılandırma hatasını gizler.
  XURRENT_CONFIRM_POLICY: z
    .string()
    .optional()
    .transform((v) =>
      v === "open" ? "open" : v === "strict" ? ("strict" as ConfirmPolicy) : ("closed" as ConfirmPolicy),
    ),
  XURRENT_SOURCE: withDefault("xurrent-mcp"),

  XURRENT_BACKDATE_STRATEGY: z
    .string()
    .optional()
    .transform((v) =>
      v === "link_first" || v === "date_first" ? (v as BackdateStrategy) : ("two_step" as BackdateStrategy),
    ),
  XURRENT_MAX_BACKDATE_DAYS: intish(1),

  // ── Güvenilirlik düğmeleri (contract/reliability.md §7) ───────────────────
  // Varsayılanlar sözleşmede SABİTTİR; burada değiştirmek üç dili ayrıştırır.
  XURRENT_RETRY_MAX_ATTEMPTS: intish(5), // toplam deneme (ilk istek dahil); 1 = retry KAPALI
  XURRENT_RETRY_BASE_MS: intish(500), // backoff tabanı
  XURRENT_RETRY_CAP_MS: intish(8000), // tek beklemenin tavanı
  XURRENT_MIN_REQUEST_GAP_MS: intish(110), // adaptör gazı: istekler arası minimum boşluk

  CALENDAR_PROVIDER: z
    .string()
    .optional()
    .transform((v) =>
      ["mock", "ics", "google", "graph", "auto"].includes(v ?? "")
        ? (v as CalendarProviderOption)
        : ("mock" as CalendarProviderOption),
    ),
  CALENDAR_ICS_PATH: withDefault("./fixtures/calendar.ics"),
  CALENDAR_ICS_URL: withDefault(""),

  GOOGLE_CLIENT_ID: withDefault(""),
  GOOGLE_CLIENT_SECRET: withDefault(""),
  GOOGLE_TOKEN_PATH: withDefault("~/.xurrent-mcp/google-token.json"),
  GOOGLE_CALENDAR_ID: withDefault("primary"),
  GOOGLE_SA_CLIENT_EMAIL: withDefault(""),
  GOOGLE_SA_PRIVATE_KEY: withDefault(""),
  GOOGLE_IMPERSONATE_USER: withDefault(""),

  MS_TENANT_ID: withDefault(""),
  MS_CLIENT_ID: withDefault(""),
  MS_CLIENT_SECRET: withDefault(""),
  MS_IMPERSONATE_USER: withDefault(""),

  XURRENT_TIMEZONE: withDefault("Europe/Istanbul"),
  DEFAULT_TIME_ALLOCATION_ID: withDefault("TW9jay9UaW1lQWxsb2NhdGlvbi8x"),
  ROUNDING_MODE: z
    .string()
    .optional()
    .transform((v) => (v === "up" || v === "down" ? (v as RoundingMode) : ("nearest" as RoundingMode))),

  // ── LLM sağlayıcısı: GEMINI (tek sağlayıcı) ───────────────────────────────
  GEMINI_API_KEY: withDefault(""),
  // Varsayılan model NEDEN gemini-3.6-flash: ai.google.dev/gemini-api/docs/models
  // listesinde "Stable" işaretli EN GÜNCEL flash modeli budur ve tool calling
  // destekler. Flash tercih edildi çünkü bu bir ders materyalidir: gecikme ve
  // maliyet, marjinal akıl yürütme kalitesinden daha önemli.
  GEMINI_MODEL: withDefault("gemini-3.6-flash"),
  // Sahte Gemini sunucusuna (tools/fake-gemini) yönlendirmeyi mümkün kılar.
  GEMINI_BASE_URL: withDefault("https://generativelanguage.googleapis.com"),
  WEB_PORT: intish(8787),
  MCP_HTTP_PORT: intish(8788),

  // ── HTTP yüzeyi kapısı (.env.example §8) ──────────────────────────────────
  // BOŞSA sunucu yalnız loopback'e bağlanır (varsayılan güvenlik duruşu).
  // DOLUYSA 0.0.0.0'a bağlanır ve her /mcp* isteği X-MCP-Api-Key başlığında
  // bu değeri taşımak ZORUNDADIR (sabit-zamanlı karşılaştırma, aksi hâlde 401).
  MCP_API_KEY: withDefault(""),

  XURRENT_FIXTURES_DIR: withDefault(""),
  XURRENT_MOCK_PERSIST: boolish(false),

  // ── Çift protokol ─────────────────────────────────────────────────────────
  // Hangi MCP revizyonunun ADVERTISE edileceğini seçer. Tanınmayan bir değer
  // sessizce varsayılana düşer: ders ortamında yazım hatası yüzünden sunucunun
  // hiç açılmaması, yanlış revizyonu konuşmasından daha kötüdür (ve stderr'e uyarı basılır).
  MCP_PROTOCOL: z
    .string()
    .optional()
    .transform((v) =>
      v === "2025-11-25" || v === "both" ? (v as McpProtocolOption) : ("2026-07-28" as McpProtocolOption),
    ),
  // requestState imza anahtarı. BOŞSA süreç başında rastgele üretilir — yeniden
  // başlatınca eski state'ler geçersiz olur. Bu İSTENEN davranıştır (bkz. README).
  XURRENT_STATE_SECRET: withDefault(""),
  XURRENT_STATE_TTL: intish(300),
  // timesheet_wizard oturum TTL'i (contract/wizard.md §4): çok adımlı sohbet,
  // requestState'in 300 saniyesinden bilinçli olarak UZUN tutulur.
  XURRENT_WIZARD_TTL: intish(1800),
});

/**
 * Canlı modda hangi Xurrent API yüzeyinin konuşulacağı.
 * types.ts'e DEĞİL buraya konuldu: sözleşmenin (contract/tools.json) bir alanı
 * değildir, saf bir yapılandırma detayıdır — tıpkı graphqlUrl gibi.
 */
export type XurrentApi = "graphql" | "rest";

export interface AppConfig {
  repoRoot: string;
  fixturesDir: string;

  mode: XurrentMode;
  token: string;
  account: string;
  graphqlUrl: string;
  /** live modda transport seçimi: graphql (varsayılan) | rest. Mock modda etkisiz. */
  api: XurrentApi;
  /** REST v1 taban adresi (sonda eğik çizgi TAŞIMAZ). Sahte sunucu: http://127.0.0.1:<port>/v1 */
  restUrl: string;

  /** XURRENT_DRY_RUN=1 → HİÇBİR mutation HTTP'ye çıkmaz (tool parametresinden bağımsız). */
  forceDryRun: boolean;
  /** closed (varsayılan) | open (CI) | strict (mock'ta da onay zorunlu). */
  confirmPolicy: ConfirmPolicy;
  source: string;

  backdateStrategy: BackdateStrategy;
  maxBackdateDays: number;

  /** Toplam deneme sayısı (ilk istek DAHİL). 1 = retry kapalı. Bkz. contract/reliability.md §3. */
  retryMaxAttempts: number;
  /** Üstel geri çekilme tabanı (ms). wait_k = rastgele(0, min(CAP, BASE·2^(k-1))). */
  retryBaseMs: number;
  /** Tek beklemenin tavanı (ms). */
  retryCapMs: number;
  /** Adaptör gazı: her HTTP isteği (retry tekrarları DAHİL) arasındaki minimum boşluk (ms). */
  minRequestGapMs: number;

  calendarProvider: CalendarProviderOption;
  icsPath: string;
  icsUrl: string;

  google: {
    clientId: string;
    clientSecret: string;
    tokenPath: string;
    calendarId: string;
    saClientEmail: string;
    saPrivateKey: string;
    impersonateUser: string;
  };
  ms: { tenantId: string; clientId: string; clientSecret: string; impersonateUser: string };

  timeZone: string;
  defaultTimeAllocationId: string;
  roundingMode: RoundingMode;

  geminiApiKey: string;
  geminiModel: string;
  /** Uç nokta kökü. Sonda eğik çizgi TAŞIMAZ. */
  geminiBaseUrl: string;
  webPort: number;
  mcpHttpPort: number;
  /**
   * HTTP transport kapısı (.env.example §8). Boş → yalnız loopback.
   * Dolu → 0.0.0.0 + her /mcp* isteğinde X-MCP-Api-Key zorunlu.
   * Xurrent PAT'i ile KARIŞTIRILMAZ: bu anahtar MCP sunucusunun kendisini korur.
   */
  mcpApiKey: string;

  mockPersist: boolean;

  /** Hangi MCP revizyonu advertise edilecek: v2 (varsayılan), v1 veya ikisi birden. */
  mcpProtocol: McpProtocolOption;
  /** requestState HMAC anahtarı. Boş bırakılmışsa süreç başında rastgele üretilir. */
  stateSecret: string;
  /** requestState geçerlilik süresi (saniye). */
  stateTtlSeconds: number;
  /** timesheet_wizard sessionState geçerlilik süresi (saniye, varsayılan 1800). */
  wizardTtlSeconds: number;
}

let cached: AppConfig | null = null;

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached;

  const repoRoot = findRepoRoot();
  const env: Record<string, string | undefined> = { ...process.env };
  loadDotEnvInto(env, repoRoot);

  const parsed = EnvSchema.parse(env);

  const fixturesDir = parsed.XURRENT_FIXTURES_DIR
    ? resolve(parsed.XURRENT_FIXTURES_DIR)
    : join(repoRoot, "fixtures");

  const icsPath = parsed.CALENDAR_ICS_PATH.startsWith(".")
    ? resolve(repoRoot, parsed.CALENDAR_ICS_PATH)
    : parsed.CALENDAR_ICS_PATH;

  cached = {
    repoRoot,
    fixturesDir,

    mode: parsed.XURRENT_MODE,
    token: parsed.XURRENT_TOKEN,
    account: parsed.XURRENT_ACCOUNT,
    graphqlUrl: parsed.XURRENT_GRAPHQL_URL.replace(/\/+$/, "") + "/",
    api: parsed.XURRENT_API,
    // Sondaki eğik çizgi ATILIR: adaptör path'leri `${restUrl}/time_entries`
    // biçiminde ekler; çift çizgi bazı proxy'lerde 404 üretir.
    restUrl: parsed.XURRENT_REST_URL.replace(/\/+$/, ""),

    forceDryRun: parsed.XURRENT_DRY_RUN,
    confirmPolicy: parsed.XURRENT_CONFIRM_POLICY,
    source: parsed.XURRENT_SOURCE,

    backdateStrategy: parsed.XURRENT_BACKDATE_STRATEGY,
    maxBackdateDays: parsed.XURRENT_MAX_BACKDATE_DAYS,

    // 1'in altı anlamsızdır (0 deneme = hiç istek yok) → sessizce 1'e ÇEKİLMEZ,
    // clamp edilir ve validateSemantics uyarı basar.
    retryMaxAttempts: Math.max(1, parsed.XURRENT_RETRY_MAX_ATTEMPTS),
    retryBaseMs: Math.max(0, parsed.XURRENT_RETRY_BASE_MS),
    retryCapMs: Math.max(0, parsed.XURRENT_RETRY_CAP_MS),
    minRequestGapMs: Math.max(0, parsed.XURRENT_MIN_REQUEST_GAP_MS),

    calendarProvider: parsed.CALENDAR_PROVIDER,
    icsPath,
    icsUrl: parsed.CALENDAR_ICS_URL,

    google: {
      clientId: parsed.GOOGLE_CLIENT_ID,
      clientSecret: parsed.GOOGLE_CLIENT_SECRET,
      tokenPath: expandHome(parsed.GOOGLE_TOKEN_PATH),
      calendarId: parsed.GOOGLE_CALENDAR_ID,
      saClientEmail: parsed.GOOGLE_SA_CLIENT_EMAIL,
      saPrivateKey: parsed.GOOGLE_SA_PRIVATE_KEY,
      impersonateUser: parsed.GOOGLE_IMPERSONATE_USER,
    },
    ms: {
      tenantId: parsed.MS_TENANT_ID,
      clientId: parsed.MS_CLIENT_ID,
      clientSecret: parsed.MS_CLIENT_SECRET,
      impersonateUser: parsed.MS_IMPERSONATE_USER,
    },

    timeZone: parsed.XURRENT_TIMEZONE,
    defaultTimeAllocationId: parsed.DEFAULT_TIME_ALLOCATION_ID,
    roundingMode: parsed.ROUNDING_MODE,

    geminiApiKey: parsed.GEMINI_API_KEY,
    geminiModel: parsed.GEMINI_MODEL,
    geminiBaseUrl: parsed.GEMINI_BASE_URL.replace(/\/+$/, ""),
    webPort: parsed.WEB_PORT,
    mcpHttpPort: parsed.MCP_HTTP_PORT,
    mcpApiKey: parsed.MCP_API_KEY,

    mockPersist: parsed.XURRENT_MOCK_PERSIST,

    mcpProtocol: parsed.MCP_PROTOCOL,
    stateSecret: parsed.XURRENT_STATE_SECRET,
    stateTtlSeconds: parsed.XURRENT_STATE_TTL,
    wizardTtlSeconds: parsed.XURRENT_WIZARD_TTL,
  };

  validateSemantics(cached, env);
  return cached;
}

function expandHome(p: string): string {
  if (p.startsWith("~/")) return join(process.env["HOME"] ?? "", p.slice(2));
  return p;
}

/**
 * Şema doğrulamasının yakalayamadığı iş kuralları.
 * Hata FIRLATMAZ; uyarı basar — ders materyalinin yanlış yapılandırmayla da
 * açılıp öğrenciye ne eksik olduğunu SÖYLEMESİ gerekir.
 */
function validateSemantics(cfg: AppConfig, env: Record<string, string | undefined>): void {
  const problems: string[] = [];

  if (cfg.mode === "live") {
    if (!cfg.token) problems.push("XURRENT_MODE=live ama XURRENT_TOKEN boş.");
    if (!cfg.account) problems.push("XURRENT_MODE=live ama XURRENT_ACCOUNT boş (numerik değil, slug).");
  }

  // "eu" diye bir bölge YOKTUR: wildcard DNS ile çözülür ama TLS hatası verir.
  if (/graphql\.eu\.xurrent\.com/i.test(cfg.graphqlUrl)) {
    problems.push(
      'XURRENT_GRAPHQL_URL "eu" bölgesini gösteriyor — böyle bir bölge YOKTUR. Global zaten Avrupa\'dadır.',
    );
  }

  // Tanınmayan XURRENT_API değeri sessizce graphql'e düştü — SÖYLE. Öğrenci
  // "rest'e geçtim ama tek istek görüyorum" şaşkınlığını yaşamamalı.
  const rawApi = env["XURRENT_API"];
  if (rawApi && !["graphql", "rest"].includes(rawApi)) {
    problems.push(
      `XURRENT_API="${rawApi}" tanınmıyor. Geçerli değerler: graphql (varsayılan), rest. Varsayılana düşüldü.`,
    );
  }
  if (cfg.api === "rest" && cfg.mode === "live") {
    try {
      new URL(cfg.restUrl);
    } catch {
      problems.push(`XURRENT_REST_URL geçerli bir URL değil: ${cfg.restUrl}`);
    }
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: cfg.timeZone });
  } catch {
    problems.push(`XURRENT_TIMEZONE geçersiz bir IANA saat dilimi: ${cfg.timeZone}`);
  }

  if (cfg.maxBackdateDays < 0) problems.push("XURRENT_MAX_BACKDATE_DAYS negatif olamaz.");

  // Retry düğmeleri: geçersiz değer sessizce düzeltildi — SÖYLE.
  // Dikkat: Number("") === 0'dır — boş/tanımsız değişken "0 verildi" sanılmamalı.
  const rawAttemptsStr = env["XURRENT_RETRY_MAX_ATTEMPTS"];
  const rawAttempts = rawAttemptsStr ? Number(rawAttemptsStr) : NaN;
  if (Number.isFinite(rawAttempts) && rawAttempts < 1) {
    problems.push(
      `XURRENT_RETRY_MAX_ATTEMPTS=${rawAttempts} geçersiz (en az 1 olmalı — 1 retry'ı kapatır). 1'e çekildi.`,
    );
  }
  if (cfg.retryCapMs < cfg.retryBaseMs) {
    problems.push(
      `XURRENT_RETRY_CAP_MS (${cfg.retryCapMs}) < XURRENT_RETRY_BASE_MS (${cfg.retryBaseMs}) — tavan tabandan küçük; beklemeler hep tavana kırpılacak.`,
    );
  }

  // Tanınmayan MCP_PROTOCOL değeri sessizce varsayılana düştü — SÖYLE.
  const rawProtocol = env["MCP_PROTOCOL"];
  if (rawProtocol && !["2026-07-28", "2025-11-25", "both"].includes(rawProtocol)) {
    problems.push(
      `MCP_PROTOCOL="${rawProtocol}" tanınmıyor. Geçerli değerler: 2026-07-28 (varsayılan), 2025-11-25, both. Varsayılana düşüldü.`,
    );
  }

  // Aynı kural onay politikası için de geçerli: yazım hatası SESSİZCE "closed"a düşer
  // ve öğrenci "strict açtım ama bir şey değişmedi" sanır. Söylenmesi gerekir.
  const rawPolicy = env["XURRENT_CONFIRM_POLICY"];
  if (rawPolicy && !["closed", "open", "strict"].includes(rawPolicy)) {
    problems.push(
      `XURRENT_CONFIRM_POLICY="${rawPolicy}" tanınmıyor. Geçerli değerler: closed (varsayılan), open, strict. Varsayılana düşüldü.`,
    );
  }
  // "open" bilinçli olarak ÇİRKİN bırakıldı: kimse yanlışlıkla bu modda çalışmasın.
  if (cfg.confirmPolicy === "open") {
    problems.push(
      "XURRENT_CONFIRM_POLICY=open — yazma öncesi onay HİÇ SORULMAYACAK. Bu ayar yalnızca CI/otomasyon içindir.",
    );
  }
  if (cfg.stateTtlSeconds <= 0) problems.push("XURRENT_STATE_TTL pozitif olmalıdır (saniye).");
  if (cfg.wizardTtlSeconds <= 0) problems.push("XURRENT_WIZARD_TTL pozitif olmalıdır (saniye).");

  // GEMINI_BASE_URL bozuksa hata chatbot'un ilk isteğinde "fetch failed" olarak
  // çıkar ve sebebi görünmez. Açılışta söylenmesi daha ucuz.
  try {
    new URL(cfg.geminiBaseUrl);
  } catch {
    problems.push(`GEMINI_BASE_URL geçerli bir URL değil: ${cfg.geminiBaseUrl}`);
  }

  // Anthropic KALDIRILDI. Eski değişkenler .env'de kalmışsa sessizce yok sayılır;
  // "anahtarı koydum ama çalışmıyor" şaşkınlığını önlemek için söylenir.
  for (const stale of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) {
    if (env[stale]) {
      problems.push(`${stale} artık KULLANILMIYOR — bu proje tek sağlayıcıya (Gemini) geçti. GEMINI_API_KEY / GEMINI_MODEL kullanın.`);
    }
  }

  if (problems.length) {
    for (const p of problems) process.stderr.write(`[xurrent-mcp:warn] yapılandırma: ${p}\n`);
  }
}

export function resetConfigCache(): void {
  cached = null;
}
