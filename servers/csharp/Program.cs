using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using XurrentMcp;
using XurrentMcp.Agent;
using XurrentMcp.Mcp;

// ─────────────────────────────────────────────────────────────────────────────
// xurrent-mcp — C# / .NET implementasyonu
//
//   dotnet run -- stdio     MCP sunucusu, stdio transport (VARSAYILAN)
//   dotnet run -- http      MCP sunucusu, Streamable HTTP transport
//   dotnet run -- chat      Terminal chatbot   (ANTHROPIC_API_KEY gerekir)
//   dotnet run -- web       Web arayüzü        (ANTHROPIC_API_KEY gerekir)
//   dotnet run -- wizard    Sihirbaz / ders modu (API key GEREKMEZ)
// ─────────────────────────────────────────────────────────────────────────────

var mode = args.Length > 0 ? args[0].ToLowerInvariant() : "stdio";

AppConfig cfg;
try
{
    cfg = AppConfig.Load();
}
catch (InvalidOperationException ex)
{
    // Yapılandırma hatası (örn. geçersiz MCP_PROTOCOL) sessizce varsayılana düşmez.
    Console.Error.WriteLine(ex.Message);
    return 78;   // EX_CONFIG
}

// K1: 'both' tek bir stdio süreci için ANLAMSIZDIR — stdio tek kanaldır, tek protokol konuşur.
// İki revizyonu ayrı yollarda yayınlamak yalnızca HTTP transport'ta mümkündür.
if (cfg.McpProtocol == ProtocolChoice.Both && mode is "stdio" or "chat" or "wizard")
{
    Console.Error.WriteLine(
        "MCP_PROTOCOL=both stdio'da GEÇERSİZDİR: stdio tek bir kanaldır ve tek süreç tek protokol konuşur.\n" +
        "  • İki revizyonu ayrı yollarda yayınlamak için:  dotnet run -- http\n" +
        "  • stdio'da tek revizyon seçin:  MCP_PROTOCOL=2026-07-28  ya da  MCP_PROTOCOL=2025-11-25");
    return 78;
}

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

return mode switch
{
    "stdio" => await RunStdioAsync(),
    "http" => await WebHost.RunMcpHttpAsync(cfg, cts.Token),
    "chat" => await RunChatAsync(),
    "web" => await WebHost.RunWebAsync(cfg, cts.Token),
    "wizard" => await Wizard.RunAsync(cfg, args.Contains("--pause"), cts.Token),
    _ => Usage(mode),
};

async Task<int> RunStdioAsync()
{
    // ⚠️ stdio modunda stdout SADECE JSON-RPC içindir.
    // Tek bir Console.WriteLine protokolü bozar; bu yüzden TÜM loglar stderr'e gider.
    var builder = Host.CreateApplicationBuilder();
    ServerSetup.ConfigureStdErrLogging(builder.Logging);

    builder.Services.AddXurrentServices(cfg);
    builder.Services.AddXurrentMcpServer(cfg).WithStdioServerTransport();

    await builder.Build().RunAsync(cts.Token);
    return 0;
}

async Task<int> RunChatAsync()
{
    AgentCore agent;
    try
    {
        agent = await AgentCore.CreateAsync(cfg, cts.Token);
    }
    catch (InvalidOperationException ex)
    {
        Console.Error.WriteLine(ex.Message);
        return 2;
    }

    await using (agent)
    {
        var sink = new ConsoleSink(cfg);

        Console.WriteLine("xurrent-mcp — terminal chatbot (C#)");
        Console.WriteLine($"Xurrent modu: {cfg.XurrentMode} · Takvim: {cfg.CalendarProvider} · " +
                          $"Strateji: {cfg.BackdateStrategy} · Model: {cfg.AnthropicModel}");
        Console.WriteLine($"Tool'lar ({agent.ToolNames.Count}): {string.Join(", ", agent.ToolNames)}");
        Console.WriteLine("Çıkmak için boş satır veya Ctrl+C.\n");

        while (!cts.IsCancellationRequested)
        {
            Console.Write("> ");
            var line = Console.ReadLine();
            if (string.IsNullOrWhiteSpace(line)) break;

            try
            {
                await agent.SendAsync(line, sink, cts.Token);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Hata: {ex.Message}");
            }
        }
    }

    return 0;
}

int Usage(string unknown)
{
    Console.Error.WriteLine($"Bilinmeyen mod: '{unknown}'");
    Console.Error.WriteLine("Kullanım: dotnet run -- [stdio|http|chat|web|wizard]");
    return 64;
}
