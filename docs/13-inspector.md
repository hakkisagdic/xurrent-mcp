# 13 — Inspector: resmî araç ve bizim ekranımız

> **Bölüm hedefi:** Bir MCP sunucusunun *içine bakmayı* öğrenmek. Önce resmî
> `@modelcontextprotocol/inspector` ile — nasıl kullanılır, ne gösterir ve **nerede
> durur**. Sonra bu repodaki ekranla — resmî aracın bilemeyeceği beş şeyi nasıl ekler.

| ← Önceki | Sonraki → |
|---|---|
| [11 — Prompt defteri](11-prompt-defteri.md) | [Demo senaryosu](demo/senaryo.md) |

İlgili: [`contract/protocol.md`](../contract/protocol.md) · [09 — Protokol geçişi](09-protokol-gecisi.md) · [`clients/inspector/README.md`](../clients/inspector/README.md)

> **Bu belgedeki tüm çıktılar gerçektir.** Hiçbiri elle yazılmadı; her biri
> `XURRENT_MODE=mock` ile bu repoda çalıştırıldı ve yapıştırıldı. Ölçüm tarihi:
> 2026-08-03. Resmî araç sürümü: `inspector-cli 2.0.0`.

---

## Neden bir inspector?

Chatbot çalıştığında protokolü **göremezsiniz**. LLM araya girer, cevabı yeniden
yazar, hataları yumuşatır. Sihirbaz ([07](07-sihirbaz.md)) doğrular ama anlatmak
için tasarlanmıştır, kurcalamak için değil.

Inspector üçüncü bir şeydir: **tel seviyesinde kurcalama.** Tool'u elle çağırır,
argümanı elle değiştirir, cevabın hamını görürsünüz. Ders sırasında "peki şu alanı
boş bıraksak ne olur?" sorusunun cevabı 5 saniyede alınır.

---

## (a) Resmî inspector

### Kurulum yok

```bash
npx -y @modelcontextprotocol/inspector@latest
```

Argümansız çağrı bir **web arayüzü** açar (tarayıcı + yerel proxy). Ders sırasında
ekrana yansıtmak için uygundur; ama tekrarlanabilir değildir — bu belgedeki ölçümler
`--cli` modundan alınmıştır.

### `--cli` modu

`--cli`, arayüzü atlar ve doğrudan tek bir RPC çağırıp JSON basar. Otomasyon,
CI ve bu belge için doğru mod budur.

```bash
npx -y @modelcontextprotocol/inspector@latest --cli <komut...> --method <metod>
```

Sık kullanılan bayraklar (kaynak: `--cli --help`):

| Bayrak | Ne yapar |
|---|---|
| `--method <m>` | Çağrılacak RPC: `tools/list`, `tools/call`, `resources/list`, `prompts/list` … |
| `--tool-name <ad>` | `tools/call` için tool adı |
| `--tool-arg k=v` | Tool argümanı (tekrarlanabilir) |
| `--tool-args-json '{…}'` | Argümanları tek JSON nesnesi olarak — tip zorlaması yapmaz |
| `--format json` | Banner'sız, tek satır JSON |
| `--transport`, `--server-url` | HTTP/SSE sunucuları için |

### Üç dilin komutları

Ortam değişkenlerini **kabuktan** verin (aşağıdaki tuzağa bakın):

```bash
export XURRENT_MODE=mock CALENDAR_PROVIDER=mock XURRENT_FIXTURES_DIR=$PWD/fixtures
```

```bash
# TypeScript
npx -y @modelcontextprotocol/inspector@latest --cli \
  node servers/typescript/dist/mcp/stdio.js --method tools/list

# Python  ← uv ile DEĞİL; sebebi aşağıda
npx -y @modelcontextprotocol/inspector@latest --cli \
  servers/python/.venv/bin/xurrent-mcp --method tools/list

# C#
npx -y @modelcontextprotocol/inspector@latest --cli \
  dotnet run --project servers/csharp/XurrentMcp.csproj --no-build -- stdio \
  --method tools/list
```

Üçü de aynı sonucu verir — sözleşmenin dil-bağımsızlığı burada da görünür:

