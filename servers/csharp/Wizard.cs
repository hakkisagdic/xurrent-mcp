using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol.Protocol;
using XurrentMcp.Mcp;

namespace XurrentMcp;

/// <summary>
/// Sihirbaz = docs/wizard/steps.json dosyasını yürüten bir MCP CLIENT'tır.
/// Üç dilin sunucusu da AYNI adımları, AYNI çıktılarla üretmek zorundadır;
/// dersin "MCP bir protokoldür, dil bir detaydır" tezinin kanıtı budur.
///
/// Hiçbir çıktı önceden yazılmamıştır — hepsi canlı tool çağrılarından gelir.
/// </summary>
public static class Wizard
{
    private const string Reset = "[0m";
    private const string Bold = "[1m";
    private const string Dim = "[2m";
    private const string Cyan = "[36m";
    private const string Green = "[32m";
    private const string Red = "[31m";
    private const string Yellow = "[33m";

    /// <summary>Onay metninin ilk satırı — otomatik modda tek satırlık özet için.</summary>
    private static string FirstLine(string text)
    {
        var line = text.Split('\n')[0].Trim();
        return line.Length <= 96 ? line : line[..93] + "…";
    }

    // K3 — adım sonucu ÜÇ DURUMLUDUR: PASS | FAIL | SKIP.
    // Bir kontrol ön koşul sağlanmadığı için ÇALIŞTIRILAMIYORSA bu bir SKIP'tir, FAIL DEĞİL.
    // Aradaki farkı silmek, "eksik altyapı"yı "bozuk sunucu" gibi göstermektir.
    private static int _passed;
    private static int _failed;
    private static int _skipped;

