using System.Text.Json.Nodes;

namespace XurrentMcp.Xurrent;

public sealed record ListOpenWorkArgs(
    string PersonId,
    IReadOnlyList<string> Include,
    int First,
    string? AfterRequests,
    string? AfterTasks,
    string View);

/// <summary>xurrent_list_time_entries girdisi. Tarih aralığı DAHİLDİR (from ≤ date ≤ to).</summary>
public sealed record ListTimeEntriesArgs(
    string PersonId,
    string? DateFrom,
    string? DateTo,
    string? SourceId,
    int First);

/// <summary>Bir mutation'ın sonucu. Xurrent doğrulama hatalarını HTTP 200 + errors[] ile döner.
/// Warnings: adaptörün YÜRÜTME sırasında ürettiği, kullanıcıya görünmesi gereken notlar
/// (ör. REST Yol B'de description'ın note'a düşürülmesi) — Strategies bunları tool
/// çıktısındaki warnings listesine ekler. Null/boş = uyarı yok.</summary>
public sealed record MutationOutcome(JsonObject? TimeEntry, IReadOnlyList<ValidationError> Errors,
    IReadOnlyList<string>? Warnings = null)
{
    public bool Ok => Errors.Count == 0;
    public static MutationOutcome Fail(string message, params string[] path)
        => new(null, [new ValidationError(message, path.Length == 0 ? null : path)]);
}

/// <summary>
/// Xurrent erişim katmanı. İki implementasyon var:
///   MockAdapter — fixtures/ klasörünü okur, yazmalar bellekte tutulur.
///   LiveAdapter — gerçek GraphQL API'sine bağlanır.
/// Tool katmanı hangisiyle konuştuğunu BİLMEZ; ders bunu kasıtlı olarak vurgular.
/// </summary>
public interface IXurrentAdapter
{
    /// <summary>"mock" | "live"</summary>
    string Mode { get; }

    Task<WhoAmIResult> WhoAmIAsync(CancellationToken ct);

    Task<FindPersonResult> FindPersonAsync(string email, string view, CancellationToken ct);

    Task<ListOpenWorkResult> ListOpenWorkAsync(ListOpenWorkArgs args, CancellationToken ct);

    /// <summary>Session içinde cache'lenir — yazma öncesi ZORUNLU bağlam.</summary>
    Task<TimeTrackingContext> GetTimeTrackingContextAsync(string personId, CancellationToken ct);

    /// <summary>'$me' özel değerini gerçek node ID'ye çevirir.</summary>
    Task<string> ResolvePersonIdAsync(string personId, CancellationToken ct);

    /// <summary>Hedef kaydın insan-okunur etiketi (uyarı metinlerinde kullanılır).</summary>
    Task<string?> ResolveTargetLabelAsync(string targetType, string targetId, CancellationToken ct);

    /// <summary>allowWorkdayOvertime=false kontrolü için: kişinin o gün YAZILMIŞ toplam dakikası.</summary>
    Task<int> GetLoggedMinutesAsync(string personId, DateOnly date, CancellationToken ct);

    /// <summary>
    /// Dedup geri-okuması (contract/reliability.md §5): deterministik sourceID ile
    /// mevcut TimeEntry'yi arar; yoksa null. İKİ yerde kullanılır:
    ///   1) yazma ÖNCESİ dedup (Strategies.RunAsync — mock'ta da live'da da çalışır),
    ///   2) guarded_create'in belirsiz-hata geri-okuması (LiveAdapter).
    /// </summary>
    Task<JsonObject?> FindTimeEntryBySourceIdAsync(string sourceId, CancellationToken ct);

    /// <summary>
    /// Yazılmış zaman girişlerini okur (xurrent_list_time_entries). Geri-okuma
    /// doğrulamasının ve dedup'ın resmî gözü: "gerçekten yazıldı mı, kaç kez yazıldı?"
    /// Mock'ta bellek içi store filtrelenir; live'da TEK timeEntries sorgusu gider.
    /// </summary>
    Task<TimeEntryPage> ListTimeEntriesAsync(ListTimeEntriesArgs args, CancellationToken ct);

    /// <summary>Planlanmış TEK bir mutation'ı çalıştırır. Bulk = N kez sıralı çağrı.</summary>
    Task<MutationOutcome> ExecuteAsync(PlannedMutation step, CancellationToken ct);
}
