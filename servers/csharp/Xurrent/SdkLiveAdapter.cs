using System.Text.Json.Nodes;
// Düz using, SDK'nın UZANTI metotlarını (Me/Account/Get(TQuery)/Mutation) görünür kılmak
// için ŞARTTIR — alias uzantıları içeri almaz. Tip adları yine Sdk. önekiyle yazılır:
// çevreleyen namespace (XurrentMcp.*) tip aramada using'lerden ÖNCE geldiği için
// Person/EffortClass/ValidationError bizim tiplerimize bağlanmaya devam eder.
using Xurrent.GraphQL;
using Sdk = Xurrent.GraphQL;

namespace XurrentMcp.Xurrent;

/// <summary>
/// ★ WP4 — resmî Xurrent.GraphQL SDK'sı (NuGet 1.0.2) üzerinden IXurrentAdapter.
/// XURRENT_API=graphql-sdk ile seçilir; YALNIZCA C#'ta vardır. TS/Python bu değeri
/// bilinçli olarak tanımaz — ders, "vendor SDK vs elle yazılmış istemci"yi TEK tool
/// sözleşmesi altında karşılaştırmaktır (varsayılan hâlâ elle yazılmış "graphql").
///
/// ── SONDA SONUCU (WP4 probe — dürüst kayıt) ─────────────────────────────────
/// XurrentClient'ın endpoint'i keyfi bir URL'ye YÖNLENDİRİLEMEZ:
///   · Enum ctor'u (EnvironmentType/EnvironmentRegion) sabit domain listesine gider.
///   · String ctor'u (apiBaseUrl) bir DOMAIN SONEKİDİR, URL değil:
///     apiBaseUrl="xurrent.qa" → https://graphql.xurrent.qa. "http://127.0.0.1:4000"
///     verilirse "https://graphql.http://127.0.0.1:4000" üretilir (sonda ile doğrulandı).
///   · HttpClient/DI enjeksiyon dikişi yoktur (ctor listesi sondalandı).
/// Şema https + graphql. öneki zorunlu → tools/fake-xurrent sahte sunucusuna (düz
/// http) ERİŞİLEMEZ. Bu yüzden:
///   · Bu adaptörün CANLI davranışı DOĞRULANMAMIŞTIR (DOĞRULANMALI — gerçek tenant ister).
///   · Birim testleri yalnız girdi-kurma katmanını (SdkGirdi) doğrular.
///
/// ── SDK'NIN KENDİ HTTP KATMANI (retry sınırı — dürüst belge) ────────────────
/// SDK rate limit sayaçlarını AuthenticationToken üzerinde kendisi izler
/// (RequestLimit/RequestsRemaining/RequestLimitReset — sonda ile görüldü) ve HTTP
/// trafiğini kendi içinde yönetir. Polly pipeline'ımızla SARMIYORUZ: çifte-retry,
/// no_retry sınıfında (parent update) çift sayım riskine dönüşür. Sınır şudur:
///   · [retry] izleri bu yolda ÜRETİLMEZ (retry kararı SDK'nın içindedir).
///   · guarded_create'in dedup geri-okuması SDK'nın ÜSTÜNDE korunur: create
///     belirsiz bir hatayla düşerse önce sourceID ile "yazılmış mı?" bakılır.
///   · Gaz (XURRENT_MIN_REQUEST_GAP_MS) uygulanmaz — SDK istek temposunu kendi
///     sayaçlarıyla yönetir. Bu bilinçli bir fark ve dersin karşılaştırma noktasıdır.
///
/// ── SDK ile ELLE YAZILMIŞ YOL arasında bulunan GERÇEK farklar ───────────────
/// · Request/Task/Problem/ProjectTask UpdateInput'larında SDK'da timeEntryDescription
///   ALANI YOKTUR (TimeSpent + TimeSpentEffortClassId + Note vardır). Elle yazılmış
///   GraphQL yolumuz timeEntryDescription gönderir — hangisinin gerçek şemayla
///   örtüştüğü DOĞRULANMALI'dır; SDK gerçek şemadan üretildiyse bizim alanımız
///   sessizce reddediliyor olabilir (docs/08'e aday bulgu).
/// · Sorgu status filtreleri SDK'da string tabanlıdır (Filter("status", NotIn, ...));
///   enum değerlerinin wire karşılığı (in_progress vb.) SDK serileştiricisine emanettir.
/// </summary>
public sealed class SdkLiveAdapter : IXurrentAdapter, IDisposable
{
    private readonly AppConfig _cfg;
    private readonly Sdk.XurrentClient _client;
    private readonly SemaphoreSlim _contextGate = new(1, 1);

