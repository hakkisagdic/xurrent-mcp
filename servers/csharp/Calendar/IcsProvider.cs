using System.Globalization;
using System.Text;

namespace XurrentMcp.Calendars;

/// <summary>
/// .ics (iCalendar, RFC 5545) dosyası veya yayınlanmış URL okuyan sağlayıcı.
///
/// NEDEN kendi ayrıştırıcımız var: .ics'in tek zor tarafı satır katlamadır
/// (folding — 75 oktetten uzun satırlar bir boşluk/tab ile alt satıra taşar).
/// Bunun dışında ihtiyacımız olan alanlar düz anahtar/değer çiftleridir.
///
/// SINIR: RRULE (tekrar kuralı) BURADA AÇILMAZ. .ics dosyaları seri master'ı ham
/// RRULE ile taşır; occurrence üretmek ayrı bir iştir. Bu yüzden ders demosunda
/// scripts/gen-ics.mjs dosyayı o günkü tarihe göre YENİDEN ÜRETİR.
/// </summary>
public sealed class IcsCalendarProvider(AppConfig cfg, HttpClient http) : ICalendarProvider
{
    public string Name => "ics";

    public async Task<IReadOnlyList<RawEvent>> FetchAsync(CalendarWindow window, CalendarOptions options, CancellationToken ct)
    {
        string content;
        if (!string.IsNullOrWhiteSpace(cfg.CalendarIcsUrl))
            content = await http.GetStringAsync(cfg.CalendarIcsUrl, ct);
        else
        {
            var path = AppConfig.ExpandHome(cfg.CalendarIcsPath);
            if (!File.Exists(path))
                throw new FileNotFoundException(
                    $"ICS dosyası bulunamadı: {path}. 'node scripts/gen-ics.mjs' ile üretin.", path);
            content = await File.ReadAllTextAsync(path, ct);
        }

        var events = new List<RawEvent>();
        foreach (var block in SplitVEvents(Unfold(content)))
        {
            var start = ParseIcsTime(Get(block, "DTSTART"), window.TimeZone, out var startIsDate);
            var end = ParseIcsTime(Get(block, "DTEND"), window.TimeZone, out _);
            if (start is null) continue;
            end ??= startIsDate ? start.Value.AddDays(1) : start.Value.AddHours(1);

            if (end <= window.Start || start >= window.End) continue;

            var status = Get(block, "STATUS")?.Value?.ToUpperInvariant();
            var partStat = Get(block, "ATTENDEE")?.Params.GetValueOrDefault("PARTSTAT")?.ToUpperInvariant();

            events.Add(new RawEvent
            {
                Id = Get(block, "UID")?.Value ?? Guid.NewGuid().ToString(),
                ICalUid = Get(block, "UID")?.Value ?? "",
                Title = Get(block, "SUMMARY")?.Value ?? "(başlıksız)",
                Start = start.Value,
                End = end.Value,
                // DTSTART;VALUE=DATE  -> tüm gün etkinliği
                IsAllDay = startIsDate,
                IsCancelled = status == "CANCELLED",
                Declined = partStat == "DECLINED",
                // TRANSP:TRANSPARENT = "meşgul değil". Alan YOKSA varsayılan OPAQUE'tir.
                Free = string.Equals(Get(block, "TRANSP")?.Value, "TRANSPARENT", StringComparison.OrdinalIgnoreCase),
                Organizer = Get(block, "ORGANIZER")?.Value?.Replace("mailto:", "", StringComparison.OrdinalIgnoreCase),
                AttendeeCount = block.Count(l => l.Key == "ATTENDEE"),
                Categories = Get(block, "CATEGORIES")?.Value?.Split(',', StringSplitOptions.RemoveEmptyEntries).ToList() ?? [],
                SeriesId = Get(block, "RRULE") is not null ? Get(block, "UID")?.Value : null,
                JoinUrl = Get(block, "URL")?.Value,
            });
        }

        return events;
    }

    // ── Ayrıştırma yardımcıları ──────────────────────────────────────────────

    private sealed record IcsLine(string Key, Dictionary<string, string> Params, string? Value);

    /// <summary>RFC 5545 satır katlamasını (folding) geri açar.</summary>
    private static string Unfold(string raw)
    {
        var sb = new StringBuilder(raw.Length);
        foreach (var line in raw.Replace("\r\n", "\n").Split('\n'))
        {
            if (line.Length > 0 && (line[0] == ' ' || line[0] == '\t')) sb.Append(line[1..]);
            else { if (sb.Length > 0) sb.Append('\n'); sb.Append(line); }
        }
        return sb.ToString();
    }

    private static IEnumerable<List<IcsLine>> SplitVEvents(string unfolded)
    {
        List<IcsLine>? current = null;
        foreach (var line in unfolded.Split('\n'))
        {
            if (line.StartsWith("BEGIN:VEVENT", StringComparison.Ordinal)) { current = []; continue; }
            if (line.StartsWith("END:VEVENT", StringComparison.Ordinal))
            {
                if (current is not null) yield return current;
                current = null;
                continue;
            }
            if (current is null) continue;

            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            var head = line[..colon];
            var value = line[(colon + 1)..];

            var parts = head.Split(';');
            var pars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in parts.Skip(1))
            {
                var eq = p.IndexOf('=');
                if (eq > 0) pars[p[..eq]] = p[(eq + 1)..];
            }
            current.Add(new IcsLine(parts[0].ToUpperInvariant(), pars, value));
        }
    }

    private static IcsLine? Get(List<IcsLine> block, string key)
        => block.FirstOrDefault(l => l.Key == key);

    /// <summary>
    /// DTSTART/DTEND ayrıştırır. Üç biçim vardır ve üçü de FARKLI anlama gelir:
    ///   20260802T090000Z        -> UTC
    ///   TZID=Europe/Istanbul:20260802T090000 -> belirtilen bölgede yerel saat
    ///   VALUE=DATE:20260802     -> tüm gün (exclusive end date!)
    /// </summary>
    private static DateTimeOffset? ParseIcsTime(IcsLine? line, TimeZoneInfo fallbackTz, out bool isDateOnly)
    {
        isDateOnly = false;
        if (line?.Value is not { Length: > 0 } v) return null;

        if (line.Params.GetValueOrDefault("VALUE") is "DATE" || v.Length == 8)
        {
            isDateOnly = true;
            if (!DateOnly.TryParseExact(v, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
                return null;
            return TimeUtil.AtLocal(d, TimeOnly.MinValue, fallbackTz);
        }

        var utc = v.EndsWith('Z');
        var core = utc ? v[..^1] : v;
        if (!DateTime.TryParseExact(core, "yyyyMMdd'T'HHmmss", CultureInfo.InvariantCulture,
                DateTimeStyles.None, out var naive))
            return null;

        if (utc) return new DateTimeOffset(naive, TimeSpan.Zero);

        var tz = fallbackTz;
        if (line.Params.GetValueOrDefault("TZID") is { Length: > 0 } tzid)
        {
            try { tz = TimeZoneInfo.FindSystemTimeZoneById(tzid); }
            catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException) { /* fallback */ }
        }
        return new DateTimeOffset(naive, tz.GetUtcOffset(naive));
    }
}
