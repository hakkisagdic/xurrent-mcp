# 10 — Sıfırdan geliştirme: bu proje nasıl üretildi

> **Bölüm hedefi:** Bu repoyu adım adım yeniden üretebilmek. Her adımda AI'a
> verilen **gerçek prompt**, insanın verdiği **karar**, üretilen **dosyalar** ve
> çalıştırılabilir bir **doğrulama** var.

> **Not (bakım):** Bu dosya `README.md` üzerinden linklenir. Anlatım notları
> tablosuna `10 — Sıfırdan geliştirme` satırı olarak eklenmelidir.

| ← Önceki | Sonraki → |
|---|---|
| [09 — Protokol geçişi](09-protokol-gecisi.md) | [Demo senaryosu](demo/senaryo.md) |

Makine-okunur hâli: [`docs/atolye/adimlar.json`](atolye/adimlar.json) —
şeması [`docs/atolye/adimlar.schema.json`](atolye/adimlar.schema.json).

---

## Sihirbaz mı, atölye mi?

İki ayrı ders akışı var ve **karıştırılmamalıdır**.

| | Sihirbaz | Atölye |
|---|---|---|
| Ne öğretir | Uygulamanın **ne yaptığını** | Uygulamanın **nasıl üretildiğini** |
| Veri | [`docs/wizard/steps.json`](wizard/steps.json) | [`docs/atolye/adimlar.json`](atolye/adimlar.json) |
| Koşucu | `clients/wizard/wizard.mjs` | `clients/atolye/atolye.mjs` |
| Ne çalıştırır | Gerçek MCP tool çağrıları | Repodaki gerçek doğrulama komutları |
| Bu belgenin karşılığı | [07 — Sihirbaz](07-sihirbaz.md) | **bu belge** |

İkisi bilinçli olarak benzer yapıdadır: aynı projede iki farklı şema kafa karıştırır.

---

## Atölye koşucusunu çalıştırmak

```bash
node clients/atolye/atolye.mjs                    # baştan sona, anlatarak
node clients/atolye/atolye.mjs --auto             # Enter beklemez (CI / prova)
node clients/atolye/atolye.mjs --adim 11          # tek adım (kısmi id eşleşmesi)
node clients/atolye/atolye.mjs --insa             # ★ doğrulama komutlarını GERÇEKTEN çalıştırır
node clients/atolye/atolye.mjs --live             # sahte Xurrent'a karşı live yol adımlarını da sürer
```

| Seçenek | Ne yapar |
|---|---|
| *(seçeneksiz)* | Adımları sırayla anlatır; her adımın sonunda Enter bekler. Doğrulama komutları **gösterilir, çalıştırılmaz**. |
| `--auto` | Beklemez. Prova ve kayıt için. |
| `--adim <id>` | Sadece o adımı çalıştırır. Kısmi eşleşme: `--adim 11` → `11-mimari-karari-olcmeden-verme`. |
| `--insa` | Her adımın `dogrulama.komut` değerini **repo kökünden gerçekten çalıştırır**. Geçmezse adım FAIL'dir. |
| `--live` | `tools/fake-xurrent` senaryolarını da içeren adımları sürer; sahte sunucuyu koşucu ayağa kaldırır. |

`--insa` modunda sonuç modeli sihirbazla aynıdır: **PASS · FAIL · SKIP**.
`atlanabilir: true` işaretli bir doğrulamanın ön koşulu yoksa sonuç `SKIP` olur —
başarısızlık değildir ve çıkış kodunu etkilemez.

### Ön koşullar

`--insa` modunun tamamının geçmesi için:

```bash
cp .env.example .env                          # opsiyonel; .env olmadan da varsayılanlar çalışır
cd servers/typescript && npm install && npm run build && cd ../..
cd servers/python     && uv sync              && cd ../..
cd servers/csharp     && dotnet build         && cd ../..
cd clients/wizard     && npm install          && cd ../..
```

Hiçbir adım `ANTHROPIC_API_KEY` istemez. Atölye tamamen internetsiz çalışır.

---

## Faz haritası

| # | Faz | Adımlar | Özet |
|---|---|---|---|
| 1 | **Keşif** | 01–03 | Kod yazmadan önce. Bulunan tek kısıt tüm mimariyi belirledi. |
| 2 | **Sözleşme ve veri** | 04–05 | Önce dil-bağımsız tool sözleşmesi, sonra tuzak öğreten mock veri. |
| 3 | **Üç implementasyon** | 06–09 | Aynı sözleşme, üç dil. İş mantığı protokolden ayrı. |
| 4 | **Spec değişti** | 10–12 | Breaking change. Mimari kararı varsayarak değil ölçerek verdik. |
| 5 | **Kusur avı ve live yolu** | 13–15 | Ajan raporlarına güvenilmedi. Üç gerçek kusur çıktı. |
| 6 | **Yayın** | 16 | Mantıksal commit'ler, sır taraması, ne doğrulanmadı. |

---
---

# FAZ 1 — Keşif: kod yazmadan önce

## 01 — Dört ister, bir soru: bu bir script mi, bir sunucu mu?

**HEDEF.** İsteri okuyup paketleme kararını vermek. Bu, geri dönmesi en pahalı karardır.

Elimizde dört cümle vardı: bir kişinin açık taleplerini ve görevlerini id + açıklama
ile listele, her biri için kullanıcı süre belirtsin, girişleri ilgili kişi ve görev
için kaydet, ve o günkü takvimi okuyup her toplantıyı zaman girişine çevir.

Dördüncü ister ilk üçünden farklıdır. *"Her bir toplantıyı zaman girişi olarak ekle"*
cümlesi otomatik bir işmiş gibi durur — ama takvimde doğum günü de vardır, reddedilmiş
bir toplantı da, birbiriyle çakışan iki randevu da. İkinci ister de aynı yere çıkar:
*"kullanıcı süre belirtsin"* demek, hangi ticket, süre yuvarlanacak mı, dünkü tarih
kabul edilir mi sorularının **konuşulması** demektir.

Müzakere gerektiren bir iş, API çağrısından çok diyalog yönetimidir.

### PROMPT

```text
Bir ITSM ürünü (Xurrent) için dört isteri karşılayan bir uygulama tasarlayacağız:
  1) bir kişinin üzerindeki açık talep/görevleri id + açıklama ile listele
  2) her biri için kullanıcı süre belirtsin (başlangıç saati; tarih bugün veya dün olabilir)
  3) girişleri ilgili kişi ve görev için kaydet
  4) kişinin o günkü takvimini oku, her toplantıyı zaman girişi olarak ekle

KOD YAZMA. Önce şunu cevapla: bu iş bir CLI script'i mi, bir MCP sunucusu mu,
yoksa LLM'e doğrudan GraphQL yazdırmak mı?

Üç seçeneğin HER BİRİ için İSTER #2'nin nasıl karşılanacağını somut olarak anlat.
Cevabını şu soru üzerinden kur: bu seçenekte kullanıcıyla kaç tur konuşulur ve o
turları kim yürütür?
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Düz CLI script'i / kütüphane | En az katman, en az bağımlılık | Diyalog yönetimi elle yazılır ve her arayüz için tekrarlanır |
| LLM'e GraphQL şemasını verip sorguyu ona yazdır | Tool tasarlamaya gerek yok | Serbest sorgu = serbest mutation; şema context'e sığmaz; tuzaklar her konuşmada yeniden riske girer |
| **MCP sunucusu + ince istemciler** ✅ | Diyaloğu host LLM yürütür; aynı sunucu Claude Code'a, chatbot'a, web'e ve sihirbaza takılır | Protokol katmanı, onay akışı ve sözleşme bakımı ek iş |

**Neden.** İster #2 bir müzakeredir. Müzakereyi bir kez tool yüzeyi olarak tanımlayıp
diyaloğu LLM'e bırakmak, aynı işi birden çok istemcide birden çalıştırır. Repoda kanıtı
duruyor: aynı sunucuya dört farklı istemci bağlanıyor ve hiçbiri iş mantığını tekrarlamıyor.

### ÜRETİLEN DOSYALAR

`docs/00-genel-bakis.md` · `README.md`

### DOĞRULAMA

Yok — bu saf bir insan kararı. Doğrulaması sonraki adımların tutması.

### NE ÖĞRENDİK

- Bir isteri okurken **"kaç tur konuşulacak"** sorusunu sor. Tek turluk işler script'tir; çok turlu işler bir yetenek yüzeyi ister.
- Paketleme kararı geri dönmesi en pahalı karardır; kod yazmadan önce verilir.
- Aynı iş mantığına birden çok istemci bağlanacaksa mantığı istemciden ayır. Bu kural MCP'ye özel değil; MCP sadece ayrımı zorunlu kılıyor.

---

## 02 — Beş paralel araştırma kolu, sıfır satır kod

**HEDEF.** API'nin gerçekte ne yapabildiğini kod yazmadan önce öğrenmek.

İlk aşamada hiç kod yazılmadı. Beş araştırma kolu paralel çalıştırıldı: Xurrent
GraphQL şeması ve kimlik doğrulama, zaman girişi veri modeli, takvim sağlayıcıları
(Microsoft Graph ve Google), MCP protokolü ile üç dilin SDK'ları, ve ekosistem
farkları. Toplam yaklaşık **887 bin token** harcandı.

Paralel çalışmanın asıl faydası hız değil, **çapraz doğrulamadır**. Bir kol yanılırsa
diğerinin çıktısı onunla çelişir; çelişki de bir bulgudur.

Keşfin en değerli ürünü ise bir liste oldu: **neyi bilmiyoruz**.
[`docs/08`](08-riskler-ve-sss.md#dogrulanmali) içindeki `DOĞRULANMALI` maddeleri
(D1–D13) tam olarak budur — resmî dokümantasyondan çıkarılmış ama canlı bir hesapta
gözlenmemiş her iddia oraya yazıldı.

### PROMPT

```text
Xurrent'ın GraphQL API'sini araştır. HENÜZ KOD YAZMA.

