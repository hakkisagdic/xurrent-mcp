using System.Text.RegularExpressions;
using Xunit;

namespace XurrentMcp.Tests;

/// <summary>
/// Saat dilimi ve ISO8601 yardımcıları.
///
/// ★ Bu dosyanın var oluş sebebi gerçek bir olaydır: "bugün"e dayanan bir doğrulama
/// bu repoda gece yarısından sonra kırıldı. Sebep, yerel saat 00:00–03:00 arasındayken
/// (Europe/Istanbul = UTC+3) UTC tarihinin BİR GÜN GERİDE olmasıydı.
///
/// Bu yüzden buradaki testlerin HİÇBİRİ gerçek saate bakmaz: her biri sabitlenmiş bir
/// TimeProvider ile kurulur. Aksi hâlde testin kendisi günün saatine bağlı olurdu —
/// yani tam da yakalamaya çalıştığı hatayı yapardı.
/// </summary>
public class ZamanTests
{
    private static TimeZoneInfo Tz => Ortam.SaatDilimi;

    // ── "Bugün" ve saat dilimi tuzağı ────────────────────────────────────────

    /// <summary>
    /// UTC 03 Ağustos 22:30 → İstanbul'da 04 Ağustos 01:30.
    /// UTC tarihine bakan bir implementasyon burada BİR GÜN GERİ kalırdı.
    /// </summary>
    [Fact]
    public void yerel_gece_yarisindan_sonra_bugun_UTC_tarihinden_BIR_GUN_ILERIDEDIR()
    {
        var saat = new SabitSaat(new DateTimeOffset(2026, 8, 3, 22, 30, 0, TimeSpan.Zero));

        Assert.Equal(new DateOnly(2026, 8, 3), DateOnly.FromDateTime(saat.GetUtcNow().UtcDateTime));
        Assert.Equal(new DateOnly(2026, 8, 4), TimeUtil.Today(Tz, saat));
    }

    [Fact]
    public void yerel_gece_yarisindan_hemen_once_gun_donmez()
    {
        // UTC 20:59 → İstanbul 23:59, hâlâ aynı gün.
        var saat = new SabitSaat(new DateTimeOffset(2026, 8, 3, 20, 59, 0, TimeSpan.Zero));

        Assert.Equal(new DateOnly(2026, 8, 3), TimeUtil.Today(Tz, saat));
    }

    [Fact]
    public void yerel_gece_yarisinda_gun_tam_olarak_doner()
    {
        // UTC 21:00 = İstanbul 00:00 ertesi gün.
        var saat = new SabitSaat(new DateTimeOffset(2026, 8, 3, 21, 0, 0, TimeSpan.Zero));

        Assert.Equal(new DateOnly(2026, 8, 4), TimeUtil.Today(Tz, saat));
    }

    [Fact]
    public void UTC_saat_diliminde_bugun_UTC_tarihiyle_ayni_kalir()
    {
        var saat = new SabitSaat(new DateTimeOffset(2026, 8, 3, 22, 30, 0, TimeSpan.Zero));

        Assert.Equal(new DateOnly(2026, 8, 3), TimeUtil.Today(TimeZoneInfo.Utc, saat));
    }

    /// <summary>Saat enjekte edilmezse sistem saatine düşer — üretim yolu bozulmamalı.</summary>
    [Fact]
    public void saat_enjekte_edilmezse_sistem_saati_kullanilir()
    {
        var sistem = TimeUtil.Today(Tz);
        var esdeger = TimeUtil.Today(Tz, TimeProvider.System);

        Assert.True(Math.Abs(sistem.DayNumber - esdeger.DayNumber) <= 1);
    }

    // ── Yerel duvar saati → mutlak an ────────────────────────────────────────

    [Fact]
    public void AtLocal_yerel_duvar_saatini_offsetli_ana_cevirir()
    {
        var an = TimeUtil.AtLocal(new DateOnly(2026, 8, 3), new TimeOnly(9, 0), Tz);

        Assert.Equal(TimeSpan.FromHours(3), an.Offset);
        Assert.Equal(9, an.Hour);
        Assert.Equal(new DateTime(2026, 8, 3, 6, 0, 0), an.UtcDateTime);
    }

