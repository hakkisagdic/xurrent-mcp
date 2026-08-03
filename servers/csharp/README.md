# servers/csharp — C# / .NET implementasyonu

`contract/tools.json` sözleşmesinin C# karşılığı. TypeScript ve Python sunucularıyla
**aynı 8 tool'u, aynı parametre adlarıyla, aynı çıktı alanlarıyla** sunar ve
`fixtures/` klasöründeki aynı veriyi okuyarak **aynı sayıları** üretir.

## Çalıştırma

```bash
dotnet build

dotnet run -- stdio       # MCP sunucusu, stdio transport (VARSAYILAN — .mcp.json bunu kullanır)
dotnet run -- http        # MCP sunucusu, Streamable HTTP (MCP_HTTP_PORT, varsayılan 8788)
dotnet run -- wizard      # Sihirbaz / ders modu — API key GEREKMEZ
dotnet run -- chat        # Terminal chatbot   (GEMINI_API_KEY gerekir)
dotnet run -- web         # Web arayüzü        (WEB_PORT, varsayılan 8787)
dotnet run -- sema-testi  # Şema çevirisi ders artefaktı (tablo + örnek çıktı) — API key GEREKMEZ

dotnet test XurrentMcp.Tests   # ★ Çekirdek iş mantığının birim testleri — API key GEREKMEZ
```

`wizard` modu `docs/wizard/steps.json` dosyasını süreç içi bir MCP client ile yürütür:
sunucu ve istemci aynı process'te iki pipe üzerinden **gerçek JSON-RPC** konuşur.
Yani derste gösterilen her çıktı protokolden geçer — doğrudan metot çağrısı yoktur.

Sihirbaz özeti **üç durumludur**: `N geçti, M başarısız, K atlandı`. Bir kontrol ön koşulu
sağlanmadığı için çalıştırılamıyorsa **SKIP**'tir, FAIL değil.

## Dosya düzeni

| Yol | İçerik |
|---|---|
| `Config.cs` | Tüm ortam değişkenleri + JSON serileştirme ayarları (`UnsafeRelaxedJsonEscaping`) |
| `Models.cs` | `contract/tools.json` `$defs` bölümünün birebir C# karşılığı |
| `TimeUtil.cs` | Saat dilimi / ISO8601 / interval merge / yuvarlama yardımcıları |
| `Core/ToolImpl.cs` | ★ **8 tool'un SAF hâli** — protokolden bağımsız. MCP tipi İÇERMEZ |
| `Core/Confirm.cs` | ★ `ConfirmationRequest` + **HMAC-SHA256 imzalı `requestState`** üretimi/doğrulaması |
| `Core/ToolContracts.cs` | `contract/tools.json`'dan `outputSchema` yükleyici + deterministik sıra |
| `Core/Narrate.cs` | Her sonucun okunabilir **Türkçe** metin karşılığı |
| `Core/Matcher.cs` | Toplantı başlığı ↔ açık iş eşleştirme heuristiği (üç yollu, açıklanabilir) |
| `Xurrent/Queries.cs` | GraphQL sorgu ve mutation metinleri — dry-run çıktısında birebir gösterilir |
| `Xurrent/MockAdapter.cs` | `fixtures/` okuyucu; yazmalar bellekte birikir |
| `Xurrent/LiveAdapter.cs` | Gerçek Xurrent GraphQL istemcisi |
| `Xurrent/Strategies.cs` | ★ İki yol, üç backdate stratejisi |
| `Xurrent/Validate.cs` | Yazma öncesi ön kontroller (timeIncrement, T-1, mesai sınırı…) |
| `Calendar/*` | mock / ics / google / graph sağlayıcıları + ortak normalizasyon |
| `Mcp/McpTools.cs` | ★ **İnce MCP adaptörü**: sonucu `CallToolResult`'a, onayı protokole çevirir |
| `Mcp/ServerSetup.cs` | DI kaydı, protokol seçimi, tools/list cache metadata'sı, süreç içi oturum |
| `Llm/GeminiClient.cs` | Gemini `generateContent` istemcisi — düz `HttpClient`, SDK yok |
| `Llm/SchemaTranslator.cs` | ★ **MCP JSON Schema 2020-12 → Gemini functionDeclarations** çevirisi + ne atıldığının kaydı |
| `Llm/SchemaSelfTest.cs` | `dotnet run -- sema-testi` — çeviri tablosunu ve örnek çıktıyı basan ders artefaktı |
| `Agent/*` | Chatbot beyni + web sunucusu (`clients/web/API.md` sözleşmesi) |
| `Wizard.cs` | Ders akışı yürütücüsü |
| `XurrentMcp.Tests/` | ★ **Birim testleri** (xunit) — çekirdek iş mantığı, ağsız ve saatten bağımsız |

