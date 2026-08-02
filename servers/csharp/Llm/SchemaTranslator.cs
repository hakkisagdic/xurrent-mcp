using System.Text.Json.Nodes;

namespace XurrentMcp.Llm;

/// <summary>Bir şema anahtarına ne yapıldığı.</summary>
public enum SchemaNoteKind
{
    /// <summary>Gemini alt kümesinde karşılığı yok; tamamen atıldı.</summary>
    Dropped,

    /// <summary>Anahtar atıldı AMA bilgisi description metnine taşındı (default gibi).</summary>
    MovedToDescription,

    /// <summary>Anahtar korundu ama biçimi değişti ($ref → ref, type[] → nullable gibi).</summary>
    Rewritten,
}

/// <summary>Çeviri sırasında tek bir anahtar hakkında tutulan kayıt. Ders artefaktıdır.</summary>
public sealed record SchemaNote(string Path, string Keyword, SchemaNoteKind Kind, string Reason)
{
    public string KindLabel => Kind switch
    {
        SchemaNoteKind.Dropped => "atıldı",
        SchemaNoteKind.MovedToDescription => "açıklamaya taşındı",
        _ => "dönüştürüldü",
    };

    public override string ToString() => $"{Path} · {Keyword} · {KindLabel} · {Reason}";
}

/// <summary>
/// Çeviri sonucu. <see cref="Parameters"/> null ise tool parametresizdir ve
/// functionDeclaration'a "parameters" alanı HİÇ konmaz.
/// </summary>
public sealed record SchemaTranslation(JsonObject? Parameters, IReadOnlyList<SchemaNote> Notes, int MaxDepth)
{
    public IEnumerable<SchemaNote> Dropped => Notes.Where(n => n.Kind == SchemaNoteKind.Dropped);
}

/// <summary>
/// ★ ASIL MÜHENDİSLİK PROBLEMİ: MCP şeması ile Gemini şeması AYNI DİL DEĞİLDİR.
///
/// MCP inputSchema tam JSON Schema 2020-12'dir (2026-07-28 revizyonu bunu bilerek gevşetti).
/// Gemini functionDeclarations ise OpenAPI şemasının dar bir ALT KÜMESİNİ kabul eder:
///
///   Desteklenen : type (string|number|integer|boolean|array|object), properties, required,
///                 description, enum, items, nullable
///   Özel kural  : $ref ve $defs DOLAR İŞARETİ OLMADAN yazılır → ref, defs
///                 ref yalnızca KÖK defs'in DOĞRUDAN çocuğunu gösterebilir; dış referans YOK
///                 azami iç içe derinlik 32
///   Reddedilen  : $schema, additionalProperties, default, pattern, minimum, maximum,
///                 minLength/maxLength, minItems/maxItems, oneOf/anyOf/allOf, const, format, ...
///
/// Bu sınıf o çeviriyi yapar ve NE ATTIĞINI KAYDEDER. Kayıt tutmak süs değil:
/// "aynı sözleşme, iki farklı tool-calling lehçesi" tezinin tek kanıtı budur.
/// dotnet run -- sema-testi bu kayıtları ekrana basar.
///
/// SAFLIK: <see cref="Translate"/> saf bir fonksiyondur — girdiyi değiştirmez, IO yapmaz,
/// log basmaz, global durum okumaz. Loglamak ÇAĞIRANIN işidir (stdio modunda stdout
/// yalnızca JSON-RPC'ye aittir; buradan yanlışlıkla bir satır basmak protokolü bozardı).
/// </summary>
public static class SchemaTranslator
{
    /// <summary>Gemini'nin ilan ettiği azami iç içe geçme derinliği.</summary>
    public const int DepthLimit = 32;

    /// <summary>Gemini'nin kabul ettiği tip adları. Bunun dışındaki her tip atılır.</summary>
    private static readonly HashSet<string> AllowedTypes = new(StringComparer.Ordinal)
        { "string", "number", "integer", "boolean", "array", "object" };

