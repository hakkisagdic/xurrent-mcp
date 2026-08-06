using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Core;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ Güvenilirlik katmanı (contract/reliability.md): retry sınıflandırması, tam jitter
/// + Retry-After alt sınırı, iz biçimi, guarded_create geri-okuması ve yazma öncesi dedup.
///
/// İki cephe:
///   1) LiveAdapter — SAHTE HttpMessageHandler ile: ağ yok, yanıtlar betikli. Retry'ın
///      "kaç HTTP isteği çıktı" sorusu ancak bu seviyede ölçülebilir.
///   2) MockAdapter — yazma öncesi dedup TOOL katmanında yaşar, dolayısıyla mock'ta da
///      birebir çalışmak ZORUNDA. Ders tezi: tool katmanı adapter'ını bilmez.
///
/// İzler ReliabilityTrace.CaptureForTest ile toplanır (AsyncLocal): süreç stderr'ine
/// dokunmadan, paralel test sınıflarıyla çakışmadan.
/// </summary>
public class GuvenilirlikTests
{
    // ── Yardımcılar ──────────────────────────────────────────────────────────

    /// <summary>
    /// Live yapılandırma: bekleme tabanı 1 ms — testler backoff MATEMATİĞİNİ ayrı
    /// (ComputeWait) test eder, entegrasyon testleri gerçek saniyeler beklememeli.
    /// Gaz kapalı (MinRequestGapMs=0): burada ölçülen şey gaz değil, retry.
    /// </summary>
    private static AppConfig Canli(int denemeler = 5) => new()
    {
        RepoRoot = Ortam.RepoKoku,
        FixturesDir = Ortam.FixtureDizini,
        XurrentMode = "live",
        XurrentToken = "test-token",
        XurrentAccount = "ornek-bt",
        XurrentGraphqlUrl = "http://127.0.0.1:9",
        XurrentConfirmPolicy = "open",
        TimeZoneId = Ortam.SaatDilimiId,
        Clock = new SabitSaat(Ortam.VarsayilanAn),
        RetryMaxAttempts = denemeler,
        RetryBaseMs = 1,
        RetryCapMs = 4,
        MinRequestGapMs = 0,
    };

    /// <summary>Betikli HTTP: gövdeye bakıp yanıt seçer; hiçbir gerçek bağlantı açılmaz.</summary>
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

    private static HttpResponseMessage Http429(int? retryAfterSaniye = null)
    {
        var res = new HttpResponseMessage((HttpStatusCode)429)
        {
            Content = new StringContent("""{"errors":[{"message":"rate limit"}]}""", Encoding.UTF8, "application/json"),
        };
        if (retryAfterSaniye is { } s) res.Headers.Add("Retry-After", s.ToString());
        return res;
    }

    private static HttpResponseMessage Http500() => new(HttpStatusCode.InternalServerError)
    {
        Content = new StringContent("""{"errors":[{"message":"kaos"}]}""", Encoding.UTF8, "application/json"),
    };

    // Betikli yanıt gövdeleri. me/JustCreated: parent update başarısı bu iki takip
    // sorgusunu tetikler (payload TimeEntry döndürmez → adapter geri okur).
    private const string MeYaniti = """
        {"data":{"me":{"id":"TW9jay9QZXJzb24vMQ","name":"Test","primaryEmail":null,"jobTitle":null,
        "timeZone":null,"disabled":false,"organization":null},
        "account":{"id":"ornek-bt","name":null,"directory":null}}}
        """;
    private const string BosTimeEntries = """{"data":{"timeEntries":{"nodes":[]}}}""";
    private const string RequestUpdateOk = """
        {"data":{"requestUpdate":{"clientMutationId":null,"errors":[],"request":{"id":"R1"}}}}
        """;
    private const string TimeEntryUpdateOk = """
        {"data":{"timeEntryUpdate":{"clientMutationId":null,"errors":[],
        "timeEntry":{"id":"TE1","date":"2026-08-03","timeSpent":60,"person":{"id":"P1","name":"A"}}}}}
        """;
    private const string CreateOk = """
        {"data":{"timeEntryCreate":{"clientMutationId":null,"errors":[],
        "timeEntry":{"id":"TE-YENI","date":"2026-08-03","startedAt":null,"timeSpent":30,
        "description":"t","person":{"id":"P1","name":"A"}}}}}
        """;

