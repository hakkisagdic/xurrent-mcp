# 06 — Üç dil karşılaştırma

> **Bölüm hedefi:** Aynı sözleşmenin TypeScript, Python ve C#'ta nasıl göründüğünü yan
> yana görmek — ve dersin tezini kanıtlamak: *MCP bir protokoldür, dil bir detaydır.*

| ← Önceki | Sonraki → |
|---|---|
| [05 — Chatbot](05-chatbot.md) | [07 — Sihirbaz](07-sihirbaz.md) |

---

> **Bu bölümdeki kod hakkında.** Aşağıdaki blokların hepsi `servers/` altındaki
> **gerçek kaynak dosyalardan** alınmıştır — sözleşmeden türetilmiş örnek değildir.
> Her bloğun başında geldiği dosya ve satır aralığı yazar.
>
> **Otorite her zaman kaynak dosyanın kendisidir.** Satır numaraları bu belgenin
> yazıldığı andaki hâli gösterir; kod değiştikçe kayabilir. Uzun fonksiyonlarda
> `// …` ile kesme yapıldığı yerler işaretlenmiştir.
>
> Sürüm numaraları manifest dosyalarından alınmıştır:
> [`package.json`](../servers/typescript/package.json) ·
> [`pyproject.toml`](../servers/python/pyproject.toml) ·
> [`XurrentMcp.csproj`](../servers/csharp/XurrentMcp.csproj)

---

## Aynı iş, üç dil: `xurrent_list_open_work`

En öğretici tool — okuma, şema, normalizasyon ve iki çıktı biçimi bir arada.

> **Önce mimari.** Çift protokol fazından sonra üç dil de aynı katmanlamayı
> kullanıyor: **iş mantığı `core/`'da, protokol `mcp/`'de.** Aşağıdaki bloklar bu
> ayrımı üç ekosistemde gösteriyor.
>
> | Rol | TypeScript | Python | C# |
> |---|---|---|---|
> | Saf tool mantığı | `src/core/toolimpl.ts` | `core/toolimpl.py` | `Core/ToolImpl.cs` |
> | Şemalar | `src/core/schemas.ts` | `core/schemas.py` | `Core/ToolContracts.cs` |
> | Türkçe metin üretimi | `src/core/toolimpl.ts` | `core/toolimpl.py` | `Core/Narrate.cs` |
> | MCP adaptörü | `src/mcp/v1|v2/server.ts` | `mcp/v1.py`, `mcp/v2.py` | `Mcp/McpTools.cs` |

### TypeScript — tek `TOOL_SPECS` tablosu, iki adaptör okur

Tool sözleşmesi veri olarak duruyor; adaptör onu döngüyle kaydediyor:

```typescript
// servers/typescript/src/core/toolimpl.ts:1044-1054  (TOOL_SPECS'ten bir kayıt)
{
  name: "xurrent_list_open_work",
  title: "Xurrent: açık talep ve görevler",
  description:
    "Bir kişinin üzerindeki AÇIK Request ve Task'ları id + açıklama ile listeler. " +
    "Filtre asimetriktir (Request: member, Task: assignee), view her zaman 'all' geçilir ve " +
    "açık/kapalı ayrımı yalnızca status ile yapılır. Zaman yazmadan önce hedef id'leri buradan alınır.",
  inputSchema:  S.listOpenWorkInput,
  outputSchema: S.listOpenWorkOutput,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  write: false,
},
```

```typescript
// servers/typescript/src/mcp/v2/server.ts:114-124
// Sözleşmedeki SIRA korunur — v2 tools/list'in DETERMİNİSTİK dönmesini şart koşar.
for (const spec of TOOL_SPECS) {
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      annotations: spec.annotations,
    },
    async (args, reqCtx) => { /* … MRTR turu … */ },
  );
}
```

`src/mcp/v1/server.ts:85-86` **birebir aynı döngüyü** çalıştırır; farkı yalnızca
handler gövdesindedir. Sekiz tool iki kez tarif edilmez.

Ve iş mantığı MCP'yi hiç bilmez:

```typescript
// servers/typescript/src/core/toolimpl.ts:188-198
export async function runListOpenWork(
  ctx: ToolContext,
  args: ListOpenWorkArgs,
  signal?: AbortSignal,
): Promise<ListOpenWorkResult> {
  return ctx.xurrent.listOpenWork(
    {
      personId: args.personId ?? "$me",
      include: args.include ?? ["requests", "tasks"],
      // view HER ZAMAN açıkça geçilir; varsayılana güvenmek TUZAK 2'dir.
      // …
```

`src/tools/list-open-work.ts` artık **üç satırdır** — sadece yeniden dışa aktarım:

```typescript
// servers/typescript/src/tools/list-open-work.ts:1-3  (dosyanın TAMAMI)
/** xurrent_list_open_work — İNCE SARMALAYICI. İş mantığı: core/toolimpl.ts */
export { runListOpenWork, renderListOpenWork } from "../core/toolimpl.js";
export const NAME = "xurrent_list_open_work";
```

Şema kuralı `core/schemas.ts` başında yazılı:

```typescript
// servers/typescript/src/core/schemas.ts:4-10  (dosya başı yorumu)
// MCP SDK KURALI: registerTool'un inputSchema/outputSchema alanları ZodRawShape
// ister — yani ÇIPLAK bir nesne ({ a: z.string() }), z.object({...}) DEĞİL.
// z.object geçirmek "shape" beklenen yerde tip hatası ya da bozuk JSON Schema üretir.
//
// outputSchema verildiğinde SDK, dönen structuredContent'i bu şemaya karşı
// DOĞRULAR. Bu ücretsiz bir sözleşme testidir: alan adını yanlış yazarsan
// tool çağrısı çalışma anında patlar, sessizce yanlış veri dönmez.
```