    private TimeTrackingContext? _contextCache;
    private string? _meCache;
    private RateLimitInfo? _lastRateLimit;

    public string Mode => "live";

    public SdkLiveAdapter(AppConfig cfg)
    {
        _cfg = cfg;
        // SDK domain SONEKİ ister ("xurrent.com", "xurrent.qa", "xurrent-demo.com").
        // XURRENT_GRAPHQL_URL'den türetiyoruz ki .env sözleşmesi değişmesin:
        //   https://graphql.xurrent.qa → "xurrent.qa"
        _client = new Sdk.XurrentClient(
            new Sdk.AuthenticationToken(cfg.XurrentToken),
            cfg.XurrentAccount,
            DomainFromGraphqlUrl(cfg.XurrentGraphqlUrl),
            maximumRecursiveRequests: 10);
    }

    /// <summary>"https://graphql.xurrent.qa" → "xurrent.qa" (birim testin hedefi).</summary>
    internal static string DomainFromGraphqlUrl(string url)
    {
        var host = Uri.TryCreate(url, UriKind.Absolute, out var u) ? u.Host : url;
        return host.StartsWith("graphql.", StringComparison.OrdinalIgnoreCase) ? host["graphql.".Length..] : host;
    }

    // ── Okuma ────────────────────────────────────────────────────────────────

    public async Task<WhoAmIResult> WhoAmIAsync(CancellationToken ct)
    {
        // Elle yazılmış yol tek sorguda me+account+rateLimit alır; SDK'nın hazır
        // uzantıları ÜÇ ayrı çağrıdır — REST'teki "1 sorgu vs N istek" dersinin
        // SDK cephesindeki karşılığı.
        var me = await _client.Me();
        var acc = await _client.Account();
        var rl = await _client.RateLimit();
        _meCache = me.ID;
        _lastRateLimit = new RateLimitInfo(rl.Limit ?? 0, rl.Cost ?? 0, rl.Remaining ?? 0, 0);

        return new WhoAmIResult(ToPerson(me),
            new AccountInfo(acc.ID ?? _cfg.XurrentAccount, acc.Name, acc.Directory),
            "live", _lastRateLimit);
    }

    public async Task<FindPersonResult> FindPersonAsync(string email, string view, CancellationToken ct)
    {
        // TAM eşleşme — PersonFilter.primaryEmail TextFilter'dır (elle yazılmış yolla aynı tuzak).
        var rows = await _client.Get(new Sdk.PersonQuery()
            .View(view)
            .ItemsPerRequest(25)
            .SelectOrganization(new Sdk.OrganizationQuery())
            .Filter("primaryEmail", Sdk.FilterOperator.Equals, email));

        var people = rows.Select(ToPerson).ToList();
        return new FindPersonResult(people.Count, people, people.Count == 0);
    }

