# fixtures/ — üç dilin ortak mock verisi

Bu klasördeki JSON dosyalarını **üç implementasyon da aynen okur**. TypeScript, Python ve C#
sunucuları mock modda çalıştırıldığında birebir aynı çıktıyı üretir — ders sırasında
"dil değişti ama sonuç aynı" iddiasının kanıtı budur.

## Göreli tarih sözleşmesi

Fixture'larda **mutlak tarih yoktur**. Demo hangi gün çalıştırılırsa çalışsın tutarlı
olsun diye tarihler yükleme anında materyalize edilir:

| Alan | Anlamı |
|---|---|
| `dayOffset` | Bugüne göre gün farkı. `0` = bugün (T), `-1` = dün (T-1), `-3` = 3 gün önce |
| `startLocal` / `endLocal` | `"HH:mm"` — kişinin saat diliminde yerel saat |
| `updatedAtOffsetDays` | Kaydın son güncellenme zamanı, bugüne göre gün farkı |
| `targetAtOffsetDays` | Hedef/termin tarihi, bugüne göre gün farkı |

Materyalizasyon kuralı (üç dilde de aynı):

```
instant = zonedDateTime(today + dayOffset, startLocal, timeZone)
```

Saat dilimi `XURRENT_TIMEZONE` (varsayılan `Europe/Istanbul`) ile gelir. **DST geçişleri
bilerek yerel saatten hesaplanır** — bir toplantı "saat 09:00'da" başlar, "UTC 06:00'da"
değil.

## Dosyalar

| Dosya | İçerik |
|---|---|
| `people.json` | Demo kullanıcı + 2 iş arkadaşı. `me` alanı authenticated user'ı işaret eder |
| `requests.json` | 3 açık + 1 kapalı Request. Kapalı olan, filtre doğruluğunu göstermek için var |
| `tasks.json` | 3 açık + 1 kapalı Task |
| `effort-classes.json` | 3 aktif + 1 `disabled` effort class. Disabled olan client-side eleme dersini verir |
| `timesheet-settings.json` | `timeIncrement: 30` — 45 dakikalık toplantının yuvarlanmasını zorunlu kılar |
| `time-allocations.json` | Yol A (`timeEntryCreate`) hedefleri. Biri `descriptionRequired` |
| `calendar.json` | Takvim. Bugün (`dayOffset: 0`) 8 ham etkinlik → 5 gerçek toplantı; dün (`dayOffset: -1`) 2 toplantı |
| `calendar.ics` | Aynı veri `.ics` formatında — `ics` sağlayıcısını test etmek için. `npm run gen:ics` ile üretilir |
| `time-entries.json` | 5 tohum kayıt taşır (dünden 5 gün öncesine, `dayOffset` −1..−5) — "geçen hafta ne yazmışım" sorusunun cevaplanabilmesi için. Mock modda yeni yazılanlar üzerine birikir (`XURRENT_MOCK_PERSIST=1` ise diske de yazılır) |

`.ics` gerçek bir dosya formatıdır ve göreli tarih taşıyamaz; bu yüzden
`scripts/gen-ics.mjs` onu `calendar.json`'dan **o anki tarihe göre** yeniden üretir.
Sunumdan hemen önce bir kez çalıştırmak yeterlidir.

## Takvim fixture'ı neden böyle kurgulandı

`calendar.json` 8 ham etkinlik içerir ve bunların yalnızca 5'i gerçek toplantıdır.
Elenen 3 tanesi kasıtlıdır — her biri farklı bir filtreleme kuralını öğretir:

| Etkinlik | Neden elenir | Öğrettiği kural |
|---|---|---|
| "Doğum günü" | `isAllDay` | Tüm gün etkinliklerinin süresi instant'lardan HESAPLANMAZ (exclusive end date) |
| "Öğle arası" | `free` | `showAs=free` / `transparency=transparent` meşgul değildir |
| "Ekip retro" | `declined` | Reddedilen toplantı takvimde durur ama çalışılmamıştır |

Ayrıca **iki toplantı kasıtlı olarak çakışır** (10:00–11:00 ve 10:30–11:30).
Naif toplam 120 dakika verir, doğru cevap (interval merge) 90 dakikadır.
`calendar_list_today` çıktısında ikisi de raporlanır (`naiveSumMinutes` vs `busyMinutes`)
çünkü farkı görmek dersin bir parçasıdır.

Bir toplantı da **45 dakikadır** (13:45–14:30). `timeIncrement: 30` olduğu için bu değer
olduğu gibi yazılamaz; yuvarlama diyaloğunu tetikler.

## Eşleşme senaryoları

`plan_time_entries_from_calendar` heuristiğinin üç yolunu da tetiklemek için:

| Toplantı | Eşleşme yolu |
|---|---|
| "REQ-70248 performans incelemesi" | Başlıkta ticket numarası deseni → **kesin eşleşme** |
| "VPN kopma sorunu kök neden" | Metin benzerliği → Request #70301 ile **bulanık eşleşme** |
| "Günlük standup" | Hiçbiri → **kullanıcı kararı gerekli** |
