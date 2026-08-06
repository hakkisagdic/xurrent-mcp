using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using XurrentMcp.Calendars;
using XurrentMcp.Xurrent;

namespace XurrentMcp.Core;

/// <summary>
/// ★ timesheet_wizard — LLM'siz, sunucu-güdümlü sohbet durum makinesi
/// (contract/wizard.md §1–§5). Host yalnızca kullanıcı cümlesini iletir ve dönen
/// soruyu gösterir; kararların TAMAMI burada, deterministik olarak verilir.
///
/// Adım semantiği (ÜÇ DİLDE AYNI — senaryo h bunu ölçer): çıktıdaki <c>step</c>,
/// bu yanıtı üreten yani SON TAMAMLANAN adımdır ve sessionState'e aynen yazılır:
///   çağrı 1 (boş)        → "start"      (selamlar, işleri listeler; seçim bekler)
///   seçim cevabı         → "pick_work"  (işi doğrular; süre sorusunu sorar)
///   süre cevabı          → "duration"   (120 dk çevirimi söyler; detay sorar)
///   detay cevabı         → "detail"     (özetler; strateji seçtirir)
///   strateji cevabı      → "strategy"   (dry-run planı gösterir; evet/hayır)
///   evet                 → "write"      (yazar + geri-okur; done=true)
///   hayır / hata / iptal → "done"       (done=true, yazılmadı)
/// Takvim dalı: "calendar_plan" → "calendar_confirm" → "write". Bir sonraki
/// çağrının hangi cevabı işleyeceğini state'teki bu adım adı belirler
/// ("pick_work" state'i süre cevabı bekliyor demektir).
///
/// İş mantığı YENİDEN YAZILMAZ: her aksiyon mevcut çekirdeği çağırır —
/// ToolImpl.WhoAmIAsync / TimeTrackingContextAsync / ListOpenWorkAsync /
/// CreateTimeEntryAsync / CreateTimeEntriesBulkAsync / PlanFromCalendarAsync /
/// ListTimeEntriesAsync. write geçişi approved:true ile çağrılır: sihirbazın
/// KENDİ onay adımı onaydır, elicitation katmanına İKİNCİ kez sorulmaz;
/// koruma plannedFingerprint karşılaştırmasıdır (§4).
/// </summary>
public static class TimesheetWizard
{
    // ── Adım adları (sözleşme enum'u) ────────────────────────────────────────
    private const string StepStart = "start";
    private const string StepPickWork = "pick_work";
    private const string StepDuration = "duration";
    private const string StepDetail = "detail";
    private const string StepStrategy = "strategy";
    private const string StepConfirm = "confirm";
    private const string StepWrite = "write";
    private const string StepCalendarPlan = "calendar_plan";
    private const string StepCalendarConfirm = "calendar_confirm";
    private const string StepDone = "done";

    private const string TakvimChoiceId = "takvim";

    public static async Task<WizardResult> RunAsync(
        AppConfig cfg, IXurrentAdapter adapter, CalendarFactory calendar,
        string? utterance, string? sessionState, CancellationToken ct)
    {
        // İlk çağrı: state yok → start.
        if (string.IsNullOrEmpty(sessionState))
            return await StartAsync(cfg, adapter, preface: null, ct);

        // ★ İMZA ÖNCE, ham payload byte'ları üzerinde (WizardStateCodec).
        // Bozuk/expired state = NAZİK yeniden başlama; sessiz sıfırlama YOK.
        var verdict = WizardStateCodec.Verify(cfg, sessionState);
        if (!verdict.Ok)
            return await StartAsync(cfg, adapter,
                preface: $"{verdict.RestartReason} Güvenlik gereği sohbet BAŞTAN başlıyor.", ct);

        var payload = verdict.Payload!;
        var step = payload["step"]!.GetValue<string>();
        var data = payload["data"]?.AsObject() ?? new JsonObject();
        var answer = utterance?.Trim() ?? "";

        return step switch
        {
            StepStart => await HandleStartAsync(cfg, adapter, calendar, answer, data, ct),
            StepPickWork => await HandlePickWorkAsync(cfg, adapter, answer, data, ct),
            StepDuration => HandleDuration(cfg, answer, data),
            StepDetail => await HandleDetailAsync(cfg, adapter, answer, data, ct),
            // "confirm" rezerv etiket — evet/hayır beklenen aynı nokta (TS ile aynı karar).
            StepStrategy or StepConfirm => await HandleStrategyAsync(cfg, adapter, answer, data, ct),
            StepCalendarPlan => await HandleCalendarPlanAsync(cfg, adapter, answer, data, ct),
            StepCalendarConfirm => await HandleCalendarConfirmAsync(cfg, adapter, answer, data, ct),
            // write/done state olarak taşınmaz (done=true → state null); gelirse bozulmuştur.
            _ => await StartAsync(cfg, adapter,
                preface: $"Beklenmeyen adım \"{step}\" — sohbet BAŞTAN başlıyor (state bitmiş bir akışı işaret ediyor).", ct),
        };
    }

