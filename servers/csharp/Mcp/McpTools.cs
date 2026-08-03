using System.ComponentModel;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;
using XurrentMcp.Calendars;
using XurrentMcp.Core;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Mcp;

/// <summary>Bulk girdisinin tek satırı — xurrent_create_time_entry input'unun aynısı.</summary>
public sealed class BulkEntryInput
{
    [JsonPropertyName("targetType")] public string TargetType { get; set; } = "request";
    [JsonPropertyName("targetId")] public string TargetId { get; set; } = "";
    [JsonPropertyName("minutes")] public int Minutes { get; set; }
    [JsonPropertyName("date")] public string? Date { get; set; }
    [JsonPropertyName("startedAt")] public string? StartedAt { get; set; }
    [JsonPropertyName("personId")] public string? PersonId { get; set; }
    [JsonPropertyName("effortClassId")] public string? EffortClassId { get; set; }
    [JsonPropertyName("description")] public string? Description { get; set; }
    [JsonPropertyName("note")] public string? Note { get; set; }
    [JsonPropertyName("customerId")] public string? CustomerId { get; set; }
    [JsonPropertyName("serviceId")] public string? ServiceId { get; set; }
    [JsonPropertyName("organizationId")] public string? OrganizationId { get; set; }
    [JsonPropertyName("teamId")] public string? TeamId { get; set; }
    [JsonPropertyName("correction")] public bool Correction { get; set; }
    [JsonPropertyName("sourceId")] public string? SourceId { get; set; }
}

/// <summary>
/// ★ MCP ADAPTÖR KATMANI — ince olması KASITLIDIR.
///
/// Burada iki iş yapılır ve sadece iki iş:
///   1) Core/ToolImpl.cs'in ürettiği sonucu CallToolResult'a çevirmek
///      (structuredContent + okunabilir Türkçe metin — K2).
///   2) ToolImpl'in ürettiği ConfirmationRequest'i AKTİF PROTOKOLE çevirmek:
///        v2 (2026-07-28) → InputRequiredResult + imzalı requestState  [MRTR]
///        v1 (2025-11-25) → elicitation/create isteği                  [sunucu-başlatmalı]
///
/// [McpServerTool] attribute'u YERİNE düşük seviye kayıt kullanıyoruz. NEDEN:
/// attribute yalnızca UseStructuredContent bayrağını taşır, ŞEMAYI dönüş tipinden ÜRETİR.
/// Bizim dönüş tipimiz CallToolResult olduğu için türetilecek anlamlı bir şema yok —
/// şema sözleşmeden (contract/tools.json) ELLE verilmek zorunda ve bunun tek yolu
/// McpServerToolCreateOptions.OutputSchema'dır.
/// </summary>
public static class McpTools
{
    /// <summary>Onay elicitation'ında kullanılan alan adı. Hem soru hem cevap bu anahtarı kullanır.</summary>
    private const string ConfirmField = "onay";

