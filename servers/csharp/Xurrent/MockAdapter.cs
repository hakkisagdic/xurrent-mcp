using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace XurrentMcp.Xurrent;

/// <summary>
/// fixtures/ klasörünü okuyan mock adapter.
/// TypeScript ve Python implementasyonları AYNI dosyaları AYNI kurallarla okur;
/// üç dil de birebir aynı sayıları üretir. Dersin "dil bir detaydır" iddiasının kanıtı budur.
/// </summary>
public sealed class MockAdapter : IXurrentAdapter
{
    private readonly AppConfig _cfg;
    private readonly TimeZoneInfo _tz;

    private readonly JsonNode _people;
    private readonly JsonNode _requests;
    private readonly JsonNode _tasks;
    private readonly JsonNode _effortClasses;
    private readonly JsonNode _timesheet;
    private readonly JsonNode _timeAllocations;

    // Mutasyonlar bu listede birikir. Fixture dosyası varsayılan olarak DEĞİŞTİRİLMEZ.
    private readonly List<MockTimeEntry> _timeEntries = [];
    // Yol B (parent update) ARTIMLI timeSpent uygular; toplamlar burada tutulur.
    private readonly Dictionary<string, int> _parentTotals = new(StringComparer.Ordinal);
    private int _entrySeq;

    // Zaman takibi bağlamı session içinde cache'lenir (sözleşmenin teachingNotes maddesi).
    private TimeTrackingContext? _contextCache;

    private readonly Lock _gate = new();

    public string Mode => "mock";

    public MockAdapter(AppConfig cfg)
    {
        _cfg = cfg;
        _tz = cfg.TimeZone;

        _people = LoadFixture("people.json");
        _requests = LoadFixture("requests.json");
        _tasks = LoadFixture("tasks.json");
        _effortClasses = LoadFixture("effort-classes.json");
        _timesheet = LoadFixture("timesheet-settings.json");
        _timeAllocations = LoadFixture("time-allocations.json");

        var seeded = LoadFixture("time-entries.json");
        foreach (var node in seeded["timeEntries"]!.AsArray())
        {
            var e = node!.AsObject();
            _entrySeq++;
            var entry = new MockTimeEntry
            {
                Id = Str(e, "id") ?? NextEntryId(),
                PersonId = Str(e, "personId") ?? MeId,
                AssignmentType = Str(e, "assignmentType"),
                AssignmentId = Str(e, "assignmentId"),
                Date = Today.AddDays(Int(e, "dayOffset") ?? 0),
                StartedAt = TimeUtil.AtLocal(
                    Today.AddDays(Int(e, "dayOffset") ?? 0),
                    TimeUtil.ParseHhMm(Str(e, "startedAtLocal")), _tz),
                TimeSpent = Int(e, "timeSpent") ?? 0,
                Description = Str(e, "description"),
                EffortClassId = Str(e, "effortClassId"),
                Correction = Bool(e, "correction") ?? false,
                Source = Str(e, "source"),
                SourceId = Str(e, "sourceID"),
            };
            _timeEntries.Add(entry);
            if (entry.AssignmentId is not null)
                _parentTotals[entry.AssignmentId] = _parentTotals.GetValueOrDefault(entry.AssignmentId) + entry.TimeSpent;
        }
    }

    /// <summary>Fixture'ların göreli tarihleri bu "bugün"e göre materyalize edilir (cfg.Clock enjekte edilebilir).</summary>
    private DateOnly Today => TimeUtil.Today(_tz, _cfg.Clock);

    private JsonNode LoadFixture(string file)
    {
        var path = Path.Combine(_cfg.FixturesDir, file);
        if (!File.Exists(path))
            throw new FileNotFoundException($"Fixture bulunamadı: {path}. XURRENT_FIXTURES_DIR doğru mu?", path);
        return JsonNode.Parse(File.ReadAllText(path))!;
    }