```
tool sayısı: 8
sıra: xurrent_whoami, xurrent_find_person, xurrent_list_open_work,
      xurrent_get_time_tracking_context, xurrent_create_time_entry,
      xurrent_create_time_entries_bulk, calendar_list_today,
      plan_time_entries_from_calendar
```

### `tools/call` örneği

```bash
npx -y @modelcontextprotocol/inspector@latest --cli \
  node servers/typescript/dist/mcp/stdio.js \
  --method tools/call --tool-name xurrent_whoami
```

Gerçek çıktı (kısaltılmadı, yalnızca `content[0].text` kırpıldı):

```json
{
  "content": [
    { "type": "text", "text": "Kimlik: Ayşe Demir — Kıdemli Sistem Uzmanı\nE-posta: ayse.demir@ornek.com\nNode ID: TW9jay9QZXJzb24vMQ\nHesap: Örnek A.Ş. — BT Hizmetleri (ornek-bt)\nMod: mock — fixtures/ klasöründen okunuyor…" }
  ],
  "structuredContent": {
    "person": {
      "id": "TW9jay9QZXJzb24vMQ",
      "name": "Ayşe Demir",
      "primaryEmail": "ayse.demir@ornek.com",
      "jobTitle": "Kıdemli Sistem Uzmanı",
      "timeZone": "Europe/Istanbul",
      "disabled": false,
      "organization": { "id": "TW9jay9Pcmdhbml6YXRpb24vMQ", "name": "Örnek A.Ş." }
    },
    "account": { "id": "ornek-bt", "name": "Örnek A.Ş. — BT Hizmetleri", "directory": false },
    "mode": "mock",
    "rateLimit": null
  }
}
```

Argümanlı çağrı:

```bash
npx -y @modelcontextprotocol/inspector@latest --cli \
  node servers/typescript/dist/mcp/stdio.js \
  --method tools/call --tool-name xurrent_create_time_entry \
  --tool-arg targetType=request \
  --tool-arg targetId=TW9jay9SZXF1ZXN0LzcwMjQ4 \
  --tool-arg minutes=120 \
  --tool-arg dryRun=true
```

### Hangi durumda ne işe yarar

| Durum | Resmî inspector |
|---|---|
| Yeni yazdığın sunucu ayağa kalkıyor mu? | **En hızlı yol.** Tek komut, sıfır kurulum |
| `tools/list` çıktısında bir alan var mı? | Evet — ham JSON |
| `outputSchema` bildiriliyor mu? | Evet — çıktıda görünür |
| `structuredContent` geliyor mu? | Evet |
| Bir tool'u elle çağırıp cevabı görmek | Evet, `--tool-arg` ile |
| CI'da duman testi | Evet, `--format json` + çıkış kodu |
| **Başka birinin** sunucusunu incelemek | **Tek seçenek.** Bizim ekranımız yapamaz |

---

### Sınırları — ölçülmüş

Aşağıdakiler resmî aracın kusuru değil; **genel amaçlı olmasının doğal sonucu**.
Ama ders açısından tam olarak eksik olan şeyler bunlar.

#### 1. Bizim sözleşmemizi bilmez

`contract/tools.json` MCP'nin bir parçası değil, bu repoya ait bir dosya. Resmî
inspector `tools/list` çıktısını gösterir; onun **doğru olup olmadığını** söyleyemez.
Bir parametre adı kaydığında, `readOnlyHint` ters döndüğünde veya tool sırası
bozulduğunda ekranda hiçbir şey kırmızıya dönmez.

#### 2. `teachingNotes` görünmez

```bash
# tools/list çıktısında teachingNotes aranır:
… --method tools/list | grep -c teachingNotes
# → 0
```

Beklenen sonuç budur: `teachingNotes` MCP'de olmayan bir alandır, sunucular onu
yayınlamaz. Bu repodaki en değerli içerik — filtre asimetrisi, `timeIncrement`
tuzağı, `singleEvents` varsayılanı — resmî inspector'da **hiç yoktur**.

#### 3. v2 zarfını göremez: `initialize` ile bağlanır

Aradaki teli ölçtük. Resmî CLI'ın gönderdiği ilk mesaj:

```json
{
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-11-25",
    "capabilities": {
      "roots": { "listChanged": true },
      "extensions": {
        "io.modelcontextprotocol/tasks": {},
        "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] }
      }
    },
    "clientInfo": { "name": "inspector-cli", "version": "2.0.0" }
  }
}
```

Yani resmî araç **v1 (2025-11-25) konuşur**. Sonucu şudur: `tools/list` cevabı
v1 zarfıyla döner ve v2'nin **zorunlu** cache alanları hiç görünmez:

| | Resmî inspector (`initialize`) | Bizim ekran (`server/discover`) |
|---|---|---|
| `tools/list` üst seviye anahtarlar | `["tools"]` | `["tools","resultType","ttlMs","cacheScope","_meta"]` |
| `ttlMs` | `undefined` | `300000` |
| `cacheScope` | `undefined` | `"public"` |

Bu bir araç kusuru değil, **doğru okuma**: sunucumuz `MCP_PROTOCOL=2026-07-28`
modundayken bile `initialize`'a v1 zarfıyla cevap verir (geriye dönük uyumluluk).
Ham sondayla doğrulandı:

```
MCP_PROTOCOL=2026-07-28
  initialize      -> OK protocolVersion=2025-11-25
  server/discover -> OK supportedVersions=["2026-07-28"]
MCP_PROTOCOL=2025-11-25
  initialize      -> OK protocolVersion=2025-11-25
  server/discover -> HATA -32601 Method not found
```

> **Ders notu.** "Sunucum v2 konuşuyor mu?" sorusuna resmî inspector cevap **veremez** —
> çünkü sormaz. Cevabı ancak `server/discover`'ı `_meta` ile gönderen bir sonda verir.
> Ve `-32601` ile `-32602` ayrımını bilmeyen bir sonda, v2 konuşan sunucuyu v1 sanar
> ([`contract/protocol.md`](../contract/protocol.md)).

#### 4. ★ `elicitation` yeteneğini bildirmez → onay adımı ATLANIR

Yukarıdaki `initialize` gövdesine tekrar bakın: `capabilities` içinde
**`elicitation` yok**. Sunucumuz, kullanıcıya soramayacağını anlayınca yazmayı
onaysız yapar. Gerçek çağrı:

```bash
… --method tools/call --tool-name xurrent_create_time_entry \
  --tool-arg targetType=request --tool-arg targetId=TW9jay9SZXF1ZXN0LzcwMjQ4 \
  --tool-arg minutes=120 --tool-arg dryRun=false
```