Şu beş soruyu ayrı ayrı cevapla ve her cevabın yanına kaynağını yaz:
  1. Kimlik doğrulama nasıl yapılır? Hangi header'lar zorunlu? Bölge URL'leri neler?
  2. Bir kişinin açık Request ve Task'larını çekmek için filtre alanları tam olarak ne?
     Request ve Task filtreleri AYNI mı? Terminal (kapalı) durumların TAM listesi ne?
  3. TimeEntry nasıl oluşturulur? TimeEntryCreateInput'un TÜM alanlarını listele.
  4. Timesheet ayarları nereden okunur? timeIncrement nedir, varsayılanı kaç?
  5. Rate limit nedir, hangi header'larla raporlanır?

Her cevap için ayrıca şunu belirt: bu bilgi resmî dokümantasyonda AÇIKÇA yazıyor mu,
yoksa çıkarım mı? Çıkarım olanları ayrı bir 'DOĞRULANMALI' listesinde topla ve her
madde için 'nasıl doğrularım' ile 'yanlışsa ne olur' sorularını cevapla.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| İskeleti hemen kur, API'yi yol boyu öğren | İlk saatte çalışan bir şey | Yanlış varsayım üzerine kurulan mimari, bulgu geldiğinde baştan yazılır |
| Resmî SDK örneğini kopyala | En hızlı başlangıç | Örnek bizim isterimizi tanımaz; alan kısıtlarını hiç görmezsin |
| **Önce kapsamlı keşif, sonra tek seferde doğru mimari** ✅ | Kısıtlar mimariyi belirler, tersi değil | İlk aşamada gösterilecek çalışan bir şey yok |

**Neden.** Bir sonraki adımdaki tek bulgu — *timeEntryCreate bir ticket'a bağlanamaz* —
tüm yazma mimarisini belirledi. O bulguyu kaçırıp kod yazmaya başlasaydık iki gün sonra
baştan yazardık. AI destekli geliştirmede keşfin maliyeti token, yanlış mimarinin
maliyeti zamandır; oran bozuk olduğu için keşfe fazladan harcamak neredeyse her zaman kârdır.

### ÜRETİLEN DOSYALAR

`docs/01-xurrent-api.md` · `docs/02-zaman-girisi-modeli.md` · `docs/04-takvim.md` · `docs/08-riskler-ve-sss.md`

### DOĞRULAMA

```bash
node clients/wizard/wizard.mjs --server ts --step 04 --auto --json
```

Beklenen: `0 başarısız` — açık iş listesi 3 Request + 3 Task döner; `approved`
durumundaki Task açık sayılmaz.

### TUZAK

Araştırma sırasında Xurrent'ın `eu` diye bir bölge endpoint'i olduğu varsayıldı.
Wildcard DNS yüzünden adres çözülüyor ama TLS patlıyor ve hata *"ağ sorunu"* gibi
görünüyor. Böyle bir bölge yok; Global zaten Avrupa. **Doğrulanmamış bir varsayım
yalnızca yanlış kod üretmez, hata mesajını da yanlış yere baktırır.**

### NE ÖĞRENDİK

- Araştırma çıktısını **"bildiklerimiz"** ve **"çıkarımlarımız"** diye ikiye ayır. İkinci liste, ilk canlı bağlantıda sırayla yürütülecek iş listendir.
- Bir kısıtı erken bulmak, geç bulmaktan katbekat ucuzdur. Keşif bütçesini kod bütçesinden ayrı düşün.
- Paralel araştırma kollarının değeri hız değil, birbirini denetlemeleridir.

---

## 03 — ★ İki mutation, aynı iş, farklı yetenekler

**HEDEF.** İsterin API tarafından tek adımda karşılanamadığını görmek ve çıkış yolunu bulmak.

Bu projenin tek en önemli bulgusu: **`TimeEntryCreateInput` içinde `requestId`,
`taskId` veya `assignmentId` alanı YOKTUR.** Yani `timeEntryCreate` ile oluşturulan
bir zaman girişi bir Request veya Task'a bağlanamaz.

Ticket'a bağlamanın tek yolu parent kaydın kendi mutation'ıdır: `requestUpdate` veya
`taskUpdate` içine `timeSpent` göndermek. Ama o yolda `date` alanını sunucu "bugün"
yapar, `person` alanını authenticated user yapar, `startedAt` hiç yazılmaz.

| | Yol A `timeEntryCreate` | Yol B `requestUpdate` / `taskUpdate` |
|---|---|---|
| Ticket'a bağlar mı | ❌ `assignment = null` | ✅ tek yol |
| `date` (T-1) kontrolü | ✅ | ❌ sunucu "bugün" atar |
| `startedAt` | ✅ | ❌ |
| `personId` | ✅ | ❌ authenticated user |

İsterimiz dördünü birden istiyordu. Çıkış yolu üçüncü bir mutation'ın input şemasında
saklıydı: **`TimeEntryUpdateInput`'ta `date`, `startedAt` ve `personId` VAR ama
`assignment` YOK.** Bir alan input şemasında yoksa güncellenemez, dolayısıyla mevcut
değeri korunur — yani ikinci adım ticket bağını **bozamaz**. Kısıtın kendisi garantiyi
veriyor.

### PROMPT

```text
TimeEntryCreateInput'un TÜM alanlarını listele. Sonra şu soruyu cevapla:

Bu mutation ile oluşturulan bir zaman girişi bir Request veya Task'a BAĞLANABİLİR Mİ?
Input'ta requestId / taskId / assignmentId benzeri bir alan var mı? Yoksa, bir zaman
girişini bir ticket'a bağlamanın BAŞKA yolu nedir?

Bulduğun HER yol için şu dört yeteneği ayrı ayrı işaretle:
  - ticket'a bağlar mı
  - date alanı (dünkü tarih) kontrol edilebilir mi
  - startedAt (başlangıç saati) yazılabilir mi
  - personId (başkası adına) verilebilir mi

Sonucu iki sütunlu bir tablo olarak ver. İsterimiz dördünü de istiyor: tek bir
mutation ile karşılanıyor mu? Karşılanmıyorsa, iki mutation'ı birleştiren bir yol
var mı — ve o yolda ilk mutation'ın kurduğu ticket bağı ikinci mutation tarafından
BOZULUR MU? Cevabını mutation'ların input şemalarına dayandır, tahmine değil.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| `link_first` — tarihi bugüne sabitle | Tek istek, atomik, en dayanıklı | T-1 karşılanamaz; başlangıç saati kaydedilmez |
| `date_first` — ticket bağından vazgeç | Tarih/saat/kişi tam kontrol; atomik | Kayıt ticket'a bağlanmaz; ticket bazlı raporda hiç görünmez |
| `two_step` — önce bağla, sonra düzelt | Dört yeteneğin dördünü de korur | 2 HTTP isteği; atomik değil |
| **Üçünü de kodla, seçimi yapılandırmaya bırak** ✅ | Takas kullanıcının raporlama ihtiyacına göre verilir; üçü derste yan yana gösterilebilir | Üç kod yolu, üç doğrulama yükü |

**Neden.** Hangi stratejinin doğru olduğunu API değil, kullanıcının raporlama ihtiyacı
belirliyor. Ticket bazlı rapor isteyen bir organizasyonda `date_first` işe yaramaz;
kilitli timesheet dönemi olan bir yerde `two_step`'in ikinci adımı reddedilebilir.
**Bir kısıtın tek doğru cevabı yoksa, cevabı koda gömmek yerine dışarı açılır:**
`XURRENT_BACKDATE_STRATEGY`. Ayrıca her strateji ne feda ettiğini `warnings` dizisinde
açıkça söyler — sessizce yuvarlanan hiçbir karar yok.

### ÜRETİLEN DOSYALAR

`servers/typescript/src/xurrent/strategies.ts` ·
`servers/python/src/xurrent_mcp/xurrent/strategies.py` ·
`servers/csharp/Xurrent/Strategies.cs`

### DOĞRULAMA

```bash
node clients/wizard/wizard.mjs --server ts --step 07 --auto --json
```

Beklenen: `0 başarısız` — dry-run planı **iki** mutation içerir: `requestUpdate` + `timeEntryUpdate`.

### TUZAK

`two_step`'in ikinci adımı için oluşan `TimeEntry`'nin id'sine ihtiyaç var.
`requestUpdate` payload'ının bu id'yi döndürüp döndürmediği **doğrulanamadı**
([docs/08 → D5](08-riskler-ve-sss.md#dogrulanmali)). Döndürmüyorsa aradaki arama bir
**heuristiktir**, garanti değil. Bu belirsizlik gizlenmedi; stratejinin en zayıf noktası
olarak `DOĞRULANMALI` listesine yazıldı.

### NE ÖĞRENDİK

- Bir API'nin **ne yapamadığı**, ne yapabildiğinden daha çok mimari belirler. Input şemalarını alan alan oku.
- Bir alanın input şemasında **olmaması** bazen bir garantidir: o alan güncellenemiyorsa mevcut değeri korunur.
- Tek doğru cevabı olmayan bir takası koda gömme; yapılandırmaya çıkar ve her seçeneğin neyi feda ettiğini çalışma zamanında kullanıcıya söyle.

---
---

# FAZ 2 — Sözleşme ve veri

## 04 — ★ Önce sözleşme: tek gerçek kaynak bir JSON dosyası

**HEDEF.** Üç implementasyonun da türetileceği dil-bağımsız tool sözleşmesini yazmak.

Kod yazmadan önce yazılan ikinci şey [`contract/tools.json`](../contract/tools.json)
oldu: **sekiz tool**, dil-bağımsız, girdi **ve** çıktı şemalarıyla.

Sözleşmeye yalnızca imzalar değil, keşifte bulunan tuzaklar da yazıldı. RequestFilter'da
atanan kişi alanının `member`, TaskFilter'da `assignee` olması gibi maddeler ilgili
tool'un `teachingNotes` alanında duruyor — **koda değil, sözleşmeye**. Böylece üç
implementasyon da aynı tuzağı aynı yerden öğreniyor.

Ortak kurallar ayrı bir `conventions` bloğunda toplandı: süre daima dakika, tarih
ISO8601, timestamp'te offset zorunlu, id'ler opak ve asla üretilmez, iş kuralı hataları
`errors` dizisiyle döner.

### PROMPT

```text
Dört isteri karşılayan MCP tool setini TASARLA. Kod yazma — tek çıktın
contract/tools.json olacak: dil-bağımsız bir tool sözleşmesi.

