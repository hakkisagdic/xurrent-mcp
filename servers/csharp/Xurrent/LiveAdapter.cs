using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace XurrentMcp.Xurrent;

/// <summary>
/// Gerçek Xurrent GraphQL API'sine bağlanan adapter.
///
/// ENDPOINT: TÜM operasyonlar POST https://graphql.xurrent.com/ adresine gider (GET yok).
/// BÖLGELER: global (varsayılan), au, uk, ch, us.
///           ⚠️ "eu" DİYE BİR BÖLGE YOKTUR — graphql.eu.xurrent.com wildcard DNS ile
///           çözülür ama TLS hatası verir. Global zaten Avrupa'dadır.
/// HEADER'LAR: Authorization: Bearer &lt;token&gt; + X-Xurrent-Account: &lt;slug&gt;
///           X-Xurrent-Account NUMERİK DEĞİL, kısa slug'dır ("widget" gibi).
///           İç personelin time entry'leri DIRECTORY ACCOUNT'ta yaşar; yanlış hesabı
///           hedeflemek "kayıt bulunamadı" hatalarının en yaygın sebebidir.
/// </summary>
public sealed class LiveAdapter : IXurrentAdapter, IDisposable
{
    private readonly AppConfig _cfg;
    private readonly HttpClient _http;
    private readonly SemaphoreSlim _contextGate = new(1, 1);

    private TimeTrackingContext? _contextCache;
    private string? _meCache;
    private RateLimitInfo? _lastRateLimit;

    public string Mode => "live";

    public LiveAdapter(AppConfig cfg, HttpClient? http = null)
    {
        _cfg = cfg;
        _http = http ?? new HttpClient();
        _http.BaseAddress ??= new Uri(cfg.XurrentGraphqlUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", cfg.XurrentToken);
        if (!string.IsNullOrWhiteSpace(cfg.XurrentAccount))
            _http.DefaultRequestHeaders.Add("X-Xurrent-Account", cfg.XurrentAccount);
    }

    // ── GraphQL taşıma katmanı ───────────────────────────────────────────────

    private async Task<JsonObject> PostAsync(string query, JsonObject? variables, CancellationToken ct)
    {
        var body = new JsonObject { ["query"] = query };
        if (variables is not null) body["variables"] = variables;

        // NEDEN her zaman POST: Xurrent GraphQL endpoint'i GET kabul etmez.
        using var res = await _http.PostAsJsonAsync("", body, Json.Options, ct);

        CaptureRateLimit(res);

        var text = await res.Content.ReadAsStringAsync(ct);
        var node = JsonNode.Parse(text)?.AsObject()
                   ?? throw new InvalidOperationException("Xurrent boş yanıt döndü.");

        // Şema/auth hataları burada gelir. İş kuralı hataları ise HTTP 200 + payload.errors ile gelir.
        if (node["errors"] is JsonArray topLevel && topLevel.Count > 0)
        {
            var msg = string.Join("; ", topLevel.Select(e => e?["message"]?.GetValue<string>() ?? "?"));
            throw new InvalidOperationException($"Xurrent GraphQL hatası: {msg}");
        }

        return node["data"]?.AsObject() ?? new JsonObject();
    }

    private void CaptureRateLimit(HttpResponseMessage res)
    {
        double Header(string name)
            => res.Headers.TryGetValues(name, out var v) && double.TryParse(v.FirstOrDefault(), out var d) ? d : 0;

        var limit = Header("X-RateLimit-Limit");
        if (limit > 0)
            _lastRateLimit = new RateLimitInfo(limit, Header("X-RateLimit-Cost"),
                Header("X-RateLimit-Remaining"), Header("X-RateLimit-Reset"));
    }

    // ── Okuma ────────────────────────────────────────────────────────────────

    public async Task<WhoAmIResult> WhoAmIAsync(CancellationToken ct)
    {
        var data = await PostAsync(Queries.Me, null, ct);
        var me = data["me"]!.AsObject();
        var acc = data["account"]?.AsObject() ?? new JsonObject();
        _meCache = MockAdapter.Str(me, "id");

        return new WhoAmIResult(ToPerson(me),
            new AccountInfo(MockAdapter.Str(acc, "id") ?? _cfg.XurrentAccount,
                MockAdapter.Str(acc, "name"), MockAdapter.Bool(acc, "directory")),
            "live", _lastRateLimit);
    }

    public async Task<FindPersonResult> FindPersonAsync(string email, string view, CancellationToken ct)
    {
        // TAM eşleşme: PersonFilter.primaryEmail bir TextFilter'dır, substring DEĞİL.
        var data = await PostAsync(Queries.FindPerson,
            new JsonObject { ["email"] = email, ["view"] = view }, ct);

        var people = data["people"]?.AsObject() ?? new JsonObject();
        var nodes = (people["nodes"] as JsonArray ?? []).Select(n => ToPerson(n!.AsObject())).ToList();
        var total = MockAdapter.Int(people, "totalCount") ?? nodes.Count;
        return new FindPersonResult(total, nodes, total == 0);
    }

    public async Task<string> ResolvePersonIdAsync(string personId, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(personId) && personId != "$me") return personId;
        if (_meCache is not null) return _meCache;
        await WhoAmIAsync(ct);
        return _meCache ?? "$me";
    }