    /// <summary>Çevrilmiş şemada bulunmasına izin verilen anahtarlar (doğrulama için de kullanılır).</summary>
    public static readonly IReadOnlySet<string> AllowedKeywords = new HashSet<string>(StringComparer.Ordinal)
        { "type", "description", "enum", "properties", "required", "items", "defs", "ref", "nullable" };

    // ── Genel giriş noktası ──────────────────────────────────────────────────

    /// <summary>MCP inputSchema → Gemini functionDeclarations.parameters. SAF fonksiyon.</summary>
    public static SchemaTranslation Translate(JsonNode? mcpSchema, string rootPath = "#")
    {
        var ctx = new Context();
        var root = Node(mcpSchema, rootPath, depth: 1, isRoot: true, ctx);

        // Parametresiz tool: Gemini'de "parameters" alanı HİÇ verilmez.
        // Boş bir {"type":"object","properties":{}} göndermek bazı sürümlerde reddedilir.
        if (root is not null
            && root["ref"] is null
            && root["properties"] is not JsonObject { Count: > 0 })
        {
            ctx.Note(rootPath, "parameters", SchemaNoteKind.Dropped,
                "tool parametresiz — 'parameters' alanı hiç gönderilmiyor");
            root = null;
        }

        return new SchemaTranslation(root, ctx.Notes, ctx.MaxDepth);
    }

    /// <summary>
    /// Tek bir tool'un tam functionDeclaration nesnesi: { name, description, parameters? }.
    /// </summary>
    public static (JsonObject Declaration, SchemaTranslation Translation) Declare(
        string name, string? description, JsonNode? mcpSchema)
    {
        var translation = Translate(mcpSchema, name);

        var declaration = new JsonObject
        {
            ["name"] = name,
            ["description"] = string.IsNullOrWhiteSpace(description) ? name : description,
        };
        if (translation.Parameters is { } p) declaration["parameters"] = p;

        return (declaration, translation);
    }

    // ── Düğüm çevirisi ───────────────────────────────────────────────────────