Kurallar:
  - Her tool için: name, kind (read|write|preview), summary, annotations
    (readOnlyHint, idempotentHint, destructiveHint, openWorldHint),
    input JSON Schema ve output JSON Schema.
  - Çıktı şeması ZORUNLU. Bir tool sözleşmesi, çağıranın ne göndereceği kadar
    ne ALACAĞINI da tarif etmek zorundadır.
  - Keşifte bulunan her tuzağı ilgili tool'un teachingNotes alanına yaz. Tuzak
    koda değil sözleşmeye yazılır ki üç implementasyon da aynı tuzağı bilsin.
  - Ortak kuralları ayrı bir conventions bloğunda topla: süre birimi, tarih ve
    timestamp formatı, id opaklığı, hata semantiği.
  - Tool sırası KANONİKTİR; üç implementasyon da bu sırayı korumak zorunda.

Son olarak açıkça belirt: hangi tool yazma yapar, hangisi YAPISAL olarak yapamaz.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Her dil kendi tanımını yazsın, referans TypeScript olsun | Ek dosya yok | Referans dil ayrıcalıklı olur; sapmalar sessizce birikir |
| Sözleşmeyi `docs/` içine yaz | Okunur, gerekçeli | Makine karşılaştıramaz; denetim insan gözüne kalır |
| **Tek dil-bağımsız JSON + otomatik doğrulayıcı** ✅ | Sapma CI'da yakalanır; üç dil eşit mesafede | Elle senkron tutulan bir katman doğar |

**Neden.** AI ile çalışırken en yüksek getirili adım **doğru sözleşmeyi tarif etmektir**;
implementasyon o tarifin türevidir. Sözleşme yalnızca belgede kalsaydı *"üç dil aynı
çıktıyı üretir"* ölçülemez bir slogan olurdu.

### ÜRETİLEN DOSYALAR

`contract/tools.json` · `scripts/verify-contract.mjs`

### DOĞRULAMA

```bash
node scripts/verify-contract.mjs --all
```

Beklenen: `TÜM SUNUCULAR SÖZLEŞMEYE UYUMLU`

### NE ÖĞRENDİK

- Sözleşmeyi kodun **önüne** koy ve makine-okunur yap. AI'a verdiğin en değerli girdi budur.
- Bir tool sözleşmesi **çıktıyı da** tarif etmelidir. Yalnızca girdiyi tarif eden sözleşme uyumu yarım ölçer (bunun bedelini 14. adımda ödedik).
- Alan adı ve sıra gibi "önemsiz" görünen ayrıntıları sözleşmeye yaz. Sessiz sapmalar tam olarak oralarda doğar.

---

## 05 — Mock veri rastgele değil, öğretici tasarlanır

**HEDEF.** Her kaydı bir kural öğretmek için var olan bir fixture seti kurmak.

- `requests.json`: 3 açık + 1 kapalı Request. `tasks.json`: 3 açık + 1 kapalı Task.
  Kapalı Task'ın durumu `completed` **değil `approved`** — Xurrent'ta beş terminal durum
  vardır ve sadece `completed`'ı eleyen naif bir filtre o kaydı açık sanar.
- `calendar.json`: **8 ham etkinlik, yalnızca 5'i gerçek toplantı.** Elenen üçü üç ayrı
  kural öğretir: doğum günü (`isAllDay`), öğle arası (`free`), ekip retrospektifi
  (`declined`). İki toplantı kasıtlı olarak çakışır → naif toplam **255**, doğru cevap **225**.
- `timesheet-settings.json`: `timeIncrement: 30`. Takvimdeki bir toplantı **45 dakika**.
  İkisi birlikte yuvarlama diyaloğunu zorunlu kılar.
- `effort-classes.json`: 4 kayıt, biri `disabled`. `EffortClassFilter`'da `disabled`
  filtresi olmadığı için eleme client tarafında yapılmak zorunda.

Tarihler **mutlak değil göreli** (`dayOffset`). Demo hangi gün çalışırsa çalışsın aynı
sayıları üretir.

### PROMPT

```text
Üç dilin de okuyacağı ortak mock veriyi fixtures/ altında kur. Rastgele veri
ÜRETME. Her kayıt bir kuralı öğretmek için var olsun ve fixtures/README.md içinde
hangi kaydın hangi dersi verdiğini tablo hâlinde yaz.

En az şunları kurgula:
  - Kapalı bir Task, durumu 'completed' DEĞİL 'approved' olsun. Naif bir filtre
    onu açık sansın.
  - Takvimde tam gün bir etkinlik, meşgul olmayan bir blok ve reddedilmiş bir
    toplantı olsun; üçü de farklı bir filtre kuralını tetiklesin.
  - İki toplantı ÇAKIŞSIN, böylece naif toplam ile birleştirilmiş meşgul süre
    farklı çıksın. İki sayıyı da raporla.
  - Bir toplantı timeIncrement'in katı OLMAYAN bir süre taşısın.
  - Bir effort class disabled olsun.

Tarihleri MUTLAK yazma: bugüne göre gün farkı (dayOffset) tut ve yükleme anında
materyalize et. Demo hangi gün çalıştırılırsa çalıştırılsın aynı sayıları üretmeli.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Gerçek hesaptan anonimleştir | Gerçekçi dağılım | Hesap yok; ayrıca veri bir dersi garanti etmez |
| Rastgele üret | Hızlı, çok kayıt | Beklenen sayılar sabitlenemez; hiçbir kayıt bir kural öğretmez |
| **Elle kurgula: her kayıt bir kural öğretsin** ✅ | Beklenen sayılar deterministik; her tuzak canlı gösterilebilir | Az sayıda kayıt; ölçek etkileri görünmez |

**Neden.** Sihirbazın her adımı fixture'lardan gelen **sabit sayılara** karşı doğrulanıyor
(3/3 açık iş, 8 ham etkinlik, 5 toplantı, 225 ve 255 dakika, `timeIncrement` 30).
Rastgele veriyle bu doğrulamaların hiçbiri yazılamazdı.

### ÜRETİLEN DOSYALAR

`fixtures/README.md` · `fixtures/requests.json` · `fixtures/tasks.json` ·
`fixtures/calendar.json` · `fixtures/timesheet-settings.json` ·
`fixtures/effort-classes.json` · `fixtures/time-allocations.json` · `scripts/gen-ics.mjs`

### DOĞRULAMA

```bash
node clients/wizard/wizard.mjs --server ts --step 09 --auto --json
```

Beklenen: `0 başarısız` — `rawCount 8`, `count 5`, `filteredOut 3`,
`busyMinutes 225`, `naiveSumMinutes 255`.

### TUZAK

İlk fixture'lar **mutlak tarih** taşıyordu ve "bugünün takvimi" ertesi gün boş döndü.
Tarihler `dayOffset`'e çevrildi. `.ics` ise formatı gereği mutlak `DTSTART` taşımak
zorunda olduğu için **türev dosya** yapıldı: kaynak `calendar.json`, `.ics` ondan
üretiliyor ve `.gitignore`'da.

### NE ÖĞRENDİK

- Test verisi bir yan ürün değil, bir **tasarım ürünüdür**. Her kaydın "hangi kuralı öğretiyorum" sorusuna cevabı olsun.
- Zamana bağlı fixture'ları göreli tut. Mutlak tarih taşıyan bir demo ertesi gün sessizce boş döner.
- Türetilebilir dosyayı kaynak sayma.

---
---

# FAZ 3 — Üç implementasyon

## 06 — Katmanlar: her katmanın NE BİLMEDİĞİ yazılır

**HEDEF.** İş mantığını protokolden ayırmak — bedeli bugün, karşılığı 10. adımda.

Sunucular dört katmana bölündü ve her katman için **neyi bilmediği** tarif edildi:

```
xurrent/   ← Xurrent GraphQL adapter'ı. MCP'yi BİLMEZ.
calendar/  ← takvim sağlayıcıları. MCP'yi ve Xurrent'ı BİLMEZ.
core/      ← 8 tool'un saf fonksiyon hâli. Protokolü BİLMEZ.
mcp/       ← protokol kabuğu. İş kuralı İÇERMEZ.
```

En keskin nokta onay akışında: `core` katmanındaki bir tool, kullanıcı onayı
gerektiğinde **`ConfirmationRequired`** döndürür — onayın *nasıl* sorulacağını bilmez.
Onayı protokole çevirmek `mcp/` katmanının işidir.

O sırada bu ayrımın **bedeli** belliydi (bir ara tip ve fazladan bir dolaylama),
**karşılığı** belli değildi. Karşılığını dördüncü fazda aldı.

### PROMPT

```text
Sunucuyu dört katmana böl ve her katmanın NE BİLMEDİĞİNİ açıkça yaz:

  xurrent/   — Xurrent GraphQL adapter'ı. MCP'yi BİLMEZ.
  calendar/  — takvim sağlayıcıları. MCP'yi ve Xurrent'ı BİLMEZ.
  core/      — 8 tool'un saf fonksiyon hâli: argüman girer, sonuç çıkar.
               Protokolü BİLMEZ.
  mcp/       — protokol kabuğu. İş kuralı İÇERMEZ.

