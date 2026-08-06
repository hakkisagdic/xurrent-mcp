using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ WP3 — REST v1 adaptörü (Xurrent/RestAdapter.cs, lehçe: tools/fake-xurrent handleRest).
///
/// Kapsam (lehçe 2026-08-06'da developer.xurrent.com'a karşı doğrulandı):
///   · endpoint/parametre eşlemesi (whoami 2 istek, member/assignee, sourceID,
///     tarih filtresi: operatör DEĞERİN içinde — ?date=&gt;=X&lt;=Y, date_from/date_to YOK)
///   · referans alanları İD'SİZ ad + düz id (person, effort_class, time_allocation...)
///   · snake_case → adaptör içi camelCase normalizasyonu; bağlı kayıt KOŞULLU
///     request/task/problem/project_task referanslarından türetilir (assignment alanı YOK)
///   · 422 → errors[] normalizasyonu — gövde ["alan","mesaj"] İKİLİLERİ taşır
///     (İSTİSNAİ DEĞİL, ASLA retry edilmez)
///   · Yol B'de description note'a düşer + uyarı (time_entry_description parametresi YOK)
///   · operasyon başına retry sınıflandırması (transport değişti, politika değişmedi)
///   · dedup geri-okuması (GET /time_entries?sourceID=)
///
/// GuvenilirlikTests ile aynı teknik: SAHTE HttpMessageHandler, ağ yok, yanıtlar betikli.
/// </summary>
public class RestUyarlamaTests
{
    // ── Yardımcılar ──────────────────────────────────────────────────────────

    private static AppConfig Ayarlar(int denemeler = 5) => new()
    {
        RepoRoot = Ortam.RepoKoku,
        FixturesDir = Ortam.FixtureDizini,
        XurrentMode = "live",
        XurrentApi = "rest",
        XurrentToken = "test-token",
        XurrentAccount = "ornek-bt",
        XurrentRestUrl = "http://127.0.0.1:9/v1",
        XurrentConfirmPolicy = "open",
        TimeZoneId = Ortam.SaatDilimiId,
        Clock = new SabitSaat(Ortam.VarsayilanAn),
        RetryMaxAttempts = denemeler,
        RetryBaseMs = 1,
        RetryCapMs = 4,
        MinRequestGapMs = 0,
    };