    [Fact]
    public void LocalMidnight_gunun_yerel_gece_yarisini_verir()
    {
        var an = TimeUtil.LocalMidnight(new DateOnly(2026, 8, 3), Tz);

        Assert.Equal(0, an.Hour);
        Assert.Equal(0, an.Minute);
        Assert.Equal(TimeSpan.FromHours(3), an.Offset);
    }

    /// <summary>
    /// DST geçişi yerel saatten hesaplanır: aynı duvar saati, yılın farklı yerlerinde
    /// FARKLI offset'e oturur. (Europe/Istanbul 2016'dan beri sabit +03; bu yüzden
    /// kural Europe/Berlin üzerinde gösteriliyor.)
    /// </summary>
    [Fact]
    public void AtLocal_DST_gecisini_yerel_saatten_uygular()
    {
        var berlin = TimeZoneInfo.FindSystemTimeZoneById("Europe/Berlin");

        var kis = TimeUtil.AtLocal(new DateOnly(2026, 1, 15), new TimeOnly(9, 0), berlin);
        var yaz = TimeUtil.AtLocal(new DateOnly(2026, 7, 15), new TimeOnly(9, 0), berlin);

        Assert.Equal(TimeSpan.FromHours(1), kis.Offset);
        Assert.Equal(TimeSpan.FromHours(2), yaz.Offset);
        Assert.Equal(9, kis.Hour);
        Assert.Equal(9, yaz.Hour);
    }

    // ── ISO biçimi ───────────────────────────────────────────────────────────

    [Fact]
    public void ToIso_offset_tasir_ve_kesirli_saniye_icermez()
    {
        var metin = TimeUtil.ToIso(new DateTimeOffset(2026, 8, 3, 9, 0, 0, 123, TimeSpan.FromHours(3)));

        Assert.Equal("2026-08-03T09:00:00+03:00", metin);
        Assert.Matches(new Regex(@"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+\-]\d{2}:\d{2}$"), metin);
    }

    [Fact]
    public void ToIso_UTC_ani_da_acik_offsetle_yazar_ciplak_timestamp_uretmez()
    {
        Assert.Equal("2026-08-03T06:00:00+00:00",
            TimeUtil.ToIso(new DateTimeOffset(2026, 8, 3, 6, 0, 0, TimeSpan.Zero)));
    }

    // ── Ayrıştırıcılar ───────────────────────────────────────────────────────

    [Theory]
    [InlineData("09:00", 9, 0)]
    [InlineData("13:45", 13, 45)]
    [InlineData("00:00", 0, 0)]
    [InlineData("23:59", 23, 59)]
    public void ParseHhMm_gecerli_saatleri_ayristirir(string girdi, int saat, int dakika)
    {
        Assert.Equal(new TimeOnly(saat, dakika), TimeUtil.ParseHhMm(girdi));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("9:00")]
    [InlineData("saçmalık")]
    public void ParseHhMm_bozuk_deger_icin_gece_yarisina_duser(string? girdi)
    {
        Assert.Equal(TimeOnly.MinValue, TimeUtil.ParseHhMm(girdi));
    }

    [Fact]
    public void ParseDate_gecerli_tarihi_ayristirir()
    {
        Assert.Equal(new DateOnly(2026, 8, 3), TimeUtil.ParseDate("2026-08-03", Tz));
    }

    [Fact]
    public void ParseDate_bozuk_deger_icin_enjekte_edilen_bugune_duser()
    {
        var saat = new SabitSaat(new DateTimeOffset(2027, 1, 5, 9, 0, 0, TimeSpan.Zero));

        Assert.Equal(new DateOnly(2027, 1, 5), TimeUtil.ParseDate("03.08.2026", Tz, saat));
    }

    // ── Çakışma birleştirme (saf matematik) ──────────────────────────────────