### Python — düşük seviye `Server`, şema **elle** verilir

Python'daki en dikkat çekici karar: **FastMCP (yeni adıyla `MCPServer`)
kullanılmadı.** Gerekçe dosya başında:

```python
# servers/python/src/xurrent_mcp/server.py:11-15  (modül docstring'i)
# BURADA NEDEN MCPServer (eski FastMCP) DEGIL de dusuk seviye Server:
# MCPServer, inputSchema'yi fonksiyon imzasindan URETIR. Bizim sozlesmemiz
# contract/tools.json'da BIREBIR tanimli (default'lar, enum'lar, pattern'ler,
# additionalProperties:false). Sema uretimine birakmak sozlesme testini kirar.
# Dusuk seviye Server bize semayi ELLE verme imkani sagliyor.
```

Tool tanımları bir veri yapısından üretilir, dekoratörden değil:

```python
# servers/python/src/xurrent_mcp/mcp/common.py:27-58  (kesilerek)
def tool_definitions() -> list[types.Tool]:
    """8 tool'u MCP Tool nesnelerine cevirir — SOZLESMEDEKI SIRAYLA.

    Sira DETERMINISTIK olmak zorundadir: v2 spec'i bunu acikca ister cunku
    tool listesi LLM prompt'unun basina girer ve sira degisirse prompt cache
    isabeti kaybolur. TOOLS listesi contract/tools.json sirasindadir.
    """
    out: list[types.Tool] = []
    for spec in TOOLS:
        # … teaching_notes description'a eklenir …
        out.append(
            types.Tool(
                name=spec.name,
                description=description,
                input_schema=spec.input_schema,
                # 8/8 tool outputSchema BEYAN EDER. Beyan etmeden
                # structuredContent gondermek client tarafinda dogrulanamaz bir
                # veri demektir; sozlesmenin yarisini bosa dusurur.
                output_schema=spec.output_schema,
                annotations=types.ToolAnnotations(...),
            )
        )
    return out
```

Şemaları elle yazmanın bedeli ve karşılığı `core/schemas.py` başında belgelenmiş —
ve içinde JSON Schema'yı ilk kez tools/list'e koyan herkesi yakalayan bir tuzak var:

```python
# servers/python/src/xurrent_mcp/core/schemas.py:9-12  (docstring'ten)
# NEDEN $defs HER SEMANIN ICINE KOPYALANIYOR: `$ref: "#/$defs/Person"` ifadesi
# BULUNDUGU DOKUMANIN kokune gore cozulur. tools/list'te her tool'un outputSchema'si
# ayri bir dokumandir; ortak bir dosyaya isaret edemez. Bu yuzden kullanilan
# tanimlar her semanin kokune kopyalanir — semalar KENDI KENDINE YETERLIDIR.
```

> **Python'ın klasik `snake_case` tuzağı — ve nasıl kaçınıldığı.** FastMCP
> kullanılsaydı parametre adları Python tanımlayıcısı olacağı için şemaya
> `person_id` diye çıkardı; sözleşme `personId` diyor. Şema elle verildiği için bu
> tuzak **hiç yaşanmıyor**: `args.get("personId")` bir sözlük anahtarıdır.
> Güvenlik ağı yine de duruyor — `node scripts/verify-contract.mjs --all` bu farkı
> yakalar.

### C# — attribute + metot imzası, şema **türetilir**

C# tarafında adaptörün ince olduğu doğrudan dosya başında yazıyor:

```csharp
// servers/csharp/Mcp/McpTools.cs:33-40  (sınıf docstring'i, kesilerek)
/// ★ MCP ADAPTÖR KATMANI — ince olması KASITLIDIR.
///
/// Burada iki iş yapılır ve sadece iki iş:
///   1) Core/ToolImpl.cs'in ürettiği sonucu CallToolResult'a çevirmek
///      (structuredContent + okunabilir Türkçe metin — K2).
///   2) ToolImpl'in ürettiği ConfirmationRequest'i AKTİF PROTOKOLE çevirmek
```

Ve tool metodu tam olarak o iki işi yapıyor:

```csharp
// servers/csharp/Mcp/McpTools.cs:171-188
private static async Task<CallToolResult> ListOpenWork(
    IXurrentAdapter adapter,                        // ← DI ile enjekte edilir, şemaya GİRMEZ
    [Description("Person node ID veya '$me'. Varsayılan '$me'.")]
    string personId = "$me",
    [Description("Hangi kayıt tipleri çekilsin: 'requests' ve/veya 'tasks'. Varsayılan ikisi birden.")]
    string[]? include = null,
    [Description("Sayfa boyutu (1-100). Varsayılan 25.")]
    int first = 25,
    [Description("Request sayfalama cursor'ı")] string? afterRequests = null,
    [Description("Task sayfalama cursor'ı")] string? afterTasks = null,
    [Description("'all' (varsayılan) veya 'current_account'. VARSAYILANI 'all' YAPTIK çünkü " +
                 "Xurrent'ın kendi varsayılanı 'current_account'tur ve kişinin diğer hesaplardaki işlerini gizler.")]
    string view = "all",
    CancellationToken ct = default)
{
    var r = await ToolImpl.ListOpenWorkAsync(adapter, personId, include, first, afterRequests, afterTasks, view, ct);
    return Ok(Narrate.ListOpenWork(r), r);   // ← metin + structuredContent, ikisi birden
}
```

