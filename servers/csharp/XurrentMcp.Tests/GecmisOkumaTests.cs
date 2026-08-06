using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Core;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ xurrent_list_time_entries — geri-okuma gözü (contract/tools.json #9).
///
/// İki cephe:
///   1) MockAdapter — filtre semantiği (personId / dateFrom / dateTo / sourceId,
///      aralık DAHİL) ve totalMinutes fixture'lara karşı ölçülür.
///   2) LiveAdapter — SAHTE HttpMessageHandler ile TEK timeEntries sorgusunun
///      wire şekli doğrulanır: değişken adları sözleşme gereği SABİTTİR
///      (personId / dateFrom / dateTo / sourceID — sahte sunucu bu adlarla eşleşir).
///
/// Sabit saat: 3 Ağustos 2026. Fixture dayOffset'leri buna göre materyalize olur:
///   -1 → 2026-08-02 (30 + 45 dk), -2 → 2026-08-01 (30 dk), -3 → 2026-07-31 (60 dk),
///   -5 → 2026-07-29 (240 dk). Beşi de me (TW9jay9QZXJzb24vMQ) üzerinedir.
/// </summary>
public class GecmisOkumaTests
{
    private static (AppConfig Cfg, MockAdapter Adapter) Kur()
    {
        var cfg = Ortam.Yapilandirma();
        return (cfg, new MockAdapter(cfg));
    }

    private static Task<TimeEntryPage> Listele(
        MockAdapter adapter, string personId = "$me", string? dateFrom = null,
        string? dateTo = null, string? sourceId = null, int first = 25)
        => ToolImpl.ListTimeEntriesAsync(adapter, personId, dateFrom, dateTo, sourceId, first, CancellationToken.None);

    // ── Mock filtreleri ──────────────────────────────────────────────────────

    [Fact]
    public async Task filtresiz_sorgu_kisinin_tum_kayitlarini_ve_toplam_dakikayi_doner()
    {
        var (_, adapter) = Kur();
        var sayfa = await Listele(adapter);

        Assert.Equal(5, sayfa.TimeEntries.Count);
        Assert.Equal(60 + 30 + 45 + 30 + 240, sayfa.TotalMinutes);
        Assert.False(string.IsNullOrEmpty(sayfa.AccountId));
    }

    [Fact]
    public async Task personId_filtresi_baskasinin_kayitlarini_GETIRMEZ()
    {
        var (_, adapter) = Kur();
        var sayfa = await Listele(adapter, personId: Ortam.BaskasiId);

        // Fixture'daki 5 kayıt da me'ye ait; başka kişi için sonuç BOŞTUR — ve bu da bir cevaptır.
        Assert.Empty(sayfa.TimeEntries);
        Assert.Equal(0, sayfa.TotalMinutes);
    }

    [Fact]
    public async Task tarih_araligi_DAHILDIR_dun_icin_iki_kayit_75_dakika()
    {
        var (cfg, adapter) = Kur();
        var dun = Ortam.GunMetin(cfg, -1);
        var sayfa = await Listele(adapter, dateFrom: dun, dateTo: dun);

        Assert.Equal(2, sayfa.TimeEntries.Count);
        Assert.Equal(75, sayfa.TotalMinutes);
        Assert.All(sayfa.TimeEntries, e => Assert.Equal(dun, e.Date));
    }

    [Fact]
    public async Task dateFrom_tek_basina_alt_siniri_uygular()
    {
        var (cfg, adapter) = Kur();
        var sayfa = await Listele(adapter, dateFrom: Ortam.GunMetin(cfg, -2));

        // -1 (30+45) ve -2 (30) kalır; -3 ve -5 elenir.
        Assert.Equal(3, sayfa.TimeEntries.Count);
        Assert.Equal(105, sayfa.TotalMinutes);
    }

    [Fact]
    public async Task dateTo_tek_basina_ust_siniri_uygular()
    {
        var (cfg, adapter) = Kur();
        var sayfa = await Listele(adapter, dateTo: Ortam.GunMetin(cfg, -3));

        // -3 (60) ve -5 (240) kalır.
        Assert.Equal(2, sayfa.TimeEntries.Count);
        Assert.Equal(300, sayfa.TotalMinutes);
    }

    [Fact]
    public async Task first_sayfa_boyutunu_keser_ve_totalMinutes_donen_kayitlari_sayar()
    {
        var (_, adapter) = Kur();
        var sayfa = await Listele(adapter, first: 2);

        Assert.Equal(2, sayfa.TimeEntries.Count);
        Assert.Equal(sayfa.TimeEntries.Sum(e => e.TimeSpent), sayfa.TotalMinutes);
    }

    [Fact]
    public async Task assignment_ve_effortClass_alanlari_coz_lur_yol_B_kaydinda_ticket_gorunur()
    {
        var (cfg, adapter) = Kur();
        var dun = Ortam.GunMetin(cfg, -1);
        var sayfa = await Listele(adapter, dateFrom: dun, dateTo: dun);

        var request = sayfa.TimeEntries.Single(e => e.Assignment?.Type == "Request");
        Assert.Equal("70248", request.Assignment!.DisplayId);
        Assert.NotNull(request.Person);
        Assert.Equal(Ortam.BenId, request.Person!.Id);
        Assert.NotNull(request.EffortClass);
        Assert.False(string.IsNullOrEmpty(request.EffortClass!.Name));

        var task = sayfa.TimeEntries.Single(e => e.Assignment?.Type == "Task");
        Assert.Equal("4412", task.Assignment!.DisplayId);
    }

    /// <summary>
    /// Dedup geri-okumasının ta kendisi: Yol A yazması deterministik sourceID taşır;
    /// sourceId filtresi o kaydı NOKTA atışıyla bulur — ve Yol A kaydında assignment NULL'dur.
    /// </summary>
    [Fact]
    public async Task sourceId_filtresi_yazilan_kaydi_nokta_atisiyla_bulur()
    {
        var (cfg, adapter) = Kur();

        var yazma = await Strategies.RunAsync(cfg, adapter, new TimeEntryRequest
        {
            TargetType = "time_allocation",
            TargetId = Ortam.Allocation1,
            Minutes = 30,
            Description = "geri-okuma testi",
            BackdateStrategy = "date_first",
        }, dryRun: false, CancellationToken.None);

        Assert.Empty(yazma.Errors);
        var sourceId = yazma.Planned[0].Input["input"]!["sourceID"]!.GetValue<string>();

        var sayfa = await Listele(adapter, sourceId: sourceId);

        var kayit = Assert.Single(sayfa.TimeEntries);
        Assert.Equal(sourceId, kayit.SourceId);
        Assert.Equal("xurrent-mcp", kayit.Source);
        Assert.Equal(30, sayfa.TotalMinutes);
        Assert.Null(kayit.Assignment);   // Yol A: ticket'a BAĞLANMAZ
    }

    [Fact]
    public async Task eslesmeyen_sourceId_bos_sayfa_doner()
    {
        var (_, adapter) = Kur();
        var sayfa = await Listele(adapter, sourceId: "xmcp-hicyok");

        Assert.Empty(sayfa.TimeEntries);
        Assert.Equal(0, sayfa.TotalMinutes);
    }

    // ── Live: wire şekli (değişken adları sözleşmeyle sabit) ─────────────────

    private sealed class SahteYanitlar(Func<string, HttpResponseMessage> yanitla) : HttpMessageHandler
    {
        public readonly List<string> Govdeler = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken ct)
        {
            var govde = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            lock (Govdeler) Govdeler.Add(govde);
            return yanitla(govde);
        }
    }

    private static HttpResponseMessage Json200(string json) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json"),
    };

    private static AppConfig Canli() => new()
    {
        RepoRoot = Ortam.RepoKoku,
        FixturesDir = Ortam.FixtureDizini,
        XurrentMode = "live",
        XurrentToken = "test-token",
        XurrentAccount = "ornek-bt",
        XurrentGraphqlUrl = "http://127.0.0.1:9",
        TimeZoneId = Ortam.SaatDilimiId,
        Clock = new SabitSaat(Ortam.VarsayilanAn),
        RetryBaseMs = 1,
        RetryCapMs = 4,
        MinRequestGapMs = 0,
    };

    private const string MeYaniti = """
        {"data":{"me":{"id":"TW9jay9QZXJzb24vMQ","name":"Test","primaryEmail":null,"jobTitle":null,
        "timeZone":null,"disabled":false,"organization":null},
        "account":{"id":"ornek-bt","name":null,"directory":null}}}
        """;

    private const string TimeEntriesYaniti = """
        {"data":{"timeEntries":{"nodes":[
          {"id":"TE1","date":"2026-08-02","startedAt":null,"timeSpent":30,"description":"a",
           "correction":false,"source":"web","sourceID":null,
           "person":{"id":"TW9jay9QZXJzb24vMQ","name":"Test"},
           "effortClass":{"id":"EC1","name":"Normal"},
           "assignment":{"__typename":"Request","id":"R1","requestId":"70248"}},
          {"id":"TE2","date":"2026-08-02","startedAt":null,"timeSpent":45,"description":"b",
           "correction":false,"source":"xurrent-mcp","sourceID":"xmcp-abc","person":null,
           "effortClass":null,"assignment":null}
        ]}}}
        """;

    [Fact]
    public async Task live_TEK_sorgu_gonderir_ve_degisken_adlari_sozlesmeyle_ayni_dir()
    {
        var handler = new SahteYanitlar(govde =>
            govde.Contains("query Me") ? Json200(MeYaniti) : Json200(TimeEntriesYaniti));

        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        var sayfa = await adapter.ListTimeEntriesAsync(
            new ListTimeEntriesArgs("$me", "2026-08-01", "2026-08-02", "xmcp-abc", 25), CancellationToken.None);

        var govdeler = handler.Govdeler.Where(g => g.Contains("ListTimeEntries")).ToList();
        var govde = Assert.Single(govdeler);   // TEK timeEntries sorgusu

        var istek = JsonNode.Parse(govde)!.AsObject();
        var degiskenler = istek["variables"]!.AsObject();

        // ★ Değişken adları SABİT: personId / dateFrom / dateTo / sourceID.
        // Sahte Xurrent filtreyi tam bu adlardan okur; ad kayarsa filtre sessizce yiter.
        Assert.Equal("TW9jay9QZXJzb24vMQ", degiskenler["personId"]!.GetValue<string>());
        Assert.Equal("2026-08-01", degiskenler["dateFrom"]!.GetValue<string>());
        Assert.Equal("2026-08-02", degiskenler["dateTo"]!.GetValue<string>());
        Assert.Equal("xmcp-abc", degiskenler["sourceID"]!.GetValue<string>());

        var sorgu = istek["query"]!.GetValue<string>();
        Assert.Contains("$dateFrom", sorgu);
        Assert.Contains("$dateTo", sorgu);
        Assert.Contains("$sourceID", sorgu);

        // Yanıt eşlemesi: assignment __typename → type, requestId → displayId.
        Assert.Equal(2, sayfa.TimeEntries.Count);
        Assert.Equal(75, sayfa.TotalMinutes);
        Assert.Equal("Request", sayfa.TimeEntries[0].Assignment!.Type);
        Assert.Equal("70248", sayfa.TimeEntries[0].Assignment!.DisplayId);
        Assert.Null(sayfa.TimeEntries[1].Assignment);
        Assert.Equal("xmcp-abc", sayfa.TimeEntries[1].SourceId);
    }

    [Fact]
    public async Task live_verilmeyen_filtreler_ne_degiskenlerde_ne_sorguda_yer_alir()
    {
        var handler = new SahteYanitlar(govde =>
            govde.Contains("query Me") ? Json200(MeYaniti) : Json200("""{"data":{"timeEntries":{"nodes":[]}}}"""));

        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        await adapter.ListTimeEntriesAsync(
            new ListTimeEntriesArgs("$me", null, null, null, 25), CancellationToken.None);

        var govde = Assert.Single(handler.Govdeler, g => g.Contains("ListTimeEntries"));
        var istek = JsonNode.Parse(govde)!.AsObject();
        var degiskenler = istek["variables"]!.AsObject();

        Assert.False(degiskenler.ContainsKey("dateFrom"));
        Assert.False(degiskenler.ContainsKey("dateTo"));
        Assert.False(degiskenler.ContainsKey("sourceID"));

        // values: [null] tuzağı — filtre parçası sorgu METNİNDE de bulunmamalı.
        // (sourceID bir SEÇİM alanı olarak node gövdesinde her zaman durur; burada
        //  denetlenen şey FİLTRE ve DEĞİŞKEN bildirimidir.)
        var sorgu = istek["query"]!.GetValue<string>();
        Assert.DoesNotContain("$sourceID", sorgu);
        Assert.DoesNotContain("sourceID: {", sorgu);
        Assert.DoesNotContain("$dateFrom", sorgu);
        Assert.DoesNotContain("date: {", sorgu);
    }
}
