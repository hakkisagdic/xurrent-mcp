using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Calendars;

namespace XurrentMcp.Tests;

/// <summary>
/// Takvim normalizasyonu: eleme kuralları, pencereye kırpma, dedup ve süre hesabı.
///
/// Sağlayıcılar DIŞARIDAN veriliyor (CalendarFactory.ReadAsync(ICalendarProvider, ...)),
/// böylece hiçbir HTTP isteği ya da OAuth akışı olmadan tam kontrollü ham etkinliklerle
/// çalışılıyor. Fixture tabanlı testler ise üç dilin paylaştığı beklenen sayıları
/// (busyMinutes 225 · naiveSum 255) sabitliyor.
/// </summary>
public class TakvimTests
{
    private static readonly HttpClient Http = new();

    private static (CalendarFactory Fabrika, CalendarWindow Pencere, AppConfig Cfg) Kur(SabitSaat? saat = null)
    {
        var cfg = Ortam.Yapilandirma(saat);
        var fabrika = new CalendarFactory(cfg, Http);
        return (fabrika, fabrika.BuildWindow(null, Ortam.SaatDilimiId), cfg);
    }

    private static DateTimeOffset Yerel(DateOnly gun, int saat, int dakika = 0)
        => TimeUtil.AtLocal(gun, new TimeOnly(saat, dakika), Ortam.SaatDilimi);

    private static Task<CalendarResult> Oku(
        CalendarFactory fabrika, CalendarWindow pencere, CalendarOptions? secenek, params RawEvent[] etkinlikler)
        => fabrika.ReadAsync(new SahteTakvim(etkinlikler), pencere, secenek ?? new CalendarOptions(),
            CancellationToken.None);

    // ── Eleme kuralları ──────────────────────────────────────────────────────

