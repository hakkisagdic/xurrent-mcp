using XurrentMcp.Calendars;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ SABİTLENMİŞ SAAT.
///
/// Bu repoda gerçek bir olay yaşandı: "bugün"e dayanan bir doğrulama gece yarısından
/// sonra kırıldı. Sebep şuydu — yerel saat 00:00–03:00 arasındayken (Europe/Istanbul = UTC+3)
/// UTC tarihi BİR GÜN GERİDEDİR. Test kendi beklentisini "şu anki gün"den üretirse,
/// testin doğruluğu ÇALIŞTIRILDIĞI SAATE bağlı olur.
///
/// Çözüm: zaman bir bağımlılıktır ve enjekte edilir. Üretimde TimeProvider.System,
/// testte bu sınıf.
/// </summary>
public sealed class SabitSaat(DateTimeOffset an) : TimeProvider
{
    public DateTimeOffset An { get; set; } = an;

    public override DateTimeOffset GetUtcNow() => An;

    /// <summary>Saati ileri alır — TTL / süre dolması senaryoları gerçek zaman beklemeden test edilir.</summary>
    public SabitSaat Ilerlet(TimeSpan sure)
    {
        An = An.Add(sure);
        return this;
    }
}

/// <summary>
/// Testlerin ortak kurulum yardımcıları.
///
/// KURAL: testler ağ KULLANMAZ, yazma I/O YAPMAZ ve gerçek zamana BAĞLI DEĞİLDİR.
/// Fixture okumak serbesttir — zaten üç dilin de paylaştığı tek gerçek kaynak odur.
/// </summary>
public static class Ortam
{
    public const string SaatDilimiId = "Europe/Istanbul";

    /// <summary>
    /// Testlerin varsayılan "şimdi"si: 3 Ağustos 2026, 09:00 yerel (06:00 UTC).
    /// Gün ortası bilinçli seçildi — gün sınırına yakın davranış AYRI testlerde,
    /// açıkça o sınıra kurulmuş saatlerle sınanır (bkz. ZamanTests).
    /// </summary>
    public static readonly DateTimeOffset VarsayilanAn = new(2026, 8, 3, 6, 0, 0, TimeSpan.Zero);

    public static TimeZoneInfo SaatDilimi => TimeZoneInfo.FindSystemTimeZoneById(SaatDilimiId);

    /// <summary>Fixture'ların yeri: contract/tools.json'ı barındıran dizinin altındaki fixtures/.</summary>
    public static string RepoKoku { get; } = BulRepoKoku();

    public static string FixtureDizini => Path.Combine(RepoKoku, "fixtures");

    /// <summary>Fixture sözleşmesindeki demo kullanıcı (people.json → me).</summary>
    public const string BenId = "TW9jay9QZXJzb24vMQ";

    /// <summary>Ayşe'nin iş arkadaşı — "başkası adına yazma" senaryosu için.</summary>
    public const string BaskasiId = "TW9jay9QZXJzb24vMg";

    public const string Request70248 = "TW9jay9SZXF1ZXN0LzcwMjQ4";
    public const string Request70301 = "TW9jay9SZXF1ZXN0LzcwMzAx";
    public const string Request70315 = "TW9jay9SZXF1ZXN0LzcwMzE1";
    public const string Task4412 = "TW9jay9UYXNrLzQ0MTI";
    public const string Task4419 = "TW9jay9UYXNrLzQ0MTk";

    /// <summary>İç toplantılar — descriptionRequired=false.</summary>
    public const string Allocation1 = "TW9jay9UaW1lQWxsb2NhdGlvbi8x";

    /// <summary>Eğitim ve gelişim — descriptionRequired=TRUE.</summary>
    public const string Allocation2 = "TW9jay9UaW1lQWxsb2NhdGlvbi8y";

    public const string EffortClass1 = "TW9jay9FZmZvcnRDbGFzcy8x";

    /// <summary>
    /// Test yapılandırması. AppConfig.Load() BİLEREK çağrılmaz: o, .env dosyasını ve
    /// süreç ortam değişkenlerini okur — yani testin sonucu makinenin durumuna bağlanırdı.
    /// </summary>
    public static AppConfig Yapilandirma(
        SabitSaat? saat = null,
        string backdateStrategy = "two_step",
        int maxBackdateDays = 1,
        bool dryRun = false,
        string confirmPolicy = "closed",
        string defaultAllocationId = Allocation1,
        int stateTtlSaniye = 300,
        string stateSecret = "test-imza-anahtari",
        string roundingMode = "nearest")
        => new()
        {
            RepoRoot = RepoKoku,
            FixturesDir = FixtureDizini,
            XurrentMode = "mock",
            XurrentDryRun = dryRun,
            XurrentConfirmPolicy = confirmPolicy,
            XurrentSource = "xurrent-mcp",
            StateSecret = stateSecret,
            StateTtlSeconds = stateTtlSaniye,
            BackdateStrategy = backdateStrategy,
            MaxBackdateDays = maxBackdateDays,
            CalendarProvider = "mock",
            TimeZoneId = SaatDilimiId,
            DefaultTimeAllocationId = defaultAllocationId,
            RoundingMode = roundingMode,
            Clock = saat ?? new SabitSaat(VarsayilanAn),
        };

    /// <summary>Yapılandırmanın sabit saatine göre "bugün".</summary>
    public static DateOnly Bugun(AppConfig cfg) => TimeUtil.Today(cfg.TimeZone, cfg.Clock);

    public static string BugunMetin(AppConfig cfg) => Bugun(cfg).ToString("yyyy-MM-dd");

    public static string GunMetin(AppConfig cfg, int gunFarki)
        => Bugun(cfg).AddDays(gunFarki).ToString("yyyy-MM-dd");

    private static string BulRepoKoku()
    {
        foreach (var baslangic in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var dizin = new DirectoryInfo(baslangic);
            while (dizin is not null)
            {
                if (File.Exists(Path.Combine(dizin.FullName, "contract", "tools.json")))
                    return dizin.FullName;
                dizin = dizin.Parent;
            }
        }
        throw new DirectoryNotFoundException("Repo kökü bulunamadı (contract/tools.json aranıyordu).");
    }
}

/// <summary>
/// Sentetik takvim sağlayıcısı. CalendarFactory'nin filtre / kırpma / dedup katmanını
/// ağ ve dosya olmadan, tam kontrollü ham etkinliklerle sınamak için.
/// </summary>
public sealed class SahteTakvim(params RawEvent[] etkinlikler) : ICalendarProvider
{
    public string Name => "sahte";

    public Task<IReadOnlyList<RawEvent>> FetchAsync(
        CalendarWindow window, CalendarOptions options, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<RawEvent>>(etkinlikler);
}

/// <summary>Ham etkinlik üretmeyi tek satıra indiren yardımcı.</summary>
public static class HamEtkinlik
{
    public static RawEvent Olustur(
        string baslik,
        DateTimeOffset baslangic,
        DateTimeOffset bitis,
        string? uid = null,
        string? id = null,
        bool tumGun = false,
        bool iptal = false,
        bool reddedildi = false,
        bool mesgulDegil = false)
        => new()
        {
            Id = id ?? uid ?? baslik,
            ICalUid = uid ?? id ?? baslik,
            Title = baslik,
            Start = baslangic,
            End = bitis,
            IsAllDay = tumGun,
            IsCancelled = iptal,
            Declined = reddedildi,
            Free = mesgulDegil,
            AttendeeCount = 2,
        };
}
