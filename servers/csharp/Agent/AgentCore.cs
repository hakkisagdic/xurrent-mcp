using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Anthropic.SDK;
using Anthropic.SDK.Common;
using Anthropic.SDK.Messaging;
using ModelContextProtocol.Protocol;
using XurrentMcp.Core;
using XurrentMcp.Mcp;

namespace XurrentMcp.Agent;

/// <summary>Bir tur boyunca üretilen olayların alıcısı (terminal veya SSE).</summary>
public interface IAgentSink
{
    Task TextAsync(string text, CancellationToken ct);
    Task ToolUseAsync(string id, string name, JsonNode? args, CancellationToken ct);
    Task ToolResultAsync(string id, string name, bool isError, long durationMs,
        string? summary, JsonNode? result, CancellationToken ct);

    /// <summary>Yazma öncesi onay. false dönerse tool ÇALIŞTIRILMAZ.</summary>
    Task<bool> ConfirmAsync(string id, string message, JsonObject details, CancellationToken ct);

    Task DoneAsync(string stopReason, JsonArray messages, CancellationToken ct);
    Task ErrorAsync(string message, string? code, CancellationToken ct);
}

/// <summary>
/// Terminal ve web chatbot'unun ortak beyni.
///
/// MİMARİ NOT: chatbot, tool'ları doğrudan C# metodu olarak ÇAĞIRMAZ.
/// Kendi MCP sunucusuna süreç içi bir MCP CLIENT olarak bağlanır ve tools/list +
/// tools/call üzerinden konuşur — yani Claude Code'un yaptığı işin AYNISINI yapar.
/// Ders bunu vurgular: "MCP host" özel bir şey değildir; sen de yazabilirsin.
///
/// SDK KARARI: Anthropic.SDK 5.10.0 kullanılıyor. MCP tool şemaları JSON Schema olarak gelir
/// ve Anthropic.SDK'nın Function(name, description, JsonNode) kurucusu ham şemayı DOĞRUDAN
/// kabul eder — C# metot yansımasına ihtiyaç duymaz. MCP ile SDK arasında gereken tek
/// entegrasyon noktası budur; bu yüzden düz HttpClient'a düşmeye gerek kalmadı.
///
/// DURUM YÖNETİMİ: sohbet geçmişi BACKEND'DE TUTULMAZ. clients/web/API.md sözleşmesi gereği
/// istemci her istekte tüm 'messages' dizisini geri gönderir. Wire biçimi Anthropic'in
/// content-block biçimidir; arayüz onu yorumlamaz, sadece saklayıp geri yollar.
/// </summary>
public sealed class AgentCore : IAsyncDisposable
{
    public const string SystemPrompt = """
        Sen Xurrent (ITSM) üzerinde zaman girişi yapan bir asistansın. Türkçe konuşursun.

        DEĞİŞMEZ KURALLAR:
        1. Tüm id değerleri opak string'lerdir. ASLA id üretme, tahmin etme veya ezberden yazma.
           Kullandığın her id, daha önce çağırdığın bir tool'un çıktısından gelmek ZORUNDADIR.
        2. Süreler DAKİKA cinsindendir. Kullanıcı "2 saat" derse 120'ye çevir ve çevirdiğini SÖYLE.
        3. Zaman yazmadan ÖNCE xurrent_get_time_tracking_context çağır. timeIncrement bilinmeden
           süre seçilemez; 45 dakika, timeIncrement 30 olan bir hesapta REDDEDİLİR.
        4. Her yazma işleminden önce dryRun=true ile planı çıkar ve kullanıcıya özetle.
           Gerçek yazmadan önce sistem ayrıca protokol seviyesinde onay isteyecektir.
        5. Toplu yazma ATOMİK DEĞİLDİR. Kısmi başarı ihtimalini kullanıcıya açıkça söyle.
        6. Takvimden öneri üretirken plan_time_entries_from_calendar kullan. Bu tool yazamaz.
           needsUserDecision=true olan her öneri için kullanıcıya SOR — tahmin etme.
        7. Yuvarlama yaptıysan SÖYLE. Hangi effort class'ı seçtiğini SÖYLE (faturalamayı etkiler).
        8. backdateStrategy seçiminin neyi feda ettiğini kullanıcıya açıkla:
           two_step atomik değil, link_first tarihi bugüne çeker, date_first ticket'a bağlamaz.
        """;

    private readonly AppConfig _cfg;
    private readonly InProcessMcpSession _session;
    private readonly AnthropicClient? _client;
    private readonly List<Anthropic.SDK.Common.Tool> _tools = [];

