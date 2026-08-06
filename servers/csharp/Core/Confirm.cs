using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace XurrentMcp.Core;

/// <summary>
/// İş mantığının ürettiği ONAY TALEBİ.
///
/// ★ Kritik tasarım kuralı: bu nesne onayın NASIL sorulacağını BİLMEZ.
/// v1 adaptörü bunu <c>elicitation/create</c> İSTEĞİNE, v2 adaptörü ise
/// <c>InputRequiredResult</c> SONUCUNA çevirir. Aynı iş mantığı, iki protokol kabuğu.
/// </summary>
public sealed record ConfirmationRequest(
    string Message,
    IReadOnlyDictionary<string, string> Details,
    string FieldName = "onay");

/// <summary>
/// Bir tool çağrısının iki olası sonucundan biri: TAMAMLANDI ya da ONAY GEREKİYOR.
/// C#'ta discriminated union olmadığı için iki alanlı record + fabrika metotları.
/// </summary>
public sealed record ToolOutcome<T>(T? Value, ConfirmationRequest? Confirmation)
{
    public static ToolOutcome<T> Completed(T value) => new(value, null);
    public static ToolOutcome<T> NeedsConfirmation(ConfirmationRequest request) => new(default, request);
}

/// <summary>requestState doğrulamasının sonucu. Başarısızsa <see cref="Reason"/> Türkçe açıklamadır.</summary>
public sealed record RequestStateVerdict(bool Ok, string? Reason)
{
    public static readonly RequestStateVerdict Valid = new(true, null);
    public static RequestStateVerdict Invalid(string reason) => new(false, reason);
}

/// <summary>
/// ★ requestState BİR GÜVENLİK SINIRIDIR.
///
/// Spec bunu açıkça "saldırgan kontrolündeki girdi" olarak tanımlar: sunucu state'ini
/// client'a verip geri alıyoruz. Bizim state'imiz şunu taşır:
/// "kullanıcı X, Request #70248'e 120 dakika yazmayı onayladı".
/// İmzasız bırakılırsa client bunu değiştirip BAŞKA bir ticket'a, BAŞKA bir süre yazdırabilir.
///
/// Bu yüzden blob şu biçimdedir:  base64url(payload) "." base64url(HMAC-SHA256(secret, payload))
///
/// payload içinde:
///   principal   — authenticated person id. Başka principal ile gelen state REDDEDİLİR.
///   exp         — XURRENT_STATE_TTL saniyelik yaşam süresi (varsayılan 300).
///   fingerprint — metod adı + tool argümanlarının SHA-256 özeti.
///                 Farklı bir çağrıya iliştirilen state REDDEDİLİR.
///   nonce       — tek kullanımlık; süreç içi bir sette tutulur.
///
/// Spec'in uyarısı aynen geçerlidir: imza + exp + fingerprint replay penceresini daraltır
/// ve çapraz kullanıcı/çapraz istek kullanımını engeller ama TEK KULLANIMI GARANTİ ETMEZ.
/// Tek kullanım şartsa sunucu tarafında ayrıca zorlanmalıdır — <see cref="_usedNonces"/> tam olarak budur.
/// </summary>
public static class RequestStateCodec
{
    private const int Version = 1;

    /// <summary>Payload'daki amaç ayracı — sihirbaz state'i ("wizard") onay yerine geçemesin.</summary>
    private const string Kind = "confirm";

    // Tek kullanımlık nonce seti. Süreç içidir: sunucu yeniden başlarsa eski state'ler
    // zaten imza doğrulamasından geçemez (secret verilmemişse yeniden üretilir).
    private static readonly ConcurrentDictionary<string, DateTimeOffset> _usedNonces = new();

    /// <summary>Zarf çözümünün olası sonuçları. Türkçe mesajı HER codec kendi üslubuyla üretir.</summary>
    internal enum ZarfSonucu { Gecerli, BicimBozuk, Base64Degil, ImzaGecersiz, JsonDegil }

    /// <summary>Onaylanmış bir çağrı için imzalı state üretir.</summary>
    public static string Sign(AppConfig cfg, string principal, string method, JsonNode? arguments)
    {
        // cfg.Clock üretimde TimeProvider.System'dir; testte sabitlenir ki TTL davranışı
        // gerçek saatin geçmesini BEKLEMEDEN doğrulanabilsin.
        var now = cfg.Clock.GetUtcNow();
        var payload = new JsonObject
        {
            ["v"] = Version,
            ["kind"] = Kind,
            ["principal"] = principal,
            ["method"] = method,
            ["fingerprint"] = Fingerprint(method, arguments),
            ["nonce"] = Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant(),
            ["iat"] = now.ToUnixTimeSeconds(),
            ["exp"] = now.AddSeconds(cfg.StateTtlSeconds).ToUnixTimeSeconds(),
        };

        return ZarfImzala(cfg, payload.ToJsonString(Json.Options));
    }

