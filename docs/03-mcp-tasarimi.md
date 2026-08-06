# 03 — MCP tasarımı

> **Bölüm hedefi:** On tool'un neden tam olarak bu on tool olduğunu, yazma
> güvenliğinin üç katmanını ve sunucunun istemciye niyetini nasıl bildirdiğini anlamak.

| ← Önceki | Sonraki → |
|---|---|
| [02 — Zaman girişi modeli](02-zaman-girisi-modeli.md) | [04 — Takvim](04-takvim.md) |

---

## Tool sınırlarını kim çizer?

On tool var. Sözleşme: [`contract/tools.json`](../contract/tools.json).

| # | Tool | `kind` | Neden var |
|---|---|---|---|
| 1 | `xurrent_whoami` | read | **Smoke test.** "Ben kimim, nereye bağlıyım?" 1 puanlık en ucuz sorgu. Rate limit durumunu da döner. |
| 2 | `xurrent_find_person` | read | Başkası adına yazma senaryosu için kişi çözümleme. Tam eşleşme yapar; `suggestFuzzy` ile bunu bildirir. |
| 3 | `xurrent_list_open_work` | read | **İster #1.** Request + Task tek çağrıda, normalize edilmiş `WorkItem` şeklinde. |
| 4 | `xurrent_get_time_tracking_context` | read | **Kimse istemedi — API zorunlu kıldı.** `timeIncrement` bilinmeden `timeSpent` seçilemez. |
| 5 | `xurrent_create_time_entry` | **write** | **İster #2+#3.** Yol A/Yol B yönlendirmesi ve strateji seçimi burada. |
| 6 | `xurrent_create_time_entries_bulk` | **write** | Takvim planını tek onayla uygulamak için. Atomik değil, ve bunu saklamıyor. |
| 7 | `calendar_list_today` | read | **İster #4a.** Ham takvimi normalize eder ve filtreler. |
| 8 | `plan_time_entries_from_calendar` | **preview** | **İster #4b.** Öneri üretir. **Yapısal olarak yazamaz.** |
| 9 | `xurrent_list_time_entries` | read | **Geri-okuma.** Yazma raporuna güvenmek yerine kaydı sunucudan doğrulamak; `sourceId` ile dedup araması (bkz. [15](15-guvenilirlik.md)). |
| 10 | `timesheet_wizard` | **chat** | **LLM'siz sohbet.** Sunucu-güdümlü durum makinesi; ince host'ta (Copilot Studio, terminal) diyaloğu sunucu yürütür (bkz. [contract/wizard.md](../contract/wizard.md)). |

### Neden "her ister = bir tool" değil?

Dört ister var, on tool. Fark üç tasarım kararından geliyor:

**1 — Bir tool, bir *yetenek*; bir *cümle* değil.**
İster #4 tek cümle: *"takvimi oku, her toplantıyı zaman girişi olarak ekle."* Bunu tek
tool yapsaydı, kullanıcı ara sonucu göremezdi. İkiye böldük: oku (`calendar_list_today`),
öner (`plan_time_entries_from_calendar`). Yazma ayrı bir tool'un işi — ve ayrı bir onayın.

**2 — Ön koşullar açık tool olmalı.**
`xurrent_get_time_tracking_context`'i `xurrent_create_time_entry` içine gömebilirdik.
Gömmedik, çünkü:
- LLM kısıtları **görebilmeli** (yuvarlamayı kullanıcıya açıklayabilsin diye),
- sonuç **cache'lenebilmeli** (her yazmada tekrar sorgulanmasın),
- ve öğrenci bu adımı **kaçırılan adım** olarak deneyimlemeli. Dersin bir parçası.

**3 — Okuma ve yazma asla aynı tool'da olmaz.**
`annotations.readOnlyHint` istemci tarafında izin kararına dönüşür. Karma bir tool bu
sinyali kullanılamaz hale getirir.

---

<a id="dry-run"></a>

## Dry-run neden üç katmanlı?

