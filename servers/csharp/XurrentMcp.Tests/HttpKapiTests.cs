using Xunit;
using XurrentMcp.Agent;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ WP6 — HTTP yüzeyi uyumlaştırması (Agent/HttpKapi.cs).
///
/// İki saf fonksiyon test edilir:
///   · AnahtarUygun — MCP_API_KEY kapısının sabit-zamanlı karşılaştırıcısı
///   · YolTablosu   — uyumlaştırılmış yol tablosu + dönem başına session duruşu
/// Tam HTTP el sıkışması merkezî smoke'ta koşar; buradaki testler HTTP ayağa
/// kaldırmadan sözleşmenin karar tablolarını sabitler.
/// </summary>
public class HttpKapiTests
{
    // ── AnahtarUygun ─────────────────────────────────────────────────────────

    /// <summary>Anahtar BOŞ = kapı kapalı: her istek geçer (sunucu zaten yalnız loopback dinler).</summary>
    [Fact]
    public void bos_anahtar_kapiyi_devre_disi_birakir()
    {
        Assert.True(HttpKapi.AnahtarUygun("", null));
        Assert.True(HttpKapi.AnahtarUygun("", "her-sey"));
    }

    [Fact]
    public void dogru_anahtar_gecer_yanlis_ve_eksik_gecmez()
    {
        Assert.True(HttpKapi.AnahtarUygun("deneme", "deneme"));
        Assert.False(HttpKapi.AnahtarUygun("deneme", "yanlis"));
        Assert.False(HttpKapi.AnahtarUygun("deneme", null));
        Assert.False(HttpKapi.AnahtarUygun("deneme", ""));
        // Uzunluk farkı da reddedilir (içerik değil yalnız uzunluk sızar — kabul edilen pratik).
        Assert.False(HttpKapi.AnahtarUygun("deneme", "denem"));
        Assert.False(HttpKapi.AnahtarUygun("deneme", "deneme1"));
    }

    /// <summary>Türkçe/çok baytlı karakterler UTF-8 üzerinden karşılaştırılır.</summary>
    [Fact]
    public void cok_baytli_anahtarlar_dogru_karsilastirilir()
    {
        Assert.True(HttpKapi.AnahtarUygun("gizli-şifre-ü", "gizli-şifre-ü"));
        Assert.False(HttpKapi.AnahtarUygun("gizli-şifre-ü", "gizli-sifre-u"));
    }

    // ── YolTablosu ───────────────────────────────────────────────────────────

    /// <summary>Tek dönem → /mcp, o dönemin duruşuyla: v1 SESSIONFUL, v2 STATELESS.</summary>
    [Fact]
    public void tek_donem_mcp_yolunda_donemin_durusuyla_yayinlanir()
    {
        var v1 = Assert.Single(HttpKapi.YolTablosu(ProtocolChoice.V1));
        Assert.Equal(new McpYol("/mcp", "2025-11-25", Sessionful: true), v1);

        var v2 = Assert.Single(HttpKapi.YolTablosu(ProtocolChoice.V2));
        Assert.Equal(new McpYol("/mcp", "2026-07-28", Sessionful: false), v2);
    }

    /// <summary>both → /mcp/v1 (sessionful) + /mcp/v2 (stateless) + /mcp = v2 takma adı.</summary>
    [Fact]
    public void both_uc_yol_yayinlar_ve_mcp_v2nin_takma_adidir()
    {
        var tablo = HttpKapi.YolTablosu(ProtocolChoice.Both);

        Assert.Equal(3, tablo.Count);
        Assert.Equal(new McpYol("/mcp/v1", "2025-11-25", Sessionful: true), tablo[0]);
        Assert.Equal(new McpYol("/mcp/v2", "2026-07-28", Sessionful: false), tablo[1]);
        Assert.Equal(new McpYol("/mcp", "2026-07-28", Sessionful: false), tablo[2]);
    }

    // ── DinlemeAdresi ────────────────────────────────────────────────────────

    /// <summary>Anahtar boş → loopback (mevcut duruş); dolu → 0.0.0.0 (kapı zorunlu).</summary>
    [Fact]
    public void dinleme_adresi_anahtara_gore_secilir()
    {
        Assert.Equal("http://localhost:8788", HttpKapi.DinlemeAdresi("", 8788));
        Assert.Equal("http://0.0.0.0:8788", HttpKapi.DinlemeAdresi("deneme", 8788));
    }
}
