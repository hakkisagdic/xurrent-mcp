# 15 — Güvenilirlik: retry, dedup ve "kesin mesajlaşma"

> **Bölüm hedefi:** Aynı HTTP hatasının neden bir operasyonda güvenle
> tekrarlanıp başka bir operasyonda **çift kayıt** ürettiğini anlamak; retry'ın
> transportun değil **operasyonun** özelliği olduğunu üç dilde üç farklı
> kütüphaneyle kanıtlamak; ve "bulk yarıda kesildi, şimdi ne olacak?" sorusuna
> komut satırından cevap verebilmek.

| ← Önceki | Sonraki → |
|---|---|
| [14 — Test ve kalite](14-test-ve-kalite.md) | [16 — REST ve resmî SDK](16-rest-ve-sdk.md) |

Politika metni: [`contract/reliability.md`](../contract/reliability.md) — tek kaynak.
Kanıt: `tools/fake-xurrent/senaryolar.mjs` → **(f)** ve **(g)**.

> 🎤 **Anlatım notu:** Bu bölüme şu soruyla girin: *"429 aldınız. Tekrar
> denemeli misiniz?"* Salon "evet" diyecektir. Sonra: *"500 aldınız ve istek bir
> `requestUpdate` idi. Tekrar denemeli misiniz?"* Sessizlik, dersin kancasıdır.

---

## Problem: retry masum bir kelime değil

Rate limit gerçek: Xurrent 20 istek / 2 saniye sınırı koyar, aşarsanız
**429 + `Retry-After`** alırsınız. Refleks bellidir — "retry kütüphanesi tak,
geç". Bu projede o refleks **veri bozar**:

- `requestUpdate` / `taskUpdate` içindeki `timeSpent` **ARTIMLIDIR**: "toplamı
  bu yap" değil, "üzerine ekle" demektir.
- Bu mutation'lar **idempotency anahtarı kabul etmez** (input'ta `source` /
  `sourceID` yoktur — o alanlar yalnız `timeEntryCreate`/`timeEntryUpdate`'te var).
- Yani: 500 aldınız ama sunucu isteği aslında İŞLEDİYSE, köre köre tekrar =
  **aynı sürenin iki kez sayılması.** Ve bunu fark edecek bir anahtar da yok.

Aynı 500'ü bir sorguda alsanız hiç düşünmeden tekrarlarsınız — yan etkisi yok.
Demek ki karar HTTP koduna değil, **operasyonun doğasına** bakıyor.

> 🎤 **Anlatım notu:** "Retry transportun değil, operasyonun özelliğidir"
> cümlesini tahtaya yazın — bölümün eve götürülecek tek cümlesi budur.

## Hata sınıflandırması: üç sınıf, üç kader

| Sınıf | Ne | Karar |
|---|---|---|
| **kesin-işlenmedi** | `429` | Rate limiter isteği işlemeden reddetti → **herkes** tekrarlayabilir. Parent update bile. |
| **belirsiz** | `5xx`, ağ hatası, zaman aşımı | İstek işlenmiş **olabilir** → operasyona bak (aşağıda). |
| **kesin-reddedildi** | öteki `4xx`, GraphQL `errors`, payload iş-kuralı hatası | Sunucu anladı ve reddetti → tekrar aynı reddi üretir. **Asla.** |

Belirsiz sınıfta operasyon tablosu:

| Operasyon | Belirsiz hatada | Neden |
|---|---|---|
| sorgular | retry | Yan etkisiz. |
| `timeEntryUpdate` | retry | Mutlak SET — tekrarı zararsız. |
| `timeEntryCreate` | **önce dedup geri-okuması**, yoksa retry | `sourceID` var ama Xurrent'ta unique kısıtı YOK: kör retry çift yazar. Önce "yazılmış mı?" diye sor. |
| `requestUpdate` vb. | **asla** | Artımlı + anahtarsız. Kullanıcıya söylenir: *"kayıt oluşmuş olabilir, ticket'a bakın."* |

İki sonuç, ikisi de ders:

1. **two_step'in 1. adımı retry edilemez.** Ticket bağını kuran adım tam da
   korumasız olan adımdır. (Yol B'nin bedeli bir kez daha.)
2. **Dedup yalnız Yol A'da mümkündür.** Yol B'nin koruması dedup değil,
   retry YASAĞIDIR — asimetri API modelinden gelir, bizden değil.

## Bekleme: üstel geri çekilme + tam jitter

k'ıncı tekrar öncesi bekleme: `rastgele(0, min(8000, 500·2^(k-1)))` ms; toplam
5 deneme. `Retry-After` başlığı varsa o tekrarın beklemesi **en az** o kadardır.
Neden jitter: aynı anda düşen N istemci, jitter'sız backoff'ta aynı anda geri
döner ve sunucuyu tekrar devirir ("thundering herd").

Ayarlar `.env` ile: `XURRENT_RETRY_MAX_ATTEMPTS` (1 = kapalı),
`XURRENT_RETRY_BASE_MS`, `XURRENT_RETRY_CAP_MS`, `XURRENT_MIN_REQUEST_GAP_MS`
(adaptör gazı — 110 ms; artık üç dilde de adaptör seviyesindedir, bulk
döngülerinde elle konmuş bekleme kalmamıştır).

## Dedup: "kesin mesajlaşma"nın gerçek adı

Dağıtık sistemlerde "tam-bir-kez teslim" doğrudan satın alınamaz; satın
alınabilen şudur: **en-az-bir-kez teslim + alıcıda tekilleştirme**. Bizde:

- Her Yol A yazması deterministik bir anahtar taşır:
  `sourceID = "xmcp-" + sha256(hedef|dakika|tarih|saat|kişi|açıklama)[:16]`.
  Aynı girdi → aynı anahtar. (`source="xurrent-mcp"` ile birlikte — Xurrent'ın
  kendi entegrasyon-kimliği alanları, tam bu amaç için.)
- `dryRun=false` bir Yol A planında yazmadan önce sunucuya sorulur:
  *bu `sourceID` ile kayıt var mı?* Varsa yazma **atlanır**, sonuç
  `deduped` işaretlenir, mevcut kayıt döndürülür.
- Bulk'ta bu kalem başına yapılır. Yarıda kesilen bulk'ın kurtarması bu yüzden
  tek cümledir: **aynı komutu tekrar çalıştır.** Yazılmışlar `deduped`,
  eksikler `created` olur; çift kayıt oluşmaz.

> 🎤 **Anlatım notu:** Burada durup vurgulayın: bulk'ı "atomik olmadığı için"
> eleştirmiştik (docs/02). Atomikliği API vermiyor; biz de onu taklit etmiyoruz —
> yerine **güvenli tekrar** koyuyoruz. Dağıtık sistemlerde dürüst cevap budur.

## Gözlemlenebilirlik: iz olmadan iddia olmaz

Her tekrar ve her dedup kararı `stderr`'e, üç dilde **birebir aynı** biçimle düşer:

```
[retry] op=timeEntryCreate attempt=2/5 reason=429 waitMs=1042
[dedup] op=timeEntryCreate sourceID=xmcp-3f9a1c22e07b44d1 hit=true
```

Neden stderr: stdio modunda stdout MCP kanalıdır — oraya yazılan tek karakter
protokolü bozar (bkz. docs/14, stdout saflığı). Neden tek biçim: senaryo
koşucusu bu satırları **sayarak** politikayı doğrular; üç dil üç format
kullansaydı kanıt üç ayrı regex'e bölünür ve sessizce çürürdü.

## Kanıt: kaos senaryoları

Sahte Xurrent'a bayrakla arıza enjekte edilir (`--kaos-429`, `--kaos-kir-desc`,
`--tohum` ile deterministik — bkz. `tools/fake-xurrent/README.md`):

| Senaryo | Düzenek | İddia |
|---|---|---|
| **(f)** 429 fırtınası | Sonraki 3 istek 429 + `retry-after: 1` | Yazma yine başarılı; stderr'de `reason=429` izleri var; sahte sunucuda o kayıttan **tam 1 adet** |
| **(g)** kısmi bulk | Bir kalem `--kaos-kir-desc` ile kalıcı kırık | 1. koşu: `created=3 failed=1`. Kaos kapatılıp **aynı komut** tekrar: `created=1 deduped=3`. Sonda 4 kalem × 1 kayıt — çift yok |

Senaryo koşucusu istemcinin raporuna güvenmez; sahte sunucuya **doğrudan**
sorgu atıp kayıtları kendisi sayar. (Karneyi öğrenciye yazdırmıyoruz.)

## Üç dil, üç kütüphane, tek politika

| | TypeScript | Python | C# |
|---|---|---|---|
| Kütüphane | `p-retry` | `tenacity` | `Polly` v8 |
| Politikanın yaşadığı yer | `src/xurrent/retry.ts` | `xurrent/retry.py` | `Xurrent/RetryPolicy.cs` |
| Retry-After | `onFailedAttempt` içinde ek bekleme | özel `wait` çağrılabiliri | `DelayGenerator` |

Üç kütüphane üç farklı API sunar; **politika sabitleri ve iz formatı aynıdır**.
"Dil bir detaydır" tezinin güvenilirlik ayağı: sözleşme `contract/reliability.md`'de,
diller onun altında.

> 🎤 **Anlatım notu:** Kapanışta senaryo (g)'yi CANLI koşun — `--dil ts` ile
> 30 saniye sürer. `created=3 failed=1` → `created=1 deduped=3` geçişini ekranda
> görmek, bu bölümün bütün teorisinden daha kalıcıdır.

## DOĞRULANMALI (gerçek tenant'ta)

- **D14** — `TimeEntryFilter`'da `sourceID` filtresi gerçekten var mı? (Dedup
  geri-okuması buna dayanır; yoksa kişi+tarih sorgusu + istemci tarafı eşleşmeye düşülür.)
- **D15** — `Retry-After` birimi saniye mi? (Saniye varsayıldı.)
- **D16** — Gerçek 429, mutation işlenmeden **önce** mi kesiyor? (Rate limiter'ın
  ön-kapıda olduğu varsayıldı; değilse 429 da "belirsiz" sınıfına iner.)
