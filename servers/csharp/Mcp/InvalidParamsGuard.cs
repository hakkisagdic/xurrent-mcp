using System.Text.Json;
using System.Text.Json.Nodes;

namespace XurrentMcp.Mcp;

/// <summary>
/// GEÇERSİZ params KORUYUCUSU — SDK'nın deserializer'ı ile handler arasına girer.
///
/// SORUN: JSON-RPC 2.0, isteğin parametreleri geçersizse <c>-32602 Invalid params</c>
/// dönmeyi ZORUNLU kılar. ModelContextProtocol 2.0.0 ise zorunlu <c>name</c> alanı
/// olmadan gelen bir <c>tools/call</c> isteğinde şunu yapıyor:
///
///   RequestHandlers.SetWithAlternate → JsonSerializer.ReadFromNode&lt;CallToolRequestParams&gt;
///     → System.Text.Json.JsonException:
///       "JSON deserialization for type 'CallToolRequestParams' was missing
///        required properties including: 'name'."
///
/// Bu <c>JsonException</c> handler'ın DIŞINDA, tipli parametreye çevirme adımında
/// atılır; McpProtocolException olmadığı için oturum katmanı onu genel bir iç hataya
/// sarmalar ve dışarı şu çıkar:
///
///   {"error":{"code":-32603,"message":"An error occurred."}}
///
/// İki ayrı kusur var: (1) kod yanlış — <c>-32603</c> "sunucuda bir şey patladı,
/// tekrar denemek mantıklı olabilir" demektir, oysa eksik <c>name</c> ile bu istek
/// SONSUZA KADAR başarısızdır; doğru cevap <c>-32602</c>'dir, yani "isteği düzelt".
/// (2) mesaj bilgi taşımıyor — hangi alanın eksik ya da hatalı olduğu SÖYLENMİYOR.
/// Üç dilin içinde hata ayıklanabilirlik açısından en kötü davranış buydu.
///
/// NEDEN "SDK böyle" bir mazeret DEĞİL: aynı senaryoda Python SDK'sı <c>-32602</c>
/// dönüyor (scripts/mcp-uyum.mjs · madde J4). Davranış protokolün değil,
/// implementasyonun eksiği.
///
/// ÇÖZÜM: SDK ile dövüşmek yerine ÖNÜNE geçiyoruz. Gelen JSON-RPC mesajı daha
/// tipli parametreye çevrilmeden, HAM <see cref="JsonNode"/> hâlindeyken denetlenir.
/// Geçerli istek dokunulmadan geçer; geçersiz olan hiç handler'a ulaşmaz ve yerine
/// spec'in istediği hata yazılır. <see cref="ToolsCallHatasi"/> saf bir fonksiyondur:
/// sunucu, transport ve DI olmadan birim testi yazılabilir (McpUyumTests).
///
/// KAPSAM: yalnızca PROTOKOL seviyesi alanlar (<c>name</c>, <c>arguments</c>'ın
/// kabı). Tool'un KENDİ argümanlarının doğrulaması buraya AİT DEĞİLDİR — o bir
/// iş kuralı hatasıdır ve spec gereği JSON-RPC hatası değil, <c>isError=true</c>
/// taşıyan bir CallToolResult ile bildirilir (madde T7).
/// </summary>
public static class InvalidParamsGuard
{
    /// <summary>
    /// <c>tools/call</c> isteğinin HAM params düğümünü protokol seviyesinde denetler.
    /// Geçerliyse <see langword="null"/>, değilse istemciye gösterilecek Türkçe mesaj döner.
    ///
    /// Mesaj HANGİ ALANIN neden reddedildiğini söyler; "An error occurred." gibi
    /// bir cümle istemciye hiçbir şey öğretmez ve bu maddenin asıl derdi odur.
    /// </summary>
    public static string? ToolsCallHatasi(JsonNode? paramsNode)
    {
        // params hiç yok ya da JSON null.
        // SDK bu durumda name'i boş string sayıp "Unknown tool: ''" diyor: kod doğru
        // ama teşhis yanlış — eksik olan tool DEĞİL, params'ın kendisi.
        if (paramsNode is null)
            return "params zorunludur: tools/call en az { \"name\": \"<tool adı>\" } içermelidir.";

        if (paramsNode is not JsonObject obj)
            return $"params bir JSON nesnesi olmalıdır (gelen: {TipAdi(paramsNode)}).";

        if (!obj.TryGetPropertyValue("name", out var nameNode) || nameNode is null)
            return "params.name zorunludur: çağrılacak tool'un adı verilmelidir. " +
                   "Kullanılabilir adlar için tools/list çağırın.";

        if (!IsString(nameNode, out var name))
            return $"params.name bir string olmalıdır (gelen: {TipAdi(nameNode)}).";

        if (name!.Length == 0)
            return "params.name boş olamaz: çağrılacak tool'un adı verilmelidir. " +
                   "Kullanılabilir adlar için tools/list çağırın.";

        // arguments İSTEĞE BAĞLIDIR (argümansız tool'lar vardır), ama VARSA nesne olmalıdır.
        // Dizi/skaler gelirse SDK yine deserializer'da patlıyor ve -32603 üretiyordu.
        if (obj.TryGetPropertyValue("arguments", out var argsNode) && argsNode is not null && argsNode is not JsonObject)
            return $"params.arguments bir JSON nesnesi olmalıdır (gelen: {TipAdi(argsNode)}).";

        return null;
    }

    /// <summary>JsonNode'un JSON tipini Türkçe ve INSAN OKUR biçimde adlandırır.</summary>
    private static string TipAdi(JsonNode node) => node switch
    {
        JsonObject => "nesne",
        JsonArray => "dizi",
        JsonValue v when v.TryGetValue<string>(out _) => "string",
        JsonValue v when v.TryGetValue<bool>(out _) => "boolean",
        JsonValue v when v.GetValueKind() == JsonValueKind.Number => "sayı",
        JsonValue v when v.GetValueKind() == JsonValueKind.Null => "null",
        _ => "bilinmeyen",
    };

    /// <summary>
    /// Düğüm gerçekten bir JSON string mi? <c>TryGetValue&lt;string&gt;</c> tek başına
    /// yetmez: System.Text.Json sayıyı da string'e çevirmeyi deneyebilir, oysa burada
    /// TİP hatasını yakalamak istiyoruz.
    /// </summary>
    private static bool IsString(JsonNode node, out string? value)
    {
        value = null;
        if (node is not JsonValue v || v.GetValueKind() != JsonValueKind.String) return false;
        value = v.GetValue<string>();
        return true;
    }
}
