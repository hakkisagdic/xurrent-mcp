using XurrentMcp.Calendars;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Core;

/// <summary>
/// ★ 8 tool'un SAF hâli: argüman girer, sonuç çıkar.
///
/// Bu dosyada MCP'ye ait TEK BİR TİP YOKTUR — ne CallToolResult, ne McpServer,
/// ne elicitation. Sebep protokol sözleşmesinin ana tezi:
///
///     "Protokol revizyonu tool sözleşmeni bozmamalı. İş mantığını protokolden
///      ayırdıysan, breaking change seni ince bir adaptör katmanında yakalar."
///
/// Yazma tool'ları onay gerektiğinde <see cref="ConfirmationRequest"/> döner ve
/// onayın NASIL sorulacağını bilmez. Bunu protokole çeviren Mcp/McpTools.cs'tir:
///   v1 (2025-11-25) → elicitation/create İSTEĞİ
///   v2 (2026-07-28) → InputRequiredResult SONUCU + imzalı requestState
/// </summary>
public static class ToolImpl
{
    // ── Okuma tool'ları ──────────────────────────────────────────────────────

    public static Task<WhoAmIResult> WhoAmIAsync(IXurrentAdapter adapter, CancellationToken ct)
        => adapter.WhoAmIAsync(ct);

    public static Task<FindPersonResult> FindPersonAsync(
        IXurrentAdapter adapter, string email, string view, CancellationToken ct)
        // view yalnızca iki değer alır; bilinmeyen her şey 'all'a düşer (Xurrent varsayılanı
        // 'current_account'tur ve kişinin diğer hesaplardaki kaydını GİZLER).
        => adapter.FindPersonAsync(email, view is "current_account" ? "current_account" : "all", ct);

    public static Task<ListOpenWorkResult> ListOpenWorkAsync(
        IXurrentAdapter adapter, string personId, string[]? include, int first,
        string? afterRequests, string? afterTasks, string view, CancellationToken ct)
    {
        var includes = include is { Length: > 0 } ? include : ["requests", "tasks"];
        var args = new ListOpenWorkArgs(
            personId, includes, Math.Clamp(first, 1, 100), afterRequests, afterTasks,
            view is "current_account" ? "current_account" : "all");
        return adapter.ListOpenWorkAsync(args, ct);
    }

    public static Task<TimeTrackingContext> TimeTrackingContextAsync(
        IXurrentAdapter adapter, string personId, CancellationToken ct)
        => adapter.GetTimeTrackingContextAsync(personId, ct);

    public static Task<CalendarResult> CalendarListTodayAsync(
        CalendarFactory calendar, string provider, string? userEmail, string? date, string timeZone,
        bool includeAllDay, bool includeDeclined, bool includeFree, CancellationToken ct)
    {
        // Pencere HER ZAMAN yerel gece yarısından yerel gece yarısına, OFFSET GÖMÜLÜ kurulur.
        var window = calendar.BuildWindow(date, timeZone);
        var options = new CalendarOptions(includeAllDay, includeDeclined, includeFree, userEmail);
        return calendar.ReadAsync(provider, window, options, ct);
    }

    // ── Önizleme: takvimden plan üretimi (YAPISAL OLARAK yazamaz) ─────────────

