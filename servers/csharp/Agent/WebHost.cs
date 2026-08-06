using System.Collections.Concurrent;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using XurrentMcp.Mcp;

namespace XurrentMcp.Agent;

/// <summary>
/// Web arayüzü (mod: web) ve MCP Streamable HTTP transport'u (mod: http).
///
/// Web katmanı clients/web/API.md sözleşmesini BİREBİR uygular:
///   GET  /  /style.css  /app.js   → statik dosyalar (clients/web)
///   GET  /api/config                → rozet bilgileri, SIR İÇERMEZ
///   POST /api/chat                  → SSE akışı (text, tool_use, tool_result, elicit, done, error)
///   POST /api/elicit                → onay yanıtı (SSE tek yönlü olduğu için ayrı istek)
/// Aynı statik dosyaları üç backend de servis eder; arayüz hangi dilin arkasında
/// çalıştığını bilmez.
/// </summary>
public static class WebHost
{
    /// <summary>Bekleyen onaylar. Cevapsızlık ONAY DEĞİLDİR — 120 sn sonra reddedilir.</summary>
    private static readonly ConcurrentDictionary<string, TaskCompletionSource<bool>> PendingElicitations = new();
    private const int ElicitTimeoutSeconds = 120;

    public static async Task<int> RunWebAsync(AppConfig cfg, CancellationToken ct)
    {
        // requireLlm=false: API key yoksa da arayüz açılır, rozetler dolar, yazma alanı kilitlenir.
        var agent = await AgentCore.CreateAsync(cfg, requireLlm: false, ct);

        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole();
        builder.WebHost.UseUrls($"http://localhost:{cfg.WebPort}");

        var app = builder.Build();
        var webDir = Path.Combine(cfg.RepoRoot, "clients", "web");

        // ── Statik dosyalar ─────────────────────────────────────────────────
        app.MapGet("/", () => ServeStatic(webDir, "index.html", "text/html; charset=utf-8", cfg));
        app.MapGet("/style.css", () => ServeStatic(webDir, "style.css", "text/css; charset=utf-8", cfg));
        app.MapGet("/app.js", () => ServeStatic(webDir, "app.js", "text/javascript; charset=utf-8", cfg));

        // ── /api/config ─────────────────────────────────────────────────────
        // SIR SIZDIRMAZ: yalnızca hasApiKey boolean'ı döner, anahtarın kendisi asla.
        app.MapGet("/api/config", () => Results.Json(new
        {
            mode = cfg.IsMock ? "mock" : "live",
            strategy = cfg.BackdateStrategy,
            calendarProvider = cfg.CalendarProvider,
            model = cfg.GeminiModel,
            hasApiKey = agent.HasLlm,
            language = "csharp",
            dryRunForced = cfg.XurrentDryRun,
            timeZone = cfg.TimeZoneId,
            maxBackdateDays = cfg.MaxBackdateDays,
            toolCount = agent.ToolNames.Count,
        }));

        // ── /api/chat (SSE) ─────────────────────────────────────────────────
        app.MapPost("/api/chat", async (HttpContext http) =>
        {
            var body = await JsonNode.ParseAsync(http.Request.Body, cancellationToken: http.RequestAborted);
            var messages = body?["messages"]?.DeepClone().AsArray() ?? [];

            http.Response.ContentType = "text/event-stream; charset=utf-8";
            http.Response.Headers.CacheControl = "no-cache, no-transform";
            http.Response.Headers.Connection = "keep-alive";
            // Ters vekil arkasında tamponlama akışı öldürür.
            http.Response.Headers["X-Accel-Buffering"] = "no";

            var sink = new SseSink(http, cfg);
            await agent.RunTurnAsync(messages, sink, http.RequestAborted);
        });

        // ── /api/elicit ─────────────────────────────────────────────────────
        app.MapPost("/api/elicit", async (HttpContext http) =>
        {
            var body = await JsonNode.ParseAsync(http.Request.Body, cancellationToken: ct);
            var id = body?["id"]?.GetValue<string>();
            if (id is null || body?["accept"] is null)
                return Results.Json(new { ok = false, error = "Gövde hatalı: 'id' ve 'accept' zorunludur." }, statusCode: 400);

            if (!PendingElicitations.TryRemove(id, out var tcs))
                return Results.Json(new { ok = false, error = "Onay isteği bulunamadı veya zaman aşımına uğradı." }, statusCode: 404);

            tcs.TrySetResult(body["accept"]!.GetValue<bool>());
            return Results.Json(new { ok = true });
        });

        Console.WriteLine($"Web arayüzü: http://localhost:{cfg.WebPort}  (dil: C#, tool sayısı: {agent.ToolNames.Count})");
        if (!agent.HasLlm)
            Console.Error.WriteLine("UYARI: GEMINI_API_KEY tanımlı değil — sohbet devre dışı, arayüz salt görüntüleme modunda.");

        await app.RunAsync(ct);
        await agent.DisposeAsync();
        return 0;
    }

