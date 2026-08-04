using System.IO.Pipelines;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Xunit;
using XurrentMcp.Mcp;

namespace XurrentMcp.Tests;

/// <summary>
/// GEÇERSİZ params KORUYUCUSU (madde J4 — JSON-RPC 2.0 MUST: -32602 Invalid params).
///
/// ★ BU TESTLER NEDEN VAR: bu ihlalin belirtisi "hiçbir şey olmaması"dır.
/// Koruyucu kaldırılırsa ya da mesaj filtresi bir refactor sırasında düşerse
/// sunucu yine ayağa kalkar, yine tool çağırır, sihirbaz yine 17/17 geçer —
/// tek fark, hatalı bir istekte istemciye <c>-32603 "An error occurred."</c>
/// gitmesidir. Testsiz, ihlal SESSİZCE geri gelir.
///
/// İki katman ayrı ayrı sınanır:
///   A) Saf karar fonksiyonu — sunucu, transport, DI yok. Hızlı ve kesin.
///   B) HAM TEL testi — gerçek bir MCP sunucusuna elle yazılmış JSON-RPC satırları
///      gönderilir ve dönen kod okunur. A geçip B kalıyorsa filtre BAĞLANMAMIŞ demektir;
///      bu ayrımı görebilmek için iki katman da gereklidir.
/// </summary>
public class GecersizParamsTests
{
    // ═════════════════════════════════════════════════════════════════════════
    // A) Saf karar fonksiyonu
    // ═════════════════════════════════════════════════════════════════════════

    private static JsonNode? P(string json) => JsonNode.Parse(json);

    [Fact]
    public void params_yoksa_reddedilir()
    {
        var hata = InvalidParamsGuard.ToolsCallHatasi(null);
        Assert.NotNull(hata);
        Assert.Contains("params", hata);
    }

    [Fact]
    public void params_nesne_degilse_reddedilir()
    {
        var hata = InvalidParamsGuard.ToolsCallHatasi(P("""["xurrent_whoami"]"""));
        Assert.NotNull(hata);
        Assert.Contains("dizi", hata);
    }

    [Fact]
    public void name_yoksa_reddedilir_ve_mesaj_ALANI_SOYLER()
    {
        var hata = InvalidParamsGuard.ToolsCallHatasi(P("""{"arguments":{}}"""));
        Assert.NotNull(hata);

        // ★ Maddenin asıl derdi buydu: "An error occurred." hangi alanın eksik
        //   olduğunu SÖYLEMİYORDU. Mesaj alan adını taşımazsa test kalır.
        Assert.Contains("params.name", hata);
    }

    [Fact]
    public void name_json_null_ise_reddedilir()
    {
        var hata = InvalidParamsGuard.ToolsCallHatasi(P("""{"name":null}"""));
        Assert.NotNull(hata);
        Assert.Contains("params.name", hata);
    }

    [Fact]
    public void name_string_degilse_TIP_soylenir()
    {
        var hata = InvalidParamsGuard.ToolsCallHatasi(P("""{"name":42,"arguments":{}}"""));
        Assert.NotNull(hata);
        Assert.Contains("string", hata);
        Assert.Contains("sayı", hata);
    }

    [Fact]
    public void name_bos_string_ise_reddedilir()
    {
        var hata = InvalidParamsGuard.ToolsCallHatasi(P("""{"name":"","arguments":{}}"""));
        Assert.NotNull(hata);
        Assert.Contains("params.name", hata);
    }

    [Fact]
    public void arguments_nesne_degilse_reddedilir()
    {
        var hata = InvalidParamsGuard.ToolsCallHatasi(P("""{"name":"xurrent_whoami","arguments":[]}"""));
        Assert.NotNull(hata);
        Assert.Contains("params.arguments", hata);
    }

    // ── YANLIŞ POZİTİF YOK: aşağıdaki istekler GEÇERLİDİR ve dokunulmadan geçmelidir ──

    [Fact]
    public void arguments_hic_yoksa_GECERLIDIR()
    {
        // arguments isteğe bağlıdır; argümansız tool vardır (xurrent_whoami).
        Assert.Null(InvalidParamsGuard.ToolsCallHatasi(P("""{"name":"xurrent_whoami"}""")));
    }

    [Fact]
    public void arguments_json_null_ise_GECERLIDIR()
    {
        Assert.Null(InvalidParamsGuard.ToolsCallHatasi(P("""{"name":"xurrent_whoami","arguments":null}""")));
    }

