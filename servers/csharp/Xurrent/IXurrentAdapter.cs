using System.Text.Json.Nodes;

namespace XurrentMcp.Xurrent;

public sealed record ListOpenWorkArgs(
    string PersonId,
    IReadOnlyList<string> Include,
    int First,
    string? AfterRequests,
    string? AfterTasks,
    string View);

/// <summary>Bir mutation'ın sonucu. Xurrent doğrulama hatalarını HTTP 200 + errors[] ile döner.</summary>
public sealed record MutationOutcome(JsonObject? TimeEntry, IReadOnlyList<ValidationError> Errors)
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

    /// <summary>Planlanmış TEK bir mutation'ı çalıştırır. Bulk = N kez sıralı çağrı.</summary>
    Task<MutationOutcome> ExecuteAsync(PlannedMutation step, CancellationToken ct);
}
