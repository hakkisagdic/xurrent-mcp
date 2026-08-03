using System.Globalization;

namespace XurrentMcp;

/// <summary>
/// Saat dilimi / ISO8601 yardımcıları.
/// Bu projede tek bir kural var: HİÇBİR ZAMAN çıplak (offset'siz) timestamp üretme.
/// </summary>
public static class TimeUtil
{
    /// <summary>Sözleşme formatı: offset ZORUNLU, kesirli saniye YOK.</summary>
    public const string Iso = "yyyy-MM-dd'T'HH:mm:sszzz";

    public static string ToIso(DateTimeOffset value) => value.ToString(Iso, CultureInfo.InvariantCulture);

    /// <summary>
    /// Verilen saat diliminde "bugün".
    ///
    /// ★ SAAT DİLİMİ TUZAĞI: yerel saat 00:00–03:00 arasındayken UTC tarihi BİR GÜN
    /// GERİDEDİR (Europe/Istanbul = UTC+3). Bu yüzden UTC anı ÖNCE hedef saat dilimine
    /// çevrilir, tarih SONRA alınır. Bu repoda tam olarak bu yüzden gece kırılan bir test
    /// yaşandı — testler bu davranışı SABİT bir <paramref name="clock"/> ile doğrular.
    ///
    /// <paramref name="clock"/> ENJEKTE EDİLEBİLİRDİR: null ise sistem saati kullanılır
    /// (üretim yolu), testlerde ise sabitlenmiş bir TimeProvider geçilir.
    /// </summary>
    public static DateOnly Today(TimeZoneInfo tz, TimeProvider? clock = null)
        => DateOnly.FromDateTime(
            TimeZoneInfo.ConvertTime((clock ?? TimeProvider.System).GetUtcNow(), tz).DateTime);

    /// <summary>
    /// Yerel duvar saatini (date + HH:mm) o saat dilimindeki MUTLAK ana çevirir.
    /// NEDEN GetUtcOffset(DateTime): Unspecified kind'li bir DateTime, o zaman diliminde
    /// yerel saat olarak yorumlanır — DST geçişleri böylece doğru uygulanır.
    /// </summary>
    public static DateTimeOffset AtLocal(DateOnly date, TimeOnly time, TimeZoneInfo tz)
    {
        var naive = date.ToDateTime(time, DateTimeKind.Unspecified);
        return new DateTimeOffset(naive, tz.GetUtcOffset(naive));
    }

    public static DateTimeOffset LocalMidnight(DateOnly date, TimeZoneInfo tz)
        => AtLocal(date, TimeOnly.MinValue, tz);

    /// <summary>"HH:mm" ayrıştırır. Boş/bozuk değer 00:00 döner.</summary>
    public static TimeOnly ParseHhMm(string? value)
        => TimeOnly.TryParseExact(value ?? "", "HH:mm", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out var t) ? t : TimeOnly.MinValue;

    /// <summary>"yyyy-MM-dd" ayrıştırır. Bozuk değer sessizce "bugün"e düşer.</summary>
    public static DateOnly ParseDate(string value, TimeZoneInfo tz, TimeProvider? clock = null)
        => DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture,
            DateTimeStyles.None, out var d) ? d : Today(tz, clock);

    /// <summary>
    /// Microsoft Graph'in dateTime alanını ayrıştırır.
    /// TUZAK: Graph "2026-08-02T09:00:00.0000000" gibi OFFSET TAŞIMAYAN ve 7 kesirli
    /// hane içeren bir string döner. Doğrudan DateTime.Parse edilirse SUNUCUNUN yerel
    /// saati sanılır. Graph'in ayrı gelen timeZone alanı (Prefer header göndermezsek
    /// "UTC"dir) uygulanmak zorundadır.
    /// </summary>
    public static DateTimeOffset ParseGraphDateTime(string dateTime, string? timeZone)
    {
        // 7 kesirli haneyi 3'e indir — bazı .NET sürümleri 7 haneyi kabul etse de garanti altına alıyoruz.
        var trimmed = System.Text.RegularExpressions.Regex.Replace(dateTime, @"(\.\d{3})\d+$", "$1");
        var naive = DateTime.Parse(trimmed, CultureInfo.InvariantCulture, DateTimeStyles.None);
        naive = DateTime.SpecifyKind(naive, DateTimeKind.Unspecified);

        if (string.IsNullOrWhiteSpace(timeZone) || timeZone.Equals("UTC", StringComparison.OrdinalIgnoreCase))
            return new DateTimeOffset(naive, TimeSpan.Zero); // Prefer header göndermediğimiz için beklenen yol

        try
        {
            var tz = TimeZoneInfo.FindSystemTimeZoneById(timeZone);
            return new DateTimeOffset(naive, tz.GetUtcOffset(naive));
        }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException)
        {
            return new DateTimeOffset(naive, TimeSpan.Zero);
        }
    }

    /// <summary>Çakışan aralıkları BİRLEŞTİRİP toplam dakikayı verir (çakışma bir kez sayılır).</summary>
    public static int MergedMinutes(IEnumerable<(DateTimeOffset Start, DateTimeOffset End)> intervals)
    {
        var sorted = intervals.Where(i => i.End > i.Start).OrderBy(i => i.Start).ToList();
        var total = 0.0;
        DateTimeOffset? curStart = null, curEnd = null;
        foreach (var (s, e) in sorted)
        {
            if (curStart is null) { curStart = s; curEnd = e; continue; }
            if (s <= curEnd) { if (e > curEnd) curEnd = e; }
            else { total += (curEnd!.Value - curStart.Value).TotalMinutes; curStart = s; curEnd = e; }
        }
        if (curStart is not null) total += (curEnd!.Value - curStart.Value).TotalMinutes;
        return (int)Math.Round(total, MidpointRounding.AwayFromZero);
    }

    /// <summary>timeIncrement katına yuvarlar. mode: nearest | up | down.</summary>
    public static int RoundToIncrement(int minutes, int increment, string mode)
    {
        if (increment <= 0) return minutes;
        var q = (double)minutes / increment;
        var steps = mode switch
        {
            "up" => (int)Math.Ceiling(q),
            "down" => (int)Math.Floor(q),
            _ => (int)Math.Round(q, MidpointRounding.AwayFromZero),
        };
        if (steps < 1) steps = 1; // 0 dakikalık giriş anlamsız; en az bir artım
        return steps * increment;
    }
}
