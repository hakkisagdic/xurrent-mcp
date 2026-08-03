# MCP spec uyum checklist'i ve doğrulayıcısı

> **Ne işe yarar:** "üç sunucumuz da MCP spec'ine uyuyor mu?" sorusunu tahminle değil
> **ölçümle** yanıtlar. İki parçadır: insan için bir checklist (bu belge) ve o checklist'i
> gerçekten koşturan bir program (`scripts/mcp-uyum.mjs`).

## Neden ayrı bir araç — `verify-contract.mjs` yetmiyor mu?

Yetmiyor, çünkü ikisi **farklı soruları** yanıtlar:

| | `verify-contract.mjs` | `mcp-uyum.mjs` |
|---|---|---|
| Soru | "Üç dil **aynı sözleşmeyi** mi sunuyor?" | "Sunucular **MCP spec'ine** uyuyor mu?" |
| Referans | `contract/tools.json` | MCP spec 2026-07-28 + 2025-11-25 + JSON-RPC 2.0 |
| Bağlantı | SDK client'ı ile | **ham JSON-RPC** — SDK yok |
| Yakaladığı | tool adı/parametre kayması | yanlış hata kodu, eksik `resultType`, imzasız `requestState`, stdout kirliliği |

Sözleşmeye kusursuz uyan ama spec'i ihlal eden bir sunucu **tamamen mümkündür**. Bu belgedeki
ölçüm bunu kanıtlıyor: üç sunucu da sözleşme testini geçiyor, ama **hiçbiri** spec'in tamamını
geçmiyor.

### İki tasarım kararı

**1. SDK kullanılmaz.** SDK'lar tam da burada test etmek istediğimiz şeyleri düzeltir: `_meta`'yı
otomatik ekler, hata kodlarını normalize eder, bozuk çerçeveyi yutar. SDK ile ölçmek, gözlüğün
üstünden gözü muayene etmektir. Bu yüzden protokol ham konuşulur: satır-sonlu JSON-RPC 2.0.

**2. Negatif testler birinci sınıf vatandaştır.** Bir sunucunun doğru cevabı vermesi kadar
**yanlış isteği reddetmesi** de spec gereğidir. Bilinmeyen metod, bozuk JSON, `_meta`'sız
`server/discover`, kurcalanmış `requestState`, desteklenmeyen protokol sürümü — hepsi gönderilir.
Bu belgedeki **beş bulgunun dördü** yalnızca negatif testlerle ortaya çıktı.

## Çalıştırma

```bash
node scripts/mcp-uyum.mjs --hepsi --protokol ikisi   # tam koşu (bu belgedeki ölçüm)
node scripts/mcp-uyum.mjs --sunucu py --protokol 2026-07-28
node scripts/mcp-uyum.mjs --maddeler                 # checklist'i bas, sunucu başlatma
node scripts/mcp-uyum.mjs --markdown                 # aşağıdaki tabloyu üretir
node scripts/mcp-uyum.mjs --hepsi --json             # makine-okunur rapor
```

Bağımlılığı yoktur (yalnızca `node:*`, Node 24). Çıkış kodu **yalnızca MUST maddesi kaldıysa** 1'dir;
SHOULD ihlalleri raporda görünür ama derlemeyi kırmaz.

> **Güvenlik:** doğrulayıcı MRTR onay turunu ölçmek için **gerçek bir yazma çağrısı** yapar.
> Bu yüzden `XURRENT_MODE=mock` ve `XURRENT_MOCK_PERSIST=0` **zorla** ayarlanır; ortamdaki
> live ayarları yok sayılır. Live bir Xurrent'a kayıt düşmesi mümkün değildir.

---

# ÖLÇÜLMÜŞ SONUÇ

Aşağıdakiler `node scripts/mcp-uyum.mjs --hepsi --protokol ikisi` çıktısıdır. **Tahmin değildir.**
Katalog 65 madde içerir: 60'ı otomatik, 5'i elle.

| Sunucu | Revizyon | GEÇTİ | KALDI | ATLANDI | Kalan MUST |
|---|---|---:|---:|---:|---|
| TypeScript | 2026-07-28 | 49 | 3 | 13 | `J5` |
| TypeScript | 2025-11-25 | 30 | 2 | 33 | `J4`, `J5` |
| Python | 2026-07-28 | 48 | 4 | 13 | `J5`, `T7` |
| Python | 2025-11-25 | 30 | 2 | 33 | `J5`, `T7` |
| C# | 2026-07-28 | 49 | 3 | 13 | `J4`, `M4`, `T7` |
| C# | 2025-11-25 | 30 | 2 | 33 | `J4`, `T7` |

**Çıkış kodu 1.** Altı koşunun altısında da en az bir MUST maddesi kaldı.

> v1 koşularında ATLANDI sayısının yüksek olması (33) bir sorun değildir: 2026-07-28'e özgü
> maddeler (`Y*`, `M*`) o revizyonda **yoktur**, dolayısıyla ölçülmezler.

## Dil × madde matrisi

`✔` geçti · `✘` KALDI · `○` atlandı · `!` = MUST

