# 08 — Riskler ve SSS

> **Bölüm hedefi:** Neyin ters gidebileceğini önceden bilmek, canlıya bağlanmadan önce
> neyin doğrulanması gerektiğini listelemek ve sunumda arıza çıkarsa ne yapılacağını
> hazır tutmak.

| ← Önceki | Sonraki → |
|---|---|
| [07 — Sihirbaz](07-sihirbaz.md) | [09 — Protokol geçişi](09-protokol-gecisi.md) |

---

## Bu proje neyi vaat ediyor, neyi etmiyor?

| Vaat | Durum |
|---|---|
| Mock mod uçtan uca çalışır ve test edilmiştir | ✅ |
| Üç dil aynı sözleşmeyi uygular | ✅ `scripts/verify-contract.mjs --all` ile doğrulanır |
| Live mod gerçek bir Xurrent hesabına karşı çalıştırılmıştır | ❌ **Hayır** |
| GraphQL şeması resmî dokümantasyondan çıkarılmıştır | ⚠️ Çıkarım, gözlem değil |
| Üretim kullanımına hazırdır | ❌ **Hayır** — öğretim materyalidir |

Bu bölümdeki **`DOĞRULANMALI`** listesi bu dürüstlüğün somut hâli.

---

## Risk tablosu

### Canlı Xurrent bağlantısı

| Risk | Etki | Azaltma |
|---|---|---|
| **Yanlış hesap slug'ı** (`X-Xurrent-Account`) | 401 **almazsın** — boş sonuç dönersin. İç personelin time entry'leri **directory account**'ta yaşar. | `xurrent_whoami`'yi ilk çalıştır; `account.id` beklenen mi bak |
| **`eu` bölgesi** | DNS çözülür, TLS patlar. Hata "ağ sorunu" gibi görünür | `.env`'de tam URL; `eu` **yok**, Global zaten Avrupa |
| **İlk canlı yazma yanlış gider** | Faturalamaya kadar giden yanlış kayıt | `XURRENT_DRY_RUN=1` ile başla, planı incele, sonra `0` yap |
| **`timeIncrement` = 60** (Xurrent varsayılanı) | 30/45/90 dakikalık girişler HTTP 200 + `errors` ile **sessizce** reddedilir | `xurrent_get_time_tracking_context` her yazmadan önce; `errors` her zaman kontrol edilir |
| **`two_step` 2. adımı başarısız** | Ticket'a bağlı ama tarihi bugün olan kayıt | `warnings`'te açıkça uyarılır; kullanıcı düzeltme yapabilir |
| **Bulk yarıda kalır** | Kısmi yazma | `stopOnError: true` varsayılan; satır satır rapor |
| **`timeSpent` artımlı unutulur** | **Çift sayma** — en pahalı hata | Sistem promptu 7. madde + sözleşme `teachingNotes` + `idempotentHint: false` |
| **Rate limit (20/2 sn)** | 429 | Bulk'ta ≥110 ms bekleme; SDK retry devrede |
| **Kilitli timesheet dönemi** | Yazma reddedilir | `XURRENT_MAX_BACKDATE_DAYS` ile erken reddet; `correction: true` yolu belgelendi |

### Takvim

| Risk | Etki | Azaltma |
|---|---|---|
| **Graph `Calendars.Read.All` alınması** | 403 — o izin *çalışma saatleri* içindir | [04](04-takvim.md)'te açıkça yazılı; doğru izin `Calendars.Read` |
| **Google `singleEvents` unutulur** | Tekrarlayan toplantılar **hiç görünmez** | Adapter'da sabit `true`; `orderBy` ona bağımlı |
| **Graph `dateTime` yanlış parse** | Konteyner UTC ise saatler **kayar**; geliştirici makinesinde fark edilmez | Kesirli haneleri kırp + `"Z"`; testte UTC ortam simüle et |
| **Google `transparency` varsayılanı** | Meşgul toplantılar **hiç** meşgul sayılmaz → tüm gün boş görünür | `(t ?? "opaque")` |
| **App-only Graph, politika yok** | Uygulama tenant'taki **her** mailbox'ı okur — denetim bulgusu | Exchange application access policy ile gruba kısıtla |
| **Çıplak timestamp** | Sessizce yanlış gün | Pencere her zaman offset gömülü |
| **`.ics` bayat tarihler** | Dünkü demo | Sunum sabahı `node scripts/gen-ics.mjs` |

