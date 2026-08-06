using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace XurrentMcp.Core;

/// <summary>Doğrulama sonucu: geçerli payload YA DA nazik-yeniden-başlama gerekçesi.</summary>
public sealed record WizardStateVerdict(JsonObject? Payload, string? RestartReason)
{
    public bool Ok => Payload is not null;
    public static WizardStateVerdict Valid(JsonObject payload) => new(payload, null);
    public static WizardStateVerdict Restart(string reason) => new(null, reason);
}

/// <summary>
/// ★ timesheet_wizard sessionState codec'i (contract/wizard.md §4).
///
/// Wire biçimi requestState ile ARTIK BİREBİR AYNIDIR — iki codec de
/// RequestStateCodec'teki paylaşılan ZARFI (ZarfImzala/ZarfCoz) kullanır; ayrışan
/// yalnız AMAÇ ve payload'dır: {"v":1,"kind":"wizard","step":"...","exp":&lt;epoch sn&gt;,"data":{...}}.
/// Çapraz-dil sözleşmesi fixtures/state-vektorleri.json ile sabitlenmiştir.
///
/// Kritik kurallar:
///   • HMAC, payload BYTE'ları üzerinde hesaplanır — kanonikleştirme GEREKMEZ.
///     Doğrulayan taraf parse etmeden ÖNCE byte'ları imzalar. Bu sayede çapraz-dil
///     devir çalışır: TS'in ürettiği state C#'a verilebilir (aynı XURRENT_STATE_SECRET).
///   • Doğrulama İMZA ÖNCE yapılır (ucuz ve kesin), semantik kontroller sonra.
///   • Nonce YOK: state her adımda geri döner, tek-kullanımlık değildir; write adımının
///     kendisi confirm + plannedFingerprint korumasındadır.
///   • Süresi geçmiş / bozuk state = NAZİK yeniden başlama, sessiz sıfırlama YOK —
///     RestartReason her zaman kullanıcıya söylenecek Türkçe bir cümledir.
/// </summary>
public static class WizardStateCodec
{
    private const int Version = 1;
    private const string Kind = "wizard";

    /// <summary>Adım + veri için imzalı state üretir. exp = şimdi + XURRENT_WIZARD_TTL.</summary>
    public static string Sign(AppConfig cfg, string step, JsonObject data)
    {
        var payload = new JsonObject
        {
            ["v"] = Version,
            ["kind"] = Kind,
            ["step"] = step,
            ["exp"] = cfg.Clock.GetUtcNow().ToUnixTimeSeconds() + cfg.WizardTtlSeconds,
            ["data"] = data.DeepClone(),
        };

        return RequestStateCodec.ZarfImzala(cfg, payload.ToJsonString(Json.Options));
    }

    /// <summary>
    /// Geri gelen state'i doğrular. Herhangi bir kontrol tutmazsa akış start'tan
    /// başlar ve gerekçe AÇIKÇA söylenir (WizardStateVerdict.RestartReason).
    ///
    /// ★ Zarf çözümü RequestStateCodec.ZarfCoz ile ORTAKTIR: imza önce, ham
    /// byte'lar üzerinde — parse edilmeden. Kanonikleştirme yok; başka bir dilin
    /// ürettiği byte dizisi de aynen doğrulanır (çapraz-dil devir).
    /// </summary>
    public static WizardStateVerdict Verify(AppConfig cfg, string blob)
    {
        var (payload, zarf) = RequestStateCodec.ZarfCoz(cfg, blob);
        switch (zarf)
        {
            case RequestStateCodec.ZarfSonucu.BicimBozuk:
                return WizardStateVerdict.Restart(
                    "Oturum durumu (sessionState) beklenen biçimde değil (payload.signature bekleniyordu).");
            case RequestStateCodec.ZarfSonucu.Base64Degil:
                return WizardStateVerdict.Restart("Oturum durumu base64url olarak çözülemedi.");
            case RequestStateCodec.ZarfSonucu.ImzaGecersiz:
                return WizardStateVerdict.Restart(
                    "Oturum durumunun İMZASI GEÇERSİZ — state değiştirilmiş ya da başka bir anahtarla üretilmiş.");
            case RequestStateCodec.ZarfSonucu.JsonDegil:
                return WizardStateVerdict.Restart("Oturum durumunun içeriği geçerli JSON değil.");
        }

        if (payload is null)   // Gecerli sonuçta payload hep doludur; derleyiciye kanıt.
            return WizardStateVerdict.Restart("Oturum durumunun içeriği geçerli JSON değil.");

        if (payload["v"]?.GetValue<int>() != Version || payload["kind"]?.GetValue<string>() != Kind)
            return WizardStateVerdict.Restart("Oturum durumu bu sihirbaza ait değil (v/kind uyuşmuyor).");

        var exp = payload["exp"]?.GetValue<long>() ?? 0;
        if (cfg.Clock.GetUtcNow().ToUnixTimeSeconds() > exp)
            return WizardStateVerdict.Restart(
                $"Oturumun süresi dolmuş (XURRENT_WIZARD_TTL={cfg.WizardTtlSeconds} sn).");

        if (payload["step"]?.GetValue<string>() is not { Length: > 0 })
            return WizardStateVerdict.Restart("Oturum durumu adım bilgisi taşımıyor.");

        return WizardStateVerdict.Valid(payload);
    }

    /// <summary>
    /// plannedFingerprint (contract/wizard.md §4): confirm adımında gösterilen planın
    /// sha256 kısaltması. write adımı bunu YENİDEN hesaplar; eşleşmezse YAZMAZ —
    /// onaylanandan farklı bir planın yazdırılması girişimi böyle kapanır.
    ///
    /// Kanonik biçim: planlanan mutation'ların [{path, input}] dizisi, anahtarlar
    /// sıralı (RequestStateCodec.Canonicalize). mutation metni ve warnings HARİÇ —
    /// onlar görüntü artefaktıdır, yazılacak şeyin kimliği path + input'tur.
    /// </summary>
    public static string PlannedFingerprint(IEnumerable<PlannedMutation> planned)
    {
        var arr = new JsonArray();
        foreach (var p in planned)
            arr.Add(new JsonObject { ["path"] = p.Path, ["input"] = p.Input.DeepClone() });

        var canonical = RequestStateCodec.Canonicalize(arr);
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexString(hash)[..16].ToLowerInvariant();
    }
}