    public async Task<string> ResolvePersonIdAsync(string personId, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(personId) && personId != "$me") return personId;
        if (_meCache is not null) return _meCache;
        var me = await _client.Me();
        _meCache = me.ID;
        return _meCache ?? "$me";
    }

    public async Task<ListOpenWorkResult> ListOpenWorkAsync(ListOpenWorkArgs args, CancellationToken ct)
    {
        var personId = await ResolvePersonIdAsync(args.PersonId, ct);
        var requests = new WorkPage(0, false, null, []);
        var tasks = new WorkPage(0, false, null, []);

        if (args.Include.Contains("requests"))
        {
            // TUZAKLAR elle yazılmış sorguyla aynı: alan "member", terminal durum TEK (completed).
            var rows = await _client.Get(new Sdk.RequestQuery()
                .View(args.View)
                .ItemsPerRequest(args.First)
                .SelectTeam(new Sdk.TeamQuery())
                .SelectMember(new Sdk.PersonQuery())
                .Filter("member", Sdk.FilterOperator.In, personId)
                .Filter("status", Sdk.FilterOperator.NotIn, "completed"));
            requests = new WorkPage(rows.Count, false, null, rows.Select(r => new WorkItem(
                "request", r.ID ?? "", r.RequestId ?? "", r.Subject, StatusWire(r.Status),
                LiveAdapter.StatusLabel(StatusWire(r.Status)), true,
                // NextTargetAt SDK'da STRING'dir ("best_effort" gibi sembolik değerler
                // taşıyabildiği için) — olduğu gibi geçirilir.
                r.NextTargetAt, r.Team?.Name, r.Member?.Name, null, Iso(r.UpdatedAt))).ToList());
        }

        if (args.Include.Contains("tasks"))
        {
            // TUZAK: Task'ta alan "assignee"dir ve BEŞ terminal durum vardır.
            var rows = await _client.Get(new Sdk.TaskQuery()
                .View(args.View)
                .ItemsPerRequest(args.First)
                .SelectTeam(new Sdk.TeamQuery())
                .SelectMember(new Sdk.PersonQuery())
                .SelectWorkflow(new Sdk.WorkflowQuery())
                .Filter("assignee", Sdk.FilterOperator.In, personId)
                .Filter("status", Sdk.FilterOperator.NotIn,
                    "completed", "approved", "failed", "rejected", "canceled"));
            tasks = new WorkPage(rows.Count, false, null, rows.Select(t => new WorkItem(
                "task", t.ID ?? "", t.TaskId ?? "", t.Subject, StatusWire(t.Status),
                LiveAdapter.StatusLabel(StatusWire(t.Status)), true,
                Iso(t.CompletionTargetAt), t.Team?.Name, t.Member?.Name, t.Workflow?.Subject,
                Iso(t.UpdatedAt))).ToList());
        }

        return new ListOpenWorkResult(_cfg.XurrentAccount, requests, tasks);
    }

    public async Task<TimeTrackingContext> GetTimeTrackingContextAsync(string personId, CancellationToken ct)
    {
        await _contextGate.WaitAsync(ct);
        try
        {
            if (_contextCache is not null) return _contextCache;

            // DOĞRULANMALI: elle yazılmış yol me.organization.timesheetSetting'i okur;
            // SDK'da kök timesheetSettings koleksiyonunun İLK kaydı alınır — çok
            // ayarlı tenant'ta hangi kaydın kullanıcıya ait olduğu gerçek tenant ister.
            var settings = await _client.Get(new Sdk.TimesheetSettingQuery()
                .ItemsPerRequest(1)
                .SelectRequestEffortClass(new Sdk.EffortClassQuery())
                .SelectTaskEffortClass(new Sdk.EffortClassQuery())
                .SelectProjectTaskEffortClass(new Sdk.EffortClassQuery())
                .SelectProblemEffortClass(new Sdk.EffortClassQuery())
                .SelectTimeAllocationEffortClass(new Sdk.EffortClassQuery()));
            var s = settings.FirstOrDefault();

            // disabled eleme yine CLIENT tarafında — EffortClassFilter'da disabled filtresi yoktur.
            var classes = (await _client.Get(new Sdk.EffortClassQuery().ItemsPerRequest(100)))
                .Where(e => e.Disabled != true)
                .Select(e => new EffortClass(e.ID ?? "", e.Name, e.Position.HasValue ? (int)e.Position.Value : null,
                    e.CostMultiplier is { } cm ? (double)cm : null, e.Disabled))
                .ToList();

            var allocations = (await _client.Get(new Sdk.TimeAllocationQuery().ItemsPerRequest(100)))
                .Select(a => new TimeAllocationInfo(a.ID ?? "", a.Name, a.Group, null))
                .ToList();

            _contextCache = new TimeTrackingContext(
                s?.Unit?.ToString()?.ToLowerInvariant(),
                s?.TimeIncrement.HasValue == true ? (int)s.TimeIncrement!.Value : 60,
                s?.Workday.HasValue == true ? (int)s.Workday!.Value : 480,
                s?.Workweek.HasValue == true ? (int)s.Workweek!.Value : 2400,
                s?.AllowWorkdayOvertime, s?.AllowWorkweekOvertime,
                s?.AllocationTimeTracking, s?.AssignmentTimeTracking,
                s?.RequireNote, null,
                classes, allocations,
                new TimeTrackingDefaults(
                    s?.RequestEffortClass?.ID, s?.TaskEffortClass?.ID,
                    s?.ProjectTaskEffortClass?.ID, s?.ProblemEffortClass?.ID,
                    s?.TimeAllocationEffortClass?.ID));
            return _contextCache;
        }
        finally { _contextGate.Release(); }
    }

    public Task<string?> ResolveTargetLabelAsync(string targetType, string targetId, CancellationToken ct)
        // Etiket kozmetiktir; SDK'da id ile tekil node sorgusu ayrı bir desendir ve
        // canlı doğrulama yapılamadığı için (bkz. sınıf başlığı) bilinçli olarak atlandı.
        // (Tam nitelikli Task: 'using Xurrent.GraphQL' sonrası çıplak Task adı,
        //  SDK'nın Task varlığıyla çakışır — arity-0 tek yerde burada gerekiyor.)
        => System.Threading.Tasks.Task.FromResult<string?>(null);

    public async Task<int> GetLoggedMinutesAsync(string personId, DateOnly date, CancellationToken ct)
    {
        var resolved = await ResolvePersonIdAsync(personId, ct);
        try
        {
            var rows = await _client.Get(new Sdk.TimeEntryQuery()
                .View("all")
                .ItemsPerRequest(100)
                .Filter("person", Sdk.FilterOperator.In, resolved)
                .Filter("date", Sdk.FilterOperator.Equals, date.ToString("yyyy-MM-dd")));
            return rows.Sum(t => (int)(t.TimeSpent ?? 0));
        }
        catch (Sdk.XurrentException) { return 0; } // sınır kontrolü best-effort
    }

    public async Task<JsonObject?> FindTimeEntryBySourceIdAsync(string sourceId, CancellationToken ct)
    {
        // D14 aynı şüphe: TimeEntry filtresinde sourceID'nin varlığı DOĞRULANMALI.
        var rows = await _client.Get(new Sdk.TimeEntryQuery()
            .View("all")
            .ItemsPerRequest(5)
            .SelectPerson(new Sdk.PersonQuery())
            .SelectEffortClass(new Sdk.EffortClassQuery())
            .SelectTimeAllocation(new Sdk.TimeAllocationQuery())
            .Filter("sourceID", Sdk.FilterOperator.Equals, sourceId));
        var first = rows.FirstOrDefault();
        return first is null ? null : ToJson(first);
    }

    public async Task<TimeEntryPage> ListTimeEntriesAsync(ListTimeEntriesArgs args, CancellationToken ct)
    {
        var personId = await ResolvePersonIdAsync(args.PersonId, ct);
        var q = new Sdk.TimeEntryQuery()
            .View("all")
            .ItemsPerRequest(Math.Clamp(args.First, 1, 100))
            .SelectPerson(new Sdk.PersonQuery())
            .SelectEffortClass(new Sdk.EffortClassQuery())
            .Filter("person", Sdk.FilterOperator.In, personId);

        var hasFrom = !string.IsNullOrWhiteSpace(args.DateFrom);
        var hasTo = !string.IsNullOrWhiteSpace(args.DateTo);
        if (hasFrom && hasTo)
            q = q.Filter("date", Sdk.FilterOperator.GreaterThanOrEqualToAndLessThanOrEqualTo, args.DateFrom!, args.DateTo!);
        else if (hasFrom)
            q = q.Filter("date", Sdk.FilterOperator.GreaterThanOrEqualsTo, args.DateFrom!);
        else if (hasTo)
            q = q.Filter("date", Sdk.FilterOperator.LessThanOrEqualsTo, args.DateTo!);
        if (!string.IsNullOrWhiteSpace(args.SourceId))
            q = q.Filter("sourceID", Sdk.FilterOperator.Equals, args.SourceId!);

        var rows = await _client.Get(q);
        var records = rows.Select(t => new TimeEntryRecord(
            t.ID ?? "",
            t.Date?.ToString("yyyy-MM-dd") ?? "",
            Iso(t.StartedAt),
            (int)(t.TimeSpent ?? 0),
            t.Description,
            t.Correction,
            t.Source,
            t.SourceID,
            t.Person is null ? null : new TimeEntryPersonRef(t.Person.ID ?? "", t.Person.Name),
            null,   // assignment interface'inin (IHasTimeEntries) seçimi DOĞRULANMALI — canlı sınama gerekir
            t.EffortClass is null ? null : new TimeEntryEffortClassRef(t.EffortClass.ID ?? "", t.EffortClass.Name)))
            .ToList();

        return new TimeEntryPage(_cfg.XurrentAccount, records, records.Sum(r => r.TimeSpent));
    }

    // ── Yazma ────────────────────────────────────────────────────────────────

    public async Task<MutationOutcome> ExecuteAsync(PlannedMutation step, CancellationToken ct)
    {
        var input = step.Input["input"]?.AsObject() ?? new JsonObject();
        try
        {
            switch (step.Path)
            {
                case "timeEntryCreate":
                {
                    // guarded_create'in koruması SDK'nın ÜSTÜNDE: belirsiz hata →
                    // önce sourceID geri-okuması ("yazılmış mı?"), retry SDK'ya bırakılır.
                    var sourceId = MockAdapter.Str(input, "sourceID");
                    Sdk.TimeEntryCreatePayload payload;
                    try
                    {
                        payload = await _client.Mutation(
                            SdkGirdi.TimeEntryCreate(input), TeQuery(), throwOnError: false);
                    }
                    catch (Sdk.XurrentException ex)
                    {
                        if (sourceId is not null)
                        {
                            JsonObject? existing = null;
                            try { existing = await FindTimeEntryBySourceIdAsync(sourceId, ct); }
                            catch (Sdk.XurrentException) { /* miss say */ }
                            ReliabilityTrace.Dedup(sourceId, existing is not null);
                            if (existing is not null) return new MutationOutcome(existing, []);
                        }
                        return MutationOutcome.Fail(
                            $"timeEntryCreate SDK yolunda başarısız: {ex.Message} — sourceID geri-okuması " +
                            "kayıt bulamadı; aynı komut güvenle tekrar çalıştırılabilir (dedup çift kaydı önler).");
                    }
                    return Outcome(payload.Errors, payload.TimeEntry is null ? null : ToJson(payload.TimeEntry));
                }

                case "timeEntryUpdate":
                {
                    var payload = await _client.Mutation(
                        SdkGirdi.TimeEntryUpdate(input), TeQuery(), throwOnError: false);
                    return Outcome(payload.Errors, payload.TimeEntry is null ? null : ToJson(payload.TimeEntry));
                }

                case "requestUpdate":
                {
                    var payload = await _client.Mutation(
                        SdkGirdi.RequestUpdate(input), new Sdk.RequestQuery(), throwOnError: false);
                    return Outcome(payload.Errors, await FindJustCreatedAsync(ct));
                }

                case "taskUpdate":
                {
                    var payload = await _client.Mutation(
                        SdkGirdi.TaskUpdate(input), new Sdk.TaskQuery(), throwOnError: false);
                    return Outcome(payload.Errors, await FindJustCreatedAsync(ct));
                }

                default:
                    // projectTaskUpdate/problemUpdate SDK yolunda bilinçli dışarıda:
                    // canlı doğrulama yapılamadan dört parent tipini de taşımak yüzeyi
                    // büyütür. Elle yazılmış "graphql" yolu tam kapsamı vermeye devam eder.
                    return MutationOutcome.Fail(
                        $"'{step.Path}' SDK yolunda desteklenmiyor (XURRENT_API=graphql-sdk). " +
                        "XURRENT_API=graphql (varsayılan) tam kapsamı sunar.");
            }
        }
        catch (Sdk.XurrentException ex)
        {
            // no_retry sınıfının dürüstlük sözleşmesi burada da geçerlidir.
            var uyari = step.Path is "requestUpdate" or "taskUpdate"
                ? " DİKKAT: timeSpent ARTIMLIDIR ve yazma İŞLENMİŞ OLABİLİR — ticket'ı kontrol edin."
                : "";
            return MutationOutcome.Fail($"{step.Path} SDK yolunda başarısız: {ex.Message}.{uyari}");
        }
    }

    private static MutationOutcome Outcome(List<Sdk.ValidationError>? errors, JsonObject? entry)
    {
        // Payload errors sözleşmesi SDK'da da aynıdır: errors dolu ise iş kuralı reddi.
        var mapped = (errors ?? [])
            .Select(e => new ValidationError(e.Message ?? "Bilinmeyen hata", e.Path))
            .ToList();
        return mapped.Count > 0 ? new MutationOutcome(null, mapped) : new MutationOutcome(entry, []);
    }

    private static Sdk.TimeEntryQuery TeQuery() => new Sdk.TimeEntryQuery()
        .SelectPerson(new Sdk.PersonQuery())
        .SelectEffortClass(new Sdk.EffortClassQuery())
        .SelectTimeAllocation(new Sdk.TimeAllocationQuery());

    /// <summary>
    /// Parent update payload'ı TimeEntry döndürmez; two_step'in 2. adımı için bugünün
    /// EN YENİ kaydı okunur. DOĞRULANMALI: assignment eşlemesi canlı sınama ister —
    /// elle yazılmış yol assignment.id ile doğrular, SDK yolunda en yeni kayda güvenilir.
    /// </summary>
    private async Task<JsonObject?> FindJustCreatedAsync(CancellationToken ct)
    {
        try
        {
            var me = await ResolvePersonIdAsync("$me", ct);
            var today = TimeUtil.Today(_cfg.TimeZone, _cfg.Clock).ToString("yyyy-MM-dd");
            var rows = await _client.Get(new Sdk.TimeEntryQuery()
                .View("all")
                .ItemsPerRequest(25)
                .OrderBy("createdAt", Sdk.OrderBySortOrder.Descending)
                .SelectPerson(new Sdk.PersonQuery())
                .Filter("person", Sdk.FilterOperator.In, me)
                .Filter("date", Sdk.FilterOperator.Equals, today));
            var first = rows.FirstOrDefault();
            return first is null ? null : ToJson(first);
        }
        catch (Sdk.XurrentException) { return null; }
    }

    /// <summary>SDK varlığı → adaptör içi camelCase şekil (RestAdapter.NormalizeTimeEntry ikizi).</summary>
    internal static JsonObject ToJson(Sdk.TimeEntry te)
    {
        var o = new JsonObject
        {
            ["id"] = te.ID,
            ["date"] = te.Date?.ToString("yyyy-MM-dd"),
            ["startedAt"] = Iso(te.StartedAt),
            ["timeSpent"] = te.TimeSpent is { } ts ? (int)ts : null,
            ["description"] = te.Description,
            ["correction"] = te.Correction,
            ["source"] = te.Source,
            ["sourceID"] = te.SourceID,
        };
        if (te.Person is not null)
            o["person"] = new JsonObject { ["id"] = te.Person.ID, ["name"] = te.Person.Name };
        if (te.EffortClass is not null)
            o["effortClass"] = new JsonObject { ["id"] = te.EffortClass.ID, ["name"] = te.EffortClass.Name };
        if (te.TimeAllocation is not null)
            o["timeAllocation"] = new JsonObject { ["id"] = te.TimeAllocation.ID, ["name"] = te.TimeAllocation.Name };
        return o;
    }

    private static Person ToPerson(Sdk.Person p) => new(
        p.ID ?? "", p.Name, p.PrimaryEmail, p.JobTitle, p.TimeZone, p.Disabled,
        p.Organization is null ? null : new OrganizationRef(p.Organization.ID ?? "", p.Organization.Name));

    /// <summary>SDK enum adı → sözleşmenin snake_case durum değeri (InProgress → in_progress).</summary>
    internal static string? StatusWire<T>(T? status) where T : struct, Enum
    {
        if (status is null) return null;
        var name = status.Value.ToString();
        var sb = new System.Text.StringBuilder();
        for (var i = 0; i < name.Length; i++)
        {
            if (char.IsUpper(name[i]) && i > 0) sb.Append('_');
            sb.Append(char.ToLowerInvariant(name[i]));
        }
        return sb.ToString();
    }

    private static string? Iso(DateTime? at) => at?.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss'Z'");

    public void Dispose()
    {
        _client.Dispose();
        _contextGate.Dispose();
    }
}

