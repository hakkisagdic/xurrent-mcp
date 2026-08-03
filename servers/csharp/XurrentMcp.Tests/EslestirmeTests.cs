using Xunit;
using XurrentMcp.Core;

namespace XurrentMcp.Tests;

/// <summary>
/// Toplantı başlığı → açık iş eşleştirmesi.
///
/// Heuristik KASITLI OLARAK basit ve açıklanabilir: her karar kullanıcıya Türkçe
/// gerekçesiyle sunulur. Testlerin asıl konusu doğru eşleşmeyi bulmak değil —
/// EMİN OLMADIĞINDA TAHMİN ETMEMEK. Yanlış ticket'a yazılan bir zaman girişi
/// sessizce yanlış faturalama demektir.
/// </summary>
public class EslestirmeTests
{
    private static WorkItem Is(string kind, string id, string displayId, string konu)
        => new(kind, id, displayId, konu, "in_progress", "Devam ediyor", true, null, null, null, null, null);

    /// <summary>Fixture'daki açık işlerin birebir karşılığı.</summary>
    private static readonly List<WorkItem> Adaylar =
    [
        Is("request", Ortam.Request70248, "70248", "Masraf beyanı ekranı çok yavaş açılıyor"),
        Is("request", Ortam.Request70301, "70301", "VPN bağlantısı gün içinde sürekli kopuyor"),
        Is("request", Ortam.Request70315, "70315", "Yeni çalışan onboarding hesap açılışı otomasyonu"),
        Is("task", Ortam.Task4412, "4412", "Raporlama sorgusuna submitted_at index'i ekle"),
        Is("task", Ortam.Task4419, "4419", "VPN concentrator loglarını analiz et"),
        Is("task", "TW9jay9UYXNrLzQ1MDE", "4501", "Yeni çalışanlar için AD hesabı oluştur"),
    ];

    // ── YOL 1: başlıkta ticket numarası ──────────────────────────────────────

    [Fact]
    public void baslikta_ticket_numarasi_varsa_kesin_eslesme_ve_guven_1_0_olur()
    {
        var sonuc = Matcher.Match("REQ-70248 performans incelemesi", Adaylar);

        Assert.False(sonuc.NeedsUserDecision);
        Assert.Equal(Ortam.Request70248, sonuc.Item!.Id);
        Assert.Equal(1.0, sonuc.Confidence);
        Assert.Contains("ticket numarası bulundu", sonuc.Reason);
    }

    [Fact]
    public void ticket_numarasi_Task_numarasiyla_da_eslesir()
    {
        var sonuc = Matcher.Match("4419 log incelemesi", Adaylar);

        Assert.Equal(Ortam.Task4419, sonuc.Item!.Id);
        Assert.Equal(1.0, sonuc.Confidence);
    }

    /// <summary>Numara deseni metin benzerliğini EZER — en güçlü sinyaldir.</summary>
    [Fact]
    public void numara_eslesmesi_metin_benzerliginin_onune_gecer()
    {
        var sonuc = Matcher.Match("VPN toplantısı 70248", Adaylar);

        Assert.Equal(Ortam.Request70248, sonuc.Item!.Id);
        Assert.Equal(1.0, sonuc.Confidence);
    }

    [Fact]
    public void listede_olmayan_bir_numara_kesin_eslesme_saymaz()
    {
        var sonuc = Matcher.Match("REQ-99999 toplantısı", Adaylar);

        Assert.True(sonuc.NeedsUserDecision);
        Assert.Null(sonuc.Item);
    }

    [Fact]
    public void dort_haneden_kisa_sayilar_ticket_numarasi_sayilmaz()
    {
        var sonuc = Matcher.Match("Sprint 12 planlama", Adaylar);

        Assert.True(sonuc.NeedsUserDecision);
    }

    // ── YOL 2: metin benzerliği ──────────────────────────────────────────────