    public static async Task<int> RunAsync(AppConfig cfg, bool pause, CancellationToken ct)
    {
        var stepsPath = Path.Combine(cfg.RepoRoot, "docs", "wizard", "steps.json");
        if (!File.Exists(stepsPath))
        {
            Console.Error.WriteLine($"Ders akışı bulunamadı: {stepsPath}");
            return 2;
        }

        var doc = JsonNode.Parse(await File.ReadAllTextAsync(stepsPath, ct))!.AsObject();
        var chapters = (doc["chapters"] as JsonArray ?? [])
            .ToDictionary(c => c!["id"]!.GetValue<string>(), c => c!["title"]!.GetValue<string>());

        await using var session = await InProcessMcpSession.StartAsync(cfg, ct);

        // ★ ONAY KANALI. Bağlanmazsa sunucunun her onay isteği "decline" olarak yanıtlanır
        // ve yazma adımı errors.length=1 ile başarısız olur.
        //
        // Sunucu mock modda da onay sorar (bkz. ToolImpl.RequiresConfirmation) — mock,
        // üretimin SİMÜLASYONUDUR, onay akışı da simülasyonun parçasıdır. TypeScript ve
        // Python sihirbazları da bu kanalı bağlar; üçünün aynı davranması şart.
        session.OnConfirm = async (parameters, cancel) =>
        {
            var message = parameters.Message ?? "Onaylıyor musunuz?";

            if (!pause)
            {
                // Otomatik mod (CI / --auto): onay verilir ama SESSİZCE değil —
                // ekranda ne onaylandığı görünür, aksi halde ders yalan söyler.
                Console.WriteLine($"{Yellow}  [onay · otomatik kabul]{Reset} {Dim}{FirstLine(message)}{Reset}");
                return true;
            }

            Console.WriteLine($"\n{Yellow}{Bold}  [onay gerekiyor]{Reset}");
            foreach (var line in message.Split('\n'))
                Console.WriteLine($"    {line}");
            Console.Write($"  {Bold}Yazılsın mı? (e/H) {Reset}");

            var answer = (Console.ReadLine() ?? string.Empty).Trim().ToLowerInvariant();
            var ok = answer is "e" or "evet" or "y" or "yes";
            Console.WriteLine(ok
                ? $"  {Green}→ onaylandı{Reset}\n"
                : $"  {Red}→ reddedildi, hiçbir kayıt yazılmayacak{Reset}\n");
            return await ValueTask.FromResult(ok);
        };

        Header(doc["title"]?.GetValue<string>() ?? "xurrent-mcp", doc["subtitle"]?.GetValue<string>());
        Console.WriteLine($"{Dim}Sunucu: C# / .NET  ·  Xurrent modu: {cfg.XurrentMode}  ·  " +
                          $"Takvim: {cfg.CalendarProvider}  ·  Strateji: {cfg.BackdateStrategy}{Reset}\n");

        var vars = BuildTemplateVariables(cfg);
        string? lastChapter = null;

        foreach (var node in doc["steps"] as JsonArray ?? [])
        {
            var step = node!.AsObject();
            var chapterId = step["chapter"]?.GetValue<string>();
            if (chapterId is not null && chapterId != lastChapter)
            {
                lastChapter = chapterId;
                Console.WriteLine($"\n{Cyan}{Bold}══ {chapters.GetValueOrDefault(chapterId, chapterId)} ══{Reset}");
            }

            Console.WriteLine($"\n{Bold}{step["id"]!.GetValue<string>()} — {step["title"]!.GetValue<string>()}{Reset}");

            foreach (var line in step["narrate"] as JsonArray ?? [])
                Console.WriteLine("  " + line!.GetValue<string>());

            PrintTable(step["table"]?.AsObject());

            // ── tools/list ──────────────────────────────────────────────────
            if (step["listTools"]?.GetValue<bool>() == true)
            {
                var tools = await session.Client.ListToolsAsync(cancellationToken: ct);
                Console.WriteLine($"\n  {Dim}→ tools/list{Reset}");

                // Sıra KORUNUR (sözleşme sırası) — alfabetik sıralamıyoruz, çünkü
                // deterministik sıranın kendisi v2'nin bir gereğidir.
                var withSchema = 0;
                foreach (var t in tools)
                {
                    var hasSchema = t.ProtocolTool.OutputSchema is not null;
                    if (hasSchema) withSchema++;
                    Console.WriteLine($"    · {t.Name}" +
                                      (t.ProtocolTool.Annotations?.ReadOnlyHint == true ? $" {Dim}(readOnly){Reset}" : "") +
                                      (hasSchema ? $" {Green}[outputSchema]{Reset}" : $" {Red}[şema YOK]{Reset}"));
                }
                Console.WriteLine($"    {Dim}outputSchema beyan eden: {withSchema}/{tools.Count}{Reset}");

                CheckExpectations(step["expect"] as JsonArray, new JsonObject { ["toolCount"] = tools.Count });
            }

            // ── tek tool çağrısı ────────────────────────────────────────────
            if (step["callTool"] is JsonObject call)
            {
                var payload = await CallToolAsync(session, call, vars, null, ct);
                CheckExpectations(step["expect"] as JsonArray, payload);
            }

            // ── ardışık tool çağrıları (strateji karşılaştırması) ───────────
            foreach (var seq in step["callToolSequence"] as JsonArray ?? [])
            {
                var item = seq!.AsObject();
                await CallToolAsync(session, item, vars, item["label"]?.GetValue<string>(), ct);
            }

            // ── protokol karşılaştırması ────────────────────────────────────
            // Bu adım AYNI sunucuyu İKİ AYRI SÜREÇ olarak, iki farklı MCP revizyonuyla
            // konuşturmayı gerektirir. Süreç içi client tek bir oturum kurduğu için
            // burada yapılamaz; ortak istemci (clients/wizard/wizard.mjs) yapar.
            if (step["compareProtocols"] is JsonObject cp)
            {
                var protocols = string.Join(", ",
                    (cp["protocols"] as JsonArray ?? []).Select(p => p!.GetValue<string>()));
                Console.WriteLine($"\n  {Dim}→ protokol karşılaştırması ({protocols}){Reset}");
                SkipExpectations(step["expect"] as JsonArray,
                    "Süreç içi sihirbaz TEK oturum kurar; iki revizyonu yan yana koşturmak " +
                    "iki AYRI süreç gerektirir → ortak istemci: " +
                    $"node clients/wizard/wizard.mjs --server cs --only {step["id"]!.GetValue<string>()}");
                step.Remove("expect");
            }

            foreach (var line in step["reveal"] as JsonArray ?? [])
                Console.WriteLine($"  {Yellow}▸{Reset} {line!.GetValue<string>()}");

            PrintQuiz(step["quiz"]?.AsObject());

            if (step["docs"]?.GetValue<string>() is { } docs)
                Console.WriteLine($"  {Dim}📖 {docs}{Reset}");

            if (pause && !Console.IsInputRedirected)
            {
                Console.Write($"{Dim}  [Enter ile devam]{Reset}");
                Console.ReadLine();
            }
        }

        Console.WriteLine();

        // K3 — özet satırı ÜÇ SAYI taşır. Üç dilde de aynı biçim.
        var summary = $"{_passed} geçti, {_failed} başarısız, {_skipped} atlandı";
        if (_failed == 0)
        {
            Console.WriteLine($"{Green}{Bold}✔ {summary}.{Reset}");
            Console.WriteLine($"{Dim}Aynı adımları TypeScript ve Python sunucularıyla da çalıştırın — sayılar değişmeyecek.{Reset}");
            return 0;
        }

        Console.WriteLine($"{Red}{Bold}✘ {summary}.{Reset}");
        return 1;
    }