    /// <summary>
    /// Geri gelen state'i doğrular. HERHANGİ bir kontrol tutmazsa YAZMA YAPILMAZ.
    /// Sıra önemlidir: önce imza (ucuz ve kesin), sonra semantik kontroller.
    /// </summary>
    public static RequestStateVerdict Verify(
        AppConfig cfg, string? blob, string principal, string method, JsonNode? arguments)
    {
        if (string.IsNullOrWhiteSpace(blob))
            return RequestStateVerdict.Invalid("requestState boş geldi.");

        var (payload, zarf) = ZarfCoz(cfg, blob);
        switch (zarf)
        {
            case ZarfSonucu.BicimBozuk:
                return RequestStateVerdict.Invalid("requestState biçimi bozuk (payload.signature bekleniyordu).");
            case ZarfSonucu.Base64Degil:
                return RequestStateVerdict.Invalid("requestState base64url olarak çözülemedi.");
            case ZarfSonucu.ImzaGecersiz:
                return RequestStateVerdict.Invalid(
                    "requestState İMZASI GEÇERSİZ — blob değiştirilmiş ya da başka bir sunucu tarafından üretilmiş.");
            case ZarfSonucu.JsonDegil:
                return RequestStateVerdict.Invalid("requestState içeriği JSON değil.");
        }

        if (payload is null)   // Gecerli sonuçta payload hep doludur; derleyiciye kanıt.
            return RequestStateVerdict.Invalid("requestState içeriği JSON değil.");

        if (payload["v"]?.GetValue<int>() != Version)
            return RequestStateVerdict.Invalid("requestState sürümü desteklenmiyor.");

        // kind ayracı: aynı sırla imzalanmış ama BAŞKA AMAÇLI bir state (örn. sihirbazın
        // sessionState'i) onay yerine geçemez. Alanı hiç taşımayan eski/yabancı üreticiler
        // tolere edilir — zarf ve diğer semantik kontroller onları zaten sınırlar.
        if (payload["kind"] is not null && payload["kind"]!.GetValue<string>() != Kind)
            return RequestStateVerdict.Invalid(
                "requestState BAŞKA BİR AMAÇLA üretilmiş (kind uyuşmuyor) — onay yerine geçemez.");

        var now = cfg.Clock.GetUtcNow();
        var exp = payload["exp"]?.GetValue<long>() ?? 0;
        if (now.ToUnixTimeSeconds() > exp)
            return RequestStateVerdict.Invalid(
                $"requestState SÜRESİ DOLDU (TTL {cfg.StateTtlSeconds} sn). Onay akışı baştan başlatılmalıdır.");

        if (payload["principal"]?.GetValue<string>() != principal)
            return RequestStateVerdict.Invalid(
                "requestState BAŞKA BİR KULLANICIYA ait — çapraz kullanıcı onayı kabul edilmez.");

        if (payload["method"]?.GetValue<string>() != method)
            return RequestStateVerdict.Invalid(
                "requestState BAŞKA BİR METODA ait — başka bir çağrının onayı buraya iliştirilemez.");

        if (payload["fingerprint"]?.GetValue<string>() != Fingerprint(method, arguments))
            return RequestStateVerdict.Invalid(
                "requestState ARGÜMANLARLA UYUŞMUYOR — onaydan sonra çağrının parametreleri değiştirilmiş.");

        var nonce = payload["nonce"]?.GetValue<string>();
        if (string.IsNullOrEmpty(nonce))
            return RequestStateVerdict.Invalid("requestState nonce taşımıyor.");

        PruneNonces(now);
        if (!_usedNonces.TryAdd(nonce, DateTimeOffset.FromUnixTimeSeconds(exp)))
            return RequestStateVerdict.Invalid(
                "requestState ZATEN KULLANILMIŞ — tek kullanımlıktır, tekrar oynatma (replay) kabul edilmez.");

        return RequestStateVerdict.Valid;
    }

