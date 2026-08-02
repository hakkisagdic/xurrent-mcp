using System.IO.Pipelines;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using XurrentMcp.Calendars;
using XurrentMcp.Core;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Mcp;

/// <summary>
/// MCP sunucusunun kurulumu ve servis kaydı.
/// Aynı kurulum dört modda da kullanılır: stdio, http, chat, wizard.
/// </summary>
public static class ServerSetup
{
    public const string ServerName = "xurrent-mcp-csharp";
    public const string ServerVersion = "1.0.0";

    public const string Instructions =
        "Bu sunucu Xurrent (ITSM) üzerinde açık iş listeleme ve zaman girişi yazma yetenekleri sunar.\n" +
        "KURALLAR:\n" +
        "1) Tüm id değerleri opak string'lerdir. ASLA üretme veya tahmin etme — her id bir tool çıktısından gelmelidir.\n" +
        "2) Süreler DAKİKA cinsindendir. '2 saat' -> 120 ve bu çevirimi kullanıcıya SÖYLE.\n" +
        "3) Zaman yazmadan ÖNCE xurrent_get_time_tracking_context çağır; timeIncrement bilinmeden süre seçilemez.\n" +
        "4) Yazma öncesi mutlaka dryRun=true ile planı göster ve kullanıcı onayı al.\n" +
        "5) Toplu yazma ATOMİK DEĞİLDİR; kısmi başarı olasılığını kullanıcıya AÇIKÇA söyle.";

    /// <summary>Xurrent + takvim servisleri. Tool metotlarına DI ile enjekte edilir.</summary>
    public static IServiceCollection AddXurrentServices(this IServiceCollection services, AppConfig cfg)
    {
        services.AddSingleton(cfg);
        services.AddSingleton<HttpClient>(_ => new HttpClient { Timeout = TimeSpan.FromSeconds(30) });

        // Mod seçimi TEK YERDE yapılır; tool katmanı hangi adapter'la konuştuğunu bilmez.
        services.AddSingleton<IXurrentAdapter>(sp => cfg.IsMock
            ? new MockAdapter(cfg)
            : new LiveAdapter(cfg, sp.GetRequiredService<HttpClient>()));

        services.AddSingleton(sp => new CalendarFactory(cfg, sp.GetRequiredService<HttpClient>()));
        return services;
    }

    /// <summary>tools/list için cache ipucu. Tool listemiz STATİKTİR → 5 dakika, herkese açık.</summary>
    public static readonly TimeSpan ToolListTtl = TimeSpan.FromMinutes(5);

    // SDK'nın sürüm sabitleri internal; wire değerlerini burada açıkça tutuyoruz.
    public const string ProtocolV1 = "2025-11-25";
    public const string ProtocolV2 = "2026-07-28";

    public static IMcpServerBuilder AddXurrentMcpServer(this IServiceCollection services, AppConfig cfg)
    {
        // outputSchema'nın kaynağı sözleşmedir; sunucu ayağa kalkmadan yüklenmelidir.
        ToolContracts.Load(cfg.RepoRoot);

        var builder = services.AddMcpServer(options =>
        {
            options.ServerInfo = new Implementation { Name = ServerName, Version = ServerVersion };
            options.ServerInstructions = Instructions;

            // K1: yalnızca v1 istendiğinde sürüm PİNLENİR — bu durumda SDK server/discover'ı
            // reddeder ve tek yol initialize el sıkışması olur. Varsayılan (v2) pinlenmez;
            // geriye dönük uyumluluk sondasının canlı gösterilebilmesi buna bağlıdır.
            if (cfg.McpProtocol == ProtocolChoice.V1)
                options.ProtocolVersion = ProtocolV1;
        });

        // ★ Düşük seviye tool kaydı: outputSchema contract/tools.json'dan ELLE verilir.
        builder.AddXurrentTools();

        // v2 zorunlulukları: ttlMs + cacheScope + DETERMİNİSTİK SIRA.
        // NEDEN filtre: tool koleksiyonu bir sözlüktür, sırası garanti DEĞİLDİR.
        // Sıra sabit olmazsa LLM prompt cache'i her tools/list'te ıskalar.
        builder.WithRequestFilters(filters => filters.AddListToolsFilter(next => async (ctx, ct) =>
        {
            var result = await next(ctx, ct);
            result.Tools = [.. result.Tools.OrderBy(t => IndexOf(t.Name))];
            result.TimeToLive = ToolListTtl;
            result.CacheScope = CacheScope.Public;
            return result;
        }));

        return builder;
    }

