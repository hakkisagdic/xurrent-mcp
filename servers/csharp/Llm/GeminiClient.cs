using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace XurrentMcp.Llm;

/// <summary>Modelin istediği tek bir tool çağrısı.</summary>
/// <param name="Id">
/// functionCall.id — functionResponse'ta AYNEN geri gönderilmek ZORUNDADIR.
/// Model tek çağrı yaptığında API bu alanı bazen hiç göndermez; o durumda null'dır
/// ve eşleştirme sıra + isim üzerinden yapılır (bkz. AgentCore.ToolResultPart).
/// </param>
public sealed record GeminiFunctionCall(string? Id, string Name, JsonObject Args);

/// <summary>Bir generateContent turunun ayrıştırılmış sonucu.</summary>
/// <param name="Parts">
/// Modelin ürettiği ham parts[] dizisi. Sohbet geçmişine OLDUĞU GİBİ eklenir;
/// yeniden üretmeye çalışmak functionCall.id'yi kaybettirir.
/// </param>
public sealed record GeminiTurn(
    string Text,
    IReadOnlyList<GeminiFunctionCall> Calls,
    string? FinishReason,
    JsonArray Parts,
    JsonNode? Usage);

/// <summary>Gemini API'sinden dönen iş hatası (HTTP veya gövde içi 'error').</summary>
public sealed class GeminiException(string message, int? status = null) : Exception(message)
{
    public int? Status { get; } = status;
}

/// <summary>
/// Gemini generateContent istemcisi — düz HttpClient + System.Text.Json.
///
/// SDK KARARI: resmî bir .NET Gemini paketi bağımlılığı EKLENMEDİ. İhtiyacımız tek uç
/// nokta ve dört alan; buna karşılık paket, wire biçimini derste GÖSTEREMEDİĞİMİZ bir
/// soyutlamanın arkasına saklardı. Ham HTTP burada öğretici olanıdır: gönderilen gövde
/// dokümandaki gövdenin aynısıdır.
///
/// UÇ NOKTA : POST {BASE}/v1beta/models/{model}:generateContent
/// KİMLİK   : ★ x-goog-api-key HEADER'ı. Anahtar URL query'sine KONMAZ —
///            query string ters vekil ve erişim loglarına düz metin olarak düşer.
/// </summary>
public sealed class GeminiClient : IDisposable
{
    public const string DefaultBaseUrl = "https://generativelanguage.googleapis.com";

    /// <summary>Varsayılan model. Gerekçesi <see cref="AppConfig.GeminiModel"/> üstünde yazılı.</summary>
    public const string DefaultModel = "gemini-3.6-flash";

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly string _apiKey;

    public string Model { get; }
    public Uri Endpoint { get; }