    /// <summary>
    /// Bu fonksiyon ÖNERİ üretir, asla yazmaz. Dry-run'ın en güçlü katmanı budur:
    /// "yazmamayı" bir bayrağa değil, fonksiyonun YETENEĞİNE bağlamak.
    /// </summary>
    public static async Task<PlanResult> PlanFromCalendarAsync(
        AppConfig cfg, IXurrentAdapter adapter, CalendarFactory calendar,
        string personId, string? date, string timeZone, string provider,
        string? defaultTargetType, string? defaultTargetId, string roundingMode, CancellationToken ct)
    {
        var window = calendar.BuildWindow(date, timeZone);
        var cal = await calendar.ReadAsync(provider, window, new CalendarOptions(), ct);

        var ctx = await adapter.GetTimeTrackingContextAsync(personId, ct);
        var increment = ctx.TimeIncrement ?? 60;

        var work = await adapter.ListOpenWorkAsync(
            new ListOpenWorkArgs(personId, ["requests", "tasks"], 100, null, null, "all"), ct);

        var candidates = work.Requests.Nodes.Concat(work.Tasks.Nodes).ToList();

        var fallbackType = defaultTargetType ?? "time_allocation";

        // K6 — YEDEK HEDEF ZİNCİRİ (üç dilde de aynı):
        //   1) defaultTargetId argümanı
        //   2) DEFAULT_TIME_ALLOCATION_ID ortam değişkeni
        //   3) hesaptaki İLK TimeAllocation
        // Üçü de yoksa hedef boş kalır ve öneri needsUserDecision ile kullanıcıya düşer.
        var fallbackId = FirstNonEmpty(
            defaultTargetId,
            cfg.DefaultTimeAllocationId,
            ctx.TimeAllocations.FirstOrDefault()?.Id);

        var fallbackLabel = ctx.TimeAllocations.FirstOrDefault(a => a.Id == fallbackId)?.Name ?? fallbackId;

        var mode = roundingMode is "up" or "down" ? roundingMode : cfg.RoundingMode;

        var proposals = new List<Proposal>();
        var unmatched = new List<string>();

        // Elenen etkinlikler öneri üretmez — sadece gerçek toplantılar.
        foreach (var m in cal.Meetings.Where(m => !m.Skipped))
        {
            var warnings = new List<string>();
            var rounded = TimeUtil.RoundToIncrement(m.Minutes, increment, mode);

            // Yuvarlama SESSİZCE yapılmaz; her zaman uyarıya yazılır.
            if (rounded != m.Minutes)
                warnings.Add($"Süre {m.Minutes} dakikaydı; bu hesabın timeIncrement değeri {increment} " +
                             $"olduğu için {rounded} dakikaya yuvarlandı (mod: {mode}). " +
                             "Kullanıcı onayı alınmadan yazılmamalıdır.");

            var match = Matcher.Match(m.Title, candidates);

            string? targetType, targetId, label;
            if (match.NeedsUserDecision)
            {
                targetType = fallbackType;
                targetId = fallbackId;
                label = fallbackLabel;
                unmatched.Add(m.Title);
            }
            else
            {
                targetType = match.Item!.Kind;              // "request" | "task"
                targetId = match.Item.Id;
                label = $"#{match.Item.DisplayId} {match.Item.Subject}";
            }

            proposals.Add(new Proposal(
                MeetingTitle: m.Title,
                StartedAt: m.Start,
                RawMinutes: m.Minutes,
                RoundedMinutes: rounded,
                SuggestedTargetType: targetType,
                SuggestedTargetId: targetId,
                SuggestedTargetLabel: label,
                MatchReason: match.Reason,
                MatchConfidence: match.Confidence,
                NeedsUserDecision: match.NeedsUserDecision,
                Warnings: warnings));
        }

        return new PlanResult(
            Date: window.Date.ToString("yyyy-MM-dd"),
            TimeIncrement: increment,
            Proposals: proposals,
            UnmatchedMeetings: unmatched,
            Totals: new PlanTotals(proposals.Sum(p => p.RawMinutes), proposals.Sum(p => p.RoundedMinutes)));
    }

