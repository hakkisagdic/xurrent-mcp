using Xunit;
using XurrentMcp.Calendars;
using XurrentMcp.Core;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Tests;

/// <summary>
/// Takvimden plan üretimi ve onay kapısı.
///
/// plan_time_entries_from_calendar ÖNERİ üretir, ASLA yazmaz — ve bu "yazmama"
/// bir bayrağa değil, fonksiyonun YETENEĞİNE bağlanmıştır. Buradaki testler hem
/// çıktının doğruluğunu hem de o yapısal garantiyi doğrular.
/// </summary>
public class PlanTests
{
    private static readonly HttpClient Http = new();

    private static (AppConfig Cfg, MockAdapter Adapter, CalendarFactory Takvim) Kur(
        string? varsayilanAllocation = null, string yuvarlama = "nearest")
    {
        var cfg = varsayilanAllocation is null
            ? Ortam.Yapilandirma(roundingMode: yuvarlama)
            : Ortam.Yapilandirma(defaultAllocationId: varsayilanAllocation, roundingMode: yuvarlama);
        return (cfg, new MockAdapter(cfg), new CalendarFactory(cfg, Http));
    }

    private static Task<PlanResult> Planla(
        AppConfig cfg, MockAdapter adapter, CalendarFactory takvim,
        string? hedefTip = null, string? hedefId = null, string yuvarlama = "nearest")
        => ToolImpl.PlanFromCalendarAsync(cfg, adapter, takvim, "$me", null, Ortam.SaatDilimiId, "mock",
            hedefTip, hedefId, yuvarlama, CancellationToken.None);

    // ── Öneri üretimi ────────────────────────────────────────────────────────