## ★ Birim testleri

```bash
dotnet test XurrentMcp.Tests
```

Sihirbaz, sözleşme doğrulayıcı ve senaryo koşucuları **uçtan uca** çalışır: bir kenar durum
bozulduğunda çoğu zaman yine geçerler ve hata ancak üretimde görünür. Bu proje o boşluğu
kapatır — çekirdek mantığı **doğrudan** sınar.

| Dosya | Kapsam | Test |
|---|---|---|
| `StratejiTests.cs` | Üç backdate stratejisinin PLAN çıktısı; `two_step` 2. adımının ticket bağına dokunamadığı **şema seviyesinde** | 31 |
| `DogrulamaTests.cs` | `timeIncrement`, negatif süre/`correction`, 80 karakter, T-1 sınırı, mesai tavanı, yol anahtarları | 43 |
| `TakvimTests.cs` | Eleme kuralları, pencereye kırpma, interval merge, dedup anahtarı, Graph/Google alan tuzakları | 39 |
| `EslestirmeTests.cs` | Kesin/bulanık/belirsiz eşleşme — **emin olmadığında tahmin etmeme** | 13 |
| `OnayTests.cs` | `requestState`: imza, parmak izi, TTL, replay, çapraz kullanıcı | 20 |
| `ZamanTests.cs` | Saat dilimi, ISO8601, interval merge, yuvarlama | 36 |
| `PlanTests.cs` | Takvimden plan üretimi, onay kapısı (K5), toplu yazma | 38 |
| `SemaTests.cs` | `sema-testi` iddialarının gerçek test karşılığı — tool başına ayrı vaka | 89 |

**Üç kural**, üçü de kasıtlı:

1. **Ağ yok, yazma I/O yok.** Sağlayıcılar dışarıdan enjekte edilir
   (`CalendarFactory.ReadAsync(ICalendarProvider, …)`), HTTP eşleyicileri
   (`GraphCalendarProvider.MapEvent`, `GoogleCalendarProvider.MapEvent`) istekten ayrıştırıldı.
   Fixture **okumak** serbesttir — zaten üç dilin paylaştığı tek gerçek kaynak odur.
2. **Zaman enjekte edilir.** `AppConfig.Clock` üretimde `TimeProvider.System`'dir; testte
   sabitlenir. Sebebi somut: yerel saat 00:00–03:00 arasındayken (`Europe/Istanbul` = UTC+3)
   UTC tarihi **bir gün geridedir** ve bu repoda tam olarak bu yüzden gece kırılan bir
   doğrulama yaşandı. Test kendi beklentisini "şu anki gün"den üretirse, testin doğruluğu
   çalıştırıldığı **saate** bağlanır.
3. **Test adı ne doğruladığını söyler.** `test1` değil,
   `two_step_ikinci_adimda_assignment_alani_GONDERMEZ`.

Ana proje etkilenmez: `XurrentMcp.csproj` içindeki `DefaultItemExcludes` test klasörünü
ana derlemenin dışında tutar; `dotnet run` modlarının hepsi aynen çalışır.

## ★ Mimari: aynı iş mantığı, iki protokol kabuğu

```
                          ┌─ MRTR (v2)  → InputRequiredResult + imzalı requestState
Core/ToolImpl ────────────┤
  ConfirmationRequired    └─ v1         → elicitation/create isteği
```

`Core/ToolImpl.cs` bir tool'u çalıştırırken onay gerekiyorsa `ConfirmationRequest` döner —
**nasıl sorulacağını bilmez**. Bunu protokole çeviren `Mcp/McpTools.cs`'tir. Protokol
revizyonu tool sözleşmesini bozmaz; breaking change yalnızca bu ince katmanı yakalar.

