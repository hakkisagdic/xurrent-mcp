using System.Text.Json.Nodes;

namespace XurrentMcp.Llm;

/// <summary>
/// `dotnet run -- sema-testi` — şema çevirisinin DERS ARTEFAKTI.
///
/// ★ DEĞİŞTİ: buradaki iddiaların tamamı artık GERÇEK bir test projesinde de yaşıyor —
/// XurrentMcp.Tests/SemaTests.cs (`dotnet test`). Sebebi şuydu: elle yazılmış koşucuda
/// bir iddia kırıldığında ekranda tek satır çıkıyor, diğerlerinin durumu görünmüyordu;
/// ayrıca CI'da tool bazında raporlama yoktu.
///
/// Bu mod SİLİNMEDİ çünkü işi farklı: DERSTE çalıştırılır ve GÖSTERİR — atılan anahtar
/// tablosunu, açıklamaya taşınanları ve örnek bir functionDeclaration çıktısını basar.
/// İkisi birlikte kalır: burası anlatır, `dotnet test` denetler.
///
/// Kapsam:
///   • contract/tools.json'daki 10 tool'un input şeması çevrilir
///     (timesheet_wizard BURADA da çevrilir — bu mod sözleşmeyi anlatır; chatbot'un
///      functionDeclarations listesinden dışlama AgentCore'daki LLM filtresinin işidir)
///   • atılan / açıklamaya taşınan / dönüştürülen her anahtar listelenir
///   • $ref + $defs yeniden yazımı gerçek sözleşme $defs'i ile denenir
///   • derinlik sınırı (32) sentetik bir şema ile zorlanır
/// </summary>
public static class SchemaSelfTest
{
    public static int Run(AppConfig cfg)
    {
        var path = Path.Combine(cfg.RepoRoot, "contract", "tools.json");
        if (!File.Exists(path))
        {
            Console.Error.WriteLine($"Sözleşme bulunamadı: {path}");
            return 1;
        }

        var contract = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var tools = contract["tools"]!.AsArray();
        var defs = contract["$defs"]!.AsObject();

        var checks = new Checks();
        var allNotes = new List<SchemaNote>();

        Console.WriteLine();
        Console.WriteLine("şema testi — contract/tools.json (JSON Schema 2020-12) → Gemini functionDeclarations");
        Console.WriteLine(new string('─', 92));
        Console.WriteLine($"{"#",2}  {"tool",-38} {"alan",5}  {"derinlik",8}  atılan anahtarlar");
        Console.WriteLine(new string('─', 92));

        var index = 0;
        foreach (var node in tools)
        {
            var tool = node!.AsObject();
            var name = tool["name"]!.GetValue<string>();
            var input = tool["input"];

            SchemaTranslation translation;
            try
            {
                translation = SchemaTranslator.Translate(input, name);
            }
            catch (Exception ex)
            {
                checks.Fail($"'{name}' çevrilebiliyor", ex.Message);
                continue;
            }

            checks.Pass($"'{name}' çevrildi");
            allNotes.AddRange(translation.Notes);

            var fields = (translation.Parameters?["properties"] as JsonObject)?.Count ?? 0;
            var dropped = translation.Dropped
                .GroupBy(n => n.Keyword, StringComparer.Ordinal)
                .OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal)
                .Select(g => g.Count() > 1 ? $"{g.Key}×{g.Count()}" : g.Key);

            Console.WriteLine($"{++index,2}  {name,-38} {fields,5}  {translation.MaxDepth,8}  {string.Join(", ", dropped)}");

            VerifyTool(name, input, translation, checks);
        }

        Console.WriteLine(new string('─', 92));

        PrintNotes(allNotes);
        PrintSample(tools, "xurrent_create_time_entry");

        VerifyRefRewrite(defs, checks);
        VerifyDepthLimit(checks);
        VerifyDefaultDedup(checks);

        checks.Expect("sözleşmede tam 10 tool var", tools.Count == 10, $"{tools.Count} tool bulundu");

        return checks.Report();
    }

    // ── Tool başına iddialar ─────────────────────────────────────────────────