    private string MeId => Str(_people.AsObject(), "me") ?? "";

    // ── Kimlik ───────────────────────────────────────────────────────────────

    public Task<WhoAmIResult> WhoAmIAsync(CancellationToken ct)
    {
        var me = FindPersonNode(MeId) ?? throw new InvalidOperationException("people.json içindeki 'me' kaydı bulunamadı.");
        var acc = _people["account"]!.AsObject();

        // K4 — mock modda rateLimit NULL döner (üç dilde de).
        // NEDEN: mock adapter hiçbir HTTP isteği yapmaz; uydurma bir limit "gerçek" gibi okunur.
        // Daha kötüsü: resetAt'e gerçek zaman damgası koymak çıktıyı DETERMİNİSTİK olmaktan
        // çıkarır ve "üç dil aynı çıktıyı üretir" tezini her çalıştırmada kırar.
        // Sözleşme bu alanı ["object","null"] olarak tanımlar; null geçerli bir cevaptır.
        return Task.FromResult(new WhoAmIResult(
            ToPerson(me),
            new AccountInfo(Str(acc, "id") ?? "", Str(acc, "name"), Bool(acc, "directory")),
            "mock",
            null));
    }

    public Task<FindPersonResult> FindPersonAsync(string email, string view, CancellationToken ct)
    {
        // TAM eşleşme — Xurrent PersonFilter.primaryEmail bir TextFilter'dır, substring DEĞİL.
        var matches = PeopleArray()
            .Where(p => string.Equals(Str(p, "primaryEmail"), email, StringComparison.Ordinal))
            .Select(ToPerson)
            .ToList();

        // view='current_account' kişinin diğer hesaplardaki kaydını gizler; mock'ta tek hesap var.
        return Task.FromResult(new FindPersonResult(matches.Count, matches, matches.Count == 0));
    }

    public Task<string> ResolvePersonIdAsync(string personId, CancellationToken ct)
        => Task.FromResult(string.IsNullOrWhiteSpace(personId) || personId == "$me" ? MeId : personId);

    // ── Açık işler ───────────────────────────────────────────────────────────

    public async Task<ListOpenWorkResult> ListOpenWorkAsync(ListOpenWorkArgs args, CancellationToken ct)
    {
        var personId = await ResolvePersonIdAsync(args.PersonId, ct);
        var wantRequests = args.Include.Contains("requests");
        var wantTasks = args.Include.Contains("tasks");

        var requestNodes = new List<WorkItem>();
        if (wantRequests)
        {
            foreach (var node in _requests["requests"]!.AsArray())
            {
                var r = node!.AsObject();
                // TUZAK: Request'te atanan kişi alanı "member"dır.
                if (Str(r, "memberId") != personId) continue;
                // TUZAK: RequestStatus'ta TEK terminal değer "completed"tir.
                var status = Str(r, "status") ?? "";
                if (ClosedRequestStatuses.Contains(status)) continue;

                requestNodes.Add(new WorkItem(
                    Kind: "request",
                    Id: Str(r, "id") ?? "",
                    DisplayId: Str(r, "requestId") ?? "",   // UI numarası: requestId
                    Subject: Str(r, "subject"),
                    Status: status,
                    StatusLabel: Str(r, "statusLabel"),
                    IsOpen: true,
                    TargetAt: OffsetDaysToIso(Int(r, "targetAtOffsetDays"), 17),  // Request'te nextTargetAt
                    Team: Str(r, "team"),
                    Member: PersonName(Str(r, "memberId")),
                    ParentLabel: Str(r, "serviceName"),
                    UpdatedAt: OffsetDaysToIso(Int(r, "updatedAtOffsetDays"), 12)));
            }
        }

        var taskNodes = new List<WorkItem>();
        if (wantTasks)
        {
            foreach (var node in _tasks["tasks"]!.AsArray())
            {
                var t = node!.AsObject();
                // TUZAK: Task'ta atanan kişi alanı "assignee"dir — "member" YOKTUR.
                if (Str(t, "assigneeId") != personId) continue;
                // TUZAK: TaskStatus'ta BEŞ terminal değer vardır. "approved" da KAPALIDIR.
                var status = Str(t, "status") ?? "";
                if (ClosedTaskStatuses.Contains(status)) continue;

                taskNodes.Add(new WorkItem(
                    Kind: "task",
                    Id: Str(t, "id") ?? "",
                    DisplayId: Str(t, "taskId") ?? "",      // UI numarası: taskId
                    Subject: Str(t, "subject"),
                    Status: status,
                    StatusLabel: Str(t, "statusLabel"),
                    IsOpen: true,
                    TargetAt: OffsetDaysToIso(Int(t, "targetAtOffsetDays"), 17), // Task'ta completionTargetAt
                    Team: Str(t, "team"),
                    Member: PersonName(Str(t, "assigneeId")),
                    ParentLabel: Str(t, "workflowSubject") ?? RequestSubject(Str(t, "linkedRequestId")),
                    UpdatedAt: OffsetDaysToIso(Int(t, "updatedAtOffsetDays"), 12)));
            }
        }

        var accountId = Str(_people["account"]!.AsObject(), "id") ?? "";

        // Sayfalama mock'ta basitçe kesme ile taklit edilir.
        var reqPage = Paginate(requestNodes, args.First);
        var taskPage = Paginate(taskNodes, args.First);

        return new ListOpenWorkResult(accountId, reqPage, taskPage);
    }

