using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace XurrentMcp.Calendars;

/// <summary>
/// Microsoft Graph (Microsoft 365 / Outlook) sağlayıcısı.
///
/// ★ /me/events DEĞİL, /me/calendarView KULLANILIR.
///   calendarView tekrarlayan etkinlikleri AÇILMIŞ (expanded) döner; events ise seri
///   master'ını ham hâliyle verir. Google'daki singleEvents=true'nun karşılığıdır.
///
/// ★ startDateTime/endDateTime OFFSET'Lİ gönderilir.
///
/// ★ Prefer: outlook.timezone header'ı GÖNDERİLMEZ.
///   Göndermezsek Graph tüm zamanları UTC olarak döner ve tek bir kurala uyarız.
///   Gönderirsek dönen dateTime o bölgede yorumlanır — iki farklı okuma kuralı doğar.
///
/// ★ Graph'in dateTime alanı OFFSET TAŞIMAZ ve 7 kesirli hane içerir
///   ("2026-08-02T09:00:00.0000000"). Doğrudan parse edilirse SUNUCUNUN yerel saati
///   sanılır — sessiz ve teşhisi zor bir bug. Bkz. TimeUtil.ParseGraphDateTime.
///
/// ★ İZİN: Calendars.Read.
///   YAYGIN HATA: Calendars.Read.All etkinlik okumak için DEĞİLDİR — "tüm kullanıcıların
///   çalışma saatleri ve lokasyonları"nı okur. Client credentials akışında scope
///   HER ZAMAN https://graph.microsoft.com/.default'tur.
/// </summary>
public sealed class GraphCalendarProvider(AppConfig cfg, HttpClient http) : ICalendarProvider
{
    public string Name => "graph";

    public async Task<IReadOnlyList<RawEvent>> FetchAsync(CalendarWindow window, CalendarOptions options, CancellationToken ct)
    {
        var token = await GetAccessTokenAsync(ct);
        var user = options.UserEmail ?? cfg.MsImpersonateUser;

        // App-only (client credentials) akışında /me YOKTUR — kullanıcı açıkça belirtilmelidir.
        var scopePath = string.IsNullOrWhiteSpace(user) ? "me" : $"users/{Uri.EscapeDataString(user)}";

        var url = $"https://graph.microsoft.com/v1.0/{scopePath}/calendarView" +
                  $"?startDateTime={Uri.EscapeDataString(TimeUtil.ToIso(window.Start))}" +
                  $"&endDateTime={Uri.EscapeDataString(TimeUtil.ToIso(window.End))}" +
                  $"&$top=250" +
                  $"&$select=id,iCalUId,subject,start,end,isAllDay,isCancelled,showAs,organizer,attendees,categories,seriesMasterId,onlineMeeting,responseStatus";

        using var req = new HttpRequestMessage(HttpMethod.Get, url);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        // Prefer: outlook.timezone BİLEREK gönderilmiyor -> UTC gelsin.

        using var res = await http.SendAsync(req, ct);
        res.EnsureSuccessStatusCode();

        var body = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct))!.AsObject();

        var events = new List<RawEvent>();
        foreach (var node in body["value"] as JsonArray ?? [])
            if (MapEvent(node!.AsObject()) is { } mapped)
                events.Add(mapped);

        return events;
    }

    /// <summary>
    /// Graph event JSON'ını RawEvent'e çevirir. HTTP'den AYRIŞTIRILMIŞTIR: buradaki
    /// alan tuzakları (offset'siz dateTime, responseStatus.response, showAs) ağ olmadan
    /// birim testine tabi tutulabilsin diye.
    /// Başlangıç/bitiş okunamıyorsa null döner (kayıt atlanır).
    /// </summary>
    internal static RawEvent? MapEvent(JsonObject e)
    {
        var start = ParseSlot(e["start"]?.AsObject());
        var end = ParseSlot(e["end"]?.AsObject());
        if (start is null || end is null) return null;

        var attendees = e["attendees"] as JsonArray ?? [];

        return new RawEvent
        {
            Id = e["id"]?.GetValue<string>() ?? "",
            // Graph'te iCalUId her OCCURRENCE için farklıdır — dedup anahtarına start da girer.
            ICalUid = e["iCalUId"]?.GetValue<string>() ?? e["id"]?.GetValue<string>() ?? "",
            Title = e["subject"]?.GetValue<string>() ?? "(başlıksız)",
            Start = start.Value,
            End = end.Value,
            IsAllDay = e["isAllDay"]?.GetValue<bool>() ?? false,
            IsCancelled = e["isCancelled"]?.GetValue<bool>() ?? false,
            Declined = e["responseStatus"]?["response"]?.GetValue<string>() == "declined",
            // showAs: free | tentative | busy | oof | workingElsewhere | unknown
            Free = e["showAs"]?.GetValue<string>() == "free",
            Organizer = e["organizer"]?["emailAddress"]?["address"]?.GetValue<string>(),
            AttendeeCount = attendees.Count,
            Categories = (e["categories"] as JsonArray ?? []).Select(c => c!.GetValue<string>()).ToList(),
            SeriesId = e["seriesMasterId"]?.GetValue<string>(),
            JoinUrl = e["onlineMeeting"]?["joinUrl"]?.GetValue<string>(),
        };
    }

    private static DateTimeOffset? ParseSlot(JsonObject? slot)
    {
        if (slot?["dateTime"]?.GetValue<string>() is not { Length: > 0 } dt) return null;
        // ★ Buradaki tek satır, Graph entegrasyonlarındaki en yaygın sessiz hatanın panzehiri.
        return TimeUtil.ParseGraphDateTime(dt, slot["timeZone"]?.GetValue<string>());
    }

    /// <summary>
    /// Client credentials akışı. Scope HER ZAMAN .../.default'tur.
    /// GÜVENLİK: app-only kullanıyorsanız Exchange Online application access policy ile
    /// uygulamayı bir gruba kısıtlayın; aksi halde tenant'taki HER mailbox okunabilir.
    /// </summary>
    private async Task<string> GetAccessTokenAsync(CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(cfg.MsTenantId) || string.IsNullOrWhiteSpace(cfg.MsClientId))
            throw new InvalidOperationException("MS_TENANT_ID / MS_CLIENT_ID tanımlı değil.");

        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["client_id"] = cfg.MsClientId,
            ["client_secret"] = cfg.MsClientSecret,
            ["grant_type"] = "client_credentials",
            ["scope"] = "https://graph.microsoft.com/.default",
        });

        using var res = await http.PostAsync(
            $"https://login.microsoftonline.com/{cfg.MsTenantId}/oauth2/v2.0/token", form, ct);
        res.EnsureSuccessStatusCode();

        var json = JsonNode.Parse(await res.Content.ReadAsStringAsync(ct))!.AsObject();
        return json["access_token"]?.GetValue<string>()
            ?? throw new InvalidOperationException("Graph access_token alınamadı.");
    }
}
