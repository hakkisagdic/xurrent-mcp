using System.Security.Cryptography;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace XurrentMcp;

/// <summary>
/// K1 — MCP_PROTOCOL'ün üç değeri.
///
/// ÖNEMLİ ÖLÇÜM NOTU: ModelContextProtocol 2.0.0 TEK BAŞINA her iki revizyonu da konuşur
/// (server/discover + per-request _meta VE initialize el sıkışması). Yani C# tarafında
/// "Core + V1 + V2" diye ÜÇ PROJE gerekmez — sözleşmenin bağımlılık izolasyonu tablosu
/// 1.x + 2.x'i yan yana koymayı varsayıyordu; 2.0.0 ikisini birden konuştuğu için
/// o ayrıştırmaya gerek kalmadı. Tek proje yeterlidir.
///
/// Bu enum yalnızca ŞUNU seçer: hangi revizyon ADVERTISE edilir ve onay hangi yolla sorulur.
/// </summary>
public enum ProtocolChoice
{
    /// <summary>2025-11-25 — yalnızca v1. Sunucu server/discover'ı REDDEDER; onay elicitation/create ile sorulur.</summary>
    V1,

    /// <summary>
    /// 2026-07-28 — VARSAYILAN. Onay MRTR (InputRequiredResult + imzalı requestState) ile sorulur.
    /// Sunucu sürümü PİNLENMEZ: geriye dönük uyumluluk sondası (server/discover → yoksa initialize)
    /// ancak sunucu ikisini de kabul ederse derste canlı gösterilebilir.
    /// </summary>
    V2,

    /// <summary>both — HTTP'de iki ayrı yol (/mcp/v1, /mcp/v2). stdio'da GEÇERSİZ.</summary>
    Both,
}

/// <summary>
/// Tüm ortam değişkenlerini tek yerde toplayan yapılandırma nesnesi.
/// TypeScript ve Python implementasyonlarındaki config modülü ile BİREBİR aynı
/// alanları taşır — üç dil de aynı .env dosyasını okur.
/// </summary>
public sealed class AppConfig
{
    // ── 1) Xurrent adapter ────────────────────────────────────────────────────
    public string XurrentMode { get; init; } = "mock";
    public string XurrentToken { get; init; } = "";
    public string XurrentAccount { get; init; } = "";
    public string XurrentGraphqlUrl { get; init; } = "https://graphql.xurrent.com";

    /// <summary>
    /// XURRENT_API — live modda hangi transportun konuşulacağı (bkz. docs/16).
    ///   "graphql"     → varsayılan; elle yazılmış GraphQL adaptörü (LiveAdapter).
    ///   "rest"        → developer.xurrent.com/v1 REST adaptörü (RestAdapter).
    ///   "graphql-sdk" → resmî Xurrent.GraphQL NuGet SDK'sı (SdkLiveAdapter).
    /// ★ "graphql-sdk" YALNIZCA C#'ta vardır: TS/Python bilinçli olarak bu değeri
    /// tanımaz — ders "vendor SDK vs elle yazılmış istemci, TEK sözleşme altında"
    /// karşılaştırmasını C# üzerinden verir.
    /// </summary>
    public string XurrentApi { get; init; } = "graphql";

    /// <summary>REST v1 taban adresi. Sahte sunucuya yönlendirme: http://127.0.0.1:4000/v1</summary>
    public string XurrentRestUrl { get; init; } = "https://api.xurrent.com/v1";

    // ── 2) Güvenlik anahtarları ──────────────────────────────────────────────
    public bool XurrentDryRun { get; init; }

    /// <summary>
    /// "open"   — onay hiç sorulmaz (YALNIZCA CI/otomasyon).
    /// "closed" — VARSAYILAN; yalnızca live modda yazma öncesi onay sorulur (K5).
    /// "strict" — mock modda da sorulur; MRTR onay akışını derste göstermek içindir.
    /// </summary>
    public string XurrentConfirmPolicy { get; init; } = "closed";
    public string XurrentSource { get; init; } = "xurrent-mcp";