## ★ outputSchema neden ELLE veriliyor?

`[McpServerTool]` attribute'u yalnızca `UseStructuredContent` bayrağını taşır ve şemayı
**dönüş tipinden ÜRETİR**. Bizim tool'larımız `CallToolResult` döndürüyor (çünkü hem
`structuredContent` hem okunabilir Türkçe metin yayınlıyorlar) → türetilecek anlamlı bir
dönüş tipi yok. SDK bu durum için açık bir kapı bırakmış:
`McpServerToolCreateOptions.OutputSchema` — ama bu alan attribute üzerinden verilemez.

Bu yüzden **düşük seviye tool kaydına** geçildi (`McpServerTool.Create(delegate, options)`)
ve şema `contract/tools.json`'un `output` alanlarından okunuyor. `{"$ref": "#/$defs/X"}`
biçimindeki tepe referanslar AÇILIR (2026-07-28 öncesi revizyonlar `outputSchema.type ==
"object"` şartı koyar) ve `$defs` bloğu şemanın içine kopyalanır.

Sonuç: **8/8 tool `outputSchema` bildirir ve `tools/call` cevabında `structuredContent` döner.**

## ★ Gemini: aynı sözleşme, iki farklı tool-calling lehçesi

Chatbot tek sağlayıcı kullanır: **Gemini**. Paket bağımlılığı **yoktur** —
`Llm/GeminiClient.cs` düz `HttpClient` + `System.Text.Json` ile konuşur:

```
POST {GEMINI_BASE_URL}/v1beta/models/{GEMINI_MODEL}:generateContent
x-goog-api-key: <anahtar>        ← ★ HEADER. Query string'e KOYULMAZ: erişim loglarına düşer.
```

Gövde dört alandır: `contents`, `tools[].functionDeclarations`, `systemInstruction`,
`generationConfig`. Üç tuzak, üçü de kodda yorumlu:

1. **Sistem promptu `contents` içine KONMAZ** — ayrı `systemInstruction` alanına konur.
   Gemini'de `system` diye bir rol yoktur; roller yalnızca `user` ve `model`'dir
   (`assistant` → `model`).
2. **Tool sonucu `user` rolüyle döner** (`functionResponse`), ve
   **`functionResponse.id`, `functionCall.id` ile AYNI olmak zorundadır** — yoksa API
   sonucu çağrısına bağlayamaz. Çağrıda `id` yoksa cevaba da **uydurulmuş bir id konmaz**.
   `response` alanı bir **obje** olmalıdır; düz string kabul edilmez.
3. **HTTP 200 olsa bile gövdede `error` gelebilir.** İkisi de kontrol edilir.

### Asıl iş: şema çevirisi

MCP `inputSchema` **tam JSON Schema 2020-12**'dir. Gemini `functionDeclarations` ise
OpenAPI şemasının **dar bir alt kümesini** alır. Şema olduğu gibi geçirilemez;
`Llm/SchemaTranslator.cs` çevirir — ve **ne attığını kaydeder**:

| Kural | Davranış |
|---|---|
| `type`, `properties`, `required`, `description`, `enum`, `items` | korunur |
| `$defs` → `defs`, `$ref` → `ref` | **dolar işareti kalkar**; `ref` yalnızca kök `defs`'in *doğrudan* çocuğunu gösterebilir |
| dış referans / `#/$defs/A/properties/b` | atılır (Gemini adresleyemez) |
| `["string","null"]` birleşim tipi | `type=string` + `nullable=true` |
| tipsiz `enum` | `type="string"` eklenir — Gemini enum'u yalnızca string ile kabul eder |
| `default` | **atılır ama kaybolmaz**: değeri `description`'a *"Varsayılan: X."* olarak yazılır — açıklama zaten *"… Varsayılan '$me'."* diyorsa cümle **ikinci kez eklenmez** |
| `additionalProperties`, `pattern`, `minimum`/`maximum`, `minLength`/`maxLength`, `minItems`/`maxItems`, `oneOf`/`anyOf`/`allOf`, `const`, `format`, `$schema` | atılır ve **raporlanır** |
| iç içe derinlik > 32 | dal kesilir ve raporlanır |
| parametresiz tool | `parameters` alanı **hiç gönderilmez** |

