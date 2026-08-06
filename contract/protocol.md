# Çift protokol sözleşmesi

> Bu repo MCP'nin **iki protokol revizyonunu birden** implemente eder ve farkı ders konusu yapar.
> Sebep: 2026-07-28 revizyonu lansmandan bu yana en büyük değişikliktir ve tam olarak
> bizim onay akışımızı kaldırmıştır. Bir ders materyalinin bunu görmezden gelmesi olmaz.

| | `2025-11-25` (v1) | `2026-07-28` (v2) |
|---|---|---|
| Durum | Önceki revizyon, hâlâ yaygın | **Güncel** |
| Bağlantı | `initialize` → `notifications/initialized` el sıkışması | El sıkışma **yok** — stateless |
| Sürüm bildirimi | Handshake'te bir kez | **Her istekte** `_meta.io.modelcontextprotocol/protocolVersion` |
| Yetenek bildirimi | Handshake'te bir kez | **Her istekte** `_meta.io.modelcontextprotocol/clientCapabilities` |
| Keşif | `initialize` sonucu | **`server/discover`** (zorunlu RPC) |
| HTTP oturumu | `Mcp-Session-Id` header'ı | **Yok** — sunucu state'i tool argümanındaki handle'larda |
| Sonuç zarfı | düz `Result` | `resultType: "complete" \| "input_required"` **zorunlu** |
| Kullanıcıya soru sorma | Sunucu-başlatmalı `elicitation/create` | **MRTR** — `InputRequiredResult` + client'ın isteği tekrarlaması |
| Log | `logging/setLevel` + `notifications/message` | İstek başına `_meta.io.modelcontextprotocol/logLevel`; **Logging deprecated** |
| Liste cache | yok | `ttlMs` + `cacheScope` **zorunlu** |
| SSE koparsa | `Last-Event-ID` ile devam | **Yok** — istek yeni id ile baştan |

---

## Neden bu bizim için kritik: onay akışı

Bu projenin en önemli güvenlik kararı şuydu: *zaman girişi yazmadan önce kullanıcıdan
onay al, ve bu onayı LLM'e bırakma.* LLM ikna edilebilir; protokol seviyesindeki onay edilemez.

İki revizyon bunu **tamamen farklı** şekilde yapar.

### v1 — sunucu kullanıcıya doğrudan sorar

```
client ──── tools/call ─────────────────▶ server
client ◀─── elicitation/create ───────── server     ← sunucu İSTEK gönderiyor
client ──── ElicitResult ──────────────▶ server
client ◀─── CallToolResult ───────────── server
```

Sunucu, işlemin ortasında client'a bir **istek** gönderir. Bu, kalıcı çift yönlü bir
bağlantı gerektirir — yani sunucu stateful'dur.

### v2 — sunucu "eksik bilgi var" diye SONUÇ döner, client isteği tekrarlar

```
client ──── tools/call (id:1) ─────────▶ server
client ◀─── InputRequiredResult ──────── server     ← bu bir SONUÇ, istek değil
                                                      { resultType: "input_required",
                                                        inputRequests: {...},
                                                        requestState: "<imzalı blob>" }
       ── kullanıcıya sorulur ──
client ──── tools/call (id:2) ─────────▶ server     ← AYNI istek, YENİ id
              + inputResponses + requestState
client ◀─── CallToolResult ───────────── server
```

İlk istek **sonlanır**. Sunucu hiçbir state tutmaz — ihtiyacı olan her şeyi
`requestState` içine kodlar ve client onu geri getirir.

> **JSON-RPC `id` iki istekte FARKLI olmak zorundadır** — bunlar bağımsız isteklerdir.

### `requestState` bir güvenlik sınırıdır

Spec bunu açıkça **saldırgan kontrolündeki girdi** olarak tanımlar. Bizim durumumuzda
`requestState` şunu taşıyor: *"kullanıcı X, Request #70248'e 120 dakika yazmayı onayladı"*.
İmzasız bırakılırsa client bunu değiştirip başka bir ticket'a, başka bir süre yazdırabilir.

Bu repodaki uygulama kuralı:

1. `requestState` **HMAC-SHA256** ile imzalanır (`XURRENT_STATE_SECRET`, yoksa süreç
   başlangıcında rastgele üretilir — yeniden başlatınca eski state'ler geçersiz olur, bu istenen davranıştır).
2. İçine gömülenler:
   - `principal` — authenticated person id. Başka principal ile gelen state **reddedilir**
   - `exp` — 5 dakikalık TTL
   - `fingerprint` — metod adı + tool argümanlarının SHA-256 özeti.
     Farklı bir çağrıya iliştirilen state **reddedilir**
   - `nonce` — tek kullanımlık; süreç içi bir sette tutulur
3. Doğrulama başarısızsa: `isError: true` + Türkçe açıklama. **Yazma yapılmaz.**

> Spec'in uyarısı: bu önlemler replay penceresini daraltır ve çapraz kullanıcı/çapraz
> istek kullanımını engeller, ama **tek kullanımı garanti etmez**. Tek kullanım şartsa
> sunucu tarafında ayrıca zorlanmalıdır — bizim `nonce` seti tam olarak bunu yapar.

---

## Repo yapısı: paylaşılan çekirdek, iki adaptör

Her dilde **iş mantığı protokolden bağımsızdır**. Yalnızca ince MCP adaptör katmanı ikiye ayrılır.

```
core/                      ← protokolden BAĞIMSIZ. İki adaptör de bunu çağırır.
  xurrent/  (adapter, queries, strategies, validate)
  calendar/ (providers, normalize)
  toolimpl/ (8 tool'un SAF fonksiyon hâli: args in → result out)
  confirm/  (onay talebi üretimi + requestState imzalama/doğrulama)

mcp/v1/   ← 2025-11-25 adaptörü: sunucu-başlatmalı elicitation
mcp/v2/   ← 2026-07-28 adaptörü: InputRequiredResult / MRTR
```

**Kritik tasarım kuralı:** `core/toolimpl` bir tool'u çalıştırırken onay gerekiyorsa
`ConfirmationRequired` döner — *nasıl sorulacağını bilmez*. Bunu protokole çeviren
adaptördür. Ders açısından bu şu demek: **aynı iş mantığı, iki farklı protokol kabuğu.**

```
                    ┌─ mcp/v1 ─→ elicitation/create  (sunucu istek gönderir)
core/toolimpl ──────┤
  ConfirmationRequired
                    └─ mcp/v2 ─→ InputRequiredResult (sunucu sonuç döner)
```

### Ölçüm: iki adaptör gerçekten gerekli mi?

Bu belgenin ilk hâli "her dilde iki SDK sürümü yan yana kurulmalı" diyordu ve C# için üç
ayrı proje öngörüyordu. **Ham JSON-RPC sondasıyla ölçtük; bu yanlış çıktı.**

| Sunucu | `server/discover` (v2, `_meta` ile) | `initialize` (v1) | Sonuç |
|---|---|---|---|
| TypeScript — `@modelcontextprotocol/sdk@1.30.0` | `-32601 Method not found` | ✅ `2025-11-25` | **yalnızca v1** |
| Python — `mcp==2.0.0` | ✅ `supportedVersions: ["2026-07-28"]` | ✅ `2025-11-25` | **ikisi de** |
| C# — `ModelContextProtocol 2.0.0` | ✅ `supportedVersions: ["2026-07-28"]` | ✅ `2025-11-25` | **ikisi de** |

> ⚠️ **Bu tablo STDIO üzerinde ölçülmüştür** ve yalnız stdio için konuşur.
> Aynı SDK'nın HTTP yüzeyi FARKLI davranabilir — nitekim ölçüldü: Python'un
> ilk HTTP kabuğu (`streamable_http_app()` varsayılanlarıyla) v2'yi HİÇ
> konuşmuyordu (`server/discover` → `-32601`, oturumsuz istek → `-32600`) ve
> konteynerler arası çağrıyı DNS-rebinding korumasıyla 421'e boğuyordu.
> HTTP yüzeyinin çağ matrisi bu yüzden AYRICA ve sürekli ölçülür:
> `scripts/test-all.mjs` → `kabuk-http` adımı — üç dilde `/healthz`,
> HTTP-üzerinden `server/discover`, `/mcp/v1` oturumlu el sıkışma,
> `/mcp/v2` stateless 10-tool listesi, anahtarsız 401 ve yabancı-Host kabulü.
> *"stdio'da ölçtüm" ile "HTTP'de ölçtüm" aynı cümle değildir.*

**Resmî SDK 2.0.0'lar geriye dönük uyumluluğu kendileri taşıyor.** İki ayrı adaptör yazmak
yalnızca **eski SDK'da kalan dilde** gerekiyor — bu repoda sadece TypeScript.

Bu, dersin sessiz ama en değerli anlarından biri: *mimari kararı ölçmeden verme.* Üç projeye
bölünmüş bir C# çözümü yazsaydık, gereksiz karmaşıklığı "breaking change'in maliyeti" diye
öğretecektik — oysa o maliyeti SDK zaten ödemişti.

### Bağımlılık izolasyonu — yine de bilinmesi gereken

Eski SDK'da kalan bir dilde iki sürümü yan yana çalıştırmak gerekirse:

| Dil | Durum | Çözüm |
|---|---|---|
| TypeScript | v1 `@modelcontextprotocol/sdk`, v2 `@modelcontextprotocol/{core,server,client}` — **farklı paket adları** | Aynı `node_modules`'da yan yana kurulur. Sorunsuz — bu repoda böyle yapıldı |
| C# | `ModelContextProtocol` — **aynı paket ID** | Tek csproj'da iki sürüm olmaz; `Core` + `V1` + `V2` olarak üç proje gerekirdi. *Bu repoda gerekmedi* |
| Python | `mcp` — **aynı paket adı** | Tek ortamda iki sürüm olmaz; `uv run --with 'mcp==1.28.1' …` ile geçici override. *Bu repoda gerekmedi* |

> **`server/discover` çağırırken `_meta` göndermek zorunludur.** Göndermezseniz Python
> `-32601 Method not found` (yanıltıcı), C# ise `-32602 "requires per-request metadata
> declaring a supported protocol version"` döner.
>
> Bu ayrım kritiktir: **`-32601` gerçekten "v1 sunucu" demektir, `-32602` ise "sondanız
> hatalı" demektir.** İkisini karıştıran bir uyumluluk sondası, v2 konuşan bir sunucuyu
> v1 sanır. Bu repodaki sihirbaz tam olarak bu hatayı yaptı ve ölçümle yakalandı.

---

## Seçim ve pazarlık

### Sunucu tarafı

`MCP_PROTOCOL` ortam değişkeni:

| Değer | Davranış |
|---|---|
| `2026-07-28` | **Varsayılan.** Yalnızca v2 adaptörü |
| `2025-11-25` | Yalnızca v1 adaptörü |
| `both` | HTTP transport'ta ikisi de ayrı yollarda (`/mcp/v1`, `/mcp/v2`). stdio'da geçersiz — tek süreç tek protokol konuşur |

### Client tarafı (sihirbaz) — geriye dönük uyumluluk sondası

Spec, stdio'da `server/discover`'ın uyumluluk sondası olarak kullanılmasını önerir:

```
1. server/discover gönder
   ├─ başarılı            → v2. Dönen supportedVersions'a bak
   └─ "method not found"  → v1. initialize handshake'ine düş
```

Sihirbaz bunu yapar ve **hangi protokolü konuştuğunu ekranda gösterir**. Ders sırasında
aynı sihirbazı iki farklı sunucuya bağlayıp pazarlığın canlı çalıştığı görülür.

---

## Tool sözleşmesi DEĞİŞMEZ

`contract/tools.json` her iki protokolde de aynıdır: aynı 8 tool, aynı parametreler,
aynı çıktı alanları, aynı beklenen sayılar.

Değişen tek şey **onayın nasıl sorulduğudur**. Bu kasıtlıdır ve dersin ana mesajıdır:

> Protokol revizyonu, tool sözleşmeni bozmamalı. İş mantığını protokolden
> ayırdıysan, breaking change seni ince bir adaptör katmanında yakalar —
> tüm uygulamada değil.

`scripts/verify-contract.mjs --all` her iki protokolde de aynı sözleşmeyi doğrular.

---

## v2'de ayrıca uyulması gerekenler

- Tüm sonuçlarda `resultType` alanı **zorunlu**. Client, alanı olmayan (eski sunucu) sonucu `"complete"` saymalı.
- `tools/list` sonucunda `ttlMs` ve `cacheScope` **zorunlu**. Bizim tool listemiz statiktir → `ttlMs: 300000`, `cacheScope: "public"`.
- `tools/list` **deterministik sırada** dönmeli (LLM prompt cache isabetini artırır). Sözleşmedeki sırayı koru.
- Streamable HTTP POST'larında `Mcp-Method` ve `Mcp-Name` header'ları **zorunlu**.
- Logging deprecated → stdio'da **stderr**'e logla (zaten kuralımız buydu).
- Sampling ve Roots deprecated → zaten kullanmıyoruz.
- Hata kodları yeniden numaralandı: `UnsupportedProtocolVersion` `-32004` → **`-32022`**,
  `MissingRequiredClientCapability` `-32003` → **`-32021`**, `HeaderMismatch` `-32001` → **`-32020`**.
  `-32000`–`-32019` implementasyona ait, `-32020`–`-32099` spec'e ayrılmış.
- `resources/read` "bulunamadı" hatası `-32002` → **`-32602`**.

## Kaynaklar

- [Spec 2026-07-28 — Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Multi Round-Trip Requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- [Versioning ve pazarlık](https://modelcontextprotocol.io/specification/versioning)
- [Feature lifecycle / deprecation policy](https://modelcontextprotocol.io/community/feature-lifecycle)
- [Duyuru yazısı](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
