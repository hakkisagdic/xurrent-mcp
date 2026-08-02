using System.Text.RegularExpressions;

namespace XurrentMcp.Xurrent;

/// <summary>
/// Yazma öncesi ÖN KONTROLLER.
/// Amaç: Xurrent'a gitmeden önce yakalanabilecek her hatayı dry-run'da göstermek.
/// Buradaki kuralların tamamı gerçek API kısıtlarından türetilmiştir.
/// </summary>
public static class Validate
{
    // startedAt sözleşmede OFFSET ZORUNLU. "2026-08-01T14:00:00" gibi çıplak bir değer
    // sunucunun yerel saati sanılır ve sessizce yanlış ana yazılır.
    private static readonly Regex OffsetRequired =
        new(@"(Z|[+\-]\d{2}:?\d{2})$", RegexOptions.Compiled);

    public static void TimeEntry(
        AppConfig cfg,
        TimeTrackingContext ctx,
        TimeEntryRequest req,
        bool isPathA,
        string effectiveTargetId,
        DateOnly effectiveDate,
        DateOnly today,
        int alreadyLoggedMinutes,
        List<ValidationError> errors,
        List<string> warnings)
    {
        // ── Süre ────────────────────────────────────────────────────────────
        if (req.Minutes == 0)
            errors.Add(new ValidationError("Süre 0 dakika olamaz.", ["minutes"]));

        if (req.Minutes < 0 && !req.Correction)
            errors.Add(new ValidationError(
                "Negatif süre yalnızca correction=true ile yazılabilir (düzeltme kaydı).", ["minutes"]));

        // NEDEN: timeIncrement hem MİNİMUM hem ADIM'dır. Katı olmayan değer sunucuda
        // sessizce reddedilir; entegrasyonlardaki en yaygın hata budur.
        var inc = ctx.TimeIncrement ?? 60;
        if (inc > 0 && Math.Abs(req.Minutes) % inc != 0)
        {
            var down = Math.Abs(req.Minutes) / inc * inc;
            var up = down + inc;
            errors.Add(new ValidationError(
                $"Süre {req.Minutes} dakika, ancak bu hesabın timeIncrement değeri {inc} dakika. " +
                $"Girilebilecek en yakın değerler: {down} veya {up}.", ["minutes"]));
        }

        // ── Tarih ───────────────────────────────────────────────────────────
        if (effectiveDate > today)
            errors.Add(new ValidationError(
                $"Gelecek tarihe zaman yazılamaz: {effectiveDate:yyyy-MM-dd}.", ["date"]));

        var backDays = today.DayNumber - effectiveDate.DayNumber;
        if (backDays > cfg.MaxBackdateDays)
            errors.Add(new ValidationError(
                $"{effectiveDate:yyyy-MM-dd} tarihi, izin verilen en eski tarihten önce. " +
                $"XURRENT_MAX_BACKDATE_DAYS={cfg.MaxBackdateDays} (en fazla T-{cfg.MaxBackdateDays}).", ["date"]));

        if (!string.IsNullOrWhiteSpace(req.StartedAt) && !OffsetRequired.IsMatch(req.StartedAt))
            errors.Add(new ValidationError(
                "startedAt değerinde saat dilimi offset'i ZORUNLUDUR (örn. 2026-08-01T14:00:00+03:00). " +
                "Çıplak timestamp sunucunun yerel saati sanılır.", ["startedAt"]));

        // ── Açıklama / not ──────────────────────────────────────────────────
        if (req.Description is { Length: > 80 })
            errors.Add(new ValidationError(
                $"description en fazla 80 karakter olabilir (şu an {req.Description.Length}).", ["description"]));

        if (ctx.RequireTimeEntryDescription == true && string.IsNullOrWhiteSpace(req.Description))
            errors.Add(new ValidationError(
                "Bu hesapta zaman girişi açıklaması ZORUNLUDUR (requireTimeEntryDescription=true).", ["description"]));

        if (ctx.RequireNote == true && !isPathA && string.IsNullOrWhiteSpace(req.Note))
            errors.Add(new ValidationError(
                "Bu hesapta not ZORUNLUDUR (requireNote=true).", ["note"]));

        // ── Yol anahtarları ─────────────────────────────────────────────────
        if (isPathA && ctx.AllocationTimeTracking == false)
            errors.Add(new ValidationError(
                "Bu hesapta allocationTimeTracking=false — Yol A (timeEntryCreate) TAMAMEN kapalıdır. " +
                "date_first stratejisi kullanılamaz.", ["targetType"]));

        if (!isPathA && ctx.AssignmentTimeTracking == false)
            errors.Add(new ValidationError(
                "Bu hesapta assignmentTimeTracking=false — Yol B (requestUpdate/taskUpdate) TAMAMEN kapalıdır. " +
                "link_first ve two_step stratejileri kullanılamaz.", ["targetType"]));

        // ── TimeAllocation'a özel kural ─────────────────────────────────────
        if (isPathA)
        {
            var alloc = ctx.TimeAllocations.FirstOrDefault(a => a.Id == effectiveTargetId);
            if (alloc is null)
                warnings.Add($"'{effectiveTargetId}' bu kişinin seçebileceği TimeAllocation listesinde bulunamadı. " +
                             "Yalnızca kişinin KENDİ organizasyonuna bağlı allocation'lar seçilebilir.");
            else if (alloc.DescriptionRequired == true && string.IsNullOrWhiteSpace(req.Description))
                errors.Add(new ValidationError(
                    $"'{alloc.Name}' allocation'ı için açıklama ZORUNLUDUR (descriptionRequired=true).", ["description"]));
        }

        // ── Günlük mesai sınırı ─────────────────────────────────────────────
        // NEDEN: allowWorkdayOvertime=false iken günlük toplamı aşan yazma REDDEDİLİR.
        var workday = ctx.Workday ?? 480;
        if (ctx.AllowWorkdayOvertime == false && req.Minutes > 0)
        {
            var projected = alreadyLoggedMinutes + req.Minutes;
            if (projected > workday)
                errors.Add(new ValidationError(
                    $"{effectiveDate:yyyy-MM-dd} günü için toplam {projected} dakika olurdu; " +
                    $"günlük sınır {workday} dakika ve bu hesapta fazla mesai KAPALI (allowWorkdayOvertime=false). " +
                    $"O gün hâlihazırda {alreadyLoggedMinutes} dakika yazılmış.", ["minutes"]));
            else if (projected > workday * 0.9)
                warnings.Add($"Bu giriş sonrası günlük toplam {projected}/{workday} dakika olacak — sınıra yaklaşıldı.");
        }

        // ── Effort class ────────────────────────────────────────────────────
        // NEDEN uyarı: costMultiplier faturalamayı doğrudan etkiler. Bot varsayılana
        // sessizce güvenmek yerine ne seçtiğini SÖYLER.
        if (!string.IsNullOrWhiteSpace(req.EffortClassId) &&
            ctx.EffortClasses.All(e => e.Id != req.EffortClassId))
        {
            warnings.Add($"Seçilen effortClassId ('{req.EffortClassId}') aktif effort class listesinde yok. " +
                         "Devre dışı bırakılmış bir sınıf olabilir.");
        }
    }

    /// <summary>Strateji adını doğrular; bilinmeyen değeri env varsayılanına düşürür.</summary>
    public static string NormalizeStrategy(string? requested, AppConfig cfg, List<string> warnings)
    {
        var value = string.IsNullOrWhiteSpace(requested) ? cfg.BackdateStrategy : requested;
        if (value is "two_step" or "link_first" or "date_first") return value;

        warnings.Add($"Bilinmeyen backdateStrategy '{value}' — '{cfg.BackdateStrategy}' varsayılanına düşüldü.");
        return cfg.BackdateStrategy is "two_step" or "link_first" or "date_first" ? cfg.BackdateStrategy : "two_step";
    }
}