    /// <summary>
    /// requestState imza anahtarı. Verilmezse süreç başlangıcında rastgele üretilir —
    /// yeniden başlatınca eski state'ler geçersiz olur ve bu İSTENEN davranıştır.
    /// </summary>
    public string StateSecret { get; init; } = "";

    /// <summary>requestState yaşam süresi (saniye). Spec'in önerdiği pencere 5 dakikadır.</summary>
    public int StateTtlSeconds { get; init; } = 300;

    /// <summary>
    /// timesheet_wizard sessionState yaşam süresi (saniye). Varsayılan 1800 —
    /// çok adımlı sohbet, requestState'in 300'ünden bilinçli olarak uzundur
    /// (contract/wizard.md §4).
    /// </summary>
    public int WizardTtlSeconds { get; init; } = 1800;

    /// <summary>MCP_PROTOCOL ortam değişkeninin çözülmüş hâli (K1).</summary>
    public ProtocolChoice McpProtocol { get; init; } = ProtocolChoice.V2;

    // ── 2b) Güvenilirlik düğmeleri (contract/reliability.md §3, §4, §7) ──────
    // Üç dil de aynı dört env anahtarını okur; politika TEK yerde tanımlıdır.

    /// <summary>Toplam deneme sayısı, İLK istek DAHİL. 1 = retry tamamen kapalı.</summary>
    public int RetryMaxAttempts { get; init; } = 5;

    /// <summary>Üstel geri çekilmenin tabanı (ms): bekleme = rastgele(0, min(CAP, BASE·2^(k-1))).</summary>
    public int RetryBaseMs { get; init; } = 500;

    /// <summary>Tek bir beklemenin tavanı (ms).</summary>
    public int RetryCapMs { get; init; } = 8000;

    /// <summary>
    /// Adaptör gazı: iki HTTP isteği arasındaki minimum boşluk (ms). Xurrent sınırı
    /// 20 istek / 2 sn → varsayılan 110. Retry tekrarları DAHİL her istek bu kapıdan geçer;
    /// bulk döngülerinde ayrıca bekleme YOKTUR — gaz tek yerde yaşar (reliability.md §4).
    /// </summary>
    public int MinRequestGapMs { get; init; } = 110;

    // ── 3) Backdating stratejisi ─────────────────────────────────────────────
    public string BackdateStrategy { get; init; } = "two_step";
    public int MaxBackdateDays { get; init; } = 1;

    // ── 4) Takvim sağlayıcısı ────────────────────────────────────────────────
    public string CalendarProvider { get; init; } = "mock";
    public string CalendarIcsPath { get; init; } = "";
    public string CalendarIcsUrl { get; init; } = "";

    public string GoogleClientId { get; init; } = "";
    public string GoogleClientSecret { get; init; } = "";
    public string GoogleTokenPath { get; init; } = "~/.xurrent-mcp/google-token.json";
    public string GoogleCalendarId { get; init; } = "primary";
    public string GoogleSaClientEmail { get; init; } = "";
    public string GoogleSaPrivateKey { get; init; } = "";
    public string GoogleImpersonateUser { get; init; } = "";

    public string MsTenantId { get; init; } = "";
    public string MsClientId { get; init; } = "";
    public string MsClientSecret { get; init; } = "";
    public string MsImpersonateUser { get; init; } = "";

    // ── 5) Yerel ayarlar ─────────────────────────────────────────────────────
    public string TimeZoneId { get; init; } = "Europe/Istanbul";
    public string DefaultTimeAllocationId { get; init; } = "";
    public string RoundingMode { get; init; } = "nearest";

    // ── 6) Chatbot (tek sağlayıcı: Gemini) ───────────────────────────────────
    public string GeminiApiKey { get; init; } = "";

    /// <summary>
    /// VARSAYILAN SEÇİMİ — ezberden değil, ai.google.dev/gemini-api/docs/models sayfasından:
    /// orada STABİL olarak listelenen flash modeller arasında gemini-3.6-flash "hızı zekâyla
    /// dengeleyen en yeni model" ve AJANİK/tool-calling işler için önerilen seçenek olarak
    /// geçiyor. Bu chatbot tam olarak o işi yapar (çok turlu tool döngüsü), o yüzden bu.
    /// Preview modeller (gemini-3-flash-preview vb.) bilinçli olarak seçilmedi: ders
    /// materyalinin varsayılanı sürpriz yapmamalı. GEMINI_MODEL ile her zaman ezilebilir.
    /// Üç dil de aynı .env'i okur; TypeScript ve Python tarafı da aynı varsayılanı ilan eder.
    /// </summary>
    public string GeminiModel { get; init; } = Llm.GeminiClient.DefaultModel;

