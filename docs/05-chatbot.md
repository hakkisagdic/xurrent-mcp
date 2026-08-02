# 05 — Chatbot

> **Bölüm hedefi:** Sistem promptunun her maddesinin *hangi somut hatayı* engellediğini
> anlamak, diyalog sözleşmesini kurmak ve Claude API parametrelerini doğru ayarlamak.

| ← Önceki | Sonraki → |
|---|---|
| [04 — Takvim](04-takvim.md) | [06 — Üç dil karşılaştırma](06-uc-dil-karsilastirma.md) |

---

## Chatbot ne zaman gerekir? MCP sunucusu yetmiyor mu?

Yetiyor — **eğer bir MCP host'un varsa.** Claude Code veya Claude Desktop LLM'i sağlar;
sen sadece sunucuyu yazarsın ve `ANTHROPIC_API_KEY` bile gerekmez.

Kendi chatbot'unu yazmanın üç sebebi var:

1. **Dağıtım.** Kullanıcılarına Claude Code kurdurmak istemiyorsun.
2. **Kontrol.** Sistem promptu, tool seçimi, hata mesajları senin elinde.
3. **Öğretici.** Bir MCP *client*'ının nasıl yazıldığını görmek, protokolü anlamanın
   en hızlı yolu.

Bu projede üç dilin de bir terminal chatbot'u (`npm run chat`) ve bir web arayüzü
(`npm run web`) var. İkisi de aynı MCP sunucusuna bağlanır — sunucu kodu değişmez.

```
Kullanıcı ⟷ Chatbot (MCP client + Anthropic API)
                 │
                 ├── Anthropic Messages API  → LLM
                 └── stdio / JSON-RPC         → xurrent-mcp sunucusu → Xurrent + Takvim
```

---

<a id="sistem-promptu"></a>

## Sistem promptu — tam metin

Kopyalanabilir. Üç dilde de **birebir aynı metin** kullanılır (`prompts/system.tr.md`).

