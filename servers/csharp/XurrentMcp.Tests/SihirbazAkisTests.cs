using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Calendars;
using XurrentMcp.Core;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ timesheet_wizard — LLM'siz durum makinesi (contract/wizard.md §1–§5).
///
/// Adım semantiği ÜÇ DİLDE AYNI (senaryo h bunu çapraz-dil ölçer): sonuçtaki step,
/// yanıtı üreten yani SON TAMAMLANAN adımdır:
///   seçim → "pick_work" · süre → "duration" · detay → "detail" ·
///   strateji → "strategy" (dry-run plan + onay sorusu) · evet → "write" (done=true).
/// Vazgeçme ve hatalar "done" adımıyla biter.
/// </summary>
public class SihirbazAkisTests
{
    private static (AppConfig Cfg, MockAdapter Adapter, CalendarFactory Takvim, SabitSaat Saat) Kur()
    {
        var saat = new SabitSaat(Ortam.VarsayilanAn);
        var cfg = Ortam.Yapilandirma(saat);
        return (cfg, new MockAdapter(cfg), new CalendarFactory(cfg, new HttpClient()), saat);
    }

    private static Task<WizardResult> Adim(
        (AppConfig Cfg, MockAdapter Adapter, CalendarFactory Takvim, SabitSaat Saat) ortam,
        string? soylenen, string? durum)
        => TimesheetWizard.RunAsync(ortam.Cfg, ortam.Adapter, ortam.Takvim, soylenen, durum, CancellationToken.None);

    /// <summary>sessionState payload'ını test tarafında çözer (base64url → JSON).</summary>
    private static JsonObject Payload(string state)
    {
        var b64 = state[..state.IndexOf('.')].Replace('-', '+').Replace('_', '/');
        var dolgulu = b64.PadRight(b64.Length + (4 - b64.Length % 4) % 4, '=');
        return JsonNode.Parse(Encoding.UTF8.GetString(Convert.FromBase64String(dolgulu)))!.AsObject();
    }

    // ── Mutlu yol ────────────────────────────────────────────────────────────

    [Fact]
    public async Task mutlu_yol_start_tan_write_a_yazar_ve_geri_okur()
    {
        var ortam = Kur();

        // 1) start: selamlar, timeIncrement'i SÖYLER, açık işleri listeler.
        var r1 = await Adim(ortam, null, null);
        Assert.Equal("start", r1.Step);
        Assert.False(r1.Done);
        Assert.Contains("30 dakika", r1.Reply);           // timeIncrement söylendi
        Assert.NotNull(r1.SessionState);
        Assert.NotNull(r1.NextQuestion);
        Assert.True(r1.NextQuestion!.Choices!.Count >= 7); // 3 request + 3 task + takvim
        Assert.Contains(r1.NextQuestion.Choices!, c => c.Id == "takvim");

        // sessionState makine adımını taşır ve İMZALI round-trip yapar.
        Assert.Equal("start", Payload(r1.SessionState!)["step"]!.GetValue<string>());
        Assert.True(WizardStateCodec.Verify(ortam.Cfg, r1.SessionState!).Ok);

        // 2) 1-bazlı sıra numarasıyla iş seçimi → step "pick_work", süre sorusu.
        var r2 = await Adim(ortam, "1", r1.SessionState);
        Assert.Equal("pick_work", r2.Step);
        Assert.Contains("Seçilen iş", r2.Reply);
        Assert.Equal("pick_work", Payload(r2.SessionState!)["step"]!.GetValue<string>());

        // 3) '2 saat' → 120 dk; çevirim AÇIKÇA söylenir → step "duration".
        var r3 = await Adim(ortam, "2 saat", r2.SessionState);
        Assert.Equal("duration", r3.Step);
        Assert.Contains("120", r3.Reply);
        Assert.Equal(120, Payload(r3.SessionState!)["data"]!["minutes"]!.GetValue<int>());

        // 4) detay: dün + 14:00 + açıklama → step "detail", strateji seçenekleri.
        var r4 = await Adim(ortam, "dün 14:00 sorgu optimizasyonu", r3.SessionState);
        Assert.Equal("detail", r4.Step);
        Assert.Equal(3, r4.NextQuestion!.Choices!.Count);
        var veri = Payload(r4.SessionState!)["data"]!.AsObject();
        Assert.Equal(Ortam.GunMetin(ortam.Cfg, -1), veri["date"]!.GetValue<string>());
        Assert.Contains("14:00", veri["startedAt"]!.GetValue<string>());
        Assert.Equal("sorgu optimizasyonu", veri["description"]!.GetValue<string>());

        // 5) strateji seçimi → step "strategy": dry-run planı + parmak izi + onay sorusu.
        var r5 = await Adim(ortam, "two_step", r4.SessionState);
        Assert.Equal("strategy", r5.Step);
        Assert.Empty(r5.Errors);
        Assert.Contains("DRY-RUN", r5.Reply);
        Assert.False(string.IsNullOrEmpty(
            Payload(r5.SessionState!)["data"]!["plannedFingerprint"]!.GetValue<string>()));

        // 6) evet → step "write": yazıldı + geri-okuma raporu, done=true.
        var r6 = await Adim(ortam, "evet", r5.SessionState);
        Assert.Equal("write", r6.Step);
        Assert.True(r6.Done);
        Assert.Empty(r6.Errors);
        Assert.NotNull(r6.WriteResult);
        Assert.False(r6.WriteResult!.DryRun);
        Assert.Equal("two_step", r6.WriteResult.Strategy);
        Assert.Contains("GERİ-OKUMA", r6.Reply);

        // done=true iken sessionState ve nextQuestion YOK (sözleşme).
        Assert.Null(r6.SessionState);
        Assert.Null(r6.NextQuestion);

        // Yazma gerçekten oldu mu? Bağımsız göz: list_time_entries.
        var dun = Ortam.GunMetin(ortam.Cfg, -1);
        var sayfa = await ToolImpl.ListTimeEntriesAsync(
            ortam.Adapter, "$me", dun, dun, null, 100, CancellationToken.None);
        Assert.Contains(sayfa.TimeEntries, e => e.Description == "sorgu optimizasyonu" && e.TimeSpent == 120);
    }

