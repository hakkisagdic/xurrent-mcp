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
| `uv run xurrent-mcp --chat` | Terminal chatbot | `ANTHROPIC_API_KEY` |
| `uv run xurrent-mcp --web` | Web arayüzü (`WEB_PORT`, `clients/web` servis edilir) | `ANTHROPIC_API_KEY` |

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
  agent.py               Anthropic tool loop + Türkçe sistem promptu
  web.py                 statik clients/web + /api/chat + /api/tool
  wizard.py              docs/wizard/steps.json yürütücü (PASS/FAIL/SKIP)
  __main__.py            CLI
```

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
