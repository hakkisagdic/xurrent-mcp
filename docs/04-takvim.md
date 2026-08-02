# 04 — Takvim

> **Bölüm hedefi:** Microsoft Graph ve Google Calendar'ın aynı kavramları farklı
> alanlarla ifade etmesini, normalizasyon katmanının neden zorunlu olduğunu ve
> "her toplantıyı zaman girişine çevir" cümlesinin neden masum olmadığını anlamak.

| ← Önceki | Sonraki → |
|---|---|
| [03 — MCP tasarımı](03-mcp-tasarimi.md) | [05 — Chatbot](05-chatbot.md) |

---

## "Her toplantı" kaç toplantıdır?

İster #4: *"Kişinin o günkü takvimini okuyacak, her bir toplantıyı zaman girişi olarak
ekleyecek."*

Demo takviminde **8 etkinlik** var. Kaçı toplantı?

**Beş.**

| Etkinlik | Durum |
|---|---|
| Günlük standup | ✅ toplantı |
| REQ-70248 performans incelemesi | ✅ toplantı |
| 1:1 — Mehmet Kaya | ✅ toplantı |
| **Öğle arası** | ❌ `free` |
| VPN kopma sorunu kök neden analizi | ✅ toplantı (45 dk!) |
| Onboarding otomasyonu tasarım | ✅ toplantı |
| **Ekip retrospektifi** | ❌ `declined` |
| **Zeynep'in doğum günü** | ❌ `isAllDay` |

Ve beş "gerçek" toplantının toplamı da tek bir sayı değil: **255 dakika** (naif toplam)
veya **225 dakika** (çakışmalar bir kez sayılırsa). İkisi de doğru — farklı sorulara
cevap veriyorlar.

**Ham veriyi çekmek kolay; anlamlı veriye çevirmek asıl iş.**

---

## Graph vs Google — alan alan karşılaştırma

