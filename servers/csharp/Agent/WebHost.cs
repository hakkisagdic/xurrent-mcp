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
            model = cfg.AnthropicModel,
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
            Console.Error.WriteLine("UYARI: ANTHROPIC_API_KEY tanımlı değil — sohbet devre dışı, arayüz salt görüntüleme modunda.");

        await app.RunAsync(ct);
        await agent.DisposeAsync();
        return 0;
    }

    /// <summary>mod: http — MCP Streamable HTTP transport. Uzak MCP client'lar buraya bağlanır.</summary>
    public static async Task<int> RunMcpHttpAsync(AppConfig cfg, CancellationToken ct)
    {
        var builder = WebApplication.CreateBuilder();
        builder.Logging.ClearProviders();
        builder.Logging.AddConsole();
        builder.WebHost.UseUrls($"http://localhost:{cfg.McpHttpPort}");

        builder.Services.AddXurrentServices(cfg);
        builder.Services.AddXurrentMcpServer(cfg).WithHttpTransport();

        var app = builder.Build();
        app.MapMcp();   // POST/GET /  (Streamable HTTP)

        if (cfg.McpProtocol == ProtocolChoice.Both)
        {
            // K1 — 'both' yalnızca HTTP'de anlamlıdır: iki revizyon iki ayrı YOLDA yayınlanır.
            // NEDEN tek sunucu örneği yetiyor: ModelContextProtocol 2.0.0 aynı örnekte hem
            // initialize el sıkışmasını hem server/discover + per-request _meta akışını konuşur.
            // Yollar client tarafında ayrımı kolaylaştırmak içindir, ayrı süreç/proje GEREKMEZ.
            app.MapMcp("/mcp/v1");
            app.MapMcp("/mcp/v2");
            Console.WriteLine($"MCP Streamable HTTP (both): http://localhost:{cfg.McpHttpPort}/mcp/v1 · /mcp/v2");
        }

        Console.WriteLine($"MCP Streamable HTTP: http://localhost:{cfg.McpHttpPort}");
        await app.RunAsync(ct);
        return 0;
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