    private static WorkPage Paginate(List<WorkItem> all, int first)
    {
        var page = all.Take(first).ToList();
        return new WorkPage(all.Count, all.Count > page.Count, page.Count > 0 ? page[^1].Id : null, page);
    }

    // ── Zaman takibi bağlamı ─────────────────────────────────────────────────

    public Task<TimeTrackingContext> GetTimeTrackingContextAsync(string personId, CancellationToken ct)
    {
        lock (_gate)
        {
            if (_contextCache is not null) return Task.FromResult(_contextCache);
        }

        var s = _timesheet["timesheetSetting"]!.AsObject();
        var d = s["defaults"]!.AsObject();

        // TUZAK: EffortClassFilter'da "disabled" filtresi YOKTUR -> CLIENT TARAFINDA eliyoruz.
        var classes = _effortClasses["effortClasses"]!.AsArray()
            .Select(n => n!.AsObject())
            .Where(e => Bool(e, "disabled") != true)
            .Select(e => new EffortClass(
                Str(e, "id") ?? "", Str(e, "name"), Int(e, "position"),
                Dbl(e, "costMultiplier"), Bool(e, "disabled")))
            .ToList();

        var allocations = _timeAllocations["timeAllocations"]!.AsArray()
            .Select(n => n!.AsObject())
            .Select(a => new TimeAllocationInfo(
                Str(a, "id") ?? "", Str(a, "name"), Str(a, "group"), Bool(a, "descriptionRequired")))
            .ToList();

        var ctx = new TimeTrackingContext(
            Unit: Str(s, "unit"),
            TimeIncrement: Int(s, "timeIncrement"),
            Workday: Int(s, "workday"),
            Workweek: Int(s, "workweek"),
            AllowWorkdayOvertime: Bool(s, "allowWorkdayOvertime"),
            AllowWorkweekOvertime: Bool(s, "allowWorkweekOvertime"),
            AllocationTimeTracking: Bool(s, "allocationTimeTracking"),
            AssignmentTimeTracking: Bool(s, "assignmentTimeTracking"),
            RequireNote: Bool(s, "requireNote"),
            RequireTimeEntryDescription: Bool(s, "requireTimeEntryDescription"),
            EffortClasses: classes,
            TimeAllocations: allocations,
            Defaults: new TimeTrackingDefaults(
                Str(d, "requestEffortClassId"), Str(d, "taskEffortClassId"),
                Str(d, "projectTaskEffortClassId"), Str(d, "problemEffortClassId"),
                Str(d, "timeAllocationEffortClassId")));

        lock (_gate) { _contextCache = ctx; }
        return Task.FromResult(ctx);
    }

