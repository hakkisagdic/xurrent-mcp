# 16 — İkinci transport: REST v1 ve resmî .NET SDK'sı

> **Bölüm hedefi:** Aynı tool sözleşmesinin İKİNCİ bir API lehçesiyle (REST v1)
> servis edilebildiğini kanıtlamak; GraphQL–REST farklarını ders malzemesine
> çevirmek; ve "resmî SDK her zaman daha mı iyi?" sorusuna ÖLÇÜLMÜŞ bir cevap
> vermek.

| ← Önceki | Sonraki → |
|---|---|
| [15 — Güvenilirlik](15-guvenilirlik.md) | [17 — Plugin ve Copilot Studio](17-plugin-ve-copilot.md) |

Seçim: `.env` → `XURRENT_API=graphql|rest` (C#'ta ek: `graphql-sdk`) ·
Sahte yüzey: `tools/fake-xurrent/server.mjs` → `/v1/*` ·
Kanıt: senaryo koşucusunun `[rest]` geçişi (a–e, üç dilde).

---

## Neden ikinci bir transport?

Kurumsal gerçek: bazı ortamlarda GraphQL kapalıdır, bazılarında yalnız REST'e
izin verilir; entegrasyon ekibinin elinde hangi kapı varsa oradan girilir.
Sözleşme doğru katmandaysa bu bir YENİDEN YAZIM değil, bir ADAPTÖR işidir:
`XurrentAdapter` arayüzü aynı kaldı, üç dile birer `RestXurrentAdapter` eklendi,
tool'ların tek satırı değişmedi. Senaryo koşucusu artık her dili iki kez sürer —
GraphQL geçişi ve `[rest]` geçişi **aynı sayıları** üretmek zorundadır.

> 🎤 **Anlatım notu:** Tahtaya iki başlık: "değişen" (adaptör, ~1 dosya/dil)
> ve "değişmeyen" (sözleşme, tool'lar, retry politikası, testlerin beklentileri).
> Bu bölümün bütün iddiası o iki sütunun oranıdır.

## GraphQL ↔ REST: ders olan farklar

| | GraphQL | REST v1 |
|---|---|---|
| whoami | **1 istek** (`me` + `account` tek sorguda) | **2 istek** (`GET /me` + `GET /account`) |
| Zaman bağlamı | 1 istek | **3 istek** (`/timesheet_settings`, `/effort_classes`, `/time_allocations`) |
| Alan adları | camelCase (`startedAt`) | snake_case (`started_at`) — **`sourceID` hariç** (REST'te de camel!) |
| Referans yazımı | `effortClassId` gibi `…Id` alanları | **İD'SİZ ad + düz id değeri**: `effort_class`, `person`, `time_allocation` |
| Tarih filtresi | `DateFilter` nesnesi | operatör **değerin içinde**: `?date=>=2026-01-01<=2026-01-31` |
| İş kuralı hatası | **HTTP 200** + `payload.errors` | **HTTP 422** + `"Validation Failed"` + `[alan, mesaj]` **ikilileri** |
| Bağlı kayıt | `assignment` (interface) | koşullu `request` / `task` / `problem` / `project_task` alanları |
| Yol B parametreleri | `timeSpent` + `timeSpentEffortClassId` + `timeEntryDescription` | `time_spent` + `time_spent_effort_class` + `note` — **description taşınamaz** |
| Sayfalama | Relay cursor | `per_page` (maks 100) + `x-pagination-*` başlıkları + `link` header |

İki hata modeli, docs/01'deki dersin ikizi olarak birleşir: **istemci ne yalnız
HTTP koduna ne yalnız gövdeye bakabilir; transport'un lehçesini bilmek
zorundadır.** Adaptörün işi tam olarak bu lehçeyi tek biçime (`errors[]`)
çevirmektir — 422 bir istisna DEĞİLDİR, retry EDİLMEZ, iş kuralı reddi olarak
raporlanır.

Güvenilirlik politikası (docs/15) transport-üstüdür ve aynen uygulanır:
`GET`=query, `POST /time_entries`=guarded_create, `PATCH /time_entries/:id`=
idempotent_update, `PATCH /requests|tasks/:id`=**no_retry**. `[retry]`/`[dedup]`
izleri aynı biçimde düşer; dedup geri-okuması `GET /time_entries?sourceID=`dir.

Yol A/B çatalı REST'te de aynıdır: `POST /time_entries` ticket'a bağlayamaz,
`PATCH /requests/:id` artımlı `time_spent` alır (tarih/kişi kontrol edilemez).
**Kısıt API modelindedir, sorgu dilinde değil** — bölümün ikinci ana cümlesi.

> ✅ **Bu tablo 2026-08-06'da resmî dokümantasyona karşı DOĞRULANDI** (D17,
> docs/08). İlk taslağımızdaki ALTI varsayım yanlış çıktı — `person_id` gibi
> id'li adlar, `date_from/date_to` parametreleri, nesne biçimli 422 gövdesi,
> `assignment` alanı, `time_entry_description`, sayfalamasızlık — ve hepsi
> hem sahte yüzeyde hem üç adaptörde düzeltildi. Ders: *"dokümantasyondan
> çıkardım" ile "dokümantasyona karşı doğruladım" aynı şey değildir.* İlkini
> yazan biz, ikincisini yapınca altı hatasını bulan da biziz.

## Resmî `Xurrent.GraphQL` .NET SDK'sı: ölçülmüş bir deneme

C#'a üçüncü bir seçenek eklendi: `XURRENT_API=graphql-sdk` →
`Xurrent/SdkLiveAdapter.cs`, NuGet `Xurrent.GraphQL` üzerinden konuşur.
TS/Python'da bilinçli olarak YOKTUR: karşıtlık dersin kendisidir — *bir* dilde
vendor SDK, ikisinde el yazması istemci, sözleşme aynı.

Sonda (probe) sonuçları — iddia değil ölçüm:

1. **Endpoint override yok.** `XurrentClient`'ın `apiBaseUrl` parametresi bir
   *domain soneki*dir: `http://127.0.0.1:4000` verilince SDK
   `https://graphql.http://127.0.0.1:4000` üretir. `HttpClient`/DI dikişi de
   olmadığından SDK **sahte sunucuya yönlendirilemez** → SDK yolu senaryo
   kapısından geçirilemez; birim testler girdi-kurma katmanını (`SdkGirdi`)
   doğrular, canlı davranış `DOĞRULANMALI` kalır. *"Test edilebilirlik bir
   özellik talebidir"* — kendi adaptörünüzü yazarken base URL'i parametre yapın.
2. **`RequestUpdateInput`'ta `timeEntryDescription` yok** (TimeSpent +
   TimeSpentEffortClassId + Note var). El yazması yolun gönderdiği alan SDK
   tipinde ifade edilemiyor — testle sabitlendi. SDK'lar API'nin tamamını
   taşımayabilir; sözleşmeniz SDK tipine değil API'ye yazılmalıdır.
3. **Retry sınırı:** SDK rate-limit yönetimini kendi içinde yapar; Polly ile
   sarmak `no_retry` sınıfında çift sayım riski üretirdi. SDK yolunda `[retry]`
   izi ÜRETİLMEZ; sınır kod yorumunda açıkça belgelidir. İki retry katmanı
   üst üste konmaz — hangisinin sorumlu olduğunu SEÇMEK gerekir.

> 🎤 **Anlatım notu:** Bu üç madde "SDK kötü" demek değildir; "SDK bir
> bağımlılıktır ve sınırlarıyla satın alınır" demektir. Sınıfa soru:
> *"Hangi durumda graphql-sdk'yı, hangi durumda el yazmasını seçerdiniz?"*

## HTTP yüzeyi notu (WP6'nın C# köşesi)

`both` modunda tek süreçte iki oturum duruşu gerekir; resmî C# MCP SDK'sında
`Stateless` seçeneği DI konteyneri başına tektir. Çözüm: v1 oturumlu boru hattı
iç loopback portta ayrı bir Kestrel'de koşar, `/mcp/v1` istekleri SSE-güvenli
mini bir ters vekille iletilir — dışarıdan tek port görünür. SDK kısıtını
mimariyle telafi etmenin belgelenmiş örneği (`Agent/WebHost.cs`).