    private static JsonObject? Node(JsonNode? node, string path, int depth, bool isRoot, Context ctx)
    {
        ctx.MaxDepth = Math.Max(ctx.MaxDepth, depth);

        if (node is not JsonObject src)
        {
            // true/false şemaları (JSON Schema'da geçerlidir) Gemini'de karşılıksızdır.
            if (node is not null)
                ctx.Note(path, "(şema)", SchemaNoteKind.Dropped, "şema düğümü nesne değil");
            return null;
        }

        if (depth > DepthLimit)
        {
            ctx.Note(path, "(derinlik)", SchemaNoteKind.Dropped,
                $"Gemini azami iç içe derinliği {DepthLimit}; bu dal kesildi");
            return null;
        }

        string? type = null;
        var nullable = false;
        JsonArray? enumValues = null;
        JsonObject? properties = null;
        List<string>? required = null;
        JsonObject? items = null;
        JsonObject? defs = null;
        string? refPath = null;
        string? description = null;
        string? defaultJson = null;
        string? defaultPlain = null;
        string? defaultPath = null;

        foreach (var (key, value) in src)
        {
            var kp = $"{path}.{key}";

            switch (key)
            {
                case "type":
                    (type, nullable) = MapType(value, kp, ctx);
                    break;

                case "description":
                    description = Str(value);
                    break;

                case "enum":
                    enumValues = MapEnum(value, kp, ctx);
                    break;

                case "properties":
                    properties = MapProperties(value, kp, depth, ctx);
                    break;

                case "required":
                    required = (value as JsonArray)?.Select(Str).OfType<string>().ToList();
                    break;

                case "items":
                    items = Node(value, kp, depth + 1, isRoot: false, ctx);
                    if (items is null)
                        ctx.Note(kp, "items", SchemaNoteKind.Dropped, "eleman şeması çevrilemedi");
                    break;

                // ── $defs / $ref: DOLAR İŞARETİ KALKAR ───────────────────────
                // Gemini şemasında alan adları 'defs' ve 'ref'tir. Dolar işareti bırakmak
                // "unknown field" hatası verir; bu, çevirinin en kolay gözden kaçan yeridir.
                case "$defs":
                case "defs":
                    if (!isRoot)
                    {
                        // ref YALNIZCA kök defs'in doğrudan çocuğunu gösterebilir; iç içe
                        // bir defs bloğu Gemini tarafından hiçbir şekilde adreslenemez.
                        ctx.Note(kp, key, SchemaNoteKind.Dropped, "defs yalnızca kökte olabilir");
                        break;
                    }
                    defs = MapDefs(value, kp, depth, ctx);
                    ctx.Note(kp, key, SchemaNoteKind.Rewritten, "$defs → defs");
                    break;

                case "$ref":
                case "ref":
                    refPath = MapRef(Str(value), kp, ctx);
                    break;

                // ── default: ATILIR ama KAYBOLMAZ ────────────────────────────
                // Gemini şeması default kabul etmez. Değeri açıklama metnine yazıyoruz,
                // çünkü "personId boşsa $me" bilgisi modelin doğru çağrı yapması için gerekli.
                // Kayıt aşağıda, Compose'un ne yaptığı BİLİNDİKTEN sonra tutulur: anahtar
                // sırası JSON'da garantili değil, description'ı burada görmüş olamayabiliriz.
                case "default":
                    defaultJson = value?.ToJsonString(Json.Options);
                    defaultPlain = Str(value) ?? defaultJson;   // metin default'ta tırnaksız hâli aranır
                    defaultPath = kp;
                    break;

                default:
                    ctx.Note(kp, key, SchemaNoteKind.Dropped,
                        "Gemini functionDeclarations şema alt kümesinde yok");
                    break;
            }
        }

        // Tip çıkarımı: sözleşmede {"enum":[...]} tipsiz yazılabiliyor, Gemini ise
        // enum'u YALNIZCA type=string ile kabul eder. Tipi burada tamamlıyoruz.
        if (type is null && refPath is null)
        {
            if (enumValues is not null) type = "string";
            else if (properties is not null) type = "object";
            else if (items is not null) type = "array";
        }

        // required, gerçekten var olan property'lere daralt: Gemini olmayan bir alanı
        // zorunlu görürse tanımı komple reddeder.
        if (required is { Count: > 0 })
        {
            var known = properties is null ? [] : properties.Select(p => p.Key).ToHashSet(StringComparer.Ordinal);
            foreach (var missing in required.Where(r => !known.Contains(r)))
                ctx.Note($"{path}.required", missing, SchemaNoteKind.Dropped,
                    "required listesinde ama properties içinde yok");
            required = required.Where(known.Contains).ToList();
        }

        var finalDescription = Compose(description, defaultJson, defaultPlain);

        if (defaultPath is not null)
            ctx.Note(defaultPath, "default", SchemaNoteKind.MovedToDescription,
                ReferenceEquals(finalDescription, description)
                    ? $"default={defaultJson} zaten açıklamada geçiyor; tekrar yazılmadı"
                    : $"default={defaultJson} açıklamaya yazıldı");

        var result = new JsonObject();
        if (refPath is not null) result["ref"] = refPath;
        if (type is not null) result["type"] = type;
        if (nullable) result["nullable"] = true;
        if (finalDescription is not null) result["description"] = finalDescription;
        if (enumValues is not null) result["enum"] = enumValues;
        if (properties is not null) result["properties"] = properties;
        if (required is { Count: > 0 }) result["required"] = new JsonArray([.. required.Select(r => (JsonNode)r!)]);
        if (items is not null) result["items"] = items;
        if (defs is not null) result["defs"] = defs;

        return result.Count == 0 ? null : result;
    }

    // ── Parçalar ─────────────────────────────────────────────────────────────

