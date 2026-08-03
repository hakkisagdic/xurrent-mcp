# servers/python — Xurrent MCP sunucusu (Python)

`contract/tools.json` sözleşmesindeki **8 tool**'u birebir implemente eder ve
`fixtures/` klasöründeki ortak mock veriyi okur. TypeScript ve C#
implementasyonlarıyla **aynı sayıları** üretir.

## 60 saniyede başla

Token, hesap veya internet bağlantısı gerekmez. Varsayılan **mock** moddur.

```bash
cd servers/python
uv sync
uv run xurrent-mcp --wizard
```

## Çalıştırma modları

| Komut | Ne yapar | API key |
|---|---|---|
| `uv run xurrent-mcp` | **stdio MCP sunucusu** (varsayılan). `.mcp.json` bunu bekler | gerekmez |
| `uv run xurrent-mcp --http` | Streamable HTTP MCP sunucusu (`MCP_HTTP_PORT`, `/mcp`) | gerekmez |
| `uv run xurrent-mcp --wizard` | Sihirbaz — `docs/wizard/steps.json`'ı yürütür, LLM kullanmaz | gerekmez |
| `uv run xurrent-mcp --chat` | Terminal chatbot | `GEMINI_API_KEY` |
| `uv run xurrent-mcp --web` | Web arayüzü (`WEB_PORT`, `clients/web` servis edilir) | `GEMINI_API_KEY` |

## LLM sağlayıcısı: Gemini (tek sağlayıcı)

Chatbot ve web sohbeti **Google Gemini** kullanır. Anthropic kodu, bağımlılığı ve
env değişkenleri **kaldırılmıştır**.

| Değişken | Varsayılan | Ne yapar |
|---|---|---|
| `GEMINI_API_KEY` | *(boş)* | Chatbot/web için gerekir. MCP sunucusu için **gerekmez** — LLM'i host uygulama sağlar |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Model kimliği |
| `GEMINI_BASE_URL` | `https://generativelanguage.googleapis.com` | Uç nokta kökü. Sahte sunucuya yönlendirmek için değiştirilir |

**Neden `gemini-3.6-flash`:** [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
listesinde **Stable** işaretli en güncel flash modelidir ve "agentic" görevler
için önerilen dengeli seçenektir. Preview modeller (ör. `gemini-3-flash-preview`)
2 hafta ihbarla kaldırılabildiği için ders materyalinde kullanılmaz.

**SDK yok, düz `httpx`.** `generateContent` tek bir POST'tur; `httpx` zaten
Xurrent GraphQL için bağımlılık listesinde. Wire formatının görünür kalması
bilinçli bir ders tercihidir.

```
POST {GEMINI_BASE_URL}/v1beta/models/{model}:generateContent
x-goog-api-key: <anahtar>
```

> ⚠️ **Anahtar URL'e KOYULMAZ.** Query string ters vekil, CDN ve erişim
> loglarına düşer; bir kez düştü mü anahtar sızmış sayılır. `config.warnings()`
> `GEMINI_BASE_URL` içinde `key=` görürse uyarır.

### Gemini'nin Anthropic'ten ayrıldığı dört nokta

| | Anthropic Messages | Gemini `generateContent` |
|---|---|---|
| Sistem mesajı | `system` parametresi | ayrı `systemInstruction` alanı — `contents` içine **konmaz**, `"system"` diye bir rol **yoktur** |
| Roller | `user` / `assistant` | `user` / **`model`** |
| Tool sonucu | `tool_result` bloğu, `user` mesajında | `functionResponse` parçası, yine **`user`** rolünde; `response` bir **obje** olmalı |
| Eşleştirme | `tool_use_id` | `functionResponse.id` = `functionCall.id` — **aynı olmak zorunda**, yoksa API eşleştiremez |

Model bir `functionCall` için `id` üretmediyse (tek çağrıda sık olur) biz de `id`
**göndermeyiz**; uydurulmuş bir id eşleşmeyi bozar.

### ★ Şema çevirisi — asıl mühendislik problemi

MCP `inputSchema` **tam JSON Schema 2020-12**'dir (2026-07-28 revizyonu bunu
bilerek gevşetti). Gemini `functionDeclarations.parameters` ise OpenAPI
şemasının **dar bir alt kümesini** kabul eder:

```
type · properties · required · description · enum · items
$defs -> defs   ve   $ref -> ref     ← dolar işareti YOK
ref yalnızca defs'in DOĞRUDAN çocuğunu gösterebilir; dış referans yok
defs yalnızca KÖK seviyede; azami iç içe derinlik 32
```