    private static void VerifyTool(string name, JsonNode? source, SchemaTranslation translation, Checks checks)
    {
        var parameters = translation.Parameters;

        // whoami parametresizdir: 'parameters' hiç gönderilmez. Diğerlerinde ŞART.
        var sourceProperties = source?["properties"] as JsonObject;
        if (sourceProperties is not { Count: > 0 })
        {
            checks.Expect($"{name}: parametresiz tool 'parameters' göndermiyor",
                parameters is null, "parameters null olmalıydı");
            return;
        }

        if (parameters is null)
        {
            checks.Fail($"{name}: parameters üretildi", "null döndü");
            return;
        }

        var walked = Walk(parameters).ToList();

        checks.Expect($"{name}: dolar işaretli anahtar kalmadı",
            walked.All(n => n.Key[0] != '$'),
            string.Join(", ", walked.Where(n => n.Key[0] == '$').Select(n => n.Key)));

        var unknown = walked.Where(n => !SchemaTranslator.AllowedKeywords.Contains(n.Key)).ToList();
        checks.Expect($"{name}: yalnızca Gemini'nin bildiği anahtarlar var",
            unknown.Count == 0, string.Join(", ", unknown.Select(n => $"{n.Path}.{n.Key}")));

        // enum YALNIZCA type=string ile geçerlidir; sözleşmede tipsiz enum'lar var.
        var badEnum = walked
            .Where(n => n.Key == "enum")
            .Where(n => n.Owner["type"]?.GetValue<string>() != "string")
            .ToList();
        checks.Expect($"{name}: her enum type=string taşıyor",
            badEnum.Count == 0, string.Join(", ", badEnum.Select(n => n.Path)));

        // Hiçbir alan kaybolmadı.
        var translated = (parameters["properties"] as JsonObject)?.Count ?? 0;
        checks.Expect($"{name}: {sourceProperties.Count} alanın hepsi korundu",
            translated == sourceProperties.Count, $"{translated} alan çevrildi");

        // required, gerçekten var olan alanları gösteriyor.
        var known = (parameters["properties"] as JsonObject)!.Select(p => p.Key).ToHashSet(StringComparer.Ordinal);
        var dangling = (parameters["required"] as JsonArray ?? [])
            .Select(r => r!.GetValue<string>()).Where(r => !known.Contains(r)).ToList();
        checks.Expect($"{name}: required listesi properties ile tutarlı",
            dangling.Count == 0, string.Join(", ", dangling));

        // default'lar ATILDI ama KAYBOLMADI: DEĞERLERİ açıklamada geçiyor.
        // İddia metnin biçimine değil, BİLGİNİN VARLIĞINA bakar: çevirici, açıklama
        // varsayılanı zaten söylüyorsa cümleyi ikinci kez eklemez (bkz. Compose).
        foreach (var (field, schema) in sourceProperties)
        {
            if (schema?["default"] is not { } def) continue;

            var text = ((parameters["properties"] as JsonObject)?[field]?["description"])?.GetValue<string>() ?? "";
            var json = def.ToJsonString(Json.Options);
            var plain = def is JsonValue v && v.TryGetValue<string>(out var s) ? s : json;

            checks.Expect($"{name}.{field}: default değeri ({json}) açıklamada duruyor",
                text.Contains(plain, StringComparison.Ordinal), $"açıklama: '{text}'");
        }

        checks.Expect($"{name}: derinlik sınırı aşılmadı ({translation.MaxDepth} ≤ {SchemaTranslator.DepthLimit})",
            translation.MaxDepth <= SchemaTranslator.DepthLimit, $"{translation.MaxDepth}");
    }

    // ── $ref / $defs yeniden yazımı ──────────────────────────────────────────

    private static void VerifyRefRewrite(JsonObject contractDefs, Checks checks)
    {
        // Sözleşmenin GERÇEK $defs'i kullanılıyor: tool input'larında $ref yok ama
        // output'larda var ve MCP inputSchema'sı da her an $ref taşıyabilir.
        var schema = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject
            {
                ["person"] = new JsonObject { ["$ref"] = "#/$defs/Person" },
                ["disari"] = new JsonObject { ["$ref"] = "https://ornek/sema.json#/Person" },
                ["derin"] = new JsonObject { ["$ref"] = "#/$defs/Person/properties/id" },
            },
            ["required"] = new JsonArray("person"),
            ["$defs"] = contractDefs.DeepClone(),
        };

        var t = SchemaTranslator.Translate(schema, "ref-testi");
        var p = t.Parameters;

        checks.Expect("$ref → ref (dolar işareti kalktı)",
            p?["properties"]?["person"]?["ref"]?.GetValue<string>() == "#/defs/Person",
            p?["properties"]?["person"]?.ToJsonString(Json.Options) ?? "(yok)");