    // NOT: $$""" ile yazılamaz — JSON'un ardışık kapanış küme ayraçları ({{ }} sözdizimiyle çakışır).
    private static string SourceIdHit(string sid) =>
        """{"data":{"timeEntries":{"nodes":[{"id":"TE-MEVCUT","date":"2026-08-03","timeSpent":30,"sourceID":"__SID__"}]}}}"""
            .Replace("__SID__", sid);

    private static PlannedMutation ParentAdim() => new(0, "requestUpdate", Queries.RequestUpdate,
        new JsonObject { ["input"] = new JsonObject { ["id"] = "R1", ["timeSpent"] = 30 } }, [], null);

    private static PlannedMutation UpdateAdim() => new(0, "timeEntryUpdate", Queries.TimeEntryUpdate,
        new JsonObject { ["input"] = new JsonObject { ["id"] = "TE1", ["timeSpent"] = 60 } }, [], null);

    private static PlannedMutation CreateAdim(string sid) => new(0, "timeEntryCreate", Queries.TimeEntryCreate,
        new JsonObject { ["input"] = new JsonObject { ["timeSpent"] = 30, ["sourceID"] = sid } }, [], null);

    // ── Sınıflandırma: 429 HER operasyonda tekrarlanır ───────────────────────

    /// <summary>
    /// 429 "kesin-işlenmedi"dir: rate limiter isteği İŞLEMEDEN reddetti. no_retry
    /// sınıfındaki parent update bile güvenle tekrarlanır — çift sayım imkânsızdır.
    /// </summary>
    [Fact]
    public async Task parent_update_429da_tekrarlanir_cunku_istek_islenmeden_reddedildi()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var parentDenemesi = 0;
        var handler = new SahteYanitlar(govde =>
            govde.Contains("requestUpdate")
                ? (Interlocked.Increment(ref parentDenemesi) == 1 ? Http429() : Json200(RequestUpdateOk))
                : govde.Contains("query Me") ? Json200(MeYaniti)
                : Json200(BosTimeEntries));

        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        var sonuc = await adapter.ExecuteAsync(ParentAdim(), CancellationToken.None);