```
Madde  (! = MUST)                                                     ts v2  ts v1  py v2  py v1  cs v2  cs v1
── JSON-RPC 2.0
J1 ! Her yanıt jsonrpc:"2.0" alanını taşır                              ✔      ✔      ✔      ✔      ✔      ✔
J2 ! Yanıt id'si istek id'siyle aynı ve AYNI TİPTE                      ✔      ✔      ✔      ✔      ✔      ✔
J3 ! Bilinmeyen metod → -32601 Method not found                         ✔      ✔      ✔      ✔      ✔      ✔
J4 ! Geçersiz params → -32602 Invalid params                            ✔      ✘      ✔      ✔      ✘      ✘
J5 ! Bozuk JSON → -32700 Parse error                                    ✘      ✘      ✘      ✘      ✔      ✔
J6 ! Notification (id'siz istek) yanıt ALMAZ                            ✔      ✔      ✔      ✔      ✔      ✔
J7 ! stdio'da stdout SADECE JSON-RPC                                    ✔      ✔      ✔      ✔      ✔      ✔
J8 · Loglar stderr'e yazılır                                            ✔      ✔      ✔      ✔      ✔      ✔
J9 · Bilinmeyen tool adı düzgün reddedilir                              ✔      ✔      ✔      ✔      ✔      ✔
── 2026-07-28
Y1  ! server/discover ZORUNLU RPC olarak var                            ✔      ○      ✔      ○      ✔      ○
Y2  ! _meta'sız server/discover REDDEDİLİR                              ✔      ○      ✔      ○      ✔      ○
Y2b · _meta hatasının kodu -32601 DEĞİL                                 ✘      ○      ✘      ○      ✔      ○
Y3a ! _meta.protocolVersion eksikse REDDEDİLİR                          ✔      ○      ✔      ○      ✔      ○
Y3b · _meta.clientInfo YOKSA istek yine de işlenir                      ✘      ○      ✘      ○      ✔      ○
Y18 · Sunucu her sonucun _meta'sında serverInfo bildirir                ✔      ○      ✔      ○      ✔      ○
Y4  ! TÜM sonuçlarda resultType                                         ✔      ○      ✔      ○      ✔      ○
Y5  ! tools/list sonucunda ttlMs (CacheableResult)                      ✔      ○      ✔      ○      ✔      ○
Y6  ! tools/list sonucunda cacheScope = "public"                        ✔      ○      ✔      ○      ✔      ○
Y7  · tools/list DETERMİNİSTİK sırada                                   ✔      ○      ✔      ○      ✔      ○
Y8  ! Handshake YOK — initialize olmadan çalışır                        ✔      ○      ✔      ○      ✔      ○
Y9  ! Mcp-Session-Id header'ı YOK                                       ○      ○      ○      ○      ○      ○
Y10 ! ping RPC'si kaldırıldı → -32601                                   ✔      ○      ✔      ○      ✔      ○
Y11 ! logging/setLevel kaldırıldı → -32601                              ✔      ○      ✔      ○      ✔      ○
Y12 ! roots/list_changed kaldırıldı → -32601                            ✔      ○      ✔      ○      ✔      ○
Y13 ! Hata kodları tanımlı aralıklarda                                  ✔      ○      ✔      ○      ✔      ○
Y14a! Desteklenmeyen protokol sürümü REDDEDİLİR                         ✔      ○      ✔      ○      ✔      ○
Y14b· Red kodu -32022 (UnsupportedProtocolVersion)                      ✔      ○      ✔      ○      ✔      ○
Y15a! Eksik clientCapabilities REDDEDİLİR                               ✔      ○      ✔      ○      ✔      ○
Y15b· Red kodu eski taslak numarası (-32003) DEĞİL                      ✔      ○      ✔      ○      ✔      ○
Y16 ! HeaderMismatch → -32020                                           ○      ○      ○      ○      ○      ○
Y17 ! Streamable HTTP POST'ta Mcp-Method / Mcp-Name                     ○      ○      ○      ○      ○      ○
── MRTR (2026-07-28)
M1  ! Onay gerektiren çağrı resultType:"input_required" döner           ✔      ○      ✔      ○      ✔      ○
M2  ! InputRequiredResult { inputRequests, requestState } taşır         ✔      ○      ✔      ○      ✔      ○
M3  ! inputRequests değerleri beyaz listede                             ✔      ○      ✔      ○      ✔      ○
M4  ! Client desteklemediği inputRequest GÖNDERİLMEZ                    ✔      ○      ✔      ○      ✘      ○
M5  ! Kurcalanmış requestState REDDEDİLİR (imza)                        ✔      ○      ✔      ○      ✔      ○
M6  ! Başka argümana iliştirilen requestState REDDEDİLİR (fingerprint)  ✔      ○      ✔      ○      ✔      ○
M7  ! Geçerli requestState + accept → çağrı tamamlanır                  ✔      ○      ✔      ○      ✔      ○
M8  · requestState TEK KULLANIMLIK (nonce)                              ✔      ○      ✔      ○      ✔      ○
M9  ! Retry'de JSON-RPC id FARKLI                                       ✔      ○      ✔      ○      ✔      ○
M10 · requestState TTL'lidir (5 dk)                                     ○      ○      ○      ○      ○      ○
M11 · requestState principal'a bağlıdır                                 ○      ○      ○      ○      ○      ○
── 2025-11-25
G1 ! initialize kabul edilir ve protocolVersion döner                   ○      ✔      ○      ✔      ○      ✔
G2 ! Capabilities pazarlığı: serverInfo + capabilities döner            ○      ✔      ○      ✔      ○      ✔
G3 ! notifications/initialized sonrası oturum kullanılabilir            ○      ✔      ○      ✔      ○      ✔
G4 ! Sunucu-başlatmalı elicitation/create geliyor                       ○      ✔      ○      ✔      ○      ✔
G5 ! ElicitResult "accept" işlenir → yazma tamamlanır                   ○      ✔      ○      ✔      ○      ✔
G6 ! ElicitResult "decline" işlenir → yazma YOK                         ○      ✔      ○      ✔      ○      ✔
G7 ! ElicitResult "cancel" işlenir → yazma YOK                          ○      ✔      ○      ✔      ○      ✔
G8 · v1 sonucunda resultType YOKTUR                                     ○      ✔      ○      ✔      ○      ✔
── Tool katmanı
T1  ! Tool adları contract/tools.json ile birebir                       ✔      ✔      ✔      ✔      ✔      ✔
T2  ! Her tool inputSchema bildirir                                     ✔      ✔      ✔      ✔      ✔      ✔
T3  ! Her tool outputSchema bildirir                                    ✔      ✔      ✔      ✔      ✔      ✔
T4  ! outputSchema varsa structuredContent ZORUNLU                      ✔      ✔      ✔      ✔      ✔      ✔
T5  · structuredContent'in YANI SIRA text block                         ✔      ✔      ✔      ✔      ✔      ✔
T6  ! structuredContent sözleşmedeki required alanları taşır            ✔      ✔      ✔      ✔      ✔      ✔
T7  ! isError semantiği                                                 ✔      ✔      ✘      ✘      ✘      ✘
T8  ! annotations sözleşmeyle aynı                                      ✔      ✔      ✔      ✔      ✔      ✔
T9  ! $ref/$defs çözülüyor                                              ✔      ✔      ✔      ✔      ✔      ✔
T10 · Her tool anlamlı bir description taşır                            ✔      ✔      ✔      ✔      ✔      ✔
── Güvenlik/deprecation
D1 ! Roots KULLANILMIYOR                                                ✔      ✔      ✔      ✔      ✔      ✔
D2 ! Sampling KULLANILMIYOR                                             ✔      ✔      ✔      ✔      ✔      ✔
D3 ! Logging KULLANILMIYOR — loglar stderr'e                            ✔      ✔      ✔      ✔      ✔      ✔
D4 · HTTP+SSE transport KULLANILMIYOR                                   ✔      ✔      ✔      ✔      ✔      ✔
D5 · OAuth DCR KULLANILMIYOR (yerine CIMD)                              ✔      ✔      ✔      ✔      ✔      ✔
```