    [Fact]
    public async Task iptal_edilmis_etkinlik_elenir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("İptal olan toplantı",
                Yerel(pencere.Date, 10), Yerel(pencere.Date, 11), iptal: true));

        Assert.True(sonuc.Meetings[0].Skipped);
        Assert.Contains("İptal edilmiş", sonuc.Meetings[0].SkipReason!);
        Assert.Equal(0, sonuc.Totals.Count);
        Assert.Equal(1, sonuc.Totals.FilteredOut);
    }

    [Fact]
    public async Task tum_gun_etkinligi_elenir_cunku_suresi_instantlardan_hesaplanamaz()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Doğum günü",
                Yerel(pencere.Date, 0), Yerel(pencere.Date.AddDays(1), 0), tumGun: true));

        Assert.True(sonuc.Meetings[0].Skipped);
        Assert.Contains("Tüm gün", sonuc.Meetings[0].SkipReason!);
        Assert.Equal(0, sonuc.Meetings[0].Minutes);
    }

    [Fact]
    public async Task reddedilmis_toplanti_elenir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Ekip retro",
                Yerel(pencere.Date, 16), Yerel(pencere.Date, 17), reddedildi: true));

        Assert.True(sonuc.Meetings[0].Skipped);
        Assert.Contains("Reddedilmiş", sonuc.Meetings[0].SkipReason!);
    }

    [Fact]
    public async Task mesgul_olmayan_etkinlik_elenir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Öğle arası",
                Yerel(pencere.Date, 12), Yerel(pencere.Date, 13), mesgulDegil: true));

        Assert.True(sonuc.Meetings[0].Skipped);
        Assert.Contains("Meşgul değil", sonuc.Meetings[0].SkipReason!);
    }

    /// <summary>Eleme sırası öğreticidir: iptal her şeyin önündedir.</summary>
    [Fact]
    public async Task iptal_ve_tum_gun_birlikteyse_gerekce_IPTAL_olur()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("İptal olmuş tatil",
                Yerel(pencere.Date, 0), Yerel(pencere.Date.AddDays(1), 0), tumGun: true, iptal: true));

        Assert.Contains("İptal edilmiş", sonuc.Meetings[0].SkipReason!);
    }

    /// <summary>Doğum günü hem tüm gün hem meşgul değildir; öğretici gerekçe "tüm gün"dür.</summary>
    [Fact]
    public async Task tum_gun_ve_mesgul_degil_birlikteyse_gerekce_TUM_GUN_olur()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Doğum günü",
                Yerel(pencere.Date, 0), Yerel(pencere.Date.AddDays(1), 0), tumGun: true, mesgulDegil: true));

        Assert.Contains("Tüm gün", sonuc.Meetings[0].SkipReason!);
    }

    [Fact]
    public async Task includeAllDay_secenegi_tum_gun_etkinligini_elemez()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, new CalendarOptions(IncludeAllDay: true),
            HamEtkinlik.Olustur("Doğum günü",
                Yerel(pencere.Date, 0), Yerel(pencere.Date.AddDays(1), 0), tumGun: true));

        Assert.False(sonuc.Meetings[0].Skipped);
        Assert.Null(sonuc.Meetings[0].SkipReason!);
    }

    [Fact]
    public async Task includeDeclined_secenegi_reddedilmis_toplantiyi_elemez()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, new CalendarOptions(IncludeDeclined: true),
            HamEtkinlik.Olustur("Retro", Yerel(pencere.Date, 16), Yerel(pencere.Date, 17), reddedildi: true));

        Assert.False(sonuc.Meetings[0].Skipped);
        Assert.Equal(60, sonuc.Totals.BusyMinutes);
    }

    [Fact]
    public async Task includeFree_secenegi_mesgul_olmayani_elemez()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, new CalendarOptions(IncludeFree: true),
            HamEtkinlik.Olustur("Öğle", Yerel(pencere.Date, 12), Yerel(pencere.Date, 13), mesgulDegil: true));

        Assert.False(sonuc.Meetings[0].Skipped);
    }

    [Fact]
    public async Task elenen_etkinlikler_busyMinutes_e_dahil_edilmez()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Gerçek", Yerel(pencere.Date, 9), Yerel(pencere.Date, 10)),
            HamEtkinlik.Olustur("Öğle", Yerel(pencere.Date, 12), Yerel(pencere.Date, 13), mesgulDegil: true));

        Assert.Equal(60, sonuc.Totals.BusyMinutes);
        Assert.Equal(60, sonuc.Totals.NaiveSumMinutes);
        Assert.Equal(1, sonuc.Totals.Count);
        Assert.Equal(2, sonuc.Totals.RawCount);
    }

    // ── Çakışma birleştirme ──────────────────────────────────────────────────

    [Fact]
    public async Task cakisan_toplantilar_busyMinutes_te_BIR_KEZ_sayilir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("A", Yerel(pencere.Date, 10), Yerel(pencere.Date, 11), uid: "a"),
            HamEtkinlik.Olustur("B", Yerel(pencere.Date, 10, 30), Yerel(pencere.Date, 11, 30), uid: "b"));

        Assert.Equal(90, sonuc.Totals.BusyMinutes);      // 10:00–11:30 birleşik
        Assert.Equal(120, sonuc.Totals.NaiveSumMinutes); // 60 + 60, çakışma iki kez
    }

    [Fact]
    public async Task tamamen_kapsanan_toplanti_toplami_buyutmez()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Uzun", Yerel(pencere.Date, 9), Yerel(pencere.Date, 12), uid: "a"),
            HamEtkinlik.Olustur("İçinde", Yerel(pencere.Date, 10), Yerel(pencere.Date, 11), uid: "b"));

        Assert.Equal(180, sonuc.Totals.BusyMinutes);
        Assert.Equal(240, sonuc.Totals.NaiveSumMinutes);
    }

    [Fact]
    public async Task ardisik_bitisik_toplantilar_tek_blok_olarak_toplanir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("A", Yerel(pencere.Date, 9), Yerel(pencere.Date, 10), uid: "a"),
            HamEtkinlik.Olustur("B", Yerel(pencere.Date, 10), Yerel(pencere.Date, 11), uid: "b"));

        Assert.Equal(120, sonuc.Totals.BusyMinutes);
        Assert.Equal(120, sonuc.Totals.NaiveSumMinutes);
    }

    // ── Pencereye kırpma ─────────────────────────────────────────────────────

    /// <summary>
    /// Filtre bir OVERLAP filtresidir: dün 23:00'te başlayıp bugün 01:00'de biten toplantı
    /// da döner. Süreyi doğru saymak için başlangıç pencereye KIRPILIR.
    /// </summary>
    [Fact]
    public async Task dunden_sarkan_toplanti_pencereye_kirpilir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Gece vardiyası",
                Yerel(pencere.Date.AddDays(-1), 23), Yerel(pencere.Date, 1)));

        Assert.Equal(60, sonuc.Meetings[0].Minutes);
        Assert.Equal(pencere.Start, sonuc.Meetings[0].StartInstant);
    }

    [Fact]
    public async Task yarina_tasan_toplanti_pencereye_kirpilir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Gece bakımı",
                Yerel(pencere.Date, 23), Yerel(pencere.Date.AddDays(1), 1)));

        Assert.Equal(60, sonuc.Meetings[0].Minutes);
        Assert.Equal(pencere.End, sonuc.Meetings[0].EndInstant);
    }

    [Fact]
    public async Task pencere_her_zaman_yerel_gece_yarisindan_yerel_gece_yarisina_kurulur()
    {
        var (_, pencere, _) = Kur();

        Assert.Equal(TimeSpan.FromHours(24), pencere.End - pencere.Start);
        Assert.Equal(TimeSpan.FromHours(3), pencere.Start.Offset);      // Europe/Istanbul = UTC+3
        Assert.Equal(0, pencere.Start.Hour);
    }

    // ── Dedup ────────────────────────────────────────────────────────────────

    [Fact]
    public async Task ayni_uid_ve_ayni_baslangic_TEK_kayit_sayilir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Standup", Yerel(pencere.Date, 9), Yerel(pencere.Date, 9, 30), uid: "seri@ornek", id: "a"),
            HamEtkinlik.Olustur("Standup", Yerel(pencere.Date, 9), Yerel(pencere.Date, 9, 30), uid: "seri@ornek", id: "b"));

        Assert.Single(sonuc.Meetings);
        Assert.Equal(30, sonuc.Totals.BusyMinutes);
    }

    /// <summary>
    /// Google'da tekrarlayan bir toplantının TÜM occurrence'ları AYNI iCalUID'yi taşır.
    /// Dedup anahtarı yalnızca uid olsaydı günün ikinci occurrence'ı SESSİZCE kaybolurdu.
    /// </summary>
    [Fact]
    public async Task Google_tarzi_ayni_uid_farkli_baslangic_IKI_kayit_olarak_kalir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("1:1", Yerel(pencere.Date, 9), Yerel(pencere.Date, 9, 30), uid: "seri@ornek", id: "occ-1"),
            HamEtkinlik.Olustur("1:1", Yerel(pencere.Date, 15), Yerel(pencere.Date, 15, 30), uid: "seri@ornek", id: "occ-2"));

        Assert.Equal(2, sonuc.Meetings.Count);
        Assert.Equal(60, sonuc.Totals.BusyMinutes);
    }

    /// <summary>Graph'te her occurrence FARKLI bir iCalUId taşır; ikisi de korunmalıdır.</summary>
    [Fact]
    public async Task Graph_tarzi_farkli_uid_ler_ayri_kayit_olarak_kalir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("Standup", Yerel(pencere.Date, 9), Yerel(pencere.Date, 9, 30), uid: "occ-1@graph"),
            HamEtkinlik.Olustur("Standup", Yerel(pencere.Date, 10), Yerel(pencere.Date, 10, 30), uid: "occ-2@graph"));

        Assert.Equal(2, sonuc.Meetings.Count);
    }

    [Fact]
    public async Task dedup_anahtari_uid_ve_baslangic_aninin_birlesimidir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await Oku(fabrika, pencere, null,
            HamEtkinlik.Olustur("A", Yerel(pencere.Date, 9), Yerel(pencere.Date, 10), uid: "uid-1"));

        var baslangic = Yerel(pencere.Date, 9).ToUnixTimeSeconds();
        Assert.Equal($"uid-1@{baslangic}", sonuc.Meetings[0].Uid);
    }

    // ── Fixture tabanlı beklenen sayılar (üç dilde ORTAK) ────────────────────

    [Fact]
    public async Task fixture_bugun_icin_8_ham_etkinlikten_5_gercek_toplanti_cikar()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await fabrika.ReadAsync("mock", pencere, new CalendarOptions(), CancellationToken.None);

        Assert.Equal(8, sonuc.Totals.RawCount);
        Assert.Equal(5, sonuc.Totals.Count);
        Assert.Equal(3, sonuc.Totals.FilteredOut);
    }

    [Fact]
    public async Task fixture_bugun_icin_busyMinutes_225_naiveSum_255_tir()
    {
        var (fabrika, pencere, _) = Kur();
        var sonuc = await fabrika.ReadAsync("mock", pencere, new CalendarOptions(), CancellationToken.None);

        Assert.Equal(225, sonuc.Totals.BusyMinutes);
        Assert.Equal(255, sonuc.Totals.NaiveSumMinutes);
    }

    [Fact]
    public async Task fixture_dun_icin_2_toplanti_ve_180_dakika_dir()
    {
        var cfg = Ortam.Yapilandirma();
        var fabrika = new CalendarFactory(cfg, Http);
        var dun = fabrika.BuildWindow(Ortam.GunMetin(cfg, -1), Ortam.SaatDilimiId);
        var sonuc = await fabrika.ReadAsync("mock", dun, new CalendarOptions(), CancellationToken.None);

        Assert.Equal(2, sonuc.Totals.Count);
        Assert.Equal(180, sonuc.Totals.BusyMinutes);
        Assert.Equal(180, sonuc.Totals.NaiveSumMinutes);
    }

    /// <summary>Fixture göreli tarihlidir: enjekte edilen saat değişince gün de kayar.</summary>
    [Fact]
    public async Task fixture_tarihleri_enjekte_edilen_saate_gore_materyalize_edilir()
    {
        var saat = new SabitSaat(new DateTimeOffset(2027, 3, 15, 9, 0, 0, TimeSpan.Zero));
        var (fabrika, pencere, _) = Kur(saat);
        var sonuc = await fabrika.ReadAsync("mock", pencere, new CalendarOptions(), CancellationToken.None);

        Assert.Equal(new DateOnly(2027, 3, 15), pencere.Date);
        Assert.StartsWith("2027-03-15", sonuc.Meetings[0].Start);
        Assert.Equal(225, sonuc.Totals.BusyMinutes);
    }

    // ── Microsoft Graph alan tuzakları ───────────────────────────────────────

    /// <summary>
    /// ★ Graph "2026-08-02T09:00:00.0000000" gibi OFFSET TAŞIMAYAN, 7 kesirli haneli bir
    /// string döner. Doğrudan parse edilirse SUNUCUNUN yerel saati sanılır. Prefer header
    /// göndermediğimiz için doğru okuma UTC'dir.
    /// </summary>
    [Fact]
    public void Graph_offsetsiz_dateTime_UTC_olarak_okunur()
    {
        var an = TimeUtil.ParseGraphDateTime("2026-08-02T09:00:00.0000000", "UTC");

        Assert.Equal(TimeSpan.Zero, an.Offset);
        Assert.Equal(new DateTime(2026, 8, 2, 9, 0, 0), an.UtcDateTime);
    }

    [Fact]
    public void Graph_timeZone_alani_bos_gelirse_yine_UTC_varsayilir()
    {
        Assert.Equal(TimeSpan.Zero, TimeUtil.ParseGraphDateTime("2026-08-02T09:00:00.0000000", null).Offset);
        Assert.Equal(TimeSpan.Zero, TimeUtil.ParseGraphDateTime("2026-08-02T09:00:00.0000000", "").Offset);
    }

    [Fact]
    public void Graph_timeZone_verilirse_o_dilimin_offseti_uygulanir()
    {
        var an = TimeUtil.ParseGraphDateTime("2026-08-02T09:00:00.0000000", "Europe/Istanbul");

        Assert.Equal(TimeSpan.FromHours(3), an.Offset);
        Assert.Equal(new DateTime(2026, 8, 2, 6, 0, 0), an.UtcDateTime);
    }

    [Fact]
    public void Graph_bilinmeyen_timeZone_adi_UTC_ye_duser_istisna_firlatmaz()
    {
        var an = TimeUtil.ParseGraphDateTime("2026-08-02T09:00:00.0000000", "Mars/Olympus");
        Assert.Equal(TimeSpan.Zero, an.Offset);
    }

    [Fact]
    public void Graph_olayi_declined_ve_free_alanlarini_dogru_okur()
    {
        var e = GraphOlay(showAs: "free", yanit: "declined");
        var ham = GraphCalendarProvider.MapEvent(e);

        Assert.NotNull(ham);
        Assert.True(ham!.Free);
        Assert.True(ham.Declined);
    }

    [Fact]
    public void Graph_showAs_busy_ise_mesgul_sayilir()
    {
        var ham = GraphCalendarProvider.MapEvent(GraphOlay(showAs: "busy", yanit: "accepted"));
        Assert.False(ham!.Free);
        Assert.False(ham.Declined);
    }

    [Fact]
    public void Graph_iCalUId_yoksa_dedup_anahtari_id_ye_duser()
    {
        var e = GraphOlay();
        e.Remove("iCalUId");
        var ham = GraphCalendarProvider.MapEvent(e);

        Assert.Equal("evt-1", ham!.ICalUid);
    }

    [Fact]
    public void Graph_baslangic_okunamayan_olay_atlanir()
    {
        var e = GraphOlay();
        e["start"] = new JsonObject();
        Assert.Null(GraphCalendarProvider.MapEvent(e));
    }

    private static JsonObject GraphOlay(string showAs = "busy", string yanit = "accepted")
        => new()
        {
            ["id"] = "evt-1",
            ["iCalUId"] = "uid-1",
            ["subject"] = "Toplantı",
            ["start"] = new JsonObject { ["dateTime"] = "2026-08-02T09:00:00.0000000", ["timeZone"] = "UTC" },
            ["end"] = new JsonObject { ["dateTime"] = "2026-08-02T10:00:00.0000000", ["timeZone"] = "UTC" },
            ["isAllDay"] = false,
            ["isCancelled"] = false,
            ["showAs"] = showAs,
            ["responseStatus"] = new JsonObject { ["response"] = yanit },
            ["attendees"] = new JsonArray(new JsonObject(), new JsonObject()),
            ["categories"] = new JsonArray("Ekip"),
        };

    // ── Google Calendar alan tuzakları ───────────────────────────────────────

    /// <summary>
    /// ★ transparency alanı varsayılan değeri "opaque" iken CEVAPTA HİÇ ÇIKMAZ.
    /// "alan yok => meşgul değil" çıkarımı, çalışılan toplantıları sessizce eler.
    /// </summary>
    [Fact]
    public void Google_transparency_alani_YOKSA_opaque_yani_MESGUL_varsayilir()
    {
        var e = GoogleOlay();
        Assert.False(e.ContainsKey("transparency"));

        var ham = GoogleCalendarProvider.MapEvent(e, Ortam.SaatDilimi, "ayse.demir@ornek.com");
        Assert.False(ham!.Free);
    }

    [Fact]
    public void Google_transparency_transparent_ise_mesgul_degildir()
    {
        var e = GoogleOlay();
        e["transparency"] = "transparent";

        var ham = GoogleCalendarProvider.MapEvent(e, Ortam.SaatDilimi, "ayse.demir@ornek.com");
        Assert.True(ham!.Free);
    }

    [Fact]
    public void Google_dateTime_offset_tasir_ve_dogrudan_ayristirilir()
    {
        var ham = GoogleCalendarProvider.MapEvent(GoogleOlay(), Ortam.SaatDilimi, "");

        Assert.Equal(TimeSpan.FromHours(3), ham!.Start.Offset);
        Assert.Equal(new DateTime(2026, 8, 2, 6, 0, 0), ham.Start.UtcDateTime);
    }

    [Fact]
    public void Google_all_day_etkinlik_date_alanindan_okunur_ve_yerel_gece_yarisina_oturur()
    {
        var e = GoogleOlay();
        e["start"] = new JsonObject { ["date"] = "2026-08-02" };
        e["end"] = new JsonObject { ["date"] = "2026-08-03" };

        var ham = GoogleCalendarProvider.MapEvent(e, Ortam.SaatDilimi, "");

        Assert.True(ham!.IsAllDay);
        Assert.Equal(0, ham.Start.Hour);
        Assert.Equal(TimeSpan.FromHours(3), ham.Start.Offset);
    }

    [Fact]
    public void Google_self_katilimcinin_reddi_declined_olarak_okunur()
    {
        var e = GoogleOlay();
        e["attendees"] = new JsonArray(
            new JsonObject { ["email"] = "mehmet.kaya@ornek.com", ["responseStatus"] = "accepted" },
            new JsonObject { ["email"] = "ayse.demir@ornek.com", ["self"] = true, ["responseStatus"] = "declined" });

        var ham = GoogleCalendarProvider.MapEvent(e, Ortam.SaatDilimi, "ayse.demir@ornek.com");
        Assert.True(ham!.Declined);
    }

    [Fact]
    public void Google_baskasinin_reddi_kullanicinin_reddi_sayilmaz()
    {
        var e = GoogleOlay();
        e["attendees"] = new JsonArray(
            new JsonObject { ["email"] = "mehmet.kaya@ornek.com", ["responseStatus"] = "declined" });

        var ham = GoogleCalendarProvider.MapEvent(e, Ortam.SaatDilimi, "ayse.demir@ornek.com");
        Assert.False(ham!.Declined);
    }

    [Fact]
    public void Google_status_cancelled_iptal_olarak_okunur()
    {
        var e = GoogleOlay();
        e["status"] = "cancelled";

        var ham = GoogleCalendarProvider.MapEvent(e, Ortam.SaatDilimi, "");
        Assert.True(ham!.IsCancelled);
    }

    private static JsonObject GoogleOlay()
        => new()
        {
            ["id"] = "g-1",
            ["iCalUID"] = "uid-g1@google.com",
            ["summary"] = "Toplantı",
            ["status"] = "confirmed",
            ["start"] = new JsonObject { ["dateTime"] = "2026-08-02T09:00:00+03:00" },
            ["end"] = new JsonObject { ["dateTime"] = "2026-08-02T10:00:00+03:00" },
            ["organizer"] = new JsonObject { ["email"] = "mehmet.kaya@ornek.com" },
            ["attendees"] = new JsonArray(
                new JsonObject { ["email"] = "ayse.demir@ornek.com", ["self"] = true, ["responseStatus"] = "accepted" }),
        };
}