    /// <summary>Terminal chatbot için tutulan yerel geçmiş (web tarafı durumsuzdur).</summary>
    private readonly JsonArray _terminalHistory = [];

    private AgentCore(AppConfig cfg, InProcessMcpSession session, AnthropicClient? client)
    {
        _cfg = cfg;
        _session = session;
        _client = client;
    }

    public bool HasLlm => _client is not null;
    public IReadOnlyList<string> ToolNames => _tools.Select(t => t.Function.Name).ToList();

    /// <summary>LLM'siz kurulum: tool listesi bilinir ama sohbet yapılamaz (/api/config için).</summary>
    public static Task<AgentCore> CreateAsync(AppConfig cfg, CancellationToken ct = default)
        => CreateAsync(cfg, requireLlm: true, ct);

    public static async Task<AgentCore> CreateAsync(AppConfig cfg, bool requireLlm, CancellationToken ct = default)
    {
        var hasKey = !string.IsNullOrWhiteSpace(cfg.AnthropicApiKey);
        if (requireLlm && !hasKey)
            throw new InvalidOperationException(
                "ANTHROPIC_API_KEY tanımlı değil. Chatbot bunu gerektirir. " +
                "Sadece MCP sunucusu olarak kullanacaksanız 'stdio' modunu çalıştırın — orada LLM'i host sağlar.");

        var session = await InProcessMcpSession.StartAsync(cfg, ct);
        var client = hasKey ? new AnthropicClient(new APIAuthentication(cfg.AnthropicApiKey)) : null;
        var agent = new AgentCore(cfg, session, client);

        // MCP tools/list -> Anthropic tool tanımları. Şema DÖNÜŞTÜRÜLMEZ, olduğu gibi geçer.
        foreach (var t in await session.Client.ListToolsAsync(cancellationToken: ct))
            agent._tools.Add(new Function(t.Name, t.Description ?? t.Name, JsonNode.Parse(t.JsonSchema.GetRawText())));

        return agent;
    }

    // ── Tur yürütücü (durumsuz) ──────────────────────────────────────────────

    /// <summary>
    /// Verilen sohbet geçmişiyle bir tur çevirir. Geçmiş YERİNDE güncellenir ve
    /// 'done' olayında istemciye geri verilir.
    /// </summary>
    public async Task RunTurnAsync(JsonArray messages, IAgentSink sink, CancellationToken ct)
    {
        if (_client is null)
        {
            await sink.ErrorAsync("ANTHROPIC_API_KEY tanımlı değil; chatbot devre dışı.", "no_api_key", ct);
            return;
        }

        // Sunucu bu tur içinde onay isterse (live mod / XURRENT_CONFIRM_POLICY=strict),
        // soru bu turun arayüzüne yönlendirilir. Host'un işi budur: kullanıcıya SORMAK.
        _session.OnConfirm = async (parameters, cancel) =>
            await sink.ConfirmAsync("mcp_elicit", parameters.Message ?? "Onay gerekiyor.", [], cancel);

        try
        {
            // Sonsuz döngüye karşı sert sınır: bir kullanıcı mesajı en fazla 12 tool turu tetikleyebilir.
            for (var round = 0; round < 12; round++)
            {
                var parameters = new MessageParameters
                {
                    Model = _cfg.AnthropicModel,
                    MaxTokens = 4096,
                    Messages = ToAnthropic(messages),
                    System = [new SystemMessage(SystemPrompt)],
                    Tools = _tools,
                };

                var response = await _client.Messages.GetClaudeMessageAsync(parameters, ct);

                var text = string.Concat(response.Content.OfType<TextContent>().Select(c => c.Text));
                if (!string.IsNullOrEmpty(text)) await sink.TextAsync(text, ct);

                messages.Add(ToWire(response));

                var toolUses = response.Content.OfType<ToolUseContent>().ToList();
                if (toolUses.Count == 0)
                {
                    await sink.DoneAsync(response.StopReason ?? "end_turn", messages, ct);
                    return;
                }

                var results = new JsonArray();
                foreach (var use in toolUses)
                {
                    await sink.ToolUseAsync(use.Id, use.Name, use.Input?.DeepClone(), ct);
                    var (raw, isError, parsed, ms) = await InvokeToolAsync(use, sink, ct);

                    await sink.ToolResultAsync(use.Id, use.Name, isError, ms,
                        Summaries.Describe(use.Name, parsed), parsed?.DeepClone(), ct);

                    results.Add(new JsonObject
                    {
                        ["type"] = "tool_result",
                        ["tool_use_id"] = use.Id,
                        ["content"] = raw,
                        ["is_error"] = isError,
                    });
                }

                messages.Add(new JsonObject { ["role"] = "user", ["content"] = results });
            }

            await sink.TextAsync("Tool turu sınırına ulaşıldı (12). İsteği daha küçük adımlara bölün.", ct);
            await sink.DoneAsync("max_rounds", messages, ct);
        }
        catch (OperationCanceledException)
        {
            // İstemci bağlantıyı kapattı; sessizce çık (bekleyen onay fail-closed sayılır).
        }
        catch (Exception ex)
        {
            await sink.ErrorAsync(ex.Message, "agent_error", ct);
        }
    }