Aradaki çevirici `src/xurrent_mcp/llm/schema.py`'dedir. **Saf bir fonksiyondur**
(girdiyi değiştirmez, I/O yapmaz) ve **ne attığını kaydeder**. Rapor açılışta
stderr'e basılır — bu bir ders artifaktıdır:

```
Sema cevirisi (MCP JSON Schema 2020-12 -> Gemini OpenAPI alt kumesi): 8 tool, 35 anahtar atildi.
  calendar_list_today: 7 anahtar atildi -> additionalProperties, default, pattern
  xurrent_list_open_work: 7 anahtar atildi -> additionalProperties, default, maximum, minimum
  ...
  Toplam dagilim: defaultx19, additionalPropertiesx8, patternx3, maxItemsx1,
                  maxLengthx1, maximumx1, minItemsx1, minimumx1
```

İki incelik:

- **`default` kaybolmaz** — description'a metin olarak eklenir
  (`"Person node ID veya '$me'. Varsayilan: '$me'."`). Gemini şemasında `default`
  alanı yok; modelin "boş bırakırsam ne olur" bilgisini taşıyacak tek yer burası.
- **Tipsiz `enum`'a `type: "string"` eklenir.** Sözleşmede `{"enum": [...]}` biçimi
  bol; Gemini enum'u tip olmadan değerlendiremez.
- **Parametresiz tool'da `parameters` hiç gönderilmez.** Boş bir
  `{"type":"object","properties":{}}` bazı sürümlerde `INVALID_ARGUMENT` verir.

Birim testi: `tests/test_schema.py` — 8 tool'un hepsinin çevrildiğini ve atılan
anahtarların listelenebildiğini doğrular.

```bash
uv run pytest tests/test_schema.py -q      # 16 passed
uv run python tests/test_schema.py         # pytest'siz düz assert koşucusu
```

## Çekirdek iş mantığının birim testleri

```bash
uv run pytest -q
```

Sihirbaz, sözleşme doğrulayıcı ve senaryo koşucuları iş mantığını yalnızca
**dolaylı** test eder: bir kenar durum bozulduğunda uçtan uca akış genelde yine
geçer ve hata ancak üretimde görünür. `tests/` altındaki dosyalar strateji,
ön kontrol, takvim, eşleştirme ve onay imzalama mantığını **doğrudan** kilitler.

Üç kural geçerlidir ve `tests/conftest.py` bunları zorlar:

| Kural | Nasıl |
|---|---|
| **I/O yok, ağ yok** | Sağlayıcıların yalnızca alan eşleme fonksiyonları çağrılır, `fetch()` değil. Fixture JSON'u okumak serbest. |
| **Gerçek zamana bağlı değil** | Autouse fixture `today_in`'i sabitler. ★ Yerel 00:00–03:00 arası UTC tarihi bir gün geridedir; bu repoda tam olarak bu yüzden gece kırılan bir test yaşandı. |
| **Test adı = iddia** | `test_two_step_ikinci_adimda_assignment_alani_GONDERMEZ` — ad, doğrulanan kuralı söyler. |

`xfail` işaretli testler **gerçek, düzeltilmemiş bulgulardır** ve özet satırında
gerekçeleriyle görünürler (`addopts = "-rxX"`); yeşile dönerlerse işaret
kaldırılmalıdır.

### API anahtarsız uçtan uca test

`tools/fake-gemini` Gemini wire formatını taklit eder. Model **değildir** —
doğru şekilli bir `candidates[].content.parts[]` döndürür; tool döngüsünü, şema
çevirisini ve id eşleşmesini test eder.

```bash
node tools/fake-gemini/server.mjs --mod otomatik --port 5102

GEMINI_BASE_URL=http://127.0.0.1:5102 GEMINI_API_KEY=sahte \
  uv run xurrent-mcp --chat
```

`GEMINI_BASE_URL` varsayılandan farklıysa `config.warnings()` bunu açıkça söyler
— "gerçek Gemini'ye değil, bu adrese istek gidiyor".

## ⚠️ MCP sürüm kararı: `mcp==2.0.0` (1.x'e DÜŞÜLMEDİ)

Bu implementasyon **mcp 2.0.0** (2026-07-28 spec revizyonu) kullanır.
Kurulumdan sonra `site-packages` içindeki gerçek API incelendi; 1.x'ten şu
farklar tespit edilip ona göre kodlandı:

| Konu | mcp 1.x | mcp 2.0.0 (bu kod) |
|---|---|---|
| Tip paketi | `mcp.types` | ayrı `mcp_types` paketi (`mcp.types` hâlâ alias) |
| Alan adları | `inputSchema`, `isError` | `input_schema`, `is_error`, `structured_content` (wire'da camelCase'e serileşir) |
| Düşük seviye handler kaydı | `@server.list_tools()` dekoratörü | **constructor tabanlı**: `Server(name, on_list_tools=..., on_call_tool=...)` |
| Ergonomik sunucu | `FastMCP` | `MCPServer` (`mcp.server.mcpserver`) |
| Handler imzası | `(params)` | `(ctx: ServerRequestContext, params)` |

**Neden `MCPServer` (eski FastMCP) değil de düşük seviye `Server`:**
`MCPServer.tool()` dekoratörü `inputSchema`'yı **fonksiyon imzasından üretir**.
Bizim sözleşmemiz `contract/tools.json`'da birebir tanımlı — `default`'lar,
`enum`'lar, `pattern`'ler, `additionalProperties: false`, `maxLength`. Şema
üretimine bırakmak sözleşme testini (`scripts/verify-contract.mjs`) kırar.
Düşük seviye `Server` şemayı elle vermeye izin verdiği için o seçildi.

**Python sürümü:** 3.13 (`.python-version`). Sistem Python 3.9 **yetmez** —
`mcp` 3.10+ ister ve `mcp_types` `typing.TypeAlias` kullanır.

## Çift protokol: tek SDK, iki kabuk

`mcp==2.0.0` tek süreçte **her iki revizyonu birden** konuşur — elle v1/v2
adaptörü yazmak gerekmez. Ölçülmüş davranış:

| İstek | Cevap |
|---|---|
| `server/discover` (`_meta` ile) | `supportedVersions: ["2026-07-28"]` |
| `server/discover` (`_meta` YOK) | `-32601 Method not found` |
| `initialize` | `protocolVersion: 2025-11-25` |

`_meta` içinde zorunlu üç anahtar: `io.modelcontextprotocol/protocolVersion`,
`.../clientCapabilities`, `.../clientInfo`.

> **stdio tuzağı:** bağlantının *erası* **ilk istekle kilitlenir**. Modern zarflı
> bir `server/discover` sondasından sonra aynı boru üzerinde `initialize`
> gönderilirse `-32022` alınır. Sondadan sonra v1'e düşen bir client **yeniden
> bağlanmalıdır**.

### Onay akışı iki kabukta

| | v1 (`2025-11-25`) | v2 (`2026-07-28`) |
|---|---|---|
| Nasıl sorulur | sunucu `elicitation/create` **isteği** gönderir | sunucu `InputRequiredResult` **sonucu** döner |
| Kod | `await ctx.session.elicit_form(...)` | `return types.InputRequiredResult(...)` |
| Süreklilik | bağlantı açık kalır (stateful) | istek biter; bağ **imzalı `requestState`** ile kurulur |

`requestState` HMAC-SHA256 ile imzalanır ve içinde `principal` + `exp`
(`XURRENT_STATE_TTL`, vars. 300 sn) + argüman `fingerprint`'i + tek kullanımlık
`nonce` taşır. Dört doğrulama da **yazmadan önce** yapılır; biri bile tutmazsa
`isError=true` döner ve **hiçbir mutation gönderilmez**.

### Yeni ortam değişkenleri

| Değişken | Varsayılan | Ne yapar |
|---|---|---|
| `MCP_PROTOCOL` | `2026-07-28` | `2026-07-28` → `server/discover` açık • `2025-11-25` → keşif kapalı (`-32601`), client `initialize`'a düşer • `both` → **stdio'da geçersiz** (era ilk istekle kilitlenir), net Türkçe hata + çıkış kodu 1; HTTP'de `/mcp` zaten iki erayı da kabul eder |
| `XURRENT_STATE_SECRET` | *(boş)* | `requestState` imza anahtarı. Boşsa süreç başında rastgele üretilir — yeniden başlatınca bekleyen onaylar geçersiz olur (istenen davranış) |
| `XURRENT_STATE_TTL` | `300` | `requestState` ömrü (saniye) |
| `XURRENT_CONFIRM_POLICY` | `closed` | `open` = onay hiç sorulmaz (**yalnızca CI/otomasyon**) • `closed` = onay kanalı varsa sorulur; **yoksa** live'da RED, mock'ta uyarı + devam • `strict` = onay **zorunlu**, mock modda da — onay alınamazsa RED |

