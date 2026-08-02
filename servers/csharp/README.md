# servers/csharp — C# / .NET implementasyonu

`contract/tools.json` sözleşmesinin C# karşılığı. TypeScript ve Python sunucularıyla
**aynı 8 tool'u, aynı parametre adlarıyla, aynı çıktı alanlarıyla** sunar ve
`fixtures/` klasöründeki aynı veriyi okuyarak **aynı sayıları** üretir.

## Çalıştırma

```bash
dotnet build

dotnet run -- stdio     # MCP sunucusu, stdio transport (VARSAYILAN — .mcp.json bunu kullanır)
dotnet run -- http      # MCP sunucusu, Streamable HTTP (MCP_HTTP_PORT, varsayılan 8788)
dotnet run -- wizard    # Sihirbaz / ders modu — API key GEREKMEZ
dotnet run -- chat      # Terminal chatbot   (ANTHROPIC_API_KEY gerekir)
dotnet run -- web       # Web arayüzü        (WEB_PORT, varsayılan 8787)
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
| `Agent/*` | Chatbot beyni + web sunucusu (`clients/web/API.md` sözleşmesi) |
| `Wizard.cs` | Ders akışı yürütücüsü |

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
- **Anthropic.SDK 5.10.0** — `Function(name, description, JsonNode)` kurucusu MCP'den gelen
  ham JSON Schema'yı doğrudan kabul ettiği için düz `HttpClient`'a düşmeye gerek kalmadı.

## Uyarılar

- **stdio modunda `stdout` SADECE JSON-RPC içindir.** Tüm loglar `stderr`'e gider
  (`ServerSetup.ConfigureStdErrLogging`). Tek bir `Console.WriteLine` protokolü bozar.
- `InvariantGlobalization=false` zorunludur; aksi halde
  `TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul")` çalışmaz.
- `.mcp.json` `--no-build` ile çalıştırır → önce bir kez `dotnet build` gerekir.