    public Task<string?> ResolveTargetLabelAsync(string targetType, string targetId, CancellationToken ct)
    {
        string? label = targetType switch
        {
            "request" => _requests["requests"]!.AsArray().Select(n => n!.AsObject())
                .Where(r => Str(r, "id") == targetId)
                .Select(r => $"#{Str(r, "requestId")} {Str(r, "subject")}").FirstOrDefault(),
            "task" => _tasks["tasks"]!.AsArray().Select(n => n!.AsObject())
                .Where(t => Str(t, "id") == targetId)
                .Select(t => $"#{Str(t, "taskId")} {Str(t, "subject")}").FirstOrDefault(),
            "time_allocation" => _timeAllocations["timeAllocations"]!.AsArray().Select(n => n!.AsObject())
                .Where(a => Str(a, "id") == targetId)
                .Select(a => Str(a, "name")).FirstOrDefault(),
            _ => null,
        };
        return Task.FromResult(label);
    }

    public Task<int> GetLoggedMinutesAsync(string personId, DateOnly date, CancellationToken ct)
    {
        lock (_gate)
        {
            var total = _timeEntries
                .Where(e => e.PersonId == personId && e.Date == date)
                .Sum(e => e.TimeSpent);
            return Task.FromResult(total);
        }
    }

    /// <summary>Mock modda gerçek TimeAllocation kaydını bulur (descriptionRequired kontrolü için).</summary>
    public JsonObject? FindTimeAllocation(string id)
        => _timeAllocations["timeAllocations"]!.AsArray().Select(n => n!.AsObject())
            .FirstOrDefault(a => Str(a, "id") == id);

    /// <summary>
    /// Dedup geri-okuması (reliability.md §5) — mock karşılığı: bellek içi store'da
    /// sourceID araması. Live adapter aynı soruyu timeEntries(filter: sourceID)
    /// sorgusuyla sorar; tool katmanı hangisiyle konuştuğunu BİLMEZ, dedup bu sayede
    /// mock modda da birebir test edilebilir.
    /// </summary>
    public Task<JsonObject?> FindTimeEntryBySourceIdAsync(string sourceId, CancellationToken ct)
    {
        lock (_gate)
        {
            var entry = _timeEntries.LastOrDefault(e => e.SourceId == sourceId);
            return Task.FromResult(entry?.ToJson());
        }
    }

    /// <summary>
    /// xurrent_list_time_entries — mock karşılığı: bellek içi store filtrelenir.
    /// Sıralama fake sunucuyla aynı: EN YENİ kayıt başta (ekleme sırasının tersi).
    /// totalMinutes DÖNEN kayıtların toplamıdır (correction'lar işaretli dahil).
    /// </summary>
    public async Task<TimeEntryPage> ListTimeEntriesAsync(ListTimeEntriesArgs args, CancellationToken ct)
    {
        var personId = await ResolvePersonIdAsync(args.PersonId, ct);
        var from = string.IsNullOrWhiteSpace(args.DateFrom) ? (DateOnly?)null : TimeUtil.ParseDate(args.DateFrom, _tz, _cfg.Clock);
        var to = string.IsNullOrWhiteSpace(args.DateTo) ? (DateOnly?)null : TimeUtil.ParseDate(args.DateTo, _tz, _cfg.Clock);
        var first = Math.Clamp(args.First, 1, 100);

        List<TimeEntryRecord> rows;
        lock (_gate)
        {
            rows = _timeEntries
                .Where(e => e.PersonId == personId
                            && (from is null || e.Date >= from)
                            && (to is null || e.Date <= to)
                            && (string.IsNullOrWhiteSpace(args.SourceId) || e.SourceId == args.SourceId))
                .Reverse()          // en yeni başta — fake sunucu da store'u ters çevirir
                .Take(first)
                .Select(ToRecord)
                .ToList();
        }

        var accountId = Str(_people["account"]!.AsObject(), "id") ?? "";
        return new TimeEntryPage(accountId, rows, rows.Sum(r => r.TimeSpent));
    }