Geçersiz bir `MCP_PROTOCOL` değeri **sessizce varsayılana düşmez**; okunabilir
Türkçe hata verir ve süreç 1 ile çıkar. Geçersiz bir `XURRENT_CONFIRM_POLICY`
değeri ise **en gevşek ayara değil, varsayılana** (`closed`) düşer.

### `strict` neden var — MRTR mutlu yolunu derste canlı göstermek

Varsayılan (`closed`) mock modda **fail-open**'dır: onay soramayan bir client
(web `/tool` ucu, chatbot) yazmaya devam eder, yalnızca uyarı üretilir. Bu, ders
akışını kırmamak içindir — ama onay akışının **zorunlu** olduğu bir dünyayı
göstermez.

`strict` tam olarak bunu açar: **mock modda bile** onay olmadan yazma reddedilir.
Böylece 2026-07-28 (MRTR) mutlu yolu canlı gösterilebilir:

```bash
XURRENT_CONFIRM_POLICY=strict XURRENT_MODE=mock MCP_PROTOCOL=2026-07-28 \
  uv --directory servers/python run xurrent-mcp
```

1. `tools/call` (id:1, `dryRun:false`) → `resultType:"input_required"` + imzalı `requestState`
2. `tools/call` (**id:2**, aynı argümanlar + `inputResponses` + `requestState`) → kayıt **yazılır**
3. `action:"decline"` ile tekrarlanırsa → `isError:true`, **hiçbir mutation gitmez**

> **Not:** `strict` altında onay kanalı olmayan yollar (web `/tool`, chatbot)
> yazamaz — bu, ayarın amacıdır, arızası değil.

## Yapı

Sözleşmedeki mimari kural (`contract/protocol.md`) dizin düzeyinde uygulanır:
**iş mantığı protokolden bağımsızdır**, yalnızca ince adaptör katmanı ikiye ayrılır.

```
src/xurrent_mcp/
  config.py              env okuma + doğrulama (+ basit .env yükleyici)
  models.py              contract çıktı şekillerinin dataclass karşılıkları
  timeutil.py            zoneinfo, göreli tarih materyalizasyonu, interval merge, yuvarlama
  core/                  ★ PROTOKOLDEN BAĞIMSIZ
    toolimpl.py          8 tool'un saf hâli: args in -> ToolResult | ConfirmationRequired
    confirm.py           onay talebi üretimi + requestState imzala/doğrula (HMAC-SHA256)
    schemas.py           8 outputSchema — contract/tools.json "output" alanlarından
  mcp/                   ★ İNCE ADAPTÖR — breaking change SADECE buraya dokundu
    common.py            tool beyanları (input+output şema), sonuç zarfları, ttlMs/cacheScope
    v1.py                2025-11-25: sunucu-başlatmalı elicitation/create
    v2.py                2026-07-28: InputRequiredResult + MRTR
  xurrent/
    base.py              mock ve live'ın ortak arayüzü
    queries.py           GraphQL sorgu/mutation metinleri (dry-run'da birebir gösterilir)
    mock.py              fixtures adapter
    live.py              httpx GraphQL adapter (rate limit throttling dahil)
    validate.py          ön kontroller -> errors + warnings
    strategies.py        ★ üç backdate stratejisi
  calendar/
    types.py             normalize + filtre + dedup + interval merge
    mock.py  ics.py  google.py  graph.py
  tools/
    __init__.py          8 tool'un sözleşmesi ve kayıt defteri
    read_tools.py  write_tools.py  calendar_tools.py  matching.py  runtime.py
  server.py              MCP server kurulumu; ctx.protocol_version'a göre v1/v2 seçimi
  llm/                   ★ TEK SAĞLAYICI: Gemini
    gemini.py            generateContent wire formatı (httpx, SDK yok)
    schema.py            ★ JSON Schema 2020-12 -> Gemini OpenAPI alt kümesi çevirisi (saf)
  agent.py               Gemini tool loop + Türkçe sistem promptu
  web.py                 statik clients/web + /api/config + /api/chat + /api/tool
  wizard.py              docs/wizard/steps.json yürütücü (PASS/FAIL/SKIP)
  __main__.py            CLI
tests/
  conftest.py            ortak zemin: "bugün"ü sabitleyen autouse fixture, Config/bağlam üreticileri
  test_timeutil.py       saat dilimi ve ISO8601 yardımcıları (★ gece yarısı–03:00 tuzağı)
  test_validate.py       ön kontroller: timeIncrement, backdate penceresi, tavanlar
  test_strategies.py     üç backdate stratejisi (★ two_step 2. adımda assignment yok)
  test_calendar.py       normalizasyon, atlama kuralları, dedup, clip, 225 vs 255
  test_matching.py       toplantı → ticket eşleştirme (kesin / bulanık / kullanıcı kararı)
  test_confirm.py        requestState imzalama: imza · TTL · parmak izi · nonce · principal
  test_schema.py         şema çevirisi birim testleri (pytest veya düz koşucu)
```

