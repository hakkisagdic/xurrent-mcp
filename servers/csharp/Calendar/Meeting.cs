using System.Text.Json.Serialization;

namespace XurrentMcp.Calendars;

/// <summary>
/// Sağlayıcıdan bağımsız, normalize edilmiş toplantı kaydı.
/// Microsoft Graph ve Google Calendar alanlarının BİRLEŞİMİDİR — her adapter
/// kendi ham şeklini bu tipe çevirir.
/// </summary>
public sealed record Meeting(
    [property: JsonPropertyName("source")] string Source,
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("uid")] string Uid,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("start")] string Start,
    [property: JsonPropertyName("end")] string End,
    [property: JsonPropertyName("minutes")] int Minutes,
    [property: JsonPropertyName("isAllDay")] bool IsAllDay,
    [property: JsonPropertyName("isCancelled")] bool IsCancelled,
    [property: JsonPropertyName("declined")] bool Declined,
    [property: JsonPropertyName("free")] bool Free,
    [property: JsonPropertyName("skipped")] bool Skipped,
    [property: JsonPropertyName("skipReason")] string? SkipReason,
    [property: JsonPropertyName("organizer")] string? Organizer,
    [property: JsonPropertyName("attendeeCount")] int AttendeeCount,
    [property: JsonPropertyName("categories")] IReadOnlyList<string> Categories,
    [property: JsonPropertyName("seriesId")] string? SeriesId,
    [property: JsonPropertyName("joinUrl")] string? JoinUrl)
{
    [JsonIgnore] public DateTimeOffset StartInstant => DateTimeOffset.Parse(Start);
    [JsonIgnore] public DateTimeOffset EndInstant => DateTimeOffset.Parse(End);
}

/// <summary>Sağlayıcıların HAM çıktısı. Filtreleme/kırpma/dedup ortak katmanda yapılır.</summary>
public sealed class RawEvent
{
    public string Id { get; set; } = "";
    public string ICalUid { get; set; } = "";
    public string Title { get; set; } = "";
    public DateTimeOffset Start { get; set; }
    public DateTimeOffset End { get; set; }
    public bool IsAllDay { get; set; }
    public bool IsCancelled { get; set; }
    public bool Declined { get; set; }
    public bool Free { get; set; }
    public string? Organizer { get; set; }
    public int AttendeeCount { get; set; }
    public List<string> Categories { get; set; } = [];
    public string? SeriesId { get; set; }
    public string? JoinUrl { get; set; }
}

/// <summary>Takvim okuma penceresi — HER ZAMAN yerel gece yarısından yerel gece yarısına.</summary>
public sealed record CalendarWindow(DateOnly Date, DateTimeOffset Start, DateTimeOffset End, TimeZoneInfo TimeZone);

public sealed record CalendarOptions(
    bool IncludeAllDay = false,
    bool IncludeDeclined = false,
    bool IncludeFree = false,
    string? UserEmail = null);

public interface ICalendarProvider
{
    /// <summary>"mock" | "ics" | "google" | "graph"</summary>
    string Name { get; }

    Task<IReadOnlyList<RawEvent>> FetchAsync(CalendarWindow window, CalendarOptions options, CancellationToken ct);
}