---

# BULGULAR — geçmeyen maddeler ve nedenleri

Toplam **16 KALDI** (12 MUST + 4 SHOULD), ama bunlar **5 ayrı kök nedene** iniyor.
Hiçbiri gizlenmedi; spec ihlali bulmak bu aracın amacıdır.

## ✘ BULGU 1 — `isError` iş kuralı hatasını bildirmiyor (T7)

**Etkilenen:** Python (iki revizyon), C# (iki revizyon). TypeScript geçiyor.
**Seviye:** MUST. **En ciddi bulgu budur.**

`minutes: 7` gönderildi. Hesabın `timeIncrement` değeri 30 olduğu için bu **geçersiz bir iş
isteğidir** ve üç sunucu da bunu **doğru şekilde tespit ediyor** — `errors[]` üçünde de dolu:

```
ts  isError = true        errors[] = [{ "message": "Süre 7 dakika, ancak bu hesabın timeIncrement değeri 30. …" }]
py  isError = false   ✘   errors[] = [{ "message": "7 dakika, hesabin timeIncrement degerinin (30 dk) kati degil. …" }]
cs  isError = undefined ✘ errors[] = [{ "message": "Süre 7 dakika, ancak bu hesabın timeIncrement değeri 30 dakika. …" }]
```

Sorun tespitte değil, **bildirimde**. `contract/tools.json` şunu söylüyor:

> `errorSemantics`: "İş kuralı hataları isError=true + okunabilir Türkçe metin ile döner.
> `errors[]` dizisi boş değilse işlem **BAŞARISIZ** olmuştur."

MCP spec'inde `isError` alanı yoksa **false** kabul edilir. Yani Python "başarılı" diyor,
C# de "başarılı" diyor — hâlbuki ikisi de içeride hatayı bulmuş durumda.

**Neden ciddi:** bu sonucu okuyan taraf bir LLM'dir. `isError` false ise model
"zaman girişi yazıldı" der ve kullanıcıya öyle bildirir. Sessiz veri kaybı değil, **sessiz
yalan** üretir. `errors[]` dizisini okuyacak kadar dikkatli olması modelin insafına kalmıştır —
ve protokolün varlık sebebi tam olarak bunu insafa bırakmamaktır.

**Düzeltme:** `errors.length > 0` ise `isError = true`. Tek satırlık düzeltme, üç dilde de
MCP adaptör katmanında (`servers/*/mcp/`), iş mantığına dokunmadan yapılır.

## ✘ BULGU 2 — Bozuk JSON'a `-32700` dönmüyor (J5)

**Etkilenen:** TypeScript ve Python (iki revizyon da). **C# geçiyor.**
**Seviye:** MUST.

Yarım bir satır yazıldı: `{"jsonrpc":"2.0","id":991,"method":"tools/list","params":`

```
ts  1500 ms içinde HİÇ yanıt gelmedi (sunucu bozuk satırı sessizce yuttu)
py  1500 ms içinde HİÇ yanıt gelmedi (sunucu bozuk satırı sessizce yuttu)
cs  id=991 error={"code":-32700,"message":"Failed to parse the JSON-RPC message"}   ✔
```

JSON-RPC 2.0 §4.2 bozuk girdide `-32700` + `id: null` yanıtı **zorunlu** tutar. TS ve Python
SDK'ları satırı loglayıp düşürüyor. C#'ın doğru davranması, bunun "SDK'lar böyle yapar"
mazeretiyle geçiştirilemeyeceğini gösteriyor: **aynı spec, aynı sürüm, farklı sonuç.**

**Not:** bu **SDK transport katmanında**dır, bizim kodumuzda değil. Bu repoda düzeltilemez;
yukarı akışta (upstream) çözülmesi gerekir. Checklist'te tutulmasının sebebi budur — bir uyum
listesinin görevi "kimin suçu" demek değil, **davranışı kayda geçirmektir**.

## ✘ BULGU 3 — Eksik `params` `-32603` dönüyor, `-32602` değil (J4)

**Etkilenen:** TypeScript v1, C# (iki revizyon). Python ve TS v2 geçiyor.
**Seviye:** MUST.

`tools/call` zorunlu `name` alanı olmadan gönderildi:

```
ts v1  {"code":-32603,"message":"[{ \"expected\": \"string\", \"code\": \"invalid_type\", \"path\": [\"params\",\"name\"] …"}
cs     {"code":-32603,"message":"An error occurred."}
py     {"code":-32602,"message":"Invalid request parameters"}   ✔
ts v2  {"code":-32602,"message":"Invalid …"}                    ✔
```

