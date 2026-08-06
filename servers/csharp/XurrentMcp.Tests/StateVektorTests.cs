using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Core;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ ÇAPRAZ-DİL DURUM İMZASI VEKTÖRLERİ (fixtures/state-vektorleri.json).
///
/// Paralel altyapı ölçümü şunu buldu: TS'in ürettiği requestState, aynı
/// XURRENT_STATE_SECRET'ı paylaşan bir C# replikası tarafından ÇÖZÜLEMİYORDU —
/// confirm codec'inin zarf biçimi dilden dile ayrışmıştı. Bu dosya o sapmanın
/// bir daha oluşmamasının sözleşmesidir: üç dil de AYNI sabit vektörlerden
/// AYNEN aynı token'ı üretmek ve o token'ı doğrulamak zorundadır.
///
/// KURAL (vektör dosyasının kendi uyarısı): imza HAM payload byte'ları
/// üzerindedir, kanonikleştirme YOKTUR. Bu yüzden test payloadJson DİZGESİNİ
/// yeniden serileştirmeden, olduğu gibi imzalar — JSON anahtar sırası dilden
/// dile değişebilir ve kanonik DEĞİLDİR.
/// </summary>
public class StateVektorTests
{
    private sealed record Vektor(string Aciklama, string Secret, string PayloadJson, string Token);

    private static IReadOnlyList<Vektor> VektorleriOku()
    {
        var yol = Path.Combine(Ortam.RepoKoku, "fixtures", "state-vektorleri.json");
        var kok = JsonNode.Parse(File.ReadAllText(yol))!.AsObject();
        return [.. kok["vektorler"]!.AsArray().Select(v => new Vektor(
            v!["aciklama"]!.GetValue<string>(),
            v["secret"]!.GetValue<string>(),
            v["payloadJson"]!.GetValue<string>(),
            v["token"]!.GetValue<string>()))];
    }

    /// <summary>Dosya boşalır ya da yanlış yerden okunursa test sessizce "hep geçer" olmasın.</summary>
    [Fact]
    public void vektor_dosyasi_en_az_iki_vektor_icerir()
    {
        Assert.True(VektorleriOku().Count >= 2);
    }

    /// <summary>(a) Verilen payload verilen sırla imzalanınca TAM OLARAK beklenen token çıkar.</summary>
    [Fact]
    public void her_vektor_ayni_tokena_kodlanir()
    {
        foreach (var v in VektorleriOku())
        {
            var cfg = Ortam.Yapilandirma(stateSecret: v.Secret);
            Assert.Equal(v.Token, RequestStateCodec.ZarfImzala(cfg, v.PayloadJson));
        }
    }

    /// <summary>(b) Beklenen token aynı sırla doğrulanır ve payload'ı AYNEN geri verir.</summary>
    [Fact]
    public void her_vektor_dogrulanir_ve_payloadi_geri_verir()
    {
        foreach (var v in VektorleriOku())
        {
            var cfg = Ortam.Yapilandirma(stateSecret: v.Secret);
            var (payload, sonuc) = RequestStateCodec.ZarfCoz(cfg, v.Token);

            Assert.Equal(RequestStateCodec.ZarfSonucu.Gecerli, sonuc);
            Assert.True(JsonNode.DeepEquals(payload, JsonNode.Parse(v.PayloadJson)),
                $"{v.Aciklama}: çözülen payload vektördekiyle aynı değil.");
        }
    }

    /// <summary>
    /// Wizard vektörü ÜRETİM doğrulama yolundan da geçer (yalnız zarf değil):
    /// kind/step/exp semantik kontrolleri dahil. Confirm vektörü için bu yapılamaz —
    /// fingerprint alanı vektörde SABİT bir örnek değerdir, gerçek bir çağrının
    /// özeti değildir; onun semantiği OnayTests'te dil içinde sınanır.
    /// </summary>
    [Fact]
    public void wizard_vektoru_uretim_dogrulamasindan_gecer()
    {
        var v = VektorleriOku().Single(x => x.PayloadJson.Contains("\"kind\":\"wizard\""));
        var cfg = Ortam.Yapilandirma(stateSecret: v.Secret);

        var karar = WizardStateCodec.Verify(cfg, v.Token);

        Assert.True(karar.Ok, karar.RestartReason);
        Assert.Equal("duration", karar.Payload!["step"]!.GetValue<string>());
    }

    /// <summary>
    /// NEGATİF SONDA: vektör token'ının imzasında tek karakter oynatılır ve reddin
    /// GERİ GELDİĞİ görülür. Yakalayamayan bir doğrulama, doğrulama değildir.
    /// </summary>
    [Fact]
    public void kurcalanan_vektor_tokeni_REDDEDILIR()
    {
        var v = VektorleriOku()[0];
        var cfg = Ortam.Yapilandirma(stateSecret: v.Secret);

        // İmzanın İLK karakteri oynatılır: base64'te son karakterin alt bitleri
        // kullanılmayabilir (aynı byte'lara çözülebilir), ilk karakterin 6 biti
        // ise TAMAMEN kullanılır — değişiklik decode edilen imzayı KESİN değiştirir.
        var nokta = v.Token.IndexOf('.');
        var ilk = v.Token[nokta + 1];
        var kurcalanmis = v.Token[..(nokta + 1)] + (ilk == 'A' ? 'B' : 'A') + v.Token[(nokta + 2)..];

        var (_, sonuc) = RequestStateCodec.ZarfCoz(cfg, kurcalanmis);
        Assert.Equal(RequestStateCodec.ZarfSonucu.ImzaGecersiz, sonuc);
    }

    /// <summary>Yanlış sır, doğru token'ı bile doğrulayamaz (replika ancak AYNI sırla çözer).</summary>
    [Fact]
    public void farkli_sir_vektor_tokenini_dogrulayamaz()
    {
        var v = VektorleriOku()[0];
        var cfg = Ortam.Yapilandirma(stateSecret: "bambaska-bir-sir");

        var (_, sonuc) = RequestStateCodec.ZarfCoz(cfg, v.Token);
        Assert.Equal(RequestStateCodec.ZarfSonucu.ImzaGecersiz, sonuc);
    }
}