    /// <summary>
    /// Metod adı + argümanların özeti. Argümanlar KANONİK sıralanır; JSON anahtar sırası
    /// client'tan client'a değişebilir ve sıraya duyarlı bir özet yanlış yere "uyuşmuyor" der.
    /// </summary>
    private static string Fingerprint(string method, JsonNode? arguments)
    {
        var canonical = method + "\n" + Canonicalize(arguments);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    // internal: WizardStateCodec ve plannedFingerprint aynı kanonikleştirmeyi kullanır —
    // JSON anahtar sırası dile/istemciye göre değişebilir, sıraya duyarlı özet yanlıştır.
    internal static string Canonicalize(JsonNode? node) => node switch
    {
        null => "null",
        JsonObject o => "{" + string.Join(",", o
            .OrderBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => JsonSerializer.Serialize(kv.Key, Json.Options) + ":" + Canonicalize(kv.Value))) + "}",
        JsonArray a => "[" + string.Join(",", a.Select(Canonicalize)) + "]",
        _ => node.ToJsonString(Json.Options),
    };

    // ── Paylaşılan ZARF: base64url(payloadJson) "." base64url(HMAC-SHA256(secret, payloadJsonBytes)) ──
    //
    // ★ ÇAPRAZ-DİL SÖZLEŞMESİ (fixtures/state-vektorleri.json): requestState ve
    // wizard sessionState AYNI zarfı kullanır; imza HAM payload byte'ları üzerindedir
    // ve parse edilmeden ÖNCE doğrulanır. Kanonikleştirme YOKTUR — başka bir dilin
    // ürettiği byte dizisi (anahtar sırası ne olursa olsun) aynen doğrulanır.
    // Paralel altyapı ölçümü "TS'in ürettiği requestState'i C# çözemedi" bulmuştu;
    // bu zarfın TEK yerde yaşaması o sapmanın bir daha oluşmamasının güvencesidir.

    /// <summary>Verilen payload JSON DİZGESİNİ olduğu gibi (yeniden serileştirmeden) imzalar.</summary>
    internal static string ZarfImzala(AppConfig cfg, string payloadJson)
    {
        var bytes = Encoding.UTF8.GetBytes(payloadJson);
        return Base64Url(bytes) + "." + Base64Url(Hmac(cfg, bytes));
    }

    /// <summary>
    /// Zarfı çözer: biçim → base64url → İMZA (ham byte'lar, sabit zamanlı) → JSON parse.
    /// Semantik kontroller (kind/exp/principal/...) her codec'in kendisindedir.
    /// </summary>
    internal static (JsonObject? Payload, ZarfSonucu Sonuc) ZarfCoz(AppConfig cfg, string blob)
    {
        var dot = blob.IndexOf('.');
        if (dot <= 0 || dot == blob.Length - 1)
            return (null, ZarfSonucu.BicimBozuk);

        byte[] payloadBytes, signature;
        try
        {
            payloadBytes = FromBase64Url(blob[..dot]);
            signature = FromBase64Url(blob[(dot + 1)..]);
        }
        catch (FormatException)
        {
            return (null, ZarfSonucu.Base64Degil);
        }

        // Sabit zamanlı karşılaştırma: imza doğrulamasında erken çıkış zamanlama sızdırır.
        if (!CryptographicOperations.FixedTimeEquals(signature, Hmac(cfg, payloadBytes)))
            return (null, ZarfSonucu.ImzaGecersiz);

        try
        {
            return (JsonNode.Parse(Encoding.UTF8.GetString(payloadBytes))!.AsObject(), ZarfSonucu.Gecerli);
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or NullReferenceException)
        {
            return (null, ZarfSonucu.JsonDegil);
        }
    }

    // Sır UTF-8 byte'larıyla anahtarlanır — üç dil de aynı türetmeyi kullanır.
    internal static byte[] Hmac(AppConfig cfg, byte[] payload)
        => HMACSHA256.HashData(Encoding.UTF8.GetBytes(cfg.StateSecret), payload);

    /// <summary>Süresi dolmuş nonce'lar sette birikmesin — uzun süren sunucuda sessiz sızıntı olurdu.</summary>
    private static void PruneNonces(DateTimeOffset now)
    {
        if (_usedNonces.Count < 1024) return;
        foreach (var (k, expiry) in _usedNonces)
            if (expiry < now)
                _usedNonces.TryRemove(k, out _);
    }

    internal static string Base64Url(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    internal static byte[] FromBase64Url(string text)
    {
        var s = text.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}