    private async Task<(string Raw, bool IsError, JsonNode? Parsed, long Ms)> InvokeToolAsync(
        ToolUseContent use, IAgentSink sink, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();

        // ── PROTOKOL SEVİYESİNDE ONAY ────────────────────────────────────────
        // Onay diyaloğunu LLM'e BIRAKMIYORUZ: LLM ikna edilebilir, protokol edilemez.
        // Elicitation desteklemeyen bir istemcide politika fail-closed'dur.
        if (IsRealWrite(use, out var confirmDetails))
        {
            var accepted = await sink.ConfirmAsync(use.Id, ConfirmMessage(use), confirmDetails, ct);
            if (!accepted)
            {
                sw.Stop();
                const string msg = "Kullanıcı onayı VERİLMEDİ — hiçbir kayıt oluşturulmadı.";
                return (msg, true, new JsonObject { ["cancelled"] = true, ["message"] = msg }, sw.ElapsedMilliseconds);
            }
        }

        try
        {
            var args = (use.Input as JsonObject ?? [])
                .ToDictionary(kv => kv.Key, kv => (object?)JsonSerializer.Deserialize<JsonElement>(kv.Value ?? "null"));

            var result = await _session.Client.CallToolAsync(use.Name, args, cancellationToken: ct);

            // Modele GİDEN metin okunabilir Türkçe bloktur; makine tarafı structuredContent'tir.
            // İkisi aynı gerçeğin iki sunumudur — LLM metni, arayüz yapıyı kullanır.
            var raw = string.Concat(result.Content.OfType<TextContentBlock>().Select(c => c.Text));
            sw.Stop();

            JsonNode? parsed = result.StructuredContent is { } sc
                ? JsonNode.Parse(sc.GetRawText())
                : null;

            // Eski sunucularla (structuredContent yayınlamayan) uyum: metin JSON ise onu kullan.
            if (parsed is null)
                try { parsed = JsonNode.Parse(raw); } catch (JsonException) { /* düz metin */ }

            return (raw, result.IsError ?? false, parsed, sw.ElapsedMilliseconds);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Tool hatası konuşmayı ÖLDÜRMEZ; modele hata olarak geri verilir ki
            // kullanıcıya anlamlı bir açıklama yapabilsin.
            sw.Stop();
            var msg = $"Tool hatası: {ex.Message}";
            return (msg, true, new JsonObject { ["error"] = msg }, sw.ElapsedMilliseconds);
        }
    }

    /// <summary>dryRun=false ile çağrılan yazma tool'ları — yalnızca bunlar onay ister.</summary>
    private static bool IsRealWrite(ToolUseContent use, out JsonObject details)
    {
        details = [];
        if (use.Name is not (Core.ToolNames.CreateTimeEntry or Core.ToolNames.CreateTimeEntriesBulk))
            return false;

        var input = use.Input as JsonObject ?? [];
        if (input["dryRun"]?.GetValue<bool>() == true) return false;

        if (use.Name == Core.ToolNames.CreateTimeEntry)
        {
            details["Hedef"] = $"{input["targetType"]?.GetValue<string>()} · {input["targetId"]?.GetValue<string>()}";
            details["Süre"] = $"{input["minutes"]?.GetValue<int>() ?? 0} dakika";
            details["Tarih"] = input["date"]?.GetValue<string>() ?? "bugün";
            details["Strateji"] = input["backdateStrategy"]?.GetValue<string>() ?? "(env varsayılanı)";
        }
        else
        {
            var count = (input["entries"] as JsonArray)?.Count ?? 0;
            details["Satır sayısı"] = count.ToString();
            details["Uyarı"] = "Toplu yazma ATOMİK DEĞİLDİR — kısmi başarı mümkündür.";
        }

        return true;
    }