```csharp
// servers/csharp/Mcp/McpTools.cs:533-545
private static CallToolResult Ok<T>(string text, T structured) => new()
{
    Content = [new TextContentBlock { Text = text }],
    StructuredContent = JsonSerializer.SerializeToElement(structured, Json.Options),
};

/// <summary>İş kuralı hatası: isError=true + Türkçe açıklama. structuredContent YİNE döner.</summary>
private static CallToolResult Failure<T>(string text, T structured) => new()
{
    Content = [new TextContentBlock { Text = text }],
    StructuredContent = JsonSerializer.SerializeToElement(structured, Json.Options),
    IsError = true,
};
```

İki ayrıntı:

1. **`IXurrentAdapter adapter` bir tool parametresi değildir.** SDK, DI
   konteynerinden çözülen parametreleri şemaya koymaz — `tools/list` çıktısında
   görünmez. TypeScript'in closure, Python'un açık parametre ile taşıdığı bağımlılık
   burada framework tarafından çözülür.
2. **`[Description]` metinleri şemanın parçasıdır.** LLM'in tool'u nasıl
   kullanacağını öğrenmesinin tek yolu bu metinlerdir; bu yüzden tuzak açıklamaları
   doğrudan attribute'un içine yazıldı.

### Üç blok yan yana

| | TypeScript | Python | C# |
|---|---|---|---|
| Şema nereden gelir | `core/schemas.ts` — **Zod, elle** | `core/schemas.py` — **ham JSON Schema, elle** | Metot imzası + `[Description]` — **türetilir** |
| Tool kaydı | `TOOL_SPECS` üzerinde döngü → `registerTool` | `TOOLS` → `tool_definitions()` | `AddXurrentTools()` — açık ad→delege tablosu |
| Sözleşme sırası | Döngü sırası (deterministik) | `TOOLS` listesi sırası (deterministik) | Tablodaki sıra (deterministik) |
| Bağımlılık | Closure (`ToolContext`) | Açık parametre (`Runtime`) | **DI** (`IXurrentAdapter`) |
| İş mantığı nerede | `core/toolimpl.ts` | `core/toolimpl.py` | `Core/ToolImpl.cs` |
| Metin üretimi | `renderListOpenWork()` | `core/toolimpl.py` | `Narrate.ListOpenWork()` |

