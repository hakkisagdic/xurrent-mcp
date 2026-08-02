using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using XurrentMcp.Core;
using XurrentMcp.Llm;
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
/// SAĞLAYICI KARARI: tek sağlayıcı, GEMINI. Paket bağımlılığı yok; düz HttpClient
/// (bkz. Llm/GeminiClient.cs). MCP ile Gemini arasındaki entegrasyon noktası TEK ve
/// ÖNEMSİZ DEĞİL: tool şemaları. MCP inputSchema tam JSON Schema 2020-12'dir, Gemini
/// functionDeclarations ise OpenAPI'nin dar bir alt kümesini alır. Şema OLDUĞU GİBİ
/// GEÇİRİLEMEZ; Llm/SchemaTranslator.cs çevirir ve neyi attığını stderr'e raporlar.
///
/// DURUM YÖNETİMİ: sohbet geçmişi BACKEND'DE TUTULMAZ. clients/web/API.md sözleşmesi gereği
/// istemci her istekte tüm 'messages' dizisini geri gönderir ve dizinin İÇERİĞİNİ YORUMLAMAZ.
/// Bu yüzden wire biçimi olarak Gemini'nin KENDİ contents biçimini saklıyoruz
/// ({role, parts[]}): ara bir biçime çevirmek functionCall.id'yi kaybettirir ve
/// id eşleşmesi bozulunca API tool sonucunu çağrısına bağlayamaz.
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

    /// <summary>Bir kullanıcı mesajının tetikleyebileceği azami tool turu (sonsuz döngü kalkanı).</summary>
    private const int MaxRounds = 12;

    private readonly AppConfig _cfg;
    private readonly InProcessMcpSession _session;
    private readonly GeminiClient? _client;

    /// <summary>Gemini'ye gönderilen tool tanımları — çevrilmiş şemalarla.</summary>
    private readonly JsonArray _declarations = [];
    private readonly List<string> _toolNames = [];
    private readonly List<SchemaNote> _schemaNotes = [];

    /// <summary>functionCall.id gelmediğinde arayüz kartlarını eşleştirmek için üretilen sayaç.</summary>
    private int _callSeq;

    /// <summary>Terminal chatbot için tutulan yerel geçmiş (web tarafı durumsuzdur).</summary>
    private readonly JsonArray _terminalHistory = [];

    private AgentCore(AppConfig cfg, InProcessMcpSession session, GeminiClient? client)
    {
        _cfg = cfg;
        _session = session;
        _client = client;
    }

    public bool HasLlm => _client is not null;
    public IReadOnlyList<string> ToolNames => _toolNames;

    /// <summary>Şema çevirisinin tuttuğu kayıtlar — derste "ne kaybettik" sorusunun cevabı.</summary>
    public IReadOnlyList<SchemaNote> SchemaNotes => _schemaNotes;

    /// <summary>LLM'siz kurulum: tool listesi bilinir ama sohbet yapılamaz (/api/config için).</summary>
    public static Task<AgentCore> CreateAsync(AppConfig cfg, CancellationToken ct = default)
        => CreateAsync(cfg, requireLlm: true, ct);

    public static async Task<AgentCore> CreateAsync(AppConfig cfg, bool requireLlm, CancellationToken ct = default)
    {
        var hasKey = !string.IsNullOrWhiteSpace(cfg.GeminiApiKey);
        if (requireLlm && !hasKey)
            throw new InvalidOperationException(
                "GEMINI_API_KEY tanımlı değil. Chatbot bunu gerektirir. " +
                "Sadece MCP sunucusu olarak kullanacaksanız 'stdio' modunu çalıştırın — orada LLM'i host sağlar.");

        var session = await InProcessMcpSession.StartAsync(cfg, ct);
        var client = hasKey ? new GeminiClient(cfg.GeminiApiKey, cfg.GeminiModel, cfg.GeminiBaseUrl) : null;
        var agent = new AgentCore(cfg, session, client);

        // ★ MCP tools/list → Gemini functionDeclarations. ŞEMA BURADA ÇEVRİLİR.
        // Anthropic'te ham JSON Schema doğrudan kabul ediliyordu; Gemini'de EDİLMEZ.
        // Aynı sözleşme, iki farklı tool-calling lehçesi — çevirinin bedeli aşağıda raporlanır.
        foreach (var t in await session.Client.ListToolsAsync(cancellationToken: ct))
        {
            var schema = JsonNode.Parse(t.JsonSchema.GetRawText());
            var (declaration, translation) = SchemaTranslator.Declare(t.Name, t.Description, schema);

            agent._declarations.Add(declaration);
            agent._toolNames.Add(t.Name);
            agent._schemaNotes.AddRange(translation.Notes);
        }

        // Özet stderr'e basılır. stdout'a BASILAMAZ: stdio modunda orası yalnızca JSON-RPC'nindir
        // ve chat/web modları da aynı süreç kurulumunu paylaşır.
        foreach (var line in SchemaTranslator.Summarize(agent._schemaNotes, agent._toolNames.Count))
            Console.Error.WriteLine(line);

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
            await sink.ErrorAsync("GEMINI_API_KEY tanımlı değil; chatbot devre dışı.", "no_api_key", ct);
            return;
        }

        // Sunucu bu tur içinde onay isterse (live mod / XURRENT_CONFIRM_POLICY=strict),
        // soru bu turun arayüzüne yönlendirilir. Host'un işi budur: kullanıcıya SORMAK.
        _session.OnConfirm = async (parameters, cancel) =>
            await sink.ConfirmAsync("mcp_elicit", parameters.Message ?? "Onay gerekiyor.", [], cancel);

        var contents = ToContents(messages);

        try
        {
            for (var round = 0; round < MaxRounds; round++)
            {
                var turn = await _client.GenerateContentAsync(contents, _declarations, SystemPrompt, ct);

                if (!string.IsNullOrEmpty(turn.Text)) await sink.TextAsync(turn.Text, ct);

                // Modelin turu HAM parts[] ile eklenir. Yeniden inşa etmek functionCall.id'yi
                // kaybettirir ve bir sonraki istekte eşleştirme kopar.
                contents.Add(new JsonObject { ["role"] = "model", ["parts"] = turn.Parts.DeepClone() });

                if (turn.Calls.Count == 0)
                {
                    Sync(messages, contents);
                    await sink.DoneAsync(turn.FinishReason ?? "STOP", messages, ct);
                    return;
                }

                var responses = new JsonArray();
                foreach (var call in turn.Calls)
                {
                    // Arayüz kartı tool_use ve tool_result'ı AYNI id ile eşleştirir (API.md §4).
                    // Model id vermediyse (tek çağrıda olabiliyor) yerel bir id üretiyoruz —
                    // ama bu id functionResponse'a KONMAZ, aşağıya bak.
                    var eventId = call.Id is { Length: > 0 } ? call.Id : $"fc_{Interlocked.Increment(ref _callSeq)}";

                    await sink.ToolUseAsync(eventId, call.Name, call.Args.DeepClone(), ct);
                    var (payload, isError, parsed, ms) = await InvokeToolAsync(call, eventId, sink, ct);

                    await sink.ToolResultAsync(eventId, call.Name, isError, ms,
                        Summaries.Describe(call.Name, parsed), parsed?.DeepClone(), ct);

                    // ★ ID EŞLEŞMESİ: functionResponse.id, functionCall.id ile AYNI olmak ZORUNDA;
                    // aksi hâlde API sonucu çağrısına bağlayamaz. Çağrıda id YOKSA burada da
                    // GÖNDERİLMEZ — uydurulmuş bir id, eşleşmeme demektir (eşleşme isim+sıra ile yapılır).
                    var functionResponse = new JsonObject { ["name"] = call.Name, ["response"] = payload };
                    if (call.Id is { Length: > 0 }) functionResponse["id"] = call.Id;

                    responses.Add(new JsonObject { ["functionResponse"] = functionResponse });
                }

                // ★ Tool sonuçları "user" rolüyle döner. Gemini'de "tool" veya "function" rolü YOKTUR.
                contents.Add(new JsonObject { ["role"] = "user", ["parts"] = responses });
            }

            await sink.TextAsync($"Tool turu sınırına ulaşıldı ({MaxRounds}). İsteği daha küçük adımlara bölün.", ct);
            Sync(messages, contents);
            await sink.DoneAsync("max_rounds", messages, ct);
        }
        catch (OperationCanceledException)
        {
            // İstemci bağlantıyı kapattı; sessizce çık (bekleyen onay fail-closed sayılır).
        }
        catch (GeminiException ex)
        {
            await sink.ErrorAsync(ex.Message, "gemini_error", ct);
        }
        catch (Exception ex)
        {
            await sink.ErrorAsync(ex.Message, "agent_error", ct);
        }
    }

    private async Task<(JsonObject Response, bool IsError, JsonNode? Parsed, long Ms)> InvokeToolAsync(
        GeminiFunctionCall call, string eventId, IAgentSink sink, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();

        // ── PROTOKOL SEVİYESİNDE ONAY ────────────────────────────────────────
        // Onay diyaloğunu LLM'e BIRAKMIYORUZ: LLM ikna edilebilir, protokol edilemez.
        // Elicitation desteklemeyen bir istemcide politika fail-closed'dur.
        if (IsRealWrite(call, out var confirmDetails))
        {
            var accepted = await sink.ConfirmAsync(eventId, ConfirmMessage(call), confirmDetails, ct);
            if (!accepted)
            {
                sw.Stop();
                const string msg = "Kullanıcı onayı VERİLMEDİ — hiçbir kayıt oluşturulmadı.";
                return (Error(msg), true, new JsonObject { ["cancelled"] = true, ["message"] = msg },
                    sw.ElapsedMilliseconds);
            }
        }

        try
        {
            var result = await _session.Client.CallToolAsync(call.Name, ToArguments(call.Args), cancellationToken: ct);

            // Modele GİDEN metin okunabilir Türkçe bloktur; makine tarafı structuredContent'tir.
            // İkisi aynı gerçeğin iki sunumudur — LLM metni, arayüz yapıyı kullanır.
            var raw = string.Concat(result.Content
                .OfType<ModelContextProtocol.Protocol.TextContentBlock>()
                .Select(c => c.Text));
            sw.Stop();

            JsonNode? parsed = result.StructuredContent is { } sc
                ? JsonNode.Parse(sc.GetRawText())
                : null;

            // Eski sunucularla (structuredContent yayınlamayan) uyum: metin JSON ise onu kullan.
            if (parsed is null)
                try { parsed = JsonNode.Parse(raw); } catch (JsonException) { /* düz metin */ }

            var isError = result.IsError ?? false;
            return (isError ? Error(raw) : Success(raw, parsed), isError, parsed, sw.ElapsedMilliseconds);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Tool hatası konuşmayı ÖLDÜRMEZ; modele hata olarak geri verilir ki
            // kullanıcıya anlamlı bir açıklama yapabilsin.
            sw.Stop();
            var msg = $"Tool hatası: {ex.Message}";
            return (Error(msg), true, new JsonObject { ["error"] = msg }, sw.ElapsedMilliseconds);
        }
    }

    // ★ functionResponse.response bir OBJE olmak ZORUNDA — düz string kabul edilmez.
    private static JsonObject Success(string text, JsonNode? structured)
    {
        var payload = new JsonObject { ["output"] = text };
        if (structured is not null) payload["structured"] = structured.DeepClone();
        return payload;
    }

    private static JsonObject Error(string message) => new() { ["error"] = message };

    /// <summary>dryRun=false ile çağrılan yazma tool'ları — yalnızca bunlar onay ister.</summary>
    private static bool IsRealWrite(GeminiFunctionCall call, out JsonObject details)
    {
        details = [];
        if (call.Name is not (Core.ToolNames.CreateTimeEntry or Core.ToolNames.CreateTimeEntriesBulk))
            return false;

        if (AsBool(call.Args["dryRun"]) == true) return false;

        if (call.Name == Core.ToolNames.CreateTimeEntry)
        {
            details["Hedef"] = $"{AsText(call.Args["targetType"])} · {AsText(call.Args["targetId"])}";
            details["Süre"] = $"{AsInt(call.Args["minutes"]) ?? 0} dakika";
            details["Tarih"] = AsText(call.Args["date"]) ?? "bugün";
            details["Strateji"] = AsText(call.Args["backdateStrategy"]) ?? "(env varsayılanı)";
        }
        else
        {
            details["Satır sayısı"] = ((call.Args["entries"] as JsonArray)?.Count ?? 0).ToString();
            details["Uyarı"] = "Toplu yazma ATOMİK DEĞİLDİR — kısmi başarı mümkündür.";
        }

        return true;
    }

    private static string ConfirmMessage(GeminiFunctionCall call)
        => call.Name == Core.ToolNames.CreateTimeEntriesBulk
            ? $"{(call.Args["entries"] as JsonArray)?.Count ?? 0} zaman girişi Xurrent'a YAZILACAK. Onaylıyor musun?"
            : $"{AsInt(call.Args["minutes"]) ?? 0} dakikalık zaman girişi Xurrent'a YAZILACAK. Onaylıyor musun?";

    // ── Wire <-> Gemini contents dönüşümü ────────────────────────────────────

    /// <summary>
    /// İstemciden gelen 'messages' dizisini Gemini contents'ine çevirir.
    /// Üç girdi biçimini de kabul eder, çünkü arayüz yeni kullanıcı mesajını
    /// { role, content: "metin" } olarak ekler (clients/web/API.md §2) ama geçmişi
    /// bizim döndürdüğümüz biçimde saklar.
    /// </summary>
    private static JsonArray ToContents(JsonArray wire)
    {
        var contents = new JsonArray();

        foreach (var node in wire)
        {
            if (node is not JsonObject m) continue;

            // ★ ROL EŞLEMESİ: assistant → "model". Gemini'de "system" ve "tool" rolü YOKTUR;
            // sistem promptu systemInstruction alanına, tool sonucu "user" rolüne gider.
            var role = AsText(m["role"]) is "assistant" or "model" ? "model" : "user";

            if (m["parts"] is JsonArray parts)
            {
                contents.Add(new JsonObject { ["role"] = role, ["parts"] = parts.DeepClone() });
                continue;
            }

            if (AsText(m["content"]) is { } text)
            {
                contents.Add(new JsonObject
                {
                    ["role"] = role,
                    ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
                });
                continue;
            }

            // Blok dizisi taşıyan eski bir sekme: metin bloklarını kurtar, gerisini bırak.
            if (m["content"] is JsonArray blocks)
            {
                var salvaged = new JsonArray();
                foreach (var b in blocks)
                    if (AsText(b?["text"]) is { } bt)
                        salvaged.Add(new JsonObject { ["text"] = bt });

                if (salvaged.Count > 0)
                    contents.Add(new JsonObject { ["role"] = role, ["parts"] = salvaged });
            }
        }

        return contents;
    }

    /// <summary>Güncel contents'i istemciye dönecek 'messages' dizisine yazar (yerinde).</summary>
    private static void Sync(JsonArray messages, JsonArray contents)
    {
        messages.Clear();
        foreach (var c in contents) messages.Add(c?.DeepClone());
    }

    /// <summary>
    /// Gemini args'ını MCP tools/call argümanlarına çevirir.
    /// Sayı normalizasyonu ŞART: Gemini args'ı protobuf Struct üzerinden taşır ve
    /// tam sayılar 120.0 gibi kesirli görünebilir; int bekleyen bir parametreye bağlanamaz.
    /// </summary>
    private static Dictionary<string, object?> ToArguments(JsonObject args)
    {
        var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var (key, value) in args)
        {
            var json = NormalizeNumbers(value)?.ToJsonString(Json.Options) ?? "null";
            dict[key] = JsonSerializer.Deserialize<JsonElement>(json);
        }
        return dict;
    }

    private static JsonNode? NormalizeNumbers(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject o:
                var mapped = new JsonObject();
                foreach (var (k, v) in o) mapped[k] = NormalizeNumbers(v);
                return mapped;

            case JsonArray a:
                return new JsonArray([.. a.Select(NormalizeNumbers)]);

            case JsonValue v when v.TryGetValue<double>(out var d)
                                  && double.IsInteger(d) && Math.Abs(d) <= 9007199254740992d:
                return JsonValue.Create((long)d);

            default:
                return node?.DeepClone();
        }
    }

    private static string? AsText(JsonNode? node)
        => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static bool? AsBool(JsonNode? node)
        => node is JsonValue v && v.TryGetValue<bool>(out var b) ? b : null;

    private static int? AsInt(JsonNode? node)
        => node is JsonValue v && v.TryGetValue<double>(out var d) ? (int)d : null;

    // ── Terminal yardımcısı ──────────────────────────────────────────────────

    public async Task<string> SendAsync(string userText, IAgentSink sink, CancellationToken ct = default)
    {
        _terminalHistory.Add(new JsonObject
        {
            ["role"] = "user",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = userText }),
        });

        await RunTurnAsync(_terminalHistory, sink, ct);

        // Son model mesajının metin parçaları.
        var last = _terminalHistory.LastOrDefault(m => AsText(m?["role"]) == "model") as JsonObject;

        return string.Concat((last?["parts"] as JsonArray ?? [])
            .Select(p => AsText(p?["text"]))
            .OfType<string>());
    }

    public void Reset() => _terminalHistory.Clear();

    public ValueTask DisposeAsync()
    {
        _client?.Dispose();
        return _session.DisposeAsync();
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