        Assert.True(sonuc.Ok);
        Assert.Equal(2, parentDenemesi);
        Assert.Single(izler, l => l.StartsWith("[retry]") && l.Contains("op=requestUpdate") && l.Contains("reason=429"));
    }

    /// <summary>
    /// ★ Politikanın kalbi: parent update'te timeSpent ARTIMLIDIR ve idempotency
    /// anahtarı yoktur → belirsiz hatada (5xx) tekrar = olası ÇİFT SAYIM. Tek deneme
    /// yapılır, hata "yazılmış olabilir, ticket'ı kontrol edin" diyerek raporlanır.
    /// </summary>
    [Fact]
    public async Task parent_update_5xxte_ASLA_tekrarlanmaz_ve_belirsizlik_kullaniciya_soylenir()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var handler = new SahteYanitlar(_ => Http500());
        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        var sonuc = await adapter.ExecuteAsync(ParentAdim(), CancellationToken.None);

        Assert.False(sonuc.Ok);
        Assert.Single(handler.Govdeler);                       // TEK istek — retry yok
        Assert.DoesNotContain(izler, l => l.StartsWith("[retry]"));
        // Hata dürüst olmak zorunda: yazma İŞLENMİŞ olabilir + ticket kontrol önerisi.
        Assert.Contains("İŞLENMİŞ OLABİLİR", sonuc.Errors[0].Message);
        Assert.Contains("ticket", sonuc.Errors[0].Message, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>timeEntryUpdate mutlak SET'tir (idempotent_update) → 5xx'te tekrar serbest.</summary>
    [Fact]
    public async Task timeEntryUpdate_5xxte_tekrarlanir_cunku_mutlak_settir()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var deneme = 0;
        var handler = new SahteYanitlar(_ =>
            Interlocked.Increment(ref deneme) == 1 ? Http500() : Json200(TimeEntryUpdateOk));

        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        var sonuc = await adapter.ExecuteAsync(UpdateAdim(), CancellationToken.None);

        Assert.True(sonuc.Ok);
        Assert.Equal(2, deneme);
        Assert.Single(izler, l => l.Contains("op=timeEntryUpdate") && l.Contains("reason=5xx"));
    }

    /// <summary>Ağ hatası da "belirsiz"dir ama query yan etkisiz → tekrar; reason=network.</summary>
    [Fact]
    public async Task query_ag_hatasinda_tekrarlanir_reason_network()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var deneme = 0;
        var handler = new SahteYanitlar(_ =>
            Interlocked.Increment(ref deneme) == 1
                ? throw new HttpRequestException("bağlantı koptu")
                : Json200(MeYaniti));

        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        var sonuc = await adapter.WhoAmIAsync(CancellationToken.None);

        Assert.Equal("TW9jay9QZXJzb24vMQ", sonuc.Person.Id);
        Assert.Single(izler, l => l.Contains("reason=network"));
    }

    // ── Retry kapatma ve bekleme matematiği ──────────────────────────────────

    /// <summary>XURRENT_RETRY_MAX_ATTEMPTS=1 → toplam 1 deneme, retry tamamen kapalı.</summary>
    [Fact]
    public async Task attempts_1_retryyi_tamamen_kapatir()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var handler = new SahteYanitlar(_ => Http429());
        using var adapter = new LiveAdapter(Canli(denemeler: 1), new HttpClient(handler));

        await Assert.ThrowsAsync<XurrentHttpException>(() => adapter.WhoAmIAsync(CancellationToken.None));
        Assert.Single(handler.Govdeler);
        Assert.Empty(izler);
    }

    /// <summary>
    /// Tam jitter: bekleme [0, min(CAP, BASE·2^(k-1))) aralığındadır; Retry-After
    /// varsa bekleme EN AZ o kadardır (max(jitter, retryAfter)) — reliability.md §3.
    /// Rastgelelik yüzünden tek örnek yetmez; sınırlar çok örneklemle doğrulanır.
    /// </summary>
    [Fact]
    public void bekleme_tam_jitter_araligindadir_ve_retry_after_alt_sinirdir()
    {
        for (var i = 0; i < 200; i++)
        {
            // k=1, tavan = min(8000, 500·2^0) = 500 ms.
            var jitter = RetryPolicy.ComputeWait(1, null, 500, 8000);
            Assert.InRange(jitter.TotalMilliseconds, 0, 500);

            // k=10: üstel tavan CAP'e çarpar — asla 8000 ms'i aşamaz.
            var tavanli = RetryPolicy.ComputeWait(10, null, 500, 8000);
            Assert.InRange(tavanli.TotalMilliseconds, 0, 8000);

            // Retry-After=2 sn: jitter ne derse desin bekleme ≥ 2000 ms.
            var altSinirli = RetryPolicy.ComputeWait(1, TimeSpan.FromSeconds(2), 500, 8000);
            Assert.True(altSinirli >= TimeSpan.FromSeconds(2),
                $"Retry-After alt sınırı delindi: {altSinirli.TotalMilliseconds} ms");
        }
    }

    /// <summary>İz biçimi senaryo koşucusuyla SÖZLEŞMEDİR — karakteri karakterine doğrulanır.</summary>
    [Fact]
    public async Task retry_izi_bicimi_sozlesmeyle_birebir_aynidir()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var deneme = 0;
        var handler = new SahteYanitlar(_ =>
            Interlocked.Increment(ref deneme) == 1 ? Http429() : Json200(MeYaniti));

        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        await adapter.WhoAmIAsync(CancellationToken.None);

        var iz = Assert.Single(izler);
        Assert.Matches(@"^\[retry\] op=query attempt=1/5 reason=429 waitMs=\d+$", iz);
    }

    // ── guarded_create: belirsiz hatada önce geri-okuma ──────────────────────

    /// <summary>
    /// timeEntryCreate 5xx ile düştü ama istek aslında İŞLENMİŞTİ. Kör retry çift
    /// kayıt yazardı; politika önce sourceID geri-okuması yapar: kayıt VARSA yazma
    /// tekrarlanmaz, mevcut kayıt BAŞARI olarak döner ve [dedup] hit=true izi kalır.
    /// </summary>
    [Fact]
    public async Task guarded_create_belirsiz_hatada_geri_okur_hit_ise_mevcut_kaydi_dondurur()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var createDenemesi = 0;
        var handler = new SahteYanitlar(govde =>
            govde.Contains("timeEntryCreate")
                ? (Interlocked.Increment(ref createDenemesi), Http500()).Item2
                : Json200(SourceIdHit("xmcp-hit1")));

        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        var sonuc = await adapter.ExecuteAsync(CreateAdim("xmcp-hit1"), CancellationToken.None);

        Assert.True(sonuc.Ok);
        Assert.Equal("TE-MEVCUT", sonuc.TimeEntry!["id"]!.GetValue<string>());
        Assert.Equal(1, createDenemesi);                       // create TEKRARLANMADI
        Assert.Contains("[dedup] op=timeEntryCreate sourceID=xmcp-hit1 hit=true", izler);
        Assert.DoesNotContain(izler, l => l.StartsWith("[retry]"));
    }

    /// <summary>Geri-okuma miss ise yazılmamıştır → retry serbest; iz sırası dedup → retry.</summary>
    [Fact]
    public async Task guarded_create_geri_okuma_miss_ise_tekrar_dener_ve_basarir()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var createDenemesi = 0;
        var handler = new SahteYanitlar(govde =>
            govde.Contains("timeEntryCreate")
                ? (Interlocked.Increment(ref createDenemesi) == 1 ? Http500() : Json200(CreateOk))
                : Json200(BosTimeEntries));

        using var adapter = new LiveAdapter(Canli(), new HttpClient(handler));
        var sonuc = await adapter.ExecuteAsync(CreateAdim("xmcp-miss1"), CancellationToken.None);

        Assert.True(sonuc.Ok);
        Assert.Equal("TE-YENI", sonuc.TimeEntry!["id"]!.GetValue<string>());
        Assert.Equal(2, createDenemesi);
        Assert.Contains("[dedup] op=timeEntryCreate sourceID=xmcp-miss1 hit=false", izler);
        var retryIzi = Assert.Single(izler, l => l.StartsWith("[retry]"));
        Assert.Matches(@"^\[retry\] op=timeEntryCreate attempt=1/5 reason=5xx waitMs=\d+$", retryIzi);
    }

    // ── Yazma öncesi dedup — MOCK adapter ile (tool katmanının özelliği) ─────

    private static TimeEntryRequest YolAIstek(string aciklama, int dakika = 30) => new()
    {
        TargetType = "time_allocation",
        TargetId = Ortam.Allocation1,
        Minutes = dakika,
        Description = aciklama,
    };

    /// <summary>
    /// Aynı girdi aynı deterministik sourceID'yi üretir → ikinci yazma ATLANIR,
    /// deduped=true + mevcut kayıt + Türkçe uyarı döner. Mock'ta çalışması önemli:
    /// dedup tool katmanının davranışıdır, adapter detayı değil.
    /// </summary>
    [Fact]
    public async Task ayni_girdiyle_ikinci_yazma_atlanir_deduped_true_ve_ayni_kayit_doner()
    {
        var cfg = Ortam.Yapilandirma(confirmPolicy: "open");
        var adapter = new MockAdapter(cfg);
        var istek = YolAIstek("dedup tek kayıt testi");

        var ilk = await Strategies.RunAsync(cfg, adapter, istek, dryRun: false, CancellationToken.None);
        Assert.Empty(ilk.Errors);
        Assert.NotEqual(true, ilk.Deduped);

        var ikinci = await Strategies.RunAsync(cfg, adapter, istek, dryRun: false, CancellationToken.None);
        Assert.Empty(ikinci.Errors);
        Assert.True(ikinci.Deduped);
        Assert.Equal(ilk.TimeEntry!["id"]!.GetValue<string>(), ikinci.TimeEntry!["id"]!.GetValue<string>());
        Assert.Contains(ikinci.Warnings, w => w.Contains("dedup"));
    }

    /// <summary>two_step'in 1. adımı parent update'tir → dedup YOK. Asimetri dersin kendisi.</summary>
    [Fact]
    public async Task two_step_tekrarinda_dedup_YOKTUR_yol_b_korumasi_retry_yasagidir()
    {
        var cfg = Ortam.Yapilandirma(confirmPolicy: "open", backdateStrategy: "two_step");
        var adapter = new MockAdapter(cfg);
        var istek = new TimeEntryRequest
        {
            TargetType = "request",
            TargetId = Ortam.Request70248,
            Minutes = 30,
            Description = "yol b tekrar",
        };

        var ilk = await Strategies.RunAsync(cfg, adapter, istek, dryRun: false, CancellationToken.None);
        var ikinci = await Strategies.RunAsync(cfg, adapter, istek, dryRun: false, CancellationToken.None);

        Assert.Empty(ilk.Errors);
        Assert.Empty(ikinci.Errors);
        // İkisi de YAZDI: Yol B'de idempotency anahtarı taşınamaz, dedup imkânsızdır.
        Assert.NotEqual(true, ikinci.Deduped);
        Assert.NotEqual(ilk.TimeEntry!["id"]!.GetValue<string>(), ikinci.TimeEntry!["id"]!.GetValue<string>());
    }

    /// <summary>
    /// Bulk kurtarma güvencesi (reliability.md §5): aynı komutun tekrarı yazılmışları
    /// "deduped" sayar, summary.deduped sayacı tutar, çift kayıt OLUŞMAZ.
    /// </summary>
    [Fact]
    public async Task bulk_tekrari_yazilmislari_deduped_sayar_cift_kayit_olusmaz()
    {
        var cfg = Ortam.Yapilandirma(confirmPolicy: "open");
        var adapter = new MockAdapter(cfg);
        TimeEntryRequest[] kalemler =
            [YolAIstek("bulk kalem 1"), YolAIstek("bulk kalem 2"), YolAIstek("bulk kalem 3")];

        var ilk = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, adapter, kalemler, dryRun: false, stopOnError: false, approved: true, CancellationToken.None);
        Assert.Equal(3, ilk.Value!.Summary.Created);
        Assert.Equal(0, ilk.Value.Summary.Deduped);

        var ikinci = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, adapter, kalemler, dryRun: false, stopOnError: false, approved: true, CancellationToken.None);

        Assert.Equal(0, ikinci.Value!.Summary.Created);
        Assert.Equal(0, ikinci.Value.Summary.Failed);
        Assert.Equal(3, ikinci.Value.Summary.Deduped);
        Assert.All(ikinci.Value.Results, satir => Assert.Equal("deduped", satir.Status));
        // deduped satırlar mevcut kaydın id'sini gösterir — kullanıcı neyin var olduğunu görür.
        Assert.All(ikinci.Value.Results, satir => Assert.NotNull(satir.TimeEntryId));
    }
}