    /// <summary>
    /// 8 tool'u contract/tools.json SIRASIYLA kaydeder.
    /// Sıra önemlidir: tools/list deterministik dönmeli (LLM prompt cache isabeti).
    /// </summary>
    public static IMcpServerBuilder AddXurrentTools(this IMcpServerBuilder builder)
    {
        var factories = new Dictionary<string, (Delegate Impl, string Title, string Description, ToolFlags Flags)>
        {
            [ToolNames.WhoAmI] = (WhoAmI, "Kimlik ve bağlantı testi",
                "Authenticated kullanıcıyı, hesabı ve rate limit durumunu döner. " +
                "Aynı zamanda bağlantı smoke test'idir. " +
                "DİKKAT: person.id gibi tüm id değerleri opak string'lerdir; ASLA elle üretilmez.",
                ToolFlags.Read),

            [ToolNames.FindPerson] = (FindPerson, "Kişiyi e-posta ile bul",
                "Kişiyi birincil e-posta ile bulur. TAM eşleşme yapar (substring DEĞİL) — " +
                "Xurrent PersonFilter.primaryEmail bir TextFilter'dır. " +
                "Sonuç boşsa suggestFuzzy=true döner.",
                ToolFlags.Read),

            [ToolNames.ListOpenWork] = (ListOpenWork, "Açık talep ve görevleri listele",
                "Bir kişinin üzerindeki AÇIK Request ve Task'ları id + açıklama ile listeler. " +
                "Açık/kapalı ayrımı yalnızca status ile yapılır ('open' diye bir view YOKTUR). " +
                "Request'te tek terminal durum 'completed'; Task'ta beş tanedir " +
                "(completed, approved, failed, rejected, canceled).",
                ToolFlags.Read),

            [ToolNames.TimeTrackingContext] = (TimeTrackingContext, "Zaman takibi bağlamı",
                "Zaman yazmadan ÖNCE çalıştırılması ZORUNLU bağlam sorgusu: timeIncrement, " +
                "effort class'lar, timesheet kısıtları. Sonuç session içinde cache'lenir. " +
                "allocationTimeTracking=false ise Yol A, assignmentTimeTracking=false ise Yol B kapalıdır. " +
                "effortClasses listesinden disabled olanlar CLIENT tarafında elenmiştir " +
                "(EffortClassFilter'da 'disabled' filtresi YOKTUR).",
                ToolFlags.Read),

            [ToolNames.CreateTimeEntry] = (CreateTimeEntry, "Zaman girişi oluştur",
                "Tek bir zaman girişi oluşturur. targetType='time_allocation' ise Yol A " +
                "(timeEntryCreate, ticket'a BAĞLANMAZ), diğerlerinde Yol B " +
                "(requestUpdate/taskUpdate/..., ticket'a bağlar ama tarih=bugün). " +
                "Süre DAKİKA cinsindendir ve timeIncrement'in katı olmalıdır — önce " +
                "xurrent_get_time_tracking_context çağrılmalıdır. " +
                "dryRun=true iken HİÇBİR mutation gönderilmez; sadece plan ve uyarılar döner.",
                ToolFlags.Write),

            [ToolNames.CreateTimeEntriesBulk] = (CreateTimeEntriesBulk, "Toplu zaman girişi",
                "Birden çok zaman girişini SIRAYLA oluşturur. ATOMİK DEĞİLDİR — kısmi başarı normaldir " +
                "ve her satır ayrı raporlanır. GraphQL istek başına 1 mutation kabul ettiği için " +
                "N ayrı HTTP isteği gider; rate limit nedeniyle aralarında 110 ms beklenir.",
                ToolFlags.Write),

            [ToolNames.CalendarListToday] = (CalendarListToday, "Günün takvimini oku",
                "Kişinin belirtilen gündeki takvimini okur, normalize eder ve gerçek toplantıları " +
                "filtreler. Pencere HER ZAMAN yerel gece yarısından yerel gece yarısına, OFFSET GÖMÜLÜ " +
                "kurulur. Elenen etkinlikler listede KALIR ama skipped=true + Türkçe skipReason taşır. " +
                "totals.busyMinutes çakışmaları BİR KEZ sayar (interval merge); " +
                "totals.naiveSumMinutes ise naif toplamdır — farkı görmek öğreticidir.",
                ToolFlags.Read),

            [ToolNames.PlanFromCalendar] = (PlanFromCalendar, "Takvimden zaman girişi planı üret",
                "Takvim + açık iş listesini birleştirip ÖNERİLEN zaman girişi planı üretir. ASLA YAZMAZ. " +
                "Eşleşme heuristiği üç yollu ve açıklanabilirdir: (1) başlıkta ticket numarası deseni, " +
                "(2) normalize edilmiş metin benzerliği, (3) hiçbiri tutmazsa needsUserDecision=true. " +
                "roundedMinutes her zaman timeIncrement katına yuvarlanır ve yuvarlama HER ZAMAN warnings'e yazılır.",
                ToolFlags.Read),
        };

        foreach (var name in ToolContracts.Order)
        {
            var (impl, title, description, flags) = factories[name];
            builder.Services.AddSingleton<McpServerTool>(sp => McpServerTool.Create(impl, new McpServerToolCreateOptions
            {
                Services = sp,
                Name = name,
                Title = title,
                Description = description,
                ReadOnly = flags.ReadOnly,
                Destructive = flags.Destructive,
                Idempotent = flags.Idempotent,
                OpenWorld = true,
                SerializerOptions = Json.Options,

                // ★ K2: sözleşmeden gelen outputSchema + structuredContent.
                UseStructuredContent = true,
                OutputSchema = ToolContracts.OutputSchema(name),
            }));
        }

        return builder;
    }

