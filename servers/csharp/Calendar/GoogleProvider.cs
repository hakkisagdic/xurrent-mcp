using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace XurrentMcp.Calendars;

/// <summary>
/// Google Calendar API v3 sağlayıcısı.
///
/// ★ EN KRİTİK PARAMETRE: singleEvents.
///   Varsayılanı FALSE'tur. true yapılmazsa tekrarlayan toplantılar AÇILMAZ —
///   API seri master'ı ham RRULE ile döner ve o günkü occurrence'ı hiç göremezsin.
///   orderBy='startTime' de YALNIZCA singleEvents=true iken çalışır.
///
/// ★ transparency alanı varsayılan değeri "opaque" iken CEVAPTA HİÇ ÇIKMAZ.
///   Bu yüzden okurken (transparency ?? "opaque") yazmak zorunludur; aksi halde
///   "alan yok => meşgul değil" gibi yanlış bir çıkarım yapılır.
///
/// ★ timeMin/timeMax OFFSET ZORUNLU (RFC3339). Çıplak timestamp sessizce yanlış gün getirir.
/// </summary>
public sealed class GoogleCalendarProvider(AppConfig cfg, HttpClient http) : ICalendarProvider
{
    public string Name => "google";

    public async Task<IReadOnlyList<RawEvent>> FetchAsync(CalendarWindow window, CalendarOptions options, CancellationToken ct)
    {
        var token = await GetAccessTokenAsync(ct);
        var calendarId = Uri.EscapeDataString(options.UserEmail ?? cfg.GoogleCalendarId);

        var url = $"https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events" +
                  $"?singleEvents=true" +                                   // ← ZORUNLU
                  $"&orderBy=startTime" +                                   // ← singleEvents'e bağımlı
                  $"&maxResults=2500" +
                  $"&timeMin={Uri.EscapeDataString(TimeUtil.ToIso(window.Start))}" +  // ← offset gömülü
                  $"&timeMax={Uri.EscapeDataString(TimeUtil.ToIso(window.End))}";

        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        using var res = await http.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();

        var body = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct))!.AsObject();
        var self = options.UserEmail ?? cfg.GoogleImpersonateUser;

        var events = new List<RawEvent>();
        foreach (var node in body["items"] as JsonArray ?? [])
            if (MapEvent(node!.AsObject(), window.TimeZone, self) is { } mapped)
                events.Add(mapped);

        return events;
    }

    /// <summary>
    /// Google event JSON'ını RawEvent'e çevirir. HTTP'den AYRIŞTIRILMIŞTIR: buradaki
    /// alan tuzakları (transparency alanının HİÇ GELMEMESİ, all-day'in "date" taşıması,
    /// self katılımcının responseStatus'u) ağ olmadan birim testine tabi tutulabilsin diye.
    /// </summary>
    internal static RawEvent? MapEvent(JsonObject e, TimeZoneInfo fallbackTz, string self)
    {
        var startNode = e["start"]?.AsObject();
        var endNode = e["end"]?.AsObject();
        if (startNode is null || endNode is null) return null;

        // All-day etkinlikler dateTime yerine "date" taşır ve end EXCLUSIVE'dir.
        var isAllDay = startNode["dateTime"] is null;
        var start = ParseGoogleTime(startNode, fallbackTz);
        var end = ParseGoogleTime(endNode, fallbackTz);
        if (start is null || end is null) return null;

        // Katılımcı listesinde "self" olan kayıt kullanıcının kendi yanıtıdır.
        var attendees = e["attendees"] as JsonArray ?? [];
        var mine = attendees.Select(a => a!.AsObject()).FirstOrDefault(a =>
            (a["self"]?.GetValue<bool>() ?? false) ||
            (self.Length > 0 && string.Equals(a["email"]?.GetValue<string>(), self, StringComparison.OrdinalIgnoreCase)));

        return new RawEvent
        {
            Id = e["id"]?.GetValue<string>() ?? "",
            ICalUid = e["iCalUID"]?.GetValue<string>() ?? e["id"]?.GetValue<string>() ?? "",
            Title = e["summary"]?.GetValue<string>() ?? "(başlıksız)",
            Start = start.Value,
            End = end.Value,
            IsAllDay = isAllDay,
            IsCancelled = e["status"]?.GetValue<string>() == "cancelled",
            Declined = mine?["responseStatus"]?.GetValue<string>() == "declined",
            // ★ (transparency ?? "opaque") — alan yoksa MEŞGUL demektir.
            Free = (e["transparency"]?.GetValue<string>() ?? "opaque") == "transparent",
            Organizer = e["organizer"]?["email"]?.GetValue<string>(),
            AttendeeCount = attendees.Count,
            // Google'da "categories" yoktur; en yakın karşılık renk etiketidir.
            Categories = [],
            // singleEvents=true iken her occurrence recurringEventId ile seriye bağlanır.
            SeriesId = e["recurringEventId"]?.GetValue<string>(),
            JoinUrl = e["hangoutLink"]?.GetValue<string>(),
        };
    }

    private static DateTimeOffset? ParseGoogleTime(JsonObject node, TimeZoneInfo fallbackTz)
    {
        // dateTime RFC3339'dur ve OFFSET TAŞIR -> doğrudan ayrıştırılabilir (Graph'ten farkı budur).
        if (node["dateTime"]?.GetValue<string>() is { Length: > 0 } dt)
            return DateTimeOffset.Parse(dt);

        if (node["date"]?.GetValue<string>() is { Length: > 0 } d && DateOnly.TryParse(d, out var day))
            return TimeUtil.AtLocal(day, TimeOnly.MinValue, fallbackTz);

        return null;
    }

    /// <summary>
    /// İki kimlik yolu:
    ///  (a) OAuth refresh token — kişisel Gmail hesapları dahil HERKESTE çalışır.
    ///      Token dosyası ~/.xurrent-mcp/google-token.json'dır ve ÜÇ DİL DE aynı dosyayı okur.
    ///      Bilinçli tasarım: OAuth kütüphanesini üç kez yazmak yerine yenilemeyi düz POST'a indirdik.
    ///  (b) Service account + domain-wide delegation — YALNIZCA Google Workspace,
    ///      @gmail.com hesaplarında ÇALIŞMAZ.
    /// </summary>
    private async Task<string> GetAccessTokenAsync(CancellationToken ct)
    {
        var tokenPath = AppConfig.ExpandHome(cfg.GoogleTokenPath);
        if (!File.Exists(tokenPath))
            throw new InvalidOperationException(
                $"Google token dosyası yok: {tokenPath}. Bir kez 'node scripts/google-auth.mjs' çalıştırın.");

        var stored = JsonNode.Parse(await File.ReadAllTextAsync(tokenPath, ct))!.AsObject();
        var refresh = stored["refresh_token"]?.GetValue<string>()
            ?? throw new InvalidOperationException("google-token.json içinde refresh_token yok.");

        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = cfg.GoogleClientId,
            ["client_secret"] = cfg.GoogleClientSecret,
            ["refresh_token"] = refresh,
            ["grant_type"] = "refresh_token",
        });

        using var res = await http.PostAsync("https://oauth2.googleapis.com/token", form, ct);
        res.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct))!.AsObject();
        return json["access_token"]?.GetValue<string>()
            ?? throw new InvalidOperationException("Google access_token alınamadı.");
    }
}