    private TimeEntryRecord ToRecord(MockTimeEntry e) => new(
        Id: e.Id,
        Date: e.Date.ToString("yyyy-MM-dd"),
        StartedAt: e.StartedAt is null ? null : TimeUtil.ToIso(e.StartedAt.Value),
        TimeSpent: e.TimeSpent,
        Description: e.Description,
        Correction: e.Correction,
        Source: e.Source,
        SourceId: e.SourceId,
        Person: new TimeEntryPersonRef(e.PersonId, PersonName(e.PersonId)),
        // ★ Yol A kayıtlarında assignment NULL'dur — ticket bağı yoktur (dersin kalbi).
        Assignment: e.AssignmentId is null
            ? null
            : new TimeEntryAssignmentRef(e.AssignmentType, e.AssignmentId, DisplayIdOf(e.AssignmentType, e.AssignmentId)),
        EffortClass: e.EffortClassId is null
            ? null
            : new TimeEntryEffortClassRef(e.EffortClassId, EffortClassName(e.EffortClassId)));

    private string? DisplayIdOf(string? assignmentType, string assignmentId) => assignmentType switch
    {
        "Request" => _requests["requests"]!.AsArray().Select(n => n!.AsObject())
            .Where(r => Str(r, "id") == assignmentId).Select(r => Str(r, "requestId")).FirstOrDefault(),
        "Task" => _tasks["tasks"]!.AsArray().Select(n => n!.AsObject())
            .Where(t => Str(t, "id") == assignmentId).Select(t => Str(t, "taskId")).FirstOrDefault(),
        _ => null,
    };

    private string? EffortClassName(string id)
        => _effortClasses["effortClasses"]!.AsArray().Select(n => n!.AsObject())
            .Where(e => Str(e, "id") == id).Select(e => Str(e, "name")).FirstOrDefault();

    // ── Mutasyonlar ──────────────────────────────────────────────────────────

    public Task<MutationOutcome> ExecuteAsync(PlannedMutation step, CancellationToken ct)
    {
        lock (_gate)
        {
            var input = step.Input["input"]?.AsObject() ?? new JsonObject();
            return Task.FromResult(step.Path switch
            {
                "timeEntryCreate" => ApplyTimeEntryCreate(input),
                "timeEntryUpdate" => ApplyTimeEntryUpdate(input),
                "requestUpdate" => ApplyParentUpdate("Request", input),
                "taskUpdate" => ApplyParentUpdate("Task", input),
                "projectTaskUpdate" => ApplyParentUpdate("ProjectTask", input),
                "problemUpdate" => ApplyParentUpdate("Problem", input),
                _ => MutationOutcome.Fail($"Bilinmeyen mutation: {step.Path}"),
            });
        }
    }

    private MutationOutcome ApplyTimeEntryCreate(JsonObject input)
    {
        var minutes = Int(input, "timeSpent") ?? 0;
        if (minutes < 0 && Bool(input, "correction") != true)
            return MutationOutcome.Fail("Negatif timeSpent yalnızca correction=true ile mümkündür.", "timeSpent");

        var entry = new MockTimeEntry
        {
            Id = NextEntryId(),
            PersonId = Str(input, "personId") ?? MeId,
            // YOL A: assignment YOKTUR — kayıt hiçbir ticket'a bağlı DEĞİLDİR.
            AssignmentType = null,
            AssignmentId = null,
            TimeAllocationId = Str(input, "timeAllocationId"),
            Date = Str(input, "date") is { } ds ? TimeUtil.ParseDate(ds, _tz, _cfg.Clock) : Today,
            StartedAt = Str(input, "startedAt") is { } sa && DateTimeOffset.TryParse(sa, out var p) ? p : null,
            TimeSpent = minutes,
            Description = Str(input, "description"),
            EffortClassId = Str(input, "effortClassId"),
            Correction = Bool(input, "correction") ?? false,
            Source = Str(input, "source"),
            SourceId = Str(input, "sourceID"),
        };
        _timeEntries.Add(entry);
        return new MutationOutcome(entry.ToJson(), []);
    }

