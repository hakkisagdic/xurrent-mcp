namespace XurrentMcp.Calendars;

/// <summary>
/// Sağlayıcı seçimi + TÜM sağlayıcılar için ORTAK normalizasyon.
/// Filtreleme, pencereye kırpma, dedup ve süre hesabı burada TEK YERDE yapılır;
/// sağlayıcılar yalnızca kendi alanlarını RawEvent'e çevirmekle sorumludur.
/// </summary>
public sealed class CalendarFactory(AppConfig cfg, HttpClient http)
{
    public ICalendarProvider Create(string requested)
    {
        var name = string.IsNullOrWhiteSpace(requested) || requested == "auto" ? Auto() : requested;
        return name switch
        {
            "graph" => new GraphCalendarProvider(cfg, http),
            "google" => new GoogleCalendarProvider(cfg, http),
            "ics" => new IcsCalendarProvider(cfg, http),
            _ => new MockCalendarProvider(cfg),
        };
    }

    /// <summary>auto: yapılandırılmış olan ilk sağlayıcı — graph → google → ics → mock.</summary>
    private string Auto()
    {
        if (cfg.CalendarProvider is not ("auto" or "")) return cfg.CalendarProvider;
        if (!string.IsNullOrWhiteSpace(cfg.MsTenantId) && !string.IsNullOrWhiteSpace(cfg.MsClientId)) return "graph";
        if (!string.IsNullOrWhiteSpace(cfg.GoogleClientId)) return "google";
        if (!string.IsNullOrWhiteSpace(cfg.CalendarIcsUrl) ||
            File.Exists(AppConfig.ExpandHome(cfg.CalendarIcsPath))) return "ics";
        return "mock";
    }

    /// <summary>Pencere HER ZAMAN yerel gece yarısından yerel gece yarısına kurulur.</summary>
    public CalendarWindow BuildWindow(string? date, string? timeZoneId)
    {
        var tz = ResolveTimeZone(timeZoneId ?? cfg.TimeZoneId);
        var day = string.IsNullOrWhiteSpace(date) ? TimeUtil.Today(tz, cfg.Clock) : TimeUtil.ParseDate(date, tz);
        return new CalendarWindow(day, TimeUtil.LocalMidnight(day, tz), TimeUtil.LocalMidnight(day.AddDays(1), tz), tz);
    }

    private TimeZoneInfo ResolveTimeZone(string id)
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById(id); }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException) { return cfg.TimeZone; }
    }

    public Task<CalendarResult> ReadAsync(
        string providerName, CalendarWindow window, CalendarOptions options, CancellationToken ct)
        => ReadAsync(Create(providerName), window, options, ct);

    /// <summary>
    /// Normalizasyonun gerçek gövdesi. Sağlayıcı DIŞARIDAN verilebilir; böylece
    /// filtre/kırpma/dedup kuralları ağ ya da dosya olmadan, sentetik RawEvent'lerle
    /// birim testine tabi tutulabilir (bkz. XurrentMcp.Tests/TakvimTests.cs).
    /// </summary>
    public async Task<CalendarResult> ReadAsync(
        ICalendarProvider provider, CalendarWindow window, CalendarOptions options, CancellationToken ct)
    {
        var raw = await provider.FetchAsync(window, options, ct);

        // ── DEDUP ────────────────────────────────────────────────────────────
        // iCalUID TEK BAŞINA yetmez: Graph'te her occurrence farklı bir UID taşır,
        // Google'da ise seri boyunca AYNI UID döner. Anahtara start instant'ı eklenir.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var meetings = new List<Meeting>();

        foreach (var e in raw.OrderBy(e => e.Start))
        {
            var uid = $"{e.ICalUid}@{e.Start.ToUnixTimeSeconds()}";
            if (!seen.Add(uid)) continue;

            // ── PENCEREYE KIRPMA ─────────────────────────────────────────────
            // Filtre bir OVERLAP filtresidir: dün 23:00'te başlayıp bugün 01:00'de biten
            // toplantı da döner. Süreyi doğru saymak için pencereye kırpıyoruz.
            var start = e.Start < window.Start ? window.Start : e.Start;
            var end = e.End > window.End ? window.End : e.End;

            var (skipped, reason) = Classify(e, options);

            // Tüm gün etkinliğinin süresi instant'lardan HESAPLANMAZ (exclusive end date).
            var minutes = e.IsAllDay ? 0 : Math.Max(0, (int)Math.Round((end - start).TotalMinutes));

            meetings.Add(new Meeting(
                Source: provider.Name,
                Id: e.Id,
                Uid: uid,
                Title: e.Title,
                Start: TimeUtil.ToIso(start),
                End: TimeUtil.ToIso(end),
                Minutes: minutes,
                IsAllDay: e.IsAllDay,
                IsCancelled: e.IsCancelled,
                Declined: e.Declined,
                Free: e.Free,
                Skipped: skipped,
                SkipReason: reason,
                Organizer: e.Organizer,
                AttendeeCount: e.AttendeeCount,
                Categories: e.Categories,
                SeriesId: e.SeriesId,
                JoinUrl: e.JoinUrl));
        }

        var real = meetings.Where(m => !m.Skipped).ToList();

        // busyMinutes: çakışmalar BİR KEZ sayılır (interval merge).
        var busy = TimeUtil.MergedMinutes(real.Select(m => (m.StartInstant, m.EndInstant)));
        // naiveSumMinutes: çakışmaları ayrı sayan naif toplam. İkisi de raporlanır —
        // farkı görmek dersin bir parçasıdır.
        var naive = real.Sum(m => m.Minutes);

        return new CalendarResult(
            TimeUtil.ToIso(window.Start),
            TimeUtil.ToIso(window.End),
            window.TimeZone.Id,
            provider.Name,
            meetings,
            new CalendarTotals(real.Count, busy, naive, meetings.Count, meetings.Count - real.Count));
    }

    /// <summary>
    /// Eleme kuralları. SIRA ÖNEMLİDİR: doğum günü hem isAllDay hem free'dir;
    /// öğretici olan gerekçe "tüm gün" olduğu için o önce kontrol edilir.
    /// </summary>
    private static (bool Skipped, string? Reason) Classify(RawEvent e, CalendarOptions o)
    {
        if (e.IsCancelled)
            return (true, "İptal edilmiş etkinlik — takvimde durur ama gerçekleşmemiştir.");

        if (e.IsAllDay && !o.IncludeAllDay)
            return (true, "Tüm gün etkinliği — süresi instant'lardan hesaplanamaz (her iki API de exclusive end date kullanır).");

        if (e.Declined && !o.IncludeDeclined)
            return (true, "Reddedilmiş toplantı — takvimde kalmaya devam eder ama çalışılmamıştır; sunucu tarafında filtre YOKTUR.");

        if (e.Free && !o.IncludeFree)
            return (true, "Meşgul değil (Graph: showAs=free, Google: transparency=transparent) — takvimde yer kaplar ama çalışma değildir.");

        return (false, null);
    }
}