    private static string ConfirmMessage(ToolUseContent use)
    {
        var input = use.Input as JsonObject ?? [];
        if (use.Name == Core.ToolNames.CreateTimeEntriesBulk)
            return $"{(input["entries"] as JsonArray)?.Count ?? 0} zaman girişi Xurrent'a YAZILACAK. Onaylıyor musun?";

        return $"{input["minutes"]?.GetValue<int>() ?? 0} dakikalık zaman girişi Xurrent'a YAZILACAK. Onaylıyor musun?";
    }

    // ── Wire <-> Anthropic dönüşümü ──────────────────────────────────────────

    private static List<Message> ToAnthropic(JsonArray wire)
    {
        var list = new List<Message>();
        foreach (var node in wire)
        {
            var m = node!.AsObject();
            var role = m["role"]?.GetValue<string>() == "assistant" ? RoleType.Assistant : RoleType.User;

            if (m["content"] is JsonValue v && v.GetValueKind() == JsonValueKind.String)
            {
                list.Add(new Message(role, v.GetValue<string>()));
                continue;
            }

            var content = new List<ContentBase>();
            foreach (var b in m["content"] as JsonArray ?? [])
            {
                var block = b!.AsObject();
                switch (block["type"]?.GetValue<string>())
                {
                    case "text":
                        content.Add(new TextContent { Text = block["text"]?.GetValue<string>() ?? "" });
                        break;
                    case "tool_use":
                        content.Add(new ToolUseContent
                        {
                            Id = block["id"]?.GetValue<string>() ?? "",
                            Name = block["name"]?.GetValue<string>() ?? "",
                            Input = block["input"]?.DeepClone(),
                        });
                        break;
                    case "tool_result":
                        content.Add(new ToolResultContent
                        {
                            ToolUseId = block["tool_use_id"]?.GetValue<string>() ?? "",
                            Content = [new TextContent { Text = block["content"]?.GetValue<string>() ?? "" }],
                            IsError = block["is_error"]?.GetValue<bool>() ?? false,
                        });
                        break;
                }
            }

            if (content.Count > 0) list.Add(new Message { Role = role, Content = content });
        }
        return list;
    }

    private static JsonObject ToWire(MessageResponse response)
    {
        var blocks = new JsonArray();
        foreach (var c in response.Content)
        {
            switch (c)
            {
                case TextContent t:
                    blocks.Add(new JsonObject { ["type"] = "text", ["text"] = t.Text });
                    break;
                case ToolUseContent u:
                    blocks.Add(new JsonObject
                    {
                        ["type"] = "tool_use",
                        ["id"] = u.Id,
                        ["name"] = u.Name,
                        ["input"] = u.Input?.DeepClone() ?? new JsonObject(),
                    });
                    break;
            }
        }
        return new JsonObject { ["role"] = "assistant", ["content"] = blocks };
    }

    // ── Terminal yardımcısı ──────────────────────────────────────────────────

    public async Task<string> SendAsync(string userText, IAgentSink sink, CancellationToken ct = default)
    {
        _terminalHistory.Add(new JsonObject { ["role"] = "user", ["content"] = userText });
        await RunTurnAsync(_terminalHistory, sink, ct);

        // Son asistan mesajının metin blokları.
        var last = _terminalHistory.LastOrDefault(m =>
            m?["role"]?.GetValue<string>() == "assistant") as JsonObject;

        return string.Concat((last?["content"] as JsonArray ?? [])
            .Select(b => b!.AsObject())
            .Where(b => b["type"]?.GetValue<string>() == "text")
            .Select(b => b["text"]?.GetValue<string>() ?? ""));
    }

    public void Reset() => _terminalHistory.Clear();

    public async ValueTask DisposeAsync()
    {
        _client?.Dispose();
        await _session.DisposeAsync();
    }
}

/// <summary>
/// Terminal chatbot'unun olay alıcısı.
/// stdout = kullanıcıya gösterilen konuşma, stderr = tool izleri.
/// Böylece `dotnet run -- chat | tee log.txt` yaparken izler karışmaz.
/// </summary>
public sealed class ConsoleSink(AppConfig cfg) : IAgentSink
{
    public Task TextAsync(string text, CancellationToken ct)
    {
        Console.WriteLine("\n" + text + "\n");
        return Task.CompletedTask;
    }

    public Task ToolUseAsync(string id, string name, JsonNode? args, CancellationToken ct)
    {
        Console.Error.WriteLine($"  → {name} {args?.ToJsonString(Json.Options)}");
        return Task.CompletedTask;
    }