/// <summary>
/// ★ Girdi-kurma katmanı: PlannedMutation'ın GraphQL biçimli JSON input'u → SDK'nın
/// tipli Input nesneleri. WP4 sondası "sahte sunucuya erişilemez" sonucunu verdiği
/// için birim testlerin doğruladığı yüzey TAM OLARAK burasıdır (Tests/SdkGirdiTests).
/// </summary>
internal static class SdkGirdi
{
    public static Sdk.TimeEntryCreateInput TimeEntryCreate(JsonObject input)
    {
        var x = new Sdk.TimeEntryCreateInput
        {
            TimeSpent = MockAdapter.Int(input, "timeSpent") ?? 0,
            Description = MockAdapter.Str(input, "description"),
            PersonId = MockAdapter.Str(input, "personId"),
            TimeAllocationId = MockAdapter.Str(input, "timeAllocationId"),
            EffortClassId = MockAdapter.Str(input, "effortClassId"),
            CustomerId = MockAdapter.Str(input, "customerId"),
            ServiceId = MockAdapter.Str(input, "serviceId"),
            OrganizationId = MockAdapter.Str(input, "organizationId"),
            TeamId = MockAdapter.Str(input, "teamId"),
            Source = MockAdapter.Str(input, "source"),
            SourceID = MockAdapter.Str(input, "sourceID"),
            ClientMutationId = MockAdapter.Str(input, "clientMutationId"),
        };
        if (MockAdapter.Bool(input, "correction") is { } c) x.Correction = c;
        if (MockAdapter.Str(input, "date") is { } d && DateOnly.TryParse(d, out var date)) x.Date = date;
        if (MockAdapter.Str(input, "startedAt") is { } s && DateTime.TryParse(s, out var started)) x.StartedAt = started;
        return x;
    }