    public async Task<ListOpenWorkResult> ListOpenWorkAsync(ListOpenWorkArgs args, CancellationToken ct)
    {
        // TUZAK: $personId String! olarak gider — PersonReferenceFilter.values tipi [String]!.
        // '$me' özel değeri sunucu tarafında da desteklenir, ama ID'yi çözmek daha güvenlidir.
        var personId = args.PersonId == "$me" ? "$me" : await ResolvePersonIdAsync(args.PersonId, ct);
        var accountId = _cfg.XurrentAccount;

        var requests = new WorkPage(0, false, null, []);
        var tasks = new WorkPage(0, false, null, []);

        if (args.Include.Contains("requests"))
        {
            var vars = new JsonObject
            {
                ["personId"] = personId,
                ["first"] = args.First,
                ["after"] = args.AfterRequests,
                ["view"] = args.View,   // TUZAK: varsayılan current_account — "all" AÇIKÇA geçilir.
            };
            var data = await PostAsync(Queries.OpenRequests, vars, ct);
            requests = ToPage(data["requests"]?.AsObject(), "request");
        }

        if (args.Include.Contains("tasks"))
        {
            var vars = new JsonObject
            {
                ["personId"] = personId,
                ["first"] = args.First,
                ["after"] = args.AfterTasks,
                ["view"] = args.View,
            };
            var data = await PostAsync(Queries.OpenTasks, vars, ct);
            tasks = ToPage(data["tasks"]?.AsObject(), "task");
        }

        return new ListOpenWorkResult(accountId, requests, tasks);
    }

    private static WorkPage ToPage(JsonObject? page, string kind)
    {
        if (page is null) return new WorkPage(0, false, null, []);
        var info = page["pageInfo"]?.AsObject() ?? new JsonObject();
        var nodes = (page["nodes"] as JsonArray ?? []).Select(n =>
        {
            var o = n!.AsObject();
            var team = o["team"]?.AsObject();
            var member = o["member"]?.AsObject();
            var workflow = o["workflow"]?.AsObject();

            return new WorkItem(
                Kind: kind,
                Id: MockAdapter.Str(o, "id") ?? "",
                // Request'te requestId, Task'ta taskId. İkisi de UI'da görünen numaradır.
                DisplayId: MockAdapter.Str(o, kind == "request" ? "requestId" : "taskId") ?? "",
                Subject: MockAdapter.Str(o, "subject"),
                Status: MockAdapter.Str(o, "status"),
                StatusLabel: StatusLabel(MockAdapter.Str(o, "status")),
                IsOpen: true,
                // TUZAK: Request'te nextTargetAt, Task'ta completionTargetAt.
                TargetAt: MockAdapter.Str(o, kind == "request" ? "nextTargetAt" : "completionTargetAt"),
                Team: team is null ? null : MockAdapter.Str(team, "name"),
                Member: member is null ? null : MockAdapter.Str(member, "name"),
                ParentLabel: workflow is null ? null : MockAdapter.Str(workflow, "subject"),
                UpdatedAt: MockAdapter.Str(o, "updatedAt"));
        }).ToList();

        return new WorkPage(
            MockAdapter.Int(page, "totalCount") ?? nodes.Count,
            MockAdapter.Bool(info, "hasNextPage") ?? false,
            MockAdapter.Str(info, "endCursor"),
            nodes);
    }