    public GeminiClient(string apiKey, string model, string? baseUrl = null, HttpClient? http = null)
    {
        if (string.IsNullOrWhiteSpace(apiKey))
            throw new ArgumentException("Gemini API anahtarı boş olamaz.", nameof(apiKey));

        _apiKey = apiKey;
        Model = string.IsNullOrWhiteSpace(model) ? DefaultModel : model;

        var root = (string.IsNullOrWhiteSpace(baseUrl) ? DefaultBaseUrl : baseUrl).TrimEnd('/');
        Endpoint = new Uri($"{root}/v1beta/models/{Model}:generateContent");

        // Sohbet turu tool döngüsü içerdiği için 30 sn kısa kalır; ayrı bir istemci kullanıyoruz.
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(120) };
        _ownsHttp = http is null;
    }

    /// <summary>
    /// Bir tur üretir.
    /// </summary>
    /// <param name="contents">
    /// Sohbet geçmişi. Roller YALNIZCA "user" ve "model" olabilir — Gemini'de "system" rolü YOKTUR.
    /// </param>
    /// <param name="functionDeclarations">Çevrilmiş tool tanımları (bkz. SchemaTranslator).</param>
    /// <param name="systemInstruction">
    /// ★ Sistem promptu contents'in İÇİNE KONMAZ; ayrı systemInstruction alanına konur.
    /// contents'e "system" rolüyle eklenirse API rolü reddeder.
    /// </param>
    public async Task<GeminiTurn> GenerateContentAsync(
        JsonArray contents,
        JsonArray? functionDeclarations,
        string? systemInstruction,
        CancellationToken ct = default)
    {
        var body = new JsonObject { ["contents"] = contents.DeepClone() };

        if (functionDeclarations is { Count: > 0 })
            body["tools"] = new JsonArray(new JsonObject
            {
                ["functionDeclarations"] = functionDeclarations.DeepClone(),
            });

        if (!string.IsNullOrWhiteSpace(systemInstruction))
            body["systemInstruction"] = new JsonObject
            {
                ["parts"] = new JsonArray(new JsonObject { ["text"] = systemInstruction }),
            };

        body["generationConfig"] = new JsonObject
        {
            // Zaman girişi yazan bir asistanda yaratıcılık istenmez: aynı girdi aynı planı üretmeli.
            ["temperature"] = 0,
            ["maxOutputTokens"] = 4096,
        };

        using var request = new HttpRequestMessage(HttpMethod.Post, Endpoint)
        {
            Content = new StringContent(body.ToJsonString(Json.Options), Encoding.UTF8, "application/json"),
        };
        // ★ Anahtar HEADER'da. Asla ?key=... olarak URL'e eklenmez.
        request.Headers.Add("x-goog-api-key", _apiKey);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct);
        var raw = await response.Content.ReadAsStringAsync(ct);

        JsonNode? parsed;
        try { parsed = JsonNode.Parse(raw); }
        catch (JsonException)
        {
            throw new GeminiException(
                $"Gemini yanıtı JSON değil (HTTP {(int)response.StatusCode}): {Truncate(raw, 400)}",
                (int)response.StatusCode);
        }

        // ★ HTTP 200 olsa BİLE gövdede error alanı gelebilir. İKİSİ DE kontrol edilir;
        // yalnızca status koduna bakmak sessizce boş cevaba yol açar.
        if (parsed?["error"] is JsonObject err)
        {
            var message = err["message"]?.GetValue<string>() ?? "bilinmeyen hata";
            var status = err["status"]?.GetValue<string>();
            throw new GeminiException($"Gemini hatası ({status ?? response.StatusCode.ToString()}): {message}",
                (int)response.StatusCode);
        }

        if (!response.IsSuccessStatusCode)
            throw new GeminiException(
                $"Gemini HTTP {(int)response.StatusCode}: {Truncate(raw, 400)}", (int)response.StatusCode);

        var candidate = (parsed?["candidates"] as JsonArray)?.FirstOrDefault()?.AsObject();
        if (candidate is null)
        {
            // Güvenlik filtresi devreye girdiyse candidates boş gelir, sebep promptFeedback'tedir.
            var blocked = parsed?["promptFeedback"]?["blockReason"]?.GetValue<string>();
            throw new GeminiException(blocked is null
                ? $"Gemini yanıtında candidates yok: {Truncate(raw, 400)}"
                : $"Gemini isteği engelledi (blockReason={blocked}).");
        }

        var parts = candidate["content"]?["parts"]?.AsArray() ?? [];
        var text = new StringBuilder();
        var calls = new List<GeminiFunctionCall>();

        foreach (var part in parts)
        {
            if (part is not JsonObject p) continue;

            if (p["text"] is JsonValue tv && tv.TryGetValue<string>(out var t))
                text.Append(t);

            if (p["functionCall"] is JsonObject fc)
                calls.Add(new GeminiFunctionCall(
                    fc["id"]?.GetValue<string>(),
                    fc["name"]?.GetValue<string>() ?? "",
                    fc["args"]?.DeepClone() as JsonObject ?? []));
        }

        return new GeminiTurn(
            text.ToString(),
            calls,
            candidate["finishReason"]?.GetValue<string>(),
            parts.DeepClone().AsArray(),
            parsed?["usageMetadata"]?.DeepClone());
    }

    private static string Truncate(string s, int max)
        => s.Length <= max ? s : s[..max] + "…";

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }
}