    [Fact]
    public void metin_benzerligi_bulanik_eslesme_uretir()
    {
        var sonuc = Matcher.Match("Onboarding otomasyonu tasarım toplantısı", Adaylar);

        Assert.False(sonuc.NeedsUserDecision);
        Assert.Equal(Ortam.Request70315, sonuc.Item!.Id);
        Assert.NotNull(sonuc.Confidence);
        Assert.True(sonuc.Confidence < 1.0, "Bulanık eşleşmenin güveni kesin eşleşmeden düşük olmalı.");
        Assert.Contains("Metin benzerliği", sonuc.Reason);
    }

    [Fact]
    public void turkce_ekler_tolere_edilir_analiz_ile_analizi_ayni_kokten_sayilir()
    {
        var adaylar = new List<WorkItem> { Is("task", "t-1", "9001", "VPN concentrator loglarını analiz et") };
        var sonuc = Matcher.Match("VPN concentrator logları analizi", adaylar);

        Assert.False(sonuc.NeedsUserDecision);
        Assert.Equal("t-1", sonuc.Item!.Id);
    }

    // ── YOL 3: belirsizlik ve eşleşmeme ──────────────────────────────────────

    /// <summary>
    /// ★ İki aday benzer düzeyde eşleşiyorsa bot ASLA tahmin etmez.
    /// Fixture bu senaryoyu bilerek kurar: "VPN" hem Request #70301 hem Task #4419 ile eşleşir.
    /// </summary>
    [Fact]
    public void iki_aday_benzer_skordaysa_bot_tahmin_etmez_kullaniciya_sorar()
    {
        var sonuc = Matcher.Match("VPN kopma sorunu kök neden analizi", Adaylar);

        Assert.True(sonuc.NeedsUserDecision);
        Assert.Null(sonuc.Item);
        Assert.Contains("BELİRSİZ", sonuc.Reason);
    }

    [Fact]
    public void hicbir_aday_tutmazsa_kullanici_karari_gerekir()
    {
        var sonuc = Matcher.Match("Günlük standup", Adaylar);

        Assert.True(sonuc.NeedsUserDecision);
        Assert.Null(sonuc.Item);
        Assert.Null(sonuc.Confidence);
        Assert.Contains("Hiçbir açık iş ile eşleşmedi", sonuc.Reason);
    }

    /// <summary>Tek kelimelik örtüşme güvenilir değildir — düşük güvenle de olsa SORULUR.</summary>
    [Fact]
    public void tek_ortak_kelime_zayif_sinyaldir_ve_onay_ister()
    {
        var adaylar = new List<WorkItem> { Is("request", "r-1", "8001", "Masraf beyanı ekranı çok yavaş açılıyor") };
        var sonuc = Matcher.Match("Masraf süreci bilgilendirme", adaylar);

        Assert.True(sonuc.NeedsUserDecision);
        Assert.Equal(0.3, sonuc.Confidence);
        Assert.Contains("Zayıf benzerlik", sonuc.Reason);
    }

    [Fact]
    public void aday_listesi_bossa_kullanici_karari_gerekir()
    {
        var sonuc = Matcher.Match("REQ-70248 performans incelemesi", []);

        Assert.True(sonuc.NeedsUserDecision);
        Assert.Null(sonuc.Item);
    }

    /// <summary>Anlamsız kelimeler (toplantı, sync, ve, ile) eşleşme sinyali üretmez.</summary>
    [Fact]
    public void durak_kelimeler_eslesme_uretmez()
    {
        var adaylar = new List<WorkItem> { Is("request", "r-1", "8002", "Haftalık toplantı hazırlığı") };
        var sonuc = Matcher.Match("Toplantı ve sync", adaylar);

        Assert.True(sonuc.NeedsUserDecision);
    }

    [Fact]
    public void guven_skoru_hicbir_zaman_0_9_u_asmaz_kesin_eslesme_disinda()
    {
        var adaylar = new List<WorkItem>
        {
            Is("request", "r-1", "8003", "Yeni çalışan onboarding hesap açılışı otomasyonu"),
        };
        var sonuc = Matcher.Match("Yeni çalışan onboarding hesap açılışı otomasyonu", adaylar);

        Assert.False(sonuc.NeedsUserDecision);
        Assert.True(sonuc.Confidence <= 0.9, $"Güven 0.9'u aştı: {sonuc.Confidence}");
    }
}