İkisi de şema doğrulamasını yapıyor ama sonucu **Internal error** olarak sarmalıyor.
`-32603` "sunucuda beklenmedik bir şey oldu" demektir; `-32602` "senin isteğin hatalı" demektir.
Client'ın yeniden deneyip denememesi gereken durumu belirleyen ayrım budur: `-32603`'te tekrar
denemek mantıklıdır, `-32602`'de aynı isteği tekrar göndermek **sonsuza kadar** başarısız olur.

C#'ın `"An error occurred."` mesajı ayrıca hata ayıklamayı imkânsız kılıyor — hangi alanın
hatalı olduğu söylenmiyor.

## ✘ BULGU 4 — C# desteklenmeyen `inputRequest` gönderiyor (M4)

**Etkilenen:** yalnızca C# / 2026-07-28. **Seviye:** MUST.

Client `clientCapabilities: {}` bildirdi — yani **elicitation desteklemiyorum** dedi.
Buna rağmen:

```
cs  clientCapabilities={} olmasına rağmen elicitation/create istendi: ["elicitation/create"]
ts  clientCapabilities={} → resultType=complete; elicit isteği gönderilmedi   ✔
py  clientCapabilities={} → resultType=complete; elicit isteği gönderilmedi   ✔
```

MRTR spec'i açıktır: sunucu, client'ın **desteklemediği** bir `inputRequest`'i göndermemelidir.
Gönderirse client o isteği karşılayamaz ve çağrı **kalıcı olarak tıkanır** — client ne
cevaplayabilir ne de devam edebilir. TS ve Python bu durumda politikayı uygulayıp uyarıyla
devam ediyor; C# `clientCapabilities`'i hiç okumuyor.

## ○ BULGU 5 — Era tespiti `clientInfo`'yu zorunlu sanıyor (Y2b + Y3b)

**Etkilenen:** TypeScript ve Python / 2026-07-28. C# geçiyor. **Seviye:** SHOULD (ikisi de).

Bu iki madde tek bir kök nedene iniyor ve `contract/protocol.md`'de anlatılan tuzağın ta kendisi.

Spec `clientInfo`'yu **SHOULD** tutar: *"Clients SHOULD identify themselves on each request."*
Yani `clientInfo` göndermeyen bir client **uyumludur**. Ama TS ve Python'un stdio bağlantısı,
gelen ilk mesajda **üç `_meta` anahtarının da** bulunmasına bakarak "bu v2 mi v1 mi" kararı
veriyor. `clientInfo` yoksa bağlantı v1 sanılıyor:

```
ts  clientInfo'suz istek REDDEDİLDİ  {"code":-32601,"message":"Method not found"}
py  clientInfo'suz istek REDDEDİLDİ  {"code":-32600,"message":"this connection serves the handshake
                                      protocol era; requests carrying the 2026-07-28 envelope are
                                      not accepted on it"}
cs  clientInfo olmadan da işlendi  (supportedVersions=["2026-07-28"])   ✔
```

Ve bunun ikinci yarısı daha sinsi (Y2b): `_meta` hiç yokken TS ve Python **`-32601 Method not
found`** dönüyor. Spec, `server/discover`'ın stdio'da **geriye dönük uyumluluk sondası** olarak
kullanılmasını önerir ve `-32601`'i "bu sunucu 2026 öncesidir" sinyali olarak tanımlar.
Dolayısıyla `_meta`'sını eksik gönderen bir sonda, **v2 konuşan bir sunucuyu v1 sanır**.
Doğru cevap `-32602`'dir: "isteğin hatalı", "böyle bir metot yok" değil.

> `contract/protocol.md` bu tuzağı zaten belgeliyor ve bu repodaki sihirbazın tam olarak bu
> hatayı yaptığını yazıyor. Ölçüm, tuzağın **hâlâ kurulu** olduğunu gösteriyor.