| Kavram | **Microsoft Graph** | **Google Calendar v3** | Normalize (`Meeting`) |
|---|---|---|---|
| Uç nokta | `/me/calendarView` | `/calendar/v3/calendars/{id}/events` | — |
| Kayıt id | `id` | `id` | `id` |
| Serideki kimlik | **`iCalUId`** | **`iCalUID`** | `uid`'in bir parçası |
| Başlık | `subject` | `summary` | `title` |
| Başlangıç | `start.dateTime` + `start.timeZone` | `start.dateTime` **veya** `start.date` | `start` (offset'li instant) |
| Bitiş | `end.dateTime` + `end.timeZone` | `end.dateTime` **veya** `end.date` | `end` |
| Tüm gün | `isAllDay` | `start.date` **varlığı** | `isAllDay` |
| İptal | `isCancelled` | `status == "cancelled"` | `isCancelled` |
| Meşguliyet | `showAs` (`free`/`tentative`/`busy`/`oof`/…) | `transparency` (`opaque`/`transparent`) | `free` |
| Katılım cevabı | `responseStatus.response` (`declined`/`accepted`/…) | `attendees[self==true].responseStatus` | `declined` |
| Düzenleyen | `organizer.emailAddress.address` | `organizer.email` | `organizer` |
| Katılımcı sayısı | `attendees.length` | `attendees.length` | `attendeeCount` |
| Kategoriler | `categories[]` | — (yok; `colorId` var) | `categories` |
| Seri | `seriesMasterId` | `recurringEventId` | `seriesId` |
| Toplantı linki | `onlineMeeting.joinUrl` | `hangoutLink` / `conferenceData.entryPoints[].uri` | `joinUrl` |
| Zaman aralığı param. | `startDateTime` / `endDateTime` | `timeMin` / `timeMax` | — |
| Tekrar açma | **otomatik** (`calendarView`) | **`singleEvents=true`** (varsayılan `false`!) | — |

Bu tablo, normalizasyon katmanının neden bir "gereksiz soyutlama" olmadığının kanıtı.
`title` alanına ulaşmak için biri `subject`, diğeri `summary` diyor. Aynı kavram, iki isim.
Bunu her çağrı yerinde `if (provider === "graph")` ile çözmeye kalkarsan kod dallanır ve
üçüncü sağlayıcı (`ics`) geldiğinde çöker.

**Kural:** sağlayıcıya özgü şekil, adapter'ın **sınırında** biter. İçeride yalnızca
`Meeting` vardır.

---

## Tuzak 1 — `calendarView` vs `events` (Graph)

```
✅ GET /me/calendarView?startDateTime=…&endDateTime=…
❌ GET /me/events
```

`/me/events` **seri master'ını** ham `recurrence` kuralıyla döner. Bugünkü occurrence'ı
göremezsin — RRULE'ü kendin açman gerekir.

`/me/calendarView` verilen aralıktaki tekrarları **açılmış (expanded)** döner. Yani her
occurrence ayrı bir kayıt.

> ### ⚠️ Yanlış yaparsan ne olur
>
> Haftalık standup'ın bugünkü örneği listede **hiç görünmez.** Hata almazsın. "Takvimde
> yokmuş" dersin. Kullanıcının en düzenli toplantıları sistematik olarak kaybolur.

---

## Tuzak 2 — `singleEvents=true` (Google)

Aynı problemin Google'daki karşılığı, ama daha sinsi çünkü **bir parametre varsayılanı**:

```
GET /calendar/v3/calendars/primary/events
    ?timeMin=2026-08-02T00:00:00%2B03:00
    &timeMax=2026-08-03T00:00:00%2B03:00
    &singleEvents=true          ← VARSAYILANI FALSE!
    &orderBy=startTime          ← yalnızca singleEvents=true iken çalışır
    &maxResults=2500
```

`singleEvents` varsayılanı **`false`**'tur. `true` yapılmazsa tekrarlayan toplantılar
açılmaz; seri master'ı ham `recurrence` dizisiyle döner.

Ve ikinci sıra etki: **`orderBy=startTime` `singleEvents=true` olmadan hata verir.**
Yani "sıralama çalışmıyor" diye başlayan bir hata ayıklama seansı, aslında bambaşka bir
bug'ı işaret eder.

---

## Tuzak 3 — Graph'in `dateTime` alanı

Bu, projedeki **en sessiz** tuzaklardan biri.

Graph'ten gelen bir başlangıç:

```json
{
  "start": {
    "dateTime": "2026-08-02T09:00:00.0000000",
    "timeZone": "UTC"
  }
}
```

İki gözlem:

1. **Offset TAŞIMAZ.** Sonunda `Z` de yok, `+03:00` da yok. Saat dilimi **ayrı bir
   alandadır** (`timeZone`).
2. **7 kesirli hane** içerir. `.0000000` — çoğu ISO8601 parser'ı 3 hane bekler.

> ### ⚠️ Yanlış yaparsan ne olur
>
> ```js
> new Date("2026-08-02T09:00:00.0000000")   // ❌
> ```
>
> Offset olmadığı için JavaScript bunu **çalıştığın sunucunun yerel saati** sanar.
> Geliştirici makinesi Europe/Istanbul ise "doğru" görünür. Konteyner UTC ise **3 saat
> kayar.** Test geçer, üretim kayar. Bulunması en zor bug türü.

**Doğru form:**

```ts
// Graph dateTime alanı offset TAŞIMAZ ve 7 kesirli hane içerir.
// Kesirli haneleri 3'e kırp, ardından timeZone alanına göre offset ekle.
// (Prefer header GÖNDERİLMEZ → Graph UTC döner → "Z" doğru offsettir.)
const iso = raw.replace(/(\.\d{3})\d+$/, "$1") + "Z";
const instant = new Date(iso);
```

### `Prefer: outlook.timezone` göndermeyin

Graph, `Prefer: outlook.timezone="Europe/Istanbul"` header'ı ile yanıtı istediğin
dilimde döndürebilir. **Göndermiyoruz.**

Neden? Çünkü o zaman `dateTime` alanı hâlâ offset taşımaz, ama artık **hangi dilimde
olduğunu da bilmezsin** (header'ı takip etmen gerekir). UTC istemek tek bir kural
üretir: *kesirli haneleri kırp, `"Z"` ekle, bitti.*

**İlke:** dış sistemden **en ham, en belirsizliksiz** biçimi iste; yorumu tek bir yerde yap.

---

## Tuzak 4 — İzin modeli: `Calendars.Read` vs `Calendars.Read.All`

Sezgi şunu söyler: *"`.All` daha kapsamlıdır, onu isteyeyim, kesin çalışır."*

**Yanlış.**

| İzin | Ne yapar |
|---|---|
| **`Calendars.Read`** | **Takvim etkinliklerini okur.** Delegated ve app-only için doğru izin. |
| `Calendars.Read.All` | Tüm kullanıcıların **çalışma saatlerini ve lokasyonlarını** okur. Etkinlik okumaz. |

> ### ⚠️ Yanlış yaparsan ne olur
>
> Admin `Calendars.Read.All`'ı onaylar (üstelik "tenant geneli" olduğu için ekstra
> tartışma yaratır), sen token alırsın, `/me/calendarView` çağırırsın ve **403** alırsın.
> Sonra izinleri, consent'i, app registration'ı saatlerce kontrol edersin. Doğru izin
> baştan beri **daha dar** olandı.

Client credentials (app-only) akışında scope **her zaman**:

```
https://graph.microsoft.com/.default
```

Tek tek scope adı yazılmaz; `.default`, app registration'da tanımlı ve admin onaylı tüm
application permission'ları uygular.

### App-only ise mailbox'ı kısıtla

App-only izinle uygulama, tenant'taki **her** mailbox'ı okuyabilir. Exchange Online
application access policy ile bir gruba kısıtla:

```powershell
New-ApplicationAccessPolicy `
  -AppId <client-id> `
  -PolicyScopeGroupId <güvenlik-grubu> `
  -AccessRight RestrictAccess
```

Bu bir "güzel olur" değil. Ders sunumunda bir öğrenci kendi kurumsal tenant'ında bunu
denerse, politikasız bir app-only kayıt **denetim bulgusudur.**

### Google tarafı

| Yol | Kimlerde çalışır |
|---|---|
| **OAuth kullanıcı onayı** | **Herkes**, kişisel `@gmail.com` dahil |
| Service account + domain-wide delegation | **Yalnızca Google Workspace.** `@gmail.com`'da çalışmaz. |

Bu projede OAuth yolu tercih edildi ve token **tek bir dosyada** tutulur:

```
~/.xurrent-mcp/google-token.json
```

**Üç dil de aynı dosyayı okur.** Bilinçli bir tasarım kararı: OAuth kütüphanesini üç kez
implemente etmek yerine, tek seferlik yetkilendirmeyi bir script'e (`scripts/google-auth.mjs`)
alıp, üç sunucuda geriye kalan işi **düz bir HTTP POST**'a (refresh token → access token)
indirdik.

> **Ders notu:** "Üç dilde aynı şeyi yaz" derken, *neyi yazmayacağını* seçmek de mimaridir.

---

## Pencereyi doğru kurmak

**Kural:** pencere her zaman **yerel gece yarısından yerel gece yarısına**, **offset
gömülü**.

```
windowStart = 2026-08-02T00:00:00+03:00
windowEnd   = 2026-08-03T00:00:00+03:00
```

> ### ⚠️ Yanlış yaparsan ne olur
>
> ```
> startDateTime=2026-08-02T00:00:00      ← çıplak, offset yok
> ```
>
> Sunucu bunu kendi varsayılan dilimine göre yorumlar. Istanbul (+03:00) kullanıcısı için
> UTC yorumu **3 saat kayar**: gecenin ilk 3 saati düşer, ertesi günün ilk 3 saati girer.
> Sabah 09:00 toplantısı hâlâ görünür — yani **hata fark edilmez** — ama akşam 22:00
> etkinliği yanlış güne düşer.

DST geçiş günlerinde bu daha da önemlidir: o gün 23 veya 25 saattir ve "24 saat ekle"
yanlıştır. Doğrusu **"ertesi günün yerel gece yarısı"**dır.

Aynı ilke fixture'larda da geçerli — [`fixtures/README.md`](../fixtures/README.md):

```
instant = zonedDateTime(today + dayOffset, startLocal, timeZone)
```

Bir toplantı *"saat 09:00'da"* başlar, *"UTC 06:00'da"* değil.

### Overlap filtresi ve clipping

Her iki API de **overlap** filtresi uygular: pencereye **değen** her etkinlik döner.

Yani dün 23:00'te başlayıp bugün 01:00'de biten bir toplantı, bugünün penceresinde
**görünür** — ve tam 120 dakikasıyla. Ama bugüne düşen kısmı 60 dakikadır.

**Çözüm: pencereye clip et.**

```
effectiveStart = max(meeting.start, windowStart)
effectiveEnd   = min(meeting.end,   windowEnd)
minutes        = (effectiveEnd - effectiveStart) / 60000
```

Clip edilmezse gece yarısını aşan toplantılar **iki gün birden** tam süreyle sayılır.

---

## Atlama kuralları

Elenen etkinlik listeden **silinmez**; `skipped: true` + Türkçe `skipReason` ile döner.
Öğretici olan da bu — kullanıcı neyin neden elendiğini görür.

| Koşul | `skipReason` | Öğrettiği kural | Varsayılanı ezen parametre |
|---|---|---|---|
| `isCancelled` | "İptal edilmiş etkinlik." | İptal edilen toplantı takvimde kalır | — |
| `declined` | "Bu toplantıyı reddetmişsiniz." | Reddedilen toplantı **sunucu tarafında filtrelenmez** | `includeDeclined` |
| `isAllDay` | "Tüm gün etkinliği — süresi hesaplanamaz." | End date **exclusive**'dir | `includeAllDay` |
| `free` | "Meşgul değil (free/transparent) — çalışma sayılmaz." | Takvimde yer kaplar, çalışma değildir | `includeFree` |

Üç ayrıntı:

**`isAllDay` neden hesaplanamaz:** her iki API de all-day için **exclusive end date**
kullanır. Tek günlük bir all-day etkinlik `start = 2026-08-02`, `end = 2026-08-03`
şeklinde gelir. Instant farkı **24 saat = 1440 dakika** verir. "Zeynep'in doğum günü"
için 1440 dakika yazmak absürt; bu yüzden all-day etkinliklerin süresi instant'lardan
**hesaplanmaz**, elenirler.

**`declined` neden sunucuda filtrelenemez:** reddettiğin toplantı takviminde durmaya
devam eder — bu bir özelliktir (kimin ne zaman meşgul olduğunu görebilmek için). Her iki
API de onu döndürür. Filtre **senin** işin.

**`free` iki farklı isim taşır:** Graph `showAs == "free"`, Google
`transparency == "transparent"`.

> ### ⚠️ Yanlış yaparsan ne olur — Google `transparency` varsayılanı
>
> Google, `transparency` alanını **varsayılan değerinde (`opaque`) yanıta koymaz.**
> Alan yoktur.
>
> ```js
> if (ev.transparency === "opaque") { /* meşgul */ }   // ❌ HİÇBİR ZAMAN çalışmaz
> const free = (ev.transparency ?? "opaque") === "transparent";  // ✅
> ```
>
> İlk form, meşgul toplantıların **hiçbirini** meşgul saymaz. Yani bütün gün boşmuş gibi
> görünür ve hiçbir zaman girişi önerilmez. Sessiz, tam ve kolayca gözden kaçan bir hata.

---

## Dedup: anahtarın asimetrisi

İki sağlayıcıdan aynı takvimi okuduğunda (veya `auto` modda fallback zinciri devreye
girdiğinde) aynı toplantıyı iki kez saymamak gerekir.

Sezgi: *`iCalUID` benzersizdir, onu kullan.*

**Yetmez** — çünkü iki sağlayıcı `iCalUID`'i farklı yorumlar:

| | Tekrarlayan bir serideki her occurrence |
|---|---|
| **Microsoft Graph** | `iCalUId` **farklıdır** (her occurrence ayrı) |
| **Google Calendar** | `iCalUID` **aynıdır** (seri boyunca sabit) |

> ### ⚠️ Yanlış yaparsan ne olur
>
> - **Yalnızca `iCalUID` ile dedup:** Google'da haftalık standup'ın 5 occurrence'ı **tek
>   kayda iner.** Haftanın 4 günü kaybolur.
> - **Hiç dedup yapmama:** iki sağlayıcı birden aktifse her toplantı **iki kez** sayılır;
>   zaman girişleri iki katına çıkar.

**Doğru anahtar:**

```
uid = iCalUID + "|" + start.toISOString()
```

`start` **mutlak instant** olarak (UTC ISO) yazılır — yerel saat kullanmak DST günlerinde
çakışma üretir.

Bu anahtar her iki sağlayıcıda da doğru çalışır:
- Graph'te `iCalUId` zaten farklı → anahtar da farklı ✅
- Google'da `iCalUID` aynı ama `start` farklı → anahtar farklı ✅
- İki sağlayıcıdan gelen **aynı** toplantı → aynı `iCalUID` + aynı instant → anahtar aynı ✅

---

## `busyMinutes` vs `naiveSumMinutes`

İki toplantı çakışıyor:

```
10:00 ─────────── 11:00     REQ-70248 performans incelemesi  (60 dk)
      10:30 ─────────── 11:30     1:1 — Mehmet Kaya           (60 dk)
```

Naif toplam: 60 + 60 = **120 dakika.**
Gerçek meşguliyet: 10:00–11:30 = **90 dakika.**

Günün tamamı için:

| Toplantı | Süre |
|---|---|
| Günlük standup 09:00–09:30 | 30 |
| REQ-70248 10:00–11:00 | 60 |
| 1:1 10:30–11:30 | 60 |
| VPN kök neden 13:45–14:30 | 45 |
| Onboarding tasarım 15:00–16:00 | 60 |
| **`naiveSumMinutes`** | **255** |

Interval merge sonrası:

```
09:00–09:30  →  30
10:00–11:30  →  90     ← iki toplantı birleşti
13:45–14:30  →  45
15:00–16:00  →  60
─────────────────────
busyMinutes  →  225
```

**Fark: 30 dakika.**

### Her ikisi de raporlanır — neden?

Farklı sorulara cevap veriyorlar:

| Soru | Cevap |
|---|---|
| *"Bugün ne kadar meşguldüm?"* | `busyMinutes` (225) — takvimde kaç dakika doluydun |
| *"Toplantılara ne kadar zaman yazmalıyım?"* | `naiveSumMinutes` (255) — çakışan iki toplantıya ayrı ayrı zaman yazmak da meşru olabilir |

`busyMinutes`'a bakıp toplam zaman yazarsan **30 dakika eksik** yazarsın.
`naiveSumMinutes`'ı "meşguliyet" diye raporlarsan **30 dakika fazla** gösterirsin.

Sözleşme ikisini de zorunlu tuttu (`totals.busyMinutes`, `totals.naiveSumMinutes`) çünkü
**farkı görmek dersin bir parçası.** Aradaki fark sıfırdan büyükse, kullanıcıya bir soru
sorulması gerektiğinin sinyalidir.

### Interval merge — algoritma

```
1. Elenmemiş toplantıları başlangıca göre sırala
2. current = ilk aralık
3. Sonraki her aralık için:
     çakışıyorsa (next.start <= current.end):
         current.end = max(current.end, next.end)     ← birleştir
     çakışmıyorsa:
         current'ı sonuca ekle; current = next
4. Sonuçtaki aralıkların uzunluklarını topla
```

Klasik bir mülakat sorusu — burada gerçek bir faturalama sonucu var.

---

<a id="eslestirme"></a>

## Eşleştirme heuristiği

`plan_time_entries_from_calendar`, her toplantıyı bir açık işle eşleştirmeye çalışır.
Heuristik **basit ve açıklanabilir** tutuldu — üç yol:

### 1. Başlıkta ticket numarası deseni

```
"REQ-70248 performans incelemesi"  →  70248  →  Request TW9jay9SZXF1ZXN0LzcwMjQ4
```

`matchConfidence: 1.0`, `matchReason: "Toplantı başlığında #70248 numarası geçiyor."`

Numara **açık iş listesindeki** bir `displayId` ile eşleşmek zorundadır. Listede yoksa
eşleşme sayılmaz — kapalı veya başkasına ait bir ticket'a zaman yazılmaz.

### 2. Normalize edilmiş metin benzerliği

```
"Onboarding otomasyonu tasarım toplantısı"
   ≈ Request #70315 "Yeni çalışan onboarding hesap açılışı otomasyonu"
```

Normalizasyon: küçült, Türkçe aksanları sadeleştir, noktalama at, durak kelimeleri
("toplantı", "görüşme", "ile", "için") ele, token kümesi kesişimi hesapla.

`matchConfidence` düşüktür (ör. 0.4–0.7) ve `matchReason` **Türkçe, insan-okunur**dur:
`"Başlık ile talep konusu 3 ortak anahtar kelime paylaşıyor: onboarding, otomasyon, tasarım."`

### 3. Hiçbiri tutmazsa → `needsUserDecision: true`

```
"Günlük standup"  →  hiçbir açık işle benzeşmiyor
```

`suggestedTargetType: "time_allocation"`, `suggestedTargetId: DEFAULT_TIME_ALLOCATION_ID`
("İç toplantılar") önerilir, ama `needsUserDecision: true` kalır.

### Belirsizlik de bir karardır

En öğretici vaka:

```
"VPN kopma sorunu kök neden analizi"
   ≈ Request #70301 "VPN bağlantısı gün içinde sürekli kopuyor"
   ≈ Task    #4419  "VPN concentrator loglarını analiz et"
```

İki aday, benzer skorlar. Heuristik en yüksek skoru seçebilirdi — **seçmiyor.**

> **Kural:** İki aday arasındaki skor farkı eşiğin altındaysa `needsUserDecision: true`.
> Bot tahmin etmek yerine **SORAR.**

Aynı öneride bir de yuvarlama uyarısı var: 45 dakika, `timeIncrement` 30 → uyarı zorunlu.

### Ve neden ASLA otomatik yazmıyoruz?

`plan_time_entries_from_calendar` `kind: "preview"`'dur ve `readOnlyHint: true` taşır.
**Yazma yolu kodda yoktur.**

Dört sebep:

1. **Heuristik asla %100 doğru olamaz.** "Standup" hangi ticket'a yazılacak? Bilinemez.
   Bilinemeyen bir şeyi tahmin edip yazmak, veriyi bozmaktır.
2. **Faturalamaya gider.** Yanlış eşleşme yanlış müşteriye fatura demektir.
3. **Kullanıcı takvimini biliyor, bot bilmiyor.** "1:1" toplantısı yönetim işi mi,
   ticket işi mi? Cevap kullanıcının kafasında.
4. **Öneri reddedilebilir olmalı.** Yazılmış bir kaydı geri almak, önerilmiş bir kaydı
   reddetmekten kat kat pahalıdır.

Akış bu yüzden iki adımlıdır:

```
plan_time_entries_from_calendar   →  öneriler (YAZMAZ)
        ↓  kullanıcı düzeltir / onaylar
xurrent_create_time_entries_bulk  →  yazar (tek onayla)
```

Öneri üreten ile yazan **ayrı tool**. Bu ayrım, [03 — MCP tasarımı](03-mcp-tasarimi.md#dry-run)'ndaki
üçüncü dry-run katmanının ta kendisidir.

---

## Sağlayıcı seçimi ve `auto`

```
CALENDAR_PROVIDER = mock | ics | google | graph | auto
```

`auto` sırayla dener: **graph → google → ics → mock.** İlk yapılandırılmış olan kazanır.

`mock` en sonda ve **her zaman çalışır** — ders sunumunun internet olmadan da yapılabilmesi
bu sayede garanti altında.

`ics` sağlayıcısı gerçek bir dosya formatı okur ve `.ics` **göreli tarih taşıyamaz.**
Bu yüzden `scripts/gen-ics.mjs`, `fixtures/calendar.ics`'i `calendar.json`'dan **o anki
tarihe göre** yeniden üretir:

```bash
npm run gen:ics     # sunumdan hemen önce bir kez
```

---

## Özet

| Konu | Kural |
|---|---|
| Graph uç noktası | **`/me/calendarView`**, `/me/events` değil |
| Google parametresi | **`singleEvents=true`** (varsayılan `false`!) |
| Google sıralama | `orderBy=startTime` yalnızca `singleEvents=true` ile |
| Graph `dateTime` | Offset **yok**, 7 kesirli hane → kırp + `"Z"` |
| `Prefer` header | **Gönderme** — UTC iste, yorumu tek yerde yap |
| Graph izni | **`Calendars.Read`** (`.All` çalışma saatleridir!) |
| App-only scope | `https://graph.microsoft.com/.default` |
| Pencere | Yerel gece yarısı → yerel gece yarısı, **offset gömülü** |
| Overlap | Pencereye **clip et** |
| Atlama | `isCancelled` \| `declined` \| `isAllDay` \| `free` → `skipped` + Türkçe `skipReason` |
| Google `transparency` | `(t ?? "opaque")` — varsayılan yanıta **konmaz** |
| Dedup anahtarı | `iCalUID` **+ start instant** |
| Süre | `busyMinutes` (merge) **ve** `naiveSumMinutes` — **ikisi de** |
| Eşleştirme | 3 yol; belirsizlik → `needsUserDecision: true` |
| Otomatik yazma | **Yok.** Öneri üreten ve yazan ayrı tool'lardır. |

Sıradaki bölüm, tüm bu kuralları LLM'e nasıl öğrettiğimizi anlatıyor:
[05 — Chatbot](05-chatbot.md).
