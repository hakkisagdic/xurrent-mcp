using Xunit;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Tests;

/// <summary>
/// Yazma öncesi ÖN KONTROLLER (Validate).
///
/// Bu kuralların tamamı gerçek Xurrent kısıtlarından türetilmiştir ve amaç, hatayı
/// API'ye gitmeden dry-run'da göstermektir. Buradaki testler saf: adapter yok, ağ yok,
/// takvim yok — yalnızca (bağlam + istek) → (hatalar + uyarılar).
/// </summary>
public class DogrulamaTests
{
    // ── Kurulum yardımcıları ─────────────────────────────────────────────────

    private static TimeTrackingContext Baglam(
        int? timeIncrement = 30,
        int? workday = 480,
        bool? fazlaMesaiSerbest = true,
        bool? allocationTimeTracking = true,
        bool? assignmentTimeTracking = true,
        bool? notZorunlu = false,
        bool? aciklamaZorunlu = false,
        IReadOnlyList<TimeAllocationInfo>? allocationlar = null,
        IReadOnlyList<EffortClass>? effortSiniflari = null)
        => new(
            Unit: "hours_and_minutes",
            TimeIncrement: timeIncrement,
            Workday: workday,
            Workweek: 2400,
            AllowWorkdayOvertime: fazlaMesaiSerbest,
            AllowWorkweekOvertime: true,
            AllocationTimeTracking: allocationTimeTracking,
            AssignmentTimeTracking: assignmentTimeTracking,
            RequireNote: notZorunlu,
            RequireTimeEntryDescription: aciklamaZorunlu,
            EffortClasses: effortSiniflari ?? [new EffortClass(Ortam.EffortClass1, "Normal", 1, 1.0, false)],
            TimeAllocations: allocationlar ??
            [
                new TimeAllocationInfo(Ortam.Allocation1, "İç toplantılar", "Genel", false),
                new TimeAllocationInfo(Ortam.Allocation2, "Eğitim ve gelişim", "Genel", true),
            ],
            Defaults: new TimeTrackingDefaults(
                Ortam.EffortClass1, Ortam.EffortClass1, Ortam.EffortClass1, Ortam.EffortClass1, Ortam.EffortClass1));

    private static TimeEntryRequest Istek(
        int dakika = 60,
        string? aciklama = null,
        string? not = null,
        string? baslangic = null,
        bool duzeltme = false,
        string? effortClassId = null)
        => new()
        {
            TargetType = "request",
            TargetId = Ortam.Request70248,
            Minutes = dakika,
            Description = aciklama,
            Note = not,
            StartedAt = baslangic,
            Correction = duzeltme,
            EffortClassId = effortClassId,
        };

    private sealed record Sonuc(List<ValidationError> Hatalar, List<string> Uyarilar)
    {
        public bool HataVar(string parca) => Hatalar.Any(h => h.Message.Contains(parca));
        public bool UyariVar(string parca) => Uyarilar.Any(u => u.Contains(parca));
    }

    private static Sonuc Dogrula(
        TimeEntryRequest istek,
        TimeTrackingContext? baglam = null,
        AppConfig? cfg = null,
        bool yolA = false,
        string hedefId = Ortam.Allocation1,
        int gunFarki = 0,
        int oGunYazilmis = 0)
    {
        cfg ??= Ortam.Yapilandirma();
        var bugun = Ortam.Bugun(cfg);
        var hatalar = new List<ValidationError>();
        var uyarilar = new List<string>();

        Validate.TimeEntry(cfg, baglam ?? Baglam(), istek, yolA, hedefId,
            bugun.AddDays(gunFarki), bugun, oGunYazilmis, hatalar, uyarilar);

        return new Sonuc(hatalar, uyarilar);
    }

    // ── timeIncrement ────────────────────────────────────────────────────────

