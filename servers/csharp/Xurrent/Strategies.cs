using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace XurrentMcp.Xurrent;

/// <summary>
/// ★ Bu projenin kalbi.
///
/// Xurrent'ta bir Request/Task'a zaman yazmanın İKİ yolu vardır ve ikisi de tek başına
/// isteri karşılamaz:
///
///   Yol A  timeEntryCreate           -> date/startedAt/personId TAM KONTROL,
///                                       ama TimeEntryCreateInput'ta requestId/taskId/
///                                       assignmentId ALANI YOKTUR -> ticket'a BAĞLANAMAZ.
///   Yol B  requestUpdate/taskUpdate  -> ticket'a bağlar (TEK yol),
///          projectTaskUpdate/problemUpdate  ama date="bugün" ve person=authenticated user
///                                       olarak SUNUCU atar.
///
/// Üç strateji bu çatalı üç farklı şekilde çözer. Hiçbiri "doğru cevap" değildir;
/// hangisinin uygun olduğunu raporlama ihtiyacı belirler.
/// </summary>
public static class Strategies
{
    /// <summary>two_step'in 2. adımında 1. adımın çıktısı yerine geçen yer tutucu.</summary>
    public const string PreviousEntryIdPlaceholder = "{{step1.timeEntryId}}";

    /// <summary>Rate limit 20 istek / 2 saniye -> istekler arası en az 110 ms.</summary>
    public const int RateLimitDelayMs = 110;

    private static readonly Dictionary<string, string> Explanations = new()
    {
        ["two_step"] =
            "İKİ ADIMLI TELAFİ: önce Yol B ile ticket'a bağlı bir zaman girişi oluşturulur " +
            "(bu adımda sunucu tarihi BUGÜN yapar), hemen ardından timeEntryUpdate ile date, " +
            "startedAt ve personId düzeltilir. NEDEN ÇALIŞIR: TimeEntryUpdateInput içinde " +
            "assignment alanı YOKTUR; bir alan input şemasında yoksa güncellenemez, dolayısıyla " +
            "2. adım ticket bağını BOZAMAZ. FEDA EDİLEN: 2 HTTP isteği ve atomiklik — " +
            "1. adım başarılı olup 2. adım başarısız olabilir.",

        ["link_first"] =
            "TICKET BAĞI ÖNCELİKLİ: yalnızca Yol B çalıştırılır. Tek istek, atomik ve en dayanıklı " +
            "yol. FEDA EDİLEN: tarih HER ZAMAN bugündür (T-1 karşılanamaz), başlangıç saati " +
            "kaydedilmez ve kayıt her zaman authenticated user adına yazılır.",

        ["date_first"] =
            "TARİH ÖNCELİKLİ: yalnızca Yol A çalıştırılır (TimeAllocation hedefli). date, startedAt " +
            "ve personId tam kontrol altındadır. FEDA EDİLEN: kayıt ticket'a BAĞLANMAZ " +
            "(assignment=null). Ticket bazlı raporlama yapılıyorsa bu seçenek UYGUN DEĞİLDİR.",
    };