    private sealed record ToolFlags(bool ReadOnly, bool Destructive, bool Idempotent)
    {
        public static readonly ToolFlags Read = new(true, false, true);
        public static readonly ToolFlags Write = new(false, false, false);
    }

    // ── Okuma tool'ları ──────────────────────────────────────────────────────

    private static async Task<CallToolResult> WhoAmI(IXurrentAdapter adapter, CancellationToken ct)
    {
        var r = await ToolImpl.WhoAmIAsync(adapter, ct);
        return Ok(Narrate.WhoAmI(r), r);
    }

    private static async Task<CallToolResult> FindPerson(
        IXurrentAdapter adapter,
        [Description("Birincil e-posta. TAM eşleşme; büyük-küçük harf ve format duyarlı.")]
        string email,
        [Description("'all' (varsayılan) veya 'current_account'. 'current_account' kişinin diğer hesaplardaki kaydını GİZLER.")]
        string view = "all",
        CancellationToken ct = default)
    {
        var r = await ToolImpl.FindPersonAsync(adapter, email, view, ct);
        return Ok(Narrate.FindPerson(r, email), r);
    }

    private static async Task<CallToolResult> ListOpenWork(
        IXurrentAdapter adapter,
        [Description("Person node ID veya '$me'. Varsayılan '$me'.")]
        string personId = "$me",
        [Description("Hangi kayıt tipleri çekilsin: 'requests' ve/veya 'tasks'. Varsayılan ikisi birden.")]
        string[]? include = null,
        [Description("Sayfa boyutu (1-100). Varsayılan 25.")]
        int first = 25,
        [Description("Request sayfalama cursor'ı")] string? afterRequests = null,
        [Description("Task sayfalama cursor'ı")] string? afterTasks = null,
        [Description("'all' (varsayılan) veya 'current_account'. VARSAYILANI 'all' YAPTIK çünkü " +
                     "Xurrent'ın kendi varsayılanı 'current_account'tur ve kişinin diğer hesaplardaki işlerini gizler.")]
        string view = "all",
        CancellationToken ct = default)
    {
        var r = await ToolImpl.ListOpenWorkAsync(adapter, personId, include, first, afterRequests, afterTasks, view, ct);
        return Ok(Narrate.ListOpenWork(r), r);
    }

    private static async Task<CallToolResult> TimeTrackingContext(
        IXurrentAdapter adapter,
        [Description("Person node ID veya '$me'. Varsayılan '$me'.")]
        string personId = "$me",
        CancellationToken ct = default)
    {
        var r = await ToolImpl.TimeTrackingContextAsync(adapter, personId, ct);
        return Ok(Narrate.TimeTrackingContext(r), r);
    }

    private static async Task<CallToolResult> CalendarListToday(
        CalendarFactory calendar,
        [Description("'mock' | 'ics' | 'google' | 'graph' | 'auto'. Varsayılan 'auto'.")]
        string provider = "auto",
        [Description("app-only / domain-wide-delegation modunda impersonate edilecek kullanıcı e-postası")]
        string? userEmail = null,
        [Description("ISO8601 tarih (YYYY-MM-DD). Boşsa bugün.")]
        string? date = null,
        [Description("IANA saat dilimi. Varsayılan Europe/Istanbul.")]
        string timeZone = "Europe/Istanbul",
        [Description("true ise tüm gün etkinlikleri de gerçek toplantı sayılır. Varsayılan false.")]
        bool includeAllDay = false,
        [Description("true ise reddedilen toplantılar da sayılır. Varsayılan false.")]
        bool includeDeclined = false,
        [Description("true ise showAs=free / transparency=transparent etkinlikler de sayılır. Varsayılan false.")]
        bool includeFree = false,
        CancellationToken ct = default)
    {
        var r = await ToolImpl.CalendarListTodayAsync(
            calendar, provider, userEmail, date, timeZone, includeAllDay, includeDeclined, includeFree, ct);
        return Ok(Narrate.Calendar(r), r);
    }