    private static int IndexOf(string toolName)
    {
        var i = ToolContracts.Order.ToList().IndexOf(toolName);
        return i < 0 ? int.MaxValue : i;     // sözleşmede olmayan tool en sona
    }

    /// <summary>
    /// stdio modunda logların TAMAMI stderr'e gider.
    /// NEDEN: stdio transport'ta stdout SADECE JSON-RPC içindir. Tek bir Console.WriteLine
    /// protokolü bozar ve client "invalid message" ile bağlantıyı düşürür.
    /// </summary>
    public static void ConfigureStdErrLogging(ILoggingBuilder logging)
    {
        logging.ClearProviders();
        logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
        logging.SetMinimumLevel(LogLevel.Warning);
    }
}

/// <summary>
/// SÜREÇ İÇİ MCP oturumu: sunucu ve client aynı process'te, iki pipe üzerinden
/// GERÇEK JSON-RPC konuşur.
///
/// NEDEN böyle: sihirbaz ve chatbot, tool'ları doğrudan C# metodu olarak çağırsaydı
/// MCP katmanı test EDİLMEMİŞ olurdu. Bu kurulumla ders sırasında gösterilen her çıktı
/// gerçekten protokolden geçer — tools/list sayısı da dahil.
/// </summary>
public sealed class InProcessMcpSession : IAsyncDisposable
{
    private readonly IHost _host;
    public McpClient Client { get; }

    /// <summary>
    /// Sunucu onay istediğinde çağrılır. HOST tarafının işidir: kullanıcıya sormak.
    /// Atanmamışsa FAIL-CLOSED davranırız — cevapsızlık ONAY DEĞİLDİR.
    /// (Sihirbaz bunu atamaz; chatbot terminal/web arayüzüne bağlar.)
    /// </summary>
    public Func<ElicitRequestParams, CancellationToken, ValueTask<bool>>? OnConfirm { get; set; }

    private InProcessMcpSession(IHost host, McpClient client)
    {
        _host = host;
        Client = client;
    }

    public static async Task<InProcessMcpSession> StartAsync(AppConfig cfg, CancellationToken ct = default)
    {
        // client -> server ve server -> client yönleri için iki ayrı pipe.
        var clientToServer = new Pipe();
        var serverToClient = new Pipe();

        var builder = Host.CreateApplicationBuilder();
        ServerSetup.ConfigureStdErrLogging(builder.Logging);
        builder.Services.AddXurrentServices(cfg);
        builder.Services.AddXurrentMcpServer(cfg)
            .WithStreamServerTransport(clientToServer.Reader.AsStream(), serverToClient.Writer.AsStream());

        var host = builder.Build();
        await host.StartAsync(ct);

        var transport = new StreamClientTransport(
            serverInput: clientToServer.Writer.AsStream(),
            serverOutput: serverToClient.Reader.AsStream());

        InProcessMcpSession? session = null;

        var client = await McpClient.CreateAsync(transport, new McpClientOptions
        {
            ClientInfo = new Implementation { Name = "xurrent-mcp-inproc-client", Version = "1.0.0" },

            // Elicitation yeteneği BEYAN EDİLİR. NEDEN: sunucu yazma öncesi onay isteyebilir
            // (live modda ya da XURRENT_CONFIRM_POLICY=strict ile). Yeteneği beyan etmezsek
            // sunucu fail-closed davranır ve chatbot live modda hiç yazamaz.
            Capabilities = new ClientCapabilities { Elicitation = new ElicitationCapability() },
            Handlers = new McpClientHandlers
            {
                ElicitationHandler = async (parameters, cancel) =>
                {
                    var approved = session?.OnConfirm is { } ask && await ask(parameters!, cancel);
                    return approved
                        ? new ElicitResult
                        {
                            Action = "accept",
                            Content = new Dictionary<string, JsonElement>
                            {
                                ["onay"] = JsonSerializer.SerializeToElement(true, Json.Options),
                            },
                        }
                        : new ElicitResult { Action = "decline" };
                },
            },
        }, cancellationToken: ct);

        session = new InProcessMcpSession(host, client);
        return session;
    }

    public async ValueTask DisposeAsync()
    {
        await Client.DisposeAsync();
        await _host.StopAsync();
        _host.Dispose();
    }
}