Sunucunun geri kalanı `llm/` paketine bağımlı **değildir**: tool uygulamaları
LLM'den hiç haberdar değildir, `llm/` yalnızca `agent.py` tarafından kullanılır.
Sağlayıcı değişimi bu yüzden tek bir dizine dokunarak yapılabildi.

`core/toolimpl` onay gerektiğinde `ConfirmationRequired` döner ve **nasıl
sorulacağını bilmez**. Aynı iş mantığı, iki farklı protokol kabuğu.

## outputSchema ve structuredContent

**8/8 tool `outputSchema` bildirir** ve her `tools/call` cevabı hem
`structuredContent` hem okunabilir Türkçe **text bloğu** taşır. İkisi birden
üretilir: şemayı anlamayan bir client metni okur, yapısal veriyi işleyen client
`structuredContent`'i kullanır.

Şemalar elle yazılır (`core/schemas.py`) çünkü düşük seviye `Server` şema
üretmez — ve üretse sözleşmeyi bozardı. `$defs` her şemanın köküne kopyalanır:
`$ref: "#/$defs/Person"` bulunduğu **dokümanın** köküne göre çözülür, `tools/list`
içinde her `outputSchema` ayrı bir dokümandır.

## Doğrulanmış mock çıktıları

`uv run xurrent-mcp --wizard` → **16 geçti, 0 başarısız, 1 atlandı**:

| Kontrol | Değer |
|---|---|
| `toolCount` | 8 |
| `xurrent_list_open_work` → `requests.totalCount` / `tasks.totalCount` | 3 / 3 |
| `xurrent_get_time_tracking_context` → `timeIncrement` | 30 |
| `xurrent_get_time_tracking_context` → `effortClasses.length` | 3 (disabled elenmiş) |
| `calendar_list_today` → `rawCount` / `count` / `filteredOut` | 8 / 5 / 3 |
| `calendar_list_today` → `busyMinutes` / `naiveSumMinutes` | 225 / 255 |
| `plan_time_entries_from_calendar` → `proposals.length` | 5 |
| dry-run `planned.length` | two_step **2**, link_first **1**, date_first **1** |
| `xurrent_whoami` → `rateLimit` (mock) | `null` — uydurulmuş `resetAt` çıktıyı deterministik olmaktan çıkarırdı |

### PASS / FAIL / **SKIP**

Sihirbaz sonucu **üç durumludur**. Bir kontrol, ön koşulu sağlanmadığı için
*çalıştırılamıyorsa* **SKIP**'tir, FAIL değil — ikisini aynı kefeye koymak gerçek
bir regresyonu gürültünün içinde kaybeder. Özet satırı:
`SONUC: N gecti, M basarisiz, K atlandi`.

`13-iki-kabuk` adımı SKIP verir: iki protokol kabuğunu gerçekten karşılaştırmak
**iki ayrı sunucu süreci** ister; sihirbaz tek süreçte çalışır. Python'da ayrıca
`mcp==1.28.1` ile `mcp==2.0.0` **aynı ortamda yaşayamaz** (aynı paket adı) —
`uv run --with 'mcp==1.28.1' ...` ile ikinci bir ortam gerekir.

## stdio kuralı

stdio modunda **stdout SADECE JSON-RPC** taşır. Tek bir `print()` bile
protokolü bozar. Bu yüzden `logging.basicConfig(stream=sys.stderr)` ile tüm
loglar stderr'e yönlendirilir; sırlar asla loglanmaz.

## Canlı moda geçmek

```bash
XURRENT_MODE=live XURRENT_TOKEN=<PAT> XURRENT_ACCOUNT=<slug> XURRENT_DRY_RUN=1 \
  uv run xurrent-mcp
```

`XURRENT_DRY_RUN=1` iken hiçbir mutation HTTP'ye çıkmaz. **Live mod gerçek bir
Xurrent hesabına karşı çalıştırılmamıştır** — GraphQL şeması resmî
dokümantasyondan çıkarılmıştır.

> **Bölge notu:** `eu` diye bir bölge **yoktur**. Geçerli değerler: Global
> (varsayılan), `au`, `uk`, `ch`, `us`. Global zaten Avrupa'dadır.