Gerçek cevap (`structuredContent`'ten):

```json
{
  "dryRun": false,
  "strategy": "two_step",
  "timeEntry": { "id": "TW9jay9UaW1lRW50cnkv1000", "assignmentId": "TW9jay9SZXF1ZXN0LzcwMjQ4", "timeSpent": 120, … },
  "errors": [],
  "warnings": [
    "two_step ATOMİK DEĞİLDİR: 1. adım başarılı olup 2. adım başarısız olabilir…",
    "İki adım = iki HTTP isteği. GraphQL istek başına 1 mutation kabul eder; transaction YOKTUR.",
    "Client protokol seviyesinde onay soramıyor. MOCK modda çalışıldığı için yazma ENGELLENMEDİ — fixtures/ klasörüne yazılıyor, gerçek bir kayıt sistemi etkilenmiyor. Live modda bu istek REDDEDİLİRDİ."
  ]
}
```

Kayıt **yazıldı** ve hiçbir onay sorulmadı. Sunucu bunu üçüncü uyarıda açıkça söylüyor
ve live modda reddedeceğini bildiriyor — tasarım doğru çalışıyor. Ama derste
göstermek istediğimiz **onay akışının kendisi** bu araçla hiç görünmez.

> Bu, dersin en iyi anlarından biridir: *"Onay, client'ın bir yeteneğidir. Client
> soramıyorsa sunucu ne yapmalı?"* Cevap — reddetmeli. Ve bu politikanın kendisi
> (`confirmPolicy: closed`) test edilebilir bir karardır.

#### 5. `--cli` argüman ayrıştırması, alt komutun bayraklarını yutar

Ölçüm: `--cli` sonrasına konan komuta *gerçekte* hangi argümanların geçtiğini
argv'sini log'a yazan bir kabuk script'iyle ölçtük.

| Yazdığınız | Alt sürecin **gerçekten aldığı** argv | Sonuç |
|---|---|---|
| `--cli node servers/typescript/dist/mcp/stdio.js --method tools/list` | `servers/typescript/dist/mcp/stdio.js` | ✅ |
| `--cli uv --directory servers/python run xurrent-mcp --method tools/list` | *(boş)* | ❌ `Connection closed` |
| `--cli uv run --directory servers/python xurrent-mcp --method tools/list` | `run` | ❌ `Connection closed` |
| `--cli dotnet run --project … --no-build -- stdio --method tools/list` | `run --project … --no-build` | ⚠ `stdio` düştü; C# varsayılanı stdio olduğu için yine de çalıştı |
| `--cli servers/python/.venv/bin/xurrent-mcp --method tools/list` | *(argümansız)* | ✅ |

**Kural:** alt komuta `--`'lı bayrak geçirmeyin. Repodaki kanonik Python komutu
(`uv --directory servers/python run xurrent-mcp` — `.mcp.json`, `wizard.mjs` ve
`verify-contract.mjs` bunu kullanır) resmî inspector ile **çalışmaz**; venv giriş
noktasını doğrudan çağırın.

`-e KEY=VALUE` bayrağı da ad-hoc çağrıda `No servers found in config file` hatası
verdi; ortam değişkenlerini kabuktan `export` edin.

> Python sunucusunun kendisi sağlamdır — aynı komut `node scripts/verify-contract.mjs
> --server py` ile sorunsuz çalışır ve **8/8 sözleşmeye tam uyumlu** döner. Sorun
> araçtadır, sunucuda değil. Bu ayrımı yapamamak, saatlerce yanlış yerde hata aramaktır.

---

## (b) Bizim ekranımız

```bash
node clients/inspector/sunucu.mjs --port 5200
# → http://127.0.0.1:5200
```

Bağımlılık yok, CDN yok, derleme yok: `sunucu.mjs` + üç statik dosya. Açık/koyu tema,
mobil uyumlu. Ayrıntı: [`clients/inspector/README.md`](../clients/inspector/README.md).

Beş sekme var ve her biri resmî araçtaki bir boşluğu kapatır.

### 1 · Protokol — pazarlığın *nasıl* yapıldığı

Ekran sondanın kendisini gösterir. Gerçek giden istek:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { "elicitation": {} },
      "io.modelcontextprotocol/clientInfo": { "name": "xurrent-inspector", "version": "1.0.0" }
    }
  }
}
```

Gerçek gelen cevap:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "supportedVersions": ["2026-07-28"],
    "capabilities": { "tools": { "listChanged": true } },
    "instructions": "Xurrent (ITSM) zaman takibi. KURALLAR: …",
    "resultType": "complete",
    "ttlMs": 300000,
    "cacheScope": "public",
    "_meta": {
      "io.modelcontextprotocol/serverInfo": {
        "name": "xurrent-mcp-typescript", "version": "1.0.0", "title": "Xurrent MCP (TypeScript)"
      }
    }
  }
}
```

Ekrandaki açıklama, üretilmiş metin değil — sondanın kendi çıkarımı:

> `server/discover` KABUL EDİLDİ. El sıkışma yapılmadı; sunucu kimliğini sonucun
> `_meta.io.modelcontextprotocol/serverInfo` alanında bildirdi. Bundan sonraki HER
> istekte `_meta` bloğu tekrar gönderilecek.

`_meta` bloğu giden isteklerde **sarı** boyanır: v2'de bu blok her istekte gitmek
zorundadır ve birini unutmak isteği reddettirir.

Sonda başarısız olursa ekran `-32601` (gerçekten v1 sunucu) ile `-32602` / `-32021`
(**istemci** hatası, `_meta` eksik) ayrımını açıkça yapar ve ikincisinde **v1'e düşmez**.

#### İki revizyonu yan yana