    public async Task<TimeTrackingContext> GetTimeTrackingContextAsync(string personId, CancellationToken ct)
    {
        await _contextGate.WaitAsync(ct);
        try
        {
            if (_contextCache is not null) return _contextCache;

            var data = await PostAsync(Queries.TimeTrackingContext,
                new JsonObject { ["personId"] = await ResolvePersonIdAsync(personId, ct) }, ct);

            var setting = data["me"]?["organization"]?["timesheetSetting"]?.AsObject() ?? new JsonObject();

            // TUZAK: EffortClassFilter'da "disabled" filtresi YOKTUR -> CLIENT tarafında eleniyor.
            var classes = (data["effortClasses"]?["nodes"] as JsonArray ?? [])
                .Select(n => n!.AsObject())
                .Where(e => MockAdapter.Bool(e, "disabled") != true)
                .Select(e => new EffortClass(MockAdapter.Str(e, "id") ?? "", MockAdapter.Str(e, "name"),
                    MockAdapter.Int(e, "position"), MockAdapter.Dbl(e, "costMultiplier"),
                    MockAdapter.Bool(e, "disabled")))
                .ToList();

            var allocations = (data["timeAllocations"]?["nodes"] as JsonArray ?? [])
                .Select(n => n!.AsObject())
                .Select(a => new TimeAllocationInfo(MockAdapter.Str(a, "id") ?? "", MockAdapter.Str(a, "name"),
                    MockAdapter.Str(a, "group"), MockAdapter.Bool(a, "descriptionRequired")))
                .ToList();

            string? Default(string key) => setting[key]?["id"]?.GetValue<string>();

            _contextCache = new TimeTrackingContext(
                MockAdapter.Str(setting, "unit"),
                // NEDEN varsayılan 60: Xurrent'ın kendi varsayılanı budur ve 45 dakikalık
                // girişleri sessizce reddeder. Bilinmiyorsa en kısıtlayıcı varsayım doğrudur.
                MockAdapter.Int(setting, "timeIncrement") ?? 60,
                MockAdapter.Int(setting, "workday") ?? 480,
                MockAdapter.Int(setting, "workweek") ?? 2400,
                MockAdapter.Bool(setting, "allowWorkdayOvertime"),
                MockAdapter.Bool(setting, "allowWorkweekOvertime"),
                MockAdapter.Bool(setting, "allocationTimeTracking"),
                MockAdapter.Bool(setting, "assignmentTimeTracking"),
                MockAdapter.Bool(setting, "requireNote"),
                MockAdapter.Bool(setting, "requireTimeEntryDescription"),
                classes, allocations,
                new TimeTrackingDefaults(Default("requestEffortClass"), Default("taskEffortClass"),
                    Default("projectTaskEffortClass"), Default("problemEffortClass"),
                    Default("timeAllocationEffortClass")));

            return _contextCache;
        }
        finally { _contextGate.Release(); }
    }

    public async Task<string?> ResolveTargetLabelAsync(string targetType, string targetId, CancellationToken ct)
    {
        const string q = """
            query TargetLabel($id: ID!) {
              node(id: $id) {
                ... on Request { requestId subject }
                ... on Task { taskId subject }
                ... on TimeAllocation { name }
              }
            }
            """;
        try
        {
            var data = await PostAsync(q, new JsonObject { ["id"] = targetId }, ct);
            var n = data["node"]?.AsObject();
            if (n is null) return null;
            var num = MockAdapter.Str(n, "requestId") ?? MockAdapter.Str(n, "taskId");
            var subject = MockAdapter.Str(n, "subject") ?? MockAdapter.Str(n, "name");
            return num is null ? subject : $"#{num} {subject}";
        }
        catch (InvalidOperationException) { return null; } // etiket kozmetiktir; hata akışı bozmasın
    }

    /// <summary>
    /// (kişi, tarih) için sunucudan çekilmiş günlük toplam ve çekilme anı.
    /// Bulk yazma sırasında AYNI günü tekrar tekrar sormamak için.
    /// </summary>
    private readonly Dictionary<string, (int Baseline, DateTimeOffset At)> _loggedBaseline = new();