    private static string FirstNonEmpty(params string?[] candidates)
        => candidates.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c)) ?? "";

    // ── Yazma tool'ları ──────────────────────────────────────────────────────

    /// <summary>
    /// K5 — ONAY NE ZAMAN İSTENİR?
    ///
    ///   dryRun=true                    → asla (hiçbir mutation gitmiyor)
    ///   XURRENT_CONFIRM_POLICY=open    → asla (yalnızca CI/otomasyon içindir)
    ///   XURRENT_CONFIRM_POLICY=closed  → HER ZAMAN sorulur (VARSAYILAN)
    ///   XURRENT_CONFIRM_POLICY=strict  → HER ZAMAN sorulur
    ///
    /// ★ SORMAK ile SORAMAYINCA NE YAPMAK birbirinden AYRI iki karardır.
    ///   Burası yalnızca birincisini yanıtlar. Client onayı SORAMIYORSA ne olacağı
    ///   McpTools.AskForApprovalAsync içindeki catch bloğunda karara bağlanır:
    ///     closed + mock → uyarı üretilip DEVAM edilir
    ///     closed + live → REDDEDİLİR
    ///     strict        → her koşulda REDDEDİLİR
    ///
    /// NEDEN mock modda da soruyoruz: mock, üretimin SİMÜLASYONUDUR — onay akışı da
    /// simülasyonun parçası. Ayrıca sihirbazın 11. adımının tüm anlatımı buna dayanıyor
    /// ve TypeScript ile Python zaten böyle davranıyor. Ölçüm bu dosyanın eskiden tek
    /// ayrık implementasyon olduğunu gösterdi; hizalandı.
    /// </summary>
    public static bool RequiresConfirmation(AppConfig cfg, bool dryRun)
    {
        if (dryRun || cfg.XurrentDryRun) return false;
        return cfg.XurrentConfirmPolicy != "open";
    }

    /// <summary>
    /// Tek zaman girişi. Onay gerekiyorsa ÖNCE dry-run planı üretilir ve onay metni
    /// bu plandan yazılır — kullanıcı "ne olacağını" görmeden onaylamak zorunda kalmaz.
    /// </summary>
    public static async Task<ToolOutcome<WriteResult>> CreateTimeEntryAsync(
        AppConfig cfg, IXurrentAdapter adapter, TimeEntryRequest req, bool dryRun, bool approved, CancellationToken ct)
    {
        if (!IsKnownTarget(req.TargetType))
        {
            var err = new WriteResult(true, "link_first", "", [], [], null, [
                new ValidationError(
                    $"Geçersiz targetType: '{req.TargetType}'. " +
                    "İzinli değerler: time_allocation, request, task, project_task, problem.", ["targetType"])
            ]);
            return ToolOutcome<WriteResult>.Completed(err);
        }

        if (!approved && RequiresConfirmation(cfg, dryRun))
        {
            var preview = await Strategies.RunAsync(cfg, adapter, req, dryRun: true, ct);

            // Plan zaten hatalıysa onay sormanın anlamı yok — hatayı doğrudan göster.
            if (preview.Errors.Count > 0)
                return ToolOutcome<WriteResult>.Completed(preview);

            var label = await adapter.ResolveTargetLabelAsync(req.TargetType, req.TargetId, ct) ?? req.TargetId;
            var details = new Dictionary<string, string>
            {
                ["Hedef"] = $"{req.TargetType} · {label}",
                ["Süre"] = $"{req.Minutes} dakika",
                ["Tarih"] = req.Date ?? "bugün",
                ["Strateji"] = preview.Strategy,
                ["Gidecek mutation sayısı"] = preview.Planned.Count.ToString(),
            };
            if (preview.Warnings.Count > 0)
                details["Uyarılar"] = string.Join(" | ", preview.Warnings);

            return ToolOutcome<WriteResult>.NeedsConfirmation(new ConfirmationRequest(
                $"{req.Minutes} dakikalık zaman girişi Xurrent'a YAZILACAK ({label}). Onaylıyor musun?",
                details));
        }

        return ToolOutcome<WriteResult>.Completed(await Strategies.RunAsync(cfg, adapter, req, dryRun, ct));
    }

    /// <summary>
    /// Toplu yazma. ATOMİK DEĞİLDİR ve bu gizlenmez.
    ///   - GraphQL istek başına 1 mutation kabul eder -> bulk = N ayrı HTTP isteği.
    ///   - Rate limit 20 istek / 2 saniye -> istekler arası en az 110 ms bekleme.
    ///   - Kısmi başarı NORMALDİR; her satır ayrı raporlanır.
    ///   - Onay N kez değil, ÖZET üzerinden BİR kez sorulur.
    /// </summary>
    public static async Task<ToolOutcome<BulkResult>> CreateTimeEntriesBulkAsync(
        AppConfig cfg, IXurrentAdapter adapter, TimeEntryRequest[] entries,
        bool dryRun, bool stopOnError, bool approved, CancellationToken ct)
    {
        if (entries.Length is 0 or > 50)
        {
            var err = new BulkResult(true, [], [
                new BulkRowResult(0, "failed", null, [
                    new ValidationError("entries en az 1, en fazla 50 satır içermelidir.", ["entries"])
                ])
            ], new BulkSummary(entries.Length, 0, entries.Length, 0, 0));
            return ToolOutcome<BulkResult>.Completed(err);
        }

        if (!approved && RequiresConfirmation(cfg, dryRun))
        {
            var totalMinutesPreview = entries.Sum(e => e.Minutes);
            return ToolOutcome<BulkResult>.NeedsConfirmation(new ConfirmationRequest(
                $"{entries.Length} zaman girişi ({totalMinutesPreview} dakika) Xurrent'a YAZILACAK. Onaylıyor musun?",
                new Dictionary<string, string>
                {
                    ["Satır sayısı"] = entries.Length.ToString(),
                    ["Toplam süre"] = $"{totalMinutesPreview} dakika",
                    ["İlk hatada dur"] = stopOnError ? "evet" : "hayır",
                    ["Uyarı"] = "Toplu yazma ATOMİK DEĞİLDİR — kısmi başarı mümkündür ve geri alınmaz.",
                }));
        }

        var planned = new List<PlannedMutation>();
        var results = new List<BulkRowResult>();
        int created = 0, failed = 0, skipped = 0, totalMinutes = 0;
        var stopped = false;

        for (var i = 0; i < entries.Length; i++)
        {
            if (stopped)
            {
                results.Add(new BulkRowResult(i, "skipped", null, []));
                skipped++;
                continue;
            }

            var e = entries[i];

            if (!IsKnownTarget(e.TargetType))
            {
                results.Add(new BulkRowResult(i, "failed", null, [
                    new ValidationError($"Geçersiz targetType: '{e.TargetType}'.",
                        ["entries", i.ToString(), "targetType"])
                ]));
                failed++;
                if (stopOnError) stopped = true;
                continue;
            }

            var one = await Strategies.RunAsync(cfg, adapter, e, dryRun, ct);

            // Plan çıktısı satır bazlı izlenebilsin diye index yeniden yazılır.
            foreach (var p in one.Planned) planned.Add(p with { Index = i });

            if (one.Errors.Count > 0)
            {
                results.Add(new BulkRowResult(i, "failed", null, one.Errors));
                failed++;
                if (stopOnError) stopped = true;
                continue;
            }

            if (one.DryRun)
            {
                // dry-run'da hiçbir şey oluşturulmadı; "skipped" ile açıkça belirtiyoruz.
                results.Add(new BulkRowResult(i, "skipped", null, []));
                skipped++;
            }
            else
            {
                results.Add(new BulkRowResult(i, "created", one.TimeEntry?["id"]?.GetValue<string>(), []));
                created++;
            }
            totalMinutes += e.Minutes;

            // Rate limit: 20 istek / 2 saniye. Satırlar arasında da bekliyoruz.
            if (!dryRun && i < entries.Length - 1)
                await Task.Delay(Strategies.RateLimitDelayMs, ct);
        }

        return ToolOutcome<BulkResult>.Completed(new BulkResult(dryRun, planned, results,
            new BulkSummary(entries.Length, created, failed, skipped, totalMinutes)));
    }

    public static bool IsKnownTarget(string targetType)
        => targetType is "time_allocation" or "request" or "task" or "project_task" or "problem";

    /// <summary>Onay REDDEDİLDİĞİNDE dönen sonuç. Hiçbir mutation gitmemiştir.</summary>
    public static WriteResult DeclinedWrite(string reason)
        => new(true, "link_first", "", [], [], null, [new ValidationError(reason, ["_confirmation"])]);

    /// <summary>Toplu yazmanın onay reddi karşılığı.</summary>
    public static BulkResult DeclinedBulk(int requested, string reason)
        => new(true, [], [new BulkRowResult(0, "failed", null, [new ValidationError(reason, ["_confirmation"])])],
            new BulkSummary(requested, 0, 0, requested, 0));
}