    /// <summary>Tek bir zaman girişini planlar ve (dry-run değilse) çalıştırır.</summary>
    public static async Task<WriteResult> RunAsync(
        AppConfig cfg,
        IXurrentAdapter adapter,
        TimeEntryRequest req,
        bool dryRun,
        CancellationToken ct)
    {
        var warnings = new List<string>();
        var errors = new List<ValidationError>();

        var ctx = await adapter.GetTimeTrackingContextAsync(req.PersonId ?? "$me", ct);
        var me = await adapter.ResolvePersonIdAsync("$me", ct);
        var personId = await adapter.ResolvePersonIdAsync(req.PersonId ?? "$me", ct);

        var today = TimeUtil.Today(cfg.TimeZone);
        var effectiveDate = string.IsNullOrWhiteSpace(req.Date) ? today : TimeUtil.ParseDate(req.Date, cfg.TimeZone);

        var strategy = Validate.NormalizeStrategy(req.BackdateStrategy, cfg, warnings);

        // Hedef time_allocation ise Yol B zaten MÜMKÜN DEĞİL — strateji tartışması biter.
        var targetIsAllocation = req.TargetType == "time_allocation";
        if (targetIsAllocation && strategy != "date_first")
        {
            warnings.Add($"Hedef bir TimeAllocation olduğu için '{strategy}' stratejisi uygulanamaz: " +
                         "allocation'a yazmanın TEK yolu Yol A'dır (timeEntryCreate). Strateji 'date_first' kabul edildi.");
            strategy = "date_first";
        }

        // date_first + ticket hedefi: hedef otomatik olarak varsayılan TimeAllocation'a çevrilir.
        var effectiveTargetType = req.TargetType;
        var effectiveTargetId = req.TargetId;
        if (strategy == "date_first" && !targetIsAllocation)
        {
            if (string.IsNullOrWhiteSpace(cfg.DefaultTimeAllocationId))
                errors.Add(new ValidationError(
                    "date_first stratejisi için DEFAULT_TIME_ALLOCATION_ID tanımlı olmalıdır.", ["backdateStrategy"]));

            var label = await adapter.ResolveTargetLabelAsync(req.TargetType, req.TargetId, ct) ?? req.TargetId;
            warnings.Add($"date_first stratejisi seçildi: kayıt '{label}' hedefine BAĞLANMAYACAK " +
                         $"(assignment=null). Hedef, varsayılan TimeAllocation'a ({cfg.DefaultTimeAllocationId}) çevrildi. " +
                         "Ticket bazlı raporlamada bu kayıt GÖRÜNMEZ.");
            effectiveTargetType = "time_allocation";
            effectiveTargetId = cfg.DefaultTimeAllocationId;
        }

        var isPathA = effectiveTargetType == "time_allocation";

        // Yol B'de sunucunun neyi ezeceğini kullanıcıya AÇIKÇA söyle.
        if (strategy == "link_first")
        {
            if (effectiveDate != today)
                warnings.Add($"İSTENEN TARİH KARŞILANAMADI: link_first stratejisinde date her zaman BUGÜN " +
                             $"({today:yyyy-MM-dd}) olur; istenen {effectiveDate:yyyy-MM-dd} yok sayılacak. " +
                             "Geçmiş tarih gerekiyorsa 'two_step' veya 'date_first' seçilmelidir.");
            if (!string.IsNullOrWhiteSpace(req.StartedAt))
                warnings.Add("Başlangıç saati KAYDEDİLMEYECEK: Yol B'de startedAt alanı yoktur.");
            if (personId != me)
                warnings.Add("Kayıt authenticated user adına yazılacak: Yol B'de personId alanı yoktur.");
        }
        else if (strategy == "two_step")
        {
            warnings.Add("two_step ATOMİK DEĞİLDİR: 1. adım (ticket'a bağlama) başarılı olup 2. adım " +
                         "(tarih/saat düzeltmesi) başarısız olabilir. Bu durumda kayıt ticket'a bağlı kalır " +
                         "ama tarihi BUGÜN olur — kullanıcıya bildirilmelidir.");
            if (personId != me)
                warnings.Add("Başkası adına yazma: 2. adımda personId düzeltilecek. " +
                             "Bunun için manager / substitute / Account Administrator yetkisi gerekir.");
        }

        var alreadyLogged = await adapter.GetLoggedMinutesAsync(personId, effectiveDate, ct);
        Validate.TimeEntry(cfg, ctx, req, isPathA, effectiveTargetId, effectiveDate, today, alreadyLogged, errors, warnings);

        var effortClassId = req.EffortClassId ?? DefaultEffortClass(ctx, effectiveTargetType);
        var sourceId = req.SourceId ?? DeterministicSourceId(req, effectiveDate, personId);

        List<PlannedMutation> planned = isPathA
            ? [BuildPathA(cfg, req, effectiveTargetId, effectiveDate, personId, effortClassId, sourceId)]
            : BuildPathB(cfg, req, strategy, effectiveDate, personId, effortClassId, sourceId);

        var globalDryRun = dryRun || cfg.XurrentDryRun;
        if (globalDryRun && cfg.XurrentDryRun && !dryRun)
            warnings.Add("XURRENT_DRY_RUN=1 olduğu için istek dry-run'a zorlandı; hiçbir mutation gönderilmedi.");

        // Doğrulama hatası varsa ASLA yazma — dry-run gibi davran.
        if (errors.Count > 0)
            return new WriteResult(true, strategy, Explanations[strategy], planned, warnings, null, errors);

        if (globalDryRun)
            return new WriteResult(true, strategy, Explanations[strategy], planned, warnings, null, errors);

        // ── Gerçek çalıştırma ───────────────────────────────────────────────
        JsonObject? timeEntry = null;
        string? createdId = null;

        for (var i = 0; i < planned.Count; i++)
        {
            var step = planned[i];
            if (i > 0) await Task.Delay(RateLimitDelayMs, ct); // rate limit: 20 istek / 2 sn

            // two_step 2. adımı 1. adımın ürettiği id'ye ihtiyaç duyar.
            var toRun = step;
            if (createdId is not null)
                toRun = step with { Input = SubstitutePlaceholder(step.Input, createdId) };

            var outcome = await adapter.ExecuteAsync(toRun, ct);
            if (!outcome.Ok)
            {
                foreach (var e in outcome.Errors) errors.Add(e);
                if (i > 0)
                    warnings.Add($"{i}. adım başarılı oldu ama {i + 1}. adım başarısız — KAYIT YARIM KALDI. " +
                                 "Zaman girişi ticket'a bağlı fakat tarihi düzeltilemedi.");
                return new WriteResult(false, strategy, Explanations[strategy], planned, warnings, timeEntry, errors);
            }

            timeEntry = outcome.TimeEntry ?? timeEntry;
            createdId ??= timeEntry?["id"]?.GetValue<string>();
        }

        return new WriteResult(false, strategy, Explanations[strategy], planned, warnings, timeEntry, errors);
    }

