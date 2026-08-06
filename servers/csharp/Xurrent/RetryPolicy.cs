using Polly;
using Polly.Retry;

namespace XurrentMcp.Xurrent;

/// <summary>
/// ★ Operasyon sınıfları (contract/reliability.md §2).
///
/// Retry TRANSPORTUN değil, OPERASYONUN özelliğidir: aynı HTTP 500, bir okuma
/// sorgusunda güvenle tekrarlanır; bir requestUpdate'te çift sayım üretebilir.
/// Bu enum o farkı tipe döker — string karşılaştırması tek yerde yapılır
/// (LiveAdapter.ClassifyPath), gerisi derleyici güvencesindedir.
/// </summary>
public enum OperationClass
{
    /// <summary>Tüm okuma sorguları. Yan etkisiz → 429 da belirsiz de tekrarlanır.</summary>
    Query,

    /// <summary>
    /// timeEntryCreate. Deterministik sourceID taşır ama Xurrent tarafında unique
    /// kısıtı YOK — kör retry çift kayıt yazabilir. Belirsiz hatada ÖNCE sourceID
    /// geri-okuması yapılır; kayıt yoksa retry, varsa mevcut kayıt BAŞARI sayılır.
    /// </summary>
    GuardedCreate,

    /// <summary>timeEntryUpdate. Mutlak SET'tir (date/startedAt/personId atar) → tekrarı zararsız.</summary>
    IdempotentUpdate,

    /// <summary>
    /// requestUpdate / taskUpdate / projectTaskUpdate / problemUpdate.
    /// timeSpent ARTIMLIDIR ve input idempotency anahtarı kabul etmez →
    /// belirsiz hatada tekrar = çift sayım. YALNIZ 429 tekrarlanır.
    /// </summary>
    NoRetry,
}

/// <summary>
/// Taşıma katmanının TİPLİ hatası: HTTP durum kodu + (varsa) Retry-After.
///
/// NEDEN InvalidOperationException'dan türer: adapterdeki best-effort okumalar
/// (etiket çözme, günlük toplam, takip sorgusu) zaten `catch (InvalidOperationException)`
/// ile korunuyor — bu hata da retry bütçesi bittikten sonra oraya düşmeli, akışı
/// KIRMAMALI. Ayrı bir taban tip her call site'ı güncellemeyi gerektirirdi.
///
/// Sınıflandırma (contract/reliability.md §1):
///   429            → kesin-işlenmedi (her sınıf tekrarlar)
///   5xx / ağ (=0)  → belirsiz (istek İŞLENMİŞ olabilir)
/// 4xx (429 hariç), GraphQL top-level errors ve payload errors bu tipe SARILMAZ —
/// onlar kesin-reddedildi'dir ve düz InvalidOperationException olarak atılır,
/// dolayısıyla hiçbir retry filtresine takılmazlar.
/// </summary>
public sealed class XurrentHttpException(int statusCode, TimeSpan? retryAfter, string message, Exception? inner = null)
    : InvalidOperationException(message, inner)
{
    /// <summary>HTTP durum kodu. 0 = ağ hatası / zaman aşımı (HTTP yanıtı hiç gelmedi).</summary>
    public int StatusCode { get; } = statusCode;

    /// <summary>429 yanıtındaki Retry-After (saniye) — beklemenin ALT SINIRI olur.</summary>
    public TimeSpan? RetryAfter { get; } = retryAfter;

    /// <summary>İz biçimindeki reason alanı: 429 | 5xx | network (reliability.md §6).</summary>
    public string Reason => StatusCode == 429 ? "429" : StatusCode >= 500 ? "5xx" : "network";

    /// <summary>
    /// true = "belirsiz": istek sunucuya ULAŞMIŞ ve İŞLENMİŞ olabilir.
    /// Sözleşmenin bilinçli sadeleştirmesi: TÜM ağ hataları belirsiz sayılır
    /// (ECONNREFUSED ayrımı üç runtimeda güvenilir yapılamıyor — reliability.md §1 notu).
    /// </summary>
    public bool Uncertain => StatusCode != 429;
}