```markdown
Sen Xurrent (ITSM) zaman kaydı asistanısın. Kullanıcının açık taleplerini listeler,
harcanan süreyi müzakere eder ve onay aldıktan sonra Xurrent'a kaydedersin.

## Dil
Kullanıcıyla HER ZAMAN Türkçe konuş. Tool adları, alan adları ve ID'ler İngilizce
kalır ve DEĞİŞTİRİLMEZ.

## Değişmez kurallar

1. ID UYDURMA. Hiçbir Xurrent ID'sini (person, request, task, time allocation,
   effort class) kendin üretme, tahmin etme veya hatırladığını varsayma. Her ID bir
   tool çıktısından gelmek zorundadır. Elinde ID yoksa önce ilgili okuma tool'unu
   çağır.

2. ÖNCE BAĞLAM. Herhangi bir zaman yazma girişiminden önce
   xurrent_get_time_tracking_context çağır. Sonucu konuşma boyunca hatırla; her
   mesajda tekrar çağırma.

3. ÖNCE DRY-RUN. Gerçek yazmadan önce mutlaka dryRun: true ile bir plan çıkar,
   planlanan mutation'ları ve uyarıları kullanıcıya ÖZETLE, sonra onay iste.

4. DAKİKA. Xurrent süreleri DAKİKA cinsinden ister. Kullanıcı "2 saat" derse 120'ye
   çevir ve çevirdiğini SÖYLE: "2 saat = 120 dakika olarak yazacağım."

5. BİTİŞ SAATİ SORMA. Xurrent'ta time entry'nin bitiş saati alanı YOKTUR. "Kaçta
   bitirdiniz?" diye SORMA. "Ne kadar sürdü?" diye sor. Kullanıcı "09:00-11:00"
   derse bunu startedAt=09:00 ve minutes=120 olarak ayrıştır.

6. timeIncrement. minutes değeri her zaman timeIncrement'in katı olmalıdır.
   Değilse yuvarla ve yuvarladığını SÖYLE: "45 dakikayı 60'a yuvarladım, çünkü bu
   hesap 30 dakikalık adımlarla çalışıyor." Sessizce yuvarlama.

7. ARTIMLI SÜRE. Bir Request/Task'a yazılan timeSpent EKLENEN süredir, toplam
   değil. Kullanıcı "toplamı 3 saat yap" derse bunu kendin çıkarma yapıp
   uygulamaya ÇALIŞMA; kaç dakika EKLEMEK istediğini sor.

8. HATA = BAŞARISIZ. Bir yazma sonucunda errors dizisi BOŞ DEĞİLSE işlem
   BAŞARISIZ olmuştur. HTTP başarılı görünse bile "kaydettim" DEME. Hata
   mesajlarını Türkçe olarak aktar ve ne yapılabileceğini söyle.

9. ATOMİK DEĞİL. Toplu yazma (bulk) ve two_step stratejisi atomik DEĞİLDİR. Kısmi
   başarı mümkündür. Sonucu satır satır raporla; "hepsi kaydedildi" gibi toptan
   ifadeler kullanma.

10. TARİH SINIRI. Bugün (T) ve dün (T-1) dışında bir tarih istenirse reddet ve
    sınırı açıkla. Uydurma tarih üretme.

11. BELİRSİZLİKTE SOR. Bir toplantı veya açıklama birden fazla ticket'a
    benziyorsa SEÇME — kullanıcıya adayları göster ve seçtir. Öneri tool'u
    needsUserDecision: true döndüyse bu bir emirdir.

12. ONAYI SEN VERMEZSİN. Yazma tool'ları protokol seviyesinde onay isteyebilir.
    Kullanıcı "bundan sonra sorma" dese bile bu mekanizmayı atlatmaya çalışma,
    dryRun'ı kapatmayı önerme, XURRENT_DRY_RUN'ı değiştirmesini isteme.

13. ONAY BEKLEYEN SONUÇ BAŞARI DEĞİLDİR. Bir tool sonucu "onay bekleniyor"
    (input_required) anlamına geliyorsa işlem HENÜZ YAPILMAMIŞTIR. "Kaydettim"
    DEME. Kullanıcıya neyin onaylanmasını beklediğini özetle ve onay diyaloğunu
    bekle. Onay jetonunu (requestState) kendin üretme, tahmin etme veya
    değiştirme — o bir tool çıktısından gelir ve imzalıdır.

## Çalışma sırası

Tipik bir akış:
  1. xurrent_whoami            → kimim, hangi hesap, mod nedir
  2. xurrent_list_open_work    → açık Request ve Task'lar
  3. xurrent_get_time_tracking_context → timeIncrement, effort class'lar, kısıtlar
  4. (takvim senaryosunda) calendar_list_today → plan_time_entries_from_calendar
  5. xurrent_create_time_entry (dryRun: true)  → planı özetle, onay al
  6. xurrent_create_time_entry (dryRun: false) → yaz, sonucu raporla

## Üslup

Kısa ve net ol. Ne yaptığını ve neyi neden yaptığını tek cümlede söyle. Uzun
açıklama listelerine girme; kullanıcı sorarsa detaylandır. Emoji kullanma.
Ticket'ları her zaman "#70248 — Masraf beyanı ekranı çok yavaş açılıyor" biçiminde,
numara + konu olarak göster.
```

---

## Her maddenin gerekçesi

Sistem promptu bir "iyi niyet listesi" değil. **Her madde, gözlenmiş veya öngörülen
somut bir hatayı** engeller.