Xurrent bir **system of record**'dur. Yanlış yazılan bir zaman girişi effort class
çarpanı üzerinden **faturalamaya kadar gider.** Geri almak, "sil" demek kadar kolay
değildir (kilitli dönem, düzeltme kaydı — bkz. [02](02-zaman-girisi-modeli.md)).

Bu yüzden yazma güvenliği tek bir bayrağa emanet edilmedi:

```
Katman 1 — GLOBAL KILL-SWITCH        XURRENT_DRY_RUN=1
           İşletmeci kontrolü. Hiçbir mutation HTTP'ye ÇIKMAZ.
           LLM veya kullanıcı bunu geçersiz kılamaz.
                    ↓
Katman 2 — TOOL PARAMETRESİ          dryRun: true
           LLM kontrolü. "Önce planı göster."
           Modelin kendi kararı; kapatılabilir.
                    ↓
Katman 3 — YAPISAL                   plan_time_entries_from_calendar
           Kod kontrolü. Bu tool'un yazma yolu YOKTUR.
           Bayrak değil, MİMARİ.
```

### Katman 1 — global kill-switch

`XURRENT_DRY_RUN=1` iken hiçbir mutation gönderilmez. Her yazma tool'u planı ve
uyarıları döner, `dryRun: true` ile.

Kritik özellik: **bu bayrak tool parametresinden üstündür.** `dryRun: false` gönderilse
bile yazma gerçekleşmez. LLM ikna edilebilir bir bileşendir; env değişkeni değildir.

[`.env.example`](../.env.example)'da tavsiye açık: *"İlk canlı bağlantıda bunu 1 bırakıp
çıktıyı incelemek şiddetle tavsiye edilir."*

### Katman 2 — tool parametresi

`xurrent_create_time_entry` ve `..._bulk` girdilerinde `dryRun` (varsayılan `false`).

Bunun asıl faydası **öğreticidir**: `planned[].mutation` alanı, gönderilecek GraphQL
metnini **birebir** taşır.

> Öğrenciye "ne olacağını" anlatmak yerine **gösteriyoruz.**

Sözleşmedeki `PlannedMutation` tipi bu yüzden `mutation` (string) ve `input` (object)
alanlarını ayrı ayrı taşır. Kopyalayıp GraphQL Playground'a yapıştırabilirsin.

### Katman 3 — yapısal önizleme

`plan_time_entries_from_calendar`, `annotations.readOnlyHint: true` taşır ve
**gerçekten** hiçbir mutation yolu içermez.

Neden en güçlü katman bu? Çünkü diğer ikisi **bayraktır** — bir bayrak yanlış
ayarlanabilir. Bu katman **mimaridir**: tool'un yazma yeteneği kodda yoktur, dolayısıyla
yanlış ayarlanacak bir şey de yoktur.

**Genel ilke:** *Güvenliği yapılandırmayla değil, yetenek yokluğuyla sağla.*

---

<a id="onay"></a>

## Onay neden LLM'e bırakılmaz?

Onay bu projedeki en önemli güvenlik kararıdır. Ve MCP'nin **iki protokol
revizyonunda iki farklı mekanizmayla** kurulur:

| | `2025-11-25` (v1) | `2026-07-28` (v2) |
|---|---|---|
| Mekanizma | **Elicitation** — `elicitation/create` | **MRTR** — `InputRequiredResult` |
| Yön | Sunucu istemciye **istek** gönderir | Sunucu istemciye **sonuç** döner |
| Kaç JSON-RPC isteği | 1 (+1 ters yön) | 2 (farklı `id`'lerle) |
| Sunucu state tutar mı | ✅ istek açık kalır | ❌ state `requestState` blob'unda |
| Onay LLM'de mi yaşar | ❌ | ❌ |

**Son satır değişmiyor** — ve mesele budur. Ayrıntı:
[09 — Protokol geçişi](09-protokol-gecisi.md#mrtr).

### v1 — elicitation: sunucu kullanıcıya doğrudan sorar

MCP'nin **elicitation** özelliği, sunucunun istemci üzerinden **doğrudan kullanıcıya**
soru sormasını sağlar. Akış:

```
Sunucu → istemci:  elicitation/create { message, requestedSchema }
İstemci            → kullanıcıya UI gösterir
Kullanıcı          → karar verir
İstemci → sunucu:  { action: "accept" | "decline" | "cancel", content? }
```

### Neden protokol seviyesinde?

Onay diyaloğunu LLM'e bıraksaydık akış şöyle olurdu:

```
LLM: "Request #70248'e 120 dakika yazacağım, onaylıyor musunuz?"
Kullanıcı: "evet"
LLM: tool'u çağırır
```

Sorun: **bu onay LLM'in içinde yaşar ve LLM ikna edilebilir.** Uzun bir konuşmada
kullanıcı "artık her seferinde sorma" der; model bunu genelleştirir; üç mesaj sonra
onaysız yazma yapar. Prompt injection ise bunu doğrudan hedefler.

Elicitation'da onay **sunucudan çıkar, istemcide gösterilir, kullanıcıdan gelir.**
LLM'in bu zincire müdahale imkânı yoktur. Model konuşmayı yönetir, **protokol** işlemi
korur.

### Üç action ve karşılıkları

| `action` | Anlamı | Sunucu ne yapar |
|---|---|---|
| `accept` | Kullanıcı onayladı | Mutation gönderilir |
| `decline` | Kullanıcı **reddetti** | Yazma yapılmaz; `errors` boş, sonuç "iptal edildi" olarak raporlanır |
| `cancel` | Kullanıcı **karar vermedi** (diyaloğu kapattı, zaman aşımı) | Yazma yapılmaz |

`decline` ile `cancel` farkı önemlidir: ilki bir **karardır** ("hayır, yazma"), ikincisi
**kararsızlıktır**. Chatbot ikisine farklı tepki verir — `decline` sonrası konuyu kapatır,
`cancel` sonrası soruyu tekrar sorabilir.

### v2 — MRTR: sunucu "eksik bilgi var" diye SONUÇ döner

`2026-07-28` revizyonu `elicitation/create`'i **kaldırdı**. Sunucu artık istemciye
istek gönderemez; çünkü çekirdek stateless yapıldı ve sunucudan istemciye giden
istekler kalıcı çift yönlü bağlantı gerektiriyordu.

Yerine gelen mekanizma **MRTR** (Multi Round-Trip Requests):

```
İstemci → sunucu:  tools/call (id:1) xurrent_create_time_entry
Sunucu  → istemci: Result (id:1) { resultType: "input_required",
                                    inputRequests: {...},
                                    requestState: "<imzalı blob>" }   ← SONUÇ, istek değil
İstemci            → kullanıcıya UI gösterir
Kullanıcı          → karar verir
İstemci → sunucu:  tools/call (id:2) AYNI tool + inputResponses + requestState
Sunucu  → istemci: Result (id:2) { resultType: "complete", ... }
```

Üç şey dikkat çekiyor:

1. **İlk istek sonlanır.** `id:1` kapanır; sunucuda hiçbir state kalmaz.
2. **İkinci istek YENİ bir `id` taşır.** Bunlar bağımsız isteklerdir; aynı `id`'yi
   kullanmak istemcinin korelasyon tablosunu bozar.
3. **İki isteği birbirine bağlayan tek şey `requestState`'tir** — ve o, istemcide
   beklediği için **imzalanmak zorundadır**. Spec onu açıkça *saldırgan
   kontrolündeki girdi* sayar.

Bizim imzalama şemamız — HMAC-SHA256 + `principal` + TTL + `fingerprint` + `nonce`,
ve her birinin gerekçesi:
[09 — `requestState` bir güvenlik sınırıdır](09-protokol-gecisi.md#requeststate).

> **Değişen taşıma biçimi, değişmeyen güvenlik modeli.** İki revizyonda da onayı
> **sunucu ister, kullanıcı verir, LLM araya giremez.** Model konuşmayı yönetir,
> protokol işlemi korur.

### Fail-closed politikası — her iki yolda da aynı

Her MCP istemcisi onay mekanizmasını desteklemez. Desteklemiyorsa ne olur?

```
XURRENT_CONFIRM_POLICY=closed   ← VARSAYILAN
    Onay kanalı yoksa YAZMA REDDEDİLİR.

XURRENT_CONFIRM_POLICY=open
    Onaysız yazılır. YALNIZCA CI / otomasyon için.
```

**Varsayılan `closed`.** Güvenlik varsayılanları güvenli tarafta olmalıdır: eksik bir
yetenek, sessizce "onay gerekmiyor"a dönüşmemelidir.

"Onay kanalı yok" tespiti iki revizyonda **farklı ölçülür**, sonucu aynıdır:

| | v1 | v2 |
|---|---|---|
| Nasıl anlaşılır | İstemci yetenek bildiriminde `elicitation` yok | İstemci `input_required` sonucunu ele almıyor / `requestState`'i geri getirmiyor |
| `closed` iken | Yazma **reddedilir**, `isError` + Türkçe açıklama | Aynı |
| `open` iken | Onaysız devam + **uyarı** | Aynı |

`open` modu bilinçli olarak *çirkin* bırakıldı — env dosyasında açık uyarıyla, ve
sunucu başlarken stderr'e uyarı basar. Kimse yanlışlıkla bu modda çalışmasın.

> **⚠️ Mock modda istisna.** `XURRENT_CONFIRM_POLICY=closed` + `dryRun: false` iken
> yazma **yalnızca `live` modda** engellenir. Mock modda yazma zararsızdır (belleğe
> gider) ve ders akışını kırmamalıdır; bunun yerine bir **uyarı** üretilir:
> *"Mock modda çalışıyoruz; canlı modda bu yazma için protokol seviyesinde onay
> istenirdi."* Üç dil de bu davranışı gösterir — sihirbazın onay adımı bu sayede
> `ts`, `py` ve `cs` üzerinde **aynı** sonucu verir.

### Bulk'ta onay: N kez değil, bir kez

`xurrent_create_time_entries_bulk` 50 satıra kadar kabul eder. 50 elicitation diyaloğu
göstermek onayı anlamsızlaştırır (kullanıcı üçüncüden sonra okumadan tıklar).

**Politika:** onay **özet** üzerinden **bir kez** sorulur:

```
5 zaman girişi oluşturulacak:
  · Request #70248 — 60 dk — bugün 10:00
  · Request #70301 — 60 dk — bugün 13:45  (45 dk → 60'a yuvarlandı)
  · TimeAllocation "İç toplantılar" — 30 dk — bugün 09:00
  · ...
Toplam: 240 dakika.

UYARI: Bu işlem ATOMİK DEĞİLDİR. Kısmi başarı mümkündür.
Onaylıyor musunuz?
```

Atomiklik uyarısı özetin parçası — çünkü kullanıcının vereceği karar onsuz eksik bilgiyle
verilmiş olur.

---

## `annotations` — istemciye niyet bildirmek

Her tool `annotations` taşır:

| Annotation | Anlamı | Bizde |
|---|---|---|
| `readOnlyHint` | Ortamı değiştirmez | 6 tool'da `true` |
| `destructiveHint` | Yıkıcı/geri alınamaz değişiklik | Yazma tool'larında `false` — **ekleme yapıyoruz, silmiyoruz** |
| `idempotentHint` | Tekrarı ek etki yaratmaz | Okumalarda `true`, yazmalarda `false` (`timeSpent` artımlı!) |
| `openWorldHint` | Dış sistemle konuşur | Hepsinde `true` |

Örnek — `xurrent_create_time_entry`:

```json
{
  "readOnlyHint": false,
  "destructiveHint": false,
  "idempotentHint": false,
  "openWorldHint": true
}
```

`idempotentHint: false` bir kaza değil. [02](02-zaman-girisi-modeli.md)'de gördüğümüz gibi
Yol B'de `timeSpent` **artımlıdır**; aynı çağrıyı iki kez yapmak **iki kayıt** üretir.
Bu annotation, istemciye "otomatik retry yapma" der.

### Claude Code izin promptları

Claude Code bu ipuçlarını izin akışında kullanır:

- `readOnlyHint: true` → çoğunlukla sorgusuz çalışır
- `readOnlyHint: false` → **kullanıcıdan izin ister**

Yani `xurrent_list_open_work` akıcı çalışırken `xurrent_create_time_entry` durur ve sorar.
Bu bizim istediğimiz davranış — annotations'ı doğru doldurmak, istemcinin işini doğru
yapmasını sağlar.

> **Not:** `annotations` bir **ipucudur**, güvenlik sınırı değil. Kötü niyetli bir sunucu
> yalan söyleyebilir. Gerçek koruma istemci tarafındaki izin sisteminde ve bizim
> tarafımızdaki elicitation + kill-switch katmanlarındadır.

---

## `structuredContent` + text block ikilisi

Her tool çağrısı **iki biçimde birden** cevap döner:

```json
{
  "content": [
    {
      "type": "text",
      "text": "3 açık talep, 3 açık görev bulundu.\n\n· #70248 — Masraf beyanı ekranı çok yavaş açılıyor (Devam ediyor)\n· #70301 — VPN bağlantısı gün içinde sürekli kopuyor (Atandı)\n..."
    }
  ],
  "structuredContent": {
    "accountId": "ornek-bt",
    "requests": { "totalCount": 3, "hasNextPage": false, "nodes": [ /* ... */ ] },
    "tasks":    { "totalCount": 3, "hasNextPage": false, "nodes": [ /* ... */ ] }
  }
}
```

Neden ikisi de?

| Tüketici | Ne okur | Neden |
|---|---|---|
| **LLM** | `content[].text` | Türkçe özet; token ekonomisi. Ham JSON'ı akıl yürütmek için okumak gereksiz pahalıdır. |
| **Program** (sihirbaz, web UI, test) | `structuredContent` | `outputSchema`'ya karşı doğrulanabilir; `expect` kontrolleri buna bakar. |

Sihirbazın `expect` blokları (`docs/wizard/steps.json`) doğrudan `structuredContent`
yollarını kullanır: `requests.totalCount`, `totals.busyMinutes`, `planned.length`.
Metin özeti değişse bile testler kırılmaz — **sözleşme yapıda, metinde değil.**

**Kural:** metin özeti insan/LLM içindir ve serbestçe iyileştirilebilir.
`structuredContent` sözleşmedir ve değiştirmek **kırıcı değişikliktir.**

### `outputSchema` — 8/8, üç dilde de zorunlu

`structuredContent` tek başına yetmez: tool'un onu **beyan etmesi** gerekir.
Sözleşme kuralı net:

> **8 tool'un HEPSİ `outputSchema` yayınlar ve `tools/call` cevabında
> `structuredContent` döner.** Şemalar [`contract/tools.json`](../contract/tools.json)
> içindeki `output` alanlarından **birebir** türetilir.

Neden zorunlu tuttuk — üç ayrı kazanç:

| Kazanç | Açıklama |
|---|---|
| **Ücretsiz sözleşme testi** | SDK, dönen `structuredContent`'i şemaya karşı doğrular. Alan adını yanlış yazarsan tool çağrısı **çalışma anında patlar**, sessizce yanlış veri dönmez |
| **İstemci tarafı doğrulama** | Sihirbaz ve web UI, `expect` bloklarını şemaya güvenerek yazar |
| **Tezin kanıtı** | `outputSchema` beyan etmeyen bir dil, "üç dil aynı çıktıyı üretir" iddiasını **ölçülemez** hâle getirir |

Son madde bir gözlemden geliyor: `tools/list` sondasında bir dil 8/8 beyan ederken
diğer ikisi 0/8 beyan ediyordu. Sonuç yalnızca sözleşme ihlali değildi —
`structuredContent` hiç dönmediği için sihirbazın kontrolleri o dillerde
**çalıştırılamıyordu.** Ölçemediğin şey eşit olduğunu iddia edemez.

Ve `structuredContent`'in **yanı sıra** okunabilir Türkçe text block **her zaman**
yayınlanır. İkisi birden — biri diğerinin yerine geçmez.

---

## Transport: stdio vs Streamable HTTP

| | **stdio** | **Streamable HTTP** |
|---|---|---|
| Nasıl | Sunucu alt süreç; stdin/stdout üzerinden JSON-RPC | HTTP POST + SSE |
| Kim başlatır | İstemci (Claude Code, Desktop) | Bağımsız servis |
| Kimlik | Süreç ortamı (env) | HTTP katmanı (header, OAuth) |
| Çok kullanıcı | ❌ tek kullanıcı | ✅ |
| Kurulum | Sıfır | Port, CORS, kimlik |
| Bu projede | **Varsayılan** | `MCP_HTTP_PORT=8788` |

Ders için stdio doğru seçim: yerel, sıfır kurulum, `.mcp.json` ile tek satırda takılıyor.
Streamable HTTP, "aynı sunucu bir servis olarak da çalışır" iddiasını göstermek için
mevcut.

### ⛔ stdio'nun tek katı kuralı

> ## `stdout` **YALNIZCA** JSON-RPC içindir.
> Tüm loglar **`stderr`**'e gider.

Tek bir `console.log("debug")` / `print("ok")` / `Console.WriteLine(...)` çağrısı
JSON-RPC akışını bozar ve istemci bağlantıyı **parse hatasıyla** düşürür. Hata mesajı
genellikle anlaşılmazdır ("Unexpected token d in JSON at position 0") ve saatler
kaybettirir.

Üç dilde doğru form:

```ts
// TypeScript — stdout SADECE JSON-RPC; log stderr'e
console.error("[xurrent-mcp] mock adapter aktif");
```

```python
# Python — stdout SADECE JSON-RPC; log stderr'e
print("[xurrent-mcp] mock adapter aktif", file=sys.stderr)
```

```csharp
// C# — stdout SADECE JSON-RPC; log stderr'e
Console.Error.WriteLine("[xurrent-mcp] mock adapter aktif");
```

Ve ikinci kural, birincisinden bağımsız olarak geçerli:

> **Sırlar asla loglanmaz.** Token, `Authorization` header'ı, tam GraphQL yanıtı — hiçbiri.
> `stderr` de bir dosyaya yönlendirilebilir.

---

## İstemci yapılandırması

### Claude Code — `.mcp.json` (proje scope)

Repo kökünde hazır: [`.mcp.json`](../.mcp.json). Commit edilir; Claude Code ilk açılışta
onay ister.

```jsonc
{
  "mcpServers": {
    "xurrent-ts": {
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/servers/typescript/dist/mcp/stdio.js"],
      "env": {
        "XURRENT_MODE": "${XURRENT_MODE:-mock}",
        "XURRENT_DRY_RUN": "${XURRENT_DRY_RUN:-0}",
        "XURRENT_FIXTURES_DIR": "${CLAUDE_PROJECT_DIR:-.}/fixtures"
      }
    },
    "xurrent-py": { "command": "uv",     "args": ["--directory", "…/servers/python", "run", "xurrent-mcp"] },
    "xurrent-cs": { "command": "dotnet", "args": ["run", "--project", "…/XurrentMcp.csproj", "--no-build", "--", "stdio"] }
  }
}
```

> ### ⚠️ Üçünü aynı anda açma
>
> Üç sunucu da **aynı** tool adlarını sunar. Hepsi açıkken Claude hangi
> `xurrent_whoami`'yi çağıracağını bilemez; en iyi ihtimalle rastgele seçer.
>
> Ders sırasında **sırayla** aç/kapat. Onay seçimlerini sıfırlamak için:
> `claude mcp reset-project-choices`

### Claude Desktop — `claude_desktop_config.json`

| OS | Yol |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "xurrent": {
      "command": "node",
      "args": ["/mutlak/yol/xurrent-mcp/servers/typescript/dist/mcp/stdio.js"],
      "env": {
        "XURRENT_MODE": "mock",
        "XURRENT_FIXTURES_DIR": "/mutlak/yol/xurrent-mcp/fixtures"
      }
    }
  }
}
```

İki fark, ikisi de sık hata sebebi:

1. **Mutlak yol zorunlu.** `${CLAUDE_PROJECT_DIR}` genişletmesi Desktop'ta yoktur.
2. **Desktop'un `PATH`'i kabuğunkinden farklıdır.** `uv`, `dotnet`, hatta `node` bulunmayabilir;
   `which uv` çıktısını tam yol olarak yaz.

Yapılandırma değişikliği için Claude Desktop **tamamen yeniden başlatılmalıdır**
(pencereyi kapatmak yetmez).

---

## Test: MCP Inspector

LLM olmadan, elle:

```bash
npx @modelcontextprotocol/inspector \
  node servers/typescript/dist/mcp/stdio.js
```

Tarayıcı açılır; `tools/list` görülür, her tool elle çağrılabilir, ham JSON-RPC trafiği
izlenir.

Inspector'la yapılacak beş kontrol:

| # | Kontrol | Beklenen |
|---|---|---|
| 1 | `tools/list` | **8 tool** |
| 2 | Her tool'un `description`'ı | LLM'i yönlendirecek kadar net mi? |
| 3 | `annotations` | Yazma tool'larında `readOnlyHint: false` |
| 4 | `xurrent_list_open_work` çağrısı | `structuredContent.requests.totalCount == 3` |
| 5 | `xurrent_create_time_entry` `dryRun: true` | `planned` dizisinde ham GraphQL metni |

`description` alanları **LLM'in tool'u nasıl kullanacağını öğrenmesinin tek yoludur.**
Kötü yazılmış bir açıklama = yanlış kullanılan bir tool. Bu yüzden sözleşmedeki
`summary` ve `teachingNotes` alanları özenle yazıldı; ders materyali olmalarının yanında
**çalışan birer prompt**turlar.

### Sözleşme testi

```bash
node scripts/verify-contract.mjs --all
```

Üç sunucunun `tools/list` çıktısını [`contract/tools.json`](../contract/tools.json)'a
karşı doğrular: tool adları, parametre adları, çıktı alanları. "Üç dil aynı sözleşmeyi
uyguluyor" iddiası burada **kanıtlanır**, iddia edilmez.

---

## Özet

| Karar | Gerekçe |
|---|---|
| 8 tool, 4 ister | Tool = yetenek, cümle değil |
| Ön koşul ayrı tool | LLM kısıtları görmeli, sonuç cache'lenmeli |
| Okuma/yazma ayrı | `readOnlyHint` kullanılabilir kalsın |
| 3 katmanlı dry-run | env > parametre > **yapısal** |
| `plan_*` yazamaz | Güvenlik yapılandırmayla değil, **yetenek yokluğuyla** |
| Onay protokolde | v1'de elicitation, v2'de MRTR — **ikisinde de LLM'in dışında** |
| Fail-closed | Eksik yetenek "onay gerekmiyor"a dönüşmemeli; mock modda uyarıya düşer |
| Bulk'ta tek onay | 50 diyalog onayı anlamsızlaştırır |
| `structuredContent` + text | Program şemayı, LLM metni okur — **ikisi birden** |
| `outputSchema` 8/8 | Beyan edilmeyen çıktı doğrulanamaz; eşitlik iddiası ölçülemez |
| stdio varsayılan | Sıfır kurulum; **stdout yalnızca JSON-RPC** |

Sıradaki bölüm gerçek dünyanın en dağınık veri kaynağına giriyor:
[04 — Takvim](04-takvim.md).

Onay mekanizmasının protokol revizyonuyla nasıl değiştiği ve `requestState`'in neden
imzalanması gerektiği: [09 — Protokol geçişi](09-protokol-gecisi.md).