/// <summary>
/// Gözlemlenebilirlik izleri (contract/reliability.md §6). Üç dil BİREBİR aynı satırı
/// basar; senaryo koşucusu politikayı bu satırları SAYARAK doğrular.
///
/// ★ HER ZAMAN stderr — stdout MCP stdio kanalıdır, oraya yazılan tek bayt protokolü bozar.
///
/// AsyncLocal override YALNIZ birim testleri içindir: testler izleri süreç stderr'ini
/// yakalamadan, paralel test sınıflarıyla çakışmadan toplayabilsin diye akış-yerel.
/// </summary>
public static class ReliabilityTrace
{
    private static readonly AsyncLocal<Action<string>?> Override = new();

    public static IDisposable CaptureForTest(Action<string> sink)
    {
        Override.Value = sink;
        return new Resetter();
    }

    private sealed class Resetter : IDisposable
    {
        public void Dispose() => Override.Value = null;
    }

    /// <summary>[retry] izi. attempt = BAŞARISIZ olan deneme, waitMs = bir sonrakinden önceki GERÇEK bekleme.</summary>
    public static void Retry(string op, int attempt, int max, string reason, int waitMs)
        => Write($"[retry] op={op} attempt={attempt}/{max} reason={reason} waitMs={waitMs}");

    /// <summary>[dedup] izi — her dedup KARARI yazılır, sonucu ne olursa olsun.</summary>
    public static void Dedup(string sourceId, bool hit)
        => Write($"[dedup] op=timeEntryCreate sourceID={sourceId} hit={(hit ? "true" : "false")}");

    private static void Write(string line)
    {
        var sink = Override.Value;
        if (sink is not null) sink(line);
        else Console.Error.WriteLine(line);
    }
}

/// <summary>
/// Bekleme politikası + operasyon sınıfı başına Polly pipeline'ları
/// (contract/reliability.md §3, §8 — C# sütunu).
///
/// Politika: toplam deneme N (ilk istek dahil), k'ıncı tekrarın beklemesi
/// TAM JİTTER: rastgele(0, min(CAP, BASE·2^(k-1))); Retry-After varsa bekleme
/// EN AZ o kadardır (max(jitter, retryAfter) — "en az" garantisi esastır).
///
/// GuardedCreate pipeline'ı BİLEREK YOK: belirsiz hatada araya "sourceID geri-okuması"
/// girmek zorunda ve geri-okuma HIT ise sonuç retry değil BAŞARIDIR (mevcut kayıt).
/// Polly'nin OnRetry/predicate kancaları "denemeyi başarıya çevir" akışını taşıyamaz —
/// bu yüzden guarded_create döngüsü LiveAdapter'da ELLE yazılıdır ve buradaki
/// ComputeWait/MaxAttempts'i kullanır. Tek politika, iki uygulama noktası.
/// </summary>
public sealed class RetryPolicy
{
    /// <summary>Polly context'i üzerinden iz satırına taşınan operasyon etiketi (path | "query").</summary>
    private static readonly ResiliencePropertyKey<string> OpKey = new("xurrent.op");

    private readonly int _baseMs;
    private readonly int _capMs;
    private readonly ResiliencePipeline _query;
    private readonly ResiliencePipeline _idempotentUpdate;
    private readonly ResiliencePipeline _noRetry;

    /// <summary>Toplam deneme (ilk istek dahil). 1 = retry kapalı.</summary>
    public int MaxAttempts { get; }

    public RetryPolicy(AppConfig cfg)
    {
        MaxAttempts = Math.Max(1, cfg.RetryMaxAttempts);
        _baseMs = Math.Max(0, cfg.RetryBaseMs);
        _capMs = Math.Max(0, cfg.RetryCapMs);

        _query = Build(OperationClass.Query);
        _idempotentUpdate = Build(OperationClass.IdempotentUpdate);
        _noRetry = Build(OperationClass.NoRetry);
    }

