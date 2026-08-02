# 01 — Xurrent GraphQL API'si

> **Bölüm hedefi:** Xurrent'a nasıl bağlanılır, veri modeli nasıl okunur ve
> *hata vermeden yanlış sonuç üreten* filtre tuzakları nelerdir.

| ← Önceki | Sonraki → |
|---|---|
| [00 — Genel bakış](00-genel-bakis.md) | [02 — Zaman girişi modeli](02-zaman-girisi-modeli.md) |

---

## Nereye bağlanıyoruz?

Tek endpoint, tek HTTP metodu:

```
POST https://graphql.xurrent.com/
```

**Her operasyon POST'tur.** Okuma sorguları dahil. GET ile query göndermeye çalışma.

### Bölgeler

| Bölge | URL |
|---|---|
| Global (varsayılan) | `https://graphql.xurrent.com` |
| Australia | `https://graphql.au.xurrent.com` |
| United Kingdom | `https://graphql.uk.xurrent.com` |
| Switzerland | `https://graphql.ch.xurrent.com` |
| United States | `https://graphql.us.xurrent.com` |
| QA | `https://graphql.xurrent.qa` |
| Demo | `https://graphql.xurrent-demo.com` |

> ### ⚠️ Yanlış yaparsan ne olur — `eu` bölgesi
>
> **`eu` diye bir bölge YOKTUR.** `graphql.eu.xurrent.com` wildcard DNS sayesinde
> *çözülür* — yani DNS hatası almazsın — ama TLS el sıkışması sertifika uyuşmazlığıyla
> patlar. Hata mesajı ağ katmanından gelir ve "Xurrent erişilemiyor" gibi görünür.
> Saatler kaybettiren, tamamen sahte bir arıza.
>
> **Global zaten Avrupa'dadır.** Avrupa için hiçbir şey yapma.

Bu yüzden [`.env.example`](../.env.example) içinde `XURRENT_GRAPHQL_URL` tam URL olarak
tutulur; "bölge kodu" alıp URL üreten bir yardımcı fonksiyon yazılmadı. Üretilebilecek
en tehlikeli değer `eu` idi.

---

## Kimlik doğrulama nasıl çalışır?

Üç header:

```http
POST / HTTP/1.1
Host: graphql.xurrent.com
Authorization: Bearer <token>
X-Xurrent-Account: <hesap-slug>
Content-Type: application/json
```

| Header | Değer | Not |
|---|---|---|
| `Authorization` | `Bearer <token>` | Personal Access Token **veya** OAuth access token. Wire seviyesinde ikisi aynıdır. |
| `X-Xurrent-Account` | slug | **Numerik değil.** Örn. `widget`, `wdc`. Settings console → Account Overview. |
| `Content-Type` | `application/json` | |

> ### ⚠️ Yanlış yaparsan ne olur — yanlış hesap slug'ı
>
> `X-Xurrent-Account` yanlışsa **401 almazsın.** Token geçerli, hesap geçerli, sorgu
> geçerli — sadece *boş sonuç* dönersin.
>
> Özellikle can yakan durum: **iç personelin time entry'leri DIRECTORY ACCOUNT'ta yaşar.**
> Müşteri hesabının slug'ıyla bağlanıp "kaydı bulamıyorum" hatası almak, canlı
> entegrasyonlarda bir numaralı zaman kaybıdır.
>
> Bu yüzden `xurrent_whoami` hem `person` hem `account` döner ve ilk çalıştırılacak
> tool olarak tasarlandı.

### Scope modeli

Token'ın *neyi görebildiği* iki katmanla belirlenir:

1. **Token'ın kendi izinleri** — PAT oluşturulurken seçilen scope'lar.
2. **`X-Xurrent-Account` + sorgudaki `view` parametresi** — hangi hesabın verisini
   görüntülediğin.