Kritik kural: core katmanındaki bir tool, kullanıcı onayı gerektiğinde
'ConfirmationRequired' döndürsün — onayın NASIL sorulacağını BİLMESİN. Onayı
protokole çevirmek mcp/ katmanının işi.

Her katman için, o katmanın import etmesine İZİN VERİLEN modülleri listele.
Bu listeyi ihlal eden tek bir import bile yazma. Sonra kendi kodunu bu listeye
karşı denetle ve ihlalleri raporla.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Doğrudan SDK'nın tool handler'ı içine | En az dosya, en hızlı ilk sürüm | Protokol değişirse iş mantığı da taşınır |
| Tam hexagonal mimari | Teorik olarak en esnek | 8 tool'luk projede soyutlama maliyeti faydayı aşar ve dersi gizler |
| **Saf fonksiyon core + ince protokol kabuğu** ✅ | Kabuk değişir, core aynı kalır; test edilebilirlik bedava | Onay için bir ara tip gerekir |

**Neden.** Az soyutlama borç, çok soyutlama gürültüdür. Ortadaki seçenek her iki maliyeti
de sınırlı tutuyor: tek ara tip, tek dolaylama.

### ÜRETİLEN DOSYALAR

`servers/typescript/src/core/toolimpl.ts` · `servers/typescript/src/core/context.ts` ·
`servers/python/src/xurrent_mcp/core/toolimpl.py` · `servers/csharp/Core/ToolImpl.cs` ·
`servers/csharp/Core/Confirm.cs`

### DOĞRULAMA

```bash
(cd servers/typescript && npm run build) && echo "BUILD OK"
```

Beklenen: `BUILD OK`

### NE ÖĞRENDİK

- Katmanı "ne yapar" ile değil **"neyi bilmez"** ile tarif et. İkinci tarif ihlal edildiğinde gözden geçiren hemen görür.
- Protokole yakın kararları (onay, hata zarfı, oturum) iş mantığından ayrı tut. Protokoller iş kurallarından daha sık değişir.
- Soyutlama miktarını projenin boyutuna göre seç.

---

## 07 — Aynı sözleşme, üç dil

**HEDEF.** Tezi kanıtlamak: *MCP bir protokoldür, dil bir detaydır.*

TypeScript, Python ve C# sunucuları aynı `contract/tools.json` dosyasından **paralel**
üretildi. Hiçbiri diğerinin kodunu okumadı; ortak referans yalnızca sözleşme ve
`fixtures/` klasörüydü.

Beklenmedik kazanç: sözleşmeyi **üçüncü kez** uygulamak, ilk iki implementasyonun sessiz
varsayımlarını ortaya çıkardı. Bir alan adı Python'da `snake_case`'e kayma eğilimi
gösteriyorsa, sözleşme o alanı yeterince açık tarif etmemiş demektir.

> Üretim için doğru cevap bu değildir: bir dil seç, iyi yaz. Üç dil **dersin tezi**
> olduğu için var.

### PROMPT