    public static Sdk.TimeEntryUpdateInput TimeEntryUpdate(JsonObject input)
    {
        var x = new Sdk.TimeEntryUpdateInput
        {
            ID = MockAdapter.Str(input, "id"),
            Description = MockAdapter.Str(input, "description"),
            PersonId = MockAdapter.Str(input, "personId"),
            EffortClassId = MockAdapter.Str(input, "effortClassId"),
            ClientMutationId = MockAdapter.Str(input, "clientMutationId"),
        };
        if (MockAdapter.Int(input, "timeSpent") is { } ts) x.TimeSpent = ts;
        if (MockAdapter.Str(input, "date") is { } d && DateOnly.TryParse(d, out var date)) x.Date = date;
        if (MockAdapter.Str(input, "startedAt") is { } s && DateTime.TryParse(s, out var started)) x.StartedAt = started;
        return x;
    }

    public static Sdk.RequestUpdateInput RequestUpdate(JsonObject input)
    {
        var x = new Sdk.RequestUpdateInput
        {
            ID = MockAdapter.Str(input, "id"),
            TimeSpentEffortClassId = MockAdapter.Str(input, "timeSpentEffortClassId"),
            // ★ SDK'DA timeEntryDescription ALANI YOK (sınıf başlığındaki bulgu).
            // Elle yazılmış yolun gönderdiği açıklama SDK yolunda TAŞINAMAZ; kayıp
            // sessiz olmasın diye Note'a düşürmüyoruz — Note ayrı bir kavramdır.
            Note = MockAdapter.Str(input, "note"),
            ClientMutationId = MockAdapter.Str(input, "clientMutationId"),
        };
        if (MockAdapter.Int(input, "timeSpent") is { } ts) x.TimeSpent = ts;
        return x;
    }

    public static Sdk.TaskUpdateInput TaskUpdate(JsonObject input)
    {
        var x = new Sdk.TaskUpdateInput
        {
            ID = MockAdapter.Str(input, "id"),
            TimeSpentEffortClassId = MockAdapter.Str(input, "timeSpentEffortClassId"),
            Note = MockAdapter.Str(input, "note"),   // timeEntryDescription SDK'da yok — üstteki not
            ClientMutationId = MockAdapter.Str(input, "clientMutationId"),
        };
        if (MockAdapter.Int(input, "timeSpent") is { } ts) x.TimeSpent = ts;
        return x;
    }
}