### Ders / sunum

| Risk | Etki | Azaltma |
|---|---|---|
| **İnternet yok** | Chatbot ve Claude Code çalışmaz | Mock mod + sihirbaz **internetsiz** çalışır → [C planı](demo/senaryo.md) |
| **`ANTHROPIC_API_KEY` quota / hata** | Chatbot demosu düşer | Sihirbazla başla; chatbot ikinci sırada |
| **Üç MCP sunucusu aynı anda açık** | Claude hangi `xurrent_whoami`'yi çağıracağını bilemez | `.mcp.json`'da sırayla aç/kapat; `claude mcp reset-project-choices` |
| **Port çakışması** (8787 / 8788) | Web arayüzü açılmaz | `.env`'de `WEB_PORT` / `MCP_HTTP_PORT` değiştir |
| **`uv` / `dotnet` kurulu değil** | Python veya C# sunucusu başlamaz | Dersten önce üçünü de bir kez çalıştır |
| **Node < 20** | SDK çalışmaz | `clients/wizard/package.json` → `engines.node >= 20` |
| **stdout'a log sızması** | İstemci "parse error" ile düşer | Üç dilde de log **stderr**'e; C#'ta `LogToStandardErrorThreshold` |
| **DST geçiş günü** | Yerel saat hesabı kayar | Fixture'lar yerel saatten materyalize edilir; `{{tzOffset}}` o günün offset'i |

### Protokol