    [Theory]
    [InlineData(45)]
    [InlineData(7)]
    [InlineData(31)]
    public void timeIncrement_katı_olmayan_sure_HATA_verir(int dakika)
    {
        var sonuc = Dogrula(Istek(dakika));
        Assert.True(sonuc.HataVar("timeIncrement değeri 30 dakika"));
        Assert.Contains(sonuc.Hatalar, h => h.Path!.Contains("minutes"));
    }

    [Fact]
    public void timeIncrement_hatasi_alt_ve_ust_gecerli_degerleri_soyler()
    {
        var sonuc = Dogrula(Istek(45));
        Assert.True(sonuc.HataVar("30 veya 60"));
    }

    [Theory]
    [InlineData(30)]
    [InlineData(60)]
    [InlineData(480)]
    public void timeIncrement_katı_olan_sure_gecer(int dakika)
    {
        var sonuc = Dogrula(Istek(dakika), Baglam(fazlaMesaiSerbest: true));
        Assert.Empty(sonuc.Hatalar);
    }

    [Fact]
    public void timeIncrement_yoksa_60_varsayilir_ve_45_dakika_yine_reddedilir()
    {
        var sonuc = Dogrula(Istek(45), Baglam(timeIncrement: null));
        Assert.True(sonuc.HataVar("timeIncrement değeri 60 dakika"));
    }

    // ── Negatif süre / düzeltme ──────────────────────────────────────────────

    [Fact]
    public void negatif_sure_correction_olmadan_reddedilir()
    {
        var sonuc = Dogrula(Istek(-30));
        Assert.True(sonuc.HataVar("yalnızca correction=true ile"));
    }

    [Fact]
    public void negatif_sure_correction_true_ile_kabul_edilir()
    {
        var sonuc = Dogrula(Istek(-30, duzeltme: true));
        Assert.Empty(sonuc.Hatalar);
    }

    [Fact]
    public void negatif_sure_de_timeIncrement_katı_olmak_zorundadir()
    {
        var sonuc = Dogrula(Istek(-45, duzeltme: true));
        Assert.True(sonuc.HataVar("timeIncrement"));
    }

    [Fact]
    public void sifir_dakika_reddedilir()
    {
        var sonuc = Dogrula(Istek(0));
        Assert.True(sonuc.HataVar("0 dakika olamaz"));
    }

    // ── description ──────────────────────────────────────────────────────────

    [Fact]
    public void description_80_karakterden_uzunsa_reddedilir()
    {
        var sonuc = Dogrula(Istek(aciklama: new string('a', 81)));
        Assert.True(sonuc.HataVar("en fazla 80 karakter"));
    }

    [Fact]
    public void description_tam_80_karakter_ise_kabul_edilir()
    {
        var sonuc = Dogrula(Istek(aciklama: new string('a', 80)));
        Assert.Empty(sonuc.Hatalar);
    }

    [Fact]
    public void hesap_aciklamayi_zorunlu_kilmissa_bos_description_reddedilir()
    {
        var sonuc = Dogrula(Istek(), Baglam(aciklamaZorunlu: true));
        Assert.True(sonuc.HataVar("requireTimeEntryDescription=true"));
    }

    [Fact]
    public void descriptionRequired_allocation_a_aciklamasiz_yazma_reddedilir()
    {
        var sonuc = Dogrula(Istek(), yolA: true, hedefId: Ortam.Allocation2);
        Assert.True(sonuc.HataVar("descriptionRequired=true"));
    }

    [Fact]
    public void descriptionRequired_allocation_a_aciklama_ile_yazma_gecer()
    {
        var sonuc = Dogrula(Istek(aciklama: "MCP eğitimi"), yolA: true, hedefId: Ortam.Allocation2);
        Assert.Empty(sonuc.Hatalar);
    }

    [Fact]
    public void tanimsiz_allocation_id_si_HATA_degil_UYARI_uretir()
    {
        var sonuc = Dogrula(Istek(), yolA: true, hedefId: "bilinmeyen-allocation");
        Assert.Empty(sonuc.Hatalar);
        Assert.True(sonuc.UyariVar("seçebileceği TimeAllocation listesinde bulunamadı"));
    }