    // ── start eylemi: whoami + context + açık işler ──────────────────────────

    private static async Task<WizardResult> StartAsync(
        AppConfig cfg, IXurrentAdapter adapter, string? preface, CancellationToken ct)
    {
        var who = await ToolImpl.WhoAmIAsync(adapter, ct);
        var ctx = await ToolImpl.TimeTrackingContextAsync(adapter, "$me", ct);
        var items = await OpenItemsAsync(adapter, ct);
        var inc = ctx.TimeIncrement ?? 60;

        var sb = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(preface)) sb.AppendLine(preface).AppendLine();
        sb.AppendLine($"Merhaba {who.Person.Name ?? ""}! Zaman girişi sihirbazı (LLM'siz, sunucu-güdümlü durum makinesi).".Trim());
        // timeIncrement SÖYLENİR — sözleşmenin şartı (wizard.md §2 start satırı).
        sb.AppendLine($"Süre kuralı: bu hesabın timeIncrement değeri {inc} dakika — yazacağım her süre {inc}'in KATI olmak zorunda.");
        sb.AppendLine();
        sb.AppendLine($"Üzerinizdeki açık işler ({items.Count}):");
        for (var i = 0; i < items.Count; i++)
            sb.AppendLine($"  {i + 1}. #{items[i].DisplayId} — {items[i].Subject ?? "(konusuz)"} [{items[i].Kind}]");
        sb.Append($"  {items.Count + 1}. takvim — günün toplantılarından toplu öneri üret");