    public Task ToolResultAsync(string id, string name, bool isError, long durationMs,
        string? summary, JsonNode? result, CancellationToken ct)
    {
        Console.Error.WriteLine($"  ← {(isError ? "HATA " : "")}{summary ?? name} ({durationMs} ms)");
        return Task.CompletedTask;
    }

    public Task<bool> ConfirmAsync(string id, string message, JsonObject details, CancellationToken ct)
    {
        // Terminal bir elicitation kanalı SAYILIR: kullanıcıya doğrudan soruyoruz.
        // Bu kanal olmasaydı XURRENT_CONFIRM_POLICY=closed gereği yazma REDDEDİLİRDİ.
        if (cfg.XurrentConfirmPolicy == "open") return Task.FromResult(true);

        Console.WriteLine($"\n⚠️  {message}");
        foreach (var (k, v) in details) Console.WriteLine($"    {k}: {v}");
        Console.Write("    Onaylıyor musun? [e/H] ");

        var answer = Console.ReadLine()?.Trim().ToLowerInvariant();
        return Task.FromResult(answer is "e" or "evet" or "y" or "yes");
    }

    public Task DoneAsync(string stopReason, JsonArray messages, CancellationToken ct) => Task.CompletedTask;

    public Task ErrorAsync(string message, string? code, CancellationToken ct)
    {
        Console.Error.WriteLine($"Hata ({code}): {message}");
        return Task.CompletedTask;
    }
}

/// <summary>
/// Tool çıktılarının TÜRKÇE tek satırlık özetleri.
/// NEDEN backend üretiyor: arayüz tool semantiğini BİLMEZ (clients/web/API.md §2).
/// Özet üretilemiyorsa null döner ve arayüz ham JSON gösterir.
/// </summary>
internal static class Summaries
{
    public static string? Describe(string toolName, JsonNode? result)
    {
        if (result is not JsonObject o) return null;
        try
        {
            return toolName switch
            {
                Core.ToolNames.WhoAmI =>
                    $"{o["person"]?["name"]} · {o["account"]?["name"]} ({o["mode"]})",

                Core.ToolNames.FindPerson =>
                    $"{o["totalCount"]} kişi bulundu" +
                    (o["suggestFuzzy"]?.GetValue<bool>() == true ? " — tam eşleşme yok, serbest arama önerilir" : ""),

                Core.ToolNames.ListOpenWork =>
                    $"{o["requests"]?["totalCount"]} açık talep, {o["tasks"]?["totalCount"]} açık görev",

                Core.ToolNames.TimeTrackingContext =>
                    $"timeIncrement {o["timeIncrement"]} dk · {(o["effortClasses"] as JsonArray)?.Count} effort class · " +
                    $"workday {o["workday"]} dk",

                Core.ToolNames.CreateTimeEntry => DescribeWrite(o),

                Core.ToolNames.CreateTimeEntriesBulk =>
                    $"{o["summary"]?["requested"]} istendi · {o["summary"]?["created"]} yazıldı · " +
                    $"{o["summary"]?["failed"]} hata · {o["summary"]?["skipped"]} atlandı",

                Core.ToolNames.CalendarListToday =>
                    $"{o["totals"]?["rawCount"]} ham etkinlik → {o["totals"]?["count"]} gerçek toplantı · " +
                    $"{o["totals"]?["busyMinutes"]} dk meşgul (naif {o["totals"]?["naiveSumMinutes"]} dk)",

                Core.ToolNames.PlanFromCalendar =>
                    $"{(o["proposals"] as JsonArray)?.Count} öneri · " +
                    $"{(o["unmatchedMeetings"] as JsonArray)?.Count} tanesi kullanıcı kararı bekliyor",

                _ => null,
            };
        }
        catch (Exception) { return null; }
    }

    private static string DescribeWrite(JsonObject o)
    {
        var errors = (o["errors"] as JsonArray)?.Count ?? 0;
        if (errors > 0) return $"{errors} doğrulama hatası — hiçbir şey yazılmadı";

        var strategy = o["strategy"]?.GetValue<string>();
        var steps = (o["planned"] as JsonArray)?.Count ?? 0;
        return o["dryRun"]?.GetValue<bool>() == true
            ? $"DRY-RUN · {strategy} · {steps} mutation planlandı (hiçbir şey yazılmadı)"
            : $"Kayıt oluşturuldu · {strategy} · {steps} mutation çalıştı";
    }
}