    // ── note ─────────────────────────────────────────────────────────────────

    [Fact]
    public void hesap_notu_zorunlu_kilmissa_Yol_B_de_notsuz_yazma_reddedilir()
    {
        var sonuc = Dogrula(Istek(), Baglam(notZorunlu: true));
        Assert.True(sonuc.HataVar("requireNote=true"));
    }

    [Fact]
    public void note_zorunlulugu_Yol_A_yi_baglamaz_cunku_o_input_ta_note_alani_yoktur()
    {
        var sonuc = Dogrula(Istek(), Baglam(notZorunlu: true), yolA: true);
        Assert.False(sonuc.HataVar("requireNote=true"));
    }

    // ── Tarih / backdate sınırı ──────────────────────────────────────────────

    [Fact]
    public void bugune_yazma_gecer()
    {
        Assert.Empty(Dogrula(Istek(), gunFarki: 0).Hatalar);
    }

    [Fact]
    public void MAX_BACKDATE_DAYS_1_iken_dune_yazma_gecer()
    {
        Assert.Empty(Dogrula(Istek(), gunFarki: -1).Hatalar);
    }

    [Fact]
    public void MAX_BACKDATE_DAYS_1_iken_iki_gun_oncesine_yazma_reddedilir()
    {
        var sonuc = Dogrula(Istek(), gunFarki: -2);
        Assert.True(sonuc.HataVar("XURRENT_MAX_BACKDATE_DAYS=1"));
    }

    [Fact]
    public void MAX_BACKDATE_DAYS_7_iken_iki_gun_oncesine_yazma_gecer()
    {
        var cfg = Ortam.Yapilandirma(maxBackdateDays: 7);
        Assert.Empty(Dogrula(Istek(), cfg: cfg, gunFarki: -2).Hatalar);
    }

    [Fact]
    public void gelecek_tarihe_yazma_reddedilir()
    {
        var sonuc = Dogrula(Istek(), gunFarki: 1);
        Assert.True(sonuc.HataVar("Gelecek tarihe zaman yazılamaz"));
    }

    // ── startedAt offset zorunluluğu ─────────────────────────────────────────

    [Fact]
    public void startedAt_offsetsiz_verilirse_reddedilir()
    {
        var sonuc = Dogrula(Istek(baslangic: "2026-08-01T14:00:00"));
        Assert.True(sonuc.HataVar("offset'i ZORUNLUDUR"));
    }

    [Theory]
    [InlineData("2026-08-01T14:00:00+03:00")]
    [InlineData("2026-08-01T11:00:00Z")]
    [InlineData("2026-08-01T14:00:00+0300")]
    public void startedAt_offsetli_verilirse_kabul_edilir(string deger)
    {
        var sonuc = Dogrula(Istek(baslangic: deger));
        Assert.False(sonuc.HataVar("offset"));
    }

    // ── Yol anahtarları ──────────────────────────────────────────────────────

    [Fact]
    public void allocationTimeTracking_kapaliysa_Yol_A_tamamen_reddedilir()
    {
        var sonuc = Dogrula(Istek(), Baglam(allocationTimeTracking: false), yolA: true);
        Assert.True(sonuc.HataVar("Yol A (timeEntryCreate) TAMAMEN kapalıdır"));
    }

    [Fact]
    public void assignmentTimeTracking_kapaliysa_Yol_B_tamamen_reddedilir()
    {
        var sonuc = Dogrula(Istek(), Baglam(assignmentTimeTracking: false));
        Assert.True(sonuc.HataVar("Yol B (requestUpdate/taskUpdate) TAMAMEN kapalıdır"));
    }

    // ── Günlük mesai sınırı ──────────────────────────────────────────────────