    private static (DateTimeOffset, DateTimeOffset) Aralik(int baslangicSaat, int baslangicDk, int bitisSaat, int bitisDk)
        => (TimeUtil.AtLocal(new DateOnly(2026, 8, 3), new TimeOnly(baslangicSaat, baslangicDk), Tz),
            TimeUtil.AtLocal(new DateOnly(2026, 8, 3), new TimeOnly(bitisSaat, bitisDk), Tz));

    [Fact]
    public void MergedMinutes_cakisan_araliklari_bir_kez_sayar()
    {
        var toplam = TimeUtil.MergedMinutes([Aralik(10, 0, 11, 0), Aralik(10, 30, 11, 30)]);

        Assert.Equal(90, toplam);
    }

    [Fact]
    public void MergedMinutes_fixture_gununun_beklenen_225_dakikasini_uretir()
    {
        var toplam = TimeUtil.MergedMinutes(
        [
            Aralik(9, 0, 9, 30),    // standup       30
            Aralik(10, 0, 11, 0),   // REQ-70248     60  ─┐ çakışıyor
            Aralik(10, 30, 11, 30), // 1:1           60  ─┘
            Aralik(13, 45, 14, 30), // VPN RCA       45
            Aralik(15, 0, 16, 0),   // onboarding    60
        ]);

        Assert.Equal(225, toplam);
    }

    [Fact]
    public void MergedMinutes_sirasi_bozuk_gelen_araliklari_da_dogru_birlestirir()
    {
        var toplam = TimeUtil.MergedMinutes([Aralik(15, 0, 16, 0), Aralik(9, 0, 10, 0), Aralik(9, 30, 11, 0)]);

        Assert.Equal(180, toplam); // 09:00–11:00 (120) + 15:00–16:00 (60)
    }

    [Fact]
    public void MergedMinutes_bos_liste_icin_sifir_doner()
    {
        Assert.Equal(0, TimeUtil.MergedMinutes([]));
    }

    [Fact]
    public void MergedMinutes_bitisi_baslangictan_once_olan_araligi_yok_sayar()
    {
        Assert.Equal(60, TimeUtil.MergedMinutes([Aralik(10, 0, 11, 0), Aralik(12, 0, 11, 0)]));
    }

    // ── Yuvarlama ────────────────────────────────────────────────────────────

    [Theory]
    [InlineData(45, 30, "nearest", 60)]
    [InlineData(45, 30, "up", 60)]
    [InlineData(45, 30, "down", 30)]
    [InlineData(44, 30, "nearest", 30)]
    [InlineData(60, 30, "nearest", 60)]
    [InlineData(75, 30, "nearest", 90)]
    [InlineData(50, 60, "nearest", 60)]
    [InlineData(50, 60, "down", 60)]
    public void RoundToIncrement_artim_katina_yuvarlar(int dakika, int artim, string mod, int beklenen)
    {
        Assert.Equal(beklenen, TimeUtil.RoundToIncrement(dakika, artim, mod));
    }

    /// <summary>0 dakikalık giriş anlamsızdır: aşağı yuvarlama en az BİR artıma kilitlenir.</summary>
    [Fact]
    public void RoundToIncrement_asagi_yuvarlarken_sifira_dusmez()
    {
        Assert.Equal(30, TimeUtil.RoundToIncrement(10, 30, "down"));
        Assert.Equal(30, TimeUtil.RoundToIncrement(1, 30, "nearest"));
    }

    [Fact]
    public void RoundToIncrement_artim_sifir_veya_negatifse_degeri_oldugu_gibi_birakir()
    {
        Assert.Equal(45, TimeUtil.RoundToIncrement(45, 0, "nearest"));
        Assert.Equal(45, TimeUtil.RoundToIncrement(45, -30, "nearest"));
    }

    [Fact]
    public void RoundToIncrement_bilinmeyen_mod_nearest_gibi_davranir()
    {
        Assert.Equal(60, TimeUtil.RoundToIncrement(45, 30, "sihirli"));
    }
}
