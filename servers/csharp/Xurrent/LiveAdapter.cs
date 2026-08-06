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
    private readonly RetryPolicy _retry;
    private readonly SemaphoreSlim _contextGate = new(1, 1);

    // ── Gaz (istemci tarafı throttle, reliability.md §4) ─────────────────────
    // İki HTTP isteği arasında en az MinRequestGapMs (varsayılan 110 ms) boşluk.
    // ADAPTÖR seviyesinde: retry tekrarları ve dedup geri-okumaları DAHİL her
    // istek bu kapıdan geçer. Bulk döngülerindeki eski Task.Delay'ler kaldırıldı —
    // gaz TEK yerde yaşar, iki yerde yaşarsa biri unutulur.
    private readonly SemaphoreSlim _gapGate = new(1, 1);
    private long _nextRequestAtMs;

    private TimeTrackingContext? _contextCache;
    private string? _meCache;
    private RateLimitInfo? _lastRateLimit;

    public string Mode => "live";

    public LiveAdapter(AppConfig cfg, HttpClient? http = null)
    {
        _cfg = cfg;
        _retry = new RetryPolicy(cfg);
        _http = http ?? new HttpClient();
        // İstek toplamı ≤ 30 sn (reliability.md §3). DI'dan gelen client zaten 30 sn
        // (ServerSetup); kendi ürettiğimizde burada eşitliyoruz. Kullanılmış bir client'ta
        // Timeout set etmek fırlatır — o yüzden yalnız kendi client'ımızda.
        if (http is null) _http.Timeout = TimeSpan.FromSeconds(30);
        _http.BaseAddress ??= new Uri(cfg.XurrentGraphqlUrl.TrimEnd('/') + "/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", cfg.XurrentToken);
        if (!string.IsNullOrWhiteSpace(cfg.XurrentAccount))
            _http.DefaultRequestHeaders.Add("X-Xurrent-Account", cfg.XurrentAccount);
    }

    // ── GraphQL taşıma katmanı ───────────────────────────────────────────────

    /// <summary>Okuma sorguları: query sınıfı (429 da belirsiz de tekrarlanır).</summary>
    private Task<JsonObject> PostAsync(string query, JsonObject? variables, CancellationToken ct)
        => PostAsync(query, variables, OperationClass.Query, "query", ct);

    /// <summary>
    /// Sınıflandırılmış gönderim: istek, operasyon sınıfının Polly pipeline'ı içinde
    /// çalışır (RetryPolicy). guarded_create BURADAN GEÇMEZ — o sınıfın döngüsü
    /// ExecuteGuardedCreateAsync'te elle yazılıdır (gerekçe RetryPolicy başlığında).
    /// </summary>
    private Task<JsonObject> PostAsync(
        string query, JsonObject? variables, OperationClass cls, string op, CancellationToken ct)
    {
        // Gövde BİR KEZ kurulur ve tüm tekrarlarda aynen kullanılır. variables'ı
        // DeepClone'luyoruz çünkü PlannedMutation.Input aynı zamanda tool ÇIKTISINDA
        // yaşıyor — JsonNode bir ebeveyne bağlanınca ikinci bağlama fırlatır.
        var body = BuildBody(query, variables);
        return _retry.ExecuteAsync(cls, op, c => SendOnceAsync(body, c), ct);
    }

    private static JsonObject BuildBody(string query, JsonObject? variables)
    {
        var body = new JsonObject { ["query"] = query };
        if (variables is not null) body["variables"] = variables.DeepClone();
        return body;
    }

    /// <summary>
    /// TEK istek — retry YOK, sınıflandırma VAR (contract/reliability.md §1):
    ///   429        → XurrentHttpException(429, Retry-After)   [kesin-işlenmedi]
    ///   5xx        → XurrentHttpException(5xx)                 [belirsiz]
    ///   ağ/timeout → XurrentHttpException(0)                   [belirsiz — bilinçli sadeleştirme]
    ///   4xx (≠429) → InvalidOperationException                 [kesin-reddedildi, ASLA retry]
    ///   200 + top-level errors → InvalidOperationException     [kesin-reddedildi]
    /// Payload errors (iş kuralı) burada İSTİSNA DEĞİLDİR — HTTP 200 + errors[] olarak
    /// data içinde akmaya devam eder; onları ExecuteAsync'in payload katmanı okur.
    /// </summary>
    private async Task<JsonObject> SendOnceAsync(JsonObject body, CancellationToken ct)
    {
        await ThrottleAsync(ct);

        HttpResponseMessage res;
        try
        {
            // NEDEN her zaman POST: Xurrent GraphQL endpoint'i GET kabul etmez.
            res = await _http.PostAsJsonAsync("", body, Json.Options, ct);
        }
        catch (HttpRequestException ex)
        {
            throw new XurrentHttpException(0, null,
                $"Xurrent'a ulaşılamadı (ağ hatası): {ex.Message}", ex);
        }
        catch (TaskCanceledException ex) when (!ct.IsCancellationRequested)
        {
            // HttpClient.Timeout dolunca TaskCanceledException gelir — bu kullanıcı
            // iptali DEĞİL, zaman aşımıdır ve sınıfı "belirsiz"dir (yanıtı görmedik).
            throw new XurrentHttpException(0, null,
                "Xurrent isteği zaman aşımına uğradı (30 sn) — istek işlenmiş OLABİLİR.", ex);
        }

        using (res)
        {
            CaptureRateLimit(res);
            var status = (int)res.StatusCode;

            if (status == 429)
            {
                // Rate limiter isteği İŞLEMEDEN reddetti → her operasyon sınıfı için
                // güvenle tekrarlanabilir. Retry-After (saniye) beklemenin alt sınırıdır.
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
                    $"Xurrent sunucu hatası (HTTP {status}) — istek işlenmiş OLABİLİR (sınıf: belirsiz).");

            var text = await res.Content.ReadAsStringAsync(ct);

            if (status >= 400)
            {
                // Kesin-reddedildi: sunucu isteği ANLADI ve reddetti. Tekrarlamak
                // aynı reddi üretir → düz InvalidOperationException (retry filtresi tutmaz).
                var detail = FirstErrorMessage(text) ?? text[..Math.Min(text.Length, 200)];
                throw new InvalidOperationException(
                    $"Xurrent isteği reddetti (HTTP {status}): {detail} " +
                    "Bu hata sınıfı otomatik TEKRARLANMAZ (kesin-reddedildi).");
            }

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
    }

    private static string? FirstErrorMessage(string text)
    {
        try
        {
            return (JsonNode.Parse(text)?["errors"] as JsonArray)?
                .Select(e => e?["message"]?.GetValue<string>())
                .FirstOrDefault(m => !string.IsNullOrWhiteSpace(m));
        }
        catch (System.Text.Json.JsonException) { return null; }
    }

    /// <summary>
    /// Gaz kapısı: bir önceki isteğin ÜZERİNDEN MinRequestGapMs geçmeden yeni istek çıkmaz.
    /// SemaphoreSlim + zaman damgası: eşzamanlı çağrılar sıraya girer, bekleme
    /// kapının İÇİNDE yapılır ki iki istek aynı boşluğu paylaşamasın.
    /// </summary>
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

    /// <summary>
    /// step.Path → operasyon sınıfı (contract/reliability.md §2). Sınıf, hatanın
    /// tekrar edilip edilmeyeceğini belirler — transport değil, OPERASYON karar verir.
    /// </summary>
    internal static OperationClass ClassifyPath(string path) => path switch
    {
        "timeEntryCreate" => OperationClass.GuardedCreate,
        "timeEntryUpdate" => OperationClass.IdempotentUpdate,
        // requestUpdate/taskUpdate/projectTaskUpdate/problemUpdate: timeSpent ARTIMLI,
        // idempotency anahtarı yok → belirsiz hatada tekrar = çift sayım.
        _ => OperationClass.NoRetry,
    };

    public async Task<MutationOutcome> ExecuteAsync(PlannedMutation step, CancellationToken ct)
    {
        var cls = ClassifyPath(step.Path);
        try
        {
            if (cls == OperationClass.GuardedCreate)
                return await ExecuteGuardedCreateAsync(step, ct);

            var data = await PostAsync(step.Mutation, step.Input, cls, step.Path, ct);
            return await ParseMutationPayloadAsync(data, step, ct);
        }
        catch (XurrentHttpException ex)
        {
            // Retry bütçesi bitti (ya da sınıf hiç izin vermedi). İstisna değil,
            // YAPILANDIRILMIŞ hata döndürüyoruz: bulk'ta stopOnError=false diğer
            // satırlarla devam edebilmeli, tek yazmada da errors[] dolu dönmeli.
            return MutationOutcome.Fail(WriteFailureMessage(step.Path, cls, ex));
        }
        catch (InvalidOperationException ex)
        {
            // Kesin-reddedildi (4xx / GraphQL top-level errors): retry zaten denenmedi.
            return MutationOutcome.Fail(ex.Message);
        }
    }

    /// <summary>
    /// ★ guarded_create (timeEntryCreate) — ELLE YAZILI döngü.
    ///
    /// NEDEN Polly değil: belirsiz hatada (5xx/ağ) körlemesine tekrar etmek çift kayıt
    /// yazabilir — istek sunucuda İŞLENMİŞ olabilir. Politika (reliability.md §2):
    /// belirsiz hatada ÖNCE sourceID geri-okuması; kayıt VARSA yazma zaten olmuş demektir
    /// ve mevcut kayıt BAŞARI olarak döndürülür (retry'a hiç gidilmez); YOKSA tekrar
    /// denenir. "Başarısız denemeyi başarıya çevirme" kararı Polly'nin OnRetry/predicate
    /// kancalarına sığmıyor; döngüyü elle yazmak hem daha kısa hem okunur çıktı.
    /// Bekleme matematiği yine RetryPolicy.ComputeWait — politika TEK yerde.
    /// </summary>
    private async Task<MutationOutcome> ExecuteGuardedCreateAsync(PlannedMutation step, CancellationToken ct)
    {
        var body = BuildBody(step.Mutation, step.Input);
        var sourceId = step.Input["input"]?["sourceID"]?.GetValue<string>();
        var max = _retry.MaxAttempts;

        for (var attempt = 1; ; attempt++)
        {
            XurrentHttpException failure;
            try
            {
                var data = await SendOnceAsync(body, ct);
                return await ParseMutationPayloadAsync(data, step, ct);
            }
            catch (XurrentHttpException ex)
            {
                failure = ex;
            }

            // 429 = kesin-işlenmedi: kayıt yazılmış OLAMAZ, geri-okuma İSRAFTIR → doğrudan tekrar.
            // Belirsiz (5xx/ağ): istek işlenmiş olabilir → önce "yazılmış mı?" sorusu.
            if (failure.Uncertain && sourceId is not null)
            {
                JsonObject? existing = null;
                try
                {
                    existing = await FindTimeEntryBySourceIdAsync(sourceId, ct);
                }
                catch (InvalidOperationException)
                {
                    // Geri-okuma da düştü (query sınıfının kendi retry'ları dahil).
                    // Miss sayıp normal retry'a devam ediyoruz: sunucu bu kadar hastaysa
                    // create tekrarı da düşecek; kısır döngüden hata raporuyla çıkılır.
                }
                ReliabilityTrace.Dedup(sourceId, existing is not null);
                if (existing is not null)
                    return new MutationOutcome(existing, []); // yazılmış: mevcut kayıt = BAŞARI
            }

            if (attempt >= max)
                return MutationOutcome.Fail(WriteFailureMessage(step.Path, OperationClass.GuardedCreate, failure));

            var wait = _retry.ComputeWait(attempt, failure.RetryAfter);
            ReliabilityTrace.Retry(step.Path, attempt, max, failure.Reason, (int)wait.TotalMilliseconds);
            await Task.Delay(wait, ct);
        }
    }

    /// <summary>
    /// Transport hatasını KULLANICIYA dürüst anlatan Türkçe mesaj. Özellikle no_retry
    /// sınıfında "yazılmış olabilir" belirsizliği SAKLANMAZ — sözleşmenin şartı bu.
    /// </summary>
    private string WriteFailureMessage(string path, OperationClass cls, XurrentHttpException ex)
    {
        if (ex.StatusCode == 429)
            return $"{path} rate limit yüzünden başarısız: {_retry.MaxAttempts} deneme boyunca HTTP 429 " +
                   "alındı. Kayıt OLUŞMADI (429 istek işlenmeden reddedilir). Biraz sonra tekrar deneyin.";

        return cls switch
        {
            // no_retry: tek deneme yapıldı ve sonucu BİLMİYORUZ. Dürüstlük zorunlu.
            OperationClass.NoRetry =>
                $"{path} belirsiz bir hatayla düştü ({ex.Message}) ve otomatik TEKRARLANMADI: " +
                "bu operasyonda timeSpent ARTIMLIDIR, tekrar çift sayım üretebilirdi. " +
                "DİKKAT: yazma Xurrent'a ulaşmış ve İŞLENMİŞ OLABİLİR — ticket'ın zaman " +
                "girişlerini kontrol edin ve gerekirse elle karar verin.",

            // guarded_create: geri-okuma(lar) kayıt bulamadı → oluşmamış görünüyor.
            OperationClass.GuardedCreate =>
                $"{path} {_retry.MaxAttempts} denemede başarısız (son hata: {ex.Message}). " +
                "sourceID geri-okuması kayıt bulamadı — kayıt oluşmamış görünüyor. " +
                "Aynı komut güvenle TEKRAR çalıştırılabilir; dedup çift kaydı önler.",

            _ =>
                $"{path} {_retry.MaxAttempts} denemede başarısız (son hata: {ex.Message}).",
        };
    }

    /// <summary>Mutation payload'ının ortak okunması (eski ExecuteAsync gövdesi).</summary>
    private async Task<MutationOutcome> ParseMutationPayloadAsync(
        JsonObject data, PlannedMutation step, CancellationToken ct)
    {
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
    /// Dedup geri-okuması (reliability.md §5): sourceID ile mevcut TimeEntry aranır.
    /// D14 — gerçek TimeEntryFilter'da sourceID filtresinin varlığı DOĞRULANMALI;
    /// yoksa kişi+tarih sorgusu + istemci tarafı eşleşmeye düşülür.
    /// Query sınıfında koşar: geri-okumanın kendisi yan etkisizdir, retry'ı serbesttir.
    /// </summary>
    public async Task<JsonObject?> FindTimeEntryBySourceIdAsync(string sourceId, CancellationToken ct)
    {
        const string q = """
            query FindBySourceId($sourceID: String!) {
              timeEntries(first: 5, view: all, filter: { sourceID: { values: [$sourceID] } }) {
                nodes {
                  id date startedAt timeSpent description correction
                  source sourceID
                  person { id name }
                  effortClass { id name }
                  timeAllocation { id name }
                }
              }
            }
            """;
        var data = await PostAsync(q, new JsonObject { ["sourceID"] = sourceId }, ct);
        var node = (data["timeEntries"]?["nodes"] as JsonArray)?.FirstOrDefault()?.AsObject();
        // DeepClone: düğüm yanıt ağacına bağlı; WriteResult.timeEntry olarak yeniden
        // ebeveynlenirse JsonNode "already has a parent" fırlatır.
        return node?.DeepClone().AsObject();
    }

    /// <summary>
    /// xurrent_list_time_entries — TEK timeEntries sorgusu, query sınıfında
    /// (yan etkisiz, retry serbest). Değişken adları sözleşme gereği sabittir:
    /// personId / dateFrom / dateTo / sourceID.
    /// </summary>
    public async Task<TimeEntryPage> ListTimeEntriesAsync(ListTimeEntriesArgs args, CancellationToken ct)
    {
        var personId = await ResolvePersonIdAsync(args.PersonId, ct);
        var first = Math.Clamp(args.First, 1, 100);

        var hasFrom = !string.IsNullOrWhiteSpace(args.DateFrom);
        var hasTo = !string.IsNullOrWhiteSpace(args.DateTo);
        var hasSource = !string.IsNullOrWhiteSpace(args.SourceId);

        var vars = new JsonObject { ["personId"] = personId, ["first"] = first };
        if (hasFrom) vars["dateFrom"] = args.DateFrom;
        if (hasTo) vars["dateTo"] = args.DateTo;
        if (hasSource) vars["sourceID"] = args.SourceId;

        var data = await PostAsync(Queries.ListTimeEntries(hasFrom, hasTo, hasSource), vars, ct);

        var rows = (data["timeEntries"]?["nodes"] as JsonArray ?? [])
            .Select(n => ToTimeEntryRecord(n!.AsObject()))
            .ToList();

        return new TimeEntryPage(_cfg.XurrentAccount, rows, rows.Sum(r => r.TimeSpent));
    }

    private static TimeEntryRecord ToTimeEntryRecord(JsonObject o)
    {
        var person = o["person"]?.AsObject();
        var effort = o["effortClass"]?.AsObject();
        var assignment = o["assignment"]?.AsObject();

        return new TimeEntryRecord(
            Id: MockAdapter.Str(o, "id") ?? "",
            Date: MockAdapter.Str(o, "date") ?? "",
            StartedAt: MockAdapter.Str(o, "startedAt"),
            TimeSpent: MockAdapter.Int(o, "timeSpent") ?? 0,
            Description: MockAdapter.Str(o, "description"),
            Correction: MockAdapter.Bool(o, "correction"),
            Source: MockAdapter.Str(o, "source"),
            SourceId: MockAdapter.Str(o, "sourceID"),
            Person: person is null
                ? null
                : new TimeEntryPersonRef(MockAdapter.Str(person, "id") ?? "", MockAdapter.Str(person, "name")),
            // Yol A kayıtlarında assignment NULL gelir — ticket'a bağlanmamıştır.
            Assignment: assignment is null
                ? null
                : new TimeEntryAssignmentRef(
                    MockAdapter.Str(assignment, "__typename"),
                    MockAdapter.Str(assignment, "id"),
                    MockAdapter.Str(assignment, "requestId") ?? MockAdapter.Str(assignment, "taskId")),
            EffortClass: effort is null
                ? null
                : new TimeEntryEffortClassRef(MockAdapter.Str(effort, "id") ?? "", MockAdapter.Str(effort, "name")));
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

    // internal: RestAdapter aynı Türkçe durum etiketlerini kullanır — etiket
    // transportun değil, SÖZLEŞMENİN parçasıdır (üç dil aynı statusLabel üretir).
    internal static string? StatusLabel(string? status) => status switch
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
        _gapGate.Dispose();
    }
}