`SchemaTranslator.Translate` **saf bir fonksiyondur**: girdiyi değiştirmez, IO yapmaz,
log basmaz. Loglamak çağıranın işidir — `stdio` modunda `stdout` yalnızca JSON-RPC'nindir.

```bash
dotnet run -- sema-testi     # 8 tool'u çevirir, atılan anahtarları listeler, örnek çıktıyı basar
dotnet test XurrentMcp.Tests --filter SemaTests   # aynı iddialar, tool başına ayrı test vakası
```

> İddialar **iki yerde** yaşar ve bu bilinçlidir: `sema-testi` derste **gösterir**
> (tablo + örnek `functionDeclaration`), `dotnet test` **denetler** (89 vaka, kırılan
> iddia diğerlerini gizlemez).

Ölçülen sonuç (sözleşme şemaları): `additionalProperties`×8, `pattern`×3, `minimum`,
`maximum`, `minItems`, `maxItems`, `maxLength` birer kez atıldı; **19 `default` açıklamaya
taşındı** (biri zaten açıklamada geçtiği için yeniden yazılmadı); hiçbir alan kaybolmadı.

> **Buradaki tuzak neden ölçülüyor:** "değer açıklamada geçiyor mu" diye bakmak yetmez.
> `stopOnError`'ın açıklaması *"true ise ilk hatada durur"*tur; içindeki `true` varsayılanı
> değil, doğru değerin **anlamını** anlatır. Naif kontrol burada eşleşir, varsayılanı hiç
> yazmaz ve model onu bilemez. Bu yüzden atlama koşulu dardır: açıklamada **"Varsayılan"
> sözcüğü** geçecek **ve** değer o sözcükten *sonra* görünecek. `sema-testi` her iki dalı da
> tutar.

Çalışma anında MCP SDK'sının ürettiği şemalarda tablo başkadır — aynı çeviri, farklı
kayıp profili: `default`×39 açıklamaya taşınır, `["...","null"]`×33 `nullable`'a çevrilir.
Özet her açılışta **stderr**'e basılır:

```
[gemini] şema çevirisi: 8 tool · MCP JSON Schema 2020-12 → Gemini functionDeclarations
[gemini]   atılan           : parameters×1
[gemini]   açıklamaya taşınan : default×39
[gemini]   dönüştürülen     : type[]×33
```

### Sahte Gemini'ye karşı çalıştırma (API anahtarı gerekmez)

```bash
node tools/fake-gemini/server.mjs --mod otomatik --port 5103
GEMINI_BASE_URL=http://127.0.0.1:5103 GEMINI_API_KEY=sahte dotnet run -- chat
```

## ★ requestState bir güvenlik sınırıdır

`requestState` client üzerinden geçtiği için spec onu açıkça *saldırgan kontrolündeki girdi*
sayar. Bu repoda blob şu biçimdedir:

```
base64url(payload) "." base64url(HMAC-SHA256(secret, payload))
```

payload içinde `principal` (authenticated person id), `exp` (TTL), `fingerprint`
(metod adı + argümanların SHA-256 özeti) ve tek kullanımlık `nonce` vardır.
Doğrulama başarısızsa **yazma YAPILMAZ**: `isError=true` + Türkçe açıklama.

İstekte `requestState` varsa **onay gerekmese bile** doğrulanır — doğrulanamayan bir state
"neyi sürdürdüğümüzü bilmiyoruz" demektir.

Ölçülen davranış (ham JSON-RPC sondası):

| Senaryo | Sonuç |
|---|---|
| imza bozulmuş | `İMZASI GEÇERSİZ` → yazma yok |
| 60 dk onaylandı, 600 dk gönderildi | `ARGÜMANLARLA UYUŞMUYOR` → yazma yok |
| geçerli state + kabul | yazıldı, `timeEntry.id` döndü |
| aynı state tekrar (replay) | `ZATEN KULLANILMIŞ` → yazma yok |
| onay verilmedi | `Kullanıcı onayı VERİLMEDİ` → yazma yok |

## Ortam değişkenleri (bu sunucuya özel)