    /// <summary>
    /// API kökü. Sahte Gemini sunucusuna (tools/fake-gemini) yönlendirmek için değiştirilir:
    /// GEMINI_BASE_URL=http://127.0.0.1:5100
    /// </summary>
    public string GeminiBaseUrl { get; init; } = Llm.GeminiClient.DefaultBaseUrl;

    public int WebPort { get; init; } = 8787;
    public int McpHttpPort { get; init; } = 8788;

    // ── 8) HTTP yüzeyi — dış istemciler (.env.example §8) ────────────────────

    /// <summary>
    /// MCP_API_KEY — HTTP transport kapısı. BOŞSA sunucu yalnız loopback'e bağlanır
    /// (mevcut güvenlik duruşu). DOLUYSA 0.0.0.0'a bağlanır ve her /mcp* isteğinde
    /// X-MCP-Api-Key başlığının bu değere eşit olması zorunludur (sabit-zamanlı
    /// karşılaştırma — Agent/HttpKapi.AnahtarUygun). Xurrent PAT'i ile KARIŞTIRMAYIN:
    /// bu anahtar MCP sunucusunun kendisini korur, Xurrent kimliği sunucuda kalır.
    /// </summary>
    public string McpApiKey { get; init; } = "";

    // ── Türetilmiş yollar ────────────────────────────────────────────────────
    public string RepoRoot { get; init; } = "";
    public string FixturesDir { get; init; } = "";

    /// <summary>
    /// IANA saat dilimi. macOS/.NET 10 IANA adlarını doğrudan destekler.
    /// NEDEN önemli: takvim penceresi ve fixture tarihleri bu dilimin YEREL gece
    /// yarılarına göre kurulur; çıplak (offset'siz) timestamp sessizce yanlış gün getirir.
    /// </summary>
    public TimeZoneInfo TimeZone
    {
        get
        {
            try { return TimeZoneInfo.FindSystemTimeZoneById(TimeZoneId); }
            catch (TimeZoneNotFoundException) { return TimeZoneInfo.Utc; }
            catch (InvalidTimeZoneException) { return TimeZoneInfo.Utc; }
        }
    }

    /// <summary>
    /// ★ ENJEKTE EDİLEBİLİR SAAT. Üretimde TimeProvider.System'dir; hiçbir davranış değişmez.
    /// Birim testleri bunu sabit bir ana kilitler — aksi halde "bugün"e dayanan her kural
    /// (backdate sınırı, fixture materyalizasyonu, requestState TTL'i) testin çalıştığı
    /// SAATE bağlı olurdu ve gece yarısı civarında kırılırdı.
    /// </summary>
    public TimeProvider Clock { get; init; } = TimeProvider.System;

    public bool IsMock => !string.Equals(XurrentMode, "live", StringComparison.OrdinalIgnoreCase);

