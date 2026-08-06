using System.Security.Cryptography;
using System.Text;

namespace XurrentMcp.Agent;

/// <summary>
/// HTTP yüzeyinin tek satırlık yol tablosu girdisi (WP6 — uyumlaştırılmış yollar).
/// Session duruşu SÖZLEŞMENİN parçasıdır: v1 uçları SESSIONFUL (initialize el
/// sıkışması Mcp-Session-Id üretir), v2 uçları STATELESS (session başlığı yok).
/// </summary>
public sealed record McpYol(string Yol, string ProtokolSurumu, bool Sessionful);

/// <summary>
/// ★ WP6 — HTTP kapısı ve yol tablosu. İkisi de SAF fonksiyondur ki birim test
/// HTTP ayağa kaldırmadan doğrulayabilsin (Tests/HttpKapiTests).
/// </summary>
public static class HttpKapi
{
    /// <summary>
    /// MCP_API_KEY karşılaştırması — SABİT ZAMANLI.
    ///
    /// NEDEN sabit zamanlı: erken çıkan (ilk farklı bayta kadar okuyan) bir string
    /// karşılaştırması, saldırgana anahtarı bayt bayt "ölçme" imkânı verir (timing
    /// attack). CryptographicOperations.FixedTimeEquals iki diziyi HER ZAMAN sonuna
    /// kadar okur. Uzunluk farkında erken false dönmek yalnız UZUNLUĞU sızdırır —
    /// kabul edilen pratik budur; içerik sızmaz.
    ///
    /// beklenen BOŞSA kapı kapalıdır (anahtar istenmez) — sunucu bu durumda zaten
    /// yalnız loopback'e bağlanır; bu fonksiyon true döner ve akış değişmez.
    /// </summary>
    public static bool AnahtarUygun(string beklenen, string? gelen)
    {
        if (string.IsNullOrEmpty(beklenen)) return true;
        if (string.IsNullOrEmpty(gelen)) return false;

        var b = Encoding.UTF8.GetBytes(beklenen);
        var g = Encoding.UTF8.GetBytes(gelen);
        return b.Length == g.Length && CryptographicOperations.FixedTimeEquals(b, g);
    }

    /// <summary>
    /// Uyumlaştırılmış yol tablosu (üç dil aynı tabloyu servis eder):
    ///   tek dönem      → /mcp                   (o dönemin duruşuyla)
    ///   MCP_PROTOCOL=both → /mcp/v1  2025-11-25  SESSIONFUL
    ///                       /mcp/v2  2026-07-28  STATELESS
    ///                       /mcp     2026-07-28  STATELESS (v2 takma adı)
    /// </summary>
    public static IReadOnlyList<McpYol> YolTablosu(ProtocolChoice protokol) => protokol switch
    {
        ProtocolChoice.V1 => [new McpYol("/mcp", Mcp.ServerSetup.ProtocolV1, Sessionful: true)],
        ProtocolChoice.V2 => [new McpYol("/mcp", Mcp.ServerSetup.ProtocolV2, Sessionful: false)],
        ProtocolChoice.Both =>
        [
            new McpYol("/mcp/v1", Mcp.ServerSetup.ProtocolV1, Sessionful: true),
            new McpYol("/mcp/v2", Mcp.ServerSetup.ProtocolV2, Sessionful: false),
            new McpYol("/mcp", Mcp.ServerSetup.ProtocolV2, Sessionful: false),
        ],
        _ => throw new ArgumentOutOfRangeException(nameof(protokol)),
    };

    /// <summary>
    /// Dinleme adresi: anahtar BOŞ → yalnız loopback (mevcut güvenlik duruşu);
    /// anahtar DOLU → 0.0.0.0 (dış istemciler kapıdan geçmek zorundadır).
    /// </summary>
    public static string DinlemeAdresi(string apiKey, int port)
        => string.IsNullOrEmpty(apiKey) ? $"http://localhost:{port}" : $"http://0.0.0.0:{port}";
}