```text
contract/tools.json dosyasını oku. Bu dosya TEK GERÇEK KAYNAKTIR.

Şimdi Python'da bir MCP sunucusu yaz. Kurallar:
  - Tool adları, parametre adları ve çıktı ALAN ADLARI sözleşmedekiyle BİREBİR
    aynı olacak. Python alışkanlığı diye snake_case'e çevirme — bunlar wire
    formatıdır, iç değişken adı değil.
  - tools/list sırası sözleşmedeki sıra olacak.
  - Her tool outputSchema BİLDİRECEK ve tools/call cevabında structuredContent
    ÜRETECEK. Yanında insan-okunur bir text bloğu da olacak.
  - Mock veri fixtures/ klasöründen okunacak; oradaki JSON'ları DEĞİŞTİRME.
  - Yorumlar Türkçe, tanımlayıcılar İngilizce.

Bitirince şunu çalıştır ve çıktısını olduğu gibi raporla:
  node scripts/verify-contract.mjs --server py

Fark çıkarsa sözleşmeyi değil kodunu düzelt. Sözleşme yanlışsa, önce nedenini
yaz ve onay iste.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Tek dil, iyi yazılmış | Üretim için doğru cevap | Tez iddia olarak kalır, kanıtlanmaz |
| Üç dil sırayla (biri referans) | İkinci ve üçüncü dil hazır referanstan gider | Referansın varsayımları sorgusuz kopyalanır |
| **Üç dil paralel, hepsi aynı sözleşmeden** ✅ | Tez canlı kanıtlanır; sözleşme üç kez sınanır | Üç ekosistem, üç build zinciri |

### ÜRETİLEN DOSYALAR

`servers/typescript/src/tools/*.ts` · `servers/python/src/xurrent_mcp/tools/*.py` ·
`servers/csharp/Core/ToolImpl.cs` · `servers/csharp/Mcp/McpTools.cs`

### DOĞRULAMA

```bash
node scripts/verify-contract.mjs --all
```

Beklenen: `Aynı tool adları, aynı parametreler, aynı annotation'lar.`

### TUZAK

Bir alan adı bir dilde idioma kayarsa, hata o dilde değil **sözleşmededir**: o alan
yeterince açık tarif edilmemiştir. Düzeltmeyi koda değil, **önce sözleşmeye** uygula.

### NE ÖĞRENDİK

- Aynı sözleşmeyi ikinci kez uygulamak, sözleşmeyi gözden geçirmenin en ucuz yoludur.
- Wire formatındaki adları dilin idiomuna çevirme. *"Bizde böyle yazılır"* alışkanlığı sözleşmeyi sessizce bozan en yaygın nedendir.
- Ders için doğru olan üretim için doğru olmayabilir; hangi amaç için optimize ettiğini açıkça söyle.

---

## 08 — Dry-run tek katman değil

**HEDEF.** Yazma yolunu üç ayrı tehdit modeline karşı üç ayrı katmanla korumak.

Xurrent bir *system of record*'dur; yanlış yazılan bir zaman girişi faturalamaya kadar gider.

| Katman | Ne yapar | Hangi tehdide karşı |
|---|---|---|
| `dryRun` tool parametresi | Hiçbir mutation HTTP'ye çıkmaz; plan + uyarılar döner | Model veya kullanıcı **hata yapar** |
| `XURRENT_DRY_RUN` ortam değişkeni | Tool parametresini **ezer** | Model **kandırılır** (prompt injection) |
| `plan_time_entries_from_calendar` | **Yapısal olarak** yazamaz; içinde mutation yolu yok | İkna edilecek bir şey yok |

Onay ise bilinçli olarak LLM'e bırakılmadı: **LLM ikna edilebilir; protokol seviyesindeki
onay edilemez.**

### PROMPT

```text
Yazma tool'ları için üç ayrı savunma katmanı kur ve her birinin HANGİ tehdide
karşı olduğunu açıkça yaz:

  1. dryRun tool parametresi — hiçbir mutation gönderilmez; gönderilecek GraphQL
     metni, değişkenler ve uyarılar döner.
  2. XURRENT_DRY_RUN ortam değişkeni — tool parametresini EZER.
  3. Takvimden plan üreten tool'u YAPISAL olarak yazamaz yap: readOnlyHint true
     olsun ve içinde hiçbir mutation yolu BULUNMASIN.

Sonra şu soruyu cevapla: 1. katman varken 2. katman neden gerekli?
Cevabında 'model hata yapar' ile 'model kandırılır' tehdit modellerini AYIR ve
her katmanın hangisini kapattığını söyle.

Son olarak: kullanıcı onayını LLM'e mi sorduracağız, protokole mi? Gerekçesini yaz.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Sistem promptuna kural olarak yaz | Sıfır kod | LLM ikna edilebilir; injection tam bu katmanı hedefler |
| Tek `dryRun` parametresi yeterli | Basit, tool yüzeyinde görünür | Değerini model belirler |
| **Üç katman** ✅ | Farklı tehditlere farklı katman; en dıştakine model erişemez | Üç yerde tutarlılık, üç dilde aynı davranış |

### ÜRETİLEN DOSYALAR

`servers/typescript/src/tools/plan-from-calendar.ts` ·
`servers/typescript/src/core/context.ts` ·
`servers/python/src/xurrent_mcp/tools/write_tools.py` · `servers/csharp/Mcp/McpTools.cs`

### DOĞRULAMA

```bash
node clients/wizard/wizard.mjs --server ts --step 10 --auto --json
```

Beklenen: `0 başarısız` — 5 öneri üretildi ve **hiçbiri yazılmadı**.

### NE ÖĞRENDİK

- Bir güvenlik katmanının değeri, **modelin ona erişip erişemediğiyle** ölçülür.
- "Hata" ve "kötüye kullanım" iki ayrı tehdit modelidir ve ayrı katman ister.
- En güçlü kısıt, **yapısal olarak imkânsız** olandır.

---

## 09 — Sihirbaz: içerik veride, yürütme kodda

**HEDEF.** Ders akışını koddan ayırmak — kanıtın kendisi bu ayrıma bağlı.

Sihirbaz bir **MCP client**'tır; `--server ts|py|cs` ile hangi sunucuya bağlanacağı
seçilir. Ders içeriğinin hiçbir parçası client'ta gömülü değildir: 14 adım, anlatım
metinleri ve beklenen sayılar [`docs/wizard/steps.json`](wizard/steps.json)'dan gelir.

Bu ayrım kozmetik değil: ders metni client'a gömülü olsaydı *"aynı ders üç sunucuda
aynı sonucu verir"* kanıtı değersiz olurdu — üçünü de aynı gömülü metin anlatıyor olurdu.

Sonuç modeli üç durumludur: **PASS · FAIL · SKIP**. `SKIP`'in tanımı bilinçli olarak
dardır — *"çalıştı ama tutmadı"* asla `SKIP` olamaz, yoksa sihirbaz kendi hatalarını
kendi affeder.

### PROMPT

```text
Dersi yürüten bir MCP CLIENT yaz. Ders İÇERİĞİNİN hiçbir parçası client'ta
gömülü OLMAYACAK: adımlar, anlatım metni ve beklenen sayılar
docs/wizard/steps.json dosyasından gelecek. Client yalnızca şu döngüyü yürütür:
bağlan → anlat → GERÇEK tool çağrısı yap → beklenenle karşılaştır → yorumla.

--server ts|py|cs ile hangi sunucuya bağlanacağı seçilebilsin. Hiçbir çıktı
önceden yazılmasın; hepsi canlı üretilsin.

Sonuç modeli ÜÇ DURUMLU olsun:
  PASS  kontrol çalıştı ve tuttu
  FAIL  kontrol çalıştı ve TUTMADI
  SKIP  kontrol ÇALIŞTIRILAMADI (ön koşul yok)
'Çalıştı ama tutmadı' ASLA SKIP olamaz. Çıkış kodunu yalnızca FAIL etkiler.

Ayrıca steps.json için bir JSON Schema ve onu doğrulayan bağımsız bir script yaz.
Script'in npm bağımlılığı OLMASIN. Şema additionalProperties: false olsun ve
nedenini bir yorum satırında açıkla.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Koşucunun içine gömülü | Tek dosya | Kanıt değersizleşir — üçünü de aynı gömülü metin anlatır |
| Markdown olarak yaz | En okunur | Yürütülemez; beklenen sayılar doğrulanmaz ve bayatlar |
| **Şemalı JSON veri + bağımsız koşucu** ✅ | İçerik ile yürütme ayrılır; şema ihlali CI'da yakalanır | Bir şema ve bir doğrulayıcı daha |

### ÜRETİLEN DOSYALAR

`docs/wizard/steps.json` · `docs/wizard/steps.schema.json` · `clients/wizard/wizard.mjs` ·
`scripts/validate-steps.mjs` · `scripts/lib/mini-jsonschema.mjs`

### DOĞRULAMA

```bash
node scripts/validate-steps.mjs
```

Beklenen: `steps.json ŞEMAYA UYGUN`

### NE ÖĞRENDİK

- İçeriği yürütücüden ayır. Bir demo, içeriği gömülü olduğu sürece yalnızca kendini kanıtlar.
- `SKIP`'in tanımını dar tut. *"Çalıştı ama tutmadı"* `SKIP` sayılırsa doğrulama kendi hatalarını affeder.
- `additionalProperties: false` katı görünür ama asıl işlevi başkadır: koşucunun tanımadığı bir anahtar **sessizce yok sayılır**, yani hiç çalışmayan bir bölüm doğar.

---
---

# FAZ 4 — Spec iş ortasında değişti

## 10 — ★ 28 Temmuz 2026: MCP tam olarak bizim onay akışımızı kaldırdı

**HEDEF.** Bir breaking change'in iyi katmanlanmış bir projeye kaça mal olduğunu ölçmek.

Proje yarıdayken MCP `2026-07-28` revizyonunu yayınladı — lansmandan bu yana en büyüğü.
Kaldırdığı şey **tam olarak bizim onay akışımızdı**.

| | `2025-11-25` (v1) | `2026-07-28` (v2) |
|---|---|---|
| Bağlantı | `initialize` el sıkışması | **yok** — stateless |
| Keşif | `initialize` sonucu | **`server/discover`** (zorunlu) |
| Kullanıcıya soru | sunucu **isteği** (`elicitation/create`) | sunucu **sonucu** (`InputRequiredResult`) + MRTR |
| Sunucu state'i | bellekte | imzalı `requestState` içinde, client'ta taşınır |

Kritik olan: **`contract/tools.json` hiç değişmedi.** Aynı sekiz tool, aynı parametreler,
aynı çıktı alanları, aynı sayılar. Değişen tek şey onayın sorulma biçimiydi.

### PROMPT

```text
MCP'nin 2026-07-28 revizyonunu oku ve şu soruya cevap ver:

Bizim onay akışımız (sunucu, işlemin ortasında client'a elicitation/create İSTEĞİ
gönderiyor) bu revizyonda hâlâ var mı?

Yoksa: yerine ne geldi? Yeni akışı JSON-RPC mesaj mesaj yaz — hangi mesaj kimden
kime gidiyor, id'ler ne oluyor, sunucu iki istek arasında ne hatırlıyor?

Sonra şunu değerlendir: bu değişiklik contract/tools.json dosyasındaki 8 tool'un
adlarını, parametrelerini veya çıktı alanlarını etkiliyor mu? Etkilemiyorsa,
değişikliğin bize maliyeti TAM OLARAK hangi dosyalarda? Dosya listesi ver.

Son olarak: her iki revizyonda da AYNI tool'u çağırıp çıktıların birebir aynı
olduğunu kanıtlayan bir script yaz.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Görmezden gel, eski revizyonda kal | Sıfır iş | Ders materyali yayınlandığı gün eskimiş olur |
| Tamamen v2'ye geç, v1'i sil | Tek kod yolu | Yaygın v1 istemciler dışarıda kalır; geçiş ders konusu olmaktan çıkar |
| **İkisini birden destekle ve farkı ders konusu yap** ✅ | Breaking change canlı gösterilebilir | İki adaptör, iki test yolu |

### ÜRETİLEN DOSYALAR

`contract/protocol.md` · `servers/typescript/src/mcp/v1/server.ts` ·
`servers/typescript/src/mcp/v2/server.ts` · `servers/typescript/src/mcp/protocols.ts` ·
`servers/python/src/xurrent_mcp/mcp/v1.py` · `servers/python/src/xurrent_mcp/mcp/v2.py` ·
`servers/csharp/Mcp/ServerSetup.cs`

### DOĞRULAMA

```bash
node servers/typescript/scripts/probe-protocols.mjs
```

Beklenen: `Sekiz tool'un tamamı iki protokolde AYNI structuredContent'i üretti.`

### NE ÖĞRENDİK

- Protokol revizyonu tool sözleşmeni **bozmamalı**. Bozuyorsa, iş mantığın protokole sızmış demektir.
- Bir breaking change'in maliyetini tahmin etme; **hangi dosyaların değiştiğini say**.
- Bağımlılığın spec'i değişirse bu bir kriz değil, mimarinin ücretsiz testidir.

---

## 11 — ★★ Plan üç projeye bölmekti. Ölçtük; gereksizmiş.

**HEDEF.** Mimari kararı varsayımla değil ölçümle vermek.

İlk plan şuydu: *"her dilde iki SDK sürümü yan yana kurulmalı; C#'ta paket ID aynı
olduğu için `Core` + `V1` + `V2` diye üç ayrı proje gerekir."*

Bu plan **uygulanmadı**. Önce ölçüldü: her sunucu alt süreç olarak başlatıldı ve SDK
client'ı araya girmeden ham JSON-RPC yazıldı.

| Sunucu | `server/discover` (`_meta` ile) | `initialize` | Sonuç |
|---|---|---|---|
| TypeScript — `@modelcontextprotocol/sdk` `1.30.0` | `-32601 Method not found` | ✅ `2025-11-25` | **yalnızca v1** |
| Python — `mcp` `2.0.0` | ✅ `supportedVersions: ["2026-07-28"]` | ✅ | **ikisi de** |
| C# — `ModelContextProtocol` `2.0.0` | ✅ `supportedVersions: ["2026-07-28"]` | ✅ | **ikisi de** |

Resmî SDK 2.0.0'lar geriye dönük uyumluluğu **kendileri taşıyor**. Üç projeye bölmek
gereksizdi; elle çift adaptör yalnızca eski SDK kuşağında kalan TypeScript için gerekti.

> Ölçmeseydik ne olurdu? Gereksiz karmaşıklığı *"breaking change'in maliyeti"* diye
> öğretecektik — oysa o maliyeti SDK zaten ödemişti.

### PROMPT

```text
Plan şuydu: 'iki protokol revizyonunu desteklemek için her dilde iki SDK sürümü
yan yana kurulmalı; C#'ta paket ID aynı olduğu için Core + V1 + V2 diye üç ayrı
proje gerekir.'

BUNU UYGULAMA. Önce ÖLÇ.

Her sunucuyu alt süreç olarak başlat ve HAM JSON-RPC yaz (SDK client kullanma):
  1) server/discover — zorunlu _meta ile:
       io.modelcontextprotocol/protocolVersion
       io.modelcontextprotocol/clientCapabilities
       io.modelcontextprotocol/clientInfo
  2) initialize — protocolVersion 2025-11-25 ile

Her sunucu için sonucu tablo yap: hangi RPC kabul edildi, hangi hata kodu döndü,
supportedVersions ne geldi.

Sonra cevapla: hangi dilde GERÇEKTEN iki ayrı adaptör gerekiyor? Cevabını ölçüm
tablosuna dayandır ve planın hangi kısmının yanlış olduğunu açıkça yaz.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| C# için `Core` + `V1` + `V2` üç proje | Sürüm çakışması kesin çözülür | Üç csproj, üç build — hepsi ölçülmemiş bir varsayıma dayanıyor |
| Her dilde iki SDK yan yana | Simetrik çözüm | Python ve C#'ta paket adı aynı; tek ortamda mümkün değil |
| **Önce ölç: hangi SDK zaten ikisini konuşuyor?** ✅ | Gereksiz karmaşıklık hiç yazılmaz | Ham JSON-RPC sondası yazmak gerekir |

### ÜRETİLEN DOSYALAR

`contract/protocol.md` · `docs/09-protokol-gecisi.md` ·
`servers/typescript/scripts/probe-protocols.mjs`

### DOĞRULAMA

```bash
node scripts/verify-contract.mjs --server py
```

Beklenen: `Uyumluluk sondası: server/discover kabul edildi → v2`

### TUZAK

Ölçüm için yazılan **sondanın kendisi önce yanlış yazıldı** ve aynı yanlış teşhisi başka
bir yerden üretti — bir sonraki adımın konusu tam olarak bu.

### NE ÖĞRENDİK

- **Mimari kararı ölçmeden verme.** *"Şu gerekir"* cümlesinin arkasında bir ölçüm yoksa, o cümle bir varsayımdır.
- Bir bağımlılığın ne yaptığını dokümanından değil **davranışından** öğren. Ham protokolle bir sonda yazmak çoğu zaman bir günden kısa sürer.
- Bir öğretim materyalinde yanlış mimari, **yanlış dersi** öğretir.

---

## 12 — Stateless olmak, state'i saldırgana emanet etmek demek

**HEDEF.** `requestState`'i bir güvenlik sınırı olarak tasarlamak ve bunu kanıtlamak.

v2'de sunucu stateless olduğu için onay bilgisi — *"kullanıcı, Request #70248'e 120
dakika yazmayı onayladı"* — `requestState` adında bir blob içinde **client'a verilip geri
alınıyor**. Spec bunu açıkça *saldırgan kontrolündeki girdi* sayıyor.

Blob HMAC-SHA256 ile imzalanıyor ve payload'a dört şey gömülüyor:

| Alan | Kapattığı saldırı |
|---|---|
| `principal` | Başka kullanıcının onayını kullanmak |
| `exp` (varsayılan 300 sn) | Süresi dolmuş onayı sonra oynatmak |
| `fingerprint` (metot + argüman özeti) | Bir çağrının onayını başka çağrıya iliştirmek |
| `nonce` (tek kullanımlık) | Aynı onayı tekrar tekrar oynatmak |

Kanıt tahmine bırakılmadı: `probe-request-state.mjs` altı senaryoyu ham JSON-RPC ile sürüyor.

### PROMPT

```text
Yeni revizyonda sunucu stateless. Onay akışında sunucunun hatırlaması gereken şey
("kullanıcı, Request #70248'e 120 dakika yazmayı onayladı") requestState adında
bir blob içinde CLIENT'A verilip geri alınıyor.

Spec bunu açıkça 'saldırgan kontrolündeki girdi' sayıyor. Buna göre requestState'i
tasarla ve şu altı senaryoyu geçen bir sonda script'i yaz (ham JSON-RPC ile,
SDK client kullanmadan):
  1) onaysız çağrı            → InputRequiredResult + imzalı state döner
  2) imza kurcalanmış         → REDDEDİLMELİ
  3) argümanlar değiştirilmiş → REDDEDİLMELİ
  4) geçerli state + onay     → yazılmalı
  5) AYNI state tekrar        → REDDEDİLMELİ
  6) kullanıcı reddetti       → yazılmamalı

3. ve 5. senaryonun geçmesi için state'in içine ne gömmen gerektiğini KENDİN
çıkar ve gerekçesini yaz. Ayrıca hangi saldırının bu önlemlerle KAPANMADIĞINI
da söyle.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Düz JSON olarak ver ve geri al | En basit; gerçekten stateless | Client blob'u değiştirip başka ticket'a yazdırabilir |
| Sunucuda bellekte tut, anahtar ver | İçerik hiç dışarı çıkmaz | Sunucu tekrar stateful olur — v2'nin kaldırdığı şey tam bu |
| **İmzala ve client'ta taşı** ✅ | Stateless kalır, içerik korunur; TTL + fingerprint kapsamı daraltır | Anahtar yönetimi; süreç yeniden başlayınca eski state'ler geçersiz |

### ÜRETİLEN DOSYALAR

`servers/typescript/src/core/confirm.ts` · `servers/python/src/xurrent_mcp/core/confirm.py` ·
`servers/csharp/Core/Confirm.cs` · `servers/typescript/scripts/probe-request-state.mjs`

### DOĞRULAMA

```bash
node servers/typescript/scripts/probe-request-state.mjs
```

Beklenen: `requestState ZATEN KULLANILMIŞ (tek kullanımlıktır) — tekrar oynatma reddedildi.`

### TUZAK

Nonce seti **süreç içidir**. Tek süreçli stdio'da yeterli, yatay ölçekte replay penceresi
açık kalır. Bu bilinçli olarak kapsam dışı bırakıldı ve `docs/08`'de yazıldı — **kapsam
dışı bırakmak fark etmemekten farklıdır, ama yalnızca yazıya dökülürse.**

### NE ÖĞRENDİK

- Sunucu state'ini client'a verdiğin her yerde bir **güven sınırı** geçmiş olursun. İmzasız hiçbir şey geri kabul edilmez.
- İmza tek başına yetmez: **neyi imzaladığını da bağla**. `fingerprint` olmadan geçerli bir onay başka çağrıya iliştirilebilir.
- Güvenlik iddialarını **senaryo olarak yaz ve çalıştır**. *"İmzalıyoruz"* bir cümledir; tekrar oynatmanın reddedildiğini gösteren bir koşu delildir.

---
---

# FAZ 5 — Kusur avı ve live yolu

## 13 — ★ Aynı hata kodu, iki farklı sebep

**HEDEF.** Kendi istemci hatasını karşı tarafın eksikliği sanmayı önlemek.

Sihirbaz uzun süre *"bu sunucu yeni revizyonu konuşmuyor"* dedi. **Sunucu konuşuyordu.**

Sebep: uyumluluk sondası `server/discover`'ı zorunlu `_meta` bloğu **olmadan**
gönderiyordu.

| Sunucu | `_meta` yokken dönen hata | Yorumu |
|---|---|---|
| Python | `-32601 Method not found` | Gerçek bir v1 sunucuyla **birebir aynı kod** |
| C# | `-32602` + *"requires per-request metadata…"* | Açıkça "sondan hatalı" der |

İki kodu ayırmayan bir sonda, v2 konuşan bir sunucuyu ömür boyu v1 sanar.

Düzeltme iki parçalıydı: sondaya üç zorunlu `_meta` anahtarı eklendi, ve `-32602` /
`-32021` alındığında **v1'e düşülmemesi** kuralı kondu.

İkinci ayrıntı: sonda **ayrı ve kısa ömürlü bir süreçte** çalışır. Bir bağlantıda
`initialize` yapıldıktan sonra aynı bağlantıya v2 zarflı istek göndermek reddediliyor —
bu da ölçülmüş bir gerçek, tahmin değil.

### PROMPT

```text
Sihirbaz 'sunucu yeni protokol revizyonunu konuşmuyor' diyor ama sunucu
konuşuyor. Teşhis et.

İpucu: uyumluluk sondası server/discover gönderiyor. Şu üç hata kodunu
BİRBİRİNDEN AYIR ve her biri için sihirbazın ne yapması gerektiğini yaz:
  -32601  Method not found
  -32602  Invalid params
  -32022  Unsupported protocol version

Sonra sondayı düzelt ve şunu ekle: hangi durumda v1'e DÜŞÜLMEZ, aksine net bir
İSTEMCİ hatası verilip durulur?

Son olarak: aynı bağlantı üzerinde önce initialize yapıp sonra v2 zarflı bir istek
göndermeyi dene ve ne olduğunu raporla. Sondanın nerede çalışması gerektiğine bu
sonuca göre karar ver.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| `-32602`'yi `-32601` ile aynı say, v1'e düş | Tek kod yolu; akış hiç durmaz | İstemci kendi hatasını sunucunun eksikliği sanar |
| **İkisini ayır: `-32601` → v1'e düş, `-32602` → dur ve hata ver** ✅ | Yanlış teşhis imkânsızlaşır | Sonda bazı durumlarda akışı durdurur |

**Neden.** Akışın durması burada bir maliyet değil, **doğru davranıştır**: teşhis
edilemeyen bir durum sessizce varsayılana düşmemelidir.

### ÜRETİLEN DOSYALAR

`clients/wizard/wizard.mjs` · `scripts/verify-contract.mjs`

### DOĞRULAMA

```bash
node clients/wizard/wizard.mjs --server ts --auto --json
```

Beklenen: `0 başarısız` — sonda `server/discover kabul edildi` der ve konuşulan
protokolü açıkça yazar.

### NE ÖĞRENDİK

- Bir uyumluluk sondası yazarken *"karşı taraf desteklemiyor"* ile *"ben yanlış sordum"* durumlarını **ilk günden** ayır.
- Aynı hata koduna iki farklı sebep düşebiliyorsa, teşhisi koda değil **sebebe** bağla.
- Hata kodlarını **isimle** karşılaştır, sayıyla değil. Bu revizyon `-32004`'ü `-32022`'ye taşıdı.
- Teşhis edilemeyen bir durumda **varsayılana düşme**.

---

## 14 — ★ Doğrulayıcı yeşildi — çünkü yanlış şeyi ölçüyordu

**HEDEF.** Ajan raporlarını delil saymamak; doğrulayıcının kör noktasını bulmak.

Üç sunucuyu üreten ajanlar *"tamamlandı"* dedi ve `verify-contract.mjs` üçünü de uyumlu
buldu. **İki gerçek parite kırığı bu yeşil tikin arkasında saklıydı.**

**Kırık 1 — `outputSchema` yok.** Python ve C# hiçbir tool'da `outputSchema`
bildirmiyordu (**0/8**). Dolayısıyla `tools/call` cevabında `structuredContent`
üretmiyorlardı ve çağıran taraf JSON'ı metinden ayrıştırmak zorunda kalıyordu.
Doğrulayıcı bunu kaçırmıştı çünkü yalnızca tool adlarını, parametreleri ve
`annotations`'ı karşılaştırıyordu — yani sözleşmenin **sadece girdi tarafını**.

**Kırık 2 — onay davranışı.** `XURRENT_CONFIRM_POLICY=closed` ve mock modda TypeScript
ile Python onay soruyordu, **C# sormadan yazıyordu**. C#, ortak K5 kuralını yanlış
yorumlamıştı: *"client onay SORAMIYORSA mock'ta engelleme"* kuralını *"mock'ta hiç
sorma"*ya çevirmişti.

Doğrulayıcı genişletildi ve şunlar eklendi: her tool `outputSchema` bildiriyor mu, üst
seviye alanlar sözleşmeyle örtüşüyor mu, gerçek bir `tools/call`'da `structuredContent`
dolu geliyor mu, yanında insan-okunur bir text bloğu var mı, `tools/list` sırası kanonik mi.

> Bir tool sözleşmesi çağıranın ne göndereceği kadar **ne alacağını** da tarif eder.
> Yoksa *"üç dil aynı çıktıyı üretir"* ölçülemez bir slogandır.

### PROMPT

```text
scripts/verify-contract.mjs şu anda üç sunucuyu da 'uyumlu' diyor.
BU DOĞRULAYICIYA GÜVENME. Neyi ÖLÇMEDİĞİNİ bul.

Şunları tek tek kontrol et ve eksik olanları doğrulayıcıya EKLE:
  - Her tool outputSchema BİLDİRİYOR mu?
  - outputSchema'nın üst seviye alanları contract/tools.json'daki output ile
    örtüşüyor mu ($ref'ler çözülerek)?
  - GERÇEK bir tools/call çağrısında structuredContent DOLU geliyor mu?
  - structuredContent'in yanında insan-okunur bir text bloğu var mı?
  - tools/list sırası sözleşmedeki sıra mı? v2'de ttlMs ve cacheScope var mı?

Sonra ŞEKİL değil DAVRANIŞ paritesini ölç: XURRENT_CONFIRM_POLICY=closed ve mock
modda üç sunucu da AYNI şeyi mi yapıyor? Onay kanalı YOKSA ne oluyor? Üçünün
davranışını yan yana tablo yap ve farkı bul.

Ajanların 'tamamlandı' raporlarını delil sayma; her iddiayı kendin çalıştır.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Rapora güven | En hızlı | *"Çalıştı"* bir delil değil bir iddiadır; iki gerçek kırık buradan geçti |
| Kodu elle gözden geçir | Bağımsız, araçsız | Ölçek büyüdükçe kaçırır; nitekim kaçırdı |
| **Doğrulayıcıyı genişlet ve tekrar ölç** ✅ | Aynı kusur bir daha kaçmaz; kontrol CI'da kalıcı | Doğrulayıcının kendisi bakım isteyen bir kod |

### ÜRETİLEN DOSYALAR

`scripts/verify-contract.mjs` · `servers/python/src/xurrent_mcp/core/schemas.py` ·
`servers/csharp/Core/ToolContracts.cs` · `servers/typescript/src/core/context.ts` ·
`servers/csharp/Mcp/McpTools.cs` · `servers/csharp/Wizard.cs`

### DOĞRULAMA

```bash
node scripts/verify-contract.mjs --all
```

Beklenen: `outputSchema: 8/8 tool bildiriyor`

### TUZAK

C#'ın onay davranışı hizalandığında **ikinci bir kırık** ortaya çıktı: C#'ın kendi
iç-süreç sihirbazında `OnConfirm` hiç bağlanmamıştı, yani onay hiç sorulamıyordu.
**Bir düzeltme, altındaki ikinci kusuru görünür yapabilir; ilk düzeltmeden sonra tekrar
ölçmeden bitirme.**

### NE ÖĞRENDİK

- *"Çalıştı"* raporu delil değildir. Bir ajanın çıktısını kabul etmeden önce, iddiayı bağımsız ölçen bir komut çalıştır.
- Doğrulayıcının **kör noktasını** periyodik olarak sorgula: yeşil bir kontrolün ne ölçtüğü kadar **ne ölçmediği** de bilinmelidir.
- **Parite şekil değil davranıştır.** Aynı tool adlarını sunan iki sunucu, aynı girdiye farklı yanıt veriyorsa parite yoktur.
- Ortak bir kuralı üç yerde uyguluyorsan, kuralın metnini **tek yerde** yaz ve her implementasyonun ona atıf yapmasını iste.

---

## 15 — ★ Hesap yoksa live yolu nasıl test edilir?

**HEDEF.** Hiç çalıştırılmamış bir kod yolunu, hesap satın almadan wire seviyesinde sürmek.

`XURRENT_MODE=live` kod yolu bir kez bile çalıştırılmamıştı. Xurrent ücretsiz değil:
freemium katmanı yok, self-servis deneme yok, sandbox satış üzerinden talep ediliyor.

Çözüm sahte **veri** değil sahte **DAVRANIŞ** oldu.
[`tools/fake-xurrent`](../tools/fake-xurrent/README.md) gerçek şemanın şeklini ve
davranışını taklit eden yerel bir GraphQL ucu:

| Kısıt | Davranış |
|---|---|
| `Authorization` yok | **401** |
| `X-Xurrent-Account` yok | **400** |
| Validation hatası | **HTTP 200** + `errors` dolu + `timeEntry: null` |
| `timeSpent` `timeIncrement` katı değil | reddedilir |
| Günlük 480 dk aşımı (`allowWorkdayOvertime: false`) | reddedilir |
| İstek başına >1 mutation | reddedilir |
| 20 istek / 2 saniye aşımı | **429** + `retry-after` |
| `timeEntryCreate` ile oluşan kayıt | `assignment` **her zaman null** |
| `timeEntryUpdate` | `assignment`'a **dokunmaz** |

`XURRENT_GRAPHQL_URL` zaten yapılandırılabilir olduğu için üç sunucunun live yolu
**tek satır kod değişmeden** bu uca bağlandı. Veri kaynağı da `fixtures/` — yani `mock`
ile `live`-sahte aynı sayıları üretiyor.

Sonuç: **üç dil × yedi senaryo = 21 kontrol, hepsi geçti.** Ve gerçek bir hata çıktı:

> C# live adapter'ı günlük mesai tavanı için **her bulk kaydından önce** ayrı bir
> `LoggedMinutes` sorgusu atıyordu. Kayıt başına iki istek demek bu; 8 kayıtlık bir bulk
> 20/2sn sınırını aşıp **429** alıyordu. TypeScript ve Python kayıt başına tek istek
> attığı için altında kalıyordu. **Mock modda görünmüyordu, çünkü mock'ta HTTP yok.**

Düzeltme: baseline gün başına bir kez sorulur, kendi yazdıkların yerel sayılır.
8 kayıt için `LoggedMinutes` **8 kez değil 1 kez** gidiyor.

### PROMPT

```text
XURRENT_MODE=live kod yolu bugüne kadar bir kez bile çalıştırılmadı: ürün ücretsiz
değil, self-servis deneme yok.

Yerel bir sahte GraphQL ucu yaz. Amaç sahte VERİ değil, sahte DAVRANIŞ:
  - Authorization yoksa 401; hesap header'ı yoksa 400
  - Validation hatası → HTTP 200 + errors DOLU + timeEntry null
  - timeSpent timeIncrement'in katı değilse reddet
  - allowWorkdayOvertime false iken günlük dakika tavanı aşımını reddet
  - istek başına birden fazla mutation'ı reddet
  - 20 istek / 2 saniye aşımında 429 + retry-after
  - timeEntryCreate ile oluşan kaydın assignment'ı HER ZAMAN null
  - requestUpdate/taskUpdate'te timeSpent ARTIMLI, date = bugün
  - timeEntryUpdate assignment'a DOKUNMAZ

Veri kaynağı fixtures/ olsun ki mock ile live-sahte AYNI sayıları üretsin.
Sunucuların kaynak kodunda TEK SATIR değişiklik YAPMA.

Sonra üç dili de bu uca karşı live modda çalıştıran bir senaryo koşucusu yaz.
README'nin İLK paragrafında bu aracın neyi KANITLAMADIĞINI yaz.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Olduğu gibi bırak, "test edilmedi" yaz | Dürüst; sıfır iş | Wire seviyesindeki hatalar yayında kalır |
| Sandbox hesabı talep et ve bekle | Gerçek şemaya karşı doğrulama — tek gerçek kanıt | Ders takvimine sığmaz; repoyu klonlayan kimse tekrarlayamaz |
| **Davranışı taklit eden yerel sunucu** ✅ | Live kod yolu sürülür; herkes tek komutla tekrarlar | Şema doğruluğunu **kanıtlamaz**; bu sınır en görünür yerde yazılmalı |

### ÜRETİLEN DOSYALAR

`tools/fake-xurrent/server.mjs` · `tools/fake-xurrent/senaryolar.mjs` ·
`tools/fake-xurrent/README.md` · `servers/csharp/Xurrent/LiveAdapter.cs`

### DOĞRULAMA

```bash
node tools/fake-xurrent/senaryolar.mjs --dil ts
```

Beklenen: `7 geçti · 0 başarısız`. Üç dil için: `node tools/fake-xurrent/senaryolar.mjs`

### TUZAK

**İki yanlış alarm yaşandı ve ikisi de koda dokunulmadan önce çözüldü:**

1. İlk koşuda C# iki senaryoda düştü; izole çalıştırınca ikisini de geçti. Sebep: üç dil
   aynı sahte sunucu örneğine yazıyordu ve günlük 480 dakika tavanı doluyordu — sırf
   sırada sonda olduğu için başarısız görünen bir dil. Çözüm: her dil için taze sunucu.
2. Sonra bulk senaryosu yine düştü; sebep sahte sunucunun `timeEntries` sorgusunda `date`
   filtresini yok saymasıydı.

İkisinde de **bozuk olan testti, kod değil.**

### NE ÖĞRENDİK

- **Yapılandırılabilir bir uç adresi**, test edilemez bir kod yolunu test edilebilir yapar. Bu tek satırlık tasarım kararı sonradan gerçek bir hata buldurdu.
- Sahte bir sunucunun değeri sahte veride değil, **zorladığı kısıtlarda**.
- **Kırmızı bir test önce kendini suçlamalı.**
- Bir test aracının **ne kanıtlamadığını** da yaz. Sınırı yazılmayan bir araç, zamanla bir garanti gibi okunur.

---
---

# FAZ 6 — Yayın

## 16 — Mantıksal commit'ler ve neyin doğrulanmadığını yazma disiplini

**HEDEF.** Yayın öncesi taramayı bir kontrol listesine bağlamak; geçmişi okunur bırakmak.

Repo public yayınlanmadan önce tarandı: `.env` commit edilmiş mi (hayır, `.gitignore`'da),
kaynak ağacında gerçek token kalıbı var mı (yok), build çıktıları commit'lenmiş mi (hayır),
mutlak yol sızıntısı var mı (yok), lisans README ile tutarlı mı (MIT, evet).

Değişiklikler **dosya başına değil mantıksal** olarak bölündü. İlk yayın **dört commit**'ti:

1. Ortak tool sözleşmesi, fixture'lar ve proje iskeleti
2. TypeScript, Python ve C# MCP sunucuları
3. Sihirbaz istemcisi, ortak web arayüzü ve doğrulama script'leri
4. Türkçe ders notları, demo senaryosu ve sunum sayfası

Sahte Xurrent sunucusu sonradan **beşinci commit** olarak eklendi — çünkü tek cümleyle
anlatılabilen ayrı bir değişiklikti.

> Sınır ölçütü: **bir commit tek bir cümleyle anlatılabiliyorsa doğru boyuttadır.**

Yayının en zor kısmı kod değildi. README'nin *"Durum ve sınırlar"* bölümü, live modun
gerçek bir hesaba karşı hiç çalıştırılmadığını ve GraphQL şemasının gözlem değil çıkarım
olduğunu açıkça söylüyor.

### PROMPT

```text
Repoyu public olarak yayınlamadan önce bir yayın taraması yap. Şunları TEK TEK
kontrol et ve her biri için ne bulduğunu yaz:
  - .env commit edilmiş mi? .gitignore'da mı?
  - Kaynak ağacında gerçek token kalıbına benzeyen bir dizge var mı?
  - Build çıktıları (dist/, obj/, bin/, __pycache__, node_modules) commit'lenmiş mi?
  - Mutlak yol sızıntısı var mı (/Users/<isim>/... gibi)?
  - Lisans dosyası var mı ve README ile tutarlı mı?

Sonra değişiklikleri MANTIKSAL commit'lere böl — dosya başına değil, bir commit'in
TEK BİR CÜMLEYLE anlatılabilmesine göre. Commit mesajlarını İngilizce yaz.

Son olarak README'ye bir 'Durum ve sınırlar' bölümü ekle ve şunu açıkça yaz:
neyin test edildiği, neyin edilmediği, hangi iddianın gözlem hangisinin çıkarım
olduğu. Süslemeden yaz.
```

### KARAR

| Seçenek | Artısı | Eksisi |
|---|---|---|
| Tek büyük commit | En hızlı | Geçmiş okunamaz; `bisect` işe yaramaz |
| Dosya/klasör başına commit | İnce taneli | Yarım çalışan ara durumlar; hiçbir commit tek başına tutarlı değil |
| **Mantıksal commit: her biri tek cümleyle anlatılabilsin** ✅ | Geçmiş bir anlatıya dönüşür | Elle gruplamak ve ayrı ayrı test etmek gerekir |

### ÜRETİLEN DOSYALAR

`README.md` · `LICENSE` · `.gitignore` · `.env.example`

### DOĞRULAMA

```bash
git check-ignore -v .env
```

Beklenen: `.gitignore` satırını gösterir (çıkış kodu `0`).

### NE ÖĞRENDİK

- Yayın taraması bir **kontrol listesidir**, hatırlama işi değil.
- Commit sınırını "hangi dosyalar" değil **"tek cümleyle ne anlattığı"** belirler.
- **Neyin doğrulanmadığını yazmak** bir zayıflık itirafı değil, materyalin güvenilirliğidir.
- Sırları taramayı otomatikleştir ve `.env`'i ilk günden `.gitignore`'a koy. Sonradan temizlenen bir geçmiş asla tam temizlenmez.

---
---

# Kendi projene nasıl uygularsın

Bu repo Xurrent ve MCP'ye özeldir; **yöntem değildir**. Yöntem şu altı adımdır ve
herhangi bir entegrasyon projesine uygular.

## 1 — Önce "kaç tur konuşulacak" sorusunu sor

Tek turluk bir iş script'tir. Çok turlu bir iş bir **yetenek yüzeyi** ister: tool'lar,
şemalar, onay akışı. Bu kararı kod yazmadan ver; geri dönmesi en pahalı karardır.

## 2 — Keşfi kod bütçesinden ayır ve iki liste üret

AI ile çalışırken keşif ucuz, yanlış mimari pahalıdır. Araştırmanın çıktısı iki liste olsun:

- **Bildiklerimiz** — dokümantasyonda açıkça yazan.
- **Çıkarımlarımız** — bizim türettiğimiz. Her madde için *"nasıl doğrularım"* ve
  *"yanlışsa ne olur"* yazılı olsun.

İkinci liste, ilk canlı bağlantıda yürüteceğin iş listesidir. Bu repoda
[D1–D13](08-riskler-ve-sss.md#dogrulanmali) olarak duruyor.

## 3 — Sözleşmeyi kodun önüne koy, makine-okunur yap

> AI destekli geliştirmede en yüksek getirili adım kod yazmak değil, **doğru sözleşmeyi
> tarif etmektir.**

Sözleşme şunları içermeli:

- İmzalar: ad, girdi şeması, **çıktı şeması**, davranış ipuçları (`readOnlyHint` vb.).
- Ortak kurallar tek yerde: birim, format, id semantiği, hata semantiği.
- Keşifte bulunan **tuzaklar** — koda değil sözleşmeye. Böylece her implementasyon aynı
  tuzağı aynı yerden öğrenir.
- Kanonik sıra. Sıra da sözleşmenin parçasıdır.

Ve en önemlisi: sözleşmeye karşı çalışan **bir doğrulayıcı**. Doğrulayıcısı olmayan
sözleşme bir niyet beyanıdır.

## 4 — Test verisini tasarla, üretme

Her kaydın *"hangi kuralı öğretiyorum"* sorusuna cevabı olsun. Kenar durumları rastgeleliğe
bırakma; kurgula. Zamana bağlı veriyi **göreli** tut, türetilebilir dosyaları kaynak sayma.

## 5 — Katmanı "neyi bilmez" ile tarif et

İş mantığını protokolden, protokolü de taşımadan ayır. Ölçüsü basit: **bağımlılığın spec'i
değişirse kaç dosya değişiyor?** Liste kısaysa katmanlama işe yaramıştır.

Bu repoda MCP'nin en büyük revizyonu sekiz tool'un hiçbirini değiştirmedi; yalnızca
`mcp/` altındaki kabuk ikiye ayrıldı.

## 6 — Ölç. Rapora değil, komuta güven.

Bu projedeki en pahalı üç anın üçü de ölçümle çözüldü:

| Durum | Varsayım | Ölçüm sonucu |
|---|---|---|
| İki protokolü desteklemek | "C# için üç ayrı proje gerekir" | SDK 2.0.0 ikisini de konuşuyor; gerekmedi |
| Sonda `-32601` döndü | "Sunucu v2 konuşmuyor" | İstemcinin `_meta`'sı eksikti; sunucu suçsuzdu |
| Üç ajan "tamamlandı" dedi | "Üç dil uyumlu" | İkisi hiç `outputSchema` bildirmiyordu |

Pratik kurallar:

- **Mimari kararı ölçmeden verme.** *"Şu gerekir"* cümlesinin arkasında ölçüm yoksa o bir varsayımdır.
- **"Çalıştı" raporu delil değildir.** İddiayı bağımsız ölçen bir komut çalıştır.
- **Doğrulayıcının kör noktasını sorgula.** Yeşil bir kontrolün ne ölçtüğü kadar ne ölçmediği de bilinmelidir.
- **Kırmızı bir test önce kendini suçlamalı.** Bu projede iki yanlış alarm koda dokunulmadan çözüldü.
- **Parite şekil değil davranıştır.**
- **Ne kanıtlamadığını yaz.** Sınırı yazılmayan bir araç zamanla garanti gibi okunur.

---

## Özet

| Konu | Sonuç |
|---|---|
| Kod yazmadan önce | Beş paralel araştırma kolu, ~887k token, sıfır satır kod |
| Mimariyi belirleyen | `TimeEntryCreateInput` bir ticket'a bağlanamıyor |
| İlk yazılan dosya | `contract/tools.json` — 8 tool, girdi **ve** çıktı şemasıyla |
| Test verisi | Elle kurgulandı; her kayıt bir kural öğretir |
| Katmanlama ölçüsü | MCP'nin en büyük revizyonu 8 tool'un hiçbirini değiştirmedi |
| Ölçüm 1 | SDK 2.0.0'lar iki revizyonu da konuşuyor → üç proje gereksizdi |
| Ölçüm 2 | Sondanın `-32601`'i istemci hatasıydı, sunucu eksikliği değil |
| Ölçüm 3 | İki sunucu hiç `outputSchema` bildirmiyordu; bugün **8/8** |
| Live yolu | `tools/fake-xurrent` — 3 dil × 7 senaryo = **21 kontrol** |
| Bulunan gerçek hata | C# bulk'ta kayıt başına 2 istek atıyordu → 429 |
| Yayın | 4 mantıksal commit + 1 sonradan; MIT; `.env` hiç commit'lenmedi |
| En genellenebilir ders | **Sözleşmeyi kodun önüne koy, sonra ölç.** |

Sunum planı: [demo/senaryo.md](demo/senaryo.md).
Makine-okunur adımlar: [`docs/atolye/adimlar.json`](atolye/adimlar.json).
