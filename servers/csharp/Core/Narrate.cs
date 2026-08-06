using System.Text;

namespace XurrentMcp.Core;

/// <summary>
/// K2'nin ikinci yarısı: her tool HEM structuredContent (makine için) HEM okunabilir
/// bir TÜRKÇE metin bloğu yayınlar.
///
/// NEDEN ikisi birden: MCP client'ların bir kısmı structured çıktıyı hiç göstermez,
/// LLM'ler ise düz metni daha güvenilir yorumlar. İkisi "aynı gerçeğin iki sunumu"dur —
/// ekstra iş değil, sözleşmenin parçası.
/// </summary>
public static class Narrate
{
    /// <summary>Dakikayı insan diline çevirir: 135 → "2 sa 15 dk".</summary>
    public static string HumanMinutes(int minutes)
    {
        var sign = minutes < 0 ? "-" : "";
        var abs = Math.Abs(minutes);
        var (h, m) = (abs / 60, abs % 60);
        if (h == 0) return $"{sign}{m} dk";
        if (m == 0) return $"{sign}{h} sa";
        return $"{sign}{h} sa {m} dk";
    }

    public static string WhoAmI(WhoAmIResult r)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Kimlik: {r.Person.Name ?? "(isimsiz)"} <{r.Person.PrimaryEmail ?? "-"}>");
        sb.AppendLine($"  görev: {r.Person.JobTitle ?? "-"} · saat dilimi: {r.Person.TimeZone ?? "-"}");
        sb.AppendLine($"  person.id: {r.Person.Id}   (OPAK — asla elle üretilmez)");
        sb.AppendLine($"Hesap: {r.Account.Name ?? r.Account.Id} ({r.Account.Id})");
        sb.AppendLine($"Mod: {r.Mode}");
        sb.Append(r.RateLimit is null
            // K4 — mock modda rate limit YOKTUR. Gerçek zaman damgası koymak çıktıyı
            // deterministik olmaktan çıkarır; üç dilin aynı sonucu üretmesi şarttır.
            ? "Rate limit: mock modda rate limit yok (alan null döner)."
            : $"Rate limit: {r.RateLimit.Remaining}/{r.RateLimit.Limit} kaldı, bu sorgunun maliyeti {r.RateLimit.Cost}.");
        return sb.ToString();
    }

    public static string FindPerson(FindPersonResult r, string email)
    {
        if (r.TotalCount == 0)
            return $"'{email}' ile TAM eşleşen kişi bulunamadı.\n" +
                   "Xurrent PersonFilter.primaryEmail bir TextFilter'dır — substring araması YAPMAZ.\n" +
                   "suggestFuzzy=true: serbest metin arama denenmelidir.";

        var sb = new StringBuilder($"{r.TotalCount} kişi bulundu:\n");
        foreach (var p in r.People)
            sb.AppendLine($"  • {p.Name ?? "(isimsiz)"} <{p.PrimaryEmail ?? "-"}> · id: {p.Id}");
        return sb.ToString();
    }

    public static string ListOpenWork(ListOpenWorkResult r)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Hesap: {r.AccountId}");
        sb.AppendLine();
        sb.AppendLine($"AÇIK REQUEST'LER ({r.Requests.TotalCount})");
        sb.Append(RenderItems(r.Requests.Nodes));
        sb.AppendLine();
        sb.AppendLine($"AÇIK TASK'LAR ({r.Tasks.TotalCount})");
        sb.Append(RenderItems(r.Tasks.Nodes));
        sb.AppendLine();
        sb.AppendLine("Not: Kapalı kayıtlar listede YOKTUR. Request'te tek terminal durum 'completed'tir;");
        sb.Append("Task'ta beş tanedir (completed, approved, failed, rejected, canceled) — 'approved' bir task da KAPALIDIR.");
        return sb.ToString();
    }

    private static string RenderItems(IReadOnlyList<WorkItem> items)
    {
        if (items.Count == 0) return "  (yok)\n";
        var sb = new StringBuilder();
        foreach (var w in items)
        {
            var meta = new[]
                {
                    w.StatusLabel ?? w.Status ?? "-",
                    w.Team is null ? null : $"ekip: {w.Team}",
                    w.ParentLabel is null ? null : $"bağlam: {w.ParentLabel}",
                    w.TargetAt is null ? null : $"hedef: {w.TargetAt[..Math.Min(10, w.TargetAt.Length)]}",
                }
                .Where(x => x is not null);
            sb.AppendLine($"  • #{w.DisplayId} — {w.Subject ?? "(konusuz)"}");
            sb.AppendLine($"    {string.Join(" | ", meta)}");
            sb.AppendLine($"    id: {w.Id}");
        }
        return sb.ToString();
    }

    public static string TimeTrackingContext(TimeTrackingContext c)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"timeIncrement: {c.TimeIncrement} dakika — SÜRELER BUNUN KATI OLMAK ZORUNDADIR.");
        sb.AppendLine($"Birim: {c.Unit ?? "minute"} · iş günü: {c.Workday} dk · iş haftası: {c.Workweek} dk");
        sb.AppendLine($"Yol A (time_allocation) açık mı: {Yes(c.AllocationTimeTracking)} · " +
                      $"Yol B (ticket) açık mı: {Yes(c.AssignmentTimeTracking)}");
        sb.AppendLine($"Açıklama zorunlu mu: {Yes(c.RequireTimeEntryDescription)} · Not zorunlu mu: {Yes(c.RequireNote)}");
        sb.AppendLine();
        sb.AppendLine($"EFFORT CLASS'LAR ({c.EffortClasses.Count}) — disabled olanlar CLIENT tarafında elendi:");
        foreach (var e in c.EffortClasses)
            sb.AppendLine($"  • {e.Name} (çarpan {e.CostMultiplier?.ToString() ?? "-"}) · id: {e.Id}");
        sb.AppendLine();
        sb.AppendLine($"TIME ALLOCATION'LAR ({c.TimeAllocations.Count}):");
        foreach (var a in c.TimeAllocations)
            sb.AppendLine($"  • {a.Name}{(a.Group is null ? "" : $" [{a.Group}]")} · id: {a.Id}");
        sb.Append("Uyarı: timeIncrement bilinmeden süre SEÇİLEMEZ. 45 dakikalık bir toplantı " +
                  $"{c.TimeIncrement} dakikalık artışa yuvarlanmak zorundadır.");
        return sb.ToString();
    }

    private static string Yes(bool? v) => v is true ? "evet" : v is false ? "HAYIR" : "?";

    public static string Calendar(CalendarResult r)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Pencere: {r.WindowStart} → {r.WindowEnd} ({r.TimeZone}, sağlayıcı: {r.Provider})");
        sb.AppendLine();
        foreach (var m in r.Meetings)
        {
            var mark = m.Skipped ? "✗" : "•";
            sb.AppendLine($"  {mark} {m.Start[11..16]}–{m.End[11..16]}  {m.Title}  ({HumanMinutes(m.Minutes)})");
            if (m.Skipped) sb.AppendLine($"      ELENDİ: {m.SkipReason}");
        }
        sb.AppendLine();
        sb.AppendLine($"Ham etkinlik: {r.Totals.RawCount} · gerçek toplantı: {r.Totals.Count} · elenen: {r.Totals.FilteredOut}");
        sb.Append($"Meşgul süre: {HumanMinutes(r.Totals.BusyMinutes)} (çakışmalar BİR KEZ sayıldı) · " +
                  $"naif toplam: {HumanMinutes(r.Totals.NaiveSumMinutes)}. " +
                  "Aradaki fark çakışan toplantılardan gelir.");
        return sb.ToString();
    }

    public static string Plan(PlanResult r)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"{r.Date} için {r.Proposals.Count} ÖNERİ (timeIncrement {r.TimeIncrement} dk).");
        sb.AppendLine("Bu tool YAPISAL OLARAK yazamaz — yalnızca öneri üretir.");
        sb.AppendLine();
        foreach (var p in r.Proposals)
        {
            sb.AppendLine($"  • {p.MeetingTitle} — {p.RawMinutes} dk → {p.RoundedMinutes} dk");
            sb.AppendLine($"    hedef: {p.SuggestedTargetType} · {p.SuggestedTargetLabel}");
            sb.AppendLine($"    gerekçe: {p.MatchReason}");
            if (p.NeedsUserDecision) sb.AppendLine("    ⚠ KULLANICI KARARI GEREKİYOR — bot tahmin etmemelidir.");
            foreach (var w in p.Warnings) sb.AppendLine($"    ⚠ {w}");
        }
        sb.AppendLine();
        sb.Append($"Toplam: toplantı {HumanMinutes(r.Totals.MeetingMinutes)} → önerilen {HumanMinutes(r.Totals.ProposedMinutes)}. " +
                  $"Eşleşmeyen toplantı sayısı: {r.UnmatchedMeetings.Count}.");
        return sb.ToString();
    }

    public static string TimeEntries(TimeEntryPage r)
    {
        var sb = new StringBuilder();
        sb.AppendLine($"Hesap: {r.AccountId} · {r.TimeEntries.Count} zaman girişi · toplam {HumanMinutes(r.TotalMinutes)}");
        if (r.TimeEntries.Count == 0)
        {
            sb.Append("Filtreye uyan kayıt yok. Yazma raporuna güvenmek yerine geri-okuma yapan taraf " +
                      "için bu da bir CEVAPTIR: 'yazılmamış'.");
            return sb.ToString();
        }
        sb.AppendLine();
        foreach (var e in r.TimeEntries)
        {
            var hedef = e.Assignment is null
                // Yol A kaydı: assignment NULL — ticket'a bağlı DEĞİL (dersin kalbi).
                ? "bağlı ticket YOK (Yol A)"
                : $"{e.Assignment.Type} #{e.Assignment.DisplayId ?? e.Assignment.Id}";
            sb.AppendLine($"  • {e.Date} · {HumanMinutes(e.TimeSpent)} · {e.Description ?? "(açıklamasız)"}");
            sb.AppendLine($"    {hedef}" +
                          (e.Correction == true ? " · DÜZELTME kaydı" : "") +
                          (e.SourceId is null ? "" : $" · sourceID: {e.SourceId}"));
        }
        sb.Append("Not: sourceID, idempotency anahtarıdır — kısmen başarısız bir bulk'tan sonra " +
                  "'hangi kalemler yazılmış' sorusunu bu alan cevaplar (contract/reliability.md §5).");
        return sb.ToString();
    }

    public static string Write(WriteResult r)
    {
        var sb = new StringBuilder();
        sb.AppendLine(r.DryRun
            ? "DRY-RUN — hiçbir mutation gönderilmedi. Aşağıdaki plan YALNIZCA önizlemedir."
            : r.Deduped == true
                ? "DEDUP — yazma ATLANDI: aynı sourceID'li kayıt zaten vardı; mevcut kayıt döndürüldü."
                : "YAZILDI — mutation'lar Xurrent'a gönderildi.");
        sb.AppendLine($"Strateji: {r.Strategy}");
        if (!string.IsNullOrWhiteSpace(r.StrategyExplanation)) sb.AppendLine($"  {r.StrategyExplanation}");
        sb.AppendLine();
        sb.AppendLine($"PLANLANAN MUTATION'LAR ({r.Planned.Count}):");
        foreach (var p in r.Planned)
        {
            sb.AppendLine($"  {p.StepLabel ?? "1/1"} {p.Path}");
            sb.AppendLine($"      input: {p.Input.ToJsonString(Json.Options)}");
            foreach (var w in p.Warnings) sb.AppendLine($"      ⚠ {w}");
        }
        if (r.Warnings.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("UYARILAR:");
            foreach (var w in r.Warnings) sb.AppendLine($"  ⚠ {w}");
        }
        if (r.Errors.Count > 0)
        {
            sb.AppendLine();
            sb.AppendLine("HATALAR — işlem BAŞARISIZ:");
            foreach (var e in r.Errors) sb.AppendLine($"  ✘ {e.Message}");
        }
        else if (!r.DryRun)
        {
            sb.AppendLine();
            sb.Append($"{(r.Deduped == true ? "Mevcut kayıt" : "Oluşan kayıt")}: " +
                      $"{r.TimeEntry?["id"]?.GetValue<string>() ?? "(id dönmedi)"}");
        }
        return sb.ToString().TrimEnd();
    }

    public static string Bulk(BulkResult r)
    {
        var sb = new StringBuilder();
        sb.AppendLine(r.DryRun ? "DRY-RUN — hiçbir satır yazılmadı." : "TOPLU YAZMA tamamlandı.");
        sb.AppendLine($"İstenen {r.Summary.Requested} · oluşan {r.Summary.Created} · " +
                      $"başarısız {r.Summary.Failed} · atlanan {r.Summary.Skipped} · " +
                      $"dedup {r.Summary.Deduped} · toplam {HumanMinutes(r.Summary.TotalMinutes)}");
        sb.AppendLine();
        foreach (var row in r.Results)
        {
            sb.AppendLine($"  [{row.Index}] {row.Status}{(row.TimeEntryId is null ? "" : $" · {row.TimeEntryId}")}");
            foreach (var e in row.Errors) sb.AppendLine($"      ✘ {e.Message}");
        }
        sb.Append("Uyarı: toplu yazma ATOMİK DEĞİLDİR — kısmi başarı normaldir ve geri alınmaz.");
        return sb.ToString();
    }
}