İkinci katman en sık gözden kaçandır. Ayrıntı: aşağıda [`view` bölümü](#view).

### Rate limit

**20 istek / 2 saniye.** Pratik sonuç: ardışık istekler arasında **en az 110 ms** bekle.

Bu, toplu yazma tool'unun (`xurrent_create_time_entries_bulk`) tasarımını doğrudan
belirledi — çünkü:

> **GraphQL istek başına yalnızca 1 mutation kabul eder.**
> Dolayısıyla N kayıt = N ayrı HTTP isteği = **atomik değil.**

50 satırlık bir bulk işlemi en az 5,5 saniye sürer ve ortasında yarıda kalabilir. Bu
gerçek gizlenmez; `stopOnError` parametresi ve satır bazlı `results` dizisi tam olarak
bu yüzden var.

Rate limit durumu HTTP response header'larından okunur ve `xurrent_whoami` çıktısındaki
`rateLimit` nesnesine (`limit`, `cost`, `remaining`, `resetAt`) yansıtılır.

> **`DOĞRULANMALI`** — header adlarının birebir yazımı canlı hesapta doğrulanmalıdır.
> Bkz. [08 — Riskler ve SSS](08-riskler-ve-sss.md).

---

<a id="pagination"></a>

## Sayfalama: Relay connection

Xurrent standart Relay connection deseni kullanır:

```graphql
requests(first: 25, after: "cursor...") {
  totalCount
  pageInfo { hasNextPage endCursor }
  nodes { id subject }
}
```

Sözleşmedeki `WorkPage` tipi tam olarak bunu yansıtır: `totalCount`, `hasNextPage`,
`endCursor`, `nodes`.

İki pratik kural:

- **`first` zorunlu davranışsın.** Sınırsız sorgu ya reddedilir ya da rate limit'i
  tüketir. Sözleşmede `first` varsayılanı 25, maksimumu 100.
- **Request ve Task ayrı cursor'lar taşır.** Tek bir sorguda ikisini birlikte çekiyoruz;
  bu yüzden `xurrent_list_open_work` girdisinde `afterRequests` ve `afterTasks` ayrı
  parametrelerdir. Tek bir `after` yazmak, iki koleksiyondan birini yanlış sayfadan
  okumaya yol açar.

---

<a id="kimlik"></a>

## Kimlik: "ben kimim?" ve `$me`

Her entegrasyonun ilk sorusu aynıdır. Xurrent'ta cevabı **1 puanlık** tek bir sorgudur —
bağlantıyı doğrulamanın en ucuz yolu.

```graphql
query WhoAmI {
  me {
    id
    name
    primaryEmail
    jobTitle
    timeZone
    disabled
    organization { id name }
  }
}
```

Dönen `id` şuna benzer (mock fixture'dan gerçek değer):

```
TW9jay9QZXJzb24vMQ
```

Bu **opak bir GraphQL global node ID**'dir. Base64 gibi görünmesi bir tesadüf değil ama
bir sözleşme de değil.

> ### 🔒 Değişmez kural — ID'ler asla üretilmez
>
> Hiçbir ID elle yazılmaz, tahmin edilmez, base64 ile "çözülüp" yeniden kurulmaz.
> **Her ID bir tool çıktısından gelmek zorundadır.**
>
> Bu kural chatbot'un sistem promptunda ayrıca madde olarak yazılıdır
> ([05 — Chatbot](05-chatbot.md)), çünkü LLM'lerin en sık yaptığı hata "makul görünen"
> bir ID uydurmaktır. Uydurulmuş ID'yle yapılan bir `requestUpdate`, **başka birinin
> ticket'ına** zaman yazabilir.

### `$me` özel değeri

Sözleşmedeki `personId` alanları `"$me"` değerini kabul eder — "authenticated user"
demektir. Sunucu bunu ya `me { id }` sonucuyla ya da doğrudan filtreye geçirerek çözer:

```graphql
filter: { member: { values: ["$me"] } }
```

`PersonReferenceFilter.values` `$me` özel değerini kabul eder; ayrı bir kimlik çözümleme
turu gerekmez.

> ### ⚠️ Yanlış yaparsan ne olur — `ID!` vs `String!`
>
> ```graphql
> # YANLIŞ — şema hatası
> query OpenWork($person: [ID!]!) { ... }
>
> # DOĞRU
> query OpenWork($person: [String]!) { ... }
> ```
>
> `PersonReferenceFilter` şu şekilde tanımlıdır:
>
> ```graphql
> input PersonReferenceFilter {
>   negate: Boolean
>   values: [String]!
> }
> ```
>
> `values` tipi **`[String]!`**'dır, `[ID!]!` değil. GraphQL değişken tipleri tam
> eşleşme ister; `ID!` göndermek `Variable "$person" of type "[ID!]!" used in position
> expecting type "[String]!"` hatası verir. Sezgi `ID` demeni söyler — şema `String`
> diyor. Ayrıca `$me` özel değeri de zaten bir ID değil, bir *işarettir*.

### Kişiyi e-posta ile bulmak

```graphql
query FindPerson($email: String!) {
  people(
    first: 5
    view: all
    filter: { primaryEmail: { values: [$email] } }
  ) {
    totalCount
    nodes { id name primaryEmail jobTitle timeZone disabled organization { id name } }
  }
}
```

`PersonFilter.primaryEmail` bir **TextFilter**'dır ve **tam eşleşme** yapar — substring
değil. `ayse` yazarak `ayse.demir@ornek.com` bulunmaz.

Bu yüzden `xurrent_find_person` çıktısında `suggestFuzzy` alanı var: tam eşleşme
bulunamadığında chatbot serbest metin aramayı önerebilsin diye.

---

<a id="acik-isler"></a>

## Açık iş sorgusu — dersin en yoğun tuzak alanı

İster #1: *"İlgili kişinin üzerindeki açık görevleri/talepleri listele."*

Xurrent'ta iki ayrı kayıt tipi var ve ikisi de çekilmeli:

- **Request** (talep) — son kullanıcıdan gelen
- **Task** (görev) — bir workflow içindeki adım

```graphql
requests(first: Int, after: String, view: ..., order: ..., filter: RequestFilter)
tasks(first: Int, after: String, view: ..., order: ..., filter: TaskFilter)
```

Burada **beş tuzak** var ve **hepsi sessizdir** — yani yanlış yaparsan hata almazsın,
sadece eksik veri alırsın.

### Tuzak 1 — `member` vs `assignee` asimetrisi

| | Filtre alanı (atanan kişi) | Node alanı (atanan kişi) |
|---|---|---|
| **Request** | `member` | `member` |
| **Task** | **`assignee`** | `member` |

Okuduğun doğru: **node üzerinde ikisi de `member`, filtrede Task `assignee` kullanır.**

- `TaskFilter`'da **`member` alanı YOKTUR.**
- `RequestFilter`'da **`assignee` alanı YOKTUR.**

> ### ⚠️ Yanlış yaparsan ne olur
>
> `TaskFilter`'a `member` yazarsan sunucu şema hatası döndürür. Ama pratikte:
> istemcilerin çoğu `errors` dizisini `data` null olduğunda bile sessizce yutar,
> geliştirici de **"bu kişinin task'ı yokmuş"** diye yorumlar.
>
> Node çıktısında `member` görmen bu hatayı *pekiştirir* — "alan var, o zaman filtrede de
> vardır" dersin. Yok.
>
> **Kural:** filtre şeması ile node şeması ayrı şeylerdir. Node'da gördüğün alan
> filtrede olmak zorunda değildir.

<a id="view"></a>

### Tuzak 2 — `view` varsayılanı seni ısırır

`view` parametresinin varsayılanı **`current_account`**'tur.

```graphql
requests(first: 25, view: all, filter: { ... })   # ← view: all HER ZAMAN geçilir
```

> ### ⚠️ Yanlış yaparsan ne olur
>
> `view` geçmezsen kişinin **diğer hesaplardaki** işleri görünmez. Çok hesaplı
> kurulumlarda (ki kurumsal Xurrent kurulumlarının çoğu böyledir) liste eksik döner ve
> **hiçbir uyarı verilmez.**
>
> Test ortamın tek hesaplıysa bu tuzağı asla fark etmezsin — canlıda fark edersin.

Bu yüzden `xurrent_list_open_work` ve `xurrent_find_person` girdilerinde `view`
parametresi **`all` varsayılanıyla** açıkça yer alır. Xurrent varsayılanını devralmıyoruz;
kendi varsayılanımızı dayatıyoruz.

### Tuzak 3 — "open" diye bir view yoktur

Açık/kapalı ayrımı **yalnızca `status` ile** yapılır. Sihirli bir `view: open` yok,
`isOpen` diye bir sunucu alanı yok. Filtreyi sen kuracaksın:

```graphql
filter: {
  member: { values: $person }
  status: { negate: true, values: [completed] }    # Request için
}
```

`negate: true` = "bu değerler HARİÇ".

### Tuzak 4 — terminal durum sayısı asimetrisi

Bu, projedeki en sinsi tuzak.

| | Terminal (kapalı) durumlar | Sayı |
|---|---|---|
| **RequestStatus** | `completed` | **1** |
| **TaskStatus** | `completed`, `approved`, `failed`, `rejected`, `canceled` | **5** |

Dayanak: `Request.completedAt` yalnızca durum *Completed* iken set edilir;
`Task.finishedAt` ise **bu beş durumun hepsinde** set edilir.

Açık durumlar (referans):

```
RequestStatus açık:  declined, on_backlog, assigned, accepted, in_progress,
                     waiting_for, waiting_for_customer, reservation_pending,
                     workflow_pending, project_pending

TaskStatus açık:     registered, declined, assigned, accepted, in_progress,
                     waiting_for, waiting_for_customer, request_pending
```

> ### ⚠️ Yanlış yaparsan ne olur
>
> Task filtresine sadece `completed`'ı yazarsan **`approved` durumundaki görevler açık
> sanılır.** Fixture'daki Task **#4390** (`status: approved`) tam olarak bunu kanıtlamak
> için var: naif bir filtre onu listeler, doğru filtre elemez.
>
> Sonuç: kullanıcıya "şu görev hâlâ üzerinde" dersin, o görev haftalar önce onaylanıp
> kapanmıştır. Kullanıcı sana bir daha güvenmez.

Ayrıca `declined` **her ikisinde de AÇIKTIR.** Reddedilmiş bir talep hâlâ birinin
masasındadır — kapanmamıştır.

Ve bir ürün kararı: **`waiting_for_customer` açık sayılır.** Şu anda aksiyon
alınamıyor olması kapandığı anlamına gelmez; zaman yazılabilir (örneğin müşteriyle
yapılan takip toplantısı). Fixture'daki Request #70315 bu senaryodur.

### Tuzak 5 — `completedAt` vs `finishedAt`

| Kavram | Request | Task |
|---|---|---|
| Görünen numara | `requestId` | `taskId` |
| Kapanma zamanı | `completedAt` | **`finishedAt`** |
| Hedef/termin | `nextTargetAt` | **`completionTargetAt`** |

**Task'ta `completedAt` alanı YOKTUR.** Sorguya yazarsan `Cannot query field
"completedAt" on type "Task"` alırsın — bu, listedeki *tek gürültülü* tuzaktır; en
azından hemen fark edersin.

Sözleşmedeki `WorkItem` tipi bu ikiliği tek bir şekle normalize eder:

| Sözleşme alanı | Request kaynağı | Task kaynağı |
|---|---|---|
| `displayId` | `requestId` | `taskId` |
| `targetAt` | `nextTargetAt` | `completionTargetAt` |
| `isOpen` | `status ∉ {completed}` | `status ∉ {completed, approved, failed, rejected, canceled}` |
| `parentLabel` | — | workflow veya bağlı request |

Normalizasyonu **sunucuda** yapıyoruz, LLM'de değil. LLM'e "Request'te şu alan, Task'ta
bu alan" diye anlatmak, her konuşmada yeniden hata yapma şansı vermektir.

---

## Çalışan örnek: açık iş sorgusu

Beş tuzağın hepsinden kaçınan tam sorgu:

```graphql
query OpenWork(
  $person: [String]!          # ← ID! DEĞİL (Tuzak 5)
  $first: Int!
  $afterRequests: String
  $afterTasks: String
) {
  requests(
    first: $first
    after: $afterRequests
    view: all                                     # ← Tuzak 2
    filter: {
      member: { values: $person }                 # ← Tuzak 1: Request = member
      status: { negate: true, values: [completed] }   # ← Tuzak 4: tek terminal
    }
  ) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      id                      # ← mutation'larda KULLANILAN opak ID
      requestId               # ← UI'da görünen numara
      subject
      status
      member { id name }
      team { id name }
      completedAt             # ← Request'te completedAt (Tuzak 5)
      nextTargetAt            # ← Request'te nextTargetAt
      updatedAt
    }
  }

  tasks(
    first: $first
    after: $afterTasks
    view: all
    filter: {
      assignee: { values: $person }               # ← Tuzak 1: Task = assignee
      status: {
        negate: true
        values: [completed, approved, failed, rejected, canceled]   # ← BEŞİ DE
      }
    }
  ) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      taskId                  # ← Task'ta taskId
      subject
      status
      member { id name }      # ← node'da member (filtrede assignee!)
      team { id name }
      finishedAt              # ← Task'ta finishedAt, completedAt YOK
      completionTargetAt      # ← Task'ta completionTargetAt
      updatedAt
    }
  }
}
```

Değişkenler:

```json
{
  "person": ["$me"],
  "first": 25,
  "afterRequests": null,
  "afterTasks": null
}
```

Mock modda beklenen çıktı — `requests.totalCount = 3`, `tasks.totalCount = 3`.
Dördüncü kayıtlar (Request #70120 `completed`, Task #4390 `approved`) elenir.

> **`order` parametresi hakkında:** `requests`/`tasks` bir `order` argümanı kabul eder.
> Argümanın *tam şekli* (alan adları, yön enum'ı) canlı şemada doğrulanmadı, bu yüzden
> yukarıdaki örnekte kullanılmadı. `DOĞRULANMALI` — bkz.
> [08 — Riskler ve SSS](08-riskler-ve-sss.md).

---

## Cache anahtarı neden `(accountId, nodeId)`?

`xurrent_list_open_work` çıktısında `accountId` alanı var. Süs değil.

**`status`, `member`, `team` alanları hesaba özgüdür.** Aynı node ID, farklı bir
`X-Xurrent-Account` ile sorgulandığında farklı `status` dönebilir. Cache'i sadece node ID
ile anahtarlarsan, hesap değiştiğinde bayat veri servis edersin.

**Kural:** cache anahtarı `(accountId, nodeId)` ikilisidir. Tek başına `nodeId` yetmez.

---

## Hata semantiği: iki ayrı hata kanalı

Xurrent GraphQL'de hatalar **iki farklı yerden** gelir ve karıştırılmaları çok yaygındır:

| Kanal | Ne zaman | HTTP | Nerede |
|---|---|---|---|
| **Top-level `errors`** | Şema hatası, auth hatası, rate limit | 200 veya 4xx | Yanıtın kökünde `errors[]` |
| **Payload `errors`** | **İş kuralı / doğrulama hatası** | **200** | `data.<mutation>.errors[]` |

İkincisi kritik:

```json
{
  "data": {
    "timeEntryCreate": {
      "clientMutationId": "xurrent-mcp-1",
      "errors": [
        { "message": "Time spent must be a multiple of 30", "path": ["timeSpent"] }
      ],
      "timeEntry": null
    }
  }
}
```

**HTTP 200. Top-level `errors` yok. Ama işlem BAŞARISIZ.**

> ### ⚠️ Yanlış yaparsan ne olur
>
> `if (response.ok)` kontrolü yaparsan bu kaydı **başarılı sanarsın.** Kullanıcıya
> "kaydettim" dersin, Xurrent'ta hiçbir şey yoktur. Bir hafta sonra timesheet eksik çıkar.
>
> **Kural, sözleşmede yazılı:**
> `errors[]` dizisi boş değilse işlem **BAŞARISIZ** olmuştur. `timeEntry` alanı `null`'dır.
> Chatbot bunu "kaydettim" diye raporlayamaz — sistem promptunda ayrıca madde olarak var.

---

## Özet — cebine koyacakların

| Konu | Kural |
|---|---|
| Endpoint | Tek URL, **her operasyon POST** |
| Bölge | `eu` **yok**; Global zaten Avrupa |
| Header | `Authorization` + `X-Xurrent-Account` (slug, numerik değil) |
| Hesap | İç personelin time entry'leri **directory account**'ta |
| Değişken tipi | `PersonReferenceFilter.values` → **`[String]!`** |
| `view` | **Her zaman `all`** geç |
| Filtre alanı | Request → `member`, Task → **`assignee`** |
| Terminal durum | Request **1**, Task **5** |
| Kapanma alanı | Request `completedAt`, Task **`finishedAt`** |
| Sayfalama | Relay; Request ve Task **ayrı cursor** |
| Rate limit | 20 / 2 sn → **≥110 ms** ara |
| Mutation | İstek başına **1 tane** → bulk atomik değil |
| Hata | `data.<mutation>.errors` dolu ise **HTTP 200 olsa da başarısız** |

Sıradaki bölümde bu API'nin **yazma** tarafına giriyoruz — ve orada işler çok daha
ilginçleşiyor: [02 — Zaman girişi modeli](02-zaman-girisi-modeli.md).