    /// <summary>Betikli HTTP: yöntem + yol kaydeder, yanıtı fonksiyona bırakır.</summary>
    private sealed class SahteRest(Func<string, string, HttpResponseMessage> yanitla) : HttpMessageHandler
    {
        public readonly List<(string Method, string PathAndQuery, string Body)> Istekler = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var govde = request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct);
            var yol = request.RequestUri!.PathAndQuery;
            lock (Istekler) Istekler.Add((request.Method.Method, yol, govde));
            return yanitla(request.Method.Method, yol);
        }
    }

    private static HttpResponseMessage Json(int code, string json) => new((HttpStatusCode)code)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json"),
    };

    private const string MeYaniti = """
        {"id":"P1","name":"Ayşe Yılmaz","primary_email":"ayse@ornek.com","job_title":"BT Uzmanı",
         "time_zone":"Europe/Istanbul","disabled":false,"organization":{"id":"O1","name":"BT Hizmetleri"}}
        """;
    private const string HesapYaniti = """{"id":"ornek-bt","name":"Örnek A.Ş.","directory":false}""";

    private static PlannedMutation ParentAdim() => new(0, "requestUpdate", Queries.RequestUpdate,
        new JsonObject
        {
            ["input"] = new JsonObject
            {
                ["id"] = "R1", ["timeSpent"] = 30,
                ["timeSpentEffortClassId"] = "EC1", ["timeEntryDescription"] = "rest testi",
            },
        }, [], null);

    private static PlannedMutation UpdateAdim() => new(0, "timeEntryUpdate", Queries.TimeEntryUpdate,
        new JsonObject { ["input"] = new JsonObject { ["id"] = "TE1", ["timeSpent"] = 60 } }, [], null);

    private static PlannedMutation CreateAdim(string sid) => new(0, "timeEntryCreate", Queries.TimeEntryCreate,
        new JsonObject
        {
            ["input"] = new JsonObject
            { ["timeSpent"] = 30, ["date"] = "2026-08-03", ["personId"] = "P1", ["sourceID"] = sid },
        }, [], null);

    // ── Endpoint / parametre eşlemesi ────────────────────────────────────────

    /// <summary>Öğretilen kontrast: GraphQL whoami 1 sorgu, REST whoami /me + /account = 2 istek.</summary>
    [Fact]
    public async Task whoami_iki_istek_atar_me_ve_account()
    {
        var handler = new SahteRest((_, yol) =>
            yol.EndsWith("/me") ? Json(200, MeYaniti) : Json(200, HesapYaniti));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.WhoAmIAsync(CancellationToken.None);

        Assert.Equal(2, handler.Istekler.Count);
        Assert.Equal(("GET", "/v1/me"), (handler.Istekler[0].Method, handler.Istekler[0].PathAndQuery));
        Assert.Equal(("GET", "/v1/account"), (handler.Istekler[1].Method, handler.Istekler[1].PathAndQuery));
        // snake_case → sözleşme alanları
        Assert.Equal("ayse@ornek.com", sonuc.Person.PrimaryEmail);
        Assert.Equal("BT Uzmanı", sonuc.Person.JobTitle);
        Assert.Equal("ornek-bt", sonuc.Account.Id);
    }

    /// <summary>Açık iş: $me önce /me ile çözülür; Request'te member, Task'ta assignee.</summary>
    [Fact]
    public async Task acik_is_member_ve_assignee_parametreleriyle_sorgulanir()
    {
        var handler = new SahteRest((_, yol) =>
            yol.EndsWith("/me") ? Json(200, MeYaniti)
            : yol.Contains("/requests") ? Json(200, """
                [{"id":"R1","subject":"Yazıcı","status":"in_progress",
                "next_target_at":"2026-08-04T17:00:00+03:00","updated_at":"2026-08-03T12:00:00+03:00",
                "team":{"name":"Servis Masası"},"member":{"id":"P1","name":"Ayşe"},"time_spent":60,
                "source_display_id":"70248"}]
                """)
            : Json(200, "[]"));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ListOpenWorkAsync(
            new ListOpenWorkArgs("$me", ["requests", "tasks"], 20, null, null, "all"), CancellationToken.None);

        Assert.Contains(handler.Istekler, i => i.PathAndQuery == "/v1/requests?member=P1");
        Assert.Contains(handler.Istekler, i => i.PathAndQuery == "/v1/tasks?assignee=P1");
        var istek = Assert.Single(sonuc.Requests.Nodes);
        Assert.Equal("70248", istek.DisplayId);                 // source_display_id → displayId
        Assert.Equal("Devam ediyor", istek.StatusLabel);        // aynı Türkçe etiket sözlüğü
        Assert.Equal("2026-08-04T17:00:00+03:00", istek.TargetAt);
    }

    /// <summary>
    /// list_time_entries: person + date + sourceID sorgu parametreleri. ★ date_from/date_to
    /// diye parametreler YOKTUR — operatör tek "date" parametresinin DEĞERİNİN içindedir:
    /// ?date=&gt;=2026-08-01&lt;=2026-08-03 (developer.xurrent.com/v1/general/filtering).
    /// </summary>
    [Fact]
    public async Task list_time_entries_tarih_araligini_tek_date_parametresinde_tasir()
    {
        var handler = new SahteRest((_, yol) =>
            yol.EndsWith("/me") ? Json(200, MeYaniti) : Json(200, "[]"));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        await adapter.ListTimeEntriesAsync(
            new ListTimeEntriesArgs("$me", "2026-08-01", "2026-08-03", "xmcp-abc", 50), CancellationToken.None);

        Assert.Contains(handler.Istekler, i => Uri.UnescapeDataString(i.PathAndQuery) ==
            "/v1/time_entries?person=P1&date=>=2026-08-01<=2026-08-03&sourceID=xmcp-abc");
        Assert.DoesNotContain(handler.Istekler, i => i.PathAndQuery.Contains("date_from"));
    }

    /// <summary>Tarih filtresi değeri: operatör değerin içinde; tek uç açık aralık üretir,
    /// eşit uçlar düz eşitliğe düşer, hiç uç yoksa filtre gönderilmez.</summary>
    [Theory]
    [InlineData(null, null, null)]
    [InlineData("2026-08-01", null, ">=2026-08-01")]
    [InlineData(null, "2026-08-03", "<=2026-08-03")]
    [InlineData("2026-08-02", "2026-08-02", "2026-08-02")]
    [InlineData("2026-08-01", "2026-08-03", ">=2026-08-01<=2026-08-03")]
    public void tarih_filtresi_operatoru_degerin_icinde_uretir(string? from, string? to, string? beklenen)
        => Assert.Equal(beklenen, RestAdapter.BuildDateFilter(from, to));

    /// <summary>Mutation adı → REST (yöntem, yol) tablosu.</summary>
    [Fact]
    public void endpoint_tablosu_mutation_adlarini_rest_yollarina_cevirir()
    {
        var input = new JsonObject { ["id"] = "X9" };
        Assert.Equal((HttpMethod.Post, "time_entries"), RestAdapter.EndpointFor("timeEntryCreate", input));
        Assert.Equal((HttpMethod.Patch, "time_entries/X9"), RestAdapter.EndpointFor("timeEntryUpdate", input));
        Assert.Equal((HttpMethod.Patch, "requests/X9"), RestAdapter.EndpointFor("requestUpdate", input));
        Assert.Equal((HttpMethod.Patch, "tasks/X9"), RestAdapter.EndpointFor("taskUpdate", input));
        Assert.Equal((HttpMethod.Patch, "project_tasks/X9"), RestAdapter.EndpointFor("projectTaskUpdate", input));
        Assert.Equal((HttpMethod.Patch, "problems/X9"), RestAdapter.EndpointFor("problemUpdate", input));
    }

    // ── Gövde eşlemesi ve normalizasyon ──────────────────────────────────────

    /// <summary>camelCase input → snake_case gövde; referans alanları İD'SİZ ad + düz id
    /// (developer.xurrent.com/v1/time_entries); id/clientMutationId düşer; sourceID camel KALIR.</summary>
    [Fact]
    public void rest_govdesi_snake_case_ve_idsiz_referans_adlari_uretir()
    {
        var input = new JsonObject
        {
            ["timeSpent"] = 30, ["date"] = "2026-08-02", ["startedAt"] = "2026-08-02T14:00:00+03:00",
            ["personId"] = "P1", ["timeAllocationId"] = "TA1", ["effortClassId"] = "EC1",
            ["description"] = "açıklama", ["source"] = "xurrent-mcp", ["sourceID"] = "xmcp-abc",
            ["clientMutationId"] = "xmcp-abc",
        };
        var govde = RestAdapter.ToRestBody("timeEntryCreate", input, "xurrent-mcp");

        Assert.Equal(30, govde["time_spent"]!.GetValue<int>());
        Assert.Equal("2026-08-02T14:00:00+03:00", govde["started_at"]!.GetValue<string>());
        // ★ İD'SİZ referans adları: person_id/effort_class_id/time_allocation_id DEĞİL.
        Assert.Equal("P1", govde["person"]!.GetValue<string>());
        Assert.Equal("TA1", govde["time_allocation"]!.GetValue<string>());
        Assert.Equal("EC1", govde["effort_class"]!.GetValue<string>());
        Assert.False(govde.ContainsKey("person_id"));
        Assert.False(govde.ContainsKey("time_allocation_id"));
        Assert.False(govde.ContainsKey("effort_class_id"));
        Assert.Equal("xmcp-abc", govde["sourceID"]!.GetValue<string>());  // ★ tek istisna
        Assert.False(govde.ContainsKey("clientMutationId"));
        Assert.False(govde.ContainsKey("id"));
        Assert.False(govde.ContainsKey("timeSpent"));                      // camel sızmadı
    }

    /// <summary>
    /// Yol B gövdesi: time_spent + time_spent_effort_class (İD'SİZ) + note
    /// (developer.xurrent.com/v1/requests). ★ time_entry_description diye bir parametre
    /// YOKTUR: açıklama note'a düşürülür ve bilgi kaybı UYARI olarak raporlanır —
    /// two_step 2. adımı description'ı gerçek alanına yazar.
    /// </summary>
    [Fact]
    public void yol_b_govdesi_aciklamayi_nota_dusurur_ve_uyari_uretir()
    {
        var uyarilar = new List<string>();
        var input = new JsonObject
        {
            ["id"] = "R1", ["timeSpent"] = 45, ["timeSpentEffortClassId"] = "EC2",
            ["timeEntryDescription"] = "VPN bakımı", ["note"] = "iç not", ["clientMutationId"] = "x",
        };
        var govde = RestAdapter.ToRestBody("requestUpdate", input, "xurrent-mcp", uyarilar);

        Assert.Equal(45, govde["time_spent"]!.GetValue<int>());
        Assert.Equal("EC2", govde["time_spent_effort_class"]!.GetValue<string>());
        Assert.False(govde.ContainsKey("time_spent_effort_class_id"));
        Assert.False(govde.ContainsKey("time_entry_description"));         // ★ REST'te YOK
        var not = govde["note"]!.GetValue<string>();
        Assert.StartsWith("iç not", not);                                  // mevcut not korunur
        Assert.Contains("VPN bakımı", not);                                // açıklama note'a düştü
        Assert.False(govde.ContainsKey("id"));
        Assert.Contains(uyarilar, u => u.Contains("note'a yazıldı"));
    }

    /// <summary>Açıklama yoksa note olduğu gibi kalır ve uyarı ÜRETİLMEZ.</summary>
    [Fact]
    public void yol_b_govdesi_aciklama_yoksa_uyari_uretmez()
    {
        var uyarilar = new List<string>();
        var input = new JsonObject { ["id"] = "R1", ["timeSpent"] = 30, ["note"] = "sadece not" };
        var govde = RestAdapter.ToRestBody("requestUpdate", input, "xurrent-mcp", uyarilar);

        Assert.Equal("sadece not", govde["note"]!.GetValue<string>());
        Assert.Empty(uyarilar);
    }

    /// <summary>
    /// two_step düzeltme adımı REST'te source/sourceID'yi DE yazar (PATCH /time_entries
    /// gövdesi kabul eder — GraphQL yolunda taşınamıyordu). "-fix" eki soyulur ki kayıt
    /// gerçek deterministik anahtarı taşısın.
    /// </summary>
    [Fact]
    public void two_step_duzeltme_adimi_source_ve_sourceID_yazar_fix_eki_soyulur()
    {
        var input = new JsonObject
        {
            ["id"] = "TE1", ["date"] = "2026-08-02", ["personId"] = "P1",
            ["clientMutationId"] = "xmcp-abc123-fix",
        };
        var govde = RestAdapter.ToRestBody("timeEntryUpdate", input, "xurrent-mcp");

        Assert.Equal("2026-08-02", govde["date"]!.GetValue<string>());
        Assert.Equal("P1", govde["person"]!.GetValue<string>());          // İD'SİZ referans adı
        Assert.Equal("xurrent-mcp", govde["source"]!.GetValue<string>());
        Assert.Equal("xmcp-abc123", govde["sourceID"]!.GetValue<string>());
    }

    /// <summary>
    /// snake_case REST time entry → adaptör içi camelCase şekil. ★ Yanıtta "assignment"
    /// diye bir alan YOKTUR: bağlı kayıt KOŞULLU request/task/problem/project_task
    /// referans nesnesi olarak gelir ve iç şekle oradan türetilir
    /// (developer.xurrent.com/v1/time_entries).
    /// </summary>
    [Fact]
    public void normalize_time_entry_kosullu_referanstan_assignment_turetir()
    {
        var rest = JsonNodeParse("""
            {"id":"TE9","date":"2026-08-03","started_at":"2026-08-03T09:00:00+03:00","time_spent":90,
             "description":"bakım","correction":false,"source":"xurrent-mcp","sourceID":"xmcp-def",
             "person":{"id":"P1","name":"Ayşe"},"effort_class":{"id":"EC1","name":"Normal"},
             "time_allocation":{"id":"TA1","name":"İç toplantılar"},
             "request":{"id":"R1"}}
            """);
        var n = RestAdapter.NormalizeTimeEntry(rest);

        Assert.Equal("TE9", n["id"]!.GetValue<string>());
        Assert.Equal("2026-08-03T09:00:00+03:00", n["startedAt"]!.GetValue<string>());
        Assert.Equal(90, n["timeSpent"]!.GetValue<int>());
        Assert.Equal("xmcp-def", n["sourceID"]!.GetValue<string>());
        Assert.Equal("Ayşe", n["person"]!["name"]!.GetValue<string>());
        Assert.Equal("Normal", n["effortClass"]!["name"]!.GetValue<string>());
        Assert.Equal("İç toplantılar", n["timeAllocation"]!["name"]!.GetValue<string>());
        Assert.Equal("Request", n["assignment"]!["__typename"]!.GetValue<string>());
        Assert.Equal("R1", n["assignment"]!["id"]!.GetValue<string>());
        Assert.False(n.ContainsKey("started_at"));
        Assert.False(n.ContainsKey("time_spent"));
    }

    /// <summary>Dört koşullu referans alanının her biri doğru __typename'e çevrilir;
    /// hiçbiri yoksa bağ türetilmez (Yol A kaydı).</summary>
    [Theory]
    [InlineData("request", "Request")]
    [InlineData("task", "Task")]
    [InlineData("problem", "Problem")]
    [InlineData("project_task", "ProjectTask")]
    public void kosullu_referans_alani_dogru_ture_cevrilir(string alan, string beklenenTur)
    {
        var derived = RestAdapter.DeriveAssignment(new JsonObject
        { ["id"] = "TE1", [alan] = new JsonObject { ["id"] = "X1" } });
        Assert.NotNull(derived);
        Assert.Equal(beklenenTur, derived!.Value.Type);
        Assert.Equal("X1", derived.Value.Id);

        Assert.Null(RestAdapter.DeriveAssignment(JsonNodeParse("""{"id":"TE1","date":"2026-08-03"}""")));
    }

    /// <summary>timesheet_settings + effort_classes + time_allocations → TimeTrackingContext.
    /// disabled effort class eleme CLIENT tarafında — GraphQL yolundaki dersin aynısı.</summary>
    [Fact]
    public void baglam_kurulumu_snake_case_okur_ve_disabled_elemesini_client_tarafinda_yapar()
    {
        var setting = JsonNodeParse("""
            {"id":"TS1","unit":"minutes","workday":480,"workweek":2400,"time_increment":30,
             "allow_workday_overtime":false,"allow_workweek_overtime":false,
             "allocation_time_tracking":true,"assignment_time_tracking":true,
             "require_note":false,"require_time_entry_description":false,
             "request_effort_class":{"id":"EC1","name":"Normal"},
             "task_effort_class":{"id":"EC1","name":"Normal"},
             "project_task_effort_class":null,"problem_effort_class":null,
             "time_allocation_effort_class":{"id":"EC2","name":"Mesai dışı"}}
            """);
        var classes = JsonNode.Parse("""
            [{"id":"EC1","name":"Normal","position":1,"cost_multiplier":1.0,"disabled":false},
             {"id":"EC2","name":"Mesai dışı","position":2,"cost_multiplier":1.5,"disabled":false},
             {"id":"EC9","name":"Eski","position":9,"cost_multiplier":1.0,"disabled":true}]
            """)!.AsArray();
        var allocs = JsonNode.Parse("""
            [{"id":"TA1","name":"İç toplantılar","group":"Genel","description_required":false}]
            """)!.AsArray();

        var ctx = RestAdapter.BuildContext(setting, classes, allocs);

        Assert.Equal(30, ctx.TimeIncrement);
        Assert.Equal(2, ctx.EffortClasses.Count);                       // disabled ELENDİ
        Assert.DoesNotContain(ctx.EffortClasses, e => e.Id == "EC9");
        Assert.Equal("EC1", ctx.Defaults.RequestEffortClassId);
        Assert.Equal("EC2", ctx.Defaults.TimeAllocationEffortClassId);
        Assert.Equal("Genel", ctx.TimeAllocations[0].Group);
        Assert.False(ctx.AllowWorkdayOvertime);
    }

    // ── 422 → errors[] (iş kuralı; İSTİSNAİ DEĞİL, ASLA retry edilmez) ──────

    /// <summary>
    /// ★ REST hata modelinin kalbi: HTTP 422, GraphQL'in "200 + payload.errors"
    /// dersinin ikizidir. Gövde {"message":"Validation Failed","errors":[["alan",
    /// "mesaj"],...]} biçimindedir — hatalar İKİLİ DİZİLERDİR, nesne değil
    /// (developer.xurrent.com/v1/#http-status-codes). Tek istek çıkar (retry YOK),
    /// sonuç istisna değil yapılandırılmış errors[] olur: ikili[0] → path, ikili[1] → message.
    /// </summary>
    [Fact]
    public async Task http_422_ikili_dizileri_errors_dizisine_normalize_edilir()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var handler = new SahteRest((_, _) => Json(422,
            """{"message":"Validation Failed","errors":[["time_spent","timeSpent (45) bu organizasyonun timeIncrement değerinin (30) katı değil."]]}"""));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(ParentAdim(), CancellationToken.None);

        Assert.False(sonuc.Ok);
        Assert.Single(handler.Istekler);                                  // retry YOK
        Assert.DoesNotContain(izler, l => l.StartsWith("[retry]"));
        Assert.Contains("timeIncrement", sonuc.Errors[0].Message);        // ikili[1] → message
        Assert.Equal(["time_spent"], sonuc.Errors[0].Path);               // ikili[0] → path
    }

    /// <summary>422, guarded_create yolunda da aynı: retry ve geri-okuma tetiklenmez.</summary>
    [Fact]
    public async Task http_422_create_yolunda_da_retry_tetiklemez()
    {
        var handler = new SahteRest((_, _) => Json(422,
            """{"message":"Validation Failed","errors":[["time_spent","Negatif timeSpent yalnızca correction: true ile gönderilebilir."]]}"""));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(CreateAdim("xmcp-422"), CancellationToken.None);

        Assert.False(sonuc.Ok);
        Assert.Single(handler.Istekler);
        Assert.Contains("correction", sonuc.Errors[0].Message);
        Assert.Equal(["time_spent"], sonuc.Errors[0].Path);
    }

    /// <summary>Taşıma katmanı hataları (404 vb.) düz {"message":"..."} gövdesi taşır
    /// (developer.xurrent.com/v1 — 429 örneğiyle aynı biçim); mesaj hata detayına geçer.</summary>
    [Fact]
    public async Task rest_4xx_govdesindeki_message_alani_hata_detayina_tasinir()
    {
        var handler = new SahteRest((_, _) => Json(404, """{"message":"TimeEntry bulunamadı: TE1"}"""));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(UpdateAdim(), CancellationToken.None);

        Assert.False(sonuc.Ok);
        Assert.Single(handler.Istekler);                                  // kesin-reddedildi: retry YOK
        Assert.Contains("TimeEntry bulunamadı", sonuc.Errors[0].Message);
    }

    // ── Yol B yürütme: gövde, uyarı ve geri-okuma uçtan uca ──────────────────

    /// <summary>
    /// Yol B yürütmesi: PATCH gövdesi time_entry_description TAŞIMAZ (açıklama note'a
    /// düşer), bilgi kaybı outcome.Warnings ile yüzeye çıkar, ve oluşan kayıt geri-okuma
    /// listesindeki KOŞULLU request referansından bulunur (REST'te assignment alanı yok).
    /// </summary>
    [Fact]
    public async Task yol_b_yurutmesi_uyariyi_dondurur_ve_kaydi_kosullu_referanstan_bulur()
    {
        var handler = new SahteRest((metot, yol) =>
            metot == "PATCH" ? Json(200, """{"id":"R1","subject":"x","status":"in_progress","time_spent":30}""")
            : yol.EndsWith("/me") ? Json(200, MeYaniti)
            : Json(200, """
                [{"id":"TE-B","date":"2026-08-03","time_spent":30,"description":null,
                  "person":{"id":"P1","name":"Ayşe"},"request":{"id":"R1"}}]
                """));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(ParentAdim(), CancellationToken.None);

        Assert.True(sonuc.Ok);
        // Gövde: time_entry_description YOK, açıklama note'a düştü.
        var patchGovde = handler.Istekler.Single(i => i.Method == "PATCH").Body;
        Assert.DoesNotContain("time_entry_description", patchGovde);
        Assert.Contains("note", patchGovde);
        Assert.Contains("rest testi", patchGovde);
        // Uyarı outcome üzerinden yüzeye çıkar (Strategies bunu tool warnings'ine ekler).
        Assert.NotNull(sonuc.Warnings);
        Assert.Contains(sonuc.Warnings!, u => u.Contains("note'a yazıldı"));
        // Oluşan kayıt koşullu request referansından bulundu ve normalize edildi.
        Assert.Equal("TE-B", sonuc.TimeEntry!["id"]!.GetValue<string>());
        Assert.Equal("Request", sonuc.TimeEntry!["assignment"]!["__typename"]!.GetValue<string>());
        Assert.Equal("R1", sonuc.TimeEntry!["assignment"]!["id"]!.GetValue<string>());
    }

    // ── Retry sınıflandırması: transport değişti, politika DEĞİŞMEDİ ─────────

    /// <summary>429 kesin-işlenmedi: no_retry sınıfındaki parent PATCH bile tekrarlanır.</summary>
    [Fact]
    public async Task parent_patch_429da_tekrarlanir()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var deneme = 0;
        var handler = new SahteRest((metot, yol) =>
            metot == "PATCH"
                ? (Interlocked.Increment(ref deneme) == 1
                    ? Json(429, """{"message":"Too Many Requests"}""")
                    : Json(200, """{"id":"R1","subject":"x","status":"in_progress"}"""))
                : yol.EndsWith("/me") ? Json(200, MeYaniti)
                : Json(200, "[]"));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(ParentAdim(), CancellationToken.None);

        Assert.True(sonuc.Ok);
        Assert.Equal(2, deneme);
        Assert.Single(izler, l => l.StartsWith("[retry]") && l.Contains("op=requestUpdate") && l.Contains("reason=429"));
    }

    /// <summary>5xx belirsizdir; parent PATCH'te time_spent ARTIMLI → ASLA tekrarlanmaz.</summary>
    [Fact]
    public async Task parent_patch_5xxte_ASLA_tekrarlanmaz()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var handler = new SahteRest((_, _) => Json(500, """{"message":"kaos"}"""));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(ParentAdim(), CancellationToken.None);

        Assert.False(sonuc.Ok);
        Assert.Single(handler.Istekler);
        Assert.DoesNotContain(izler, l => l.StartsWith("[retry]"));
        Assert.Contains("İŞLENMİŞ OLABİLİR", sonuc.Errors[0].Message);
    }

    /// <summary>PATCH /time_entries/:id mutlak SET'tir (idempotent_update) → 5xx'te tekrar serbest.</summary>
    [Fact]
    public async Task time_entry_patch_5xxte_tekrarlanir()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var deneme = 0;
        var handler = new SahteRest((_, _) =>
            Interlocked.Increment(ref deneme) == 1
                ? Json(500, """{"message":"kaos"}""")
                : Json(200, """{"id":"TE1","date":"2026-08-03","time_spent":60,"person":{"id":"P1","name":"A"}}"""));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(UpdateAdim(), CancellationToken.None);

        Assert.True(sonuc.Ok);
        Assert.Equal(2, deneme);
        Assert.Equal(60, sonuc.TimeEntry!["timeSpent"]!.GetValue<int>());   // normalize edildi
        Assert.Single(izler, l => l.Contains("op=timeEntryUpdate") && l.Contains("reason=5xx"));
    }

    // ── guarded_create: belirsiz hatada önce sourceID geri-okuması ───────────

    /// <summary>POST 500 verdi ama kayıt aslında yazılmıştı → geri-okuma HIT, mevcut kayıt BAŞARI.</summary>
    [Fact]
    public async Task guarded_create_belirsiz_hatada_geri_okur_hit_ise_mevcut_kaydi_dondurur()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var postDenemesi = 0;
        var handler = new SahteRest((metot, yol) =>
            metot == "POST"
                ? (Interlocked.Increment(ref postDenemesi), Json(500, """{"message":"kaos"}""")).Item2
                : Json(200, """[{"id":"TE-MEVCUT","date":"2026-08-03","time_spent":30,"sourceID":"xmcp-hit1"}]"""));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(CreateAdim("xmcp-hit1"), CancellationToken.None);

        Assert.True(sonuc.Ok);
        Assert.Equal("TE-MEVCUT", sonuc.TimeEntry!["id"]!.GetValue<string>());
        Assert.Equal(1, postDenemesi);                                    // POST TEKRARLANMADI
        Assert.Contains(handler.Istekler, i => i.PathAndQuery == "/v1/time_entries?sourceID=xmcp-hit1");
        Assert.Contains("[dedup] op=timeEntryCreate sourceID=xmcp-hit1 hit=true", izler);
        Assert.DoesNotContain(izler, l => l.StartsWith("[retry]"));
    }

    /// <summary>Geri-okuma miss → yazılmamış → retry serbest; POST tekrarı BAŞARIR; 201 normalize edilir.</summary>
    [Fact]
    public async Task guarded_create_miss_ise_tekrar_dener_ve_201i_normalize_eder()
    {
        var izler = new List<string>();
        using var kayit = ReliabilityTrace.CaptureForTest(izler.Add);

        var postDenemesi = 0;
        var handler = new SahteRest((metot, _) =>
            metot == "POST"
                ? (Interlocked.Increment(ref postDenemesi) == 1
                    ? Json(500, """{"message":"kaos"}""")
                    : Json(201, """
                        {"id":"TE-YENI","date":"2026-08-03","time_spent":30,
                        "person":{"id":"P1","name":"A"},"sourceID":"xmcp-miss1"}
                        """))
                : Json(200, "[]"));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.ExecuteAsync(CreateAdim("xmcp-miss1"), CancellationToken.None);

        Assert.True(sonuc.Ok);
        Assert.Equal("TE-YENI", sonuc.TimeEntry!["id"]!.GetValue<string>());
        Assert.Equal(2, postDenemesi);
        Assert.Contains("[dedup] op=timeEntryCreate sourceID=xmcp-miss1 hit=false", izler);
        Assert.Single(izler, l => l.StartsWith("[retry]") && l.Contains("op=timeEntryCreate") && l.Contains("reason=5xx"));
    }

    /// <summary>Dedup geri-okuması: GET /time_entries?sourceID= parametresiyle gider.</summary>
    [Fact]
    public async Task dedup_geri_okumasi_sourceID_parametresiyle_sorgular()
    {
        var handler = new SahteRest((_, _) => Json(200, "[]"));
        using var adapter = new RestAdapter(Ayarlar(), new HttpClient(handler));

        var sonuc = await adapter.FindTimeEntryBySourceIdAsync("xmcp-yok", CancellationToken.None);

        Assert.Null(sonuc);
        var istek = Assert.Single(handler.Istekler);
        Assert.Equal("/v1/time_entries?sourceID=xmcp-yok", istek.PathAndQuery);
    }

    private static JsonObject JsonNodeParse(string json) => JsonNode.Parse(json)!.AsObject();
}
