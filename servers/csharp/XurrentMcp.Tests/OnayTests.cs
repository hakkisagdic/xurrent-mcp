using System.Text;
using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Core;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ requestState BİR GÜVENLİK SINIRIDIR (v2 / MRTR onay akışı).
///
/// Sunucu state'ini client'a verip geri alıyoruz; spec bunu açıkça "saldırgan
/// kontrolündeki girdi" olarak tanımlar. Taşıdığı bilgi şudur:
/// "kullanıcı X, Request #70248'e 120 dakika yazmayı onayladı".
///
/// Bu sınıftaki her test, o sınırın bir deliğini kapatır. Hiçbiri "mutlu yol" değildir;
/// biri hariç hepsi REDDEDİLMESİ gereken senaryodur.
/// </summary>
public class OnayTests
{
    private const string Ben = Ortam.BenId;
    private const string Metot = "xurrent_create_time_entry";

    private static JsonNode Argumanlar(int dakika = 120, string hedef = Ortam.Request70248)
        => new JsonObject
        {
            ["targetType"] = "request",
            ["targetId"] = hedef,
            ["minutes"] = dakika,
        };

    // ── Mutlu yol ────────────────────────────────────────────────────────────

    [Fact]
    public void imzalanan_state_ayni_baglamda_dogrulanir()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());

        var karar = RequestStateCodec.Verify(cfg, blob, Ben, Metot, Argumanlar());

        Assert.True(karar.Ok);
        Assert.Null(karar.Reason);
    }

    [Fact]
    public void argumansiz_cagri_da_imzalanip_dogrulanabilir()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, "xurrent_whoami", null);

        Assert.True(RequestStateCodec.Verify(cfg, blob, Ben, "xurrent_whoami", null).Ok);
    }

    /// <summary>
    /// JSON anahtar sırası client'tan client'a değişir. Parmak izi KANONİK sıralanmasaydı
    /// geçerli onaylar yanlış yere "uyuşmuyor" derdi.
    /// </summary>
    [Fact]
    public void arguman_anahtarlarinin_sirasi_parmak_izini_degistirmez()
    {
        var cfg = Ortam.Yapilandirma();
        var ilkSira = new JsonObject { ["a"] = 1, ["b"] = "iki", ["c"] = new JsonObject { ["x"] = true, ["y"] = 3 } };
        var tersSira = new JsonObject { ["c"] = new JsonObject { ["y"] = 3, ["x"] = true }, ["b"] = "iki", ["a"] = 1 };

        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, ilkSira);

        Assert.True(RequestStateCodec.Verify(cfg, blob, Ben, Metot, tersSira).Ok);
    }

    // ── İmza ─────────────────────────────────────────────────────────────────

    [Fact]
    public void imza_bozulursa_REDDEDILIR()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());

        var nokta = blob.IndexOf('.');
        var bozuk = blob[..nokta] + "." + Ters(blob[(nokta + 1)..]);

        var karar = RequestStateCodec.Verify(cfg, bozuk, Ben, Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("İMZASI GEÇERSİZ", karar.Reason);
    }

    /// <summary>
    /// Gerçek saldırı: payload içindeki principal değiştirilir, imza aynen bırakılır.
    /// İmzasız bir state'te bu saldırı BAŞARILI olurdu.
    /// </summary>
    [Fact]
    public void payload_kurcalanirsa_imza_tutmaz_ve_REDDEDILIR()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());

        var nokta = blob.IndexOf('.');
        var payload = JsonNode.Parse(Encoding.UTF8.GetString(Base64UrlCoz(blob[..nokta])))!.AsObject();
        payload["principal"] = "saldirgan";
        var kurcalanmis = Base64UrlYaz(Encoding.UTF8.GetBytes(payload.ToJsonString())) + blob[nokta..];

        var karar = RequestStateCodec.Verify(cfg, kurcalanmis, "saldirgan", Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("İMZASI GEÇERSİZ", karar.Reason);
    }

    [Fact]
    public void baska_bir_sunucunun_anahtariyla_imzalanan_state_REDDEDILIR()
    {
        var uretenler = Ortam.Yapilandirma(stateSecret: "birinci-sunucu");
        var dogrulayan = Ortam.Yapilandirma(stateSecret: "ikinci-sunucu");

        var blob = RequestStateCodec.Sign(uretenler, Ben, Metot, Argumanlar());
        var karar = RequestStateCodec.Verify(dogrulayan, blob, Ben, Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("İMZASI GEÇERSİZ", karar.Reason);
    }

    // ── Parmak izi (metot + argümanlar) ──────────────────────────────────────

    /// <summary>Onaydan SONRA süre 120'den 480'e çekilirse state artık geçerli değildir.</summary>
    [Fact]
    public void argumanlar_onaydan_sonra_degistirilirse_REDDEDILIR()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar(dakika: 120));

        var karar = RequestStateCodec.Verify(cfg, blob, Ben, Metot, Argumanlar(dakika: 480));

        Assert.False(karar.Ok);
        Assert.Contains("ARGÜMANLARLA UYUŞMUYOR", karar.Reason);
    }

    [Fact]
    public void hedef_ticket_degistirilirse_REDDEDILIR()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar(hedef: Ortam.Request70248));

        var karar = RequestStateCodec.Verify(cfg, blob, Ben, Metot, Argumanlar(hedef: Ortam.Request70301));

        Assert.False(karar.Ok);
        Assert.Contains("ARGÜMANLARLA UYUŞMUYOR", karar.Reason);
    }

    [Fact]
    public void baska_bir_metodun_onayi_bu_cagriya_ilistirilemez()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, "xurrent_create_time_entry", Argumanlar());

        var karar = RequestStateCodec.Verify(cfg, blob, Ben, "xurrent_create_time_entries_bulk", Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("BAŞKA BİR METODA", karar.Reason);
    }

    // ── Principal ────────────────────────────────────────────────────────────

    [Fact]
    public void baska_kullanicinin_onayi_kabul_edilmez()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());

        var karar = RequestStateCodec.Verify(cfg, blob, Ortam.BaskasiId, Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("BAŞKA BİR KULLANICIYA", karar.Reason);
    }

    // ── TTL ──────────────────────────────────────────────────────────────────

    [Fact]
    public void TTL_dolduktan_sonra_state_REDDEDILIR()
    {
        var saat = new SabitSaat(Ortam.VarsayilanAn);
        var cfg = Ortam.Yapilandirma(saat, stateTtlSaniye: 300);
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());

        saat.Ilerlet(TimeSpan.FromSeconds(301));

        var karar = RequestStateCodec.Verify(cfg, blob, Ben, Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("SÜRESİ DOLDU", karar.Reason);
    }

    [Fact]
    public void TTL_penceresi_icinde_state_gecerlidir()
    {
        var saat = new SabitSaat(Ortam.VarsayilanAn);
        var cfg = Ortam.Yapilandirma(saat, stateTtlSaniye: 300);
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());

        saat.Ilerlet(TimeSpan.FromSeconds(299));

        Assert.True(RequestStateCodec.Verify(cfg, blob, Ben, Metot, Argumanlar()).Ok);
    }

    // ── Tek kullanımlık nonce (replay) ───────────────────────────────────────

    /// <summary>
    /// Spec'in uyarısı: imza + exp + fingerprint replay penceresini DARALTIR ama
    /// tek kullanımı GARANTİ ETMEZ. Tek kullanım sunucu tarafında zorlanmalıdır.
    /// </summary>
    [Fact]
    public void ayni_state_ikinci_kez_kullanilamaz_replay_reddedilir()
    {
        var cfg = Ortam.Yapilandirma();
        var blob = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());

        Assert.True(RequestStateCodec.Verify(cfg, blob, Ben, Metot, Argumanlar()).Ok);

        var ikinci = RequestStateCodec.Verify(cfg, blob, Ben, Metot, Argumanlar());

        Assert.False(ikinci.Ok);
        Assert.Contains("ZATEN KULLANILMIŞ", ikinci.Reason);
    }

    [Fact]
    public void her_imza_farkli_nonce_tasir_ayni_cagri_iki_kez_onaylanabilir()
    {
        var cfg = Ortam.Yapilandirma();
        var birinci = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());
        var ikinci = RequestStateCodec.Sign(cfg, Ben, Metot, Argumanlar());

        Assert.NotEqual(birinci, ikinci);
        Assert.True(RequestStateCodec.Verify(cfg, birinci, Ben, Metot, Argumanlar()).Ok);
        Assert.True(RequestStateCodec.Verify(cfg, ikinci, Ben, Metot, Argumanlar()).Ok);
    }

    // ── Amaç ayracı (kind) ───────────────────────────────────────────────────

    /// <summary>
    /// Sihirbazın sessionState'i AYNI sırla ve AYNI zarfla imzalanır ama AMACI
    /// farklıdır (kind: "wizard"). Onay yerine geçmeye çalışırsa REDDEDİLMELİDİR —
    /// aksi hâlde 30 dakikalık wizard TTL'i, 5 dakikalık onay penceresini deler.
    /// </summary>
    [Fact]
    public void sihirbaz_state_i_requestState_olarak_kullanilamaz()
    {
        var cfg = Ortam.Yapilandirma();
        var wizardBlob = WizardStateCodec.Sign(cfg, "duration", new JsonObject { ["minutes"] = 60 });

        var karar = RequestStateCodec.Verify(cfg, wizardBlob, Ben, Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("BAŞKA BİR AMAÇLA", karar.Reason);
    }

    // ── Biçim bozuklukları ───────────────────────────────────────────────────

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void bos_state_REDDEDILIR(string blob)
    {
        var karar = RequestStateCodec.Verify(Ortam.Yapilandirma(), blob, Ben, Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("boş geldi", karar.Reason);
    }

    [Theory]
    [InlineData("noktasiz-blob")]
    [InlineData(".imzasiz")]
    [InlineData("payloadsiz.")]
    public void bicimi_bozuk_state_REDDEDILIR(string blob)
    {
        var karar = RequestStateCodec.Verify(Ortam.Yapilandirma(), blob, Ben, Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.False(karar.Ok && karar.Reason is null);
    }

    [Fact]
    public void base64url_olmayan_state_REDDEDILIR()
    {
        var karar = RequestStateCodec.Verify(Ortam.Yapilandirma(), "!!!.???", Ben, Metot, Argumanlar());

        Assert.False(karar.Ok);
        Assert.Contains("base64url", karar.Reason);
    }

    // ── Yardımcılar (üretimdeki private kodlayıcının test karşılığı) ─────────

    private static string Ters(string metin) => new(metin.Reverse().ToArray());

    private static string Base64UrlYaz(byte[] veri)
        => Convert.ToBase64String(veri).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlCoz(string metin)
    {
        var s = metin.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + (4 - s.Length % 4) % 4, '='));
    }
}