    private MutationOutcome ApplyTimeEntryUpdate(JsonObject input)
    {
        var id = Str(input, "id");
        var entry = _timeEntries.FirstOrDefault(e => e.Id == id);
        if (entry is null)
            return MutationOutcome.Fail($"TimeEntry bulunamadı: {id}", "id");

        // KRİTİK: assignment alanı input'ta YOK -> ticket bağına DOKUNULMUYOR.
        if (Str(input, "date") is { } d) entry.Date = TimeUtil.ParseDate(d, _tz, _cfg.Clock);
        if (Str(input, "startedAt") is { } s && DateTimeOffset.TryParse(s, out var parsed)) entry.StartedAt = parsed;
        if (Str(input, "personId") is { } pid) entry.PersonId = pid;
        if (Int(input, "timeSpent") is { } ts) entry.TimeSpent = ts;
        if (Str(input, "description") is { } desc) entry.Description = desc;
        if (Str(input, "effortClassId") is { } ec) entry.EffortClassId = ec;

        return new MutationOutcome(entry.ToJson(), []);
    }

    private MutationOutcome ApplyParentUpdate(string assignmentType, JsonObject input)
    {
        var parentId = Str(input, "id");
        if (parentId is null) return MutationOutcome.Fail("Hedef kaydın id'si eksik.", "id");

        var added = Int(input, "timeSpent") ?? 0;

        // ARTIMLI: timeSpent "eklenen süre"dir, toplam değil. Toplamı BİZ takip ediyoruz.
        _parentTotals[parentId] = _parentTotals.GetValueOrDefault(parentId) + added;

        var entry = new MockTimeEntry
        {
            Id = NextEntryId(),
            // YOL B: person = authenticated user, date = BUGÜN. Sunucu atar, kontrol edilemez.
            PersonId = MeId,
            Date = Today,
            StartedAt = null,
            AssignmentType = assignmentType,
            AssignmentId = parentId,
            TimeSpent = added,
            Description = Str(input, "timeEntryDescription"),
            EffortClassId = Str(input, "timeSpentEffortClassId"),
            Correction = false,
            Source = _cfg.XurrentSource,
            SourceId = Str(input, "sourceID"),
        };
        _timeEntries.Add(entry);

        var json = entry.ToJson();
        json["_parentTotalMinutes"] = _parentTotals[parentId];
        return new MutationOutcome(json, []);
    }

    private string NextEntryId()
    {
        _entrySeq++;
        // Fixture'daki id'lerle aynı biçim: base64("Mock/TimeEntry/N")
        return Convert.ToBase64String(Encoding.UTF8.GetBytes($"Mock/TimeEntry/{_entrySeq}")).TrimEnd('=');
    }

    /// <summary>XURRENT_MOCK_PERSIST=1 ise oluşan kayıtları fixture dosyasına geri yazar.</summary>
    public void PersistIfRequested()
    {
        if (Environment.GetEnvironmentVariable("XURRENT_MOCK_PERSIST") is not ("1" or "true")) return;
        lock (_gate)
        {
            var arr = new JsonArray();
            foreach (var e in _timeEntries) arr.Add(e.ToJson());
            var doc = new JsonObject { ["_comment"] = "Mock modda üretildi.", ["timeEntries"] = arr };
            File.WriteAllText(Path.Combine(_cfg.FixturesDir, "time-entries.json"), Json.WritePretty(doc));
        }
    }