| Değişken | Varsayılan | Anlamı |
|---|---|---|
| `MCP_PROTOCOL` | `2026-07-28` | `2026-07-28` \| `2025-11-25` \| `both`. `both` **stdio'da geçersizdir** (net Türkçe hata, çıkış 78) |
| `XURRENT_CONFIRM_POLICY` | `closed` | `open` = hiç sorma (CI) · `closed` = yalnızca **live** modda sor · `strict` = mock'ta da sor (ders/gösterim) |
| `XURRENT_STATE_SECRET` | (rastgele) | `requestState` HMAC anahtarı. Verilmezse süreç başında üretilir → yeniden başlatınca eski state'ler geçersiz olur (İSTENEN davranış) |
| `XURRENT_STATE_TTL` | `300` | `requestState` yaşam süresi (saniye) |
| `GEMINI_API_KEY` | (boş) | Chatbot (`chat` / `web`) için zorunlu. `stdio`/`wizard`/`sema-testi` için GEREKMEZ |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Güncel **stabil** flash modeli; ai.google.dev/gemini-api/docs/models sayfasında ajanik/tool-calling işler için önerilen seçenek. TypeScript ve Python tarafı da aynı varsayılanı ilan eder |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Sahte sunucuya yönlendirmek için: `http://127.0.0.1:5103` |

**K5 — mock modda yazma engellenmez.** Mock adapter hiçbir yere yazmaz; orada onay istemek
güvenlik değil gürültüdür. Gerçek risk yalnızca live moddadır. Onay akışını mock'ta görmek
için `XURRENT_CONFIRM_POLICY=strict`.

**K4 — mock modda `xurrent_whoami.rateLimit` `null` döner.** Uydurma bir limit "gerçek" gibi
okunur; dahası `resetAt`'e gerçek zaman damgası koymak çıktıyı deterministik olmaktan çıkarır.

## SDK notları

- **ModelContextProtocol 2.0.0** — bu **tek paket** iki MCP revizyonunu birden konuşur:
  `initialize` el sıkışması (2025-11-25) **ve** `server/discover` + per-request `_meta` + MRTR
  (2026-07-28). Yani `Core + V1 + V2` diye **üç proje gerekmez**; sözleşmedeki bağımlılık
  izolasyonu tablosu `1.x + 2.x`'i yan yana koymayı varsayıyordu — 2.0.0 bunu gereksiz kıldı.
  `MCP_PROTOCOL` yalnızca hangi revizyonun advertise edileceğini ve onayın hangi yolla
  sorulacağını seçer.
- `server/discover` isteğinde `_meta` **zorunludur**; eksikse SDK `-32602` ile net bir hata
  döner (`io.modelcontextprotocol/protocolVersion`, `.../clientCapabilities`, `.../clientInfo`).
- `tools/list` cevabında `ttlMs=300000` + `cacheScope=public` ve **sözleşme sırası** garanti
  edilir (`AddListToolsFilter`) — tool koleksiyonu bir sözlüktür, sırası kendiliğinden sabit değildir.
- `Json.Options` içinde `TypeInfoResolver` **açıkça** verilir: SDK bu options'ı
  `MakeReadOnly()` ile dondurur ve çözücüsü atanmamış bir options donarken hata atar.
- **LLM tarafında SDK paketi YOKTUR.** Gemini `generateContent` tek uç noktadır; gövde
  dokümandakinin aynısı olsun diye düz `HttpClient` kullanıldı (`Llm/GeminiClient.cs`).
  Bir SDK, derste göstermek istediğimiz wire biçimini soyutlamanın arkasına saklardı.
  Bedeli şudur: MCP şeması **artık olduğu gibi geçirilemiyor** — `Llm/SchemaTranslator.cs`
  bu yüzden var (bkz. yukarıdaki bölüm).

## Uyarılar

- **stdio modunda `stdout` SADECE JSON-RPC içindir.** Tüm loglar `stderr`'e gider
  (`ServerSetup.ConfigureStdErrLogging`). Tek bir `Console.WriteLine` protokolü bozar.
- `InvariantGlobalization=false` zorunludur; aksi halde
  `TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul")` çalışmaz.
- `.mcp.json` `--no-build` ile çalıştırır → önce bir kez `dotnet build` gerekir.