    [Fact]
    public void meta_ve_bilinmeyen_ek_alanlar_ISTEGI_BOZMAZ()
    {
        // v2'de her istek _meta taşır; ileride eklenecek alanlar da reddedilmemelidir.
        var node = P("""
        {
          "_meta": { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
          "name": "xurrent_find_person",
          "arguments": { "email": "ayse.demir@ornek.com" },
          "gelecekteAlan": 1
        }
        """);
        Assert.Null(InvalidParamsGuard.ToolsCallHatasi(node));
    }

    [Fact]
    public void bilinmeyen_tool_adi_BU_KORUYUCUNUN_ISI_DEGILDIR()
    {
        // Ad protokol açısından geçerlidir; "böyle bir tool yok" kararını SDK verir
        // ve zaten -32602 döner. Koruyucu buraya karışırsa iki yerde iki gerçek olur.
        Assert.Null(InvalidParamsGuard.ToolsCallHatasi(P("""{"name":"yok_boyle_bir_tool","arguments":{}}""")));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // B) HAM TEL — gerçek sunucu, elle yazılmış JSON-RPC
    // ═════════════════════════════════════════════════════════════════════════

    [Fact]
    public async Task tel_uzerinde_name_yoksa_32602_doner()
    {
        await using var o = await HamOturum.BaslatAsync();
        await o.DiscoverAsync();

        var yanit = await o.IstekAsync(2, "tools/call", """{"_meta":META}""");

        Assert.Equal(-32602, yanit["error"]!["code"]!.GetValue<int>());
        Assert.Contains("params.name", yanit["error"]!["message"]!.GetValue<string>());
    }

    [Fact]
    public async Task tel_uzerinde_gecerli_cagri_DOKUNULMADAN_gecer()
    {
        await using var o = await HamOturum.BaslatAsync();
        await o.DiscoverAsync();

        var yanit = await o.IstekAsync(2, "tools/call", """{"_meta":META,"name":"xurrent_whoami","arguments":{}}""");

        Assert.Null(yanit["error"]);
        Assert.False(yanit["result"]!["isError"]!.GetValue<bool>());
    }

    /// <summary>
    /// ★ KRİTİK VAKA 1 (TypeScript parse-guard.test.mjs'teki karşılığı:
    /// "iki data olayına BÖLÜNMÜŞ geçerli mesaj bozuk sayılmamalı").
    ///
    /// Bir JSON-RPC satırının iki ayrı yazmaya bölünmesi NORMALDİR. Koruyucu
    /// mesaj katmanında çalıştığı için bölünmeden etkilenmemelidir; buradaki risk,
    /// birinin ileride byte/satır seviyesine indirip yarım tamponu "params yok"
    /// sanmasıdır. Test tam olarak onu kilitler.
    /// </summary>
    [Fact]
    public async Task BOLUNMUS_yazilan_gecerli_mesaj_bozuk_SAYILMAZ()
    {
        await using var o = await HamOturum.BaslatAsync();
        await o.DiscoverAsync();

        var satir = HamOturum.Govde(3, "tools/call", """{"_meta":META,"name":"xurrent_whoami","arguments":{}}""");
        var kes = satir.Length / 2;

        await o.HamYazAsync(satir[..kes]);
        await Task.Delay(60);                       // iki ayrı "data olayı" arasındaki boşluk
        await o.HamYazAsync(satir[kes..] + "\n");

        var yanit = await o.YanitBekleAsync(3);
        Assert.Null(yanit["error"]);
        Assert.False(yanit["result"]!["isError"]!.GetValue<bool>());
    }

    /// <summary>
    /// ★ KRİTİK VAKA 2 (TypeScript'teki karşılığı: "bozuk satır SONRAKİ geçerli
    /// satırı zehirlememeli").
    ///
    /// Reddedilen istek oturumu düşürmemeli, sıradaki geçerli çağrı normal
    /// çalışmalıdır. -32602 "isteği düzelt" demektir; "bağlantıyı kapat" değil.
    /// </summary>
    [Fact]
    public async Task reddedilen_istek_SONRAKI_gecerli_istegi_ZEHIRLEMEZ()
    {
        await using var o = await HamOturum.BaslatAsync();
        await o.DiscoverAsync();

        var kotu = await o.IstekAsync(2, "tools/call", """{"_meta":META}""");
        Assert.Equal(-32602, kotu["error"]!["code"]!.GetValue<int>());

        var iyi = await o.IstekAsync(3, "tools/call", """{"_meta":META,"name":"xurrent_whoami","arguments":{}}""");
        Assert.Null(iyi["error"]);
        Assert.False(iyi["result"]!["isError"]!.GetValue<bool>());

        // Oturum gerçekten ayakta mı? Üçüncü bir istek daha.
        var liste = await o.IstekAsync(4, "tools/list", """{"_meta":META}""");
        Assert.Null(liste["error"]);
        Assert.Equal(8, liste["result"]!["tools"]!.AsArray().Count);
    }

    [Fact]
    public async Task tel_uzerinde_arguments_dizi_ise_32602_doner()
    {
        await using var o = await HamOturum.BaslatAsync();
        await o.DiscoverAsync();

        var yanit = await o.IstekAsync(2, "tools/call", """{"_meta":META,"name":"xurrent_whoami","arguments":[]}""");

        Assert.Equal(-32602, yanit["error"]!["code"]!.GetValue<int>());
        Assert.Contains("params.arguments", yanit["error"]!["message"]!.GetValue<string>());
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Ham tel yardımcısı
    //
    // InProcessMcpSession KULLANILMAZ: o, SDK client'ını kullanır ve SDK tam da
    // burada test etmek istediğimiz şeyi engeller — name'siz bir tools/call'ı
    // derleme zamanında yazamayız bile. Ölçüm ham olmalı.
    // ═════════════════════════════════════════════════════════════════════════

    private sealed class HamOturum : IAsyncDisposable
    {
        private const string MetaJson =
            "{\"io.modelcontextprotocol/protocolVersion\":\"2026-07-28\"," +
            "\"io.modelcontextprotocol/clientCapabilities\":{}," +
            "\"io.modelcontextprotocol/clientInfo\":{\"name\":\"ham-test\",\"version\":\"1.0.0\"}}";

        private readonly IHost _host;
        private readonly Stream _girdi;      // test → sunucu
        private readonly StreamReader _cikti; // sunucu → test
        private readonly List<JsonObject> _gelenler = [];

        private HamOturum(IHost host, Stream girdi, StreamReader cikti)
            => (_host, _girdi, _cikti) = (host, girdi, cikti);

        public static async Task<HamOturum> BaslatAsync()
        {
            var istemciden = new Pipe();
            var sunucudan = new Pipe();

            var b = Host.CreateApplicationBuilder();
            b.Logging.ClearProviders();          // test çıktısı kirlenmesin
            var cfg = Ortam.Yapilandirma();
            b.Services.AddXurrentServices(cfg);
            b.Services.AddXurrentMcpServer(cfg)
                .WithStreamServerTransport(istemciden.Reader.AsStream(), sunucudan.Writer.AsStream());

            var host = b.Build();
            await host.StartAsync();

            return new HamOturum(
                host,
                istemciden.Writer.AsStream(),
                new StreamReader(sunucudan.Reader.AsStream(), Encoding.UTF8));
        }

        /// <summary>Şablondaki META yer tutucusunu gerçek _meta ile doldurur.</summary>
        public static string Govde(int id, string metot, string paramsSablonu)
            => $$"""{"jsonrpc":"2.0","id":{{id}},"method":"{{metot}}","params":{{paramsSablonu.Replace("META", MetaJson)}}}""";

        public async Task HamYazAsync(string metin)
        {
            var b = Encoding.UTF8.GetBytes(metin);
            await _girdi.WriteAsync(b);
            await _girdi.FlushAsync();
        }

        public async Task<JsonObject> IstekAsync(int id, string metot, string paramsSablonu)
        {
            await HamYazAsync(Govde(id, metot, paramsSablonu) + "\n");
            return await YanitBekleAsync(id);
        }

        public async Task DiscoverAsync() => await IstekAsync(1, "server/discover", """{"_meta":META}""");

        /// <summary>
        /// Verilen id'ye ait yanıt gelene kadar okur. Sunucu araya bildirim sokabilir;
        /// ilk satırı yanıt saymak testi kırılgan yapardı.
        /// </summary>
        public async Task<JsonObject> YanitBekleAsync(int id)
        {
            var mevcut = _gelenler.FirstOrDefault(m => m["id"]?.GetValue<int>() == id);
            if (mevcut is not null) return mevcut;

            using var zamanAsimi = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            while (true)
            {
                var satir = await _cikti.ReadLineAsync(zamanAsimi.Token)
                    ?? throw new InvalidOperationException($"Akış kapandı; id={id} yanıtı hiç gelmedi.");
                if (satir.Length == 0) continue;

                var mesaj = JsonNode.Parse(satir)!.AsObject();
                _gelenler.Add(mesaj);
                if (mesaj["id"]?.GetValue<int>() == id) return mesaj;
            }
        }

        public async ValueTask DisposeAsync()
        {
            await _girdi.DisposeAsync();
            await _host.StopAsync();
            _host.Dispose();
        }
    }
}
