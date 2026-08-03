using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ Üç backdate stratejisinin PLAN çıktısı.
///
/// Bu sınıfın tamamı Xurrent'a bir şey göndermeden çalışır: Strategies.RunAsync
/// dry-run modunda "gidecek olan" mutation'ları üretir, iddialar tam olarak onu okur.
/// Ders anlatımının iddiaları (özellikle "2. adım ticket bağını bozamaz") burada
/// metin olarak değil, ŞEMA olarak doğrulanır.
/// </summary>
public class StratejiTests
{
    private static MockAdapter Adapter(AppConfig cfg) => new(cfg);

    private static TimeEntryRequest Istek(
        string targetType = "request",
        string targetId = Ortam.Request70248,
        int dakika = 60,
        string? tarih = null,
        string? baslangic = null,
        string? kisi = null,
        string? aciklama = null,
        string? strateji = null)
        => new()
        {
            TargetType = targetType,
            TargetId = targetId,
            Minutes = dakika,
            Date = tarih,
            StartedAt = baslangic,
            PersonId = kisi,
            Description = aciklama,
            BackdateStrategy = strateji,
        };

    private static JsonObject Girdi(PlannedMutation m) => m.Input["input"]!.AsObject();

    // ── two_step ─────────────────────────────────────────────────────────────