    private static async Task<CallToolResult> PlanFromCalendar(
        AppConfig cfg,
        IXurrentAdapter adapter,
        CalendarFactory calendar,
        [Description("Person node ID veya '$me'. Varsayılan '$me'.")]
        string personId = "$me",
        [Description("ISO8601 tarih (YYYY-MM-DD). Boşsa bugün.")]
        string? date = null,
        [Description("IANA saat dilimi. Varsayılan Europe/Istanbul.")]
        string timeZone = "Europe/Istanbul",
        [Description("'mock' | 'ics' | 'google' | 'graph' | 'auto'. Varsayılan 'auto'.")]
        string provider = "auto",
        [Description("Eşleşmeyen toplantılar için varsayılan hedef tipi: 'time_allocation' | 'request' | 'task'.")]
        string? defaultTargetType = null,
        [Description("Eşleşmeyen toplantılar için varsayılan hedef ID'si. Boşsa DEFAULT_TIME_ALLOCATION_ID, " +
                     "o da boşsa hesaptaki ilk TimeAllocation kullanılır.")]
        string? defaultTargetId = null,
        [Description("'nearest' (varsayılan) | 'up' | 'down'")]
        string roundingMode = "nearest",
        CancellationToken ct = default)
    {
        var r = await ToolImpl.PlanFromCalendarAsync(
            cfg, adapter, calendar, personId, date, timeZone, provider,
            defaultTargetType, defaultTargetId, roundingMode, ct);
        return Ok(Narrate.Plan(r), r);
    }

    // ── Yazma tool'ları (onay akışı burada protokole çevrilir) ───────────────

    private static async Task<CallToolResult> CreateTimeEntry(
        RequestContext<CallToolRequestParams> ctx,
        AppConfig cfg,
        IXurrentAdapter adapter,
        [Description("'time_allocation' → Yol A. 'request' | 'task' | 'project_task' | 'problem' → Yol B.")]
        string targetType,
        [Description("Hedef kaydın opak node ID'si. ASLA tahmin edilmez; bir tool çıktısından gelmelidir.")]
        string targetId,
        [Description("Süre, DAKİKA cinsinden. timeIncrement'in katı olmalı. Negatif yalnızca correction=true ile.")]
        int minutes,
        [Description("ISO8601 tarih (YYYY-MM-DD). Boşsa bugün. T-1'den eski değerler reddedilir.")]
        string? date = null,
        [Description("ISO8601 timestamp, OFFSET ZORUNLU (2026-08-01T14:00:00+03:00). Sadece metadata; timesheet gününü DEĞİŞTİRMEZ.")]
        string? startedAt = null,
        [Description("Boşsa authenticated user. Farklıysa manager/substitute/Account Administrator yetkisi gerekir.")]
        string? personId = null,
        [Description("Effort class node ID. Boşsa timesheet varsayılanı kullanılır. costMultiplier faturalamayı etkiler.")]
        string? effortClassId = null,
        [Description("Zaman girişi açıklaması. EN FAZLA 80 KARAKTER.")]
        string? description = null,
        [Description("Yalnızca Yol B'de anlamlıdır; ticket'a not düşer.")]
        string? note = null,
        [Description("Yalnızca Yol A")] string? customerId = null,
        [Description("Yalnızca Yol A")] string? serviceId = null,
        [Description("Yalnızca Yol A. Kişinin KENDİ organizasyonu (müşteri değil).")] string? organizationId = null,
        [Description("Yalnızca Yol A")] string? teamId = null,
        [Description("Negatif süre yazabilmek için düzeltme kaydı işareti.")]
        bool correction = false,
        [Description("Idempotency anahtarı. Boşsa girdiden deterministik üretilir.")]
        string? sourceId = null,
        [Description("'two_step' | 'link_first' | 'date_first'. Boşsa XURRENT_BACKDATE_STRATEGY kullanılır.")]
        string? backdateStrategy = null,
        [Description("true ise HİÇBİR mutation gönderilmez; sadece plan + uyarılar döner.")]
        bool dryRun = false,
        CancellationToken ct = default)
    {
        var req = new TimeEntryRequest
        {
            TargetType = targetType,
            TargetId = targetId,
            Minutes = minutes,
            Date = date,
            StartedAt = startedAt,
            PersonId = personId,
            EffortClassId = effortClassId,
            Description = description,
            Note = note,
            CustomerId = customerId,
            ServiceId = serviceId,
            OrganizationId = organizationId,
            TeamId = teamId,
            Correction = correction,
            SourceId = sourceId,
            BackdateStrategy = backdateStrategy,
        };

        var gate = await OpenApprovalGateAsync(ctx, cfg, adapter, ct);
        if (gate.Refusal is { } refusal)
            return Failure(refusal, ToolImpl.DeclinedWrite(refusal));

        var outcome = await ToolImpl.CreateTimeEntryAsync(cfg, adapter, req, dryRun, gate.Approved, ct);

        if (outcome.Confirmation is { } ask)
        {
            // v2'de bu çağrı InputRequiredException ile SONLANIR ve buradan hiç dönmez.
            var second = await AskForApprovalAsync(ctx, cfg, adapter, ask, ct);
            if (second.Refusal is { } declined)
                return Failure(declined, ToolImpl.DeclinedWrite(declined));

            outcome = await ToolImpl.CreateTimeEntryAsync(cfg, adapter, req, dryRun, approved: true, ct);
        }

        return Ok(Narrate.Write(outcome.Value!), outcome.Value!);
    }