    // ── Yardımcılar ──────────────────────────────────────────────────────────

    private static readonly HashSet<string> ClosedRequestStatuses =
        new(StringComparer.Ordinal) { "completed" };

    private static readonly HashSet<string> ClosedTaskStatuses =
        new(StringComparer.Ordinal) { "completed", "approved", "failed", "rejected", "canceled" };

    private IEnumerable<JsonObject> PeopleArray()
        => _people["people"]!.AsArray().Select(n => n!.AsObject());

    private JsonObject? FindPersonNode(string id)
        => PeopleArray().FirstOrDefault(p => Str(p, "id") == id);

    private string? PersonName(string? id)
        => id is null ? null : Str(FindPersonNode(id) ?? [], "name");

    private string? RequestSubject(string? id)
        => id is null ? null : _requests["requests"]!.AsArray().Select(n => n!.AsObject())
            .Where(r => Str(r, "id") == id).Select(r => Str(r, "subject")).FirstOrDefault();

    private static Person ToPerson(JsonObject p)
    {
        JsonObject? org = p["organization"]?.AsObject();
        return new Person(
            Str(p, "id") ?? "", Str(p, "name"), Str(p, "primaryEmail"), Str(p, "jobTitle"),
            Str(p, "timeZone"), Bool(p, "disabled"),
            org is null ? null : new OrganizationRef(Str(org, "id") ?? "", Str(org, "name")));
    }

    /// <summary>Göreli gün farkını, yerel saat h:00'da mutlak ISO8601'e çevirir.</summary>
    private string? OffsetDaysToIso(int? offsetDays, int hour)
        => offsetDays is null ? null
            : TimeUtil.ToIso(TimeUtil.AtLocal(Today.AddDays(offsetDays.Value), new TimeOnly(hour, 0), _tz));

    internal static string? Str(JsonObject o, string key)
        => o.TryGetPropertyValue(key, out var v) && v is not null && v.GetValueKind() == JsonValueKind.String
            ? v.GetValue<string>() : null;

    internal static int? Int(JsonObject o, string key)
        => o.TryGetPropertyValue(key, out var v) && v is not null && v.GetValueKind() == JsonValueKind.Number
            ? v.GetValue<int>() : null;

    internal static double? Dbl(JsonObject o, string key)
        => o.TryGetPropertyValue(key, out var v) && v is not null && v.GetValueKind() == JsonValueKind.Number
            ? v.GetValue<double>() : null;

    internal static bool? Bool(JsonObject o, string key)
        => o.TryGetPropertyValue(key, out var v) && v is not null
           && v.GetValueKind() is JsonValueKind.True or JsonValueKind.False
            ? v.GetValue<bool>() : null;

    private sealed class MockTimeEntry
    {
        public string Id = "";
        public string PersonId = "";
        public string? AssignmentType;
        public string? AssignmentId;
        public string? TimeAllocationId;
        public DateOnly Date;
        public DateTimeOffset? StartedAt;
        public int TimeSpent;
        public string? Description;
        public string? EffortClassId;
        public bool Correction;
        public string? Source;
        public string? SourceId;

        public JsonObject ToJson() => new()
        {
            ["id"] = Id,
            ["personId"] = PersonId,
            ["assignmentType"] = AssignmentType,
            ["assignmentId"] = AssignmentId,
            ["timeAllocationId"] = TimeAllocationId,
            ["date"] = Date.ToString("yyyy-MM-dd"),
            ["startedAt"] = StartedAt is null ? null : TimeUtil.ToIso(StartedAt.Value),
            ["timeSpent"] = TimeSpent,
            ["description"] = Description,
            ["effortClassId"] = EffortClassId,
            ["correction"] = Correction,
            ["source"] = Source,
            ["sourceID"] = SourceId,
        };
    }
}