    [Fact]
    public void fazla_mesai_kapaliyken_gunluk_480_dakikayi_asan_yazma_reddedilir()
    {
        var sonuc = Dogrula(Istek(300), Baglam(fazlaMesaiSerbest: false), oGunYazilmis: 240);
        Assert.True(sonuc.HataVar("günlük sınır 480 dakika"));
        Assert.True(sonuc.HataVar("hâlihazırda 240 dakika yazılmış"));
    }

    [Fact]
    public void fazla_mesai_kapaliyken_tam_480_dakika_gecer()
    {
        var sonuc = Dogrula(Istek(240), Baglam(fazlaMesaiSerbest: false), oGunYazilmis: 240);
        Assert.Empty(sonuc.Hatalar);
    }

    [Fact]
    public void gunluk_sinirin_yuzde_90_i_asilinca_UYARI_uretilir_ama_yazma_engellenmez()
    {
        var sonuc = Dogrula(Istek(210), Baglam(fazlaMesaiSerbest: false), oGunYazilmis: 240);
        Assert.Empty(sonuc.Hatalar);
        Assert.True(sonuc.UyariVar("sınıra yaklaşıldı"));
    }

    [Fact]
    public void fazla_mesai_acikken_gunluk_sinir_asilabilir()
    {
        var sonuc = Dogrula(Istek(300), Baglam(fazlaMesaiSerbest: true), oGunYazilmis: 240);
        Assert.Empty(sonuc.Hatalar);
    }

    [Fact]
    public void negatif_duzeltme_kaydi_gunluk_sinir_kontrolune_takilmaz()
    {
        var sonuc = Dogrula(Istek(-60, duzeltme: true), Baglam(fazlaMesaiSerbest: false), oGunYazilmis: 480);
        Assert.Empty(sonuc.Hatalar);
    }

    // ── Effort class ─────────────────────────────────────────────────────────

    [Fact]
    public void aktif_listede_olmayan_effortClassId_HATA_degil_UYARI_uretir()
    {
        var sonuc = Dogrula(Istek(effortClassId: "devre-disi-sinif"));
        Assert.Empty(sonuc.Hatalar);
        Assert.True(sonuc.UyariVar("aktif effort class listesinde yok"));
    }

    // ── Strateji adı normalizasyonu ──────────────────────────────────────────

    [Theory]
    [InlineData("two_step")]
    [InlineData("link_first")]
    [InlineData("date_first")]
    public void bilinen_strateji_adlari_oldugu_gibi_kabul_edilir(string ad)
    {
        var uyarilar = new List<string>();
        Assert.Equal(ad, Validate.NormalizeStrategy(ad, Ortam.Yapilandirma(), uyarilar));
        Assert.Empty(uyarilar);
    }

    [Fact]
    public void bos_strateji_env_varsayilanina_duser_ve_uyari_uretmez()
    {
        var uyarilar = new List<string>();
        var cfg = Ortam.Yapilandirma(backdateStrategy: "date_first");
        Assert.Equal("date_first", Validate.NormalizeStrategy(null, cfg, uyarilar));
        Assert.Empty(uyarilar);
    }

    [Fact]
    public void bilinmeyen_strateji_env_varsayilanina_duser_ve_UYARI_uretir()
    {
        var uyarilar = new List<string>();
        var cfg = Ortam.Yapilandirma(backdateStrategy: "link_first");
        Assert.Equal("link_first", Validate.NormalizeStrategy("turbo", cfg, uyarilar));
        Assert.Single(uyarilar);
    }

    /// <summary>env varsayılanının kendisi bozuksa son çare two_step'tir — sessiz kalınmaz.</summary>
    [Fact]
    public void env_varsayilani_da_bozuksa_two_step_e_duser()
    {
        var uyarilar = new List<string>();
        var cfg = Ortam.Yapilandirma(backdateStrategy: "saçmalık");
        Assert.Equal("two_step", Validate.NormalizeStrategy("turbo", cfg, uyarilar));
    }
}
