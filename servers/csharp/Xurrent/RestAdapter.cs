using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace XurrentMcp.Xurrent;

/// <summary>
/// REST 422 gövdesinin TİPLİ hali: iş kuralı reddi, yapılandırılmış errors[] taşır.
///
/// NEDEN ayrı bir tip: GraphQL'de iş kuralı hatası HTTP 200 + payload.errors ile
/// gelir ve hiç istisna olmaz; REST'te aynı hata HTTP 422'dir. 422'yi düz
/// InvalidOperationException yapmak errors[] yapısını (message + attribute)
/// KAYBEDER — tool çıktısındaki errors[] sözleşmesi bozulurdu. Bu tip 422'yi
/// istisna kanalından taşır ama ExecuteAsync onu HEMEN yakalayıp aynı
/// MutationOutcome.Errors biçimine çevirir: istisnai değildir, ASLA retry edilmez
/// (InvalidOperationException'dan türer → XurrentHttpException retry filtresine takılmaz).
/// </summary>
public sealed class RestValidationException(IReadOnlyList<ValidationError> errors)
    : InvalidOperationException(errors.Count > 0 ? errors[0].Message : "REST 422: doğrulama hatası")
{
    public IReadOnlyList<ValidationError> Errors { get; } = errors;
}

/// <summary>
/// ★ Xurrent REST v1 adaptörü (WP3 — bkz. docs/16, tools/fake-xurrent/server.mjs handleRest).
///
/// AYNI tool sözleşmesi, İKİNCİ transport. GraphQL ile bilinçli farklar dersin konusudur:
///   · Alan adları snake_case'tir (started_at, time_spent) — sourceID HARİÇ
///     (Xurrent REST dokümantasyonu da sourceID yazar).
///   · Validation hatası HTTP 422 + {errors:[...]} döner — GraphQL'in
///     "HTTP 200 + payload.errors" modelinin tam tersi. İstemci HTTP koduna BAKMAK zorundadır.
///   · whoami tek istekte alınamaz: GET /me + GET /account (1 sorgu vs 2 istek).
///   · context üç istektir: /timesheet_settings + /effort_classes + /time_allocations.
///     disabled effort class eleme GraphQL'deki gibi CLIENT tarafındadır.
///
/// Güvenilirlik politikası TRANSPORT-BAĞIMSIZDIR (contract/reliability.md):
///   GET                    → query             (429 da belirsiz de retry)
///   POST /time_entries     → guarded_create    (belirsiz hatada önce sourceID geri-okuması)
///   PATCH /time_entries/:id→ idempotent_update (mutlak SET, retry serbest)
///   PATCH /requests|tasks  → no_retry          (time_spent ARTIMLI — tekrar çift sayar)
/// Sınıflandırma LiveAdapter.ClassifyPath ile AYNI yerden gelir: PlannedMutation.Path
/// GraphQL adlarını taşımaya devam eder (timeEntryCreate...); REST karşılığı yalnızca
/// bu adaptörün içinde çözülür — tool katmanı transportu BİLMEZ.
///
/// Gaz, retry izleri ([retry]/[dedup] stderr) ve x-ratelimit-* yakalama LiveAdapter
/// ile birebir aynı katman ve biçimdedir; senaryo koşucusu bunları transport'tan
/// bağımsız sayar.
///
/// ⚠️ Gerçek REST yanıt şekilleri dokümantasyondan ÇIKARIMDIR; alan adları ve hata
/// gövdesi biçimi DOĞRULANMALI'dır (docs/08). Bu adaptör sahte sunucunun /v1
/// yüzeyiyle (tek doğruluk kaynağı) birebir aynı lehçeyi konuşur.
/// </summary>
public sealed class RestAdapter : IXurrentAdapter, IDisposable
{
    private readonly AppConfig _cfg;
    private readonly HttpClient _http;
    private readonly RetryPolicy _retry;
    private readonly SemaphoreSlim _contextGate = new(1, 1);

    // Gaz (reliability.md §4): LiveAdapter'daki kapının aynısı — retry tekrarları ve
    // dedup geri-okumaları DAHİL her HTTP isteği bu kapıdan geçer.
    private readonly SemaphoreSlim _gapGate = new(1, 1);
    private long _nextRequestAtMs;

    private TimeTrackingContext? _contextCache;
    private string? _meCache;
    private RateLimitInfo? _lastRateLimit;

    public string Mode => "live";