    [Fact]
    public async Task elenen_etkinlikler_oneri_uretmez_sadece_gercek_toplantilar()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        Assert.Equal(5, plan.Proposals.Count);
    }

    [Fact]
    public async Task plan_hesabin_timeIncrement_degerini_raporlar()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        Assert.Equal(30, plan.TimeIncrement);
    }

    /// <summary>45 dakikalık toplantı timeIncrement=30 ile olduğu gibi yazılamaz.</summary>
    [Fact]
    public async Task kirkbes_dakikalik_toplanti_60_a_yuvarlanir_ve_yuvarlamayi_UYARI_olarak_soyler()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        var vpn = plan.Proposals.Single(o => o.MeetingTitle.Contains("VPN kopma"));

        Assert.Equal(45, vpn.RawMinutes);
        Assert.Equal(60, vpn.RoundedMinutes);
        Assert.Contains(vpn.Warnings, u => u.Contains("yuvarlandı"));
    }

    [Fact]
    public async Task yuvarlama_modu_down_secilirse_45_dakika_30_a_iner()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim, yuvarlama: "down");

        var vpn = plan.Proposals.Single(o => o.MeetingTitle.Contains("VPN kopma"));

        Assert.Equal(30, vpn.RoundedMinutes);
    }

    [Fact]
    public async Task artimla_uyumlu_sureler_icin_yuvarlama_uyarisi_uretilmez()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        var standup = plan.Proposals.Single(o => o.MeetingTitle.Contains("standup"));

        Assert.Equal(30, standup.RawMinutes);
        Assert.Equal(30, standup.RoundedMinutes);
        Assert.Empty(standup.Warnings);
    }

    // ── Eşleştirme sonucunun plana yansıması ─────────────────────────────────

    [Fact]
    public async Task baslikta_ticket_numarasi_olan_toplanti_dogrudan_o_requeste_onerilir()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        var oneri = plan.Proposals.Single(o => o.MeetingTitle.Contains("REQ-70248"));

        Assert.False(oneri.NeedsUserDecision);
        Assert.Equal("request", oneri.SuggestedTargetType);
        Assert.Equal(Ortam.Request70248, oneri.SuggestedTargetId);
        Assert.Equal(1.0, oneri.MatchConfidence);
    }

    [Fact]
    public async Task eslesmeyen_toplanti_varsayilan_TimeAllocation_a_dusurulur_ve_kullaniciya_sorulur()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        var standup = plan.Proposals.Single(o => o.MeetingTitle.Contains("standup"));

        Assert.True(standup.NeedsUserDecision);
        Assert.Equal("time_allocation", standup.SuggestedTargetType);
        Assert.Equal(Ortam.Allocation1, standup.SuggestedTargetId);
    }

    [Fact]
    public async Task eslesmeyen_toplantilar_ayrica_unmatchedMeetings_listesinde_raporlanir()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        Assert.Contains(plan.UnmatchedMeetings, b => b.Contains("standup"));
        Assert.Equal(plan.Proposals.Count(o => o.NeedsUserDecision), plan.UnmatchedMeetings.Count);
    }

    /// <summary>Belirsiz eşleşme de kullanıcıya düşer — bot iki adaydan birini SEÇMEZ.</summary>
    [Fact]
    public async Task belirsiz_eslesen_toplanti_kullanici_karari_olarak_isaretlenir()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        var vpn = plan.Proposals.Single(o => o.MeetingTitle.Contains("VPN kopma"));

        Assert.True(vpn.NeedsUserDecision);
        Assert.Contains("BELİRSİZ", vpn.MatchReason);
    }

    // ── Yedek hedef zinciri (K6) ─────────────────────────────────────────────

    [Fact]
    public async Task yedek_hedef_zincirinde_arguman_env_varsayilanini_ezer()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim, hedefId: Ortam.Allocation2);

        var standup = plan.Proposals.Single(o => o.MeetingTitle.Contains("standup"));

        Assert.Equal(Ortam.Allocation2, standup.SuggestedTargetId);
    }

    [Fact]
    public async Task env_varsayilani_yoksa_hesaptaki_ILK_TimeAllocation_a_dusulur()
    {
        var (cfg, adapter, takvim) = Kur(varsayilanAllocation: "");
        var plan = await Planla(cfg, adapter, takvim);

        var standup = plan.Proposals.Single(o => o.MeetingTitle.Contains("standup"));

        Assert.Equal(Ortam.Allocation1, standup.SuggestedTargetId);
    }

    // ── Toplamlar ────────────────────────────────────────────────────────────

    [Fact]
    public async Task plan_toplamlari_ham_ve_yuvarlanmis_sureleri_ayri_raporlar()
    {
        var (cfg, adapter, takvim) = Kur();
        var plan = await Planla(cfg, adapter, takvim);

        // Ham: 30 + 60 + 60 + 45 + 60 = 255 (naif toplam, çakışma iki kez sayılır)
        Assert.Equal(255, plan.Totals.MeetingMinutes);
        // Yuvarlanmış: 45 → 60 olduğu için 15 dakika fazla
        Assert.Equal(270, plan.Totals.ProposedMinutes);
    }

    /// <summary>★ Plan üretimi YAPISAL OLARAK yazamaz: çağrıdan sonra o günün toplamı değişmemiştir.</summary>
    [Fact]
    public async Task plan_uretimi_hicbir_zaman_girisi_olusturmaz()
    {
        var (cfg, adapter, takvim) = Kur();
        var bugun = Ortam.Bugun(cfg);

        var oncesi = await adapter.GetLoggedMinutesAsync(Ortam.BenId, bugun, CancellationToken.None);
        await Planla(cfg, adapter, takvim);
        var sonrasi = await adapter.GetLoggedMinutesAsync(Ortam.BenId, bugun, CancellationToken.None);

        Assert.Equal(oncesi, sonrasi);
    }

    // ── Onay kapısı (K5) ─────────────────────────────────────────────────────

    [Fact]
    public void dry_run_da_onay_sorulmaz_cunku_hicbir_mutation_gitmiyor()
    {
        Assert.False(ToolImpl.RequiresConfirmation(Ortam.Yapilandirma(), dryRun: true));
    }

    [Fact]
    public void XURRENT_DRY_RUN_acikken_onay_sorulmaz()
    {
        Assert.False(ToolImpl.RequiresConfirmation(Ortam.Yapilandirma(dryRun: true), dryRun: false));
    }

    [Fact]
    public void confirm_policy_open_iken_onay_hic_sorulmaz_yalnizca_CI_icindir()
    {
        Assert.False(ToolImpl.RequiresConfirmation(Ortam.Yapilandirma(confirmPolicy: "open"), dryRun: false));
    }

    [Theory]
    [InlineData("closed")]
    [InlineData("strict")]
    public void closed_ve_strict_politikalarinda_yazma_oncesi_onay_ZORUNLUDUR(string politika)
    {
        Assert.True(ToolImpl.RequiresConfirmation(Ortam.Yapilandirma(confirmPolicy: politika), dryRun: false));
    }

    [Fact]
    public async Task onaysiz_yazma_istegi_ONAY_TALEBI_dondurur_ve_plani_ozetler()
    {
        var cfg = Ortam.Yapilandirma();
        var sonuc = await ToolImpl.CreateTimeEntryAsync(cfg, new MockAdapter(cfg), new TimeEntryRequest
        {
            TargetType = "request",
            TargetId = Ortam.Request70248,
            Minutes = 120,
        }, dryRun: false, approved: false, CancellationToken.None);

        Assert.NotNull(sonuc.Confirmation);
        Assert.Null(sonuc.Value);
        Assert.Contains("120 dakikalık", sonuc.Confirmation!.Message);
        Assert.Equal("120 dakika", sonuc.Confirmation.Details["Süre"]);
        Assert.Equal("two_step", sonuc.Confirmation.Details["Strateji"]);
        Assert.Equal("2", sonuc.Confirmation.Details["Gidecek mutation sayısı"]);
    }

    /// <summary>Plan zaten hatalıysa onay sormanın anlamı yok — hata doğrudan gösterilir.</summary>
    [Fact]
    public async Task plan_hatali_ise_onay_sorulmadan_hata_dondurulur()
    {
        var cfg = Ortam.Yapilandirma();
        var sonuc = await ToolImpl.CreateTimeEntryAsync(cfg, new MockAdapter(cfg), new TimeEntryRequest
        {
            TargetType = "request",
            TargetId = Ortam.Request70248,
            Minutes = 45,   // timeIncrement=30 ile uyumsuz
        }, dryRun: false, approved: false, CancellationToken.None);

        Assert.Null(sonuc.Confirmation);
        Assert.NotNull(sonuc.Value);
        Assert.NotEmpty(sonuc.Value!.Errors);
    }

    [Fact]
    public async Task gecersiz_targetType_izinli_degerleri_sayarak_reddedilir()
    {
        var cfg = Ortam.Yapilandirma();
        var sonuc = await ToolImpl.CreateTimeEntryAsync(cfg, new MockAdapter(cfg), new TimeEntryRequest
        {
            TargetType = "incident",
            TargetId = "x",
            Minutes = 60,
        }, dryRun: true, approved: false, CancellationToken.None);

        Assert.Contains(sonuc.Value!.Errors, h => h.Message.Contains("Geçersiz targetType"));
        Assert.Contains(sonuc.Value.Errors, h => h.Message.Contains("time_allocation, request, task, project_task, problem"));
    }

    [Theory]
    [InlineData("time_allocation")]
    [InlineData("request")]
    [InlineData("task")]
    [InlineData("project_task")]
    [InlineData("problem")]
    public void bes_hedef_tipi_de_taninir(string tip) => Assert.True(ToolImpl.IsKnownTarget(tip));

    [Theory]
    [InlineData("incident")]
    [InlineData("")]
    [InlineData("Request")]
    public void tanimsiz_hedef_tipleri_reddedilir(string tip) => Assert.False(ToolImpl.IsKnownTarget(tip));

    // ── Toplu yazma ──────────────────────────────────────────────────────────

    [Fact]
    public async Task bos_toplu_istek_reddedilir()
    {
        var cfg = Ortam.Yapilandirma();
        var sonuc = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, new MockAdapter(cfg), [], dryRun: true, stopOnError: false, approved: true, CancellationToken.None);

        Assert.Contains(sonuc.Value!.Results[0].Errors, h => h.Message.Contains("en az 1, en fazla 50"));
    }

    [Fact]
    public async Task elli_satirdan_fazlasi_reddedilir()
    {
        var cfg = Ortam.Yapilandirma();
        var satirlar = Enumerable.Range(0, 51).Select(_ => new TimeEntryRequest
        {
            TargetType = "request", TargetId = Ortam.Request70248, Minutes = 30,
        }).ToArray();

        var sonuc = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, new MockAdapter(cfg), satirlar, dryRun: true, stopOnError: false, approved: true, CancellationToken.None);

        Assert.Contains(sonuc.Value!.Results[0].Errors, h => h.Message.Contains("en az 1, en fazla 50"));
    }

    [Fact]
    public async Task toplu_yazmada_onay_N_kez_degil_OZET_uzerinden_BIR_kez_sorulur()
    {
        var cfg = Ortam.Yapilandirma();
        var satirlar = new[]
        {
            new TimeEntryRequest { TargetType = "request", TargetId = Ortam.Request70248, Minutes = 60 },
            new TimeEntryRequest { TargetType = "task", TargetId = Ortam.Task4412, Minutes = 30 },
        };

        var sonuc = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, new MockAdapter(cfg), satirlar, dryRun: false, stopOnError: false, approved: false,
            CancellationToken.None);

        Assert.NotNull(sonuc.Confirmation);
        Assert.Equal("2", sonuc.Confirmation!.Details["Satır sayısı"]);
        Assert.Equal("90 dakika", sonuc.Confirmation.Details["Toplam süre"]);
        Assert.Contains("ATOMİK DEĞİLDİR", sonuc.Confirmation.Details["Uyarı"]);
    }

    [Fact]
    public async Task toplu_dry_run_da_hicbir_satir_olusturulmaz_hepsi_skipped_isaretlenir()
    {
        var cfg = Ortam.Yapilandirma();
        var satirlar = new[]
        {
            new TimeEntryRequest { TargetType = "request", TargetId = Ortam.Request70248, Minutes = 60 },
            new TimeEntryRequest { TargetType = "task", TargetId = Ortam.Task4412, Minutes = 30 },
        };

        var sonuc = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, new MockAdapter(cfg), satirlar, dryRun: true, stopOnError: false, approved: true,
            CancellationToken.None);

        Assert.All(sonuc.Value!.Results, s => Assert.Equal("skipped", s.Status));
        Assert.Equal(0, sonuc.Value.Summary.Created);
        Assert.Equal(2, sonuc.Value.Summary.Skipped);
        Assert.Equal(90, sonuc.Value.Summary.TotalMinutes);
    }

    [Fact]
    public async Task stopOnError_acikken_ilk_hatadan_sonraki_satirlar_atlanir()
    {
        var cfg = Ortam.Yapilandirma();
        var satirlar = new[]
        {
            new TimeEntryRequest { TargetType = "incident", TargetId = "x", Minutes = 60 },
            new TimeEntryRequest { TargetType = "request", TargetId = Ortam.Request70248, Minutes = 30 },
        };

        var sonuc = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, new MockAdapter(cfg), satirlar, dryRun: true, stopOnError: true, approved: true,
            CancellationToken.None);

        Assert.Equal("failed", sonuc.Value!.Results[0].Status);
        Assert.Equal("skipped", sonuc.Value.Results[1].Status);
        Assert.Equal(1, sonuc.Value.Summary.Failed);
    }

    [Fact]
    public async Task stopOnError_kapaliyken_hatali_satirdan_sonrakiler_islenmeye_devam_eder()
    {
        var cfg = Ortam.Yapilandirma();
        var satirlar = new[]
        {
            new TimeEntryRequest { TargetType = "request", TargetId = Ortam.Request70248, Minutes = 45 },
            new TimeEntryRequest { TargetType = "request", TargetId = Ortam.Request70248, Minutes = 30 },
        };

        var sonuc = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, new MockAdapter(cfg), satirlar, dryRun: true, stopOnError: false, approved: true,
            CancellationToken.None);

        Assert.Equal("failed", sonuc.Value!.Results[0].Status);
        Assert.Equal("skipped", sonuc.Value.Results[1].Status);
        Assert.Equal(1, sonuc.Value.Summary.Failed);
    }

    [Fact]
    public async Task toplu_yazmada_plan_satir_indeksiyle_izlenebilir()
    {
        var cfg = Ortam.Yapilandirma();
        var satirlar = new[]
        {
            new TimeEntryRequest { TargetType = "request", TargetId = Ortam.Request70248, Minutes = 60 },
            new TimeEntryRequest { TargetType = "task", TargetId = Ortam.Task4412, Minutes = 30 },
        };

        var sonuc = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, new MockAdapter(cfg), satirlar, dryRun: true, stopOnError: false, approved: true,
            CancellationToken.None);

        // two_step: satır başına 2 mutation, hepsi kendi satır indeksini taşır.
        Assert.Equal(4, sonuc.Value!.Planned.Count);
        Assert.Equal([0, 0, 1, 1], sonuc.Value.Planned.Select(p => p.Index));
    }

    // ── Onay reddi ───────────────────────────────────────────────────────────

    [Fact]
    public void onay_reddedilirse_hicbir_mutation_planlanmaz()
    {
        var sonuc = ToolImpl.DeclinedWrite("Kullanıcı onaylamadı.");

        Assert.True(sonuc.DryRun);
        Assert.Empty(sonuc.Planned);
        Assert.Null(sonuc.TimeEntry);
        Assert.Contains(sonuc.Errors, h => h.Path!.Contains("_confirmation"));
    }

    [Fact]
    public void toplu_onay_reddinde_tum_satirlar_atlanmis_sayilir()
    {
        var sonuc = ToolImpl.DeclinedBulk(5, "Kullanıcı onaylamadı.");

        Assert.Equal(5, sonuc.Summary.Requested);
        Assert.Equal(0, sonuc.Summary.Created);
        Assert.Equal(5, sonuc.Summary.Skipped);
        Assert.Empty(sonuc.Planned);
    }
}