    // ── Plan üreticiler ──────────────────────────────────────────────────────

    /// <summary>YOL A — timeEntryCreate. Tek mutation, ticket'a bağlanmaz.</summary>
    private static PlannedMutation BuildPathA(
        AppConfig cfg, TimeEntryRequest req, string allocationId,
        DateOnly date, string personId, string? effortClassId, string sourceId)
    {
        // DİKKAT: Bu input'ta assignmentId / requestId / taskId ALANI YOKTUR.
        // Şema seviyesinde tek zorunlu alan timeSpent'tir (Int!, DAKİKA).
        var input = new JsonObject
        {
            ["timeSpent"] = req.Minutes,
            ["date"] = date.ToString("yyyy-MM-dd"),
            ["personId"] = personId,
            ["timeAllocationId"] = allocationId,
        };
        AddIfSet(input, "startedAt", req.StartedAt);
        AddIfSet(input, "effortClassId", effortClassId);
        AddIfSet(input, "description", req.Description);
        AddIfSet(input, "customerId", req.CustomerId);
        AddIfSet(input, "serviceId", req.ServiceId);
        AddIfSet(input, "organizationId", req.OrganizationId);
        AddIfSet(input, "teamId", req.TeamId);
        if (req.Correction) input["correction"] = true;
        input["source"] = cfg.XurrentSource;
        input["sourceID"] = sourceId;
        input["clientMutationId"] = sourceId;

        var warnings = new List<string>
        {
            "Oluşan kaydın assignment değeri NULL olacak — TimeEntryCreateInput'ta ticket alanı YOKTUR.",
        };
        if (!string.IsNullOrWhiteSpace(req.Note))
            warnings.Add("note alanı Yol A'da yok sayılır; TimeEntryCreateInput'ta 'note' string alanı YOKTUR " +
                         "(noteId ile mevcut bir nota bağlanabilir).");

        return new PlannedMutation(0, "timeEntryCreate", Queries.TimeEntryCreate,
            new JsonObject { ["input"] = input }, warnings, null);
    }