    private static async Task<CallToolResult> CreateTimeEntriesBulk(
        RequestContext<CallToolRequestParams> ctx,
        AppConfig cfg,
        IXurrentAdapter adapter,
        [Description("En fazla 50 satır. Her satır xurrent_create_time_entry input'u ile aynı şekildedir.")]
        BulkEntryInput[] entries,
        [Description("true ise hiçbir mutation gönderilmez; tüm satırların planı döner.")]
        bool dryRun = false,
        [Description("true (varsayılan) ise ilk hatada durur — yarım kalan durumu netleştirir.")]
        bool stopOnError = true,
        [Description("'two_step' | 'link_first' | 'date_first'. Tüm satırlara uygulanır.")]
        string? backdateStrategy = null,
        CancellationToken ct = default)
    {
        var requests = entries.Select(e => new TimeEntryRequest
        {
            TargetType = e.TargetType,
            TargetId = e.TargetId,
            Minutes = e.Minutes,
            Date = e.Date,
            StartedAt = e.StartedAt,
            PersonId = e.PersonId,
            EffortClassId = e.EffortClassId,
            Description = e.Description,
            Note = e.Note,
            CustomerId = e.CustomerId,
            ServiceId = e.ServiceId,
            OrganizationId = e.OrganizationId,
            TeamId = e.TeamId,
            Correction = e.Correction,
            SourceId = e.SourceId,
            BackdateStrategy = backdateStrategy,
        }).ToArray();

        var gate = await OpenApprovalGateAsync(ctx, cfg, adapter, ct);
        if (gate.Refusal is { } refusal)
            return Failure(refusal, ToolImpl.DeclinedBulk(entries.Length, refusal));

        var outcome = await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, adapter, requests, dryRun, stopOnError, gate.Approved, ct);

        if (outcome.Confirmation is { } ask)
        {
            var second = await AskForApprovalAsync(ctx, cfg, adapter, ask, ct);
            if (second.Refusal is { } declined)
                return Failure(declined, ToolImpl.DeclinedBulk(entries.Length, declined));

            outcome = await ToolImpl.CreateTimeEntriesBulkAsync(
                cfg, adapter, requests, dryRun, stopOnError, approved: true, ct);
        }