**Üçünde de aynı olan:** tool adı, parametre adları, `view` varsayılanı, "neden
`all`" yorumu — ve **iş mantığının protokolden ayrı durması.** Bu son madde
kozmetik değil: protokol revizyonu geldiğinde yalnızca sağdaki sütun değişti
([09](09-protokol-gecisi.md#maliyet)).

**Farklı olan:** şemanın nasıl tarif edildiği. Burada üç ekosistem iki felsefe
gösteriyor: *açıkça yaz* (TS, Python) ve *imzadan üret* (C#). Bu proje sözleşmeyi
birebir korumak zorunda olduğu için Python'da bilinçli olarak **açık** tarafı seçti
— dilin kolay yolunu değil.

---

## SDK karşılaştırma tablosu

| | **TypeScript** | **Python** | **C#** |
|---|---|---|---|
| Paket | `@modelcontextprotocol/sdk` **+** `@modelcontextprotocol/{core,server,client}` | `mcp` | `ModelContextProtocol` (NuGet) |
| Sürüm (repo'da) | **`1.30.0`** (v1) + **`^2.0.0`** (v2) | **`2.0.0`** | **`2.0.0`** (+ `.AspNetCore`) |
| **★ Protokol desteği** | **İki paket kümesi yan yana.** `sdk@1.30.0` tek başına yalnızca `2025-11-25` konuşur — `server/discover` → `-32601` | **Tek paket, ikisi de** | **Tek paket, ikisi de** |
| Dil sürümü | Node ≥ 22, ESM | Python ≥ 3.13 | .NET 10 (`net10.0`) |
| Sunucu tipi | `McpServer` | **düşük seviye `Server`** (FastMCP değil) | `AddMcpServer()` + DI |
| Tool kaydı | `TOOL_SPECS` üzerinde `registerTool` döngüsü | `on_list_tools` / `on_call_tool` handler'ları | **Açık** ad→delege tablosu (`AddXurrentTools()`) |
| **Şema tanımı** | **Zod** shape'i | **Ham JSON Schema** (sözlük) | Girdi: imza + `[Description]` · Çıktı: sözleşmeden |
| Şema kaynağı | Açık (elle yazılır) | **Açık (elle yazılır)** | Karma |
| `outputSchema` | `registerTool` seçeneği | `types.Tool(output_schema=…)` | `ToolContracts.Load()` → `contract/tools.json` |
| Sıra determinizmi | Döngü sırası | `TOOLS` listesi sırası | Tablo sırası (**assembly taraması değil**) |
| Async modeli | `async/await`, tek thread event loop | `asyncio`, `async def` | `Task<T>`, `CancellationToken` |
| Transport (stdio) | `StdioServerTransport` | `stdio_server()` context manager | `.WithStdioServerTransport()` |
| Transport (HTTP) | `StreamableHTTPServerTransport` | `server.streamable_http_app()` + uvicorn | `.WithHttpTransport()` (AspNetCore paketi) |
| Onay (v1) | `server.server.elicitInput({...})` | onay politikası `write_tools` içinde | onay kanalı agent katmanında |
| Log hedefi | `console.error` | `logging.basicConfig(stream=sys.stderr)` | `AddConsole(LogToStandardErrorThreshold)` |
| Bağımlılık enjeksiyonu | Elle (closure — `ToolContext`) | Elle (açık parametre — `Runtime`) | **Yerleşik** (`IServiceProvider`) |
| Yapılandırma | `process.env` | `os.environ` | `Env(...)` sarmalayıcısı |
| Derleme | `tsc` → `dist/` | yok (yorumlanır) | `dotnet build` |
| Çalıştırma | `node dist/mcp/stdio.js` | `uv run xurrent-mcp` | `dotnet run -- stdio` |

> ### ★ Protokol desteği satırı neden en önemlisi
>
> Bu satır **ölçülmüştür**, okunmamıştır: üç sunucuya ham JSON-RPC `server/discover`
> ve `initialize` istekleri gönderilip cevapları kaydedildi.
>
> Sonuç, projenin bağımlılık planını değiştirdi: **resmî SDK'ların 2.0.0 sürümü iki
> protokol revizyonunu da kendisi konuşuyor.** Yani Python ve C# tarafında **iki SDK
> sürümü** yüklemek gerekmedi — tek paket yetti. TypeScript'te ise `sdk@1.30.0`
> `server/discover`'ı hiç bilmediği için v2 paketleri **yanına** kuruldu.
>
> Dikkat: bu, "iki adaptör gerekmedi" demek **değil**. Üç dil de iki adaptör yazdı
> — çünkü fark protokol sürümünde değil, **onay akışında**: v1'de bir `await`,
> v2'de bir `return`.
>
> Ölçümün ham tablosu ve çıkarımı:
> [09 — Ölçüm sonucu](09-protokol-gecisi.md#olcum).

---

## Transport kurulumu — üç dil

Üçünde de aynı iki satır: sunucuyu kur, stdio transport'a bağla.

### TypeScript

Tek giriş noktası, `MCP_PROTOCOL`'e göre iki adaptörden birini kuruyor:

```typescript
// servers/typescript/src/mcp/stdio.ts:40-54
if (cfg.mcpProtocol === "2025-11-25") {
  const { server } = createV1Server(cfg);
  const transport = new StdioServerTransport();     // @modelcontextprotocol/sdk@1.30.0
  await server.connect(transport);
  log.info("stdio transport bağlandı (v1 / 2025-11-25)");
  return;
}

// v2: serveStdio bağlantının era'sını sahiplenir ve fabrikadan TEK bir örneği
// bağlantı ömrü boyunca sabitler. legacy:'serve' varsayılanı sayesinde eski
// bir client düz initialize gönderse bile cevapsız kalmaz.
serveStdio(() => createV2Server(cfg).server, {          // @modelcontextprotocol/server@2.0.0
  onerror: (err) => log.error("v2 stdio hatası", { error: err.message }),
});
log.info("stdio transport bağlandı (v2 / 2026-07-28)");
```

> **`MCP_PROTOCOL=both` stdio'da GEÇERSİZDİR** — ve hata mesajı bunu açıklıyor:
>
> ```
> // servers/typescript/src/mcp/stdio.ts:28-36
> Sebep: stdio tek bir çift yönlü borudur; iki protokol revizyonunu aynı boruda
> ayrıştıracak bir yol adresi (path) yoktur. Seçenekler:
>   • MCP_PROTOCOL=2026-07-28  (varsayılan, güncel revizyon)
>   • MCP_PROTOCOL=2025-11-25  (eski revizyon)
>   • İkisini birden sunmak için HTTP kullanın: npm run http
>     → /mcp/v1 ve /mcp/v2 yolları aynı anda açılır.
> ```
>
> Sessizce bir tanesini seçmek yerine **çıkış kodu 2 ile durur.** Yanlış
> yapılandırmayı sessizce "düzeltmek", saatler sonra anlaşılmaz bir davranışa
> dönüşür.

Ve altın kural artık yalnızca pratik değil:

```typescript
// servers/typescript/src/mcp/stdio.ts:5-8  (dosya başı yorumu)
// ALTIN KURAL: stdio'da stdout SADECE JSON-RPC içindir. Tek bir console.log
// çerçeveyi bozar ve sunucu "bağlanamıyor" görünür. Tüm loglar stderr'e gider
// (bkz. util/log.ts). 2026-07-28 revizyonu Logging'i deprecate ettiği için
// bu kural artık yalnızca pratik değil, SPEC ÖNERİSİDİR.
```

### Python

```python
# servers/python/src/xurrent_mcp/server.py:109-124
    server = Server(
        SERVER_NAME,
        version=SERVER_VERSION,
        title="Xurrent MCP (Python)",
        instructions=INSTRUCTIONS,
        on_list_tools=on_list_tools,      # ← mcp 2.0.0: dekoratör değil, CONSTRUCTOR
        on_call_tool=on_call_tool,
    )
    return server, runtime


async def run_stdio(config: Config | None = None) -> None:
    """stdio transport. stdout SADECE JSON-RPC tasir; loglar stderr'dedir."""
    server, _ = build_server(config)
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())
```

Log yönlendirmesi CLI giriş noktasında, **her moddan önce** kuruluyor:

```python
# servers/python/src/xurrent_mcp/__main__.py:21-27
def _setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        # stdout SADECE JSON-RPC tasir -> tum loglar stderr'e.
        stream=sys.stderr,
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )
```

> **mcp 2.0.0'da üç API kırılması** (`server.py:3-9` dosya başı yorumundan):
> düşük seviye `Server` artık **constructor tabanlı** handler kaydı kullanıyor;
> `mcp.types` ayrı bir `mcp_types` paketine taşındı (alan adları `snake_case`, wire'da
> `camelCase`'e serileştiriliyor); ve `FastMCP`'nin adı **`MCPServer`** oldu.
> 1.x örneklerinden kopyalanan kod bu üç noktada derlenmeden patlar.

### C#

```csharp
// servers/csharp/Program.cs:55-67
async Task<int> RunStdioAsync()
{
    // ⚠️ stdio modunda stdout SADECE JSON-RPC içindir.
    // Tek bir Console.WriteLine protokolü bozar; bu yüzden TÜM loglar stderr'e gider.
    var builder = Host.CreateApplicationBuilder();
    ServerSetup.ConfigureStdErrLogging(builder.Logging);

    builder.Services.AddXurrentServices(cfg);
    builder.Services.AddXurrentMcpServer(cfg).WithStdioServerTransport();

    await builder.Build().RunAsync(cts.Token);
    return 0;
}
```

Protokol seçimi C#'ta **tek bir `if`**'e indi — ve o `if`'in yorumu, ders açısından
satırın kendisinden değerli:

```csharp
// servers/csharp/Mcp/ServerSetup.cs:54-72  (kesilerek)
public static IMcpServerBuilder AddXurrentMcpServer(this IServiceCollection services, AppConfig cfg)
{
    // outputSchema'nın kaynağı sözleşmedir; sunucu ayağa kalkmadan yüklenmelidir.
    ToolContracts.Load(cfg.RepoRoot);

    var builder = services.AddMcpServer(options =>
    {
        options.ServerInfo = new Implementation { Name = ServerName, Version = ServerVersion };
        options.ServerInstructions = Instructions;

        // K1: yalnızca v1 istendiğinde sürüm PİNLENİR — bu durumda SDK server/discover'ı
        // reddeder ve tek yol initialize el sıkışması olur. Varsayılan (v2) pinlenmez;
        // geriye dönük uyumluluk sondasının canlı gösterilebilmesi buna bağlıdır.
        if (cfg.McpProtocol == ProtocolChoice.V1)
            options.ProtocolVersion = ProtocolV1;
    });

    // ★ Düşük seviye tool kaydı: outputSchema contract/tools.json'dan ELLE verilir.
    builder.AddXurrentTools();
```

Üç şey dikkat çekiyor:

1. **`AddXurrentTools()`, `WithToolsFromAssembly()` değil.** Assembly taraması
   tool'ların **sırasını garanti etmez**; v2 `tools/list`'in deterministik dönmesini
   şart koşuyor ([09](09-protokol-gecisi.md)). Açık kayıt, sırayı sözleşmeye bağlar.
2. **`ToolContracts.Load(...)` sunucu ayağa kalkmadan çalışır.** `outputSchema`'nın
   kaynağı sözleşme dosyasıdır; eksikse sunucu **başlamaz**, sessizce şemasız tool
   yayınlamaz.
3. **v2'de sürüm PİNLENMEZ.** Pinlenirse geriye dönük uyumluluk sondası ölür —
   sihirbazın canlı gösterdiği pazarlık tam olarak buna bağlı.

```csharp
// servers/csharp/Mcp/ServerSetup.cs:95-105
/// <summary>
/// stdio modunda logların TAMAMI stderr'e gider.
/// NEDEN: stdio transport'ta stdout SADECE JSON-RPC içindir. Tek bir Console.WriteLine
/// protokolü bozar ve client "invalid message" ile bağlantıyı düşürür.
/// </summary>
public static void ConfigureStdErrLogging(ILoggingBuilder logging)
{
    logging.ClearProviders();
    logging.AddConsole(o => o.LogToStandardErrorThreshold = LogLevel.Trace);
    logging.SetMinimumLevel(LogLevel.Warning);
}
```

> ### ⚠️ C#'ta en kolay düşülen tuzak
>
> `Host.CreateApplicationBuilder` varsayılan olarak **stdout'a** log basar. Tek bir
> bilgi satırı JSON-RPC akışına karışır ve istemci bağlantıyı
> `Unexpected token ... in JSON` ile düşürür.
>
> Yukarıdaki üç satır — `ClearProviders()` + `LogToStandardErrorThreshold` +
> `SetMinimumLevel` — bu hatanın panzehiridir.
>
> TypeScript ve Python'da tuzak daha görünür: `console.log` / `print` yazmamak
> yeterli. C#'ta framework senin adına yazıyor.

### ★ C#'ın kendine özgü çözümü: süreç içi MCP oturumu

Sihirbaz ve chatbot C# tarafında tool'ları **doğrudan metot çağrısıyla** kullanmıyor.
İki pipe üzerinden **gerçek JSON-RPC** konuşuyorlar:

```csharp
// servers/csharp/Mcp/ServerSetup.cs:108-144  (kesilerek)
/// <summary>
/// SÜREÇ İÇİ MCP oturumu: sunucu ve client aynı process'te, iki pipe üzerinden
/// GERÇEK JSON-RPC konuşur.
///
/// NEDEN böyle: sihirbaz ve chatbot, tool'ları doğrudan C# metodu olarak çağırsaydı
/// MCP katmanı test EDİLMEMİŞ olurdu. Bu kurulumla ders sırasında gösterilen her çıktı
/// gerçekten protokolden geçer — tools/list sayısı da dahil.
/// </summary>
public sealed class InProcessMcpSession : IAsyncDisposable
{
    /// <summary>
    /// Sunucu onay istediğinde çağrılır. HOST tarafının işidir: kullanıcıya sormak.
    /// Atanmamışsa FAIL-CLOSED davranırız — cevapsızlık ONAY DEĞİLDİR.
    /// (Sihirbaz bunu atamaz; chatbot terminal/web arayüzüne bağlar.)
    /// </summary>
    public Func<ElicitRequestParams, CancellationToken, ValueTask<bool>>? OnConfirm { get; set; }

    public static async Task<InProcessMcpSession> StartAsync(AppConfig cfg, CancellationToken ct = default)
    {
        // client -> server ve server -> client yönleri için iki ayrı pipe.
        var clientToServer = new Pipe();
        var serverToClient = new Pipe();
        // …
        builder.Services.AddXurrentMcpServer(cfg)
            .WithStreamServerTransport(clientToServer.Reader.AsStream(), serverToClient.Writer.AsStream());
        // …
    }
}
```

İki ders bir arada:

- **"Protokolden geçiyor" iddiası, protokolden geçirilerek kanıtlanıyor.** Alt süreç
  açmadan, port dinlemeden — ama gerçek JSON-RPC ile.
- **`OnConfirm` atanmamışsa fail-closed.** *"Cevapsızlık ONAY DEĞİLDİR"* satırı,
  [03](03-mcp-tasarimi.md#onay)'teki `cancel` ≠ `accept` kuralının kod hâli.

---

## Onay mekanizması — üç dil

Onay diyaloğu ([03](03-mcp-tasarimi.md#onay)). Üç dilde de aynı üç sonuç ele alınır:
`accept` · `decline` · `cancel` — artı dördüncü bir durum: `unsupported`.

### TypeScript — elicitation, gerçek kod

```typescript
// servers/typescript/src/mcp/v1/server.ts:33-67  (kesilerek)
/**
 * ToolOutcome'un "confirm" hâlini protokole çevirir: elicitation/create.
 * Client bu yeteneği bildirmemişse "unsupported" döner ve politika devreye girer
 * (core/context.ts → resolveUnsupportedConfirm).
 */
async function askViaElicitation(server: McpServer, outcome: Extract<ToolOutcome, { kind: "confirm" }>): Promise<ConfirmOutcome> {
  const caps = server.server.getClientCapabilities();
  if (!caps?.elicitation) return { action: "unsupported" };      // ← feature-detect

  try {
    const res = await server.server.elicitInput({                // ← AWAIT: istek burada BEKLER
      message: `${outcome.prompt.summary}\n\n${detail}\n\nOnaylıyor musunuz?`,
      // requestedSchema DÜZ JSON Schema'dır — Zod DEĞİL ve İÇ İÇE NESNE İÇEREMEZ.
      // Spec yalnızca ilkel alanlara (string/number/boolean/enum) izin verir.
      requestedSchema: outcome.schema as never,
    });

    // Üç action'ın ÜÇÜ DE ele alınır. accept + onay=false da bir REDDİR.
    if (res.action === "accept") {
      const content = res.content as Record<string, unknown> | undefined;
      if (content?.["onay"] === true) return { action: "accept" };
      const reason = content?.["gerekce"];
      return { action: "decline", ...(typeof reason === "string" && reason ? { reason } : {}) };
    }
    if (res.action === "decline") return { action: "decline" };
    return { action: "cancel" };
  } catch (err) {
    log.warn("elicitation başarısız", { error: err instanceof Error ? err.message : String(err) });
    return { action: "unsupported" };
  }
}
```

v2 adaptöründe **aynı yerde bir `return` var** — `inputRequired({...})`. Farkın
tamamı budur ([09](09-protokol-gecisi.md#mrtr)). `outcome.schema`'nın her iki
adaptörde de aynı `core/` nesnesinden gelmesi tesadüf değil: onay formu iş
mantığına aittir, protokole değil.

İki ayrıntı sentetik örneklerde kolayca kaçırılır ve ikisi de burada var:

1. **`requestedSchema` düz JSON Schema'dır, Zod değil** — ve **iç içe nesne
   içeremez.** Spec yalnızca ilkel alanlara izin verir. Zod geçirmek sessizce bozuk
   şema üretir.
2. **`accept` + `onay: false` bir REDDİR.** Kullanıcı diyaloğu "kabul edip" kutuyu
   işaretlememiş olabilir. `action === "accept"` kontrolü tek başına **yetmez** —
   içeriğe de bakmak gerekir. Bu, elicitation ile ilgili en sık atlanan kontroldür.

### Onay bir BAĞIMLILIK olarak enjekte edilir

TypeScript tarafındaki asıl tasarım kararı, elicitation çağrısının kendisi değil,
**nereye konmadığı**:

```typescript
// servers/typescript/src/core/context.ts:1-11  (dosya başı yorumu)
// TASARIM KARARI — onay (confirm) bir BAĞIMLILIK olarak enjekte edilir:
//   - MCP sunucusunda   → protokol seviyesinde elicitation
//   - Sihirbazda        → terminalde readline sorusu
//   - Chatbot'ta        → terminalde readline sorusu
// Böylece "yazmadan önce onay al" kuralı tek bir yerde yaşar ve taşıyıcıya
// (transport) göre değişmez. Onayı LLM'e bırakmıyoruz: LLM ikna edilebilir,
// protokol seviyesindeki onay edilemez.
```

**Bu satırlar, protokol revizyonunun neden ucuz atlatıldığının cevabıdır.**
`ConfirmFn` bir arayüz olduğu için v1'in `elicitation/create`'i ile v2'nin
MRTR turu **aynı yere takılır**; iş mantığı ikisini de bilmez
([09 — Breaking change bize kaça mal oldu](09-protokol-gecisi.md#maliyet)).

### Fail-closed politikası — üç dilde tek kural

```typescript
// servers/typescript/src/core/context.ts:57-78  (kesilerek)
/**
 * Client onay soramıyorsa (elicitation yok / MRTR yeteneği bildirilmemiş) politika.
 *
 * ÜÇ DİLDE DE AYNI KURAL:
 *   live + closed → REDDET  (varsayılan, güvenli)
 *   live + open   → devam et, uyarı bas
 *   mock          → HER ZAMAN devam et
 */
export function resolveUnsupportedConfirm(cfg: AppConfig): { allowed: boolean; message: string } {
  if (cfg.mode === "mock") {
    return { allowed: true, message: "… MOCK modda çalışıldığı için yazma ENGELLENMEDİ — " +
      "fixtures/ klasörüne yazılıyor, gerçek bir kayıt sistemi etkilenmiyor. Live modda bu istek REDDEDİLİRDİ." };
  }
  if (cfg.confirmPolicy === "open") { /* devam + uyarı */ }
  /* aksi hâlde: allowed: false */
}
```

Python aynı kararı, aynı gerekçeyle veriyor:

```python
# servers/python/src/xurrent_mcp/tools/write_tools.py:160-180  (kesilerek)
    # Onay politikasi: elicitation desteklemeyen bir client'ta yazma politikasi.
    # NEDEN yalnizca live modda bloklar: mock modda yazma zararsizdir ve ders
    # akisini kirmamalidir; yine de uyari uretiriz.
    if not dry_run and config.confirm_policy == "closed":
        if config.is_live:
            errors.append(ValidationError(
                message="XURRENT_CONFIRM_POLICY=closed ve client onay (elicitation) "
                        "desteklemiyor -> canli yazma REDDEDILDI. …",
                path=["confirmPolicy"],
            ))
        else:
            warnings.append(
                "Mock modda calisiyoruz; canli modda bu yazma icin protokol seviyesinde "
                "onay (elicitation) istenirdi. Onay diyalogunu LLM'e birakmiyoruz — "
                "LLM ikna edilebilir, protokol seviyesindeki onay edilemez."
            )
```

C# tarafında aynı kural agent katmanındaki onay kanalında yaşar
(`servers/csharp/Agent/AgentCore.cs`, `servers/csharp/Agent/WebHost.cs`):

```csharp
// servers/csharp/Agent/AgentCore.cs:403-404
// Bu kanal olmasaydı XURRENT_CONFIRM_POLICY=closed gereği yazma REDDEDİLİRDİ.
if (cfg.XurrentConfirmPolicy == "open") return Task.FromResult(true);
```

> ### Neden mock modda engellemiyoruz?
>
> Mock modda fail-closed davranmanın **hiçbir güvenlik karşılığı yoktur**: ortada
> yazılacak gerçek bir system of record yok, `fixtures/` klasörü var. Buna karşılık
> bedeli büyük — dersin 11. adımı (gerçek yazma) etkileşimsiz ortamlarda hiç
> çalışmaz ve **üç dil farklı sonuç üretir.**
>
> Sihirbazın "üç dil aynı çıktıyı verir" iddiası, tam da bu tür ince davranış
> farklarında kırılır. Kararı üçünde de aynı vermek bir uyum meselesi değil,
> **tezin kendisini korumak.**

---

## Async modeli — asıl fark burada

Şema tanımlama farkları kozmetik. Async modeli mimariyi etkiler.

| | TypeScript | Python | C# |
|---|---|---|---|
| Model | Tek thread + event loop | `asyncio` event loop | Thread pool + `Task` |
| İptal | `AbortSignal` (elle taşınır) | `asyncio.CancelledError` | **`CancellationToken`** (yerleşik, her imzada) |
| Bulk gecikme | `await sleep(110)` | `await asyncio.sleep(0.110)` | `await Task.Delay(110, ct)` |
| Paralel | `Promise.all` | `asyncio.gather` | `Task.WhenAll` |
| Yarış hatası riski | Düşük (tek thread) | Düşük (tek loop) | **Var** — paylaşılan durum kilitlenmeli |

Somut örnek — rate limit için ardışık isteklerin arasına ≥110 ms koymak
([01](01-xurrent-api.md)):

```typescript
for (const entry of entries) {
  results.push(await writeOne(entry));
  await new Promise((r) => setTimeout(r, 110));  // 20 istek / 2 sn
}
```

```python
for entry in entries:
    results.append(await write_one(entry))
    await asyncio.sleep(0.110)                    # 20 istek / 2 sn
```

```csharp
foreach (var entry in entries)
{
    results.Add(await WriteOneAsync(entry, ct));
    await Task.Delay(110, ct);                    // 20 istek / 2 sn
}
```

C#'ın `CancellationToken`'ı buradaki tek gerçek avantaj: kullanıcı bulk işlemi iptal
ettiğinde `Task.Delay` **anında** kırılır. TypeScript'te aynı davranış için
`AbortSignal`'i elle taşımak gerekir.

---

## Hangi dilde ne kolay, ne zor?

### TypeScript

| ✅ Kolay | ❌ Zor |
|---|---|
| MCP SDK en olgun ve en çok örnekli | Derleme adımı gerekli (`tsc` → `dist/`) |
| Zod şemaları **açık ve okunur** — sözleşmeyi kodda görürsün | ESM/CJS ayrımı hâlâ can sıkar |
| JSON yerli veri tipi; adapter'lar ince | Çalışma zamanı tip güvenliği yok — Zod ile sen kurarsın |
| Web arayüzü aynı dilde | |

### Python

| ✅ Kolay | ❌ Zor |
|---|---|
| **En az kod.** Şema tip ipuçlarından türer | Türetilmiş şema = daha az kontrol (`camelCase` sorunu) |
| `uv` ile kurulum tek komut | Runtime tip hatası ancak Pydantic yakalarsa görülür |
| Fixture okuma / tarih işleme çok kısa | Tarih/saat dilimi ekosistemi dağınık (`zoneinfo` vs 3. parti) |
| Chatbot ile aynı dil (`anthropic` SDK) | |

### C#

| ✅ Kolay | ❌ Zor |
|---|---|
| **En güçlü tip güvenliği** — sözleşme sapması derlemede yakalanır | En fazla ceremony (proje dosyası, DI kurulumu) |
| DI yerleşik — adapter değiştirmek yapılandırma işi | **stdout logging tuzağı** (yukarıda) |
| `CancellationToken` her yerde | JSON ↔ nesne dönüşümü elle tanımlanır |
| `dotnet run` tek komut | |

### Ders için hangisi?

Sözleşme belliyse **üçü de eşit**. Bu bölümün amacı bir kazanan ilan etmek değil —
**seçimin bir detay olduğunu göstermek.** Kanıt:

```bash
node scripts/verify-contract.mjs --all
```

Üç sunucunun `tools/list` çıktısını [`contract/tools.json`](../contract/tools.json)'a
karşı doğrular. Geçerse, üçü aynı sözleşmeyi uyguluyor demektir — iddia değil, test.

Ve sihirbaz aynı şeyi çıktı seviyesinde kanıtlar:

```bash
node clients/wizard/wizard.mjs --server ts
node clients/wizard/wizard.mjs --server py
node clients/wizard/wizard.mjs --server cs
```

Aynı 14 adım, aynı sayılar: `requests.totalCount = 3`, `timeIncrement = 30`,
`busyMinutes = 225`, `planned.length = 2`.

Ve sihirbazın adım sonucu **üç durumludur**: `PASS` · `FAIL` · `SKIP`. Bir kontrol
ön koşulu sağlanmadığı için çalıştırılamıyorsa bu bir **`SKIP`**'tir, `FAIL` değil —
özet satırı bu yüzden *"N geçti, M başarısız, K atlandı"* biçimindedir. Bir dilin
`SKIP`, diğerinin `FAIL` vermesi tek başına bir sözleşme sapması sinyalidir
([07](07-sihirbaz.md)).

---

## Ortaklaştırılan üç şey

Üç dilin **tekrar etmediği** şeyler de bir tasarım kararıdır:

| Ortak varlık | Neden üç kez yazılmadı |
|---|---|
| [`contract/tools.json`](../contract/tools.json) | Sözleşme tek olmalı; üç kopya üç kez sapar |
| [`contract/protocol.md`](../contract/protocol.md) | Çift protokol kuralları — hangi revizyonun nasıl ele alınacağı üç dilde aynı |
| [`fixtures/*.json`](../fixtures/) | Aynı veri → aynı çıktı. Kanıt bu |
| [`docs/wizard/steps.json`](wizard/steps.json) | Ders akışı; sihirbaz üç sunucuya da bağlanır |
| `~/.xurrent-mcp/google-token.json` | OAuth akışı **bir kez** (`scripts/google-auth.mjs`); üç dil token'ı okur ve yenilemeyi düz bir HTTP POST'a indirir |

Son satır özellikle önemli: **"üç dilde yaz" derken neyi yazmayacağını seçmek de
mimaridir.** OAuth kütüphanesini üç kez implemente etmek üç kat bakım demekti; onun
yerine tek script + üç HTTP POST seçildi.

---

## Özet

| Konu | Sonuç |
|---|---|
| Şema tanımı | Zod (açık) · ham JSON Schema (açık) · attribute (türetilmiş) |
| **Protokol desteği** | ts `1.30.0` → yalnızca `2025-11-25` · py/cs `2.0.0` → **ikisi de** |
| En az kod | Python |
| En güçlü tip güvenliği | C# |
| En olgun SDK / en çok örnek | TypeScript — ama **protokol sürümünde geride** |
| Ortak tuzak | **stdout yalnızca JSON-RPC** — C#'ta framework kaynaklı |
| Async farkı | `CancellationToken` C#'ta yerleşik, diğerlerinde elle |
| Onay katmanı | Üçünde de **enjekte edilen bağımlılık** — protokol değişince yalnız o katman değişti |
| Sözleşme uyumu | `scripts/verify-contract.mjs --all` ile **test edilir** |
| Tez | Sözleşme netse dil bir detaydır — **SDK'nın protokol sürümü ise detay değildir** |

> **Son satırın hikâyesi.** Bu bölümün ilk sürümü "dil bir detaydır" diye
> bitiyordu. Ölçüm bir istisna ekledi: dil bir detay, ama **SDK sürümü değil.**
> Aynı sözleşmeyi uygulayan üç sunucudan biri, yalnızca SDK'sı eski olduğu için
> güncel protokol revizyonunu konuşamıyor. Tezi çürütmüyor — **sınırını çiziyor.**

Sıradaki bölüm dersin kendisini yürüten aracı anlatıyor:
[07 — Sihirbaz](07-sihirbaz.md).

Protokol revizyonunun ne getirip ne götürdüğü ve ölçümün ham tablosu:
[09 — Protokol geçişi](09-protokol-gecisi.md).