        return Ask(cfg, StepStart, new JsonObject { ["personId"] = "$me" },
            sb.ToString(), StartQuestion(items));
    }

    private static async Task<List<WorkItem>> OpenItemsAsync(IXurrentAdapter adapter, CancellationToken ct)
    {
        var work = await ToolImpl.ListOpenWorkAsync(adapter, "$me", null, 100, null, null, "all", ct);
        return work.Requests.Nodes.Concat(work.Tasks.Nodes).ToList();
    }

    private static readonly WizardChoice TakvimChoice = new(
        TakvimChoiceId,
        "Takvim: günün toplantılarından öneri üret",
        "calendar_list_today + plan_time_entries_from_calendar ile toplu öneri");

    private static List<WizardChoice> WorkChoices(List<WorkItem> items)
    {
        var choices = items
            .Select(w => new WizardChoice(w.Id, $"#{w.DisplayId} — {w.Subject ?? "(konusuz)"}",
                $"{(w.Kind == "request" ? "Request" : "Task")} · {w.StatusLabel ?? w.Status ?? "-"}"))
            .ToList();
        choices.Add(TakvimChoice);
        return choices;
    }

    private static WizardQuestion StartQuestion(List<WorkItem> items) => new(
        "Hangi işe zaman yazalım? Numara, id ya da başlıkla seçin; takvimden toplu öneri için 'takvim' yazın.",
        WorkChoices(items),
        ExpectsFreeText: true);

    private static readonly WizardQuestion DurationQuestion = new(
        "Ne kadar süre? Örnek: '2 saat', '1,5 saat', '90' (çıplak sayı DAKİKA sayılır — sözleşmenin tek birimi dakikadır).",
        ExpectsFreeText: true);

    private static readonly WizardQuestion DetailQuestion = new(
        "Tarih (bugün / dün / YYYY-AA-GG), istersen başlangıç saati (SS:DD) ve kısa bir açıklama yazın — " +
        "ör. 'dün 14:00 VPN bakımı'. Boş bırakırsanız tarih bugün olur.",
        ExpectsFreeText: true);

    /// <summary>Üç backdate stratejisi — keeps/costs metinleri contract'taki backdateStrategies'ten.</summary>
    private static readonly WizardQuestion StrategyQuestion = new(
        "Hangi yazma stratejisi? (üçü de bir şeyden feragat eder — bkz. seçeneklerin bedeli)",
        [
            new WizardChoice("two_step", "İki adımlı telafi (two_step)",
                "Korur: ticket bağı, geçmiş tarih (T-1), başlangıç saati. Bedeli: 2 HTTP isteği, atomik değil."),
            new WizardChoice("link_first", "Ticket bağı öncelikli (link_first)",
                "Tek istek, atomik; ama tarih HER ZAMAN bugün olur ve başlangıç saati kaydedilmez."),
            new WizardChoice("date_first", "Tarih öncelikli (date_first)",
                "date/startedAt tam kontrol; ama kayıt ticket'a BAĞLANMAZ (assignment=null)."),
        ],
        ExpectsFreeText: true);

    private static readonly WizardQuestion ConfirmQuestion = new(
        "Onaylıyor musunuz? (evet / hayır)",
        [
            new WizardChoice("evet", "Evet — planı Xurrent'a yaz"),
            new WizardChoice("hayır", "Hayır — vazgeç, hiçbir şey yazma"),
        ],
        ExpectsFreeText: true);

    private static readonly WizardQuestion CalendarQuestion = new(
        "Bu önerilerle devam edilsin mi? 'evet' → toplu dry-run özeti · 'hayır' → vazgeç · " +
        "'N hariç' → N numaralı öneriyi ele (ör. '3 hariç').",
        [
            new WizardChoice("evet", "Evet — önerilerle devam et"),
            new WizardChoice("hayır", "Hayır — vazgeç"),
        ],
        ExpectsFreeText: true);

    // ── start cevabı: iş seçimi ya da "takvim" ───────────────────────────────

    private static async Task<WizardResult> HandleStartAsync(
        AppConfig cfg, IXurrentAdapter adapter, CalendarFactory calendar,
        string answer, JsonObject data, CancellationToken ct)
    {
        var f = Katla(answer);
        // "takvim"/"toplantı" kelimesi takvim dalına saptırır (wizard.md §3).
        if (f.Contains("takvim") || f.Contains("toplantı"))
            return await CalendarPlanStepAsync(cfg, adapter, calendar, data, ct);

        var items = await OpenItemsAsync(adapter, ct);
        var choices = WorkChoices(items);
        var secim = MatchChoice(answer, choices);

        if (secim is null)
        {
            // Anlaşılamadı: adım DEĞİŞMEZ, aynı soru AYNEN döner (§2).
            return Ask(cfg, StepStart, data,
                $"\"{answer}\" bir seçimle eşleşmedi. Listeden 1-{items.Count} arası bir numara, " +
                "bir iş id'si ya da başlığın tamamını yazın; takvim için 'takvim' deyin.",
                StartQuestion(items));
        }

        if (secim.Id == TakvimChoiceId)
            return await CalendarPlanStepAsync(cfg, adapter, calendar, data, ct);

        var w = items.First(it => it.Id == secim.Id);
        data["targetType"] = w.Kind;
        data["targetId"] = w.Id;
        data["targetLabel"] = $"#{w.DisplayId} — {w.Subject ?? ""}".Trim();

        return Ask(cfg, StepPickWork, data,
            $"Seçilen iş: #{w.DisplayId} — {w.Subject ?? "(konusuz)"} [{w.Kind}]" +
            $"{(w.StatusLabel is null ? "" : $" · durum: {w.StatusLabel}")}\nid: {w.Id}",
            DurationQuestion);
    }

    // ── pick_work cevabı: süre. Çevirim AÇIKÇA söylenir; kat değilse SORULUR ──

    private static async Task<WizardResult> HandlePickWorkAsync(
        AppConfig cfg, IXurrentAdapter adapter, string answer, JsonObject data, CancellationToken ct)
    {
        var sure = ParseDuration(answer);
        if (sure is not { } d)
        {
            return Ask(cfg, StepPickWork, data,
                $"\"{answer}\" bir süre olarak anlaşılamadı. Kabul edilen biçimler: " +
                "'2 saat', '2 sa', '1,5 saat', '90 dk', '90' (çıplak sayı DAKİKA).",
                DurationQuestion);
        }

        var ctx = await ToolImpl.TimeTrackingContextAsync(adapter, "$me", ct);
        var inc = ctx.TimeIncrement ?? 60;
        if (inc > 0 && d.Minutes % inc != 0)
        {
            // Sessizce YUVARLANMAZ — kullanıcıya sorulur (wizard.md §2 duration satırı).
            var down = d.Minutes / inc * inc;
            var up = down + inc;
            return Ask(cfg, StepPickWork, data,
                $"{d.Minutes} dakika bu hesapta yazılamaz: timeIncrement={inc}, süre {inc}'in KATI olmalı. " +
                $"Sessizce yuvarlamıyorum — {(down > 0 ? $"{down} veya " : "")}{up} dakika yazabilirim; hangisini istersiniz?",
                DurationQuestion);
        }

        var cevrim = d.FromHours
            ? $"«{d.Raw} saat» → {d.Minutes} dakika olarak çevirdim (Xurrent'ın tek süre birimi DAKİKADIR). "
            : $"{d.Minutes} dakika olarak aldım. ";

        data["minutes"] = d.Minutes;
        return Ask(cfg, StepDuration, data,
            cevrim + $"Kayıt: {Str(data, "targetLabel") ?? "?"} · {Narrate.HumanMinutes(d.Minutes)}.",
            DetailQuestion);
    }

    // ── duration cevabı: tarih + saat + açıklama ─────────────────────────────

    private static WizardResult HandleDuration(AppConfig cfg, string answer, JsonObject data)
    {
        var today = TimeUtil.Today(cfg.TimeZone, cfg.Clock);
        var (date, time, description) = ParseDetail(answer, today);

        var backDays = today.DayNumber - date.DayNumber;
        if (backDays > cfg.MaxBackdateDays)
        {
            return Ask(cfg, StepDuration, data,
                $"{date:yyyy-MM-dd} izin verilen geriye yazma sınırının dışında " +
                $"(XURRENT_MAX_BACKDATE_DAYS={cfg.MaxBackdateDays} → en eski " +
                $"{today.AddDays(-cfg.MaxBackdateDays):yyyy-MM-dd}). Daha yakın bir tarih verin.",
                DetailQuestion);
        }

        if (description is { Length: > 80 })
        {
            return Ask(cfg, StepDuration, data,
                $"Açıklama {description.Length} karakter — Xurrent üst sınırı 80. Kısaltıp tekrar yazın.",
                DetailQuestion);
        }

        data["date"] = date.ToString("yyyy-MM-dd");
        if (time is { } t)
            data["startedAt"] = TimeUtil.ToIso(TimeUtil.AtLocal(date, t, cfg.TimeZone));
        if (description is not null)
            data["description"] = description;

        var parts = new[]
        {
            $"Tarih: {date:yyyy-MM-dd}{(date == today ? " (bugün)" : "")}",
            time is { } tt ? $"başlangıç: {tt.ToString("HH:mm", CultureInfo.InvariantCulture)}" : "başlangıç saati: yok",
            description is not null ? $"açıklama: \"{description}\"" : "açıklama: yok",
        };

        return Ask(cfg, StepDetail, data,
            string.Join(" · ", parts) +
            "\n\nŞimdi yazma stratejisi: Xurrent'ta 'ticket'a bağlı + geçmiş tarihli + saatli' kayıt " +
            "TEK mutation ile mümkün değil; üç yol da bir şeyden feragat eder.",
            StrategyQuestion);
    }

    // ── detail cevabı: strateji → dry-run planı göster, onay iste ────────────

    private static async Task<WizardResult> HandleDetailAsync(
        AppConfig cfg, IXurrentAdapter adapter, string answer, JsonObject data, CancellationToken ct)
    {
        var secim = MatchChoice(answer, StrategyQuestion.Choices!);
        if (secim is null)
        {
            return Ask(cfg, StepDetail, data,
                $"\"{answer}\" strateji seçenekleriyle eşleşmedi. 1-3 arası numara ya da " +
                "two_step / link_first / date_first yazın.",
                StrategyQuestion);
        }

        data["strategy"] = secim.Id;

        // AYNI çekirdek: xurrent_create_time_entry'nin planlama + ön kontrol yolu (dry-run).
        var preview = (await ToolImpl.CreateTimeEntryAsync(
            cfg, adapter, RequestFromData(data), dryRun: true, approved: false, ct)).Value!;

        if (preview.Errors.Count > 0)
        {
            return Bitti(
                "Plan ön kontrolden geçemedi — hiçbir şey yazılmadı:\n" +
                string.Join("\n", preview.Errors.Select(e => $"  ✖ {e.Message}")) +
                "\n\nSihirbazı yeniden başlatıp farklı değerlerle deneyebilirsiniz.",
                preview.Errors);
        }

        // Onaylanan planın parmak izi: write adımı bundan sapan HİÇBİR planı yazmaz (§4).
        data["plannedFingerprint"] = WizardStateCodec.PlannedFingerprint(preview.Planned);

        return Ask(cfg, StepStrategy, data, Narrate.Write(preview), ConfirmQuestion);
    }

    // ── strategy cevabı: evet → [write] yaz + geri-oku; hayır → bitti ────────

    private static async Task<WizardResult> HandleStrategyAsync(
        AppConfig cfg, IXurrentAdapter adapter, string answer, JsonObject data, CancellationToken ct)
    {
        var karar = ParseYesNo(answer);
        if (karar is null)
        {
            return Ask(cfg, StepStrategy, data,
                $"\"{answer}\" anlaşılamadı — 'evet' (evet/onay/onaylıyorum/tamam/e) ya da " +
                "'hayır' (hayır/iptal/vazgeç/h) bekliyorum.",
                ConfirmQuestion);
        }

        if (karar is false)
            return Bitti("Vazgeçildi — HİÇBİR mutation gönderilmedi. Yeni bir kayıt için sihirbazı tekrar çağırın.");

        // ── write geçişi: plan YENİDEN kurulur, parmak izi DOĞRULANIR ────────
        // State'le oynanıp (geçerli imzalı ama farklı veri taşıyan bir state ile)
        // onaylanandan FARKLI bir şey yazdırmak burada kapanır (wizard.md §4).
        var req = RequestFromData(data);
        var recheck = (await ToolImpl.CreateTimeEntryAsync(cfg, adapter, req, dryRun: true, approved: false, ct)).Value!;

        var fingerprint = WizardStateCodec.PlannedFingerprint(recheck.Planned);
        if (!string.Equals(fingerprint, Str(data, "plannedFingerprint"), StringComparison.Ordinal))
        {
            const string msg =
                "Onaylanan plan ile yazılacak plan AYNI DEĞİL (plannedFingerprint uyuşmadı) — yazma REDDEDİLDİ. " +
                "sessionState onaylanandan farklı bir planı işaret ediyor; sihirbazı baştan başlatın.";
            return Bitti(msg, [new ValidationError(msg, ["plannedFingerprint"])]);
        }

        if (recheck.Errors.Count > 0)
        {
            return Bitti(
                "Yazma öncesi ön kontrol başarısız — hiçbir şey yazılmadı:\n" +
                string.Join("\n", recheck.Errors.Select(e => $"  ✖ {e.Message}")),
                recheck.Errors);
        }

        // Sihirbazın kendi onay adımı ONAYIN KENDİSİDİR: protokol seviyesinde
        // (elicitation/MRTR) İKİNCİ bir onay istenmez — approved:true geçilir.
        var result = (await ToolImpl.CreateTimeEntryAsync(cfg, adapter, req, dryRun: false, approved: true, ct)).Value!;

        // ── geri-okuma: xurrent_list_time_entries'in AYNI çekirdeği ──────────
        var sid = PlannedSourceId(result.Planned);
        var today = TimeUtil.Today(cfg.TimeZone, cfg.Clock).ToString("yyyy-MM-dd");
        var tarih = Str(data, "date") ?? today;

        TimeEntryPage? page = null;
        try
        {
            page = sid is not null
                ? await ToolImpl.ListTimeEntriesAsync(adapter, Str(data, "personId") ?? "$me", null, null, sid, 25, ct)
                : await ToolImpl.ListTimeEntriesAsync(adapter, Str(data, "personId") ?? "$me", tarih, tarih, null, 100, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException) { /* geri-okuma raporu opsiyoneldir */ }

        var sb = new StringBuilder();
        sb.AppendLine(Narrate.Write(result));
        sb.AppendLine();
        if (page is not null)
        {
            sb.Append($"GERİ-OKUMA (xurrent_list_time_entries{(sid is null ? "" : $", sourceId={sid}")}): " +
                      $"{page.TimeEntries.Count} kayıt, toplam {page.TotalMinutes} dk.");
            if (result.Deduped == true)
                sb.Append("\nDEDUP: aynı sourceID'li kayıt zaten vardı — yazma atlandı, çift kayıt OLUŞMADI.");
        }
        else
        {
            sb.Append("GERİ-OKUMA yapılamadı — yazma sonucu yukarıdaki rapora dayanır.");
        }

        return new WizardResult(StepWrite, sb.ToString(), NextQuestion: null, SessionState: null,
            Done: true, WriteResult: result, Errors: result.Errors);
    }

    /// <summary>Planlanan adımların input'larından deterministik sourceID'yi çıkarır (varsa).</summary>
    private static string? PlannedSourceId(IReadOnlyList<PlannedMutation> planned)
    {
        foreach (var step in planned)
        {
            var sid = step.Input["input"]?["sourceID"]?.GetValue<string>();
            if (!string.IsNullOrEmpty(sid)) return sid;
        }
        return null;
    }

    // ── Takvim dalı ──────────────────────────────────────────────────────────

    /// <summary>calendar_plan eylemi: takvim + açık işlerden öneri listesi (ASLA yazmaz).</summary>
    private static async Task<WizardResult> CalendarPlanStepAsync(
        AppConfig cfg, IXurrentAdapter adapter, CalendarFactory calendar,
        JsonObject data, CancellationToken ct)
    {
        var plan = await ToolImpl.PlanFromCalendarAsync(
            cfg, adapter, calendar, Str(data, "personId") ?? "$me", null, cfg.TimeZoneId,
            provider: "auto", null, null, "nearest", ct);

        if (plan.Proposals.Count == 0)
            return Bitti($"{plan.Date} için öneriye dönüşecek gerçek toplantı yok — yazılacak bir şey çıkmadı.");

        // Taslak, sözleşmedeki data.calendarDraft biçimiyle saklanır: {date, entries[]}.
        var entries = new JsonArray();
        foreach (var p in plan.Proposals)
        {
            var row = new JsonObject
            {
                ["targetType"] = p.SuggestedTargetType ?? "time_allocation",
                ["targetId"] = p.SuggestedTargetId ?? "",
                ["minutes"] = p.RoundedMinutes,
            };
            if (!string.IsNullOrEmpty(p.StartedAt)) row["startedAt"] = p.StartedAt;
            var desc = p.MeetingTitle.Length > 80 ? p.MeetingTitle[..80] : p.MeetingTitle;
            if (desc.Length > 0) row["description"] = desc;
            entries.Add(row);
        }
        data["calendarDraft"] = new JsonObject { ["date"] = plan.Date, ["entries"] = entries };

        var sb = new StringBuilder();
        sb.AppendLine($"Takvimden {plan.Proposals.Count} öneri ({plan.Date}, toplam {plan.Totals.ProposedMinutes} dk):");
        for (var i = 0; i < plan.Proposals.Count; i++)
        {
            var p = plan.Proposals[i];
            sb.AppendLine($"  {i + 1}. {p.MeetingTitle} — {p.RawMinutes}→{p.RoundedMinutes} dk → {p.SuggestedTargetLabel ?? "?"}" +
                          (p.NeedsUserDecision ? "  ⚠ eşleşme belirsiz (varsayılan hedef önerildi)" : ""));
        }
        sb.AppendLine();
        sb.Append("Bu tool yapısal olarak YAZMAZ — yazma ancak onaydan sonra, bulk adımında olur.");

        return Ask(cfg, StepCalendarPlan, data, sb.ToString(), CalendarQuestion);
    }

    /// <summary>calendar_plan cevabı: evet → bulk dry-run özeti · 'N hariç' → eleme · hayır → bitti.</summary>
    private static async Task<WizardResult> HandleCalendarPlanAsync(
        AppConfig cfg, IXurrentAdapter adapter, string answer, JsonObject data, CancellationToken ct)
    {
        var draft = data["calendarDraft"]?.AsObject();
        var entries = draft?["entries"]?.AsArray();
        if (draft is null || entries is null || entries.Count == 0)
            return Bitti("Takvim taslağı bulunamadı — sihirbazı baştan başlatın.",
                [new ValidationError("calendarDraft yok", null)]);

        var eleme = Regex.Match(Katla(answer), @"^(\d+)\s*hariç$");
        if (eleme.Success)
        {
            var idx = int.Parse(eleme.Groups[1].Value, CultureInfo.InvariantCulture);
            if (idx < 1 || idx > entries.Count)
            {
                return Ask(cfg, StepCalendarPlan, data,
                    $"{idx} numaralı öneri yok (1-{entries.Count}).", CalendarQuestion);
            }
            entries.RemoveAt(idx - 1);
            if (entries.Count == 0)
                return Bitti("Tüm öneriler elendi — yazılacak kalem kalmadı.");

            var lines = new StringBuilder($"{idx}. öneri elendi. Kalan {entries.Count} kalem:");
            for (var i = 0; i < entries.Count; i++)
            {
                var e = entries[i]!.AsObject();
                lines.Append($"\n  {i + 1}. {Str(e, "description") ?? "?"} — {e["minutes"]!.GetValue<int>()} dk");
            }
            return Ask(cfg, StepCalendarPlan, data, lines.ToString(), CalendarQuestion);
        }

        var karar = ParseYesNo(answer);
        if (karar is null)
        {
            return Ask(cfg, StepCalendarPlan, data,
                $"\"{answer}\" anlaşılamadı — 'evet', 'hayır' ya da 'N hariç' (ör. '3 hariç') bekliyorum.",
                CalendarQuestion);
        }
        if (karar is false) return Bitti("Vazgeçildi — hiçbir şey yazılmadı.");

        // AYNI çekirdek: xurrent_create_time_entries_bulk'un planlama yolu (dry-run).
        var bulk = (await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, adapter, DraftRequests(draft), dryRun: true, stopOnError: false, approved: false, ct)).Value!;

        data["plannedFingerprint"] = WizardStateCodec.PlannedFingerprint(bulk.Planned);

        return Ask(cfg, StepCalendarConfirm, data,
            Narrate.Bulk(bulk) +
            "\n\n⚠ Bulk yazma ATOMİK DEĞİLDİR: GraphQL istek başına 1 mutation kabul eder, " +
            "kısmi başarı mümkündür ve her satır ayrı raporlanır.",
            ConfirmQuestion);
    }

    /// <summary>calendar_confirm cevabı: evet → [write] bulk yaz + geri-oku; hayır → bitti.</summary>
    private static async Task<WizardResult> HandleCalendarConfirmAsync(
        AppConfig cfg, IXurrentAdapter adapter, string answer, JsonObject data, CancellationToken ct)
    {
        var karar = ParseYesNo(answer);
        if (karar is null)
        {
            return Ask(cfg, StepCalendarConfirm, data,
                $"\"{answer}\" anlaşılamadı — 'evet' ya da 'hayır' bekliyorum.", ConfirmQuestion);
        }
        if (karar is false) return Bitti("Vazgeçildi — hiçbir şey yazılmadı.");

        var draft = data["calendarDraft"]?.AsObject();
        if (draft?["entries"]?.AsArray() is not { Count: > 0 })
            return Bitti("Takvim taslağı bulunamadı — sihirbazı baştan başlatın.",
                [new ValidationError("calendarDraft yok", null)]);

        var requests = DraftRequests(draft);

        // Parmak izi: onaylanan bulk plan ile yazılacak plan aynı mı?
        var recheck = (await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, adapter, requests, dryRun: true, stopOnError: false, approved: false, ct)).Value!;
        var fingerprint = WizardStateCodec.PlannedFingerprint(recheck.Planned);
        if (!string.Equals(fingerprint, Str(data, "plannedFingerprint"), StringComparison.Ordinal))
        {
            const string msg =
                "Onaylanan bulk planı ile yazılacak plan AYNI DEĞİL (plannedFingerprint uyuşmadı) — yazma REDDEDİLDİ.";
            return Bitti(msg, [new ValidationError(msg, ["plannedFingerprint"])]);
        }

        var result = (await ToolImpl.CreateTimeEntriesBulkAsync(
            cfg, adapter, requests, dryRun: false, stopOnError: false, approved: true, ct)).Value!;

        var tarih = Str(draft, "date");
        TimeEntryPage? page = null;
        try
        {
            page = await ToolImpl.ListTimeEntriesAsync(
                adapter, Str(data, "personId") ?? "$me", tarih, tarih, null, 100, ct);
        }
        catch (Exception e) when (e is not OperationCanceledException) { /* geri-okuma raporu opsiyoneldir */ }

        var rowErrors = result.Results.SelectMany(r => r.Errors).ToList();

        var sb = new StringBuilder();
        sb.AppendLine(Narrate.Bulk(result));
        sb.AppendLine();
        if (page is not null)
        {
            sb.Append($"GERİ-OKUMA (xurrent_list_time_entries, {tarih}): {page.TimeEntries.Count} kayıt, " +
                      $"toplam {page.TotalMinutes} dk.");
            if (result.Summary.Deduped > 0)
                sb.Append($"\nDEDUP: {result.Summary.Deduped} kalem zaten yazılmıştı — atlandı, çift kayıt OLUŞMADI.");
        }

        // WizardResult.writeResult sözleşmede $defs/WriteResult'tır; bulk sonucu o
        // şekle EŞLENİR (zorunlu alanlar korunur), satır ayrıntısı reply'da yaşar.
        var writeResult = new WriteResult(
            DryRun: result.DryRun,
            Strategy: Validate.NormalizeStrategy(null, cfg, []),
            StrategyExplanation:
                "Takvim dalı: bulk yazım — her kalem kendi planıyla SIRAYLA yürütüldü; satır ayrıntısı reply metnindedir.",
            Planned: result.Planned,
            Warnings:
            [
                "Bulk ATOMİK DEĞİLDİR — kısmi başarı mümkündür.",
                $"özet: istenen={result.Summary.Requested} oluşan={result.Summary.Created} " +
                $"başarısız={result.Summary.Failed} atlanan={result.Summary.Skipped} dedup={result.Summary.Deduped}",
            ],
            TimeEntry: null,
            Errors: rowErrors,
            Deduped: result.Summary.Deduped > 0 && result.Summary.Created == 0);

        return new WizardResult(StepWrite, sb.ToString(), NextQuestion: null, SessionState: null,
            Done: true, WriteResult: writeResult, Errors: rowErrors);
    }

    private static TimeEntryRequest[] DraftRequests(JsonObject draft)
    {
        var date = Str(draft, "date");
        return (draft["entries"]?.AsArray() ?? []).Select(n =>
        {
            var row = n!.AsObject();
            return new TimeEntryRequest
            {
                TargetType = Str(row, "targetType") ?? "time_allocation",
                TargetId = Str(row, "targetId") ?? "",
                Minutes = row["minutes"]?.GetValue<int>() ?? 0,
                Date = date,
                StartedAt = Str(row, "startedAt"),
                Description = Str(row, "description"),
            };
        }).ToArray();
    }

    // ── Sonuç üreticileri ────────────────────────────────────────────────────

    /// <summary>Soru soran (devam eden) yanıt: state imzalanır, adım+veri taşınır.</summary>
    private static WizardResult Ask(
        AppConfig cfg, string step, JsonObject data, string reply, WizardQuestion question)
        => new(step, reply, question, WizardStateCodec.Sign(cfg, step, data),
            Done: false, WriteResult: null, Errors: []);

    /// <summary>Akışı yazmadan bitiren yanıt: done=true iken sessionState ve nextQuestion NULL.</summary>
    private static WizardResult Bitti(string reply, IReadOnlyList<ValidationError>? errors = null)
        => new(StepDone, reply, NextQuestion: null, SessionState: null,
            Done: true, WriteResult: null, Errors: errors ?? []);

    private static TimeEntryRequest RequestFromData(JsonObject data) => new()
    {
        TargetType = Str(data, "targetType") ?? "request",
        TargetId = Str(data, "targetId") ?? "",
        Minutes = data["minutes"]?.GetValue<int>() ?? 0,
        Date = Str(data, "date"),
        StartedAt = Str(data, "startedAt"),
        Description = Str(data, "description"),
        BackdateStrategy = Str(data, "strategy"),
    };

    // ── Cevap ayrıştırma (wizard.md §3 — üç dilde birebir aynı) ──────────────

    /// <summary>
    /// Türkçe küçük-harf katlaması: İ→i, I→ı; gerisi invariant lowercase.
    /// NEDEN özel: "İŞ".ToLowerInvariant() Türkçe i/I ikilisini yanlış katlar.
    /// </summary>
    internal static string Katla(string s)
    {
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s.Trim())
            sb.Append(ch switch { 'İ' => 'i', 'I' => 'ı', _ => char.ToLowerInvariant(ch) });
        return sb.ToString();
    }

    private static readonly string[] EvetSozleri = ["evet", "onay", "onaylıyorum", "tamam", "e"];
    private static readonly string[] HayirSozleri = ["hayır", "iptal", "vazgeç", "h"];

    /// <summary>evet → true, hayır → false, anlaşılamadı → null (§3 onay kümeleri).</summary>
    internal static bool? ParseYesNo(string answer)
    {
        var f = Katla(answer);
        if (EvetSozleri.Contains(f)) return true;
        if (HayirSozleri.Contains(f)) return false;
        return null;
    }

    internal readonly record struct ParsedDuration(int Minutes, bool FromHours, string Raw);

    /// <summary>
    /// Süre ayrıştırma (§3): 'N saat'/'N sa' → N·60 · 'N dk'/'N dakika' → N ·
    /// çıplak sayı → DAKİKA. Ondalık virgül kabul edilir ('1,5 saat' → 90);
    /// ondalık DAKİKA anlamsızdır ve reddedilir.
    /// </summary>
    internal static ParsedDuration? ParseDuration(string answer)
    {
        var m = Regex.Match(Katla(answer), @"^(\d+(?:[.,]\d+)?)\s*(saat|sa|dakika|dk)?$");
        if (!m.Success) return null;

        var sayi = double.Parse(m.Groups[1].Value.Replace(',', '.'), CultureInfo.InvariantCulture);
        if (sayi <= 0) return null;

        if (m.Groups[2].Value is "saat" or "sa")
            return new ParsedDuration((int)Math.Round(sayi * 60, MidpointRounding.AwayFromZero), true, m.Groups[1].Value);

        if (sayi != Math.Floor(sayi)) return null;
        return new ParsedDuration((int)sayi, false, m.Groups[1].Value);
    }

    /// <summary>Seçim çözümü (§3): choice id'si · 1-bazlı sıra numarası · label'ın katlanmış tam eşleşmesi.</summary>
    internal static WizardChoice? MatchChoice(string answer, IReadOnlyList<WizardChoice> choices)
    {
        var raw = answer.Trim();
        if (raw.Length == 0) return null;
        var f = Katla(raw);

        foreach (var c in choices)
            if (string.Equals(c.Id, raw, StringComparison.Ordinal) || Katla(c.Id) == f)
                return c;

        if (Regex.IsMatch(f, @"^\d+$"))
        {
            var idx = int.Parse(f, CultureInfo.InvariantCulture);
            return idx >= 1 && idx <= choices.Count ? choices[idx - 1] : null;
        }

        foreach (var c in choices)
            if (Katla(c.Label) == f)
                return c;

        return null;
    }

    /// <summary>
    /// Serbest metin detay: tarih (bugün/dün/YYYY-MM-DD, YOKSA bugün) + opsiyonel
    /// saat (HH:MM, 24 saat) + kalanı açıklama. Ör. "dün 14:00 VPN bakımı".
    /// </summary>
    internal static (DateOnly Date, TimeOnly? Time, string? Description) ParseDetail(string answer, DateOnly today)
    {
        DateOnly? date = null;
        TimeOnly? time = null;
        var desc = new List<string>();

        foreach (var token in answer.Split([' ', '\t'], StringSplitOptions.RemoveEmptyEntries))
        {
            var f = Katla(token);
            if (date is null && f == "bugün") { date = today; continue; }
            if (date is null && f == "dün") { date = today.AddDays(-1); continue; }
            if (date is null && DateOnly.TryParseExact(f, "yyyy-MM-dd", CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out var dp)) { date = dp; continue; }
            if (time is null && Regex.IsMatch(f, @"^([01]?\d|2[0-3]):[0-5]\d$"))
            {
                time = TimeOnly.ParseExact(f.Length == 4 ? "0" + f : f, "HH:mm", CultureInfo.InvariantCulture);
                continue;
            }
            desc.Add(token);
        }

        return (date ?? today, time, desc.Count > 0 ? string.Join(' ', desc) : null);
    }

    private static string? Str(JsonObject o, string key)
        => o.TryGetPropertyValue(key, out var v) && v is JsonValue jv && jv.TryGetValue<string>(out var s) ? s : null;
}