    private static (string? Type, bool Nullable) MapType(JsonNode? value, string path, Context ctx)
    {
        if (Str(value) is { } single)
            return AllowedTypes.Contains(single)
                ? (single, false)
                : (null, DropType(single, path, ctx));

        if (value is JsonArray union)
        {
            // ["string","null"] gibi birleşimler sözleşmede boldur. Gemini tek tip kabul eder;
            // "null" üyesi nullable bayrağına çevrilir (Schema.nullable — ai.google.dev).
            string? picked = null;
            var nullable = false;

            foreach (var member in union.Select(Str).OfType<string>())
            {
                if (member == "null") { nullable = true; continue; }
                if (!AllowedTypes.Contains(member)) { DropType(member, path, ctx); continue; }
                if (picked is null) picked = member;
                else ctx.Note(path, member, SchemaNoteKind.Dropped, $"birleşim tipinde ikinci tip; '{picked}' seçildi");
            }

            ctx.Note(path, "type[]", SchemaNoteKind.Rewritten,
                $"birleşim tipi → type={picked ?? "(yok)"}, nullable={(nullable ? "true" : "false")}");
            return (picked, nullable);
        }

        ctx.Note(path, "type", SchemaNoteKind.Dropped, "tip değeri metin veya dizi değil");
        return (null, false);
    }

    private static bool DropType(string type, string path, Context ctx)
    {
        ctx.Note(path, type, SchemaNoteKind.Dropped, "Gemini'nin kabul ettiği tipler dışında");
        return false;
    }

    private static JsonArray? MapEnum(JsonNode? value, string path, Context ctx)
    {
        if (value is not JsonArray arr || arr.Count == 0)
        {
            ctx.Note(path, "enum", SchemaNoteKind.Dropped, "enum boş veya dizi değil");
            return null;
        }

        var values = arr.Select(Str).ToList();
        if (values.Any(v => v is null))
        {
            // Gemini enum'u yalnızca STRING tipiyle destekler; sayısal/karışık enum atılır.
            ctx.Note(path, "enum", SchemaNoteKind.Dropped, "enum değerleri metin değil");
            return null;
        }

        return new JsonArray([.. values.Select(v => (JsonNode)v!)]);
    }

    private static JsonObject? MapProperties(JsonNode? value, string path, int depth, Context ctx)
    {
        if (value is not JsonObject props) return null;

        var result = new JsonObject();
        foreach (var (name, child) in props)
        {
            var translated = Node(child, $"{path}.{name}", depth + 1, isRoot: false, ctx);
            if (translated is null)
                ctx.Note($"{path}.{name}", name, SchemaNoteKind.Dropped, "alan şeması çevrilemedi");
            else
                result[name] = translated;
        }
        return result;
    }

    private static JsonObject? MapDefs(JsonNode? value, string path, int depth, Context ctx)
    {
        if (value is not JsonObject defs || defs.Count == 0) return null;

        var result = new JsonObject();
        foreach (var (name, child) in defs)
        {
            var translated = Node(child, $"{path}.{name}", depth + 1, isRoot: false, ctx);
            if (translated is not null) result[name] = translated;
        }
        return result.Count == 0 ? null : result;
    }

    /// <summary>
    /// "#/$defs/Person" → "#/defs/Person".
    /// Dış referans (başka dosya/URL) ve derin yol (#/$defs/A/properties/b) DESTEKLENMEZ:
    /// Gemini ref'i yalnızca kök defs'in DOĞRUDAN çocuğuna bağlar.
    /// </summary>
    private static string? MapRef(string? value, string path, Context ctx)
    {
        if (value is null)
        {
            ctx.Note(path, "$ref", SchemaNoteKind.Dropped, "ref değeri metin değil");
            return null;
        }

        foreach (var prefix in new[] { "#/$defs/", "#/defs/" })
        {
            if (!value.StartsWith(prefix, StringComparison.Ordinal)) continue;

            var name = value[prefix.Length..];
            if (name.Length == 0 || name.Contains('/'))
            {
                ctx.Note(path, "$ref", SchemaNoteKind.Dropped,
                    $"'{value}' defs'in doğrudan çocuğu değil");
                return null;
            }

            ctx.Note(path, "$ref", SchemaNoteKind.Rewritten, $"{value} → #/defs/{name}");
            return $"#/defs/{name}";
        }

        ctx.Note(path, "$ref", SchemaNoteKind.Dropped, $"dış referans desteklenmiyor: '{value}'");
        return null;
    }

