using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Llm;

namespace XurrentMcp.Tests;

/// <summary>
/// Şema çevirisi: MCP inputSchema (JSON Schema 2020-12) → Gemini functionDeclarations.
///
/// Bu iddialar eskiden `dotnet run -- sema-testi` içindeki elle yazılmış koşucuda yaşıyordu.
/// Buraya TAŞINDILAR; o mod ise DERS ARTEFAKTI olarak duruyor (atılan anahtar tablosunu ve
/// örnek çıktıyı ekrana basar). Fark şu: burada her iddia ayrı bir testtir, adıyla raporlanır
/// ve bir tanesinin kırılması diğerlerinin sonucunu gizlemez.
/// </summary>
public class SemaTests
{
    private static readonly JsonObject Sozlesme =
        JsonNode.Parse(File.ReadAllText(Path.Combine(Ortam.RepoKoku, "contract", "tools.json")))!.AsObject();

    private static JsonArray Toollar => Sozlesme["tools"]!.AsArray();

    private static JsonObject Tool(string ad)
        => Toollar.Select(t => t!.AsObject()).Single(t => t["name"]!.GetValue<string>() == ad);

    /// <summary>Sözleşmedeki tool adları — her tool ayrı bir test vakası olarak koşar.</summary>
    public static TheoryData<string> ToolAdlari
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var t in Toollar) data.Add(t!["name"]!.GetValue<string>());
            return data;
        }
    }

    [Fact]
    public void sozlesmede_tam_8_tool_vardir()
    {
        Assert.Equal(8, Toollar.Count);
    }

    // ── Tool başına çeviri iddiaları ─────────────────────────────────────────

    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void her_tool_istisnasiz_cevrilir(string ad)
    {
        var ceviri = SchemaTranslator.Translate(Tool(ad)["input"], ad);
        Assert.NotNull(ceviri);
    }

    /// <summary>Dolar işaretli anahtar bırakmak Gemini'de "unknown field" hatasıdır.</summary>
    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void cevrilmis_semada_dolar_isaretli_anahtar_kalmaz(string ad)
    {
        var p = SchemaTranslator.Translate(Tool(ad)["input"], ad).Parameters;
        if (p is null) return;

        var kalanlar = Gez(p).Where(a => a.Anahtar[0] == '$').Select(a => $"{a.Yol}.{a.Anahtar}").ToList();
        Assert.Empty(kalanlar);
    }

    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void cevrilmis_semada_yalnizca_Gemini_nin_bildigi_anahtarlar_bulunur(string ad)
    {
        var p = SchemaTranslator.Translate(Tool(ad)["input"], ad).Parameters;
        if (p is null) return;

        var bilinmeyen = Gez(p)
            .Where(a => !SchemaTranslator.AllowedKeywords.Contains(a.Anahtar))
            .Select(a => $"{a.Yol}.{a.Anahtar}")
            .ToList();

        Assert.Empty(bilinmeyen);
    }

    /// <summary>Gemini enum'u YALNIZCA type=string ile kabul eder; sözleşmede tipsiz enum'lar var.</summary>
    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void her_enum_type_string_tasir(string ad)
    {
        var p = SchemaTranslator.Translate(Tool(ad)["input"], ad).Parameters;
        if (p is null) return;

        var tipsiz = Gez(p)
            .Where(a => a.Anahtar == "enum" && a.Sahip["type"]?.GetValue<string>() != "string")
            .Select(a => a.Yol)
            .ToList();

        Assert.Empty(tipsiz);
    }

    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void ceviride_hicbir_alan_kaybolmaz(string ad)
    {
        var kaynak = Tool(ad)["input"]?["properties"] as JsonObject;
        var p = SchemaTranslator.Translate(Tool(ad)["input"], ad).Parameters;

        if (kaynak is not { Count: > 0 })
        {
            // Parametresiz tool: Gemini'ye 'parameters' alanı HİÇ gönderilmez.
            Assert.Null(p);
            return;
        }

        Assert.Equal(kaynak.Count, (p!["properties"] as JsonObject)!.Count);
    }

    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void required_listesi_yalnizca_var_olan_alanlari_gosterir(string ad)
    {
        var p = SchemaTranslator.Translate(Tool(ad)["input"], ad).Parameters;
        if (p is null) return;

        var bilinen = (p["properties"] as JsonObject)!.Select(x => x.Key).ToHashSet(StringComparer.Ordinal);
        var bosluktakiler = (p["required"] as JsonArray ?? [])
            .Select(r => r!.GetValue<string>())
            .Where(r => !bilinen.Contains(r))
            .ToList();

        Assert.Empty(bosluktakiler);
    }

    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void derinlik_siniri_asilmaz(string ad)
    {
        var ceviri = SchemaTranslator.Translate(Tool(ad)["input"], ad);
        Assert.True(ceviri.MaxDepth <= SchemaTranslator.DepthLimit,
            $"{ad} derinliği {ceviri.MaxDepth}, sınır {SchemaTranslator.DepthLimit}");
    }

    /// <summary>default ATILIR ama KAYBOLMAZ: değeri açıklamada durmak zorundadır.</summary>
    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void atilan_default_degerleri_aciklamada_korunur(string ad)
    {
        var kaynak = Tool(ad)["input"]?["properties"] as JsonObject;
        if (kaynak is not { Count: > 0 }) return;

        var p = SchemaTranslator.Translate(Tool(ad)["input"], ad).Parameters!;

        foreach (var (alan, sema) in kaynak)
        {
            if (sema?["default"] is not { } varsayilan) continue;

            var metin = (p["properties"] as JsonObject)?[alan]?["description"]?.GetValue<string>() ?? "";
            var duz = varsayilan is JsonValue v && v.TryGetValue<string>(out var s)
                ? s
                : varsayilan.ToJsonString(Json.Options);

            Assert.Contains(duz, metin);
        }
    }

    [Theory]
    [MemberData(nameof(ToolAdlari))]
    public void cevrilmis_semada_default_anahtari_hic_kalmaz(string ad)
    {
        var p = SchemaTranslator.Translate(Tool(ad)["input"], ad).Parameters;
        if (p is null) return;

        Assert.DoesNotContain(Gez(p), a => a.Anahtar == "default");
    }

    [Fact]
    public void parametresiz_tool_parameters_alani_GONDERMEZ()
    {
        var (bildirim, ceviri) = SchemaTranslator.Declare(
            "xurrent_whoami", Tool("xurrent_whoami")["summary"]?.GetValue<string>(), Tool("xurrent_whoami")["input"]);

        Assert.Null(ceviri.Parameters);
        Assert.False(bildirim.ContainsKey("parameters"));
    }

    [Fact]
    public void parametreli_tool_bildiriminde_parameters_bulunur()
    {
        var (bildirim, _) = SchemaTranslator.Declare(
            "xurrent_create_time_entry", "özet", Tool("xurrent_create_time_entry")["input"]);

        Assert.True(bildirim.ContainsKey("parameters"));
        Assert.Equal("xurrent_create_time_entry", bildirim["name"]!.GetValue<string>());
    }

    // ── $ref / $defs yeniden yazımı ──────────────────────────────────────────

    private static JsonObject RefSemasi() => new()
    {
        ["type"] = "object",
        ["properties"] = new JsonObject
        {
            ["person"] = new JsonObject { ["$ref"] = "#/$defs/Person" },
            ["disari"] = new JsonObject { ["$ref"] = "https://ornek/sema.json#/Person" },
            ["derin"] = new JsonObject { ["$ref"] = "#/$defs/Person/properties/id" },
        },
        ["required"] = new JsonArray("person"),
        ["$defs"] = Sozlesme["$defs"]!.DeepClone(),
    };

    [Fact]
    public void dolar_ref_dolarsiz_ref_e_cevrilir()
    {
        var p = SchemaTranslator.Translate(RefSemasi(), "ref-testi").Parameters;

        Assert.Equal("#/defs/Person", p!["properties"]!["person"]!["ref"]!.GetValue<string>());
    }

    [Fact]
    public void dolar_defs_dolarsiz_defs_e_cevrilir_ve_hedef_dogrudan_cocuk_olur()
    {
        var p = SchemaTranslator.Translate(RefSemasi(), "ref-testi").Parameters;

        Assert.IsType<JsonObject>(p!["defs"]!["Person"]);
    }

    [Fact]
    public void dis_referans_atilir_cunku_Gemini_dis_semaya_baglanamaz()
    {
        var p = SchemaTranslator.Translate(RefSemasi(), "ref-testi").Parameters;

        Assert.Null(p!["properties"]!["disari"]?["ref"]);
    }

    [Fact]
    public void defs_in_dogrudan_cocugu_olmayan_derin_referans_atilir()
    {
        var p = SchemaTranslator.Translate(RefSemasi(), "ref-testi").Parameters;

        Assert.Null(p!["properties"]!["derin"]?["ref"]);
    }

    [Fact]
    public void kok_disindaki_defs_bloklari_atilir()
    {
        var sema = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject
            {
                ["ic"] = new JsonObject
                {
                    ["type"] = "object",
                    ["$defs"] = new JsonObject { ["X"] = new JsonObject { ["type"] = "string" } },
                    ["properties"] = new JsonObject { ["a"] = new JsonObject { ["type"] = "string" } },
                },
            },
        };

        var ceviri = SchemaTranslator.Translate(sema, "ic-defs-testi");

        Assert.Null(ceviri.Parameters!["properties"]!["ic"]!["defs"]);
        Assert.Contains(ceviri.Notes, n => n.Reason.Contains("defs yalnızca kökte olabilir"));
    }

    // ── Derinlik sınırı ──────────────────────────────────────────────────────

    [Fact]
    public void derinlik_sinirinin_otesindeki_dal_kesilir_ve_kayda_gecer()
    {
        JsonObject yaprak = new() { ["type"] = "string" };
        var mevcut = yaprak;
        for (var i = 0; i < 40; i++)
            mevcut = new JsonObject { ["type"] = "object", ["properties"] = new JsonObject { ["kat"] = mevcut } };

        var ceviri = SchemaTranslator.Translate(mevcut, "derinlik-testi");

        Assert.Contains(ceviri.Notes, n => n.Keyword == "(derinlik)");
        Assert.True(ceviri.MaxDepth <= SchemaTranslator.DepthLimit + 1);
    }

    // ── default → açıklama taşıması (dört dal) ───────────────────────────────

    private static string Aciklama(JsonObject? p, string alan)
        => p?["properties"]?[alan]?["description"]?.GetValue<string>() ?? "";

    private static JsonObject? VarsayilanSemasi()
        => SchemaTranslator.Translate(new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject
            {
                ["soyleyen"] = new JsonObject
                {
                    ["type"] = "string",
                    ["description"] = "Person node ID veya '$me'. Varsayılan '$me'.",
                    ["default"] = "$me",
                },
                ["susan"] = new JsonObject
                {
                    ["type"] = "string",
                    ["description"] = "Sayfalama cursor'ı.",
                    ["default"] = "bas",
                },
                // ★ TUZAK: açıklama "true" sözcüğünü içeriyor ama VARSAYILANI söylemiyor.
                ["tuzak"] = new JsonObject
                {
                    ["type"] = "boolean",
                    ["description"] = "true ise ilk hatada durur.",
                    ["default"] = true,
                },
                ["aciklamasiz"] = new JsonObject { ["type"] = "integer", ["default"] = 25 },
            },
        }, "default-testi").Parameters;

    [Fact]
    public void default_aciklama_zaten_soyluyorsa_cumle_TEKRAR_EKLENMEZ()
    {
        Assert.Equal("Person node ID veya '$me'. Varsayılan '$me'.", Aciklama(VarsayilanSemasi(), "soyleyen"));
    }

    [Fact]
    public void default_aciklama_susuyorsa_deger_EKLENIR()
    {
        Assert.Equal("Sayfalama cursor'ı. Varsayılan: \"bas\".", Aciklama(VarsayilanSemasi(), "susan"));
    }

    /// <summary>
    /// Düz "değer metinde geçiyor mu" kontrolü burada sessizce bilgi kaybettirirdi:
    /// "true ise ilk hatada durur" cümlesindeki true VARSAYILAN değil, anlam açıklamasıdır.
    /// </summary>
    [Fact]
    public void default_deger_metinde_var_ama_Varsayilan_sozcugu_yoksa_YINE_EKLENIR()
    {
        Assert.Equal("true ise ilk hatada durur. Varsayılan: true.", Aciklama(VarsayilanSemasi(), "tuzak"));
    }

    [Fact]
    public void default_aciklama_yoksa_tek_basina_uretilir()
    {
        Assert.Equal("Varsayılan: 25.", Aciklama(VarsayilanSemasi(), "aciklamasiz"));
    }

    // ── Tip birleşimleri ─────────────────────────────────────────────────────

    [Fact]
    public void birlesim_tipindeki_null_uyesi_nullable_bayragina_cevrilir()
    {
        var p = SchemaTranslator.Translate(new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject
            {
                ["alan"] = new JsonObject { ["type"] = new JsonArray("string", "null") },
            },
        }, "birlesim-testi").Parameters;

        Assert.Equal("string", p!["properties"]!["alan"]!["type"]!.GetValue<string>());
        Assert.True(p["properties"]!["alan"]!["nullable"]!.GetValue<bool>());
    }

    [Fact]
    public void desteklenmeyen_tip_atilir_ve_kayda_gecer()
    {
        var ceviri = SchemaTranslator.Translate(new JsonObject
        {
            ["type"] = "object",
            ["properties"] = new JsonObject { ["alan"] = new JsonObject { ["type"] = "null" } },
        }, "tip-testi");

        Assert.Contains(ceviri.Notes, n => n.Kind == SchemaNoteKind.Dropped);
    }

    // ── Özet raporu ──────────────────────────────────────────────────────────

    [Fact]
    public void Summarize_atilan_anahtarlari_sayarak_raporlar()
    {
        var notlar = Toollar.SelectMany(t =>
            SchemaTranslator.Translate(t!["input"], t["name"]!.GetValue<string>()).Notes).ToList();

        var satirlar = SchemaTranslator.Summarize(notlar, Toollar.Count);

        Assert.Contains(satirlar, s => s.Contains("8 tool"));
        Assert.Contains(satirlar, s => s.Contains("atılan"));
    }

    /// <summary>Sözleşmenin Gemini'ye taşınamayan anahtarları GERÇEKTEN vardır — çeviri boş iş değil.</summary>
    [Fact]
    public void sozlesmede_Gemini_ye_tasinamayan_anahtarlar_gercekten_bulunur()
    {
        var atilanlar = Toollar
            .SelectMany(t => SchemaTranslator.Translate(t!["input"], t["name"]!.GetValue<string>()).Dropped)
            .Select(n => n.Keyword)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        Assert.Contains("additionalProperties", atilanlar);
    }

    // ── Gezici (çevrilmiş şemadaki tüm anahtarlar) ───────────────────────────

    private sealed record Anahtarlar(string Yol, string Anahtar, JsonObject Sahip);

    private static IEnumerable<Anahtarlar> Gez(JsonNode node, string yol = "#")
    {
        switch (node)
        {
            case JsonObject o:
                foreach (var (anahtar, deger) in o)
                {
                    yield return new Anahtarlar(yol, anahtar, o);

                    // properties/defs altındaki adlar ŞEMA ANAHTARI DEĞİL, alan adıdır.
                    if (anahtar is "properties" or "defs" && deger is JsonObject torba)
                    {
                        foreach (var (cocukAd, cocuk) in torba)
                            if (cocuk is not null)
                                foreach (var g in Gez(cocuk, $"{yol}.{anahtar}.{cocukAd}"))
                                    yield return g;
                    }
                    else if (deger is JsonObject or JsonArray && anahtar is not "enum" and not "required")
                    {
                        foreach (var g in Gez(deger!, $"{yol}.{anahtar}")) yield return g;
                    }
                }
                break;

            case JsonArray a:
                var i = 0;
                foreach (var eleman in a)
                    if (eleman is not null)
                        foreach (var g in Gez(eleman, $"{yol}[{i++}]"))
                            yield return g;
                break;
        }
    }
}
