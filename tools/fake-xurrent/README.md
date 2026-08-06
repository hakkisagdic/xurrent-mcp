# Sahte Xurrent GraphQL sunucusu

> ## ⚠️ Önce bunu oku: bu sunucu neyi KANITLAMAZ
>
> Bu sunucuya karşı geçen bir test, **"Xurrent'a karşı doğrulandı" anlamına gelmez.**
> Gerçek Xurrent'ın şeması, bizim resmî dokümantasyondan çıkardığımızdan farklı olabilir.
>
> Yaptığı şey tek cümleyle: *"live kod yolu hiç çalıştırılmadı"* durumunu
> *"live kod yolu wire seviyesinde çalıştırıldı"* durumuna taşımak.
> Şema doğruluğu hâlâ **DOĞRULANMAMIŞ** — bkz. [docs/08](../../docs/08-riskler-ve-sss.md).

## Neden var

Xurrent ücretsiz değil: freemium katman yok, self-servis deneme yok, sandbox satış
üzerinden talep ediliyor. Yani repo'yu klonlayan biri `XURRENT_MODE=live` kod yolunu
deneyemiyordu — ve o yol hiç çalıştırılmamıştı.

`XURRENT_GRAPHQL_URL` zaten yapılandırılabilir olduğu için, **tek satır kod
değiştirmeden** üç sunucunun da live yolu bu sahte uca yönlendirilebiliyor.

```bash
XURRENT_MODE=live
XURRENT_GRAPHQL_URL=http://127.0.0.1:4000
XURRENT_TOKEN=sahte-token
XURRENT_ACCOUNT=ornek-bt
```

## Ne KANITLAR

- HTTP katmanı, `Authorization` ve `X-Xurrent-Account` header'larının gerçekten gönderildiği
- GraphQL sorgu metinlerinin bir sunucu tarafından tanınabilir olduğu
- `errors` dizisinin doğru ele alındığı — özellikle **HTTP 200 + `errors` dolu** durumu
- `two_step`'in gerçekten iki mutation gönderdiği ve ticket bağının korunduğu
- Artımlı `timeSpent` semantiği
- Rate limit karşısında istemcinin davranışı

## Çalıştırma

```bash
node tools/fake-xurrent/server.mjs --port 4000
```

```bash
node tools/fake-xurrent/senaryolar.mjs            # üç dil
node tools/fake-xurrent/senaryolar.mjs --dil cs   # tek dil
```

Senaryo koşucusu sunucuyu kendisi ayağa kaldırır. **Her dil için taze bir örnek**
başlatır — çünkü sunucu yazmaları biriktirir ve `workday: 480` tavanını gerçekten
uygular; paylaşılan durum, sırf sırada sonda olduğu için başarısız görünen bir dil
üretir. (İlk koşuda tam olarak bu oldu.)

## Zorladığı kısıtlar

Asıl değeri burada: sahte **veri** değil, sahte **davranış**.

| Kısıt | Davranış |
|---|---|
| `Authorization` yok | **401** |
| `X-Xurrent-Account` yok | **400** |
| Validation hatası | **HTTP 200** + `errors` dolu + `timeEntry: null` (top-level `errors` DEĞİL) |
| `timeSpent` `timeIncrement` katı değil | reddedilir |
| Negatif `timeSpent`, `correction` yok | reddedilir |
| `description` > 80 karakter | reddedilir |
| `allowWorkdayOvertime: false` + günlük 480 dk aşımı | reddedilir |
| İstek başına >1 mutation | reddedilir |
| 20 istek / 2 saniye aşımı | **429** + `retry-after` |
| `timeEntryCreate` ile oluşan kayıt | `assignment` **her zaman null** |
| `requestUpdate` / `taskUpdate` | `timeSpent` **artımlı**, `date` = bugün, `person` = authenticated user |
| `timeEntryUpdate` | `assignment`'a **dokunmaz** — `two_step`'in dayanağı |

Rate limit ve auth reddi `stderr`'e ayrıca loglanır; istemcinin throttle etmediğini
başka türlü fark etmek zor.

## Kaos modu

Arızalar **sabit değil, bayrakla açılır** ve oranlı kaos `--tohum` ile
**deterministiktir** (fake-gemini'nin `zar` modundaki desenin aynısı — kırmızı bir
koşu tekrarlanamıyorsa hata ayıklanamaz). Amaç, istemcinin retry/dedup politikasını
([contract/reliability.md](../../contract/reliability.md)) kanıtlamak:

| Bayrak | Davranış |
|---|---|
| `--kaos-429 <n>` | Sonraki *n* istek **429** + `retry-after: 1` alır — retry kanıtı (senaryo f) |
| `--kaos-500 <n>` | Sonraki *n* istek **500** alır |
| `--kaos-500-oran <p>` | Her istek *p* olasılıkla 500 alır (0..1) |
| `--gecikme-ms <ms>` | Her yanıt bu kadar geciktirilir |
| `--kaos-kir-desc <s>` | `description`'ı *s* içeren **her** `timeEntryCreate` 500 alır — retry'ın KURTARAMAYACAĞI kalıcı kırık kalem (senaryo g) |
| `--tohum <n>` | Oranlı kaosun PRNG tohumu |

Kaos, auth kontrollerinden **sonra**, rate-check'ten **önce** uygulanır: 429 kaosu
"istek işlenmeden reddedildi" sınıfını taklit eder.

Çalışma anında değiştirme — `POST /_kaos` (yalnızca sahte sunucuda var olan test
yüzeyi): süreç öldürülmeden bayrakları günceller. Neden gerekli: yazmalar bellekte
yaşar; senaryo (g)'nin "kaoslu bulk → kaossuz tekrar" akışında süreci yeniden
başlatmak store'u sıfırlar ve dedup kanıtını imkânsız kılardı.

```bash
curl -X POST http://127.0.0.1:4000/_kaos -d '{"kirDesc": null, "k429": 3}'
```

`timeEntries` sorgusu `sourceID` değişkenini de filtreler — dedup geri-okumasının
(reliability.md §5) dayandığı yol. ✅ Gerçek `TimeEntryFilter`'da `sourceID`
filtresi **belgelidir** (D14 kapatıldı, 2026-08-06 — reliability.md §9).

## Nasıl çalışır

Tam bir GraphQL motoru **değildir**. Gelen sorgunun **root field**'ını tanıyıp doğru
şekilli JSON döndürür; selection set'i ayrıştırmaz ve istenmeyen alanları da döndürür.
Bu bilinçli — amaç şema doğrulaması değil, istemci kod yolunu sürmek.

Root field'a bakıyoruz, **operation adına değil**: üç implementasyon aynı işlem için
farklı operation adları kullanıyor (`Whoami` / `Me`, `AddTimeToRequest` /
`LogTimeOnRequest` / `RequestUpdate`). Gerçek bir GraphQL sunucusu da operation adına
bakmaz.

Veri kaynağı [`fixtures/`](../../fixtures/) — mock modun okuduğu dosyaların **aynısı**.
Bu yüzden `mock` ile `live`-sahte aynı sayıları üretir; senaryo (a) tam olarak bunu
doğrular.

## Bu sunucunun ortaya çıkardığı gerçek hata

C# live adapter'ı, günlük toplam mesai kontrolü için **her bulk kaydından önce** ayrı
bir `LoggedMinutes` sorgusu atıyordu. Kayıt başına iki istek demek bu; 8 kayıtlık bir
bulk, Xurrent'ın 20 istek / 2 saniye sınırını aşıyor ve **429** alıyordu. TypeScript ve
Python kayıt başına tek istek attığı için aynı senaryoda sorun yaşamıyordu.

Mock modda görünmüyordu — çünkü mock'ta HTTP yok.

Düzeltme: baseline'ı gün başına bir kez sor, kendi yazdıklarını yerel say
(`LiveAdapter.GetLoggedMinutesAsync` + `NoteLoggedLocally`). Sonuç: 8 kayıt için
`LoggedMinutes` **8 kez değil 1 kez** gidiyor.

## Gerçek Xurrent'a geçerken doğrulanacaklar

Bu sunucu geçtiği için değil, **geçmediği** için önemli olanlar:

1. Alan adları ve enum değerleri gerçekten bizim varsaydığımız gibi mi
2. `RequestUpdatePayload` oluşan `TimeEntry`'nin id'sini döndürüyor mu (döndürmüyorsa
   `two_step`'in ara sorgusu şart — bkz. `docs/08` D5)
3. `timeIncrement` ihlalinde sunucu **reddediyor** mu yoksa **yuvarlıyor** mu
4. `personId != self` yazma denemesinde hangi hata dönüyor
5. ~~Rate limit header'larının gerçek adları~~ ✅ REST tarafında birebir belgeli:
   `x-ratelimit-limit/remaining/reset` + `retry-after` (saniye). GraphQL yüzeyinin
   kendi header adları hâlâ D1 kapsamındadır

Tam liste: [docs/08 — DOĞRULANMALI](../../docs/08-riskler-ve-sss.md).