        return Ok(Narrate.Bulk(outcome.Value!), outcome.Value!);
    }

    // ── Onay kapısı ──────────────────────────────────────────────────────────

    private sealed record ApprovalGate(bool Approved, string? Refusal);

    /// <summary>
    /// ★ requestState DOĞRULAMASI.
    ///
    /// KURAL: istekte requestState VARSA her koşulda doğrulanır — onay gerekmese bile.
    /// NEDEN: doğrulanamayan bir state, "neyi sürdürdüğümüzü bilmiyoruz" demektir.
    /// Onay gerekmediği için sessizce yok saymak, kurcalanmış bir blob'un fark edilmeden
    /// geçmesi anlamına gelirdi. Doğrulama başarısızsa YAZMA YAPILMAZ.
    /// </summary>
    private static async Task<ApprovalGate> OpenApprovalGateAsync(
        RequestContext<CallToolRequestParams> ctx, AppConfig cfg, IXurrentAdapter adapter, CancellationToken ct)
    {
        var state = ctx.Params?.RequestState;
        if (string.IsNullOrEmpty(state)) return new ApprovalGate(false, null);

        var principal = await adapter.ResolvePersonIdAsync("$me", ct);
        var verdict = RequestStateCodec.Verify(cfg, state, principal, ctx.Params!.Name, ArgumentsAsJson(ctx));

        if (!verdict.Ok)
            return new ApprovalGate(false,
                $"YAZMA REDDEDİLDİ. {verdict.Reason} " +
                "requestState bir güvenlik sınırıdır: imzası, sahibi, süresi ve argüman parmak izi " +
                "tutmayan hiçbir onay kabul edilmez. Hiçbir mutation gönderilmedi.");

        if (!TryReadApproval(ctx, out var accepted))
            return new ApprovalGate(false,
                "YAZMA REDDEDİLDİ: requestState geçerli ama onay cevabı (inputResponses) gelmedi. " +
                "Hiçbir mutation gönderilmedi.");

        if (!accepted)
            return new ApprovalGate(false,
                "Kullanıcı onayı VERİLMEDİ — hiçbir kayıt oluşturulmadı.");

        return new ApprovalGate(true, null);
    }

    /// <summary>
    /// ★ AYNI İŞ MANTIĞI, İKİ PROTOKOL KABUĞU.
    ///
    /// v2 (MRTR destekli oturum): InputRequiredResult SONUCU döneriz. İstek burada SONLANIR;
    ///     sunucu hiçbir state tutmaz — ihtiyacı olan her şey imzalı requestState içindedir
    ///     ve client isteği YENİ bir JSON-RPC id'siyle tekrarlar.
    ///
    /// v1 (MRTR desteklemeyen oturum): elicitation/create İSTEĞİ göndeririz ve cevabı
    ///     burada, çağrının ortasında bekleriz. Bu kalıcı çift yönlü bağlantı gerektirir.
    ///
    /// v2 yolunda bu metot InputRequiredException ile SONLANIR ve hiç dönmez.
    /// v1 yolunda onay alınırsa Approved=true döner ve çağıran iş mantığını TEKRAR çalıştırır.
    /// </summary>
    private static async Task<ApprovalGate> AskForApprovalAsync(
        RequestContext<CallToolRequestParams> ctx, AppConfig cfg, IXurrentAdapter adapter,
        ConfirmationRequest ask, CancellationToken ct)
    {
        var elicit = BuildElicitation(ask);

        // ★ SPEC MUST: client'ın DESTEKLEMEDİĞİ bir inputRequest GÖNDERİLEMEZ.
        //
        // 2026-07-28: "Servers MUST NOT send an inputRequests that the client has not
        // declared support for in its capabilities."
        //
        // Neden ciddi: elicitation bildirmeyen bir client InputRequiredResult'ı
        // cevaplayamaz, isteği tekrarlamaz ve çağrı KALICI OLARAK tıkanır. Kullanıcı
        // hata bile görmez — sadece bekler. Sessiz kilitlenme, açık redden kötüdür.
        //
        // Buradaki karar UseMrtr'dan AYRIDIR: UseMrtr "hangi yolu kullanayım" sorusunu
        // cevaplar, bu kontrol "sorabilir miyim" sorusunu. Uyum denetleyicisi (M4)
        // clientCapabilities={} göndererek tam olarak bunu ölçüyor.
        if (!ClientElicitationDestekliyor(ctx))
        {
            return new ApprovalGate(false,
                "YAZMA REDDEDİLDİ: bu client onay diyaloğunu (elicitation) desteklemiyor, " +
                "yeteneklerinde bildirmemiş. Onaysız yazma yapılmaz. " +
                "dryRun=true ile planı görebilir ya da XURRENT_CONFIRM_POLICY=open " +
                "(yalnızca CI/otomasyon) kullanabilirsiniz.");
        }

        if (UseMrtr(ctx, cfg))
        {
            var principal = await adapter.ResolvePersonIdAsync("$me", ct);
            var requestState = RequestStateCodec.Sign(cfg, principal, ctx.Params!.Name, ArgumentsAsJson(ctx));

            // Bu bir SONUÇ döndürür, istek göndermez. İstek burada SONLANIR;
            // client aynı çağrıyı YENİ bir id ile, requestState + inputResponses ile tekrarlar.
            throw new InputRequiredException(
                new Dictionary<string, InputRequest> { [ConfirmField] = InputRequest.ForElicitation(elicit) },
                requestState);
        }

        // v1 yolu: sunucu client'a İSTEK gönderir ve cevabı çağrının ORTASINDA bekler.
        try
        {
            var result = await ctx.Server.ElicitAsync(elicit, ct);
            var accepted = result.IsAccepted
                           && result.Content?.TryGetValue(ConfirmField, out var value) == true
                           && value.ValueKind == JsonValueKind.True;

            return accepted
                ? new ApprovalGate(true, null)
                : new ApprovalGate(false, "Kullanıcı onayı VERİLMEDİ — hiçbir kayıt oluşturulmadı.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // ★ Client onay SORAMIYOR. Ne yapacağımızı politika + mod belirler.
            //   closed + mock → uyarı üretip DEVAM et (mock hiçbir yere yazmıyor, risk yok)
            //   closed + live → REDDET (fail-closed: Xurrent bir system of record'dur)
            //   strict        → her koşulda REDDET
            // TypeScript'teki resolveUnsupportedConfirm ve Python'daki karşılığıyla aynı tablo.
            if (cfg.XurrentConfirmPolicy == "closed" && cfg.IsMock)
            {
                Console.Error.WriteLine(
                    "[uyarı] Onay kanalı kurulamadı (" + ex.GetType().Name + "). " +
                    "XURRENT_CONFIRM_POLICY=closed + mock olduğu için onaysız devam edildi. " +
                    "Live modda bu yazma REDDEDİLİRDİ.");
                return new ApprovalGate(true, null);
            }

            return new ApprovalGate(false,
                "YAZMA REDDEDİLDİ: onay kanalı kurulamadı " +
                $"({ex.GetType().Name}). Client elicitation desteklemiyor olabilir. " +
                (cfg.XurrentConfirmPolicy == "strict"
                    ? "XURRENT_CONFIRM_POLICY=strict mock modda da onay şartı koşar."
                    : "XURRENT_CONFIRM_POLICY=open yalnızca CI/otomasyon içindir."));
        }
    }

    /// <summary>
    /// Hangi onay yolu kullanılacak?
    ///   MCP_PROTOCOL=2025-11-25 → her zaman v1 (elicitation), oturum MRTR destekliyor olsa bile.
    ///   diğer durumlarda        → oturumun GERÇEK yeteneği belirler (McpServer.IsMrtrSupported).
    /// </summary>
    private static bool UseMrtr(RequestContext<CallToolRequestParams> ctx, AppConfig cfg)
        => cfg.McpProtocol != ProtocolChoice.V1 && ctx.Server.IsMrtrSupported;

    /// <summary>
    /// Client onay diyaloğunu (elicitation) DESTEKLİYOR mu?
    ///
    /// İki era, iki kaynak:
    ///   v2 → istek başına `_meta["io.modelcontextprotocol/clientCapabilities"]`
    ///   v1 → handshake'te bildirilen ve oturumda saklanan yetenekler
    ///
    /// Hiçbir yerde bilgi yoksa DESTEKLEMİYOR sayılır (fail-closed). Varsaymak,
    /// cevaplanamayacak bir istek gönderip çağrıyı kilitlemek demektir.
    /// </summary>
    private static bool ClientElicitationDestekliyor(RequestContext<CallToolRequestParams> ctx)
    {
        // v1: oturumun handshake'te bildirdiği yetenekler.
        if (ctx.Server.ClientCapabilities?.Elicitation is not null) return true;

        // v2: yetenekler her istekte _meta ile gelir.
        var meta = ctx.Params?.Meta;
        if (meta is not null
            && meta.TryGetPropertyValue("io.modelcontextprotocol/clientCapabilities", out var caps)
            && caps is JsonObject capsObj)
        {
            return capsObj.ContainsKey("elicitation");
        }

        return false;
    }

    private static ElicitRequestParams BuildElicitation(ConfirmationRequest ask)
    {
        var detail = string.Join("\n", ask.Details.Select(kv => $"{kv.Key}: {kv.Value}"));
        return new ElicitRequestParams
        {
            Message = ask.Message + "\n\n" + detail,
            RequestedSchema = new ElicitRequestParams.RequestSchema
            {
                Properties = new Dictionary<string, ElicitRequestParams.PrimitiveSchemaDefinition>
                {
                    [ask.FieldName] = new ElicitRequestParams.BooleanSchema
                    {
                        Title = "Onay",
                        Description = "true = yaz, false = yazma. Varsayılan false (fail-closed).",
                        Default = false,
                    },
                },
                Required = [ask.FieldName],
            },
        };
    }

    /// <summary>Tekrarlanan istekteki inputResponses'tan onay cevabını okur.</summary>
    private static bool TryReadApproval(RequestContext<CallToolRequestParams> ctx, out bool accepted)
    {
        accepted = false;
        if (ctx.Params?.InputResponses is not { } responses) return false;
        if (!responses.TryGetValue(ConfirmField, out var response)) return false;

        var elicitResult = response.Deserialize(InputResponse.ElicitResultJsonTypeInfo);
        accepted = elicitResult is { IsAccepted: true }
                   && elicitResult.Content?.TryGetValue(ConfirmField, out var value) == true
                   && value.ValueKind == JsonValueKind.True;
        return true;
    }

    /// <summary>
    /// Tool argümanlarını parmak izi hesabı için JSON'a çevirir.
    /// NEDEN ham argümanlar: onaydan sonra parametre değiştirilirse parmak izi tutmaz
    /// ve state reddedilir. Bu, "120 dakikayı onayla, 1200 dakika yazdır" saldırısını kapatır.
    /// </summary>
    private static JsonObject ArgumentsAsJson(RequestContext<CallToolRequestParams> ctx)
    {
        var obj = new JsonObject();
        foreach (var (key, value) in ctx.Params?.Arguments ?? new Dictionary<string, JsonElement>())
            obj[key] = JsonNode.Parse(value.GetRawText());
        return obj;
    }

    // ── CallToolResult üreticileri ───────────────────────────────────────────

    /// <summary>
    /// K2: HER sonuçta structuredContent + okunabilir Türkçe metin.
    ///
    /// ★ errors[] DOLUYSA SONUÇ BAŞARI DEĞİLDİR.
    ///
    /// Tool teknik olarak "tamamlandı" (çağrı döndü, plan üretildi) ama iş kuralı
    /// reddetti. IsError'ı hiç göndermemek MCP'de false demektir; yani başarısız
    /// bir yazma BAŞARILI olarak bildirilir ve sonucu okuyan LLM "yazıldı" der.
    ///
    /// Karar burada, tek noktada veriliyor — her yazma tool'unun kendi doğru
    /// bayrağı set etmesine güvenmek yerine. Uyum denetleyicisi (scripts/mcp-uyum.mjs)
    /// bu maddeyi tam olarak bu yüzden ölçüyor.
    /// </summary>
    private static CallToolResult Ok<T>(string text, T structured)
    {
        var eleman = JsonSerializer.SerializeToElement(structured, Json.Options);

        var basarisiz =
            eleman.ValueKind == JsonValueKind.Object &&
            eleman.TryGetProperty("errors", out var hatalar) &&
            hatalar.ValueKind == JsonValueKind.Array &&
            hatalar.GetArrayLength() > 0;

        return new CallToolResult
        {
            Content = [new TextContentBlock { Text = text }],
            StructuredContent = eleman,
            IsError = basarisiz,
        };
    }

    /// <summary>İş kuralı hatası: isError=true + Türkçe açıklama. structuredContent YİNE döner.</summary>
    private static CallToolResult Failure<T>(string text, T structured) => new()
    {
        Content = [new TextContentBlock { Text = text }],
        StructuredContent = JsonSerializer.SerializeToElement(structured, Json.Options),
        IsError = true,
    };
}