    /// <summary>YOL B — parent update (+ two_step'te timeEntryUpdate telafisi).</summary>
    private static List<PlannedMutation> BuildPathB(
        AppConfig cfg, TimeEntryRequest req, string strategy,
        DateOnly date, string personId, string? effortClassId, string sourceId)
    {
        var (path, text) = Queries.ParentUpdateFor(req.TargetType);

        var parentInput = new JsonObject
        {
            ["id"] = req.TargetId,
            // ARTIMLI: "üzerine ekle" demektir, "toplamı bu yap" DEĞİL.
            // Entegrasyonlarda çift sayma hatalarının bir numaralı kaynağı burasıdır.
            ["timeSpent"] = req.Minutes,
        };
        AddIfSet(parentInput, "timeSpentEffortClassId", effortClassId);
        AddIfSet(parentInput, "timeEntryDescription", req.Description);
        AddIfSet(parentInput, "note", req.Note);
        parentInput["clientMutationId"] = sourceId;

        var stepOneWarnings = new List<string>
        {
            "timeSpent ARTIMLIDIR: gönderilen değer mevcut toplamın ÜZERİNE eklenir.",
            "Bu adımda date sunucu tarafından BUGÜN, person ise authenticated user olarak atanır.",
        };

        if (strategy == "link_first")
            return [new PlannedMutation(0, path, text, new JsonObject { ["input"] = parentInput }, stepOneWarnings, null)];

        // two_step: 1/2 ticket'a bağla, 2/2 tarihi düzelt.
        var fixInput = new JsonObject
        {
            // 1. adımın çıktısından gelir. Live modda parent update payload'ı TimeEntry
            // döndürmediği için adapter, adım sonrası kişinin o günkü son kaydını sorgular.
            ["id"] = PreviousEntryIdPlaceholder,
            ["date"] = date.ToString("yyyy-MM-dd"),
            ["personId"] = personId,
        };
        AddIfSet(fixInput, "startedAt", req.StartedAt);
        fixInput["clientMutationId"] = sourceId + "-fix";

        var stepTwoWarnings = new List<string>
        {
            "TimeEntryUpdateInput'ta assignment ALANI YOKTUR -> bu adım ticket bağını BOZAMAZ. " +
            "two_step stratejisinin tüm dayanağı budur.",
            $"id değeri 1. adımın çıktısından gelir ({PreviousEntryIdPlaceholder}).",
        };

        return
        [
            new PlannedMutation(0, path, text, new JsonObject { ["input"] = parentInput }, stepOneWarnings, "1/2"),
            new PlannedMutation(1, "timeEntryUpdate", Queries.TimeEntryUpdate,
                new JsonObject { ["input"] = fixInput }, stepTwoWarnings, "2/2"),
        ];
    }

    // ── Yardımcılar ──────────────────────────────────────────────────────────

    private static JsonObject SubstitutePlaceholder(JsonObject input, string actualId)
    {
        var clone = input.DeepClone().AsObject();
        if (clone["input"]?.AsObject() is { } inner &&
            inner["id"]?.GetValue<string>() == PreviousEntryIdPlaceholder)
            inner["id"] = actualId;
        return clone;
    }

    private static void AddIfSet(JsonObject o, string key, string? value)
    {
        if (!string.IsNullOrWhiteSpace(value)) o[key] = value;
    }

    private static string? DefaultEffortClass(TimeTrackingContext ctx, string targetType) => targetType switch
    {
        "request" => ctx.Defaults.RequestEffortClassId,
        "task" => ctx.Defaults.TaskEffortClassId,
        "project_task" => ctx.Defaults.ProjectTaskEffortClassId,
        "problem" => ctx.Defaults.ProblemEffortClassId,
        "time_allocation" => ctx.Defaults.TimeAllocationEffortClassId,
        _ => null,
    };

    /// <summary>
    /// Idempotency anahtarı. Aynı girdi aynı sourceID'yi üretir; tekrarlanan çağrılarda
    /// Xurrent tarafında yinelenen kayıt tespiti mümkün olur.
    /// </summary>
    private static string DeterministicSourceId(TimeEntryRequest req, DateOnly date, string personId)
    {
        var raw = string.Join('|', req.TargetType, req.TargetId, req.Minutes.ToString(),
            date.ToString("yyyy-MM-dd"), req.StartedAt ?? "-", personId, req.Description ?? "-");
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(raw));
        return "xmcp-" + Convert.ToHexString(hash)[..16].ToLowerInvariant();
    }
}