    /// <summary>
    /// mod: http — MCP Streamable HTTP transport (WP6, uyumlaştırılmış yollar).
    ///
    /// YOL TABLOSU (HttpKapi.YolTablosu — üç dil aynı tabloyu servis eder):
    ///   MCP_PROTOCOL tek dönem → /mcp (o dönemin session duruşuyla)
    ///   MCP_PROTOCOL=both      → /mcp/v1 (2025-11-25, SESSIONFUL: initialize
    ///                            Mcp-Session-Id üretir) + /mcp/v2 (2026-07-28,
    ///                            STATELESS) + /mcp = v2 takma adı.
    ///
    /// ★ NEDEN 'both' modda İKİ Kestrel: SDK'da session duruşu
    /// HttpServerTransportOptions.Stateless ile seçilir ve bu ayar DI konteyneri
    /// başına TEKTİR (StreamableHttpHandler singleton'dır — sonda ile doğrulandı).
    /// Stateful sunucu 2026-07-28 isteğini bilerek REDDEDER, stateless sunucu ise
    /// Mcp-Session-Id üretmez — yani tek pipeline iki duruşu birden VEREMEZ.
    /// Çözüm: v1 pipeline'ı iç loopback portta ayrı bir Kestrel'de yaşar; ana
    /// uygulama /mcp/v1 isteklerini oraya AYNEN iletir. Dışarıdan tek port görünür.
    ///
    /// MCP_API_KEY kapısı (HttpKapi.AnahtarUygun — .env §8): anahtar BOŞ → yalnız
    /// loopback dinlenir (mevcut duruş, kapı yok). DOLU → 0.0.0.0 dinlenir ve HER
    /// /mcp* isteği X-MCP-Api-Key başlığını sabit-zamanlı karşılaştırmayla geçmek
    /// zorundadır; aksi hâlde kısa Türkçe gövdeli 401. Tüm dönemlere uygulanır.
    /// </summary>
    public static async Task<int> RunMcpHttpAsync(AppConfig cfg, CancellationToken ct)
    {
        // ── 'both': v1 (sessionful) pipeline iç loopback Kestrel'inde ──────────
        WebApplication? v1App = null;
        Uri? v1Hedef = null;
        if (cfg.McpProtocol == ProtocolChoice.Both)
        {
            v1App = BuildMcpApp(cfg, ProtocolChoice.V1, stateless: false,
                url: "http://127.0.0.1:0", mapPath: "/mcp/v1");
            await v1App.StartAsync(ct);
            v1Hedef = new Uri(v1App.Urls.First());
        }

        // ── ana uygulama: tek dönemin duruşu, ya da 'both' için v2 (stateless) ─
        var anaProtokol = cfg.McpProtocol == ProtocolChoice.Both ? ProtocolChoice.V2 : cfg.McpProtocol;
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole();
        builder.WebHost.UseUrls(HttpKapi.DinlemeAdresi(cfg.McpApiKey, cfg.McpHttpPort));

        builder.Services.AddXurrentServices(cfg);
        builder.Services.AddXurrentMcpServer(cfg, anaProtokol)
            // Session duruşu sözleşmenin parçasıdır: v1 sessionful, v2 stateless.
            .WithHttpTransport(o => o.Stateless = anaProtokol != ProtocolChoice.V1);

        var app = builder.Build();

        // API anahtarı kapısı — TÜM /mcp* yolları (proxy'lenen /mcp/v1 dahil).
        app.Use(async (http, next) =>
        {
            if (http.Request.Path.StartsWithSegments("/mcp")
                && !HttpKapi.AnahtarUygun(cfg.McpApiKey, http.Request.Headers["X-MCP-Api-Key"]))
            {
                http.Response.StatusCode = 401;
                http.Response.ContentType = "application/json; charset=utf-8";
                await http.Response.WriteAsync(
                    """{"error":"Yetkisiz: X-MCP-Api-Key başlığı eksik veya hatalı."}""",
                    http.RequestAborted);
                return;
            }
            await next();
        });

        if (cfg.McpProtocol == ProtocolChoice.Both)
        {
            // /mcp/v1 → iç sessionful Kestrel'e vekâlet (yol aynen korunur).
            var proxyClient = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
            app.Use(async (http, next) =>
            {
                if (http.Request.Path.StartsWithSegments("/mcp/v1"))
                {
                    await ProxyAsync(http, proxyClient, v1Hedef!);
                    return;
                }
                await next();
            });

            app.MapMcp("/mcp/v2");
            app.MapMcp("/mcp");     // v2 takma adı — güncel dönem varsayılan kapıdır
        }
        else
        {
            app.MapMcp("/mcp");
        }

        foreach (var yol in HttpKapi.YolTablosu(cfg.McpProtocol))
            Console.WriteLine($"MCP Streamable HTTP: http://localhost:{cfg.McpHttpPort}{yol.Yol}  " +
                              $"({yol.ProtokolSurumu}, {(yol.Sessionful ? "sessionful" : "stateless")})");
        if (!string.IsNullOrEmpty(cfg.McpApiKey))
            Console.WriteLine("MCP_API_KEY etkin: 0.0.0.0 dinleniyor, /mcp* için X-MCP-Api-Key zorunlu.");

        await app.RunAsync(ct);
        if (v1App is not null) await v1App.StopAsync(CancellationToken.None);
        return 0;
    }