| Risk | Etki | Azaltma |
|---|---|---|
| **İstemci ile sunucu farklı revizyon konuşuyor** | Bağlantı hiç kurulmaz ya da `server/discover` `-32601` alır | Sihirbazın uyumluluk sondası; `MCP_PROTOCOL` ile açıkça seç — [09](09-protokol-gecisi.md#olcum) |
| **`server/discover` `_meta`'sız gönderilir** | Python **yanıltıcı** `-32601` döner ("metod yok" der, oysa metod var) | Üç zorunlu `_meta` anahtarını her istekte gönder; C#'ın mesajı doğru ve açıklayıcıdır |
| **`resultType` gönderilmez** | İstemci sonucu `"complete"` sayar → `input_required` **başarı sanılır** | v2 sonuçlarında alan zorunlu; chatbot promptunda 13. madde son savunma hattı |
| **`requestState` imzasız** | Onay **başka bir çağrıya** iliştirilebilir — yetkisiz yazma | HMAC + principal + TTL + fingerprint + nonce — [09](09-protokol-gecisi.md#requeststate) |
| **Nonce seti süreç içi** | Yatay ölçekte replay penceresi açık kalır | Tek süreçli stdio'da sorun yok; **üretimde paylaşılan depo şart** — bilinçli kapsam dışı |
| **Hata kodu sayısal karşılaştırma** | `-32004` → `-32022` taşındı; `catch` bloğu tutmaz, hata "bilinmeyen"e düşer | Kodları **isimle** karşılaştır, sayıyla değil |
| **TS sunucusu v2 istemciye takılır** | SDK `1.30.0` `server/discover` bilmiyor → bağlanmaz | Ders sırasında `--server py` veya `--server cs`'e geç; **D11 sunumdan önce ölçülmeli** |

### Güvenlik

| Risk | Etki | Azaltma |
|---|---|---|
| **Prompt injection ile onaysız yazma** | Yetkisiz zaman kaydı | Onay **protokolde**, LLM'de değil; `XURRENT_DRY_RUN` env — model erişemez |
| **`XURRENT_CONFIRM_POLICY=open` unutulur** | Onaysız yazma | Varsayılan `closed`; `open` modda sunucu stderr'e uyarı basar |
| **Token loglanması** | Sır sızıntısı | Sırlar asla loglanmaz; stderr de dosyaya yönlenebilir |
| **LLM ID uydurur** | **Başka birinin ticket'ına** yazma | Sistem promptu 1. madde; ID'ler yalnızca tool çıktısından |
| **`.env` commit edilir** | Token sızıntısı | `.gitignore`'da; repo'da yalnızca `.env.example` |

---

<a id="dogrulanmali"></a>

## `DOĞRULANMALI` — ilk canlı bağlantıda kontrol edilecekler

GraphQL şeması resmî dokümantasyondan **çıkarıldı**, canlı bir hesapta gözlemlenmedi.
Aşağıdaki maddeler ilk bağlantıda **sırayla** doğrulanmalıdır.

### D1 — Rate limit header adları

`xurrent_whoami` çıktısındaki `rateLimit` nesnesi (`limit`, `cost`, `remaining`,
`resetAt`) HTTP response header'larından okunur. **Header adlarının birebir yazımı
doğrulanmalı.**

*Nasıl:* herhangi bir sorgu at, ham response header'larını yazdır.
*Yanlışsa:* `rateLimit` `null` döner — işlevsellik etkilenmez, sadece bilgi kaybolur.

### D2 — `requests` / `tasks` `order` argümanı

Sorgular bir `order` argümanı kabul ediyor ama **argümanın tam şekli** (alan adları,
yön enum'ı) doğrulanmadı. Bu yüzden [01](01-xurrent-api.md)'deki örnekte
kullanılmadı.

*Nasıl:* introspection ya da tek bir `order:` denemesi.
*Yanlışsa:* şema hatası — gürültülü, hemen fark edilir.

### D3 — `account` bilgisinin kaynağı ★

Sözleşme `xurrent_whoami` çıktısında `account { id, name, directory }` istiyor. Bu
bilginin `me` sorgusundan mı, ayrı bir root alandan mı, yoksa yalnızca
`X-Xurrent-Account` header yansımasından mı geldiği **doğrulanmalı**.

*Neden kritik:* `directory` alanı, iç personelin time entry'lerinin doğru hesapta
aranıp aranmadığını anlamanın en hızlı yolu.

### D4 — Timesheet ayarlarının sorgu yolu ★★

`xurrent_get_time_tracking_context`, `timeIncrement`, `workday`,
`allocationTimeTracking` vb. döner. `TimesheetSetting`'in **organizasyona bağlı**
olduğu belgelenmiş; **root sorgu alanının adı ve filtresi doğrulanmalı.**

*Neden en kritik madde:* `timeIncrement` okunamazsa tüm yazma yolu kör uçuş yapar.
*Geçici çözüm:* okunamıyorsa varsayılan **60** kabul edilmeli (Xurrent varsayılanı) —
asla "sınır yok" varsayılmamalı.

### D5 — `requestUpdate` payload'ı `timeEntry` döner mi? ★★★

**`two_step` stratejisinin en zayıf noktası.**

`requestUpdate` payload'ı `request` döner; oluşan `TimeEntry`'nin id'sini **döndürüp
döndürmediği doğrulanmadı**. Dönmüyorsa 2. adım öncesinde bir arama sorgusu gerekir
(`person` + `date` + `timeSpent` + `description` ile en yeni kayıt) — bu bir
**heuristiktir**, garanti değil.

*Dönüyorsa:* heuristik tamamen kalkar, `two_step` belirgin şekilde sağlamlaşır.
*Dönmüyorsa:* heuristiğin belirsizlik penceresi belgelenmeli ve kullanıcıya
uyarı olarak gösterilmeli.

Ayrıntı: [02 — two_step'in eksik halkası](02-zaman-girisi-modeli.md#stratejiler).

### D6 — `timeEntries` sorgusunun filtre alanları

D5'in heuristiği buna bağlı: `timeEntries` root sorgusu hangi filtreleri kabul ediyor?
(`person`, `date`, `assignment`?) **Doğrulanmalı.**

### D7 — `effortClasses` ve `timeAllocations` sorgu şekli

`view` argümanı kabul ediliyor mu? `EffortClassFilter`'da `disabled` filtresinin
**olmadığı** belgelenmiş — bu doğrulanmalı (varsa client-side eleme gereksizleşir).

### D8 — `PersonFilter.primaryEmail` şekli

TextFilter olduğu belgelenmiş. `{ values: [String] }` mi, başka bir şekil mi?
**Doğrulanmalı.**

### D9 — `TaskFilter.assignee` alan adı ★

Filtre asimetrisinin (`member` vs `assignee`) **canlı şemada** doğrulanması. Bu
projedeki en çok tekrarlanan iddia; yanlışsa açık iş listesi **boş** döner.

*Nasıl:* introspection ile `TaskFilter` alanlarını listele.

### D10 — Elicitation desteği (istemci tarafı)

Hangi MCP istemcilerinin `elicitation/create`'i desteklediği sürümle değişir.
**Kullanılacak istemcide doğrulanmalı.**

*Desteklenmiyorsa:* `live` modda `XURRENT_CONFIRM_POLICY=closed` (varsayılan) yazmayı
reddeder — güvenli ama demo akmaz. **Mock modda engellenmez** (bkz.
[03](03-mcp-tasarimi.md#onay)), yani ders akışı kırılmaz. Yine de sunumdan önce test et.

---

### Protokol maddeleri

Aşağıdaki üç madde [09 — Protokol geçişi](09-protokol-gecisi.md) bölümünden geliyor.
Diğerlerinden farkı: bunların bir kısmı **zaten ölçüldü**, bir kısmı **henüz ölçülmedi**
— ve ikisi açıkça ayrılmıştır.

### D11 — Claude Code hangi revizyonu kabul ediyor? ★★ — **HENÜZ ÖLÇÜLMEDİ**

> **⚠️ Bu maddeye varsayım yazılmayacaktır.** Claude Code'un (ve Claude Desktop'ın)
> `2026-07-28` revizyonunu konuşup konuşmadığı, `server/discover` gönderip
> göndermediği, `input_required` sonucunu ele alıp almadığı **bu belgenin yazıldığı
> anda ölçülmemiştir.**

*Neden kritik:* Bu proje `.mcp.json` ile Claude Code'a takılıyor ([03](03-mcp-tasarimi.md)).
İstemci yalnızca v1 konuşuyorsa `MCP_PROTOCOL=2025-11-25` ile başlatmak gerekir;
yalnızca v2 konuşuyorsa TypeScript sunucusu (SDK `1.30.0`) **hiç bağlanmaz.**

*Nasıl ölçülür:* Sunucu tarafında gelen ham JSON-RPC'yi stderr'e dök ve bak —
ilk istek `initialize` mi, `server/discover` mı? İkincisiyse `_meta` içinde hangi
`io.modelcontextprotocol/protocolVersion` geliyor?

*Ölçülene kadar:* `MCP_PROTOCOL` varsayılanına güvenme; ders öncesi **her iki değerle
de** bir kez bağlan.

### D12 — SDK 2.0.0'ın v1 geriye dönük desteği ne zamana kadar? ★

[Ölçüm](09-protokol-gecisi.md#olcum) gösterdi ki `mcp` 2.0.0 ve
`ModelContextProtocol` 2.0.0 **hem** `server/discover` **hem** `initialize`
cevaplıyor. Ama bu destek **kalıcı değil.**

Spec'in [feature lifecycle](https://modelcontextprotocol.io/community/feature-lifecycle)
politikası deprecate edilen özellikler için bir pencere tanımlıyor. **Doğrulanmalı:**

- `initialize` handshake'i SDK'larda hangi sürüme kadar destekleniyor?
- Bu bir *deprecation* mı yoksa *sonsuza kadar uyumluluk* mu?
- Destek düştüğünde yalnızca v1 konuşan istemciler ne olur?

*Neden şimdi önemli:* TypeScript sunucusu bugün **yalnızca v1** konuşuyor. Karşı
taraftaki v1 desteği düşerse o sunucu SDK yükseltilmeden kullanılamaz hâle gelir.

*Nasıl:* SDK changelog'ları + spec'in deprecation takvimi. Kod okumakla değil,
**politika okumakla** cevaplanır.

### D13 — TypeScript SDK 2.0.0'a ne zaman geçilecek?

`@modelcontextprotocol/sdk` **1.30.0** kullanılıyor ve `server/discover`'a
`-32601` dönüyor — **ölçülmüştür**, tahmin değil.

*Doğrulanacak:* 2.0.0 sürümü yayınlandı mı, paket adları nasıl bölündü
(`@modelcontextprotocol/{core,server,client}`), ve mevcut `registerTool` API'si
korunuyor mu?

*Geçildiğinde:* TypeScript için yazılan elle v1/v2 adaptörü **silinir**. O katman
kalıcı mimari değil, geçici köprüdür ([09](09-protokol-gecisi.md#olcum)).

### Doğrulama sırası

| Sıra | Madde | Neden bu sırada |
|---|---|---|
| 1 | **D3** | Yanlış hesap her şeyi boşa çıkarır |
| 2 | **D9** | Boş liste dönerse hiçbir şey yapılamaz |
| 3 | **D4** | `timeIncrement` olmadan yazma kör |
| 4 | **D5** | `two_step` stratejisinin kaderi |
| 5 | D6, D7, D8, D2, D1 | İşlevsel ama kritik değil |
| 6 | **D10** | Sunumdan önce, istemci üzerinde |
| 7 | **D11** | **Sunumdan önce** — ölçülmemiş ve demoyu tamamen durdurabilir |
| 8 | D12, D13 | Ders sonrası; bakım planlaması |

---

## Sık sorulan sorular

### "Neden `timeEntryCreate` bir ticket'a bağlanmıyor? Bu bir tasarım hatası değil mi?"

Tasarım tercihidir. Xurrent'ta `TimeEntry`, `assignment` üzerinden bir parent kayda
bağlanır ve bu bağ **parent'ın kendi mutation'ıyla** kurulur. Böylece parent kaydın
iş kuralları (durum, yetki, workflow) tek yerde uygulanır. Yan etkisi: dışarıdan
gelen bir entegrasyon için "bağlı + geçmiş tarihli" giriş tek adımda mümkün olmuyor.

**Ders açısından değeri:** API kısıtları keyfî değildir; genellikle bir iç tutarlılık
kuralını korurlar. Kısıtı anlamak, etrafından dolaşmaktan önce gelir.

### "Üç dil gerçekten gerekli miydi?"

Ders için **evet** — tez bu. Üretim için **hayır**: bir dil seç, iyi yaz.

Ama gizli bir kazanç var: sözleşmeyi üç kez uygulamak, sözleşmedeki **belirsizlikleri
ortaya çıkarır**. Bir alan adı Python'da `snake_case`'e kayıyorsa, sözleşme o alanı
yeterince açık tarif etmemiş demektir. Üçüncü implementasyon, ilk ikisinin
varsayımlarını denetler.

### "Neden GraphQL değil de MCP tool'u? LLM zaten GraphQL yazabilir."

Yazabilir — ve yazdığı sorgu üç tuzaktan en az birine düşer (`view` unutulur, `member`
yerine `assignee` yazılır, terminal durumlar eksik kalır). Ayrıca:

- **Şema büyüktür.** Tüm Xurrent şemasını context'e koymak pahalıdır.
- **Yazma tehlikelidir.** Serbest GraphQL üretimi, serbest mutation üretimi demektir.
- **Tuzaklar tekrar eder.** Tool'da bir kez çözülür; promptta her konuşmada yeniden
  hata riski taşır.

Tool yüzeyi, **doğru kullanımı tek seçenek hâline getirir.**

### "`dryRun` varken `XURRENT_DRY_RUN` neden gerekli?"

Çünkü `dryRun` bir **tool parametresidir** ve LLM onu `false` yapabilir. Kullanıcı
ısrar edebilir, prompt injection zorlayabilir. `XURRENT_DRY_RUN` bir **env
değişkenidir** ve model ona erişemez.

**İki farklı tehdit modeli:** biri hata (model yanlış karar verir), diğeri kötüye
kullanım (model kandırılır). Farklı katmanlar gerekir.
Ayrıntı: [03](03-mcp-tasarimi.md#dry-run).

### "`busyMinutes` mi `naiveSumMinutes` mi doğru?"

İkisi de. Farklı sorulara cevap veriyorlar:

- *"Bugün ne kadar meşguldüm?"* → `busyMinutes` (çakışmalar bir kez)
- *"Toplantılara ne kadar zaman yazmalıyım?"* → `naiveSumMinutes` (her toplantı ayrı)

Aradaki fark sıfırdan büyükse, **kullanıcıya bir soru sorulması gerektiğinin
sinyalidir.** Sözleşme ikisini de zorunlu tuttu.

### "Mock modda yazdıklarım nereye gidiyor?"

Belleğe. `XURRENT_MOCK_PERSIST=1` ise
[`fixtures/time-entries.json`](../fixtures/time-entries.json)'a da yazılır.

**Ders sırasında `PERSIST` kapalı tut** — her çalıştırmada temiz başlar. Açıksa
ikinci provada sayılar kayar ve sihirbazın `expect` bloğu patlar.

### "Claude Code'da üç sunucuyu birden açsam ne olur?"

Üçü de **aynı** tool adlarını sunar. Claude hangi `xurrent_whoami`'yi çağıracağını
bilemez. Ders sırasında **sırayla** aç/kapat.

Onay seçimlerini sıfırlamak: `claude mcp reset-project-choices`

### "Live moda geçince mock veriler ne olacak?"

Hiçbir şey. `fixtures/` yalnızca `XURRENT_MODE=mock` iken okunur. `live`'da adapter
tamamen değişir; fixture'lara dokunulmaz.

### "45 dakikayı 30'a mı 60'a mı yuvarlamalı?"

Varsayılan `ROUNDING_MODE=nearest` ve beraberlikte **yukarı** yuvarlar (45 → 60).
Gerekçe: çalışılan zamanı eksik raporlamak fazla raporlamaktan daha zararlıdır —
kullanıcı fazlayı fark eder, eksiği fark etmez.

Ama bu bir **politika kararıdır**, doğru cevap değil. Bot her zaman ne yaptığını
söyler ve alternatifi sunar.

### "Bu kod üretimde kullanılabilir mi?"

Hayır, üç eksik var:

1. **Token yönetimi** — PAT `.env`'de düz metin. Üretimde secret manager gerekir.
2. **Hata telemetrisi** — hatalar stderr'e; yapılandırılmış log ve alarm yok.
3. **Çok kullanıcılı yetkilendirme** — tek kullanıcılı stdio varsayımı. Çoklu kullanım
   Streamable HTTP + kullanıcı başına token gerektirir.

Mimari doğru; **operasyonel katman eksik.**

---

## Sunumda ters giderse — kurtarma notları

### Sunucu başlamıyor

```
Error: Cannot find module '.../dist/mcp/stdio.js'
```

**Sebep:** TypeScript derlenmemiş.
**Çözüm:** `cd servers/typescript && npm run build`
**Kurtarma:** Başka bir dile geç — `--server py` veya `--server cs`. Ders akışı
değişmez; hatta bu bir *özellik* olarak sunulabilir.

### İstemci "parse error" ile bağlantıyı düşürüyor

```
Unexpected token d in JSON at position 0
```

**Sebep:** stdout'a JSON-RPC dışı bir şey yazıldı.
**Çözüm:** Son eklenen `console.log` / `print` / `Console.WriteLine`'ı bul. C#'ta
`LogToStandardErrorThreshold` satırını kontrol et.
**Kurtarma:** Sunum sırasında debug yapma. Başka dile geç.

### Sihirbazın `expect` bloğu patlıyor

```
BEKLENEN requests.totalCount = 3, GELEN 4
```

**Sebep 1:** `XURRENT_MOCK_PERSIST=1` ve önceki provadan kalıntı var.
**Çözüm:** `git checkout fixtures/time-entries.json`
**Sebep 2:** O dilde gerçek bir sözleşme sapması var.
**Kurtarma:** Bunu **derse çevir.** Sihirbaz tam olarak bu yüzden `expect` taşıyor:
sözleşme testi olmasaydı bu sapma sessizce geçerdi. Sonra başka dile geç.

### Takvim boş / yanlış gün

**Sebep:** `.ics` fixture'ı bayat (mutlak tarih taşır).
**Çözüm:** `node scripts/gen-ics.mjs`
**Kurtarma:** `--provider mock` kullan — `calendar.json` göreli tarihlidir, her zaman
doğru.

### Chatbot cevap vermiyor

**Sebep:** `ANTHROPIC_API_KEY` yok, geçersiz veya quota dolmuş.
**Kurtarma:** Sihirbaza dön. Chatbot demosu **isteğe bağlıdır**; ders sihirbazla tam.

### Claude Code sunucuyu onaylamıyor

**Çözüm:** `claude mcp reset-project-choices`, sonra Claude Code'u yeniden başlat.
**Kurtarma:** Sihirbaz aynı tool'ları LLM olmadan gösterir.

### İnternet tamamen yok

**Etkilenmeyenler:** sihirbaz, mock mod, `verify-contract`, tüm okuma/yazma tool'ları.
**Etkilenenler:** chatbot, Claude Code, web arayüzünün LLM tarafı.

**C planı:** Ders tamamen sihirbazla anlatılır. Kaybedilen tek şey "gerçek bir LLM ile
konuşma" gösterisi — ve o, dersin *tezinin* değil, *ürününün* parçası.
Ayrıntı: [demo/senaryo.md](demo/senaryo.md) → C bölümü.

### Genel kural

> **Bir demo bileşeni düşerse onarmaya çalışma — yedeğe geç.**
>
> Sunum sırasında hata ayıklamak izleyiciyi kaybettirir. Yedek planı önceden hazırla,
> geçişi 10 saniyede yap ve devam et.

---

## Bilinen sınırlar (bilinçli kapsam dışı)

| Sınır | Neden kapsam dışı |
|---|---|
| Çoklu hesap eşzamanlı sorgulama | `view: all` yeterli; hesap birleştirme ayrı bir ürün kararı |
| Time entry silme / güncelleme tool'u | İster listesinde yok; `deleted` alanı belgelendi ama tool yok |
| Project task / problem senaryoları | `targetType` destekliyor, fixture yok |
| Türkçe dışında dil | Ders Türkçe; sistem promptu tek dilde |
| Streamable HTTP kimlik doğrulama | Port açık; OAuth katmanı yok — **üretimde şart** |
| Takvim yazma (etkinlik oluşturma) | Yalnızca okuma; yazma yönü ister dışı |

---

## Özet

| Konu | Sonuç |
|---|---|
| Mock mod | ✅ Test edilmiş, internetsiz çalışır |
| Live mod | ⚠️ Canlı hesapta çalıştırılmadı — **13 `DOĞRULANMALI` maddesi** (D1–D13) |
| En kritik doğrulama | **D5** — `requestUpdate` payload'ı `timeEntry` dönüyor mu? |
| Sunumdan önce ölçülecek | **D11** — Claude Code hangi protokol revizyonunu kabul ediyor? **Henüz ölçülmedi** |
| Ölçülmüş olan | SDK protokol desteği: ts `1.30.0` yalnızca v1; py/cs `2.0.0` ikisi de |
| İlk canlı bağlantı | `XURRENT_DRY_RUN=1` ile başla |
| En pahalı hata | Artımlı `timeSpent`'in toplam sanılması |
| En sinsi hata | HTTP 200 + dolu `errors` |
| Sunum riski | Sihirbaz en düşük riskli demo; C planı internetsiz çalışır |
| Kurtarma kuralı | **Onarma — yedeğe geç** |
| Üretim | Token yönetimi, telemetri, çok kullanıcılı yetki eklenmeli |

Sıradaki bölüm, protokolün kendisinin değişmesini konu alıyor:
[09 — Protokol geçişi](09-protokol-gecisi.md).
Ardından sunum planı: [demo/senaryo.md](demo/senaryo.md).