    public static AppConfig Load()
    {
        var repoRoot = FindRepoRoot();
        LoadDotEnv(Path.Combine(repoRoot, ".env"));

        var fixtures = Env("XURRENT_FIXTURES_DIR");
        if (string.IsNullOrWhiteSpace(fixtures))
            fixtures = Path.Combine(repoRoot, "fixtures");

        return new AppConfig
        {
            RepoRoot = repoRoot,
            FixturesDir = fixtures,

            XurrentMode = Env("XURRENT_MODE", "mock"),
            XurrentToken = Env("XURRENT_TOKEN"),
            XurrentAccount = Env("XURRENT_ACCOUNT"),
            XurrentGraphqlUrl = Env("XURRENT_GRAPHQL_URL", "https://graphql.xurrent.com"),
            XurrentApi = ParseApi(Env("XURRENT_API", "graphql")),
            XurrentRestUrl = Env("XURRENT_REST_URL", "https://api.xurrent.com/v1"),

            XurrentDryRun = EnvBool("XURRENT_DRY_RUN"),
            XurrentConfirmPolicy = Env("XURRENT_CONFIRM_POLICY", "closed"),
            XurrentSource = Env("XURRENT_SOURCE", "xurrent-mcp"),

            // Anahtar verilmediyse süreç ömrü boyunca geçerli rastgele bir anahtar üretilir.
            StateSecret = Env("XURRENT_STATE_SECRET") is { Length: > 0 } s
                ? s
                : Convert.ToHexString(RandomNumberGenerator.GetBytes(32)),
            StateTtlSeconds = EnvInt("XURRENT_STATE_TTL", 300),
            WizardTtlSeconds = EnvInt("XURRENT_WIZARD_TTL", 1800),
            McpProtocol = ParseProtocol(Env("MCP_PROTOCOL", "2026-07-28")),

            RetryMaxAttempts = EnvInt("XURRENT_RETRY_MAX_ATTEMPTS", 5),
            RetryBaseMs = EnvInt("XURRENT_RETRY_BASE_MS", 500),
            RetryCapMs = EnvInt("XURRENT_RETRY_CAP_MS", 8000),
            MinRequestGapMs = EnvInt("XURRENT_MIN_REQUEST_GAP_MS", 110),

            BackdateStrategy = Env("XURRENT_BACKDATE_STRATEGY", "two_step"),
            MaxBackdateDays = EnvInt("XURRENT_MAX_BACKDATE_DAYS", 1),

            CalendarProvider = Env("CALENDAR_PROVIDER", "mock"),
            CalendarIcsPath = Env("CALENDAR_ICS_PATH", Path.Combine(fixtures, "calendar.ics")),
            CalendarIcsUrl = Env("CALENDAR_ICS_URL"),

            GoogleClientId = Env("GOOGLE_CLIENT_ID"),
            GoogleClientSecret = Env("GOOGLE_CLIENT_SECRET"),
            GoogleTokenPath = Env("GOOGLE_TOKEN_PATH", "~/.xurrent-mcp/google-token.json"),
            GoogleCalendarId = Env("GOOGLE_CALENDAR_ID", "primary"),
            GoogleSaClientEmail = Env("GOOGLE_SA_CLIENT_EMAIL"),
            GoogleSaPrivateKey = Env("GOOGLE_SA_PRIVATE_KEY"),
            GoogleImpersonateUser = Env("GOOGLE_IMPERSONATE_USER"),

            MsTenantId = Env("MS_TENANT_ID"),
            MsClientId = Env("MS_CLIENT_ID"),
            MsClientSecret = Env("MS_CLIENT_SECRET"),
            MsImpersonateUser = Env("MS_IMPERSONATE_USER"),

            TimeZoneId = Env("XURRENT_TIMEZONE", "Europe/Istanbul"),
            DefaultTimeAllocationId = Env("DEFAULT_TIME_ALLOCATION_ID", "TW9jay9UaW1lQWxsb2NhdGlvbi8x"),
            RoundingMode = Env("ROUNDING_MODE", "nearest"),

            GeminiApiKey = Env("GEMINI_API_KEY"),
            GeminiModel = Env("GEMINI_MODEL", Llm.GeminiClient.DefaultModel),
            GeminiBaseUrl = Env("GEMINI_BASE_URL", Llm.GeminiClient.DefaultBaseUrl),
            WebPort = EnvInt("WEB_PORT", 8787),
            McpHttpPort = EnvInt("MCP_HTTP_PORT", 8788),
            McpApiKey = Env("MCP_API_KEY"),
        };
    }

    /// <summary>
    /// XURRENT_API çözümlemesi. MCP_PROTOCOL ile aynı ilke: bilinmeyen değer
    /// SESSİZCE varsayılana düşmez — yapılandırma hatası çalışma anında görünmelidir.
    /// </summary>
    private static string ParseApi(string raw) => raw.Trim().ToLowerInvariant() switch
    {
        "graphql" => "graphql",
        "rest" => "rest",
        // ★ C#'a özgü üçüncü değer (resmî Xurrent.GraphQL SDK'sı) — TS/Python bilerek tanımaz.
        "graphql-sdk" => "graphql-sdk",
        var other => throw new InvalidOperationException(
            $"XURRENT_API değeri geçersiz: '{other}'. " +
            "İzinli değerler: graphql (varsayılan) | rest | graphql-sdk (yalnız C#)."),
    };