    /// <summary>Tek duruşlu bir MCP pipeline'ı kurar ('both' modunun iç v1 sunucusu).</summary>
    private static WebApplication BuildMcpApp(
        AppConfig cfg, ProtocolChoice protokol, bool stateless, string url, string mapPath)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole();
        builder.WebHost.UseUrls(url);
        builder.Services.AddXurrentServices(cfg);
        builder.Services.AddXurrentMcpServer(cfg, protokol)
            .WithHttpTransport(o => o.Stateless = stateless);
        var app = builder.Build();
        app.MapMcp(mapPath);
        return app;
    }

    /// <summary>
    /// Minimal ters vekil: yöntem + yol + başlıklar + gövde aynen iletilir, yanıt
    /// AKTARILIRKEN parça parça flush edilir (SSE akışı tamponlanırsa ÖLÜR).
    /// Mcp-Session-Id başlığı iki yönde de dokunulmadan geçer — v1'in session
    /// sözleşmesi vekilin arkasında da aynen görünür.
    /// </summary>
    private static async Task ProxyAsync(HttpContext http, HttpClient client, Uri hedefKok)
    {
        var hedef = new UriBuilder(hedefKok)
        {
            Path = http.Request.Path.Value,
            Query = http.Request.QueryString.Value ?? "",
        }.Uri;

        using var istek = new HttpRequestMessage(new HttpMethod(http.Request.Method), hedef);
        if (http.Request.ContentLength is > 0 || http.Request.Headers.ContainsKey("Transfer-Encoding"))
            istek.Content = new StreamContent(http.Request.Body);

        foreach (var h in http.Request.Headers)
        {
            if (h.Key.Equals("Host", StringComparison.OrdinalIgnoreCase)) continue;
            if (!istek.Headers.TryAddWithoutValidation(h.Key, (IEnumerable<string?>)h.Value))
                istek.Content?.Headers.TryAddWithoutValidation(h.Key, (IEnumerable<string?>)h.Value);
        }

        using var yanit = await client.SendAsync(
            istek, HttpCompletionOption.ResponseHeadersRead, http.RequestAborted);

        http.Response.StatusCode = (int)yanit.StatusCode;
        foreach (var h in yanit.Headers) http.Response.Headers[h.Key] = h.Value.ToArray();
        foreach (var h in yanit.Content.Headers) http.Response.Headers[h.Key] = h.Value.ToArray();
        // Kestrel gövdeyi kendisi çerçeveler; iç sunucunun chunk başlığı taşınmaz.
        http.Response.Headers.Remove("transfer-encoding");

        await using var kaynak = await yanit.Content.ReadAsStreamAsync(http.RequestAborted);
        var tampon = new byte[8192];
        int okunan;
        while ((okunan = await kaynak.ReadAsync(tampon, http.RequestAborted)) > 0)
        {
            await http.Response.Body.WriteAsync(tampon.AsMemory(0, okunan), http.RequestAborted);
            await http.Response.Body.FlushAsync(http.RequestAborted);   // SSE için şart
        }
    }

    // ── SSE alıcısı ──────────────────────────────────────────────────────────

    private sealed class SseSink(HttpContext http, AppConfig cfg) : IAgentSink
    {
        private int _elicitSeq;

        public Task TextAsync(string text, CancellationToken ct)
            => SendAsync("text", new JsonObject { ["delta"] = text }, ct);

        public Task ToolUseAsync(string id, string name, JsonNode? args, CancellationToken ct)
            => SendAsync("tool_use", new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["args"] = args ?? new JsonObject(),
            }, ct);

        public Task ToolResultAsync(string id, string name, bool isError, long durationMs,
            string? summary, JsonNode? result, CancellationToken ct)
            => SendAsync("tool_result", new JsonObject
            {
                ["id"] = id,
                ["name"] = name,
                ["isError"] = isError,
                ["durationMs"] = durationMs,
                ["summary"] = summary,
                ["result"] = result ?? null,
            }, ct);

        public async Task<bool> ConfirmAsync(string id, string message, JsonObject details, CancellationToken ct)
        {
            // XURRENT_CONFIRM_POLICY=open yalnızca CI/otomasyon içindir; varsayılan 'closed'tır.
            if (cfg.XurrentConfirmPolicy == "open") return true;

            var elicitId = $"el_{Interlocked.Increment(ref _elicitSeq)}";
            var tcs = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            PendingElicitations[elicitId] = tcs;

            await SendAsync("elicit", new JsonObject
            {
                ["id"] = elicitId,
                ["message"] = message,
                ["kind"] = "confirm",
                ["confirmLabel"] = "Onayla",
                ["cancelLabel"] = "İptal",
                ["details"] = details,
            }, ct);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(ElicitTimeoutSeconds));
            timeout.Token.Register(() => tcs.TrySetResult(false)); // fail-closed

            var accepted = await tcs.Task;
            PendingElicitations.TryRemove(elicitId, out _);
            return accepted;
        }

        public Task DoneAsync(string stopReason, JsonArray messages, CancellationToken ct)
            => SendAsync("done", new JsonObject
            {
                ["stopReason"] = stopReason,
                ["messages"] = messages.DeepClone(),
            }, ct);

        public Task ErrorAsync(string message, string? code, CancellationToken ct)
            => SendAsync("error", new JsonObject { ["message"] = message, ["code"] = code }, ct);

        /// <summary>SSE çerçevesi: 'data:' TEK SATIR olmalıdır, yoksa arayüz olayı sessizce kaçırır.</summary>
        private async Task SendAsync(string eventName, JsonObject payload, CancellationToken ct)
        {
            var json = payload.ToJsonString(Json.Options).Replace("\n", "\\n").Replace("\r", "");
            var frame = $"event: {eventName}\ndata: {json}\n\n";
            await http.Response.Body.WriteAsync(Encoding.UTF8.GetBytes(frame), ct);
            await http.Response.Body.FlushAsync(ct);
        }
    }

    // ── Statik dosya sunumu ──────────────────────────────────────────────────

    private static IResult ServeStatic(string webDir, string file, string contentType, AppConfig cfg)
    {
        var path = Path.Combine(webDir, file);
        if (File.Exists(path)) return Results.Text(File.ReadAllText(path), contentType);
        if (file == "index.html") return Results.Text(FallbackPage(cfg), "text/html; charset=utf-8");
        return Results.NotFound();
    }

    private static string FallbackPage(AppConfig cfg) => $$"""
        <!doctype html>
        <html lang="tr"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>xurrent-mcp · C#</title></head>
        <body style="font-family:system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;line-height:1.6">
          <h1>xurrent-mcp — C# sunucusu</h1>
          <p>Ortak web arayüzü (<code>clients/web/index.html</code>) bulunamadı.</p>
          <p>Xurrent modu: <b>{{cfg.XurrentMode}}</b> · Takvim: <b>{{cfg.CalendarProvider}}</b> ·
             Strateji: <b>{{cfg.BackdateStrategy}}</b></p>
          <p>Uçlar hazır: <code>GET /api/config</code>, <code>POST /api/chat</code>, <code>POST /api/elicit</code></p>
        </body></html>
        """;
}