"Yan yana çalıştır" düğmesi aynı tool'u **iki ayrı süreçte** çalıştırır. Zorunludur:
`initialize` yapılmış bir bağlantıya v2 zarflı istek göndermek reddedilir.

`xurrent_create_time_entry` (`dryRun: false`) ile ölçülen gerçek sonuç:

```
v2 tel: →server/discover ←yanıt →tools/call ←yanıt(input_required) →tools/call ←yanıt
v1 tel: →initialize ←yanıt →notifications/initialized →tools/call
        ←SUNUCU İSTEĞİ elicitation/create →cevabımız ←yanıt

v2 onay akışı : InputRequiredResult + isteğin YENİ id ile tekrarı (MRTR) — 2 tur
v1 onay akışı : sunucu→client İSTEĞİ (elicitation/create) — 1 tur

structuredContent: KANONİK OLARAK AYNI
```

Dersin ana mesajı tam olarak bu ekranda ölçüye dönüşür: **tel bambaşka, çıktı aynı.**

### 2 · Sözleşme — canlı doğrulama

`tools/list` çıktısı `contract/tools.json`'a karşı tarayıcıda doğrulanır. Kontroller
`scripts/verify-contract.mjs` ile **birebir aynıdır** — tool adları, parametreler,
`required`, annotation'lar, `outputSchema`, çıktı alanları, `tools/list` sırası ve
v2'nin `ttlMs`/`cacheScope` alanları. Fark bulunursa satır kırmızıya döner.

Üç sunucuda da ölçülen sonuç: **0 fark**, `outputSchema` 8/8, sıra sözleşmeyle aynı.

### 3 · Tool — teachingNotes + şemadan form

Tool seçilince yan yana üç şey görünür:

- **`teachingNotes`** — sözleşmeden okunur, sunucudan değil. Resmî inspector'ın
  göremediği içerik.
- **`inputSchema` → form.** Tip, `enum`, `required`, `default`, `pattern`,
  `maxLength`, `minimum`, `maximum` hepsi **rozet olarak görünür**; form gizlemez,
  gösterir. Alanın sözleşmedeki açıklaması altında ve `title` olarak durur.
- **`outputSchema`** — zorunlu alanlar yıldızlı.

İki incelik forma gömülüdür:

- Boolean alanlar **üç durumludur**: `(gönderme)` · `true` · `false`. Bir alanı hiç
  göndermemek ile `false` göndermek aynı şey değildir; ilkinde sunucu varsayılanı uygulanır.
- Boş bırakılan alan **gönderilmez**.

### 4 · Yanıt anatomisi

Bir `tools/call` cevabı parçalarına ayrılıp Türkçe etiketlenir:

| Parça | Ekranda yazan |
|---|---|
| `content[]` | **İnsan (ve LLM) için.** LLM'in bağlamına giren asıl şey. `structuredContent` olsa bile boş bırakılmamalıdır |
| `structuredContent` | **Makine için.** `outputSchema`'ya uyan çıktı. "Üç dil aynı çıktıyı üretir" tezi ancak bu alan doluysa ölçülebilir |
| `isError` | **İş kuralı hatası bayrağı.** JSON-RPC `error` ile karıştırılmamalı: `isError:true` "istek geçerliydi, iş reddedildi" demektir ve LLM bunu okuyup düzeltebilir |
| `resultType` | **Sonuç zarfı türü.** v2'de zorunlu: `complete` \| `input_required`. Alanı olmayan sonucu client `complete` saymalıdır |
| `_meta.io.modelcontextprotocol/serverInfo` | **Sunucu kimliği.** v2'de el sıkışma olmadığı için HER sonuçta tekrar gelir |

Sözleşmede zorunlu olup `structuredContent`'te bulunmayan alan varsa kırmızı yazılır.

### 5 · MRTR / onay görselleştirmesi

Yazma tool'u onay isterse akış beş adımda çizilir:

```
1. tools/call            id: 3
2. InputRequiredResult   resultType:"input_required" + inputRequests + requestState
   └─ bu bir SONUÇ; istek burada SONLANDI, sunucu state tutmuyor
3. kullanıcıya sorulur   (ekrandaki form)
4. tools/call            AYNI çağrı, YENİ JSON-RPC id + inputResponses + requestState
5. resultType:"complete"
```