        checks.Expect("$defs → defs ve hedef gerçekten defs'in doğrudan çocuğu",
            p?["defs"]?["Person"] is JsonObject,
            p?["defs"]?.ToJsonString(Json.Options)?[..Math.Min(80, p["defs"]!.ToJsonString(Json.Options).Length)] ?? "(yok)");

        checks.Expect("dış referans atıldı",
            p?["properties"]?["disari"]?["ref"] is null,
            "dış referans korunmuş");

        checks.Expect("defs'in doğrudan çocuğu olmayan derin referans atıldı",
            p?["properties"]?["derin"]?["ref"] is null,
            "derin referans korunmuş");

        checks.Expect("ref-testi: dolar işaretli anahtar kalmadı",
            Walk(p!).All(n => n.Key[0] != '$'), "dolar kaldı");
    }

    // ── Derinlik sınırı ──────────────────────────────────────────────────────

    private static void VerifyDepthLimit(Checks checks)
    {
        // 40 kat iç içe: Gemini 32'de keser, biz de kesmeliyiz — sessizce göndermek
        // tanımın tamamının reddedilmesine yol açar.
        JsonObject leaf = new() { ["type"] = "string" };
        var current = leaf;
        for (var i = 0; i < 40; i++)
            current = new JsonObject { ["type"] = "object", ["properties"] = new JsonObject { ["kat"] = current } };

        var t = SchemaTranslator.Translate(current, "derinlik-testi");

        checks.Expect($"derinlik {SchemaTranslator.DepthLimit} üstü dal kesildi",
            t.Notes.Any(n => n.Keyword == "(derinlik)"), "kesme kaydı yok");

        checks.Expect($"raporlanan azami derinlik sınırın bir üstünde durdu",
            t.MaxDepth <= SchemaTranslator.DepthLimit + 1, $"{t.MaxDepth}");
    }

    // ── default → açıklama taşıması ──────────────────────────────────────────

    /// <summary>
    /// Çalışma anındaki MCP şemaları contract/tools.json'dakinden FARKLIDIR: C# tool
    /// imzalarındaki [Description] metinleri varsayılanı zaten Türkçe söylüyor
    /// ("Person node ID veya '$me'. Varsayılan '$me'."). Çevirici oraya bir de
    /// "Varsayılan: "$me"." eklerse aynı bilgi üç kez yazılmış olur. Bu iddia her iki
    /// dalı da tutar: değer yoksa EKLENİR, varsa EKLENMEZ — ama her hâlde KAYBOLMAZ.
    /// </summary>
    private static void VerifyDefaultDedup(Checks checks)
    {
        var schema = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject
            {
                // Açıklama varsayılanı zaten söylüyor → tekrar eklenmemeli.
                ["soyleyen"] = new JsonObject
                {
                    ["type"] = "string",
                    ["description"] = "Person node ID veya '$me'. Varsayılan '$me'.",
                    ["default"] = "$me",
                },
                // Açıklama susuyor → değer eklenmeli.
                ["susan"] = new JsonObject
                {
                    ["type"] = "string",
                    ["description"] = "Sayfalama cursor'ı.",
                    ["default"] = "bas",
                },
                // ★ TUZAK: açıklama "true" sözcüğünü içeriyor ama VARSAYILANI söylemiyor.
                // Düz "metinde geçiyor mu" kontrolü burada sessizce bilgi kaybettirirdi.
                ["tuzak"] = new JsonObject
                {
                    ["type"] = "boolean",
                    ["description"] = "true ise ilk hatada durur.",
                    ["default"] = true,
                },
                // Açıklama hiç yok → tek cümlelik açıklama üretilmeli.
                ["aciklamasiz"] = new JsonObject { ["type"] = "integer", ["default"] = 25 },
            },
        };

        var p = SchemaTranslator.Translate(schema, "default-testi").Parameters;
        string Desc(string field) => p?["properties"]?[field]?["description"]?.GetValue<string>() ?? "";

        checks.Expect("default: açıklama zaten söylüyorsa cümle TEKRAR EKLENMEZ",
            Desc("soyleyen") == "Person node ID veya '$me'. Varsayılan '$me'.", Desc("soyleyen"));

        checks.Expect("default: açıklama susuyorsa değer EKLENİR",
            Desc("susan") == "Sayfalama cursor'ı. Varsayılan: \"bas\".", Desc("susan"));

        checks.Expect("default: değer metinde var ama 'Varsayılan' yoksa YİNE EKLENİR",
            Desc("tuzak") == "true ise ilk hatada durur. Varsayılan: true.", Desc("tuzak"));

        checks.Expect("default: açıklama yoksa tek başına üretilir",
            Desc("aciklamasiz") == "Varsayılan: 25.", Desc("aciklamasiz"));

        checks.Expect("default: hiçbir dalda 'default' anahtarı şemada kalmadı",
            Walk(p!).All(n => n.Key != "default"), "default anahtarı kaldı");
    }

    // ── Raporlama ────────────────────────────────────────────────────────────

    private static void PrintNotes(IReadOnlyList<SchemaNote> notes)
    {
        Console.WriteLine();
        Console.WriteLine("ATILAN ANAHTARLAR — MCP'de var, Gemini'de yok");
        foreach (var g in notes.Where(n => n.Kind == SchemaNoteKind.Dropped)
                     .GroupBy(n => n.Keyword, StringComparer.Ordinal)
                     .OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal))
            Console.WriteLine($"  {g.Key,-22} ×{g.Count(),-3} {g.First().Reason}");

        var moved = notes.Where(n => n.Kind == SchemaNoteKind.MovedToDescription).ToList();
        if (moved.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine("AÇIKLAMAYA TAŞINANLAR — atıldı ama bilgi kaybolmadı");
            foreach (var n in moved) Console.WriteLine($"  {n.Path,-56} {n.Reason}");
        }

        var rewritten = notes.Where(n => n.Kind == SchemaNoteKind.Rewritten).ToList();
        if (rewritten.Count > 0)
        {
            Console.WriteLine();
            Console.WriteLine("DÖNÜŞTÜRÜLENLER");
            foreach (var n in rewritten) Console.WriteLine($"  {n.Path,-56} {n.Reason}");
        }
    }

    private static void PrintSample(JsonArray tools, string toolName)
    {
        var tool = tools.FirstOrDefault(t => t?["name"]?.GetValue<string>() == toolName)?.AsObject();
        if (tool is null) return;

        var (declaration, _) = SchemaTranslator.Declare(
            toolName, tool["summary"]?.GetValue<string>(), tool["input"]);

        Console.WriteLine();
        Console.WriteLine($"ÖRNEK ÇIKTI — {toolName} functionDeclaration");
        Console.WriteLine(declaration.ToJsonString(Json.Pretty));
    }

    // ── Yardımcılar ──────────────────────────────────────────────────────────

    private sealed record WalkedKey(string Path, string Key, JsonObject Owner);

    /// <summary>Çevrilmiş şemadaki TÜM anahtarları gezer (doğrulama için).</summary>
    private static IEnumerable<WalkedKey> Walk(JsonNode node, string path = "#")
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var (key, value) in o)
                {
                    yield return new WalkedKey(path, key, o);

                    // properties/defs altındaki adlar ŞEMA ANAHTARI DEĞİL, alan adıdır:
                    // bir seviye atlayıp çocuklarına iniyoruz.
                    if (key is "properties" or "defs" && value is JsonObject bag)
                    {
                        foreach (var (childName, child) in bag)
                            if (child is not null)
                                foreach (var w in Walk(child, $"{path}.{key}.{childName}"))
                                    yield return w;
                    }
                    else if (value is JsonObject or JsonArray && key is not "enum" and not "required")
                    {
                        foreach (var w in Walk(value!, $"{path}.{key}")) yield return w;
                    }
                }
                break;

            case JsonArray a:
                var i = 0;
                foreach (var item in a)
                    if (item is not null)
                        foreach (var w in Walk(item, $"{path}[{i++}]"))
                            yield return w;
                break;
        }
    }

    private sealed class Checks
    {
        private int _passed;
        private readonly List<string> _failures = [];

        public void Pass(string label) => _passed++;

        public void Fail(string label, string detail) => _failures.Add($"{label} — {detail}");

        public void Expect(string label, bool condition, string detail)
        {
            if (condition) _passed++;
            else Fail(label, detail);
        }

        public int Report()
        {
            Console.WriteLine();
            Console.WriteLine(new string('─', 92));

            foreach (var f in _failures) Console.WriteLine($"  ✗ {f}");

            Console.WriteLine(_failures.Count == 0
                ? $"✓ {_passed} iddia geçti, 0 başarısız."
                : $"✗ {_passed} iddia geçti, {_failures.Count} BAŞARISIZ.");

            return _failures.Count == 0 ? 0 : 1;
        }
    }
}