    /// <summary>
    /// default değerini açıklamaya taşır. Kural bilgi KAYBETMEMEKtir, cümle EKLEMEK değil:
    /// çalışma anındaki MCP şemalarında açıklama zaten "... Varsayılan '$me'." ile bitiyor;
    /// üstüne bir de "Varsayılan: "$me"." eklemek modelin okuduğu metni gürültüye boğar.
    ///
    /// ★ Atlama koşulu DAR tutulur: yalnızca açıklamada "Varsayılan" sözcüğü GEÇİYORSA ve
    /// değer o sözcükten SONRA görünüyorsa. Sadece "değer metinde geçiyor mu" diye bakmak
    /// sessizce bilgi kaybettirir: stopOnError'ın açıklaması "true ise ilk hatada durur"dur
    /// ve içindeki "true" varsayılanı DEĞİL, doğru değerin anlamını anlatır. Böyle bir
    /// eşleşmede varsayılan hiç yazılmaz ve model onu bilemez.
    /// Atlanırsa açıklama OLDUĞU GİBİ döner; çağıran referans eşitliğiyle hangi dalın
    /// işlediğini anlar ve kaydı ona göre tutar.
    /// </summary>
    private static string? Compose(string? description, string? defaultJson, string? defaultPlain)
    {
        if (defaultJson is null) return description;

        if (description is not null && defaultPlain is not null)
        {
            var at = description.IndexOf("Varsayılan", StringComparison.OrdinalIgnoreCase);
            if (at >= 0 && description.AsSpan(at).Contains(defaultPlain, StringComparison.Ordinal))
                return description;
        }

        var suffix = $"Varsayılan: {defaultJson}.";
        return string.IsNullOrWhiteSpace(description) ? suffix : $"{description.TrimEnd()} {suffix}";
    }

    private static string? Str(JsonNode? node)
        => node is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    // ── Özet (stderr'e basılan ders artefaktı) ───────────────────────────────

    /// <summary>
    /// Notları anahtar bazında sayıp okunur satırlara indirger.
    /// Çağıran bunu stderr'e basar — ASLA stdout'a (stdio modunda protokolü bozar).
    /// </summary>
    public static IReadOnlyList<string> Summarize(IEnumerable<SchemaNote> notes, int toolCount)
    {
        var all = notes.ToList();
        var lines = new List<string>
        {
            $"[gemini] şema çevirisi: {toolCount} tool · MCP JSON Schema 2020-12 → Gemini functionDeclarations",
        };

        foreach (var kind in new[] { SchemaNoteKind.Dropped, SchemaNoteKind.MovedToDescription, SchemaNoteKind.Rewritten })
        {
            var group = all.Where(n => n.Kind == kind).ToList();
            if (group.Count == 0) continue;

            var label = kind switch
            {
                SchemaNoteKind.Dropped => "atılan          ",
                SchemaNoteKind.MovedToDescription => "açıklamaya taşınan",
                _ => "dönüştürülen    ",
            };

            var detail = string.Join(", ", group
                .GroupBy(n => n.Keyword, StringComparer.Ordinal)
                .OrderByDescending(g => g.Count()).ThenBy(g => g.Key, StringComparer.Ordinal)
                .Select(g => $"{g.Key}×{g.Count()}"));

            lines.Add($"[gemini]   {label} : {detail}");
        }

        return lines;
    }

    /// <summary>Çeviri sırasında tutulan geçici durum. Dışarı sızmaz — fonksiyon saf kalır.</summary>
    private sealed class Context
    {
        public readonly List<SchemaNote> Notes = [];
        public int MaxDepth;

        public void Note(string path, string keyword, SchemaNoteKind kind, string reason)
            => Notes.Add(new SchemaNote(path, keyword, kind, reason));
    }
}