    // ── Tool çağrısı ─────────────────────────────────────────────────────────

    private static async Task<JsonObject> CallToolAsync(
        InProcessMcpSession session, JsonObject call, Dictionary<string, string> vars, string? label, CancellationToken ct)
    {
        var name = call["name"]!.GetValue<string>();
        var args = (call["args"]?.AsObject() ?? []).DeepClone().AsObject();
        Substitute(args, vars);

        var dict = args.ToDictionary(kv => kv.Key, kv => (object?)JsonSerializer.Deserialize<JsonElement>(kv.Value ?? "null"));

        var prefix = label is null ? "" : $"[{label}] ";
        Console.WriteLine($"\n  {Dim}→ {prefix}tools/call {name} {args.ToJsonString()}{Reset}");

        var result = await session.Client.CallToolAsync(name, dict, cancellationToken: ct);

        // Okunabilir Türkçe blok İNSANA, structuredContent MAKİNEYE. Beklenti kontrolleri
        // structuredContent üzerinden yapılır: metin biçimi değişse bile testler kırılmaz.
        var text = string.Concat(result.Content.OfType<TextContentBlock>().Select(c => c.Text));
        if (!string.IsNullOrWhiteSpace(text)) Console.WriteLine(Indent(text, "    "));

        if (result.StructuredContent is not { } structured)
        {
            Console.WriteLine($"    {Red}structuredContent YOK — sunucu outputSchema yayınlamıyor.{Reset}");
            return [];
        }

        var payload = JsonNode.Parse(structured.GetRawText())!.AsObject();
        Console.WriteLine($"    {Dim}structuredContent: {payload.ToJsonString(Json.Options)}{Reset}");
        return payload;
    }

    // ── Beklenti kontrolü ────────────────────────────────────────────────────

    /// <summary>
    /// K3 — beklenti değerlendirmesi. Payload BOŞSA (çağrı hiç sonuç üretemediyse)
    /// kontroller ÇALIŞTIRILAMAMIŞTIR: bu SKIP'tir, FAIL değil.
    /// </summary>
    private static void CheckExpectations(JsonArray? expectations, JsonObject payload)
    {
        if (payload.Count == 0)
        {
            SkipExpectations(expectations, "Sonuç alınamadığı için kontroller çalıştırılamadı.");
            return;
        }

        foreach (var node in expectations ?? [])
        {
            var e = node!.AsObject();
            var path = e["path"]?.GetValue<string>() ?? e["check"]?.GetValue<string>() ?? "";
            var actual = Resolve(payload, path);

            if (e["equals"] is { } expected)
            {
                var ok = JsonNode.DeepEquals(actual, expected);
                Tally(ok);
                var mark = ok ? $"{Green}✔ PASS{Reset}" : $"{Red}✘ FAIL{Reset}";
                Console.WriteLine($"  {mark} {path} = {actual?.ToJsonString() ?? "null"}" +
                                  (ok ? "" : $" {Red}(beklenen {expected.ToJsonString()}){Reset}"));
            }
            else if (e["exists"]?.GetValue<bool>() == true)
            {
                var ok = actual is not null;
                Tally(ok);
                Console.WriteLine($"  {(ok ? $"{Green}✔ PASS{Reset}" : $"{Red}✘ FAIL{Reset}")} {path} mevcut");
            }

            if (e["explain"]?.GetValue<string>() is { } explain)
                Console.WriteLine($"      {Dim}{explain}{Reset}");
        }
    }

    private static void Tally(bool ok)
    {
        if (ok) _passed++; else _failed++;
    }

    /// <summary>Ön koşulu olmayan kontroller ATLANIR ve gerekçesi Türkçe yazılır.</summary>
    private static void SkipExpectations(JsonArray? expectations, string reason)
    {
        foreach (var node in expectations ?? [])
        {
            var e = node!.AsObject();
            var path = e["path"]?.GetValue<string>() ?? e["check"]?.GetValue<string>() ?? "";
            _skipped++;
            Console.WriteLine($"  {Yellow}– SKIP{Reset} {path}");
            Console.WriteLine($"      {Dim}{reason}{Reset}");
        }
    }