    public RestAdapter(AppConfig cfg, HttpClient? http = null)
    {
        _cfg = cfg;
        _retry = new RetryPolicy(cfg);
        _http = http ?? new HttpClient();
        if (http is null) _http.Timeout = TimeSpan.FromSeconds(30);
        // Taban "/v1/" ile bitmek ZORUNDA: göreli yol ("me", "time_entries?...") ancak
        // böyle /v1 altında çözülür. Sondaki '/' unutulursa Uri sınıfı /v1'i YUTAR.
        _http.BaseAddress ??= new Uri(cfg.XurrentRestUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", cfg.XurrentToken);
        if (!string.IsNullOrWhiteSpace(cfg.XurrentAccount))
            _http.DefaultRequestHeaders.Add("X-Xurrent-Account", cfg.XurrentAccount);
    }

    // ── REST taşıma katmanı ──────────────────────────────────────────────────

    /// <summary>Okumalar: query sınıfı (429 da belirsiz de tekrarlanır).</summary>
    private Task<JsonNode> GetAsync(string pathAndQuery, CancellationToken ct)
        => _retry.ExecuteAsync(OperationClass.Query, "query",
            c => SendOnceAsync(HttpMethod.Get, pathAndQuery, null, c), ct);

    /// <summary>
    /// TEK istek — retry YOK, sınıflandırma VAR (contract/reliability.md §1):
    ///   429        → XurrentHttpException(429, Retry-After)   [kesin-işlenmedi]
    ///   5xx        → XurrentHttpException(5xx)                 [belirsiz]
    ///   ağ/timeout → XurrentHttpException(0)                   [belirsiz]
    ///   422        → RestValidationException                   [iş kuralı — errors[] korunur, retry YOK]
    ///   diğer 4xx  → InvalidOperationException                 [kesin-reddedildi, ASLA retry]
    /// </summary>
    private async Task<JsonNode> SendOnceAsync(
        HttpMethod method, string pathAndQuery, JsonObject? body, CancellationToken ct)
    {
        await ThrottleAsync(ct);

        using var req = new HttpRequestMessage(method, pathAndQuery);
        if (body is not null)
            req.Content = new StringContent(body.ToJsonString(Json.Options), Encoding.UTF8, "application/json");

        HttpResponseMessage res;
        try
        {
            res = await _http.SendAsync(req, ct);
        }
        catch (HttpRequestException ex)
        {
            throw new XurrentHttpException(0, null,
                $"Xurrent REST'e ulaşılamadı (ağ hatası): {ex.Message}", ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            throw new XurrentHttpException(0, null,
                "Xurrent REST isteği zaman aşımına uğradı (30 sn) — istek işlenmiş OLABİLİR.", ex);
        }

        using (res)
        {
            CaptureRateLimit(res);
            var status = (int)res.StatusCode;

            if (status == 429)
            {
                var retryAfter = res.Headers.RetryAfter?.Delta;
                if (retryAfter is null
                    && res.Headers.TryGetValues("Retry-After", out var vals)
                    && double.TryParse(vals.FirstOrDefault(), out var sec))
                    retryAfter = TimeSpan.FromSeconds(sec);
                throw new XurrentHttpException(429, retryAfter,
                    "Xurrent rate limit (HTTP 429): istek işlenmeden reddedildi.");
            }

            if (status >= 500)
                throw new XurrentHttpException(status, null,
                    $"Xurrent REST sunucu hatası (HTTP {status}) — istek işlenmiş OLABİLİR (sınıf: belirsiz).");

            var text = await res.Content.ReadAsStringAsync(ct);

            if (status == 422)
            {
                // ★ REST'in iş kuralı reddi. GraphQL'deki "200 + payload.errors" dersinin
                // ikizi: yapılandırılmış errors[] AYNEN korunur ve ASLA retry edilmez.
                throw new RestValidationException(ParseRestErrors(text));
            }

            if (status >= 400)
            {
                var detail = ParseRestErrors(text).FirstOrDefault()?.Message
                             ?? text[..Math.Min(text.Length, 200)];
                throw new InvalidOperationException(
                    $"Xurrent REST isteği reddetti (HTTP {status}): {detail} " +
                    "Bu hata sınıfı otomatik TEKRARLANMAZ (kesin-reddedildi).");
            }

            return JsonNode.Parse(text)
                   ?? throw new InvalidOperationException("Xurrent REST boş yanıt döndü.");
        }
    }

    /// <summary>422/4xx gövdesi: {errors:[{message, attribute}]} → ValidationError listesi.</summary>
    internal static IReadOnlyList<ValidationError> ParseRestErrors(string text)
    {
        try
        {
            var errs = (JsonNode.Parse(text)?["errors"] as JsonArray ?? [])
                .OfType<JsonNode>()
                .Select(e => new ValidationError(
                    e["message"]?.GetValue<string>() ?? "Bilinmeyen REST hatası",
                    // REST'te path yerine tek bir "attribute" alanı vardır — GraphQL'in
                    // errors[].path dizisiyle AYNI sözleşme alanına çevrilir.
                    e["attribute"]?.GetValueKind() == JsonValueKind.String
                        ? [e["attribute"]!.GetValue<string>()]
                        : null))
                .ToList();
            return errs.Count > 0 ? errs : [new ValidationError("REST hatası: gövde çözümlenemedi", null)];
        }
        catch (JsonException)
        {
            return [new ValidationError($"REST hatası: {text[..Math.Min(text.Length, 160)]}", null)];
        }
    }

    private async Task ThrottleAsync(CancellationToken ct)
    {
        if (_cfg.MinRequestGapMs <= 0) return;
        await _gapGate.WaitAsync(ct);
        try
        {
            var wait = _nextRequestAtMs - Environment.TickCount64;
            if (wait > 0) await Task.Delay((int)wait, ct);
            _nextRequestAtMs = Environment.TickCount64 + _cfg.MinRequestGapMs;
        }
        finally { _gapGate.Release(); }
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

    /// <summary>
    /// ★ Öğretilen kontrast: GraphQL whoami TEK sorgudur; REST'te /me ve /account
    /// AYRI kaynaklardır → İKİ istek. "1 sorgu vs N istek" farkı dersin kendisidir.
    /// </summary>
    public async Task<WhoAmIResult> WhoAmIAsync(CancellationToken ct)
    {
        var me = (await GetAsync("me", ct)).AsObject();
        var acc = (await GetAsync("account", ct)).AsObject();
        _meCache = MockAdapter.Str(me, "id");

        return new WhoAmIResult(ToPersonRest(me),
            new AccountInfo(MockAdapter.Str(acc, "id") ?? _cfg.XurrentAccount,
                MockAdapter.Str(acc, "name"), MockAdapter.Bool(acc, "directory")),
            "live", _lastRateLimit);
    }

    public async Task<FindPersonResult> FindPersonAsync(string email, string view, CancellationToken ct)
    {
        // TAM eşleşme: REST primary_email filtresi de substring DEĞİLDİR.
        // NOT: GraphQL'deki view parametresinin REST karşılığı sahte yüzeyde yok;
        // gerçek REST'te ?view= desteği DOĞRULANMALI (docs/08).
        var rows = (await GetAsync($"people?primary_email={Uri.EscapeDataString(email)}", ct)).AsArray();
        var people = rows.Select(n => ToPersonRest(n!.AsObject())).ToList();
        return new FindPersonResult(people.Count, people, people.Count == 0);
    }

    public async Task<string> ResolvePersonIdAsync(string personId, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(personId) && personId != "$me") return personId;
        if (_meCache is not null) return _meCache;
        // '$me' REST sorgu parametrelerinde taşınamaz — önce GET /me ile gerçek id çözülür.
        var me = (await GetAsync("me", ct)).AsObject();
        _meCache = MockAdapter.Str(me, "id");
        return _meCache ?? "$me";
    }

    public async Task<ListOpenWorkResult> ListOpenWorkAsync(ListOpenWorkArgs args, CancellationToken ct)
    {
        var personId = await ResolvePersonIdAsync(args.PersonId, ct);
        var requests = new WorkPage(0, false, null, []);
        var tasks = new WorkPage(0, false, null, []);

        // TUZAK GraphQL'dekiyle aynı: Request'te atanan kişi "member", Task'ta "assignee".
        if (args.Include.Contains("requests"))
        {
            var rows = (await GetAsync($"requests?member={Uri.EscapeDataString(personId)}", ct)).AsArray();
            requests = ToWorkPage(rows, "request");
        }

        if (args.Include.Contains("tasks"))
        {
            var rows = (await GetAsync($"tasks?assignee={Uri.EscapeDataString(personId)}", ct)).AsArray();
            tasks = ToWorkPage(rows, "task");
        }

        // NOT: REST yüzeyi cursor sayfalaması sunmaz (sahte yüzeyde yok; gerçek REST
        // sayfa parametreleri DOĞRULANMALI) — first/after burada bilinçli yok sayılır.
        return new ListOpenWorkResult(_cfg.XurrentAccount, requests, tasks);
    }

    internal static WorkPage ToWorkPage(JsonArray rows, string kind)
    {
        var nodes = rows.Select(n =>
        {
            var o = n!.AsObject();
            var team = o["team"]?.AsObject();
            var member = o["member"]?.AsObject();
            var workflow = o["workflow"]?.AsObject();
            var status = MockAdapter.Str(o, "status");

            return new WorkItem(
                Kind: kind,
                Id: MockAdapter.Str(o, "id") ?? "",
                // REST'te UI numarası "source_display_id" alanındadır (requestId/taskId değil).
                DisplayId: MockAdapter.Str(o, "source_display_id") ?? "",
                Subject: MockAdapter.Str(o, "subject"),
                Status: status,
                StatusLabel: LiveAdapter.StatusLabel(status),
                IsOpen: true,
                // TUZAK: Request'te next_target_at, Task'ta completion_target_at.
                TargetAt: MockAdapter.Str(o, kind == "request" ? "next_target_at" : "completion_target_at"),
                Team: team is null ? null : MockAdapter.Str(team, "name"),
                Member: member is null ? null : MockAdapter.Str(member, "name"),
                ParentLabel: workflow is null ? null : MockAdapter.Str(workflow, "subject"),
                UpdatedAt: MockAdapter.Str(o, "updated_at"));
        }).ToList();

        return new WorkPage(nodes.Count, false, null, nodes);
    }

    /// <summary>
    /// GraphQL'de TEK sorgu olan bağlam REST'te ÜÇ istektir:
    /// /timesheet_settings + /effort_classes + /time_allocations.
    /// disabled effort class eleme GraphQL yolundaki gibi CLIENT tarafındadır.
    /// </summary>
    public async Task<TimeTrackingContext> GetTimeTrackingContextAsync(string personId, CancellationToken ct)
    {
        await _contextGate.WaitAsync(ct);
        try
        {
            if (_contextCache is not null) return _contextCache;

            var settings = (await GetAsync("timesheet_settings", ct)).AsArray();
            var setting = settings.FirstOrDefault()?.AsObject() ?? new JsonObject();

            var classRows = (await GetAsync("effort_classes", ct)).AsArray();
            var allocRows = (await GetAsync("time_allocations", ct)).AsArray();

            _contextCache = BuildContext(setting, classRows, allocRows);
            return _contextCache;
        }
        finally { _contextGate.Release(); }
    }

    /// <summary>snake_case REST gövdelerinden sözleşme tipine — birim testin hedefi.</summary>
    internal static TimeTrackingContext BuildContext(JsonObject setting, JsonArray classRows, JsonArray allocRows)
    {
        // disabled olanlar sunucudan BİLEREK gelir; eleme burada (client) yapılır.
        var classes = classRows
            .Select(n => n!.AsObject())
            .Where(e => MockAdapter.Bool(e, "disabled") != true)
            .Select(e => new EffortClass(MockAdapter.Str(e, "id") ?? "", MockAdapter.Str(e, "name"),
                MockAdapter.Int(e, "position"), MockAdapter.Dbl(e, "cost_multiplier"),
                MockAdapter.Bool(e, "disabled")))
            .ToList();

        var allocations = allocRows
            .Select(n => n!.AsObject())
            .Select(a => new TimeAllocationInfo(MockAdapter.Str(a, "id") ?? "", MockAdapter.Str(a, "name"),
                MockAdapter.Str(a, "group"), MockAdapter.Bool(a, "description_required")))
            .ToList();

        string? Default(string key) => setting[key]?["id"]?.GetValue<string>();

        return new TimeTrackingContext(
            MockAdapter.Str(setting, "unit"),
            // GraphQL yoluyla AYNI varsayılan: bilinmiyorsa en kısıtlayıcı (60) doğrudur.
            MockAdapter.Int(setting, "time_increment") ?? 60,
            MockAdapter.Int(setting, "workday") ?? 480,
            MockAdapter.Int(setting, "workweek") ?? 2400,
            MockAdapter.Bool(setting, "allow_workday_overtime"),
            MockAdapter.Bool(setting, "allow_workweek_overtime"),
            MockAdapter.Bool(setting, "allocation_time_tracking"),
            MockAdapter.Bool(setting, "assignment_time_tracking"),
            MockAdapter.Bool(setting, "require_note"),
            MockAdapter.Bool(setting, "require_time_entry_description"),
            classes, allocations,
            new TimeTrackingDefaults(Default("request_effort_class"), Default("task_effort_class"),
                Default("project_task_effort_class"), Default("problem_effort_class"),
                Default("time_allocation_effort_class")));
    }

    public async Task<string?> ResolveTargetLabelAsync(string targetType, string targetId, CancellationToken ct)
    {
        // Etiket KOZMETİKTİR; hata akışı bozmasın. Gerçek REST'te GET /requests/:id vardır;
        // sahte yüzey tekil kaydı desteklemez ve 404 döner — o durumda null'a düşülür.
        try
        {
            var kaynak = targetType switch
            {
                "request" => "requests",
                "task" => "tasks",
                _ => null,
            };
            if (kaynak is null) return null;
            var o = (await GetAsync($"{kaynak}/{Uri.EscapeDataString(targetId)}", ct)).AsObject();
            var num = MockAdapter.Str(o, "source_display_id");
            var subject = MockAdapter.Str(o, "subject");
            return num is null ? subject : $"#{num} {subject}";
        }
        catch (InvalidOperationException) { return null; }
    }

    // (kişi|tarih) → sunucu baseline'ı + bu sürecin yerel yazdıkları.
    // NEDEN cache: LiveAdapter'daki dersin aynısı — kayıt başına ikinci bir GET,
    // bulk'ta 20 istek / 2 sn sınırını aşar (LiveAdapter.GetLoggedMinutesAsync yorumu).
    private readonly Dictionary<string, (int Baseline, DateTimeOffset At)> _loggedBaseline = new();
    private readonly Dictionary<string, int> _loggedLocal = new();
    private const int LoggedBaselineTtlSeconds = 5;

    public async Task<int> GetLoggedMinutesAsync(string personId, DateOnly date, CancellationToken ct)
    {
        var resolved = await ResolvePersonIdAsync(personId, ct);
        var key = $"{resolved}|{date:yyyy-MM-dd}";

        if (_loggedBaseline.TryGetValue(key, out var hit)
            && (DateTimeOffset.UtcNow - hit.At).TotalSeconds < LoggedBaselineTtlSeconds)
        {
            return hit.Baseline + (_loggedLocal.TryGetValue(key, out var added) ? added : 0);
        }

        int baseline;
        try
        {
            var rows = (await GetAsync(
                $"time_entries?person={Uri.EscapeDataString(resolved)}&date={date:yyyy-MM-dd}", ct)).AsArray();
            baseline = rows.Sum(n => MockAdapter.Int(n!.AsObject(), "time_spent") ?? 0);
        }
        catch (InvalidOperationException) { return 0; } // sınır kontrolü best-effort

        _loggedBaseline[key] = (baseline, DateTimeOffset.UtcNow);
        _loggedLocal[key] = 0;
        return baseline;
    }

    private void NoteLoggedLocally(string resolvedPersonId, DateOnly date, int minutes)
    {
        if (minutes <= 0) return;
        var key = $"{resolvedPersonId}|{date:yyyy-MM-dd}";
        if (!_loggedBaseline.ContainsKey(key)) return;
        _loggedLocal[key] = (_loggedLocal.TryGetValue(key, out var v) ? v : 0) + minutes;
    }

    /// <summary>
    /// Dedup geri-okuması (reliability.md §5): GET /time_entries?sourceID=…
    /// Query sınıfında koşar — geri-okuma yan etkisizdir, retry serbesttir.
    /// </summary>
    public async Task<JsonObject?> FindTimeEntryBySourceIdAsync(string sourceId, CancellationToken ct)
    {
        var rows = (await GetAsync($"time_entries?sourceID={Uri.EscapeDataString(sourceId)}", ct)).AsArray();
        var first = rows.FirstOrDefault()?.AsObject();
        return first is null ? null : NormalizeTimeEntry(first);
    }

    public async Task<TimeEntryPage> ListTimeEntriesAsync(ListTimeEntriesArgs args, CancellationToken ct)
    {
        var personId = await ResolvePersonIdAsync(args.PersonId, ct);
        var first = Math.Clamp(args.First, 1, 100);

        var query = new StringBuilder($"time_entries?person={Uri.EscapeDataString(personId)}");
        if (!string.IsNullOrWhiteSpace(args.DateFrom)) query.Append("&date_from=").Append(Uri.EscapeDataString(args.DateFrom));
        if (!string.IsNullOrWhiteSpace(args.DateTo)) query.Append("&date_to=").Append(Uri.EscapeDataString(args.DateTo));
        if (!string.IsNullOrWhiteSpace(args.SourceId)) query.Append("&sourceID=").Append(Uri.EscapeDataString(args.SourceId));

        var rows = (await GetAsync(query.ToString(), ct)).AsArray();
        var records = rows.Take(first).Select(n => ToTimeEntryRecord(n!.AsObject())).ToList();
        return new TimeEntryPage(_cfg.XurrentAccount, records, records.Sum(r => r.TimeSpent));
    }

    /// <summary>snake_case REST satırı → sözleşme kaydı (birim testin hedefi).</summary>
    internal static TimeEntryRecord ToTimeEntryRecord(JsonObject o)
    {
        var person = o["person"]?.AsObject();
        var effort = o["effort_class"]?.AsObject();
        var assignment = o["assignment"]?.AsObject();

        return new TimeEntryRecord(
            Id: MockAdapter.Str(o, "id") ?? "",
            Date: MockAdapter.Str(o, "date") ?? "",
            StartedAt: MockAdapter.Str(o, "started_at"),
            TimeSpent: MockAdapter.Int(o, "time_spent") ?? 0,
            Description: MockAdapter.Str(o, "description"),
            Correction: MockAdapter.Bool(o, "correction"),
            Source: MockAdapter.Str(o, "source"),
            SourceId: MockAdapter.Str(o, "sourceID"),   // ★ REST'te de sourceID camel kalır
            Person: person is null
                ? null
                : new TimeEntryPersonRef(MockAdapter.Str(person, "id") ?? "", MockAdapter.Str(person, "name")),
            // Yol A kayıtlarında assignment REST'te de null'dır — ders aynı ders.
            // REST assignment {type,id} taşır; UI numarası (displayId) bu yüzeyde YOKTUR.
            Assignment: assignment is null
                ? null
                : new TimeEntryAssignmentRef(
                    MockAdapter.Str(assignment, "type"),
                    MockAdapter.Str(assignment, "id"),
                    null),
            EffortClass: effort is null
                ? null
                : new TimeEntryEffortClassRef(MockAdapter.Str(effort, "id") ?? "", MockAdapter.Str(effort, "name")));
    }

    // ── Yazma ────────────────────────────────────────────────────────────────

    /// <summary>
    /// GraphQL mutation adı → REST (yöntem, yol) eşlemesi. Birim testin hedefi.
    /// projectTask/problem REST yolları sahte yüzeyde YOKTUR; gerçek REST'te
    /// /project_tasks, /problems varsayıldı — DOĞRULANMALI (docs/08).
    /// </summary>
    internal static (HttpMethod Method, string Path) EndpointFor(string mutationPath, JsonObject input) => mutationPath switch
    {
        "timeEntryCreate" => (HttpMethod.Post, "time_entries"),
        "timeEntryUpdate" => (HttpMethod.Patch, $"time_entries/{input["id"]?.GetValue<string>()}"),
        "requestUpdate" => (HttpMethod.Patch, $"requests/{input["id"]?.GetValue<string>()}"),
        "taskUpdate" => (HttpMethod.Patch, $"tasks/{input["id"]?.GetValue<string>()}"),
        "projectTaskUpdate" => (HttpMethod.Patch, $"project_tasks/{input["id"]?.GetValue<string>()}"),
        "problemUpdate" => (HttpMethod.Patch, $"problems/{input["id"]?.GetValue<string>()}"),
        _ => throw new ArgumentOutOfRangeException(nameof(mutationPath), mutationPath,
            "REST eşlemesi tanımsız mutation yolu."),
    };

    /// <summary>
    /// GraphQL input alan adı → REST gövde alanı. sourceID HARİÇ hepsi snake_case.
    /// clientMutationId ve id gövdeye GİRMEZ (id URL'dedir; clientMutationId GraphQL'e özgüdür).
    /// </summary>
    private static readonly Dictionary<string, string> FieldMap = new()
    {
        ["timeSpent"] = "time_spent",
        ["date"] = "date",
        ["startedAt"] = "started_at",
        ["personId"] = "person_id",
        ["timeAllocationId"] = "time_allocation_id",
        ["effortClassId"] = "effort_class_id",
        ["description"] = "description",
        ["correction"] = "correction",
        ["source"] = "source",
        ["sourceID"] = "sourceID",          // ★ tek istisna: REST dokümantasyonu da sourceID yazar
        ["customerId"] = "customer_id",
        ["serviceId"] = "service_id",
        ["organizationId"] = "organization_id",
        ["teamId"] = "team_id",
        // Yol B (parent PATCH) üçlüsü + note:
        ["timeSpentEffortClassId"] = "time_spent_effort_class_id",
        ["timeEntryDescription"] = "time_entry_description",
        ["note"] = "note",
    };

    /// <summary>GraphQL biçimli PlannedMutation input'u → REST gövdesi (birim testin hedefi).</summary>
    internal static JsonObject ToRestBody(string mutationPath, JsonObject input, string? sourceTag)
    {
        var body = new JsonObject();
        foreach (var (key, value) in input)
        {
            if (value is null || key is "id" or "clientMutationId") continue;
            if (FieldMap.TryGetValue(key, out var restKey)) body[restKey] = value.DeepClone();
        }

        // ★ two_step'in REST'e özgü küçük kazanımı: PATCH /time_entries/:id gövdesi
        // source/sourceID kabul eder (GraphQL TimeEntryUpdateInput'unda bu alanlar
        // gönderilmiyordu). Düzeltme adımı, kaydı entegrasyon imzasıyla etiketler;
        // deterministik anahtar clientMutationId'de "-fix" ekiyle taşınır — eki soyup
        // gerçek sourceID'yi yazarız.
        if (mutationPath == "timeEntryUpdate" && sourceTag is not null
            && input["clientMutationId"]?.GetValue<string>() is { } cmid)
        {
            body["source"] = sourceTag;
            body["sourceID"] = cmid.EndsWith("-fix", StringComparison.Ordinal) ? cmid[..^4] : cmid;
        }

        return body;
    }

    /// <summary>
    /// snake_case REST time entry → adaptör içi camelCase şekil. Tool katmanı ve
    /// Strategies (createdId, WriteResult.timeEntry) GraphQL yolundaki şekli görür —
    /// normalizasyon transport farkını BU noktada bitirir. Birim testin hedefi.
    /// </summary>
    internal static JsonObject NormalizeTimeEntry(JsonObject rest)
    {
        JsonObject? Obj(string key) => rest[key]?.AsObject();

        var normalized = new JsonObject
        {
            ["id"] = MockAdapter.Str(rest, "id"),
            ["date"] = MockAdapter.Str(rest, "date"),
            ["startedAt"] = MockAdapter.Str(rest, "started_at"),
            ["timeSpent"] = MockAdapter.Int(rest, "time_spent"),
            ["description"] = MockAdapter.Str(rest, "description"),
            ["correction"] = MockAdapter.Bool(rest, "correction"),
            ["source"] = MockAdapter.Str(rest, "source"),
            ["sourceID"] = MockAdapter.Str(rest, "sourceID"),
        };

        if (Obj("person") is { } person)
            normalized["person"] = new JsonObject
            { ["id"] = MockAdapter.Str(person, "id"), ["name"] = MockAdapter.Str(person, "name") };
        if (Obj("effort_class") is { } effort)
            normalized["effortClass"] = new JsonObject
            { ["id"] = MockAdapter.Str(effort, "id"), ["name"] = MockAdapter.Str(effort, "name") };
        if (Obj("time_allocation") is { } alloc)
            normalized["timeAllocation"] = new JsonObject
            { ["id"] = MockAdapter.Str(alloc, "id"), ["name"] = MockAdapter.Str(alloc, "name") };
        if (Obj("assignment") is { } assignment)
            normalized["assignment"] = new JsonObject
            {
                // GraphQL şekliyle hizalama: type → __typename (Request | Task).
                ["__typename"] = MockAdapter.Str(assignment, "type"),
                ["id"] = MockAdapter.Str(assignment, "id"),
            };

        return normalized;
    }

    public async Task<MutationOutcome> ExecuteAsync(PlannedMutation step, CancellationToken ct)
    {
        // Sınıflandırma LiveAdapter ile AYNI tablodan: retry OPERASYONUN özelliğidir,
        // transportun değil (reliability.md §2).
        var cls = LiveAdapter.ClassifyPath(step.Path);
        try
        {
            if (cls == OperationClass.GuardedCreate)
                return await ExecuteGuardedCreateAsync(step, ct);

            var input = step.Input["input"]?.AsObject() ?? new JsonObject();
            var (method, path) = EndpointFor(step.Path, input);
            var body = ToRestBody(step.Path, input, _cfg.XurrentSource);

            var data = await _retry.ExecuteAsync(cls, step.Path,
                c => SendOnceAsync(method, path, body, c), ct);

            return await ParseWriteResponseAsync(step, data, ct);
        }
        catch (RestValidationException ex)
        {
            // ★ 422 = iş kuralı reddi. İstisnai DEĞİLDİR ve retry EDİLMEMİŞTİR;
            // GraphQL'in payload.errors çıktısıyla aynı errors[] şekline düşer.
            return new MutationOutcome(null, ex.Errors);
        }
        catch (XurrentHttpException ex)
        {
            return MutationOutcome.Fail(WriteFailureMessage(step.Path, cls, ex));
        }
        catch (InvalidOperationException ex)
        {
            return MutationOutcome.Fail(ex.Message);
        }
    }

    /// <summary>
    /// guarded_create'in REST hali — LiveAdapter'daki elle yazılı döngünün ikizi
    /// (gerekçe RetryPolicy başlığında). Belirsiz hatada (5xx/ağ) körlemesine POST
    /// tekrarı çift kayıt yazabilir → önce GET /time_entries?sourceID= geri-okuması.
    /// </summary>
    private async Task<MutationOutcome> ExecuteGuardedCreateAsync(PlannedMutation step, CancellationToken ct)
    {
        var input = step.Input["input"]?.AsObject() ?? new JsonObject();
        var body = ToRestBody(step.Path, input, _cfg.XurrentSource);
        var sourceId = input["sourceID"]?.GetValue<string>();
        var max = _retry.MaxAttempts;

        for (var attempt = 1; ; attempt++)
        {
            XurrentHttpException failure;
            try
            {
                var data = await SendOnceAsync(HttpMethod.Post, "time_entries", body, ct);
                return await ParseWriteResponseAsync(step, data, ct);
            }
            catch (RestValidationException ex)
            {
                return new MutationOutcome(null, ex.Errors);   // 422: kesin-reddedildi, retry yok
            }
            catch (XurrentHttpException ex)
            {
                failure = ex;
            }

            // 429 = kesin-işlenmedi: geri-okuma İSRAFTIR → doğrudan tekrar.
            // Belirsiz (5xx/ağ): istek işlenmiş olabilir → önce "yazılmış mı?" sorusu.
            if (failure.Uncertain && sourceId is not null)
            {
                JsonObject? existing = null;
                try { existing = await FindTimeEntryBySourceIdAsync(sourceId, ct); }
                catch (InvalidOperationException) { /* miss say, normal retry'a düş */ }
                ReliabilityTrace.Dedup(sourceId, existing is not null);
                if (existing is not null)
                    return new MutationOutcome(existing, []);  // yazılmış: mevcut kayıt = BAŞARI
            }

            if (attempt >= max)
                return MutationOutcome.Fail(WriteFailureMessage(step.Path, OperationClass.GuardedCreate, failure));

            var wait = _retry.ComputeWait(attempt, failure.RetryAfter);
            ReliabilityTrace.Retry(step.Path, attempt, max, failure.Reason, (int)wait.TotalMilliseconds);
            await Task.Delay(wait, ct);
        }
    }

    /// <summary>
    /// Yazma yanıtının ortak okunması:
    ///   POST/PATCH /time_entries → gövde time entry'dir → normalize edilir.
    ///   PATCH /requests|tasks    → gövde PARENT'tır, time entry İÇERMEZ →
    ///                              two_step 2. adımı için oluşan kayıt geri okunur
    ///                              (GET /time_entries?person&amp;date=bugün — en yeni eşleşen).
    /// </summary>
    private async Task<MutationOutcome> ParseWriteResponseAsync(
        PlannedMutation step, JsonNode data, CancellationToken ct)
    {
        if (step.Path is "timeEntryCreate" or "timeEntryUpdate")
        {
            var entry = NormalizeTimeEntry(data.AsObject());

            // Günlük toplamı sunucuya TEKRAR SORMADAN yerel say (LiveAdapter'daki ders).
            var teDate = MockAdapter.Str(entry, "date");
            var teMinutes = MockAdapter.Int(entry, "timeSpent") ?? 0;
            var tePerson = entry["person"]?["id"]?.GetValue<string>();
            if (step.Path == "timeEntryCreate"
                && teDate is not null && tePerson is not null && DateOnly.TryParse(teDate, out var d))
                NoteLoggedLocally(tePerson, d, teMinutes);

            return new MutationOutcome(entry, []);
        }

        // Parent PATCH başarılı: two_step'in dayanağı için oluşan kaydı bul.
        var found = await FindJustCreatedTimeEntryAsync(step, ct);
        return new MutationOutcome(found, []);
    }

    /// <summary>
    /// Parent PATCH sonrası oluşan zaman girişini bulur. REST listesi EN YENİ kayıt
    /// önce döner; parent'a bağlı ilk satır aradığımız kayıttır.
    /// </summary>
    private async Task<JsonObject?> FindJustCreatedTimeEntryAsync(PlannedMutation step, CancellationToken ct)
    {
        var parentId = step.Input["input"]?["id"]?.GetValue<string>();
        if (parentId is null) return null;

        try
        {
            var me = await ResolvePersonIdAsync("$me", ct);
            var today = TimeUtil.Today(_cfg.TimeZone, _cfg.Clock).ToString("yyyy-MM-dd");
            var rows = (await GetAsync(
                $"time_entries?person={Uri.EscapeDataString(me)}&date={today}", ct)).AsArray();

            foreach (var n in rows)
            {
                var o = n!.AsObject();
                if (o["assignment"]?["id"]?.GetValue<string>() == parentId)
                    return NormalizeTimeEntry(o);
            }
        }
        catch (InvalidOperationException) { /* takip sorgusu düşse de 1. adım yazıldı */ }
        return null;
    }

    /// <summary>LiveAdapter.WriteFailureMessage ile aynı dürüstlük sözleşmesi.</summary>
    private string WriteFailureMessage(string path, OperationClass cls, XurrentHttpException ex)
    {
        if (ex.StatusCode == 429)
            return $"{path} rate limit yüzünden başarısız: {_retry.MaxAttempts} deneme boyunca HTTP 429 " +
                   "alındı. Kayıt OLUŞMADI (429 istek işlenmeden reddedilir). Biraz sonra tekrar deneyin.";

        return cls switch
        {
            OperationClass.NoRetry =>
                $"{path} belirsiz bir hatayla düştü ({ex.Message}) ve otomatik TEKRARLANMADI: " +
                "bu operasyonda timeSpent ARTIMLIDIR, tekrar çift sayım üretebilirdi. " +
                "DİKKAT: yazma Xurrent'a ulaşmış ve İŞLENMİŞ OLABİLİR — ticket'ın zaman " +
                "girişlerini kontrol edin ve gerekirse elle karar verin.",

            OperationClass.GuardedCreate =>
                $"{path} {_retry.MaxAttempts} denemede başarısız (son hata: {ex.Message}). " +
                "sourceID geri-okuması kayıt bulamadı — kayıt oluşmamış görünüyor. " +
                "Aynı komut güvenle TEKRAR çalıştırılabilir; dedup çift kaydı önler.",

            _ =>
                $"{path} {_retry.MaxAttempts} denemede başarısız (son hata: {ex.Message}).",
        };
    }

    internal static Person ToPersonRest(JsonObject p)
    {
        var org = p["organization"]?.AsObject();
        return new Person(
            MockAdapter.Str(p, "id") ?? "", MockAdapter.Str(p, "name"), MockAdapter.Str(p, "primary_email"),
            MockAdapter.Str(p, "job_title"), MockAdapter.Str(p, "time_zone"), MockAdapter.Bool(p, "disabled"),
            org is null ? null : new OrganizationRef(MockAdapter.Str(org, "id") ?? "", MockAdapter.Str(org, "name")));
    }

    public void Dispose()
    {
        _http.Dispose();
        _contextGate.Dispose();
        _gapGate.Dispose();
    }
}