    // Repo kökü: contract/tools.json'ın bulunduğu dizin. Hem `dotnet run` (cwd = proje)
    // hem de derlenmiş apphost (bin/Debug/net10.0) senaryosunda çalışsın diye
    // iki başlangıç noktasından da yukarı doğru aranır.
    private static string FindRepoRoot()
    {
        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var dir = new DirectoryInfo(start);
            while (dir is not null)
            {
                if (File.Exists(Path.Combine(dir.FullName, "contract", "tools.json")))
                    return dir.FullName;
                dir = dir.Parent;
            }
        }
        return Directory.GetCurrentDirectory();
    }

    // Çok basit bir .env okuyucu. Zaten set edilmiş ortam değişkenleri EZİLMEZ —
    // .mcp.json'dan gelen env değerleri .env'i geçersiz kılabilsin diye.
    private static void LoadDotEnv(string path)
    {
        if (!File.Exists(path)) return;
        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#')) continue;
            var eq = line.IndexOf('=');
            if (eq <= 0) continue;
            var key = line[..eq].Trim();
            var val = line[(eq + 1)..].Trim();
            if (val.Length >= 2 && ((val[0] == '"' && val[^1] == '"') || (val[0] == '\'' && val[^1] == '\'')))
                val = val[1..^1];
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
                Environment.SetEnvironmentVariable(key, val);
        }
    }

    /// <summary>
    /// MCP_PROTOCOL çözümlemesi. Bilinmeyen değer SESSİZCE varsayılana düşmez —
    /// yapılandırma hatası çalışma anında fark edilmelidir.
    /// </summary>
    private static ProtocolChoice ParseProtocol(string raw) => raw.Trim() switch
    {
        "2026-07-28" => ProtocolChoice.V2,
        "2025-11-25" => ProtocolChoice.V1,
        "both" => ProtocolChoice.Both,
        var other => throw new InvalidOperationException(
            $"MCP_PROTOCOL değeri geçersiz: '{other}'. " +
            "İzinli değerler: 2026-07-28 (varsayılan) | 2025-11-25 | both."),
    };

    private static string Env(string key, string fallback = "")
    {
        var v = Environment.GetEnvironmentVariable(key);
        return string.IsNullOrWhiteSpace(v) ? fallback : v;
    }

    private static bool EnvBool(string key, bool fallback = false)
    {
        var v = Env(key);
        if (v.Length == 0) return fallback;
        return v is "1" or "true" or "True" or "TRUE" or "yes" or "on";
    }

    private static int EnvInt(string key, int fallback)
        => int.TryParse(Env(key), out var n) ? n : fallback;

    public static string ExpandHome(string path)
        => path.StartsWith("~/", StringComparison.Ordinal)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), path[2..])
            : path;
}

/// <summary>Projedeki TÜM JSON serileştirme ayarları tek yerde.</summary>
public static class Json
{
    /// <summary>
    /// NEDEN UnsafeRelaxedJsonEscaping: varsayılan encoder Türkçe karakterleri
    /// ç gibi kaçışlara çevirir. Çıktı derste ekrana yansıtıldığı için
    /// "İş" yerine "İş" görmek kabul edilemez.
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = null,

        // NEDEN açıkça veriliyor: MCP SDK bu options'ı MakeReadOnly() ile dondurur ve
        // TypeInfoResolver atanmamış bir options donmaya çalışınca InvalidOperationException atar.
        // Yansıma tabanlı çözücü zaten örtük varsayılandır; burada sadece görünür kılıyoruz.
        TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
    };

    public static readonly JsonSerializerOptions Pretty = new(Options) { WriteIndented = true };

    public static string Write<T>(T value) => JsonSerializer.Serialize(value, Options);
    public static string WritePretty<T>(T value) => JsonSerializer.Serialize(value, Pretty);
}