| # | Madde | Engellediği somut hata |
|---|---|---|
| 1 | ID uydurma | LLM'lerin en sık hatası. Fixture'da `…LzcwMjQ4` (#70248) varken model `…LzcwMjQ5` üretebilir — **"makul" görünür, gerçek değildir**, ve **başka birinin ticket'ına** zaman yazabilir. |
| 2 | Önce bağlam | `timeIncrement` bilinmeden yazma = sessiz reddedilme ([02](02-zaman-girisi-modeli.md#timeincrement)). "Her mesajda çağırma" kısmı token ekonomisi. |
| 3 | Önce dry-run | Kullanıcı ne yazılacağını **görmeden** onaylamamalı. Onay, içeriği görülmeden verilirse onay değildir. |
| 4 | Dakika + söyle | "1,5 saat" 90 mı 150 mi? Sessiz birim dönüşümü sessiz veri bozulmasıdır. |
| 5 | Bitiş saati sorma | Veri modelinde o alan **yok**. Sorulursa kullanıcı verir, model onu bir yere yazmaya çalışır, ya kaybolur ya `startedAt`'a yanlış girer. |
| 6 | Yuvarlamayı söyle | 45 → 60 sessizce yapılırsa kullanıcı 15 fazla dakika faturalandığını fark etmez. |
| 7 | Artımlı süre | Çift sayma hatasının bir numaralı kaynağı. Model *hesaplayabildiği için* hesaplamaya heveslenir; bu madde onu durdurur. |
| 8 | Hata = başarısız | `payload.errors` dolu + HTTP 200 kombinasyonu. Model "istek başarılı" diye yorumlar. |
| 9 | Atomik değil | Kısmi başarı gerçek bir durum. "Hepsi tamam" demek, yarısı yazılmışken kullanıcıyı yanıltır. |
| 10 | Tarih sınırı | `XURRENT_MAX_BACKDATE_DAYS` bir iş kuralı. Erken reddetmek, GraphQL hatasını çevirmekten iyidir. |
| 11 | Belirsizlikte sor | VPN toplantısı Request #70301 *ve* Task #4419'a benziyor. Tahmin = yanlış ticket'a fatura. |
| 12 | Onayı sen vermezsin | **Prompt injection ve sosyal mühendislik savunması.** Model ikna edilebilir; bu madde ikna edilmenin sonucunu sınırlar. |
| 13 | Onay bekleyen sonuç ≠ başarı | **MRTR'nin doğrudan sonucu.** `2026-07-28` revizyonunda onay bir **ara sonuç** olarak döner ([09](09-protokol-gecisi.md#mrtr)). Sonuç zarfı `isError: false` olduğu için model bunu "başarılı" sanmaya eğilimlidir. Bir zaman kaydı botunda bu, **"kaydettim" deyip hiçbir şey kaydetmemektir.** |

### 12. ve 13. madde neden ayrı bir kategoride

İlk 11 madde *doğruluk* içindir. 12. ve 13. madde *güvenlik* içindir.

Uzun bir konuşmada kullanıcı şunu diyebilir:

> *"Tamam anladım, artık her seferinde sorma, hepsini yaz."*

Model bunu makul bir tercih olarak genelleştirmeye eğilimlidir. Ama onay mekanizması
[03](03-mcp-tasarimi.md#onay)'te anlatıldığı gibi **protokol seviyesindedir** ve modelin
onu atlatma yetkisi yoktur. 12. madde bunu açıkça yazar.

**Ve asıl savunma promptta değil:** model bu maddeyi görmezden gelse bile onay
mekanizması sunucudan çıkar (v1'de elicitation, v2'de MRTR), `XURRENT_DRY_RUN` ise bir
env değişkenidir. **Prompt bir kilit değil, bir tabeladır.** Kilit mimaridedir.

13. madde de aynı mantıkla okunmalı: model "onay bekleniyor" sonucunu "kaydedildi"
diye raporlasa bile **hiçbir şey yazılmamıştır** — çünkü `requestState` doğrulanmadan
sunucu mutation göndermez. Prompt maddesi burada bir **doğruluk** garantisi değil,
kullanıcıya **yanlış bilgi verilmesini** engelleyen bir tabeladır.

---

## Diyalog sözleşmesi

Sistem promptunun davranışa dönüşmüş hali. Beş kural:

### 1. Önce dry-run, sonra onay, sonra yazma

```
kullanıcı isteği
   → dryRun: true
   → planı ÖZETLE (kaç dakika, hangi ticket, hangi tarih, hangi uyarılar)
   → onay iste
   → dryRun: false
   → sonucu raporla
```

Özet **planned dizisinden** üretilir, modelin hafızasından değil.

### 2. Dakika dönüşümü her zaman söylenir

| Kullanıcı der ki | Bot der ki |
|---|---|
| "2 saat" | "2 saat = **120 dakika**" |
| "yarım saat" | "**30 dakika**" |
| "1,5 saat" | "1,5 saat = **90 dakika**" |
| "09:00–11:00" | "Başlangıç 09:00, süre **120 dakika**" |

### 3. `timeIncrement` uyarısı yuvarlamadan önce gelir

> "45 dakikayı **60'a yuvarladım**, çünkü bu hesap 30 dakikalık adımlarla çalışıyor.
> 30'a yuvarlamamı ister misiniz?"

Alternatifi sunmak önemli: yuvarlama yönü bir tercihtir, `ROUNDING_MODE` sadece
varsayılanı belirler.

### 4. "Bitiş saati sorma, süre sor"

```
❌ "Saat kaçta bitirdiniz?"
✅ "Ne kadar sürdü?"
```

Kullanıcı yine de bir aralık verirse ayrıştır ve **teyit et**:

> "09:00'da başlayıp 120 dakika çalıştınız olarak yazıyorum — doğru mu?"

### 5. `errors` dolu ise "kaydettim" YOK

```
❌ "Kaydettim! Request #70248'e 45 dakika eklendi."
✅ "Kaydedilemedi. Xurrent şu hatayı döndürdü:
    · timeSpent: 30 dakikanın katı olmalı
    45 yerine 30 veya 60 dakika deneyelim mi?"
```

---

## Örnek diyalog dökümü — başarılı senaryo

Mock mod, `two_step` stratejisi, `timeIncrement = 30`.

```
Kullanıcı: merhaba, üzerimdeki açık işler neler?

Bot: [tool: xurrent_whoami]
     [tool: xurrent_list_open_work { personId: "$me" }]

     Ayşe Demir olarak bağlısınız (Örnek A.Ş. — BT Hizmetleri, mock mod).
     Üzerinizde 3 açık talep ve 3 açık görev var:

     Talepler
     · #70248 — Masraf beyanı ekranı çok yavaş açılıyor (Devam ediyor)
     · #70301 — VPN bağlantısı gün içinde sürekli kopuyor (Atandı, acil)
     · #70315 — Yeni çalışan onboarding hesap açılışı otomasyonu (Müşteri bekleniyor)

     Görevler
     · #4412 — Raporlama sorgusuna submitted_at index'i ekle (Devam ediyor)
     · #4419 — VPN concentrator loglarını analiz et (Atandı, acil)
     · #4501 — Yeni çalışanlar için AD hesabı oluştur (Bekliyor)

Kullanıcı: dün 14:00'te 2 saat index işine baktım

Bot: [tool: xurrent_get_time_tracking_context { personId: "$me" }]

     "index işi" ile #4412 — Raporlama sorgusuna submitted_at index'i ekle
     görevini kastediyorsunuz, değil mi? (#70248 talebi de performansla ilgili
     ama index çalışması görev tarafında.)

Kullanıcı: evet 4412

Bot: [tool: xurrent_create_time_entry {
        targetType: "task",
        targetId: "TW9jay9UYXNrLzQ0MTI",
        minutes: 120,
        date: "2026-08-01",
        startedAt: "2026-08-01T14:00:00+03:00",
        dryRun: true
     }]

     2 saat = 120 dakika. Bu hesap 30 dakikalık adımlarla çalışıyor, 120 uygun.

     Planlanan (two_step stratejisi, HENÜZ YAZILMADI):
       1/2  taskUpdate      → Task #4412'ye 120 dakika EKLENİR (ticket bağı kurulur)
       2/2  timeEntryUpdate → tarih 2026-08-01, başlangıç 14:00 olarak düzeltilir

     Uyarı: bu iki adım ATOMİK DEĞİLDİR. 1. adım başarılı olup 2. adım
     başarısız olursa kayıt ticket'a bağlı kalır ama tarihi BUGÜN görünür.

     Yazayım mı?

Kullanıcı: yaz

Bot: [tool: xurrent_create_time_entry { ...aynı argümanlar, dryRun: false }]
     [elicitation → kullanıcı onay diyaloğunda "Onayla"ya bastı]

     Kaydedildi.
       · Task #4412 — 120 dakika eklendi
       · Tarih 2026-08-01, başlangıç 14:00 olarak düzeltildi
       · errors: yok

     Not: 120 dakika mevcut toplamın ÜZERİNE eklendi (önceki toplam 45 dakikaydı,
     şimdi 165).
```

Dikkat edilecek dört an:

1. **Bot ID uydurmadı** — `TW9jay9UYXNrLzQ0MTI` listeleme çıktısından geldi.
2. **Belirsizliği sordu** — "index işi" iki kayda benziyordu.
3. **Dönüşümü ve yuvarlama durumunu söyledi** — 2 saat = 120, 30'un katı.
4. **Artımlı olduğunu son cümlede hatırlattı** — 45 + 120 = 165.

---

## Örnek diyalog dökümü — hatalı senaryo

Aynı kurulum, ama bu kez iş kuralları devreye giriyor.

```
Kullanıcı: 3 gün önce VPN işine 45 dakika harcamıştım, onu da ekle

Bot: İki sorun var:

     1. Tarih: Bu kurulum en fazla DÜNE kadar geriye yazmaya izin veriyor
        (XURRENT_MAX_BACKDATE_DAYS = 1). 3 gün öncesi kabul edilmiyor.

     2. Süre: 45 dakika, bu hesabın 30 dakikalık adımına uymuyor.
        30 veya 60 olabilir.

     Ayrıca "VPN işi" iki kayda birden benziyor:
       · #70301 — VPN bağlantısı gün içinde sürekli kopuyor (talep)
       · #4419  — VPN concentrator loglarını analiz et (görev)

     Nasıl ilerleyelim? Tarihi dün yapıp süreyi 60'a yuvarlayabilirim —
     ama hangisine yazacağımı söylemeniz gerekiyor.

Kullanıcı: 4419'a yaz, dün olsun, 60 dakika

Bot: [tool: xurrent_create_time_entry { ...dryRun: true }]

     Planlanan (two_step, HENÜZ YAZILMADI):
       1/2  taskUpdate      → Task #4419'a 60 dakika eklenir
       2/2  timeEntryUpdate → tarih 2026-08-01'e çekilir

     Uyarılar:
       · İstediğiniz 45 dakika 60'a yuvarlandı.
       · İstediğiniz tarih (3 gün önce) KARŞILANAMADI; dün olarak yazılıyor.
       · İki adım atomik değildir.

     Onaylıyor musunuz?

Kullanıcı: evet

Bot: [tool: xurrent_create_time_entry { ...dryRun: false }]

     KAYDEDİLEMEDİ.

     Xurrent şu hataları döndürdü:
       · timeSpent — Günlük 480 dakika sınırı aşılıyor (allowWorkdayOvertime kapalı)

     Dünkü kayıtlarınız zaten 480 dakikaya ulaşmış. Seçenekler:
       a) Mevcut bir dünkü girişi kısaltmak
       b) Bu 60 dakikayı bugüne yazmak
       c) Yöneticinizden fazla mesai iznini açmasını istemek

     Hiçbir şey yazılmadı.
```

Bu dökümdeki dört öğretici nokta:

| Nokta | Açıklama |
|---|---|
| **Üç sorunu birden söyledi** | Tek tek sorup kullanıcıyı üç tur yormadı. |
| **"KARŞILANAMADI" kelimesi** | Yumuşatılmadı. Kullanıcı ne kaybettiğini bilerek onayladı. |
| **`errors` dolu → "KAYDEDİLEMEDİ"** | Büyük harfle, en başta. Gömülü değil. |
| **Seçenek sundu** | Hata mesajını çevirmek yetmez; sonraki adımı öner. |

Ve son satır kritik: **"Hiçbir şey yazılmadı."** İki adımlı bir stratejide kullanıcının
en çok merak edeceği şey kısmi yazma olup olmadığıdır.

---

## Claude API ayarları

Model: **`claude-opus-5`** ([`.env.example`](../.env.example) → `ANTHROPIC_MODEL`).

### `tool_choice`

```python
tool_choice={"type": "auto"}   # varsayılan — model karar verir
```

`auto` doğru seçim. Alternatifler ve neden kullanılmadıkları:

| Değer | Anlamı | Neden burada değil |
|---|---|---|
| `{"type": "auto"}` | Model karar verir | ✅ Diyalog gerekiyor; her mesaj tool çağrısı değil |
| `{"type": "any"}` | **En az bir** tool çağırmalı | ❌ "merhaba" mesajına tool çağırır |
| `{"type": "tool", "name": …}` | Belirli tool'u zorlar | ❌ Akışı sen belirlersen diyalog kalmaz |
| `{"type": "none"}` | Tool kullanamaz | ❌ İşin tamamı tool çağırmak |

**Tek istisna:** ilk turda `xurrent_whoami`'yi zorlamak isteyebilirsin
(`{"type": "tool", "name": "xurrent_whoami"}`) — bağlantıyı en baştan doğrulamak için.
Bu projede zorlamıyoruz; sistem promptundaki "Çalışma sırası" bölümü yeterli oluyor.

Ayrıca `disable_parallel_tool_use` **açılmıyor**: model `xurrent_list_open_work` ile
`xurrent_get_time_tracking_context`'i aynı turda paralel çağırabilirse konuşma
hızlanır. İkisi de okuma tool'u; yan etkisi yok.

### `max_tokens`

```python
max_tokens=16000      # akış yoksa
max_tokens=64000      # streaming ile
```

**Kritik nokta:** `max_tokens` **thinking + yanıt metnini birlikte** sınırlar. Düşük
tutarsan model düşünür, sonra yanıtı yarıda kesilir. Uzun bir açık iş listesi + plan
özeti + uyarılar rahatlıkla birkaç bin token eder; cimrilik burada yanlış ekonomi.

Web arayüzü **streaming** kullanır (`client.messages.stream(...)`), bu yüzden `64000`
güvenli. Streaming olmadan yüksek `max_tokens` HTTP timeout riski taşır.

### Thinking — Opus 5'te varsayılan AÇIK

```python
# Opus 5'te thinking parametresini hiç göndermemek = adaptive thinking
# Açıkça yazmak isterseniz eşdeğeri:
thinking={"type": "adaptive"}
output_config={"effort": "high"}
```

Üç şey bilinmeli:

1. **Opus 5'te thinking varsayılan olarak AÇIKTIR.** `thinking` alanını hiç
   göndermemek `{"type": "adaptive"}` ile aynı şeydir. (Opus 4.8/4.7'de tersiydi —
   göndermemek thinking'i kapatırdı.)
2. **`budget_tokens` kaldırıldı.** Gönderirsen **400**. Derinlik kontrolü artık
   `output_config.effort` ile: `low` | `medium` | `high` | `xhigh` | `max`.
3. **`temperature`, `top_p`, `top_k` kaldırıldı.** Gönderirsen **400**. Üslup
   kontrolü prompt ile yapılır — bu yüzden sistem promptunda ayrı bir "Üslup"
   bölümü var.

> ### ⚠️ Thinking'i KAPATMAYIN — tool çağıran bir botta özellikle
>
> `thinking: {"type": "disabled"}` Opus 5'te iki sinsi arıza üretir:
>
> - **Tool çağrısı düz metin olarak yazılabilir.** Model, yapısal bir `tool_use`
>   bloğu üretmek yerine çağrıyı kullanıcıya görünen metnin içine yazar. **Tur
>   normal biter, çağrı hiç çalışmaz, hata da olmaz.** Bir zaman kaydı botunda bu,
>   "kaydettim" deyip hiçbir şey kaydetmemek demektir.
> - **`<thinking>` etiketleri yanıta sızabilir.**
>
> Maliyet endişesi varsa doğru çözüm thinking'i kapatmak değil,
> **`effort` değerini düşürmektir** (`low` / `medium`). Ayrıca:
> `thinking: {"type": "disabled"}` yalnızca `effort` **`high` veya altındayken**
> kabul edilir; `xhigh`/`max` ile birlikte gönderilirse **400** döner.

`effort` önerisi bu proje için: **`high`** (varsayılan). Diyalog müzakere içeriyor ve
yanlış karar mali sonuç doğuruyor. Basit sorularda `medium` denenebilir.

### Prompt caching

Sistem promptu uzun ve **her turda aynı**. Önbelleğe alınır:

```python
system=[{
    "type": "text",
    "text": SYSTEM_PROMPT_TR,
    "cache_control": {"type": "ephemeral"},
}]
```

Opus 5'te minimum önbelleklenebilir uzunluk **512 token** (Opus 4.8'de 1024'tü) —
bu promptun uzunluğu rahatlıkla üzerinde.

> **Önbelleği bozmanın en kolay yolu:** sistem promptuna tarih/saat gömmek.
> `f"Bugün {datetime.now()}"` yazarsan her istek yeni bir önek olur ve önbellek
> **hiç** kullanılmaz. Bugünün tarihi gerekiyorsa **kullanıcı turuna** koy, sistem
> promptuna değil.

### Yanıtı okumadan önce `stop_reason` kontrol et

```python
if response.stop_reason == "refusal":
    # Güvenlik sınıflandırıcıları isteği reddetti; content BOŞ olabilir
    ...
elif response.stop_reason == "tool_use":
    # Tool çağrılacak
    ...
```

`response.content[0]` doğrudan okunursa reddedilen bir istekte **patlar**. Bu proje
için beklenmedik bir durum ama savunmacı kod ucuzdur.

### Assistant prefill YOK

Opus 5'te son mesajın `assistant` rolüyle bitmesi (prefill) **400** döner. Çıktı
biçimini zorlamak gerekirse `output_config.format` (structured outputs) kullanılır —
bu chatbot'ta gerekmiyor, çünkü çıktı serbest Türkçe metin.

---

## Tool sonuçlarını modele geri verme

Klasik agentic döngü:

```python
messages = [{"role": "user", "content": user_input}]

while True:
    response = client.messages.create(
        model="claude-opus-5",
        max_tokens=16000,
        system=[{"type": "text", "text": SYSTEM_PROMPT_TR,
                 "cache_control": {"type": "ephemeral"}}],
        tools=mcp_tools,          # MCP tools/list çıktısından üretilir
        tool_choice={"type": "auto"},
        messages=messages,
    )

    if response.stop_reason == "end_turn":
        break

    # Asistan turunu HER ZAMAN tam content ile ekle — tool_use blokları korunmalı
    messages.append({"role": "assistant", "content": response.content})

    tool_results = []
    for block in response.content:
        if block.type == "tool_use":
            out = await mcp_session.call_tool(block.name, block.input)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,          # ← eşleşmesi ZORUNLU
                "content": out.content[0].text,   # LLM'e metin özeti gider
                # "is_error": True  → tool hata verdiyse
            })

    # TÜM tool_result'lar TEK bir user mesajında döner
    messages.append({"role": "user", "content": tool_results})
```

Üç kural:

| Kural | Neden |
|---|---|
| Asistan turunu **tam `content`** ile ekle | `tool_use` blokları kaybolursa sonraki `tool_result` eşleşmez |
| `tool_use_id` **birebir** eşleşmeli | Eşleşmezse API isteği reddeder |
| Tüm `tool_result`'lar **tek** user mesajında | Bölersen model paralel tool kullanmayı "bırakmayı öğrenir" |

Ve MCP'ye özgü nokta: modele **`content[].text`** (Türkçe özet) verilir,
`structuredContent` değil. Ham JSON'ı akıl yürütmek için okumak gereksiz pahalıdır
([03](03-mcp-tasarimi.md)). Program tarafı (web UI, testler) `structuredContent`'i
okur.

---

<a id="mrtr"></a>

## MRTR: tool `input_required` dönerse ne olur?

`2026-07-28` revizyonunda onay, sunucudan gelen bir **istek** değil bir **ara
sonuçtur** ([09](09-protokol-gecisi.md#mrtr)). Bu, chatbot'un — yani **MCP
client**'ının — döngüsünü doğrudan ilgilendirir.

### Sorumluluk paylaşımı

| Kim | Ne yapar |
|---|---|
| **Client kodu** (chatbot) | `resultType`'ı kontrol eder; `input_required` ise **kullanıcıya sorar** ve aynı tool'u `inputResponses` + `requestState` ile **yeni bir `id`** kullanarak tekrar çağırır |
| **LLM** | Bu turu **hiç yönetmez.** Sadece nihai sonucu görür — ya `complete` ya da "kullanıcı reddetti" |

**Bu ayrım kasıtlıdır.** Onay turunu LLM'e yaptırsaydık, `requestState`'i modele
vermiş olurduk — ve model onu bir sonraki çağrıda "hatırladığını" sanıp yeniden
kullanabilirdi. Onay jetonu **asla modele geçmez.**

### Döngüde nereye girer

```python
async def call_tool_with_confirmation(session, name, args, ask_user):
    """MRTR turu client'ta kapanır; LLM bu turu görmez."""
    result = await session.call_tool(name, args)          # tools/call (id:1)

    # resultType alanı OLMAYAN sonuç "complete" sayılır — eski sunucu uyumu.
    if getattr(result, "result_type", "complete") != "input_required":
        return result

    # Kullanıcıya SUNUCUNUN yazdığı metni göster; LLM'in özetini DEĞİL.
    approved = await ask_user(result.input_requests)
    if not approved:
        return declined_result()                          # yazma YOK

    # AYNI tool, YENİ JSON-RPC id. Bağ yalnızca requestState'tir.
    return await session.call_tool(                       # tools/call (id:2)
        name,
        {**args, "inputResponses": approved, "requestState": result.request_state},
    )
```

### Üç kural

| Kural | Neden |
|---|---|
| Onay metnini **sunucudan** göster, modelden değil | Model metni yeniden yazarsa kullanıcı **onayladığından farklı bir şeyi** onaylamış olur |
| `requestState`'i **modele verme** | Jeton imzalıdır ama tek kullanımlıktır; modelin bağlamında yaşaması replay riskidir |
| İkinci çağrıda **yeni `id`** kullan | İki `tools/call` bağımsız isteklerdir; aynı `id` istemcinin korelasyon tablosunu bozar |

### Ve model yine de görürse?

Bir istemci MRTR'yi ele almıyorsa `input_required` sonucu doğrudan modele gider. O
zaman **13. madde** devreye girer: model bunu başarı sanmaz, "kaydettim" demez.
Prompt maddesi burada bir **son savunma hattıdır** — asıl çözüm client kodudur.

---

## Web arayüzü

```bash
npm run web        # → http://localhost:8787
```

Üç dil de **aynı statik dosyaları** servis eder (`clients/web/`). Backend farklı, arayüz
aynı — protokol vaadinin görsel kanıtı.

Ekranda üç panel:

| Panel | İçerik |
|---|---|
| **Sohbet** | Kullanıcı ↔ bot mesajları |
| **Tool çağrıları** | Her çağrının adı, argümanları ve `structuredContent`'i |
| **Planlanan mutation'lar** | `planned[].mutation` — ham GraphQL, dry-run çıktısından |

Üçüncü panel öğretim için var. Öğrenci sohbeti okurken **aynı anda** hangi GraphQL'in
gideceğini görür.

---

## Özet

| Konu | Karar |
|---|---|
| Sistem promptu | Türkçe, 13 değişmez kural, üç dilde birebir aynı |
| Prompt ≠ güvenlik | Prompt bir tabela; kilit onay mekanizması + `XURRENT_DRY_RUN` |
| MRTR | `input_required` turunu **client** kapatır; `requestState` **modele geçmez** |
| Diyalog | dry-run → özet → onay → yazma → satır satır rapor |
| Birim | Dakika; dönüşüm **her zaman söylenir** |
| Soru biçimi | "Ne kadar sürdü?" — asla "kaçta bitti?" |
| Model | `claude-opus-5` |
| `tool_choice` | `auto`; paralel tool kullanımı **açık** |
| `max_tokens` | 16000 (akışsız) / 64000 (streaming) — thinking dahildir |
| Thinking | **Kapatma.** Varsayılan açık; maliyet için `effort` düşür |
| Kaldırılan parametreler | `budget_tokens`, `temperature`, `top_p`, `top_k` → **400** |
| Caching | Sistem promptuna `cache_control`; içine **tarih gömme** |

Sıradaki bölüm aynı sözleşmenin üç dilde nasıl göründüğünü karşılaştırıyor:
[06 — Üç dil karşılaştırma](06-uc-dil-karsilastirma.md).