    /// <summary>"requests.totalCount" ve "proposals.length" biçimlerini çözer.</summary>
    private static JsonNode? Resolve(JsonObject root, string path)
    {
        JsonNode? current = root;
        foreach (var part in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
        {
            if (current is null) return null;
            if (part == "length")
            {
                current = current is JsonArray arr ? JsonValue.Create(arr.Count) : null;
                continue;
            }
            current = current is JsonObject o && o.TryGetPropertyValue(part, out var next) ? next : null;
        }
        return current;
    }

    // ── Şablon değişkenleri ──────────────────────────────────────────────────

    private static Dictionary<string, string> BuildTemplateVariables(AppConfig cfg)
    {
        var tz = cfg.TimeZone;
        var today = TimeUtil.Today(tz, cfg.Clock);
        var yesterday = today.AddDays(-1);
        var offset = tz.GetUtcOffset(today.ToDateTime(TimeOnly.MinValue, DateTimeKind.Unspecified));
        var offsetText = (offset < TimeSpan.Zero ? "-" : "+") +
                         offset.Duration().ToString("hh\\:mm", CultureInfo.InvariantCulture);

        return new Dictionary<string, string>
        {
            ["{{today}}"] = today.ToString("yyyy-MM-dd"),
            ["{{yesterday}}"] = yesterday.ToString("yyyy-MM-dd"),
            ["{{tzOffset}}"] = offsetText,
        };
    }

    private static void Substitute(JsonNode node, Dictionary<string, string> vars)
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var key in o.Select(kv => kv.Key).ToList())
                {
                    if (o[key] is JsonValue v && v.GetValueKind() == JsonValueKind.String)
                    {
                        var s = v.GetValue<string>();
                        foreach (var (k, r) in vars) s = s.Replace(k, r, StringComparison.Ordinal);
                        o[key] = s;
                    }
                    else if (o[key] is { } child) Substitute(child, vars);
                }
                break;
            case JsonArray a:
                for (var i = 0; i < a.Count; i++)
                {
                    if (a[i] is JsonValue v2 && v2.GetValueKind() == JsonValueKind.String)
                    {
                        var s = v2.GetValue<string>();
                        foreach (var (k, r) in vars) s = s.Replace(k, r, StringComparison.Ordinal);
                        a[i] = s;
                    }
                    else if (a[i] is { } child) Substitute(child, vars);
                }
                break;
        }
    }

    // ── Yazdırma ─────────────────────────────────────────────────────────────

    private static void Header(string title, string? subtitle)
    {
        Console.WriteLine($"\n{Cyan}{Bold}{title}{Reset}");
        if (subtitle is not null) Console.WriteLine($"{Dim}{subtitle}{Reset}");
    }

    private static void PrintTable(JsonObject? table)
    {
        if (table is null) return;
        var headers = (table["headers"] as JsonArray ?? []).Select(h => h!.GetValue<string>()).ToList();
        var rows = (table["rows"] as JsonArray ?? [])
            .Select(r => (r as JsonArray ?? []).Select(c => c!.GetValue<string>()).ToList()).ToList();

        var widths = headers.Select((h, i) =>
            Math.Max(h.Length, rows.Count == 0 ? 0 : rows.Max(r => i < r.Count ? r[i].Length : 0))).ToList();

        Console.WriteLine();
        Console.WriteLine("  " + string.Join(" │ ", headers.Select((h, i) => h.PadRight(widths[i]))));
        Console.WriteLine("  " + string.Join("─┼─", widths.Select(w => new string('─', w))));
        foreach (var row in rows)
            Console.WriteLine("  " + string.Join(" │ ", row.Select((c, i) => c.PadRight(widths[i]))));
    }

    private static void PrintQuiz(JsonObject? quiz)
    {
        if (quiz is null) return;
        Console.WriteLine($"\n  {Bold}SORU:{Reset} {quiz["question"]!.GetValue<string>()}");
        var options = (quiz["options"] as JsonArray ?? []).Select(o => o!.GetValue<string>()).ToList();
        var answer = quiz["answer"]!.GetValue<int>();
        for (var i = 0; i < options.Count; i++)
            Console.WriteLine($"    {(i == answer ? $"{Green}✔{Reset}" : " ")} {(char)('A' + i)}) {options[i]}");
        Console.WriteLine($"    {Dim}{quiz["explain"]?.GetValue<string>()}{Reset}");
    }

    private static string Indent(string text, string prefix)
        => string.Join('\n', text.Split('\n').Select(l => prefix + l));
}