    /// <summary>Bu adapter örneğinin o güne YAZDIĞI dakikalar (baseline'ın üstüne eklenir).</summary>
    private readonly Dictionary<string, int> _loggedLocal = new();

    private const int LoggedBaselineTtlSeconds = 5;

    /// <summary>
    /// ★ NEDEN CACHE: bu sorgu her yazmadan önce çalışıyordu, yani bulk'ta kayıt
    /// başına İKİ istek gidiyordu (LoggedMinutes + TimeEntryCreate). Xurrent'ın
    /// rate limit'i 20 istek / 2 saniye olduğu için 8 kayıtlık bir bulk sınırı
    /// aşıyor ve 429 alıyordu — TypeScript ve Python kayıt başına tek istek attığı
    /// için aynı senaryoda sorun yaşamıyordu.
    ///
    /// Bu hatayı tools/fake-xurrent sahte sunucusu ortaya çıkardı; mock modda
    /// görünmüyordu çünkü mock'ta HTTP yok.
    ///
    /// Çözüm: baseline'ı günde bir kez sor, kendi yazdıklarımızı yerel say.
    /// Kısa TTL, başka bir istemci de yazarsa bir süre sonra tazelenmesini sağlar.
    /// </summary>
    public async Task<int> GetLoggedMinutesAsync(string personId, DateOnly date, CancellationToken ct)
    {
        var resolved = await ResolvePersonIdAsync(personId, ct);
        var key = $"{resolved}|{date:yyyy-MM-dd}";

        if (_loggedBaseline.TryGetValue(key, out var hit)
            && (DateTimeOffset.UtcNow - hit.At).TotalSeconds < LoggedBaselineTtlSeconds)
        {
            return hit.Baseline + (_loggedLocal.TryGetValue(key, out var addedFast) ? addedFast : 0);
        }

        const string q = """
            query LoggedMinutes($personId: String!, $date: ISO8601Date!) {
              timeEntries(first: 100, view: all, filter: {
                person: { values: [$personId] }
                date: { values: [$date] }
              }) {
                nodes { id timeSpent }
              }
            }
            """;
        int baseline;
        try
        {
            var data = await PostAsync(q, new JsonObject
            {
                ["personId"] = resolved,
                ["date"] = date.ToString("yyyy-MM-dd"),
            }, ct);
            baseline = (data["timeEntries"]?["nodes"] as JsonArray ?? [])
                .Sum(n => MockAdapter.Int(n!.AsObject(), "timeSpent") ?? 0);
        }
        catch (InvalidOperationException) { return 0; } // sınır kontrolü best-effort

        // Taze baseline geldi; bu ana kadar yerel saydıklarımız zaten içinde.
        _loggedBaseline[key] = (baseline, DateTimeOffset.UtcNow);
        _loggedLocal[key] = 0;
        return baseline;
    }

    /// <summary>
    /// Başarılı bir yazmadan sonra çağrılır: aynı güne yazılan dakikaları, sunucuya
    /// tekrar sormadan yerel olarak sayar.
    /// </summary>
    private void NoteLoggedLocally(string resolvedPersonId, DateOnly date, int minutes)
    {
        if (minutes <= 0) return;
        var key = $"{resolvedPersonId}|{date:yyyy-MM-dd}";
        if (!_loggedBaseline.ContainsKey(key)) return;   // baseline yoksa bir sonraki sorgu zaten çeker
        _loggedLocal[key] = (_loggedLocal.TryGetValue(key, out var v) ? v : 0) + minutes;
    }

    // ── Yazma ────────────────────────────────────────────────────────────────