    [Fact]
    public async Task hayir_cevabi_yazmadan_done_ile_bitirir()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);
        var r2 = await Adim(ortam, "1", r1.SessionState);
        var r3 = await Adim(ortam, "90", r2.SessionState);
        var r4 = await Adim(ortam, "bugün deneme", r3.SessionState);
        var r5 = await Adim(ortam, "link_first", r4.SessionState);
        var r6 = await Adim(ortam, "hayır", r5.SessionState);

        Assert.True(r6.Done);
        Assert.Equal("done", r6.Step);
        Assert.Null(r6.WriteResult);
        Assert.Empty(r6.Errors);
        Assert.Contains("HİÇBİR", r6.Reply);
    }

    // ── Cevap ayrıştırma (§3) ────────────────────────────────────────────────

    [Fact]
    public async Task bir_bucuk_saat_90_dakikaya_cevrilir()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);
        var r2 = await Adim(ortam, "1", r1.SessionState);
        var r3 = await Adim(ortam, "1,5 saat", r2.SessionState);

        Assert.Equal("duration", r3.Step);
        Assert.Contains("90", r3.Reply);
        Assert.Equal(90, Payload(r3.SessionState!)["data"]!["minutes"]!.GetValue<int>());
    }

    [Theory]
    [InlineData("2 saat", 120, true)]
    [InlineData("2 sa", 120, true)]
    [InlineData("1,5 saat", 90, true)]
    [InlineData("1.5 saat", 90, true)]
    [InlineData("90 dk", 90, false)]
    [InlineData("45 dakika", 45, false)]
    [InlineData("90", 90, false)]
    public void sure_ayristirma_kurallari_birebir(string girdi, int beklenen, bool saatten)
    {
        var sonuc = TimesheetWizard.ParseDuration(girdi);
        Assert.NotNull(sonuc);
        Assert.Equal(beklenen, sonuc!.Value.Minutes);
        Assert.Equal(saatten, sonuc.Value.FromHours);
    }

    [Theory]
    [InlineData("bilmemne")]
    [InlineData("saat 2")]
    [InlineData("1,5 dk")]   // ondalık DAKİKA anlamsız — reddedilir
    [InlineData("0")]
    public void anlasilmaz_sure_null_doner(string girdi)
        => Assert.Null(TimesheetWizard.ParseDuration(girdi));

    [Fact]
    public void turkce_katlama_buyuk_I_ve_noktali_I_yi_dogru_indirger()
    {
        // İ→i, I→ı — "İŞ".ToLowerInvariant() tuzağının kapandığı yer.
        Assert.Equal("iş", TimesheetWizard.Katla("İŞ"));
        Assert.Equal("ılık", TimesheetWizard.Katla("ILIK"));
        Assert.Equal("evet", TimesheetWizard.Katla("EVET"));
    }

    [Theory]
    [InlineData("evet", true)]
    [InlineData("EVET", true)]
    [InlineData("onaylıyorum", true)]
    [InlineData("ONAYLIYORUM", true)]   // I→ı katlaması: ONAYLIYORUM → onaylıyorum
    [InlineData("tamam", true)]
    [InlineData("e", true)]
    [InlineData("hayır", false)]
    [InlineData("HAYIR", false)]
    [InlineData("vazgeç", false)]
    [InlineData("iptal", false)]
    [InlineData("h", false)]
    public void onay_kumeleri_sozlesmedeki_gibi(string girdi, bool beklenen)
        => Assert.Equal(beklenen, TimesheetWizard.ParseYesNo(girdi));

    [Theory]
    [InlineData("belki")]
    [InlineData("evet ama")]
    public void belirsiz_onay_cevabi_null_doner(string girdi)
        => Assert.Null(TimesheetWizard.ParseYesNo(girdi));

    // ── Sağlamlık ────────────────────────────────────────────────────────────

    [Fact]
    public async Task anlamsiz_cevap_adimi_ILERLETMEZ_ayni_soru_geri_doner()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);
        var r2 = await Adim(ortam, "1", r1.SessionState);

        var r3 = await Adim(ortam, "asdf qwerty", r2.SessionState);

        Assert.Equal("pick_work", r3.Step);                      // adım DEĞİŞMEDİ
        Assert.False(r3.Done);
        Assert.Equal(r2.NextQuestion!.Prompt, r3.NextQuestion!.Prompt);  // AYNI soru
        Assert.Contains("anlaşılamadı", r3.Reply);               // yeniden anlatım

        // Akış kaldığı yerden sürebilmeli.
        var r4 = await Adim(ortam, "60", r3.SessionState);
        Assert.Equal("duration", r4.Step);
    }

    [Fact]
    public async Task kurcalanan_sessionState_akisi_ACIKCA_bastan_baslatir()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);
        var r2 = await Adim(ortam, "1", r1.SessionState);

        // Payload'da TEK karakter değiştir: imza artık tutmaz.
        var durum = r2.SessionState!;
        var hedef = 10;
        var bozuk = durum[..hedef] + (durum[hedef] == 'A' ? 'B' : 'A') + durum[(hedef + 1)..];
        Assert.NotEqual(durum, bozuk);

        var r3 = await Adim(ortam, "2 saat", bozuk);

        Assert.Equal("start", r3.Step);                  // baştan — ama SESSİZCE değil
        Assert.False(r3.Done);
        Assert.Contains("İMZASI GEÇERSİZ", r3.Reply);
        Assert.Contains("BAŞTAN", r3.Reply);
        Assert.NotNull(r3.SessionState);                 // yeni, temiz bir oturum verildi
    }

    [Fact]
    public async Task suresi_dolan_sessionState_nazikce_bastan_baslatir()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);

        // TTL varsayılanı 1800 sn (XURRENT_WIZARD_TTL) — bir saniye ötesine geç.
        ortam.Saat.Ilerlet(TimeSpan.FromSeconds(ortam.Cfg.WizardTtlSeconds + 1));

        var r2 = await Adim(ortam, "1", r1.SessionState);

        Assert.Equal("start", r2.Step);
        Assert.False(r2.Done);
        Assert.Contains("süresi dolmuş", r2.Reply);
        Assert.Contains("BAŞTAN", r2.Reply);
    }

    /// <summary>
    /// GEÇERLİ imzalı ama onaylanandan FARKLI veri taşıyan bir state (test, imza
    /// anahtarını bildiği için sahtesini üretebilir) yazdırmaya çalışırsa:
    /// write geçişi parmak izini yeniden hesaplar ve YAZMAZ (wizard.md §4).
    /// </summary>
    [Fact]
    public async Task parmak_izi_uyusmazsa_yazma_REDDEDILIR()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);
        var r2 = await Adim(ortam, "1", r1.SessionState);
        var r3 = await Adim(ortam, "2 saat", r2.SessionState);
        var r4 = await Adim(ortam, "dün 14:00 deneme", r3.SessionState);
        var r5 = await Adim(ortam, "two_step", r4.SessionState);
        Assert.Equal("strategy", r5.Step);

        // 120 dk onaylandı; state'i 240 dk ile YENİDEN imzala (fingerprint eski planın).
        var veri = Payload(r5.SessionState!)["data"]!.AsObject();
        veri["minutes"] = 240;
        var sahte = WizardStateCodec.Sign(ortam.Cfg, "strategy", veri);

        var oncekiKayitSayisi = (await ToolImpl.ListTimeEntriesAsync(
            ortam.Adapter, "$me", null, null, null, 100, CancellationToken.None)).TimeEntries.Count;

        var r6 = await Adim(ortam, "evet", sahte);

        Assert.True(r6.Done);
        Assert.Equal("done", r6.Step);
        Assert.NotEmpty(r6.Errors);
        Assert.Null(r6.WriteResult);
        Assert.Contains("REDDEDİLDİ", r6.Reply);

        // Hiçbir mutation gitmedi — kayıt sayısı değişmedi.
        var sonrakiKayitSayisi = (await ToolImpl.ListTimeEntriesAsync(
            ortam.Adapter, "$me", null, null, null, 100, CancellationToken.None)).TimeEntries.Count;
        Assert.Equal(oncekiKayitSayisi, sonrakiKayitSayisi);
    }

    [Fact]
    public async Task increment_katina_uymayan_sure_sorulur_adim_degismez()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);
        var r2 = await Adim(ortam, "1", r1.SessionState);

        // timeIncrement=30 → 45 kabul edilmez; sihirbaz yuvarlamayı SORAR.
        var r3 = await Adim(ortam, "45", r2.SessionState);

        Assert.Equal("pick_work", r3.Step);
        Assert.Contains("30", r3.Reply);
        Assert.Contains("60", r3.Reply);   // önerilen üst değer

        var r4 = await Adim(ortam, "60", r3.SessionState);
        Assert.Equal("duration", r4.Step);
    }

    // ── Takvim dalı ──────────────────────────────────────────────────────────

    [Fact]
    public async Task takvim_cevabi_calendar_plan_dalina_gecer()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);
        var r2 = await Adim(ortam, "takvim", r1.SessionState);

        Assert.Equal("calendar_plan", r2.Step);
        Assert.False(r2.Done);
        Assert.NotNull(r2.SessionState);
        Assert.Contains("öneri", r2.Reply);
        Assert.Equal("calendar_plan", Payload(r2.SessionState!)["step"]!.GetValue<string>());

        // Taslak, sözleşmedeki {date, entries[]} biçimiyle state'te taşınır.
        var taslak = Payload(r2.SessionState!)["data"]!["calendarDraft"]!.AsObject();
        Assert.True(taslak["entries"]!.AsArray().Count > 0);
        Assert.False(string.IsNullOrEmpty(taslak["date"]!.GetValue<string>()));
    }

    [Fact]
    public async Task takvim_dalinda_haric_elemesi_ve_bulk_onay_akisi_calisir()
    {
        var ortam = Kur();
        var r1 = await Adim(ortam, null, null);
        var r2 = await Adim(ortam, "takvim", r1.SessionState);
        Assert.Equal("calendar_plan", r2.Step);

        var once = Payload(r2.SessionState!)["data"]!["calendarDraft"]!["entries"]!.AsArray().Count;
        Assert.True(once > 0);

        // '1 hariç' — ilk kalem çıkar, adım değişmez.
        var r3 = await Adim(ortam, "1 hariç", r2.SessionState);
        Assert.Equal("calendar_plan", r3.Step);
        Assert.Equal(once - 1,
            Payload(r3.SessionState!)["data"]!["calendarDraft"]!["entries"]!.AsArray().Count);

        // evet → bulk dry-run özeti + atomiklik uyarısı.
        var r4 = await Adim(ortam, "evet", r3.SessionState);
        Assert.Equal("calendar_confirm", r4.Step);
        Assert.Contains("ATOMİK DEĞİLDİR", r4.Reply);
        Assert.False(string.IsNullOrEmpty(
            Payload(r4.SessionState!)["data"]!["plannedFingerprint"]!.GetValue<string>()));

        // evet → bulk yazım + geri-okuma → step "write", done=true.
        var r5 = await Adim(ortam, "evet", r4.SessionState);
        Assert.True(r5.Done);
        Assert.Equal("write", r5.Step);
        Assert.NotNull(r5.WriteResult);
        Assert.Contains("GERİ-OKUMA", r5.Reply);
        Assert.Null(r5.SessionState);
    }
}