`serveStdio` (TypeScript'te `@modelcontextprotocol/server`) SDK'dan gelir; era tespiti bizim
kodumuzda değildir. C#'ın böyle bir tespiti hiç yok — tek era konuşuyor ve bu yüzden geçiyor.

## Bulgulardan çıkan tablo

| Bulgu | Seviye | ts | py | cs | Kim düzeltir |
|---|---|---|---|---|---|
| 1 · `isError` iş kuralı hatasını bildirmiyor | MUST | ✔ | ✘ | ✘ | **biz** (adaptör katmanı) |
| 2 · Bozuk JSON'a `-32700` yok | MUST | ✘ | ✘ | ✔ | SDK (upstream) |
| 3 · Geçersiz params `-32603` dönüyor | MUST | v1'de ✘ | ✔ | ✘ | SDK + biz |
| 4 · Desteklenmeyen `inputRequest` gönderiliyor | MUST | ✔ | ✔ | ✘ | **biz** (C# adaptörü) |
| 5 · Era tespiti `clientInfo` zorunlu sanıyor | SHOULD | ✘ | ✘ | ✔ | SDK (upstream) |

**Ders:** üç sunucu da aynı sözleşmeyi sunuyor ve sözleşme testini geçiyor. Spec uyumu ise
üçünde de farklı yerlerden sızıyor. *Aynı sözleşme, aynı spec — üç farklı sonuç.*

---

# ATLANAN MADDELER — ve neden otomatikleştirilemedi

Checklist'te olup doğrulayıcıda **koşmayan** 5 madde vardır. Hepsi raporda `ATLANDI` olarak
görünür ve gerekçesi birebir basılır. Bu ayrım kasıtlıdır: *"yazmayı unuttuk"* ile
*"otomatikleştirilemez"* aynı şey değildir, ve bir checklist'in en tehlikeli hâli hangisi
olduğunun bilinmemesidir.

| # | Madde | Neden otomatik değil | Elle nasıl yapılır |
|---|---|---|---|
| `Y9` | `Mcp-Session-Id` header'ı YOK | stdio'da **HTTP header kavramı yoktur**. Ölçmek için üç dilin HTTP giriş noktasını (port, hazır-olma beklemesi, kapatma) ayağa kaldırmak gerekir; doğrulayıcı bilinçli olarak tek transport'a sadık kalır. | `npm run http` + `curl -i -X POST localhost:PORT/mcp/v2` — yanıt header'larında `Mcp-Session-Id` **olmamalı** |
| `Y16` | `HeaderMismatch` → `-32020` | Yine yalnızca Streamable HTTP'de anlamlı (bkz. `Y9`). | `curl -H "Mcp-Method: tools/list"` gönderip gövdeye `tools/call` koyun; `-32020` beklenir |
| `Y17` | POST'ta `Mcp-Method` / `Mcp-Name` header'ları | HTTP'ye özgü **ve** bu bir **istemci** yükümlülüğüdür: sunucuyu sondalayarak değil, istemcinin gönderdiği isteğe bakarak doğrulanır. | `clients/inspector` ile ağ trafiğini inceleyin |
| `M10` | `requestState` TTL'lidir (5 dk) | Doğrulamak için **5 dakika beklemek** gerekir; CI'da kabul edilemez. | `XURRENT_STATE_TTL=1` ile sunucuyu başlatın, ilk tur ile ikinci tur arasında 2 sn bekleyin; blob reddedilmeli |
| `M11` | `requestState` principal'a bağlıdır | **İki farklı authenticated principal** gerektirir. Mock modda tek kimlik vardır (`$me` → `TW9jay9QZXJzb24vMQ`); ikincisi ancak live modda veya fixtures değiştirilerek üretilir. | Kod tarafı: `core/confirm.*` içinde `principal` alanının imzaya dâhil edildiğini doğrulayın |

Üç madde (`Y9`, `Y16`, `Y17`) tek bir sebebe iniyor: **bu doğrulayıcı stdio konuşur.** Bu bir
eksiklik değil, kapsam kararıdır — ve kapsamın yazılı olması, kapsam dışının unutulmasını önler.

---

# CHECKLIST

> Bu tablo `node scripts/mcp-uyum.mjs --markdown` ile **üretilir**. Elle düzenlemeyin:
> maddeler `scripts/mcp-uyum.mjs` içindeki `CATALOG` dizisinde yaşar ve insan checklist'i ile
> makinenin **tek ortak kaynağı** odur. İki yerde ayrı ayrı yazılsalardı kaçınılmaz olarak
> birbirlerinden kayarlardı — ve kayan bir checklist, doğru olduğu sanıldığı için en kötüsüdür.

| # | Madde | Revizyon | Seviye | Nasıl test edilir | Otomatik |
|---|---|---|---|---|---|
| | **JSON-RPC 2.0** | | | | |
| J1 | Her yanıt jsonrpc:"2.0" alanını taşır | her ikisi | MUST | Oturum boyunca gelen TÜM yanıtlarda alan aranır. | evet |
| J2 | Yanıt id'si istek id'siyle aynı ve AYNI TİPTE | her ikisi | MUST | id olarak string ("uyum-string-id") gönderilir; yanıtta sayıya dönüşmemeli. | evet |
| J3 | Bilinmeyen metod → -32601 Method not found | her ikisi | MUST | uyum/bilinmeyen-metot gönderilir. | evet |
| J4 | Geçersiz params → -32602 Invalid params | her ikisi | MUST | tools/call, zorunlu `name` alanı OLMADAN gönderilir. | evet |
| J5 | Bozuk JSON → -32700 Parse error | her ikisi | MUST | Yarım kalmış bir JSON satırı yazılır; id:null + -32700 beklenir. | evet |
| J6 | Notification (id'siz istek) yanıt ALMAZ | her ikisi | MUST | id'siz bilinmeyen bir metod gönderilip 800 ms sessizlik ölçülür. | evet |
| J7 | stdio'da stdout SADECE JSON-RPC (satır başına tek JSON) | her ikisi | MUST | stdout'un her satırı JSON.parse edilir; edilemeyen satır ihlaldir. | evet |
| J8 | Loglar stderr'e yazılır | her ikisi | SHOULD | stderr'de log satırı var mı bakılır (J7 ile birlikte anlamlıdır). | evet |
| J9 | Bilinmeyen tool adı düzgün reddedilir | her ikisi | SHOULD | tools/call name='yok_boyle_bir_tool'; JSON-RPC hatası VEYA isError=true kabul edilir. | evet |
| | **2026-07-28** | | | | |
| Y1 | server/discover ZORUNLU RPC olarak var | 2026-07-28 | MUST | Üç zorunlu _meta anahtarıyla çağrılır; hatasız dönmeli. | evet |
| Y2 | _meta'sız server/discover REDDEDİLİR | 2026-07-28 | MUST | Aynı istek _meta olmadan gönderilir; hata dönmesi ZORUNLUDUR. | evet |
| Y2b | _meta hatasının kodu -32601 DEĞİL (uyumluluk sondasını yanıltır) | 2026-07-28 | SHOULD | Y2'nin hata kodu okunur; -32601 ise sonda bu v2 sunucuyu v1 sanır. | evet |
| Y3a | _meta.protocolVersion eksikse REDDEDİLİR | 2026-07-28 | MUST | _meta'dan yalnızca protocolVersion çıkarılıp server/discover gönderilir. | evet |
| Y3b | _meta.clientInfo YOKSA istek yine de işlenir (spec'te SHOULD) | 2026-07-28 | SHOULD | clientInfo çıkarılıp server/discover gönderilir; başarılı dönmesi beklenir. | evet |
| Y18 | Sunucu her sonucun _meta'sında serverInfo bildirir | 2026-07-28 | SHOULD | Spec: "servers SHOULD identify themselves in each result's _meta (io.modelcontextprotocol/serverInfo)". | evet |
| Y4 | TÜM sonuçlarda resultType ("complete" \| "input_required") | 2026-07-28 | MUST | server/discover, tools/list ve tools/call sonuçlarında alan aranır. | evet |
| Y5 | tools/list sonucunda ttlMs (CacheableResult) | 2026-07-28 | MUST | Beklenen değer 300000 (contract/protocol.md'de sabitlendi). | evet |
| Y6 | tools/list sonucunda cacheScope = "public" | 2026-07-28 | MUST | Tool listemiz statiktir, kullanıcıya özel değildir. | evet |
| Y7 | tools/list DETERMİNİSTİK sırada (sözleşme sırası) | 2026-07-28 | SHOULD | contract/tools.json sırasıyla birebir karşılaştırılır. | evet |
| Y8 | Handshake YOK — initialize olmadan çalışır | 2026-07-28 | MUST | Oturum boyunca initialize HİÇ gönderilmez; discover+list+call çalışmalı. | evet |
| Y9 | Mcp-Session-Id header'ı YOK | 2026-07-28 | MUST | Streamable HTTP yanıt header'larına bakmayı gerektirir. | **hayır** — stdio transport'unda HTTP header'ı YOKTUR. Ölçmek için üç dilin HTTP giriş noktasını (port, hazır-olma beklemesi, kapatma) ayağa kaldırmak gerekir; bu doğrulayıcı bilinçli olarak tek transport'a (stdio) sadık kalır. Elle: `npm run http` + `curl -i -X POST localhost:PORT/mcp/v2`. |
| Y10 | ping RPC'si kaldırıldı → -32601 | 2026-07-28 | MUST | ping gönderilir; metod bulunmamalı. | evet |
| Y11 | logging/setLevel kaldırıldı → -32601 | 2026-07-28 | MUST | logging/setLevel gönderilir. | evet |
| Y12 | roots/list_changed kaldırıldı → -32601 | 2026-07-28 | MUST | notifications/roots/list_changed'in istek biçimi gönderilir. | evet |
| Y13 | Hata kodları tanımlı aralıklarda (-32000..-32019 impl, -32020..-32099 spec) | 2026-07-28 | MUST | Oturumda görülen TÜM hata kodları toplanıp sınıflandırılır. | evet |
| Y14a | Desteklenmeyen protokol sürümü REDDEDİLİR | 2026-07-28 | MUST | _meta.protocolVersion="1999-01-01" gönderilir. | evet |
| Y14b | Red kodu -32022 (UnsupportedProtocolVersion) | 2026-07-28 | SHOULD | Y14a'nın hata kodu okunur. Eski numara -32004 ise geçiş tamamlanmamıştır. | evet |
| Y15a | Eksik clientCapabilities REDDEDİLİR | 2026-07-28 | MUST | _meta'dan yalnızca clientCapabilities çıkarılıp server/discover gönderilir. | evet |
| Y15b | Red kodu eski taslak numarası (-32003) DEĞİL | 2026-07-28 | SHOULD | Y15a'nın kodu okunur; -32021 (spec) veya -32602 (invalid params) kabul, -32003 geçiş yapılmadı demektir. | evet |
| Y16 | HeaderMismatch → -32020 | 2026-07-28 | MUST | Mcp-Method header'ı gövdedeki metottan farklı gönderilmelidir. | **hayır** — Yalnızca Streamable HTTP'de anlamlıdır — stdio'da header kavramı yoktur (bkz. Y9). |
| Y17 | Streamable HTTP POST'ta Mcp-Method ve Mcp-Name header'ları | 2026-07-28 | MUST | HTTP POST isteğinin header'ları incelenir. | **hayır** — Yine HTTP'ye özgü (bkz. Y9). Ayrıca bu bir İSTEMCİ yükümlülüğüdür; sunucuyu sondalayarak değil, istemcinin gönderdiği isteğe bakarak doğrulanır. |
| | **MRTR (2026-07-28)** | | | | |
| M1 | Onay gerektiren çağrı resultType:"input_required" döner | 2026-07-28 | MUST | xurrent_create_time_entry dryRun'sız çağrılır (XURRENT_CONFIRM_POLICY=closed). | evet |
| M2 | InputRequiredResult { inputRequests, requestState } taşır | 2026-07-28 | MUST | İki alanın da dolu olduğu doğrulanır. | evet |
| M3 | inputRequests değerleri yalnızca ElicitRequest \| CreateMessageRequest \| ListRootsRequest | 2026-07-28 | MUST | Her girdinin method alanı beyaz listeyle karşılaştırılır. | evet |
| M4 | Client desteklemediği inputRequest GÖNDERİLMEZ | 2026-07-28 | MUST | clientCapabilities'ten elicitation ÇIKARILIP aynı çağrı yapılır; elicit isteği gelmemeli. | evet |
| M5 | Kurcalanmış requestState REDDEDİLİR (imza/bütünlük) | 2026-07-28 | MUST | Blob'un son karakteri değiştirilip geri gönderilir; yazma OLMAMALI. | evet |
| M6 | Başka argümana iliştirilen requestState REDDEDİLİR (fingerprint) | 2026-07-28 | MUST | Geçerli blob, minutes değeri değiştirilmiş bir çağrıya iliştirilir. | evet |
| M7 | Geçerli requestState + accept → çağrı tamamlanır | 2026-07-28 | MUST | inputResponses={"<key>":{action:"accept",content:{...}}} + requestState ile tekrar. | evet |
| M8 | requestState TEK KULLANIMLIK (nonce) | 2026-07-28 | SHOULD | Aynı blob ikinci kez gönderilir; reddedilmeli. | evet |
| M9 | Retry'de JSON-RPC id FARKLI | 2026-07-28 | MUST | İki turun id'leri karşılaştırılır (istemci yükümlülüğü — sonda kendi davranışını kanıtlar). | evet |
| M10 | requestState TTL'lidir (5 dk) | 2026-07-28 | SHOULD | TTL dolana kadar beklenip blob tekrar gönderilmelidir. | **hayır** — XURRENT_STATE_TTL varsayılanı 300 sn. Doğrulamak için 5 dakika beklemek gerekir; CI'da kabul edilemez. XURRENT_STATE_TTL=1 ile elle: `XURRENT_STATE_TTL=1 node scripts/mcp-uyum.mjs --sunucu ts` sonrası ikinci turu geciktirin. |
| M11 | requestState principal'a bağlıdır (çapraz kullanıcı reddi) | 2026-07-28 | SHOULD | A kullanıcısının blob'u B kullanıcısının oturumuna taşınmalıdır. | **hayır** — İki FARKLI authenticated principal gerektirir. Mock modda tek kimlik vardır ($me → TW9jay9QZXJzb24vMQ); ikinci bir kimlik ancak live modda veya fixtures'ı değiştirerek üretilir — ikisi de bu doğrulayıcının kapsamı dışında. Kod tarafı: core/confirm.* içinde principal alanı imzalanır. |
| | **2025-11-25** | | | | |
| G1 | initialize kabul edilir ve protocolVersion döner | 2025-11-25 | MUST | initialize + protocolVersion=2025-11-25 gönderilir. | evet |
| G2 | Capabilities pazarlığı: serverInfo + capabilities döner | 2025-11-25 | MUST | initialize sonucunda iki alan da aranır. | evet |
| G3 | notifications/initialized sonrası oturum kullanılabilir | 2025-11-25 | MUST | Bildirim yollanır, ardından tools/list çağrılır. | evet |
| G4 | Sunucu-başlatmalı elicitation/create geliyor | 2025-11-25 | MUST | elicitation yeteneği bildirilip yazma tool'u çağrılır; sunucu İSTEK göndermeli. | evet |
| G5 | ElicitResult action="accept" işlenir → yazma tamamlanır | 2025-11-25 | MUST | accept + content döndürülür. | evet |
| G6 | ElicitResult action="decline" işlenir → yazma YOK | 2025-11-25 | MUST | decline döndürülür; sonuç isError=true olmalı ve mutation çalışmamalı. | evet |
| G7 | ElicitResult action="cancel" işlenir → yazma YOK | 2025-11-25 | MUST | cancel döndürülür. | evet |
| G8 | v1 sonucunda resultType YOKTUR (client complete saymalı) | 2025-11-25 | SHOULD | tools/call sonucunda alanın bulunmaması beklenir; varsa bilgi notu düşülür. | evet |
| | **Tool katmanı** | | | | |
| T1 | Tool adları contract/tools.json ile birebir | her ikisi | MUST | tools/list adları sözleşmeyle karşılaştırılır. | evet |
| T2 | Her tool inputSchema bildirir (type="object") | her ikisi | MUST | Her tool'un inputSchema.type alanı okunur. | evet |
| T3 | Her tool outputSchema bildirir | her ikisi | MUST | 8/8 beklenir; eksikse structuredContent üretilemez. | evet |
| T4 | outputSchema varsa structuredContent ZORUNLU | her ikisi | MUST | xurrent_whoami çağrılır; structuredContent dolu olmalı. | evet |
| T5 | structuredContent'in YANI SIRA okunabilir text block | her ikisi | SHOULD | content[] içinde en az bir type='text' aranır. | evet |
| T6 | structuredContent sözleşmedeki required alanları taşır | her ikisi | MUST | whoami çıktısında person/account/mode aranır. | evet |
| T7 | isError semantiği: iş kuralı hatası JSON-RPC hatası DEĞİLDİR | her ikisi | MUST | minutes=7 (timeIncrement=30'un katı DEĞİL) ile yazma denenir; isError=true + okunabilir metin beklenir. | evet |
| T8 | annotations (readOnly/destructive/idempotent/openWorld) sözleşmeyle aynı | her ikisi | MUST | Sözleşmedeki her annotation değeri tek tek karşılaştırılır. | evet |
| T9 | $ref/$defs çözülüyor (dangling referans yok) | her ikisi | MUST | Şemalardaki tüm $ref'ler kendi belgeleri içinde çözülmeye çalışılır. | evet |
| T10 | Her tool anlamlı bir description taşır | her ikisi | SHOULD | Boş veya 10 karakterden kısa description LLM'i yanıltır. | evet |
| | **Güvenlik/deprecation** | | | | |
| D1 | Roots KULLANILMIYOR (deprecated) | her ikisi | MUST | Sunucu roots/list isteği göndermemeli + kaynakta roots kullanımı olmamalı. | evet |
| D2 | Sampling KULLANILMIYOR (deprecated) | her ikisi | MUST | sampling/createMessage isteği gelmemeli + kaynakta kullanım olmamalı. | evet |
| D3 | Logging KULLANILMIYOR (deprecated) — loglar stderr'e | her ikisi | MUST | Spec: istekte logLevel YOKSA sunucu notifications/message emit ETMEMELİ. Sonda logLevel hiç göndermez → hiç bildirim gelmemeli. Ayrıca kaynak taranır. | evet |
| D4 | HTTP+SSE transport KULLANILMIYOR (Streamable HTTP kullanılır) | her ikisi | SHOULD | Kaynak taraması: SSEServerTransport / sse_app / 2024-11-05 izleri aranır. | evet |
| D5 | OAuth DCR KULLANILMIYOR (yerine CIMD) | her ikisi | SHOULD | Kaynak taraması: registration_endpoint / RFC 7591 kayıt uçları aranır. | evet |

---

# KENDİ MCP SUNUCUNU YAZARKEN BU LİSTEYİ NASIL KULLANIRSIN

Bu checklist Xurrent'a özgü değildir. `T1`/`T6`/`T8` sözleşmeye bakar (kendi sözleşmenizi
koyun), geri kalan **57 madde her MCP sunucusu için geçerlidir**.

## 1. Sırayla değil, katman katman geç

Maddeler bilerek gruplanmıştır. Alttaki katman çalışmadan üsttekini test etmenin anlamı yoktur:

```
JSON-RPC 2.0 temeli   ← burası kırıksa geri kalan her ölçüm gürültüdür
   ↓
Transport (stdio: stdout saflığı / HTTP: header'lar)
   ↓
Protokol revizyonu (_meta · server/discover · resultType · CacheableResult)
   ↓
Tool katmanı (schema · structuredContent · isError · annotations)
   ↓
Onay akışı (MRTR / elicitation) ve güvenlik (requestState imzası)
```

Bu repodaki bulguların **üçü en alt katmanda** (`J4`, `J5`) çıktı. Onay akışının kriptografisini
doğrularken bozuk JSON'a cevap vermediğinizi fark etmemek kolaydır.

## 2. Önce negatif testleri yaz

En değerli beş madde şunlardır ve hepsi **yanlış istek göndererek** ölçülür:

| Gönder | Bekle | Yakaladığı |
|---|---|---|
| Bilinmeyen metod | `-32601` | Yönlendirme tablosunun sessiz "her şeye evet" hâli |
| `tools/call`, `name` alanı yok | `-32602` (`-32603` **değil**) | Şema hatasının Internal error'a sarılması |
| Yarım JSON satırı | `-32700` + `id:null` | Çerçeveleme (framing) hataları |
| `_meta`'sız `server/discover` | `-32602` (`-32601` **değil**) | Uyumluluk sondasını yanıltan red kodu |
| Kurcalanmış `requestState` | red | İmzasız güven sınırı |

Pozitif testler "çalışıyor mu"yu ölçer; negatif testler **"kırılınca ne oluyor"**u. Üretimde
sizi arayan hep ikincisidir.

## 3. `isError`'ı ilk günden doğru bağla

Bu repodaki en ciddi bulgu buydu ve **üç dilden ikisinde** vardı. Kural tek cümledir:

> İş kuralı hatası **JSON-RPC hatası değildir** — `isError: true` + okunabilir metinle döner.
> Ve `errors[]` doluyken `isError` **asla** false/eksik kalmaz.

İki ayrı hata kanalınız varsa (protokol hatası ve iş hatası) ikisinin arasındaki köprüyü
**tek bir yerde** kurun. Üç yerde kurulursa üçünde de aynı olmaz — ölçüm bunu gösteriyor.

## 4. Spec'in MUST/SHOULD ayrımını kendi ev kurallarınla karıştırma

Bu belgeyi yazarken üç maddenin seviyesi **düzeltildi**:

- `tools/list` deterministik sıra → spec'te **SHOULD**, bizde MUST yazıyordu
- `_meta.clientInfo` → spec'te **SHOULD**, "zorunlu üç anahtar" diye MUST yazıyordu
- `-32021` red kodu → `-32602` de savunulabilir; madde "eski taslak numarası (`-32003`) olmasın"a çevrildi

Ev kuralınız spec'ten katı olabilir — olsun. Ama checklist'te **spec'in dediği** yazmalıdır,
yoksa kendi tercihinizi başkasına ihlal diye raporlarsınız. `clientInfo`'yu zorunlu sanmak,
bu repoda uyumlu client'ları kıran gerçek bir davranışa yol açtı (Bulgu 5).

## 5. Testin kendisini de test et

`T7` maddesi ilk yazıldığında **üç dilde birden** KALDI veriyordu ve bu doğru görünüyordu.
Gerçek sebep sondaydı: olmayan bir `targetId` + `dryRun: true` gönderiyordu, ama dry-run hiçbir
mutation göndermediği için "böyle bir kayıt yok" hatası **hiç oluşmuyordu**. Test, olmayan bir
ihlali raporluyordu.

> Bir uyum aracında en tehlikeli hata yanlış negatif değil, **yanlış pozitiftir**: ekip
> düzeltilecek bir şey olmadığını anlayınca aracın tamamına güvenmeyi bırakır.

Sonda `minutes: 7` (timeIncrement 30'un katı değil) ile değiştirildi — şemadan geçen ama iş
kuralından geçmeyen bir istek. O anda TypeScript geçti, Python ve C# **gerçek** bir ihlalle
kaldı. Yani gerçek bulgu, ancak sahte bulgu temizlendikten sonra görünür oldu.

**Kural:** bir madde her yerde aynı sonucu veriyorsa, önce testten şüphelen. Bir maddenin
dillere göre **farklılaşması** o testin gerçekten bir şey ölçtüğünün en iyi kanıtıdır.

## 6. Çıkış kodunu MUST'a bağla

`mcp-uyum.mjs` yalnızca **MUST** maddesi kaldığında 1 döner. SHOULD ihlalleri raporda görünür
ama CI'yı kırmaz. Bu ayrım olmazsa iki şeyden biri olur: ya SHOULD'lar MUST gibi davranıp
derlemeyi tıkar, ya da hepsi birlikte görmezden gelinir.

## İlgili belgeler

- `contract/protocol.md` — çift protokol sözleşmesi ve `_meta` tuzağının ilk ölçümü
- `docs/09-protokol-gecisi.md` — 2026-07-28 revizyonunun ayrıntılı anlatımı
- `docs/03-mcp-tasarimi.md` — tool envanteri ve dry-run mimarisi
- `scripts/verify-contract.mjs` — sözleşme doğrulayıcı (bu aracın kardeşi)

## Kaynaklar

- [Spec 2026-07-28 — Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Multi Round-Trip Requests (MRTR)](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- [Hata kodu tahsis politikası](https://modelcontextprotocol.io/specification/2026-07-28/basic/index#error-codes)
- [Feature lifecycle / deprecation](https://modelcontextprotocol.io/community/feature-lifecycle)
- [JSON-RPC 2.0](https://www.jsonrpc.org/specification)