    /// <summary>Sınıfın pipeline'ı içinde çalıştırır; iz etiketi (op) context ile taşınır.</summary>
    public async Task<T> ExecuteAsync<T>(
        OperationClass cls, string op, Func<CancellationToken, Task<T>> action, CancellationToken ct)
    {
        var pipeline = cls switch
        {
            OperationClass.Query => _query,
            OperationClass.IdempotentUpdate => _idempotentUpdate,
            OperationClass.NoRetry => _noRetry,
            // Yukarıdaki sınıf yorumuna bakın: guarded_create elle yazılı döngüdür.
            _ => throw new InvalidOperationException(
                "guarded_create Polly pipeline'ı ile ÇALIŞTIRILMAZ — " +
                "LiveAdapter.ExecuteGuardedCreateAsync elle yazılı döngüyü kullanır."),
        };

        var context = ResilienceContextPool.Shared.Get(ct);
        context.Properties.Set(OpKey, op);
        try
        {
            return await pipeline.ExecuteAsync(
                async c => await action(c.CancellationToken).ConfigureAwait(false), context);
        }
        finally
        {
            ResilienceContextPool.Shared.Return(context);
        }
    }

    /// <summary>
    /// k'ıncı BAŞARISIZ denemeden sonraki bekleme. failedAttempt 1'den başlar.
    /// Tam jitter + Retry-After alt sınırı (reliability.md §3).
    /// </summary>
    public TimeSpan ComputeWait(int failedAttempt, TimeSpan? retryAfter)
        => ComputeWait(failedAttempt, retryAfter, _baseMs, _capMs);

    internal static TimeSpan ComputeWait(int failedAttempt, TimeSpan? retryAfter, int baseMs, int capMs)
    {
        // Tam jitter: sabit üstel bekleme yerine [0, tavan) aralığından rastgele seç.
        // NEDEN: aynı anda düşen N istemci sabit backoff'ta AYNI anda geri döner ve
        // sunucuyu tekrar devirir ("thundering herd"); jitter dönüşleri yayar.
        var ceiling = Math.Min(capMs, baseMs * Math.Pow(2, failedAttempt - 1));
        var wait = TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * ceiling);

        // Retry-After bir ALT SINIRDIR: sunucu "şu kadar bekle" dediyse daha erken dönmek
        // 429'u garantiler. max(jitter, retryAfter) hedeflenen biçimdir.
        if (retryAfter is { } ra && ra > wait) wait = ra;
        return wait;
    }

    /// <summary>
    /// Sınıf filtresi (ShouldHandle): 429 HER sınıfta tekrarlanır (istek işlenmeden
    /// reddedildi); belirsiz (5xx/ağ) yalnız yan etkisiz/idempotent sınıflarda.
    /// Düz InvalidOperationException (4xx, GraphQL errors) buraya HİÇ düşmez —
    /// yalnız XurrentHttpException yakalanır.
    /// </summary>
    private static bool ShouldRetry(OperationClass cls, Exception? ex)
        => ex is XurrentHttpException x
           && (x.StatusCode == 429
               || (x.Uncertain && cls is OperationClass.Query or OperationClass.IdempotentUpdate));

    private ResiliencePipeline Build(OperationClass cls)
    {
        // 1 deneme = retry kapalı: boş pipeline istek tek sefer geçer.
        if (MaxAttempts <= 1) return ResiliencePipeline.Empty;

        return new ResiliencePipelineBuilder()
            .AddRetry(new RetryStrategyOptions
            {
                // Polly "retry" sayar, sözleşme "toplam deneme" sayar: N deneme = N-1 retry.
                MaxRetryAttempts = MaxAttempts - 1,
                ShouldHandle = args => ValueTask.FromResult(ShouldRetry(cls, args.Outcome.Exception)),
                DelayGenerator = args =>
                {
                    // Polly AttemptNumber 0 tabanlı → başarısız deneme k = AttemptNumber + 1.
                    var retryAfter = (args.Outcome.Exception as XurrentHttpException)?.RetryAfter;
                    return new ValueTask<TimeSpan?>(ComputeWait(args.AttemptNumber + 1, retryAfter));
                },
                OnRetry = args =>
                {
                    // İz, GERÇEK beklemeyle yazılır (args.RetryDelay = DelayGenerator'ın kararı).
                    var op = args.Context.Properties.GetValue(OpKey, "query");
                    var reason = (args.Outcome.Exception as XurrentHttpException)?.Reason ?? "network";
                    ReliabilityTrace.Retry(op, args.AttemptNumber + 1, MaxAttempts, reason,
                        (int)args.RetryDelay.TotalMilliseconds);
                    return default;
                },
            })
            .Build();
    }
}