`requestState` ekranda **çözülür** — imza doğrulanmaz, yalnızca base64url gövdesi
okunur ve her alanın ne işe yaradığı yazılır. Gerçek gövde:

```json
{ "principal": "TW9jay9QZXJzb24vMQ", "fingerprint": "…", "nonce": "…", "exp": …, "tool": "xurrent_create_time_entry" }
```

| Alan | Ne işe yarar |
|---|---|
| `principal` | Authenticated person id. Başka principal ile gelen state **reddedilir** |
| `fingerprint` | Metod + argümanların SHA-256 özeti. Farklı çağrıya iliştirilen state **reddedilir** |
| `nonce` | Tek kullanımlık; süreç içi bir sette tutulur |
| `exp` | 5 dakikalık TTL |

Ekran ayrıca şunu yazar: spec `requestState`'i **saldırgan kontrolündeki girdi**
olarak tanımlar; client onu anlamak zorunda değildir ve **anlamamalıdır** — aynen
geri göndermekle yükümlüdür.

v1 seçilirse aynı yer **başka bir akış** çizer: sunucu bize `elicitation/create`
**isteği** gönderir, cevaplamadan `tools/call` cevabı asla gelmez. Ekranda bu, yön
oku ters çevrilerek gösterilir.

### Güvenlik işaretlemesi

- Yazma tool'ları (`readOnlyHint:false`) listede **kırmızı `YAZMA` rozeti** taşır ve
  tool açıldığında kırmızı bir uyarı bloğu görünür.
- `dryRun` formda **`true` olarak gelir**. Sözleşmedeki varsayılan `false`'tur; ekran
  onu bilerek ters çevirir ve bunu yazıyla söyler.
- Çocuk süreçler her zaman `XURRENT_MODE=mock`; `.env` okunmaz.
- Tarayıcı komut veremez: `ts` / `py` / `cs` allowlist'i. Sunucu yalnızca
  `127.0.0.1`'i dinler.

---

### Derste hangi anda kullanılır

| An | Sekme | Ne gösterilir |
|---|---|---|
| "MCP nedir" anlatıldıktan hemen sonra | **Protokol** | Pazarlığın ham hâli. Öğrenci protokolün 40 satırlık JSON olduğunu görür |
| "Üç dil aynı sözleşme" iddiası | **Sözleşme** | İddia ölçüye dönüşür. Dili değiştirip tekrar bağlanın |
| Tool tasarımı konusu | **Tool** | `teachingNotes` + şemadan form. LLM'in gördüğü şeyin insan hâli |
| Onay/güvenlik konusu | **Tool** → yazma tool'u | MRTR beş adımda çizilir; `requestState` çözülür |
| Protokol geçişi ([09](09-protokol-gecisi.md)) | **Protokol** → yan yana | İki tel bambaşka, `structuredContent` aynı |
| Kapanış | **Ham trafik** | "Aslında hepsi bu" anı: satır satır JSON-RPC |

Sekme sırası anlatım sırasıyla aynıdır; soldan sağa gidilirse ders akar.

---

## (c) Karşılaştırma

