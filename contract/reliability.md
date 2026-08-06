# Güvenilirlik Sözleşmesi — retry, gaz, idempotency, dedup

> **Tez:** Retry transportun değil, OPERASYONUN özelliğidir. Aynı HTTP hatası,
> bir operasyonda güvenle tekrarlanır; başka bir operasyonda çift kayıt üretir.
> Bu dosya üç implementasyonun da (TS/Python/C#) uymak zorunda olduğu tek politikadır.
> Kanıtı `tools/fake-xurrent/senaryolar.mjs` (f) ve (g) senaryolarıdır.

## 1. Hata sınıflandırması

| Sınıf | Ne | Anlamı |
|---|---|---|
| **kesin-işlenmedi** | HTTP **429** | Rate limiter istek işlenmeden reddetti. Her operasyon güvenle tekrarlanabilir. |
| **belirsiz** | HTTP **5xx**, ağ hatası, zaman aşımı | İstek sunucuya ULAŞMIŞ ve İŞLENMİŞ olabilir. Tekrar kararı operasyonun doğasına bakar. |
| **kesin-reddedildi** | HTTP 4xx (429 hariç), GraphQL top-level `errors`, payload `errors` (iş kuralı) | Sunucu isteği anladı ve reddetti. Tekrarlamak İSRAF ya da aynı reddi üretir. ASLA otomatik retry edilmez. |

> Not — bilinçli sadeleştirme: "bağlantı hiç kurulamadı" (ECONNREFUSED, DNS) aslında
> kesin-işlenmedi'dir; ama üç dilde/runtimeda bu ayrımı güvenilir yapmak kırılgandır
> (fetch `TypeError`, httpx `ConnectError`, HttpClient `SocketException` hepsi farklı
> granülerlikte). Tüm ağ hatalarını BELİRSİZ sayıyoruz — en güvenli varsayım.

## 2. Operasyon sınıfları

| Sınıf | Operasyonlar | 429 | belirsiz (5xx/ağ) | Neden |
|---|---|---|---|---|
| `query` | tüm okuma sorguları | retry | retry | Yan etkisiz. |
| `guarded_create` | `timeEntryCreate` | retry | **önce dedup geri-okuması**, kayıt yoksa retry | Deterministik `sourceID` var ama Xurrent tarafında unique kısıtı YOK — kör retry çift kayıt yazabilir. Geri-okuma "yazılmış mı?" sorusunu cevaplar. |
| `idempotent_update` | `timeEntryUpdate` | retry | retry | Mutlak SET'tir (date/startedAt/personId değerlerini atar). Tekrarı zararsızdır. |
| `no_retry` | `requestUpdate`, `taskUpdate`, `projectTaskUpdate`, `problemUpdate` | retry | **ASLA** | `timeSpent` ARTIMLIDIR ("üzerine ekle") ve input idempotency anahtarı kabul etmez. Belirsiz hatada tekrar = çift sayım. Hata kullanıcıya raporlanır; öneri: kayıtları geri-okuyup elle karar. |

Sonuçlar:
- **two_step stratejisinin 1. adımı `no_retry` sınıfındadır.** İlk adım belirsiz hatayla
  düşerse akış durur ve kullanıcıya "ticket'a bakın; kayıt oluşmuş olabilir" denir.
- **Dedup yalnız Yol A (`timeEntryCreate`) kayıtlarında mümkündür** — `sourceID` sadece
  orada yazılabiliyor. Yol B'nin koruması dedup değil, retry YASAĞIDIR.

## 3. Bekleme politikası (üstel geri çekilme + tam jitter)

- Toplam deneme: **5** (ilk istek dahil; yani en fazla 4 tekrar).
- k'ıncı tekrarın beklemesi: `rastgele(0, min(CAP, BASE · 2^(k-1)))`,
  BASE=500 ms, CAP=8000 ms.
- Yanıtta `Retry-After: <saniye>` başlığı varsa o tekrarın beklemesi
  **en az** `Retry-After` kadardır (`max(jitter, retryAfter)` hedeflenir;
  kütüphane kısıtı gereği `retryAfter + jitter` da kabul edilir — "en az" garantisi esastır).
- Zaman aşımı: istek toplamı ≤ **30 sn**; bağlantı aşaması dil olanağına göre ≤ 10 sn.
- İptal (AbortSignal / CancellationToken) beklemeleri de anında keser.

## 4. Gaz (istemci tarafı throttle)

Xurrent sınırı 20 istek / 2 sn → istekler arası **≥ 110 ms**, ADAPTÖR seviyesinde
(retry tekrarları dahil her HTTP isteği bu kapıdan geçer). Bulk döngülerinde ayrıca
bekleme YOKTUR — gaz tek yerde yaşar. `x-ratelimit-*` başlıkları yakalanır ve
`xurrent_whoami` çıktısında raporlanmaya devam eder.

## 5. Idempotency ve dedup

- Her Yol A yazması `source="xurrent-mcp"` + deterministik
  `sourceID = "xmcp-" + sha256(targetType|targetId|minutes|date|startedAt|personId|description)[:16]` taşır.
  Aynı istek aynı anahtarı üretir — tekrar çalıştırma tespit edilebilirdir.
- **Yazma öncesi dedup:** dryRun=false ve plan `timeEntryCreate` ile başlıyorsa, önce
  `timeEntries(filter: sourceID)` geri-okuması yapılır. Kayıt varsa yazma ATLANIR,
  sonuç `deduped` olarak işaretlenir ve mevcut kayıt döndürülür.
- **Bulk tekrar-çalıştırma güvencesi:** kısmen başarısız bir bulk, AYNI komutla tekrar
  çalıştırıldığında yazılmış kalemler `deduped`, eksikler `created` olur; çift kayıt oluşmaz.
  (Bulk zaten atomik değildir — kurtarma yolu budur.)
- `deduped` sözleşmede görünür: `WriteResult.deduped` (opsiyonel boolean), bulk
  `results[].status` enum'unda `"deduped"`, bulk `summary.deduped` (opsiyonel sayaç).

Kenar durum kararları (üç dilde aynı):
- **Tanım:** `deduped=true` yalnız "yazma HİÇ yapılmadı, mevcut kayıt döndü" demektir.
  Belirsiz-hata sonrası geri-okumada kayıt bulunursa yazma GERÇEKLEŞMİŞTİR →
  sonuç başarıdır, `deduped=false` kalır (iz `[dedup] hit=true` yine düşer).
- **Geri-okuma maliyeti:** yazma-öncesi dedup, canlıda her Yol A yazmasına +1 sorgu
  ekler (`hit=false` izi normal akışta da görünür). Bilinçli takas: bir sorgu,
  bir çift kayıttan ucuzdur. `dryRun=true`'da geri-okuma YAPILMAZ.
- **Geri-okuma başarısızlığı fail-open'dır:** dedup sorgusu düşerse yazma uyarıyla
  devam eder (guarded_create'in kendi belirsiz-hata koruması ayrıca yürürlüktedir).
- **`summary.totalMinutes` bu koşuda YAZILAN dakikaları sayar** — `deduped`
  kalemlerin dakikaları dahil edilmez.
- `summary.deduped` ve `WriteResult.deduped` 0/false iken de açıkça yazılır
  ("alan yok" ile "dedup olmadı" ayrımı kaybolmasın).

## 6. Gözlemlenebilirlik — retry izi

Her tekrar ve her dedup kararı **stderr**'e, üç dilde BİREBİR AYNI biçimle yazılır
(senaryo koşucusu bu satırları sayarak politikayı doğrular; stdout MCP stdio'da yasaktır):

```
[retry] op=<path|query> attempt=<k>/<max> reason=<429|5xx|network> waitMs=<tamsayı>
[dedup] op=timeEntryCreate sourceID=<sid> hit=<true|false>
```

## 7. Yapılandırma

| Env | Varsayılan | Anlamı |
|---|---|---|
| `XURRENT_RETRY_MAX_ATTEMPTS` | `5` | Toplam deneme (1 = retry kapalı) |
| `XURRENT_RETRY_BASE_MS` | `500` | Backoff tabanı |
| `XURRENT_RETRY_CAP_MS` | `8000` | Tek beklemenin tavanı |
| `XURRENT_MIN_REQUEST_GAP_MS` | `110` | Adaptör gazı |

## 8. Kütüphane eşlemesi

Politika tek, kütüphane üç — "dil bir detaydır" tezinin güvenilirlik ayağı:

| | TypeScript | Python | C# |
|---|---|---|---|
| Kütüphane | `p-retry` | `tenacity` | `Polly` v8 (`Polly.Core`) |
| Backoff+jitter | `minTimeout/factor/randomize` | özel `wait` (jitter+Retry-After `max`'ı) | `DelayGenerator` (tam kontrol) |
| Retry-After | `onFailedAttempt` içinde ek bekleme (toplam ≥ Retry-After) | özel `wait` | `DelayGenerator` |
| Sınıf filtresi | `shouldRetry` | `retry_if_exception` | `ShouldHandle` |

## 9. D14–D16 — AÇILDI ve KAPATILDI (2026-08-06, resmî dokümantasyonla)

- **D14 ✅** — GraphQL `TimeEntryFilter`'da `sourceID` **VAR** (`StringFilter`; `source`
  ve `person`/`date` filtreleriyle birlikte belgeli). REST tarafında da `sourceID`
  filtrelenebilir alan listesindedir. Dedup geri-okuması resmen desteklenen yola dayanıyor.
  Kaynak: developer.xurrent.com/graphql/input_object/timeentryfilter · /v1/time_entries.
- **D15 ✅** — `Retry-After` birimi **SANİYE**: dokümandaki 429 örneği `retry-after: 30`.
  Kaynak: developer.xurrent.com/v1 → Rate limiting. (`source` ≤30, `sourceID` ≤128
  karakter sınırları da aynı doğrulamada belgelendi; `xmcp-…` anahtarımız 21 karakter.)
- **D16 ✅** — Limit **kullanıcı başına istek sayacı** olarak belgelidir ve 429 yanıtı
  işlem çıktısı değil düz `Too Many Requests` gövdesidir — sayaç-bazlı ön kapı davranışı.
  Politika bu sonuca zaten dayanıklıydı (429 her sınıfta güvenli tekrar); canlı smoke
  isteğe bağlı teyittir, ön koşul değildir.
