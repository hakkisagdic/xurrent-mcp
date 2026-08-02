using System.Text.Json.Nodes;

namespace XurrentMcp.Calendars;

/// <summary>
/// fixtures/calendar.json'ı okuyan sağlayıcı.
/// Fixture'da MUTLAK TARİH YOKTUR: her etkinlik dayOffset (bugüne göre gün farkı) ve
/// startLocal/endLocal ("HH:mm", kişinin saat diliminde) taşır. Demo hangi gün
/// çalıştırılırsa çalıştırılsın aynı sonucu üretsin diye tarihler YÜKLEME ANINDA
/// materyalize edilir:  instant = zonedDateTime(today + dayOffset, startLocal, timeZone)
/// </summary>
public sealed class MockCalendarProvider(AppConfig cfg) : ICalendarProvider
{
    public string Name => "mock";

    public Task<IReadOnlyList<RawEvent>> FetchAsync(CalendarWindow window, CalendarOptions options, CancellationToken ct)
    {
        var path = Path.Combine(cfg.FixturesDir, "calendar.json");
        var doc = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
        var tz = window.TimeZone;
        var today = TimeUtil.Today(tz);

        var result = new List<RawEvent>();
        foreach (var node in doc["events"]!.AsArray())
        {
            var e = node!.AsObject();
            var dayOffset = Num(e, "dayOffset") ?? 0;
            var date = today.AddDays(dayOffset);

            var start = TimeUtil.AtLocal(date, TimeUtil.ParseHhMm(Text(e, "startLocal")), tz);
            var endTime = TimeUtil.ParseHhMm(Text(e, "endLocal"));
            var isAllDay = Flag(e, "isAllDay");

            // Tüm gün etkinliğinin süresi instant'lardan HESAPLANMAZ: her iki gerçek API de
            // exclusive end date kullanır (tek günlük all-day: start=bugün, end=YARIN).
            var end = isAllDay
                ? TimeUtil.AtLocal(date.AddDays(1), TimeOnly.MinValue, tz)
                : TimeUtil.AtLocal(date, endTime, tz);

            // Sağlayıcı bir OVERLAP filtresi uygular: pencereyle kesişen her etkinlik döner.
            if (end <= window.Start || start >= window.End) continue;

            result.Add(new RawEvent
            {
                Id = Text(e, "id") ?? "",
                ICalUid = Text(e, "iCalUID") ?? Text(e, "id") ?? "",
                Title = Text(e, "title") ?? "(başlıksız)",
                Start = start,
                End = end,
                IsAllDay = isAllDay,
                IsCancelled = Flag(e, "isCancelled"),
                Declined = Flag(e, "declined"),
                Free = Flag(e, "free"),
                Organizer = Text(e, "organizer"),
                AttendeeCount = Num(e, "attendeeCount") ?? 0,
                Categories = (e["categories"] as JsonArray ?? []).Select(c => c!.GetValue<string>()).ToList(),
                SeriesId = Text(e, "seriesId"),
                JoinUrl = Text(e, "joinUrl"),
            });
        }

        return Task.FromResult<IReadOnlyList<RawEvent>>(result);
    }

    private static string? Text(JsonObject o, string k) => Xurrent.MockAdapter.Str(o, k);
    private static int? Num(JsonObject o, string k) => Xurrent.MockAdapter.Int(o, k);
    private static bool Flag(JsonObject o, string k) => Xurrent.MockAdapter.Bool(o, k) ?? false;
}