| Konu | Resmî inspector | Bu ekran |
|---|---|---|
| Kurulum | `npx`, sıfır kurulum | `node clients/inspector/sunucu.mjs` |
| Bağımlılık | npm paketi indirir | **Yok** — Node stdlib + 3 statik dosya |
| Hangi sunucularla çalışır | **Her MCP sunucusu**, stdio/HTTP/SSE | Yalnızca bu repodaki 3 sunucu (allowlist) |
| Konuştuğu revizyon | **v1** (`initialize`, `2025-11-25`) — ölçüldü | v1 **ve** v2, seçilebilir |
| Pazarlığın *nasıl* olduğu | Göstermez | ✅ Ham sonda istek/cevabı |
| v2 zarfı (`ttlMs`, `cacheScope`, `resultType`) | Göremez (v1 konuşuyor) | ✅ Görünür ve doğrulanır |
| İki revizyon yan yana | ✘ | ✅ İki süreç, `structuredContent` karşılaştırması |
| `contract/tools.json` uyumu | ✘ Bilmez | ✅ Canlı doğrulama, farklar kırmızı |
| `teachingNotes` | ✘ Böyle bir MCP alanı yok | ✅ Tool'un yanında |
| Şemadan form | ✅ Var | ✅ Var + kısıtlar rozet olarak + sözleşme açıklaması |
| Yanıt anatomisi | JSON'ı gösterir | ✅ Her parça Türkçe etiketli, ne işe yaradığı yazılı |
| `elicitation` yeteneği | ✘ Bildirmez → **onay atlanır** | ✅ Bildirir → onay akışı çalışır |
| MRTR akışı | ✘ Çizmez | ✅ 5 adım + `requestState` çözümü |
| Yazma tool'u işaretlemesi | Annotation'ı listeler | ✅ Kırmızı rozet + uyarı bloğu + `dryRun` açık |
| CI'da kullanım | ✅ `--format json` | ✘ İnsan içindir (CI için `verify-contract.mjs` var) |
| Ekip dışına taşınabilirlik | ✅ Herkes kullanır | ✘ Bu repoya özgü |

**Özet:** resmî inspector *bir MCP sunucusuna* bakar; bu ekran *bu sözleşmeye* bakar.
İkisi rakip değil. Yeni bir sunucu yazarken resmî araç daha hızlıdır; **öğretirken**
bu ekran gerekir, çünkü öğretilecek şeylerin çoğu genel amaçlı bir araçta tanımsızdır.

---

## Doğrulama — tarayıcısız

Bu belgedeki her iddia komutla üretildi. Tarayıcı olmadan da sınanabilir:

```bash
# Sözdizimi
node --check clients/inspector/sunucu.mjs
node --check clients/inspector/app.js

# Uçlar
node clients/inspector/sunucu.mjs --port 5200 &
curl -s localhost:5200/api/sunucular | jq '.sozlesme.toolSayisi'          # 8
curl -s -X POST localhost:5200/api/baglan -H 'content-type: application/json' \
     -d '{"dil":"ts","protokol":"2026-07-28"}' | jq '.sonda.konusulan'     # "v2"
curl -s -X POST localhost:5200/api/cagir -H 'content-type: application/json' \
     -d '{"metod":"tools/call","params":{"name":"xurrent_whoami","arguments":{}}}' \
     | jq '.cevap.result.resultType'                                       # "complete"
curl -s localhost:5200/api/kopar | jq '.koparildi'                         # true
```

`app.js` DOM'suz da test edilebilir: dosya bir **script**'tir (modül değil), bu yüzden
`node:vm` içinde sahte bir `document`/`localStorage` ile yüklendiğinde üst seviye
`function` bildirimleri context'in global'i olur. Aynı context'te çalıştırılan ikinci
bir script `const durum` bağlamasını da görür:

```js
const ctx = vm.createContext({ document: sahteDom, localStorage: sahteDepo, /* … */ });
vm.runInContext(readFileSync("clients/inspector/app.js", "utf8"), ctx);
vm.runInContext("durum.sozlesme = __sozlesme", ctx);
vm.runInContext("sozlesmeKarsilastir(__tools, __list, 'v2')", ctx);   // → []
```

Bu yöntemle ölçülenler: gerçek `tools/list` çıktısına karşı **0 fark**; kasıtlı
bozulmuş bir listede **7 fark türünün 7'si de** yakalanıyor (eksik parametre, ters
`readOnlyHint`, eksik `outputSchema`, kısa `description`, bozuk sıra, yanlış `ttlMs`,
yanlış `cacheScope`); v1 modunda cache alanları **aranmıyor**; gerçek `requestState`
gövdesi çözülüyor; yazma tool'unda `dryRun` **zorla `true`**; `app.js`'in aradığı
**50 DOM id'sinin hepsi** `index.html`'de mevcut.

> **Not.** Bu belgeyi hazırlarken tarayıcıda görsel doğrulama **yapılmadı** —
> layout, tema geçişi ve mobil kırılma noktaları göz ile kontrol edilmedi. Doğrulanan
> her şey yukarıdaki komutlarla ve DOM'suz testlerle ölçüldü.