    public async Task<MutationOutcome> ExecuteAsync(PlannedMutation step, CancellationToken ct)
    {
        var data = await PostAsync(step.Mutation, step.Input, ct);
        var payload = data[step.Path]?.AsObject();
        if (payload is null)
            return MutationOutcome.Fail($"'{step.Path}' payload'ı boş döndü.");

        // KRİTİK: Xurrent doğrulama hatalarını HTTP 200 + payload.errors ile döner,
        // top-level GraphQL errors ile DEĞİL. errors dolu ise timeEntry null'dır.
        var errs = (payload["errors"] as JsonArray ?? [])
            .Select(e => new ValidationError(
                e?["message"]?.GetValue<string>() ?? "Bilinmeyen hata",
                (e?["path"] as JsonArray)?.Select(p => p?.GetValue<string>() ?? "").ToList()))
            .ToList();

        if (errs.Count > 0) return new MutationOutcome(null, errs);

        if (payload["timeEntry"]?.AsObject() is { } te)
        {
            // Yazma başarılı: günlük toplamı sunucuya TEKRAR SORMADAN yerel say.
            // Aksi halde bulk'ta kayıt başına ikinci bir istek gider ve rate limit aşılır.
            var teDate = MockAdapter.Str(te, "date");
            var teMinutes = MockAdapter.Int(te, "timeSpent") ?? 0;
            var tePerson = te["person"]?["id"]?.GetValue<string>();
            if (teDate is not null && tePerson is not null && DateOnly.TryParse(teDate, out var d))
                NoteLoggedLocally(tePerson, d, teMinutes);

            return new MutationOutcome(te, []);
        }

        // Parent update payload'ı TimeEntry DÖNDÜRMEZ (request/task döner).
        // two_step'in 2. adımı için oluşan kaydın id'sine ihtiyacımız var -> takip sorgusu.
        var found = await FindJustCreatedTimeEntryAsync(step, ct);
        return new MutationOutcome(found, []);
    }

    /// <summary>
    /// Parent update sonrası oluşan zaman girişini bulur.
    /// NEDEN gerekli: requestUpdate/taskUpdate payload'ında timeEntry alanı yoktur;
    /// two_step'in 2. adımı için id'yi başka türlü öğrenemeyiz.
    /// </summary>
    private async Task<JsonObject?> FindJustCreatedTimeEntryAsync(PlannedMutation step, CancellationToken ct)
    {
        var parentId = step.Input["input"]?["id"]?.GetValue<string>();
        if (parentId is null) return null;

        const string q = """
            query JustCreated($personId: String!, $date: ISO8601Date!) {
              timeEntries(first: 25, view: all, order: { field: createdAt, direction: desc }, filter: {
                person: { values: [$personId] }
                date: { values: [$date] }
              }) {
                nodes {
                  id date startedAt timeSpent description
                  assignment { ... on Request { id } ... on Task { id } }
                }
              }
            }
            """;
        try
        {
            var data = await PostAsync(q, new JsonObject
            {
                ["personId"] = await ResolvePersonIdAsync("$me", ct),
                ["date"] = TimeUtil.Today(_cfg.TimeZone, _cfg.Clock).ToString("yyyy-MM-dd"),
            }, ct);

            foreach (var n in data["timeEntries"]?["nodes"] as JsonArray ?? [])
            {
                var o = n!.AsObject();
                if (o["assignment"]?["id"]?.GetValue<string>() == parentId) return o;
            }
        }
        catch (InvalidOperationException) { /* takip sorgusu başarısız olsa da 1. adım yazıldı */ }
        return null;
    }

    private static Person ToPerson(JsonObject p)
    {
        var org = p["organization"]?.AsObject();
        return new Person(
            MockAdapter.Str(p, "id") ?? "", MockAdapter.Str(p, "name"), MockAdapter.Str(p, "primaryEmail"),
            MockAdapter.Str(p, "jobTitle"), MockAdapter.Str(p, "timeZone"), MockAdapter.Bool(p, "disabled"),
            org is null ? null : new OrganizationRef(MockAdapter.Str(org, "id") ?? "", MockAdapter.Str(org, "name")));
    }

    private static string? StatusLabel(string? status) => status switch
    {
        "declined" => "Reddedildi",
        "on_backlog" => "Backlog'da",
        "assigned" => "Atandı",
        "accepted" => "Kabul edildi",
        "in_progress" => "Devam ediyor",
        "waiting_for" => "Bekliyor",
        "waiting_for_customer" => "Müşteri bekleniyor",
        "reservation_pending" => "Rezervasyon bekliyor",
        "workflow_pending" => "Workflow bekliyor",
        "project_pending" => "Proje bekliyor",
        "registered" => "Kaydedildi",
        "request_pending" => "Talep bekliyor",
        "completed" => "Tamamlandı",
        "approved" => "Onaylandı",
        "rejected" => "Reddedildi",
        "failed" => "Başarısız",
        "canceled" => "İptal edildi",
        _ => status,
    };

    public void Dispose()
    {
        _http.Dispose();
        _contextGate.Dispose();
    }
}