    [Fact]
    public async Task two_step_tam_olarak_iki_mutation_planlar_once_parent_update_sonra_timeEntryUpdate()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(tarih: Ortam.GunMetin(cfg, -1)), dryRun: true, CancellationToken.None);

        Assert.Empty(sonuc.Errors);
        Assert.Equal(2, sonuc.Planned.Count);
        Assert.Equal("requestUpdate", sonuc.Planned[0].Path);
        Assert.Equal("timeEntryUpdate", sonuc.Planned[1].Path);
    }

    [Fact]
    public async Task two_step_adimlari_1_2_ve_2_2_olarak_etiketler()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(tarih: Ortam.GunMetin(cfg, -1)), dryRun: true, CancellationToken.None);

        Assert.Equal("1/2", sonuc.Planned[0].StepLabel);
        Assert.Equal("2/2", sonuc.Planned[1].StepLabel);
        Assert.Equal(0, sonuc.Planned[0].Index);
        Assert.Equal(1, sonuc.Planned[1].Index);
    }

    /// <summary>
    /// ★ two_step stratejisinin TÜM DAYANAĞI: TimeEntryUpdateInput'ta assignment alanı
    /// YOKTUR, dolayısıyla 2. adım ticket bağını bozamaz. Bu iddia yorum satırında
    /// kalmamalı — plan çıktısında hiçbir bağ alanı bulunmadığı DOĞRULANIR.
    /// </summary>
    [Fact]
    public async Task two_step_ikinci_adimda_assignment_alani_GONDERMEZ()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(tarih: Ortam.GunMetin(cfg, -1)), dryRun: true, CancellationToken.None);

        var ikinci = Girdi(sonuc.Planned[1]);
        foreach (var yasakli in new[] { "assignment", "assignmentId", "requestId", "taskId", "projectTaskId", "problemId" })
            Assert.False(ikinci.ContainsKey(yasakli), $"2. adımda '{yasakli}' alanı bulundu — ticket bağı bozulabilirdi.");
    }

    [Fact]
    public async Task two_step_ikinci_adim_tarihi_ve_kisiyi_duzeltir()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var dun = Ortam.GunMetin(cfg, -1);

        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(tarih: dun, baslangic: $"{dun}T14:00:00+03:00"),
            dryRun: true, CancellationToken.None);

        var ikinci = Girdi(sonuc.Planned[1]);
        Assert.Equal(dun, ikinci["date"]!.GetValue<string>());
        Assert.Equal(Ortam.BenId, ikinci["personId"]!.GetValue<string>());
        Assert.Equal($"{dun}T14:00:00+03:00", ikinci["startedAt"]!.GetValue<string>());
        Assert.Equal(Strategies.PreviousEntryIdPlaceholder, ikinci["id"]!.GetValue<string>());
    }

    [Fact]
    public async Task two_step_ilk_adim_timeSpent_i_ARTIMLI_olarak_gonderir_ve_bunu_uyariya_yazar()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(dakika: 90), dryRun: true, CancellationToken.None);

        var ilk = Girdi(sonuc.Planned[0]);
        Assert.Equal(Ortam.Request70248, ilk["id"]!.GetValue<string>());
        Assert.Equal(90, ilk["timeSpent"]!.GetValue<int>());
        Assert.Contains(sonuc.Planned[0].Warnings, u => u.Contains("ARTIMLIDIR"));
    }

    [Fact]
    public async Task two_step_atomik_olmadigini_UYARI_olarak_soyler()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: true, CancellationToken.None);

        Assert.Contains(sonuc.Warnings, u => u.Contains("ATOMİK DEĞİLDİR"));
    }

    [Theory]
    [InlineData("request", Ortam.Request70248, "requestUpdate")]
    [InlineData("task", Ortam.Task4412, "taskUpdate")]
    [InlineData("project_task", "TW9jay9Qcm9qZWN0VGFzay8x", "projectTaskUpdate")]
    [InlineData("problem", "TW9jay9Qcm9ibGVtLzE", "problemUpdate")]
    public async Task two_step_her_ticket_hedefi_icin_dogru_parent_mutation_u_secer(
        string hedefTipi, string hedefId, string beklenenMutation)
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(hedefTipi, hedefId), dryRun: true, CancellationToken.None);

        Assert.Equal(2, sonuc.Planned.Count);
        Assert.Equal(beklenenMutation, sonuc.Planned[0].Path);
        Assert.Equal("timeEntryUpdate", sonuc.Planned[1].Path);
    }

    [Fact]
    public async Task two_step_baskasi_adina_yazmayi_UYARI_ile_gecer_HATA_vermez()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(kisi: Ortam.BaskasiId), dryRun: true, CancellationToken.None);

        Assert.Empty(sonuc.Errors);
        Assert.Contains(sonuc.Warnings, u => u.Contains("Başkası adına yazma"));
        Assert.Equal(Ortam.BaskasiId, Girdi(sonuc.Planned[1])["personId"]!.GetValue<string>());
    }

    // ── link_first ───────────────────────────────────────────────────────────

    [Fact]
    public async Task link_first_tek_mutation_planlar()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "link_first");
        var sonuc = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: true, CancellationToken.None);

        Assert.Single(sonuc.Planned);
        Assert.Equal("requestUpdate", sonuc.Planned[0].Path);
        Assert.Null(sonuc.Planned[0].StepLabel);
    }

    /// <summary>Geçmiş tarih istendiği hâlde link_first bunu KARŞILAYAMAZ; sessiz kalmak yasak.</summary>
    [Fact]
    public async Task link_first_gecmis_tarih_istendiginde_karsilanamadi_uyarisi_uretir()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "link_first");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(tarih: Ortam.GunMetin(cfg, -1)), dryRun: true, CancellationToken.None);

        Assert.Contains(sonuc.Warnings, u => u.Contains("İSTENEN TARİH KARŞILANAMADI"));
    }

    [Fact]
    public async Task link_first_tarih_bugun_ise_gereksiz_uyari_uretmez()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "link_first");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(tarih: Ortam.BugunMetin(cfg)), dryRun: true, CancellationToken.None);

        Assert.DoesNotContain(sonuc.Warnings, u => u.Contains("İSTENEN TARİH KARŞILANAMADI"));
    }

    [Fact]
    public async Task link_first_baslangic_saatinin_kaybolacagini_soyler()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "link_first");
        var bugun = Ortam.BugunMetin(cfg);
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(baslangic: $"{bugun}T14:00:00+03:00"), dryRun: true, CancellationToken.None);

        Assert.Contains(sonuc.Warnings, u => u.Contains("Başlangıç saati KAYDEDİLMEYECEK"));
        Assert.False(Girdi(sonuc.Planned[0]).ContainsKey("startedAt"));
    }

    [Fact]
    public async Task link_first_baskasi_adina_yazmanin_MUMKUN_OLMADIGINI_soyler()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "link_first");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(kisi: Ortam.BaskasiId), dryRun: true, CancellationToken.None);

        Assert.Contains(sonuc.Warnings, u => u.Contains("authenticated user adına yazılacak"));
        Assert.False(Girdi(sonuc.Planned[0]).ContainsKey("personId"));
    }

    // ── date_first ───────────────────────────────────────────────────────────

    [Fact]
    public async Task date_first_tek_timeEntryCreate_planlar_ve_hedefi_TimeAllocation_a_cevirir()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first");
        var sonuc = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: true, CancellationToken.None);

        Assert.Empty(sonuc.Errors);
        Assert.Single(sonuc.Planned);
        Assert.Equal("timeEntryCreate", sonuc.Planned[0].Path);
        Assert.Equal(Ortam.Allocation1, Girdi(sonuc.Planned[0])["timeAllocationId"]!.GetValue<string>());
    }

    [Fact]
    public async Task date_first_kaydin_tickete_BAGLANMAYACAGINI_uyari_olarak_soyler()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first");
        var sonuc = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: true, CancellationToken.None);

        Assert.Contains(sonuc.Warnings, u => u.Contains("BAĞLANMAYACAK"));
        Assert.Contains(sonuc.Planned[0].Warnings, u => u.Contains("assignment değeri NULL"));
    }

    /// <summary>Yol A'nın şema gerçeği: TimeEntryCreateInput'ta ticket alanı YOKTUR.</summary>
    [Fact]
    public async Task date_first_planinda_hicbir_ticket_alani_bulunmaz()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first");
        var sonuc = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: true, CancellationToken.None);

        var girdi = Girdi(sonuc.Planned[0]);
        foreach (var yasakli in new[] { "assignment", "assignmentId", "requestId", "taskId" })
            Assert.False(girdi.ContainsKey(yasakli), $"Yol A girdisinde '{yasakli}' alanı var — şemada YOKTUR.");
    }

    [Fact]
    public async Task date_first_tarih_saat_ve_kisiyi_TAM_kontrol_eder()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first");
        var dun = Ortam.GunMetin(cfg, -1);

        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg),
            Istek(tarih: dun, baslangic: $"{dun}T14:00:00+03:00", kisi: Ortam.BaskasiId),
            dryRun: true, CancellationToken.None);

        var girdi = Girdi(sonuc.Planned[0]);
        Assert.Equal(dun, girdi["date"]!.GetValue<string>());
        Assert.Equal($"{dun}T14:00:00+03:00", girdi["startedAt"]!.GetValue<string>());
        Assert.Equal(Ortam.BaskasiId, girdi["personId"]!.GetValue<string>());
    }

    [Fact]
    public async Task date_first_varsayilan_TimeAllocation_tanimli_degilse_HATA_verir()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first", defaultAllocationId: "");
        var sonuc = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: true, CancellationToken.None);

        Assert.Contains(sonuc.Errors, h => h.Message.Contains("DEFAULT_TIME_ALLOCATION_ID"));
    }

    // ── Hedef tipi stratejiyi ezer ───────────────────────────────────────────

    [Theory]
    [InlineData("two_step")]
    [InlineData("link_first")]
    public async Task hedef_TimeAllocation_ise_strateji_zorla_date_first_e_dusurulur(string istenen)
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: istenen);
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek("time_allocation", Ortam.Allocation1), dryRun: true, CancellationToken.None);

        Assert.Equal("date_first", sonuc.Strategy);
        Assert.Single(sonuc.Planned);
        Assert.Equal("timeEntryCreate", sonuc.Planned[0].Path);
        Assert.Contains(sonuc.Warnings, u => u.Contains($"'{istenen}' stratejisi uygulanamaz"));
    }

    // ── sourceID / idempotency ───────────────────────────────────────────────

    [Fact]
    public async Task ayni_istek_ayni_sourceID_yi_uretir_determinizm_idempotency_anahtaridir()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first");
        var birinci = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: true, CancellationToken.None);
        var ikinci = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: true, CancellationToken.None);

        Assert.Equal(
            Girdi(birinci.Planned[0])["sourceID"]!.GetValue<string>(),
            Girdi(ikinci.Planned[0])["sourceID"]!.GetValue<string>());
    }

    [Fact]
    public async Task sure_degisirse_sourceID_de_degisir_farkli_kayit_farkli_anahtar()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first");
        var altmis = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(dakika: 60), dryRun: true, CancellationToken.None);
        var doksan = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(dakika: 90), dryRun: true, CancellationToken.None);

        Assert.NotEqual(
            Girdi(altmis.Planned[0])["sourceID"]!.GetValue<string>(),
            Girdi(doksan.Planned[0])["sourceID"]!.GetValue<string>());
    }

    // ── Strateji adı normalizasyonu ──────────────────────────────────────────

    [Fact]
    public async Task bilinmeyen_strateji_adi_env_varsayilanina_duser_ve_uyari_uretir()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "link_first");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(strateji: "hizli_mod"), dryRun: true, CancellationToken.None);

        Assert.Equal("link_first", sonuc.Strategy);
        Assert.Contains(sonuc.Warnings, u => u.Contains("Bilinmeyen backdateStrategy"));
    }

    [Fact]
    public async Task istekteki_strateji_env_varsayilanini_ezer()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(strateji: "link_first"), dryRun: true, CancellationToken.None);

        Assert.Equal("link_first", sonuc.Strategy);
        Assert.Single(sonuc.Planned);
    }

    // ── Yazma yolu (mock adapter üzerinde gerçekten çalıştırma) ──────────────

    /// <summary>
    /// two_step'in ders iddiasının UÇTAN UCA kanıtı: 1. adım ticket'a bağlar,
    /// 2. adım tarihi düzeltir ve BAĞ KORUNUR.
    /// </summary>
    [Fact]
    public async Task two_step_calistirildiginda_kayit_hem_tickete_bagli_kalir_hem_tarihi_duzelir()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var dun = Ortam.GunMetin(cfg, -1);

        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(tarih: dun), dryRun: false, CancellationToken.None);

        Assert.False(sonuc.DryRun);
        Assert.Empty(sonuc.Errors);
        Assert.NotNull(sonuc.TimeEntry);
        Assert.Equal(Ortam.Request70248, sonuc.TimeEntry!["assignmentId"]!.GetValue<string>());
        Assert.Equal(dun, sonuc.TimeEntry["date"]!.GetValue<string>());
    }

    [Fact]
    public async Task date_first_calistirildiginda_kayit_hicbir_tickete_bagli_olmaz()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first");
        var sonuc = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: false, CancellationToken.None);

        Assert.NotNull(sonuc.TimeEntry);
        Assert.Null(sonuc.TimeEntry!["assignmentId"]?.GetValue<string>());
        Assert.Equal(Ortam.Allocation1, sonuc.TimeEntry["timeAllocationId"]!.GetValue<string>());
    }

    /// <summary>Doğrulama hatası varsa ASLA yazılmaz — dry-run'a düşülür.</summary>
    [Fact]
    public async Task dogrulama_hatasi_varsa_hicbir_mutation_calistirilmaz()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step");
        var sonuc = await Strategies.RunAsync(
            cfg, Adapter(cfg), Istek(dakika: 45), dryRun: false, CancellationToken.None);

        Assert.True(sonuc.DryRun);
        Assert.Null(sonuc.TimeEntry);
        Assert.NotEmpty(sonuc.Errors);
    }

    [Fact]
    public async Task XURRENT_DRY_RUN_acikken_istek_dry_run_a_zorlanir()
    {
        var cfg = Ortam.Yapilandirma(backdateStrategy: "two_step", dryRun: true);
        var sonuc = await Strategies.RunAsync(cfg, Adapter(cfg), Istek(), dryRun: false, CancellationToken.None);

        Assert.True(sonuc.DryRun);
        Assert.Null(sonuc.TimeEntry);
        Assert.Contains(sonuc.Warnings, u => u.Contains("XURRENT_DRY_RUN=1"));
    }
}
