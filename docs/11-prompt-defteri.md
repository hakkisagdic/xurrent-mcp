# 11 — Prompt defteri

> **Bu dosya üretilmiştir.** Kaynak: [`docs/atolye/adimlar.json`](atolye/adimlar.json).
> Elle düzenleme; `node scripts/gen-prompt-defteri.mjs` ile yeniden üret.

Bu defter, [xurrent-mcp](../README.md) projesini sıfırdan üretmek için sırayla
verilecek prompt'ları içerir. Derste kopyala-yapıştır kullanılmak üzere yazıldı.

---

## Nasıl kullanılır

**Tek oturumda, sırayla.** Prompt'lar birbirinin çıktısına dayanır — 4. adım,
2. adımda bulunan kısıtları bilmek zorundadır. Her prompt'u yeni bir sohbette
çalıştırırsanız bağlam kopar ve sonuç tutmaz.

**Boş bir dizinde başlayın.** İlk prompt kod yazdırmaz; tasarım kararı sorar.

**Her adımdan sonra doğrulayın.** Adımların çoğunda çalıştırılabilir bir doğrulama
komutu var. Geçmeden bir sonrakine geçmeyin — bu dersin yarısı zaten "iddiayı
ölçmeden kabul etme" üzerine.

**Kararları siz verin.** Her adımda bir *karar noktası* var ve seçenekler
listelenmiş. Modelin önerisini onaylamak da bir karardır, ama farkında olarak yapın:
bu projede yanlış çıkan mimari kararlar oldu ve onları ölçüm düzeltti.

### Beklenti yönetimi — dürüst olalım

Bu prompt'ları çalıştırmak bu repoyu **birebir** üretmez. LLM'ler deterministik
değildir; dosya düzeni, değişken adları ve yorumlar farklı çıkar.

Üretmesi gereken şey: **aynı mimari, aynı kısıtlar ve aynı doğrulanabilir sayılar.**
`requests=3`, `tasks=3`, `timeIncrement=30`, takvimde `8→5` etkinlik,
`busyMinutes=225` vs `naiveSumMinutes=255`, `two_step` için `planned.length=2`.
Bu sayılar tutuyorsa doğru şeyi üretmişsinizdir.

Referans uygulama karşılaştırma için hazır:

```bash
node clients/atolye/atolye.mjs --insa ~/atolye-referans
```

### Hangi modelle

Bu repo **Claude Opus 5** ile üretildi. Araştırma adımları (2. adım) web
erişimi olan bir ortam ister. Kod yazan adımlar dosya sistemine yazabilen bir
ortam ister — Claude Code, Cursor, ya da benzeri bir agentic araç.

Prompt'lar tek bir modele bağlı değil, ama "kod yazma, önce cevapla" tipi
kısıtlara uymayan bir model bu dersin tamamını bozar: erken kod yazmak zaten
kaçınmaya çalıştığımız hatanın kendisi.

---

## Adımlar

| # | Adım | Faz | Doğrulama |
|---|---|---|---|
| 01 | [Dört ister, bir soru: bu bir script mi, bir sunucu mu?](#1-dort-ister-bir-soru-bu-bir-script-mi-bir-sunucu-mu) | Keşif — kod yazmadan önce | — |
| 02 | [Beş paralel araştırma kolu, sıfır satır kod](#2-bes-paralel-arastirma-kolu-sifir-satir-kod) | Keşif — kod yazmadan önce | var |
| 03 | [★ İki mutation, aynı iş, farklı yetenekler — ve ister ikisiyle de karşılanmıyor](#3-i-ki-mutation-ayni-is-farkli-yetenekler-ve-ister-ikisiyle-de-karsilanmiyor) | Keşif — kod yazmadan önce | var |
| 04 | [★ Önce sözleşme: tek gerçek kaynak bir JSON dosyası](#4-once-sozlesme-tek-gercek-kaynak-bir-json-dosyasi) | Sözleşme ve veri | var |
| 05 | [Mock veri rastgele değil, öğretici tasarlanır](#5-mock-veri-rastgele-degil-ogretici-tasarlanir) | Sözleşme ve veri | var |
| 06 | [Katmanlar: her katmanın NE BİLMEDİĞİ yazılır](#6-katmanlar-her-katmanin-ne-bi-lmedi-gi-yazilir) | Üç implementasyon | var |
| 07 | [Üç dil paralel — ve üçüncü implementasyon ilk ikisini denetler](#7-uc-dil-paralel-ve-ucuncu-implementasyon-ilk-ikisini-denetler) | Üç implementasyon | var |
| 08 | [Dry-run tek katman değil: parametre, ortam, ve yapısal imkânsızlık](#8-dry-run-tek-katman-degil-parametre-ortam-ve-yapisal-imk-nsizlik) | Üç implementasyon | var |
| 09 | [Sihirbaz: içerik veride, yürütme kodda](#9-sihirbaz-icerik-veride-yurutme-kodda) | Üç implementasyon | var |
| 10 | [★ 28 Temmuz 2026: MCP tam olarak bizim onay akışımızı kaldırdı](#10-28-temmuz-2026-mcp-tam-olarak-bizim-onay-akisimizi-kaldirdi) | Spec iş ortasında değişti | var |
| 11 | [★★ Plan üç projeye bölmekti. Ölçtük; gereksizmiş.](#11-plan-uc-projeye-bolmekti-olctuk-gereksizmis) | Spec iş ortasında değişti | var |
| 12 | [Stateless olmak, state'i saldırgana emanet etmek demek](#12-stateless-olmak-state-i-saldirgana-emanet-etmek-demek) | Spec iş ortasında değişti | var |
| 13 | [★ Aynı hata kodu, iki farklı sebep: sessiz yanlış teşhis](#13-ayni-hata-kodu-iki-farkli-sebep-sessiz-yanlis-teshis) | Kusur avı ve live yolu | var |
| 14 | [★ Doğrulayıcı yeşildi — çünkü yanlış şeyi ölçüyordu](#14-dogrulayici-yesildi-cunku-yanlis-seyi-olcuyordu) | Kusur avı ve live yolu | var |
| 15 | [★ Hesap yoksa live yolu nasıl test edilir?](#15-hesap-yoksa-live-yolu-nasil-test-edilir) | Kusur avı ve live yolu | var |
| 16 | [Yayın: mantıksal commit'ler ve neyin doğrulanmadığını yazma disiplini](#16-yayin-mantiksal-commit-ler-ve-neyin-dogrulanmadigini-yazma-disiplini) | Yayın | var |

---

# Keşif — kod yazmadan önce

## 1. Dört ister, bir soru: bu bir script mi, bir sunucu mu?

Elimizde dört cümlelik bir ister listesi vardı: bir kişinin açık taleplerini ve görevlerini id + açıklama ile listele, her biri için kullanıcı süre belirtsin, girişleri ilgili kişi ve görev için Xurrent'a kaydet, ve kişinin o günkü takvimini okuyup her toplantıyı zaman girişine çevir.

Dördüncü ister ilk üçünden farklıdır ve bu fark ilk kararı belirledi. 'Her bir toplantıyı zaman girişi olarak ekle' cümlesi otomatik bir işmiş gibi durur — ama takvimde doğum günü de vardır, reddedilmiş bir toplantı da, birbiriyle çakışan iki randevu da. Ortada tek atışlık bir istek değil, bir müzakere vardır.

İkinci ister de aynı yere çıkıyordu: 'kullanıcı süre belirtsin' demek, hangi ticket, süre yuvarlanacak mı, dünkü tarih kabul edilir mi sorularının konuşulması demektir.

Müzakere gerektiren bir iş, API çağrısından çok diyalog yönetimidir. Diyaloğu kendimiz yazarsak her yeni istemci için baştan yazarız.

> **Karar noktası:** Bu iş hangi biçimde paketlenecek?
>
> ○ Düz CLI script'i veya kütüphane — En az katman, en az bağımlılık; hemen çalışan bir şey *(bedeli: Diyalog yönetimi elle yazılır ve her yeni arayüz için baştan yazılır)*
>
> ○ LLM'e Xurrent GraphQL şemasını verip sorguyu ona yazdır — Tool tasarlamaya gerek yok; şema zaten mevcut *(bedeli: Serbest sorgu üretimi serbest mutation üretimi demektir; şema context'e sığmaz; keşfedilen tuzaklar her konuşmada yeniden riske girer)*
>
> **→** **MCP sunucusu + ince istemciler** — Diyaloğu host LLM yürütür; aynı sunucu Claude Code'a, terminal chatbot'a, web arayüzüne ve sihirbaza takılır *(bedeli: Protokol katmanı, onay akışı ve sözleşme bakımı ek iştir)*
>
>
> **Bu projede seçilen:** MCP sunucusu + ince istemciler. İster #2 bir müzakeredir. Müzakereyi bir kez tool yüzeyi olarak tanımlayıp diyaloğu LLM'e bırakmak, aynı işi birden çok istemcide birden çalıştırır. Repoda bunun kanıtı duruyor: aynı sunucuya dört farklı istemci bağlanıyor ve hiçbiri iş mantığını tekrarlamıyor.

### Prompt

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

### Sonra elinde ne olacak

- `docs/00-genel-bakis.md`
- `README.md`

**Ne öğrendik**

- Bir isteri okurken 'kaç tur konuşulacak' sorusunu sor. Tek turluk işler script'tir; çok turlu işler bir yetenek yüzeyi ister.
- Paketleme kararı geri dönmesi en pahalı karardır; bu yüzden kod yazmadan önce verilir.
- Aynı iş mantığına birden çok istemci bağlanacaksa mantığı istemciden ayır. Bu kural MCP'ye özel değil; MCP sadece ayrımı zorunlu kılıyor.

Ayrıntı: [docs/00-genel-bakis.md](00-genel-bakis.md)

## 2. Beş paralel araştırma kolu, sıfır satır kod

İlk aşamada hiç kod yazılmadı. Bunun yerine beş araştırma kolu paralel çalıştırıldı: Xurrent GraphQL şeması ve kimlik doğrulama, zaman girişi veri modeli, takvim sağlayıcıları (Microsoft Graph ve Google), MCP protokolü ile üç dilin SDK'ları, ve ekosistem farkları. Toplam yaklaşık 887 bin token harcandı.

Paralel çalışmanın asıl faydası hız değil, çapraz doğrulamadır. Bir kol yanılırsa diğerinin çıktısı onunla çelişir; çelişki de bir bulgudur.

Çıktı kod değil, karar veriydi: docs/01, docs/02 ve docs/04 bu kolların yazıya dökülmüş hâlidir.

Keşfin en değerli ürünü ise bir liste oldu — neyi BİLMİYORUZ. docs/08 içindeki DOĞRULANMALI maddeleri (D1'den D13'e) tam olarak budur: resmî dokümantasyondan çıkarılmış ama canlı bir hesapta gözlenmemiş her iddia oraya yazıldı.

> **Karar noktası:** Keşif ne kadar sürsün?
>
> ○ İskeleti hemen kur, API'yi yol boyu öğren — İlk saatte çalışan bir şey; ilerleme hissi *(bedeli: Yanlış varsayım üzerine kurulan mimari, bulgu geldiğinde baştan yazılır)*
>
> ○ Resmî SDK örneğini kopyala, üstüne inşa et — En hızlı başlangıç; protokol tarafı hazır gelir *(bedeli: Örnek bizim isterimizi tanımaz; alan kısıtlarını hiç görmezsin)*
>
> **→** **Önce kapsamlı keşif, sonra tek seferde doğru mimari** — Kısıtlar mimariyi belirler, tersi değil *(bedeli: İlk aşamada gösterilecek çalışan bir şey yok)*
>
>
> **Bu projede seçilen:** Önce kapsamlı keşif, sonra tek seferde doğru mimari. Bir sonraki adımdaki tek bulgu — timeEntryCreate bir ticket'a bağlanamaz — tüm yazma mimarisini belirledi. O bulguyu kaçırıp kod yazmaya başlasaydık, iki gün sonra baştan yazardık. AI destekli geliştirmede keşfin maliyeti token, yanlış mimarinin maliyeti zamandır; oran bozuk olduğu için keşfe fazladan harcamak neredeyse her zaman kârdır.

### Prompt

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

### Sonra elinde ne olacak

- `docs/01-xurrent-api.md`
- `docs/02-zaman-girisi-modeli.md`
- `docs/04-takvim.md`
- `docs/08-riskler-ve-sss.md`

### Doğrula

```bash
node clients/wizard/wizard.mjs --server ts --step 04 --auto --json
```

Beklenen çıktı repo kökünde: `0 başarısız`

> ⚠️ **Tuzak:** Araştırma sırasında Xurrent'ın 'eu' diye bir bölge endpoint'i olduğu varsayıldı. Wildcard DNS yüzünden adres çözülüyor ama TLS patlıyor ve hata 'ağ sorunu' gibi görünüyor. Böyle bir bölge yok; Global zaten Avrupa. Doğrulanmamış bir varsayım yalnızca yanlış kod üretmez, hata mesajını da yanlış yere baktırır.

**Ne öğrendik**

- Araştırma çıktısını 'bildiklerimiz' ve 'çıkarımlarımız' diye ikiye ayır. İkinci liste, ilk canlı bağlantıda sırayla yürütülecek iş listendir.
- Bir kısıtı erken bulmak, onu geç bulmaktan katbekat ucuzdur. Keşif bütçesini kod bütçesinden ayrı düşün.
- Paralel araştırma kollarının değeri hız değil, birbirini denetlemeleridir.

Ayrıntı: [docs/01-xurrent-api.md](01-xurrent-api.md)

## 3. ★ İki mutation, aynı iş, farklı yetenekler — ve ister ikisiyle de karşılanmıyor

Bu projenin tek en önemli bulgusu şudur: TimeEntryCreateInput içinde requestId, taskId veya assignmentId alanı YOKTUR. Yani timeEntryCreate ile oluşturulan bir zaman girişi bir Request veya Task'a bağlanamaz.

Ticket'a bağlamanın tek yolu parent kaydın kendi mutation'ıdır: requestUpdate veya taskUpdate içine timeSpent göndermek. Ama o yolda date alanını sunucu 'bugün' yapar, person alanını authenticated user yapar, startedAt hiç yazılmaz.

İsterimiz dördünü birden istiyordu: ticket'a bağlı + başlangıç saatli + dünkü tarihli + gerekirse başkası adına. İki yolun hiçbiri tek başına yetmiyordu.

Çıkış yolu üçüncü bir mutation'ın input şemasında saklıydı. TimeEntryUpdateInput'ta date, startedAt ve personId VAR ama assignment YOK. Bir alan input şemasında yoksa güncellenemez, dolayısıyla mevcut değeri korunur — yani ikinci adım ticket bağını bozamaz. Kısıtın kendisi garantiyi veriyor.

Bu tek bulgu tüm yazma mimarisini belirledi ve dersin kalbi oldu.

> **Karar noktası:** İster #2 ile #3 tek adımda karşılanamıyor. Ne yapacağız?
>
> ○ link_first — isteri kırp, tarihi bugüne sabitle — Tek istek, atomik, en dayanıklı yol *(bedeli: T-1 karşılanamaz; başlangıç saati kaydedilmez; her zaman authenticated user)*
>
> ○ date_first — ticket bağından vazgeç — Tarih, saat ve kişi üzerinde tam kontrol; tek istek, atomik *(bedeli: Kayıt ticket'a bağlanmaz (assignment null); ticket bazlı raporlamada hiç görünmez)*
>
> ○ two_step — önce bağla, sonra tarihi düzelt — Dört yeteneğin dördünü de korur *(bedeli: 2 HTTP isteği; atomik değil — birinci adım tutup ikincisi düşebilir)*
>
> **→** **Üçünü de kodla, seçimi yapılandırmaya bırak** — Takas kullanıcının raporlama ihtiyacına göre verilir; üç yol derste yan yana gösterilebilir *(bedeli: Üç kod yolu, üç doğrulama yükü, üç ayrı uyarı metni)*
>
>
> **Bu projede seçilen:** Üçünü de kodla, seçimi yapılandırmaya bırak. Hangi stratejinin doğru olduğunu API değil, kullanıcının raporlama ihtiyacı belirliyor. Ticket bazlı rapor isteyen bir organizasyonda date_first işe yaramaz; kilitli timesheet dönemi olan bir yerde two_step'in ikinci adımı reddedilebilir. Bir kısıtın tek doğru cevabı yoksa, cevabı koda gömmek yerine dışarı açılır: XURRENT_BACKDATE_STRATEGY. Ayrıca her strateji ne feda ettiğini warnings dizisinde açıkça söyler — sessizce yuvarlanan hiçbir karar yok.

### Prompt

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

### Sonra elinde ne olacak

- `servers/typescript/src/xurrent/strategies.ts`
- `servers/python/src/xurrent_mcp/xurrent/strategies.py`
- `servers/csharp/Xurrent/Strategies.cs`

### Doğrula

```bash
node clients/wizard/wizard.mjs --server ts --step 07 --auto --json
```

Beklenen çıktı repo kökünde: `0 başarısız`

> ⚠️ **Tuzak:** two_step'in ikinci adımı için oluşan TimeEntry'nin id'sine ihtiyaç var. requestUpdate payload'ının bu id'yi döndürüp döndürmediği doğrulanamadı (docs/08 → D5). Döndürmüyorsa aradaki arama bir heuristiktir, garanti değil. Bu belirsizlik gizlenmedi; stratejinin en zayıf noktası olarak DOĞRULANMALI listesine yazıldı.

**Ne öğrendik**

- Bir API'nin ne YAPAMADIĞI, ne yapabildiğinden daha çok mimari belirler. Input şemalarını alan alan oku.
- Bir alanın input şemasında OLMAMASI bazen bir garantidir: o alan güncellenemiyorsa mevcut değeri korunur. Kısıtı okumayı öğrenirsen bazen kısıt senin lehine çalışır.
- Tek doğru cevabı olmayan bir takası koda gömme; yapılandırmaya çıkar ve her seçeneğin neyi feda ettiğini çalışma zamanında kullanıcıya söyle.

Ayrıntı: [docs/02-zaman-girisi-modeli.md](02-zaman-girisi-modeli.md)

---

# Sözleşme ve veri

## 4. ★ Önce sözleşme: tek gerçek kaynak bir JSON dosyası

Kod yazmadan önce yazılan ikinci şey contract/tools.json oldu: sekiz tool, dil-bağımsız, girdi ve çıktı şemalarıyla birlikte.

Sözleşmeye yalnızca imzalar değil, keşifte bulunan tuzaklar da yazıldı. RequestFilter'da atanan kişi alanının 'member', TaskFilter'da 'assignee' olması gibi maddeler ilgili tool'un teachingNotes alanında duruyor — koda değil, sözleşmeye. Böylece üç implementasyon da aynı tuzağı aynı yerden öğreniyor.

Ortak kurallar ayrı bir conventions bloğunda toplandı: süre birimi daima dakika, tarih ISO8601, timestamp'te offset zorunlu, id'ler opak ve asla üretilmez, iş kuralı hataları errors dizisiyle döner.

Sözleşmenin makine tarafından okunabilir olması bir tercih değil, ölçülebilirliğin şartıydı. scripts/verify-contract.mjs üç sunucunun tools/list ve tools/call çıktısını bu dosyaya karşı doğruluyor.

> **Karar noktası:** Sözleşme nerede yaşayacak?
>
> ○ Her dil kendi tool tanımlarını yazsın, referans TypeScript olsun — Ek dosya yok; her dil kendi idiomunda kalır *(bedeli: Referans dil ayrıcalıklı olur; sapmalar sessizce birikir ve kimse fark etmez)*
>
> ○ Sözleşmeyi anlatı belgelerine (docs/) yaz — Okunur, açıklamalı, gerekçeli *(bedeli: Makine karşılaştıramaz; uyum denetimi insan gözüne kalır)*
>
> **→** **Tek bir dil-bağımsız JSON dosyası + otomatik doğrulayıcı** — Sapma CI'da yakalanır; üç dil eşit mesafede; iddia ölçülebilir olur *(bedeli: Sözleşme ile kod arasında elle senkron tutulan bir katman doğar)*
>
>
> **Bu projede seçilen:** Tek bir dil-bağımsız JSON dosyası + otomatik doğrulayıcı. AI ile çalışırken en yüksek getirili adım doğru sözleşmeyi tarif etmektir; implementasyon o tarifin türevidir. Üç sunucu da aynı JSON'dan üretildi ve sapmalar ölçüldü. Sözleşme yalnızca belgede kalsaydı 'üç dil aynı çıktıyı üretir' ölçülemez bir slogan olurdu.

### Prompt

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

### Sonra elinde ne olacak

- `contract/tools.json`
- `scripts/verify-contract.mjs`

### Doğrula

```bash
node -e "const t=require('./contract/tools.json');const n=t.tools.map(x=>x.name);console.log('tool sayisi:',n.length);console.log(n.join(','))"
```

Beklenen çıktı inşa edilen dizinde: `tool sayisi: 8`

**Ne öğrendik**

- Sözleşmeyi kodun ÖNÜNE koy ve makine-okunur yap. AI'a verdiğin en değerli girdi budur; kalanı türevdir.
- Bir tool sözleşmesi çıktıyı da tarif etmelidir. Yalnızca girdiyi tarif eden sözleşme, uyumu yarım ölçer.
- Alan adı ve sıra gibi 'önemsiz' görünen ayrıntıları sözleşmeye yaz. Sessiz sapmalar tam olarak oralarda doğar.

Ayrıntı: [docs/03-mcp-tasarimi.md](03-mcp-tasarimi.md)

## 5. Mock veri rastgele değil, öğretici tasarlanır

fixtures/ klasöründeki her kayıt bir kural öğretmek için oradadır.

requests.json'da 3 açık + 1 kapalı Request var; tasks.json'da 3 açık + 1 kapalı Task. Kapalı Task'ın durumu 'completed' değil 'approved' — çünkü Xurrent'ta beş terminal durum vardır ve sadece completed'ı eleyen naif bir filtre o kaydı açık sanar.

calendar.json'da 8 ham etkinlik var, bunların yalnızca 5'i gerçek toplantı. Elenen üçü üç ayrı kural öğretir: doğum günü (isAllDay), öğle arası (free), ekip retrospektifi (declined). İki toplantı kasıtlı olarak çakışır; naif toplam 255 dakika, doğru cevap 225.

timesheet-settings.json'da timeIncrement 30. Takvimdeki bir toplantı 45 dakika. Bu ikisi birlikte yuvarlama diyaloğunu zorunlu kılar.

effort-classes.json'da 4 kayıt var, biri disabled. EffortClassFilter'da disabled diye bir filtre olmadığı için eleme client tarafında yapılmak zorunda — fixture bunu görünür kılıyor.

Tarihler mutlak değil görelidir (dayOffset). Demo hangi gün çalışırsa çalışsın aynı sayıları üretir.

> **Karar noktası:** Mock veri nasıl üretilsin?
>
> ○ Gerçek bir hesaptan anonimleştirerek al — Gerçekçi dağılım, gerçek kenar durumlar *(bedeli: Hesap yok; ayrıca anonimleştirme her zaman eksik kalır ve veri bir dersi garanti etmez)*
>
> ○ Rastgele üret — Hızlı, çok sayıda kayıt üretilebilir *(bedeli: Beklenen sayılar sabitlenemez; hiçbir kayıt bir kuralı öğretmez)*
>
> **→** **Elle kurgula: her kayıt bir kural öğretsin** — Beklenen sayılar deterministik; her tuzak canlı olarak gösterilebilir *(bedeli: Az sayıda kayıt; gerçek dünyanın ölçek etkileri görünmez)*
>
>
> **Bu projede seçilen:** Elle kurgula: her kayıt bir kural öğretsin. Sihirbazın her adımı fixture'lardan gelen sabit sayılara karşı doğrulanıyor (3/3 açık iş, 8 ham etkinlik, 5 toplantı, 225 ve 255 dakika, timeIncrement 30). Rastgele veriyle bu doğrulamaların hiçbiri yazılamazdı; anonimleştirilmiş veriyle de 'approved bir Task' gibi tam da öğretmek istediğimiz kenar durumun bulunacağı garanti değildi.

### Prompt

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

### Sonra elinde ne olacak

- `fixtures/README.md`
- `fixtures/requests.json`
- `fixtures/tasks.json`
- `fixtures/calendar.json`
- `fixtures/timesheet-settings.json`
- `fixtures/effort-classes.json`
- `fixtures/time-allocations.json`
- `scripts/gen-ics.mjs`

### Doğrula

```bash
node clients/wizard/wizard.mjs --server ts --step 09 --auto --json
```

Beklenen çıktı repo kökünde: `0 başarısız`

> ⚠️ **Tuzak:** İlk fixture'lar mutlak tarih taşıyordu ve 'bugünün takvimi' ertesi gün boş döndü. Tarihler dayOffset'e çevrildi. .ics ise formatı gereği mutlak DTSTART taşımak zorunda olduğu için türev dosya yapıldı: kaynak calendar.json, .ics ondan üretiliyor ve .gitignore'da.

**Ne öğrendik**

- Test verisi bir yan ürün değil, bir tasarım ürünüdür. Her kaydın 'hangi kuralı öğretiyorum' sorusuna cevabı olsun.
- Zamana bağlı fixture'ları göreli tut. Mutlak tarih taşıyan bir demo ertesi gün sessizce boş döner.
- Türetilebilir dosyayı kaynak sayma. .ics mutlak tarih taşımak zorunda olduğu için kaynaktan üretiliyor ve sürüm kontrolüne girmiyor.

Ayrıntı: [docs/04-takvim.md](04-takvim.md)

---

# Üç implementasyon

## 6. Katmanlar: her katmanın NE BİLMEDİĞİ yazılır

Sunucular dört katmana bölündü ve her katman için 'neyi bilmediği' açıkça tarif edildi. xurrent/ katmanı MCP'yi bilmez. calendar/ katmanı ne MCP'yi ne Xurrent'ı bilir. core/ katmanı sekiz tool'un saf fonksiyon hâlidir ve protokolü bilmez. mcp/ katmanı ise iş kuralı içermez.

Bu ayrımın en keskin noktası onay akışında ortaya çıkıyor: core katmanındaki bir tool, kullanıcı onayı gerektiğinde ConfirmationRequired döndürür — onayın NASIL sorulacağını bilmez. Onayı protokole çevirmek mcp/ katmanının işidir.

O sırada bu ayrımın bedeli belliydi, karşılığı belli değildi: bir ara tip ve fazladan bir dolaylama. Karşılığını dördüncü fazda aldı — ama bu adımda henüz kimse bunu bilmiyordu.

Ölçülebilir kısmı şu: iş mantığı protokolden bağımsız olduğu için sekiz tool'un tamamı iki farklı MCP revizyonu altında birebir aynı çıktıyı üretiyor.

> **Karar noktası:** İş mantığı nereye yazılsın?
>
> ○ Doğrudan SDK'nın tool handler'ının içine — En az dosya, en kısa yol, en hızlı ilk sürüm *(bedeli: Protokol değişirse iş mantığı da taşınmak zorunda kalır)*
>
> ○ Tam hexagonal mimari: her şey arayüz arkasında — Teorik olarak en esnek; her bileşen tek başına değiştirilebilir *(bedeli: Sekiz tool'luk bir projede soyutlama maliyeti faydayı aşar ve ders okunmaz olur)*
>
> **→** **Saf fonksiyon core + ince protokol kabuğu** — Protokol kabuğu değiştirilebilir, core aynı kalır; test edilebilirlik bedava gelir *(bedeli: Onay gibi protokole yakın konular için bir ara tip (ConfirmationRequired) gerekir)*
>
>
> **Bu projede seçilen:** Saf fonksiyon core + ince protokol kabuğu. Sekiz tool için tam hexagonal mimari, öğretmek istediğimiz şeyi gizleyecek kadar soyutlama getirirdi. Handler içine yazmak ise protokolü iş mantığına yapıştırırdı. Ortadaki seçenek her iki maliyeti de sınırlı tutuyor: tek ara tip, tek dolaylama. Bu ayrımın karşılığı 10. ve 11. adımlarda ölçüldü.

### Prompt

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

### Sonra elinde ne olacak

- `servers/typescript/src/core/toolimpl.ts`
- `servers/typescript/src/core/context.ts`
- `servers/python/src/xurrent_mcp/core/toolimpl.py`
- `servers/csharp/Core/ToolImpl.cs`
- `servers/csharp/Core/Confirm.cs`

### Doğrula

```bash
(cd servers/typescript && npm run build) && echo "BUILD OK"
```

Beklenen çıktı repo kökünde: `BUILD OK`

**Ne öğrendik**

- Katmanı 'ne yapar' ile değil 'neyi bilmez' ile tarif et. İkinci tarif ihlal edildiğinde derleyici veya gözden geçiren hemen görür.
- Protokole yakın kararları (onay, hata zarfı, oturum) iş mantığından ayrı tut. Protokoller iş kurallarından daha sık değişir.
- Soyutlama miktarını projenin boyutuna göre seç. Az soyutlama borç, çok soyutlama gürültüdür; ikisi de bakım maliyetidir.

Ayrıntı: [contract/protocol.md](../contract/protocol.md)

## 7. Üç dil paralel — ve üçüncü implementasyon ilk ikisini denetler

TypeScript, Python ve C# sunucuları aynı contract/tools.json dosyasından paralel üretildi. Hiçbiri diğerinin kodunu okumadı; ortak referans yalnızca sözleşme ve fixtures/ klasörüydü.

Doğrulama iki katmanlı: scripts/verify-contract.mjs sözleşme uyumunu ölçüyor, sihirbaz ise üçüne de bağlanıp aynı sayıları bekliyor.

Beklenmedik kazanç şuydu: sözleşmeyi üçüncü kez uygulamak, ilk iki implementasyonun sessiz varsayımlarını ortaya çıkardı. Bir alan adı Python'da snake_case'e kayma eğilimi gösteriyorsa, sözleşme o alanı yeterince açık tarif etmemiş demektir.

Üretim için doğru cevap bu değildir: bir dil seç, iyi yaz. Üç dil dersin tezi olduğu için var.

> **Karar noktası:** Kaç dilde yazılacak?
>
> ○ Tek dil, iyi yazılmış — Üretim için doğru cevap; bakım tek yerde *(bedeli: 'MCP bir protokoldür, dil bir detaydır' tezi iddia olarak kalır, kanıtlanmaz)*
>
> ○ Üç dil, sırayla: önce biri bitsin, sonra çevirilsin — İkinci ve üçüncü dil hazır bir referanstan gider *(bedeli: Referans dilin varsayımları sorgusuz kopyalanır; sözleşmedeki belirsizlikler görünmez kalır)*
>
> **→** **Üç dil paralel, hepsi aynı sözleşmeden** — Tez canlı kanıtlanır; sözleşmedeki belirsizlikler üç kez sınanır *(bedeli: Üç ekosistem, üç build zinciri, üç kez bakım)*
>
>
> **Bu projede seçilen:** Üç dil paralel, hepsi aynı sözleşmeden. Tezi ancak tek bir istemcinin üç sunucuya bağlanıp aynı çıktıyı üretmesiyle kanıtlayabilirdik. Gizli kazanç sonradan ölçüldü: her yeni implementasyon, sözleşmenin yeterince açık olmadığı yerleri işaret eden ücretsiz bir gözden geçirmedir.

### Prompt

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

### Sonra elinde ne olacak

- `servers/typescript/src/tools/*.ts`
- `servers/python/src/xurrent_mcp/tools/*.py`
- `servers/csharp/Core/ToolImpl.cs`
- `servers/csharp/Mcp/McpTools.cs`

### Doğrula

```bash
node scripts/verify-contract.mjs --all
```

Beklenen çıktı repo kökünde: `Aynı tool adları, aynı parametreler, aynı annotation`

> ⚠️ **Tuzak:** Bir alan adı bir dilde idioma kayarsa, hata o dilde değil sözleşmededir: o alan yeterince açık tarif edilmemiştir. Düzeltmeyi koda değil, önce sözleşmeye uygula.

**Ne öğrendik**

- Aynı sözleşmeyi ikinci kez uygulamak, sözleşmeyi gözden geçirmenin en ucuz yoludur. Belirsizlikler ancak farklı bir bağlamda görünür hâle gelir.
- Wire formatındaki adları dilin idiomuna çevirme. 'Bizde böyle yazılır' alışkanlığı, sözleşmeyi sessizce bozan en yaygın nedendir.
- Ders için doğru olan üretim için doğru olmayabilir; hangi amaç için optimize ettiğini açıkça söyle.

Ayrıntı: [docs/06-uc-dil-karsilastirma.md](06-uc-dil-karsilastirma.md)

## 8. Dry-run tek katman değil: parametre, ortam, ve yapısal imkânsızlık

Xurrent bir system of record'dur; yanlış yazılan bir zaman girişi faturalamaya kadar gider. Bu yüzden yazma yolu üç ayrı katmanla korundu ve her katman FARKLI bir tehdide karşı konumlandı.

Birinci katman dryRun tool parametresi: hiçbir mutation HTTP'ye çıkmaz, gönderilecek GraphQL metni ve uyarılar döner. Bu, modelin veya kullanıcının hata yapmasına karşıdır.

İkinci katman XURRENT_DRY_RUN ortam değişkenidir ve tool parametresini ezer. Bu, modelin kandırılmasına karşıdır — prompt injection bir tool parametresini değiştirebilir, ortam değişkenine erişemez.

Üçüncü katman en güçlüsüdür: plan_time_entries_from_calendar yapısal olarak yazamaz. İçinde hiçbir mutation yolu yoktur, readOnlyHint true'dur. İkna edilecek bir şey yoktur.

Onay ise bilinçli olarak LLM'e bırakılmadı. LLM ikna edilebilir; protokol seviyesindeki onay edilemez.

> **Karar noktası:** Yazma güvenliği nereye konulacak?
>
> ○ Sistem promptuna kural olarak yaz — Sıfır kod; istediğin kadar ayrıntılı yazabilirsin *(bedeli: LLM ikna edilebilir; prompt injection tam olarak bu katmanı hedefler)*
>
> ○ Tek bir dryRun parametresi yeterli — Basit, açık, tool yüzeyinde görünür *(bedeli: Parametrenin değerini model belirler; kötüye kullanım senaryosu açık kalır)*
>
> **→** **Üç katman: parametre + ortam değişkeni + yapısal olarak yazamayan tool** — Farklı tehdit modellerine farklı katman; en dıştaki katmana model erişemez *(bedeli: Üç yerde tutarlılık gerekir ve üçü de üç dilde aynı davranmak zorundadır)*
>
>
> **Bu projede seçilen:** Üç katman: parametre + ortam değişkeni + yapısal olarak yazamayan tool. dryRun bir tool parametresidir ve LLM onu false yapabilir; kullanıcı ısrar edebilir, prompt injection zorlayabilir. XURRENT_DRY_RUN bir ortam değişkenidir ve model ona erişemez. plan_time_entries_from_calendar ise hiç yazma yolu içermez. Üç ayrı tehdit modeli, üç ayrı katman — biri diğerinin yerine geçmiyor.

### Prompt

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

### Sonra elinde ne olacak

- `servers/typescript/src/tools/plan-from-calendar.ts`
- `servers/typescript/src/core/context.ts`
- `servers/python/src/xurrent_mcp/tools/write_tools.py`
- `servers/csharp/Mcp/McpTools.cs`

### Doğrula

```bash
node clients/wizard/wizard.mjs --server ts --step 10 --auto --json
```

Beklenen çıktı repo kökünde: `0 başarısız`

**Ne öğrendik**

- Bir güvenlik katmanının değeri, modelin ona erişip erişemediğiyle ölçülür. Modelin değiştirebildiği hiçbir şey son savunma hattı değildir.
- 'Hata' ve 'kötüye kullanım' iki ayrı tehdit modelidir ve ayrı katman ister. Birini kapatan önlem diğerini kapatmaz.
- En güçlü kısıt, yapısal olarak imkânsız olandır. Bir tool yazamıyorsa, onu yazmaya ikna etmenin yolu yoktur.

Ayrıntı: [docs/03-mcp-tasarimi.md](03-mcp-tasarimi.md)

## 9. Sihirbaz: içerik veride, yürütme kodda

Ders akışını yürüten sihirbaz bir MCP client'ıdır ve --server ts|py|cs ile hangi sunucuya bağlanacağı seçilir.

Ders içeriğinin hiçbir parçası client'ta gömülü değildir: 14 adım, anlatım metinleri ve beklenen sayılar docs/wizard/steps.json dosyasından gelir. Client yalnızca şu döngüyü yürütür — bağlan, anlat, gerçek tool çağrısı yap, beklenenle karşılaştır, yorumla.

Bu ayrım kozmetik değil: ders metni client'a gömülü olsaydı 'aynı ders üç sunucuda aynı sonucu verir' kanıtı değersiz olurdu, çünkü üçünü de aynı gömülü metin anlatıyor olurdu.

Sonuç modeli üç durumludur: PASS, FAIL, SKIP. SKIP'in tanımı bilinçli olarak dardır — 'çalıştı ama tutmadı' asla SKIP olamaz, yoksa sihirbaz kendi hatalarını kendi affeder.

steps.json'un bir JSON Schema'sı ve bağımsız bir doğrulayıcısı var. Doğrulayıcı hiçbir npm paketi kullanmaz; scripts/lib/mini-jsonschema.mjs yaklaşık 250 satırlık bir alt küme uygulamasıdır.

> **Karar noktası:** Ders içeriği nerede yaşasın?
>
> ○ Koşucunun içine gömülü — Tek dosya; senkron sorunu yok *(bedeli: 'Aynı ders üç sunucuda aynı sonucu verir' iddiası kanıtlanamaz — üçünü de aynı gömülü metin anlatır)*
>
> ○ Markdown olarak yazılsın, insan okusun — En okunur biçim; gerekçeler yanına yazılabilir *(bedeli: Yürütülemez; beklenen sayılar hiç doğrulanmaz ve zamanla bayatlar)*
>
> **→** **Şemalı JSON veri + bağımsız koşucu** — İçerik ile yürütme ayrılır; şema ihlali CI'da yakalanır; aynı koşucu farklı ders dosyalarını yürütebilir *(bedeli: Bir şema dosyası ve bir doğrulayıcı daha bakılacak)*
>
>
> **Bu projede seçilen:** Şemalı JSON veri + bağımsız koşucu. Kanıtın kendisi bu ayrıma bağlıydı. İçerik veri olunca tek koşucu üç sunucuya bağlanıyor ve aynı JSON'u yürütüyor; sonuçların aynı çıkması artık gerçek bir ölçüm. Ayrıca içerik değiştiğinde kod değişmiyor — bu belge de aynı desenin ikinci uygulaması.

### Prompt

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

### Sonra elinde ne olacak

- `docs/wizard/steps.json`
- `docs/wizard/steps.schema.json`
- `clients/wizard/wizard.mjs`
- `scripts/validate-steps.mjs`
- `scripts/lib/mini-jsonschema.mjs`

### Doğrula

```bash
node scripts/validate-steps.mjs
```

Beklenen çıktı repo kökünde: `steps.json ŞEMAYA UYGUN`

**Ne öğrendik**

- İçeriği yürütücüden ayır. Bir demo, içeriği gömülü olduğu sürece yalnızca kendini kanıtlar.
- SKIP'in tanımını dar tut. 'Çalıştı ama tutmadı' SKIP sayılırsa doğrulama kendi hatalarını affeder ve yeşil bir CI hiçbir şey söylemez.
- Şemada additionalProperties: false katı görünür ama asıl işlevi başkadır: koşucunun tanımadığı bir anahtar sessizce yok sayılır, yani hiç çalışmayan bir bölüm doğar.

Ayrıntı: [docs/07-sihirbaz.md](07-sihirbaz.md)

---

# Spec iş ortasında değişti

## 10. ★ 28 Temmuz 2026: MCP tam olarak bizim onay akışımızı kaldırdı

Proje yarıdayken MCP yeni bir spesifikasyon revizyonu yayınladı: 2026-07-28. Lansmandan bu yana en büyüğü — ve kaldırdığı şey tam olarak bizim onay akışımızdı.

Eski revizyonda sunucu, işlemin ortasında client'a elicitation/create diye bir İSTEK gönderiyordu. Yani sunucu client'a istek gönderebilen bir taraftı; bu da kalıcı çift yönlü bağlantı ve stateful sunucu demekti.

Yeni revizyon stateless: initialize el sıkışması yok, oturum yok, sunucu-başlatmalı istek yok. Keşif server/discover ile yapılıyor ve protokol sürümü her istekte _meta içinde taşınıyor.

Kullanıcıya soru sorma MRTR ile yapılıyor: sunucu InputRequiredResult adında bir SONUÇ döner, ilk istek sonlanır, client aynı çağrıyı YENİ bir id ile tekrarlar ve imzalı requestState'i geri getirir.

Kritik olan şu: contract/tools.json hiç değişmedi. Aynı sekiz tool, aynı parametreler, aynı çıktı alanları, aynı sayılar. Değişen tek şey onayın sorulma biçimiydi.

> **Karar noktası:** Yeni revizyona nasıl yanıt verilecek?
>
> ○ Görmezden gel, eski revizyonda kal — Sıfır iş; mevcut istemciler çalışmaya devam eder *(bedeli: Ders materyali yayınlandığı gün eskimiş olur; yeni istemciler bağlanamaz)*
>
> ○ Tamamen yeni revizyona geç, eskisini sil — Tek kod yolu, tek test yolu *(bedeli: Hâlâ yaygın olan eski istemciler dışarıda kalır; geçişin kendisi ders konusu olmaktan çıkar)*
>
> **→** **İkisini birden destekle ve farkı ders konusu yap** — Breaking change canlı gösterilebilir; iki istemci kuşağı da bağlanır *(bedeli: İki adaptör, iki test yolu, iki dokümantasyon)*
>
>
> **Bu projede seçilen:** İkisini birden destekle ve farkı ders konusu yap. Bir AI destekli geliştirme dersinin ortasında spec'in değişmesi, senaryosu yazılamayacak bir fırsattı. Ayrıca somut bir iddia test edilebilir hâle geldi: iş mantığını protokolden ayırdıysan, breaking change seni ince bir adaptör katmanında yakalar — tüm uygulamada değil. Sekiz tool'un tamamı iki protokolde de birebir aynı structuredContent'i üretiyor; bu ölçüldü, iddia edilmedi.

### Prompt

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

### Sonra elinde ne olacak

- `contract/protocol.md`
- `servers/typescript/src/mcp/v1/server.ts`
- `servers/typescript/src/mcp/v2/server.ts`
- `servers/typescript/src/mcp/protocols.ts`
- `servers/python/src/xurrent_mcp/mcp/v1.py`
- `servers/python/src/xurrent_mcp/mcp/v2.py`
- `servers/csharp/Mcp/ServerSetup.cs`

### Doğrula

```bash
node servers/typescript/scripts/probe-protocols.mjs
```

Beklenen çıktı repo kökünde: `iki protokolde AYNI structuredContent`

**Ne öğrendik**

- Protokol revizyonu tool sözleşmeni bozmamalı. Bozuyorsa, iş mantığın protokole sızmış demektir.
- Bir breaking change'in maliyetini tahmin etme; hangi dosyaların değiştiğini say. Liste kısaysa katmanlama işe yaramıştır.
- Bağımlılığın spec'i değişirse bu bir kriz değil, mimarinin ücretsiz testidir. Testi geçemiyorsan sorun spec'te değil.

Ayrıntı: [docs/09-protokol-gecisi.md](09-protokol-gecisi.md)

## 11. ★★ Plan üç projeye bölmekti. Ölçtük; gereksizmiş.

İki revizyonu birden desteklemenin ilk planı şuydu: her dilde iki SDK sürümü yan yana kurulmalı, C#'ta paket ID aynı olduğu için Core + V1 + V2 diye üç ayrı proje gerekir.

Bu plan uygulanmadı. Önce ölçüldü: her sunucu alt süreç olarak başlatıldı ve SDK client'ı araya girmeden ham JSON-RPC yazıldı — önce zorunlu _meta ile server/discover, sonra initialize.

Sonuç tablosu şuydu: TypeScript (@modelcontextprotocol/sdk 1.30.0) server/discover'a -32601 döndü, initialize'ı kabul etti — yalnızca v1. Python (mcp 2.0.0) ikisini de kabul etti. C# (ModelContextProtocol 2.0.0) ikisini de kabul etti.

Yani resmî SDK 2.0.0'lar geriye dönük uyumluluğu kendileri taşıyor. Üç projeye bölmek gereksizdi; elle çift adaptör yalnızca eski SDK kuşağında kalan TypeScript için gerekti.

Ölçmeseydik ne olurdu? Gereksiz karmaşıklığı 'breaking change'in maliyeti' diye öğretecektik — oysa o maliyeti SDK zaten ödemişti. Bu, dersin sessiz ama en pahalı anlarından biri.

> **Karar noktası:** İki revizyon aynı repoda nasıl barınacak?
>
> ○ C# için Core + V1 + V2 üç ayrı proje — Paket sürümü çakışması kesin olarak çözülür *(bedeli: Üç csproj, üç build, üç test yolu — hepsi ölçülmemiş bir varsayıma dayanıyor)*
>
> ○ Her dilde iki SDK sürümünü yan yana kur — Simetrik çözüm; her dil aynı şekilde ele alınır *(bedeli: Python ve C#'ta paket adı aynı olduğu için tek ortamda mümkün değil; zorlama çözümler gerekir)*
>
> **→** **Önce ölç: hangi SDK zaten ikisini birden konuşuyor?** — Gereksiz karmaşıklık hiç yazılmaz; karar veriye dayanır *(bedeli: Ölçüm için ham JSON-RPC sondası yazmak gerekir — bu da bir iş)*
>
>
> **Bu projede seçilen:** Önce ölç: hangi SDK zaten ikisini birden konuşuyor?. Ölçüm planın yanlış olduğunu gösterdi. Resmî SDK 2.0.0'lar hem server/discover'a hem initialize'a cevap veriyor, yani geriye dönük uyumluluğu kendileri taşıyor. Elle çift adaptör yalnızca TypeScript için gerekti çünkü orada iki farklı paket adı yan yana duruyor. Sondayı yazmanın maliyeti bir script; üç projeye bölmenin maliyeti kalıcı bakım yüküydü.

### Prompt

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

### Sonra elinde ne olacak

- `contract/protocol.md`
- `docs/09-protokol-gecisi.md`
- `servers/typescript/scripts/probe-protocols.mjs`

### Doğrula

```bash
node scripts/verify-contract.mjs --server py
```

Beklenen çıktı repo kökünde: `Uyumluluk sondası: server/discover kabul edildi → v2`

> ⚠️ **Tuzak:** Ölçüm için yazılan sondanın kendisi önce yanlış yazıldı ve aynı yanlış teşhisi başka bir yerden üretti — bir sonraki adımın konusu tam olarak bu.

**Ne öğrendik**

- Mimari kararı ölçmeden verme. 'Şu gerekir' cümlesinin arkasında bir ölçüm yoksa, o cümle bir varsayımdır.
- Bir bağımlılığın ne yaptığını dokümanından değil, davranışından öğren. Ham protokolle bir sonda yazmak çoğu zaman bir günden kısa sürer.
- Yanlış mimari yalnızca kod maliyeti değildir: bir öğretim materyalinde yanlış mimari, yanlış dersi öğretir.

Ayrıntı: [contract/protocol.md](../contract/protocol.md)

## 12. Stateless olmak, state'i saldırgana emanet etmek demek

Yeni revizyonda sunucu stateless olduğu için onay bilgisi — 'kullanıcı, Request #70248'e 120 dakika yazmayı onayladı' — requestState adında bir blob içinde client'a verilip geri alınıyor.

Spec bunu açıkça saldırgan kontrolündeki girdi sayıyor. İmzasız bırakılırsa client blob'u değiştirip başka bir ticket'a, başka bir süre yazdırabilir.

Bu repoda requestState HMAC-SHA256 ile imzalanıyor ve payload'a dört şey gömülüyor: principal (authenticated person id), exp (varsayılan 300 saniyelik TTL), fingerprint (metot adı + argümanların özeti) ve tek kullanımlık bir nonce.

Bu dördü olmadan üç ayrı saldırı açık kalır: başka kullanıcının onayını kullanmak, süresi dolmuş bir onayı sonra oynatmak, bir çağrının onayını başka bir çağrıya iliştirmek, ve aynı onayı tekrar tekrar oynatmak.

Kanıt tahmine bırakılmadı: servers/typescript/scripts/probe-request-state.mjs altı senaryoyu ham JSON-RPC ile sürüyor — imza kurcalama, argüman değiştirme, tekrar oynatma ve red senaryoları dahil.

> **Karar noktası:** Onay bilgisi iki istek arasında nasıl taşınacak?
>
> ○ Düz JSON olarak client'a ver, geri al — En basit; sunucu gerçekten stateless kalır *(bedeli: Client blob'u değiştirip başka ticket'a başka süre yazdırabilir)*
>
> ○ Sunucuda bellekte tut, client'a yalnızca bir anahtar ver — İçerik hiç dışarı çıkmaz; kurcalanamaz *(bedeli: Sunucu tekrar stateful olur — yeni revizyonun kaldırdığı şey tam olarak bu)*
>
> **→** **İmzala ve client'ta taşı** — Stateless kalır, içerik korunur; TTL ve fingerprint ile kapsam daraltılır *(bedeli: Anahtar yönetimi gerekir; süreç yeniden başlayınca eski state'ler geçersizleşir)*
>
>
> **Bu projede seçilen:** İmzala ve client'ta taşı. Stateless kalmak protokolün gereğiydi, ama stateless olmak state'i korumasız bırakmak anlamına gelmiyor. İmza + principal + TTL + fingerprint + nonce, replay penceresini daraltır ve çapraz kullanıcı ile çapraz istek kullanımını engeller. Süreç yeniden başladığında eski state'lerin geçersiz olması bir yan etki değil, istenen davranış.

### Prompt

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

### Sonra elinde ne olacak

- `servers/typescript/src/core/confirm.ts`
- `servers/python/src/xurrent_mcp/core/confirm.py`
- `servers/csharp/Core/Confirm.cs`
- `servers/typescript/scripts/probe-request-state.mjs`

### Doğrula

```bash
node servers/typescript/scripts/probe-request-state.mjs
```

Beklenen çıktı repo kökünde: `ZATEN KULLANILMIŞ`

> ⚠️ **Tuzak:** Nonce seti süreç içidir. Tek süreçli stdio'da yeterli, yatay ölçekte replay penceresi açık kalır. Bu bilinçli olarak kapsam dışı bırakıldı ve docs/08'de yazıldı — kapsam dışı bırakmak fark etmemekten farklıdır, ama yalnızca yazıya dökülürse.

**Ne öğrendik**

- Sunucu state'ini client'a verdiğin her yerde bir güven sınırı geçmiş olursun. İmzasız hiçbir şey geri kabul edilmez.
- İmza tek başına yetmez: neyi imzaladığını da bağla. Fingerprint olmadan geçerli bir onay başka bir çağrıya iliştirilebilir.
- Güvenlik iddialarını senaryo olarak yaz ve çalıştır. 'İmzalıyoruz' bir cümledir; tekrar oynatmanın reddedildiğini gösteren bir koşu delildir.

Ayrıntı: [contract/protocol.md](../contract/protocol.md)

---

# Kusur avı ve live yolu

## 13. ★ Aynı hata kodu, iki farklı sebep: sessiz yanlış teşhis

Sihirbaz uzun süre 'bu sunucu yeni revizyonu konuşmuyor' dedi. Sunucu konuşuyordu.

Sebep şuydu: uyumluluk sondası server/discover'ı zorunlu _meta bloğu OLMADAN gönderiyordu. Python bu durumda -32601 Method not found döner — yani gerçekten v1 olan bir sunucuyla BİREBİR AYNI hata kodu. C# ise -32602 döner ve mesajında eksik olanın per-request metadata olduğunu açıkça söyler.

İki kodu ayırmayan bir sonda, v2 konuşan bir sunucuyu ömür boyu v1 sanar ve kendi istemci hatasını sunucunun eksikliği gibi raporlar.

Düzeltme iki parçalıydı: sondaya üç zorunlu _meta anahtarı eklendi, ve -32602 ile -32021 alındığında v1'e DÜŞÜLMEMESİ kuralı kondu. O durumda sihirbaz net bir istemci hatası verip duruyor.

İkinci ayrıntı: sonda ayrı ve kısa ömürlü bir süreçte çalışır. Bir bağlantıda initialize yapıldıktan sonra aynı bağlantıya v2 zarflı istek göndermek reddediliyor; bu da ölçülmüş bir gerçek, tahmin değil.

> **Karar noktası:** Sonda -32602 aldığında ne yapmalı?
>
> ○ -32601 ile aynı say: sunucu v2 konuşmuyor, v1'e düş — Tek kod yolu; sonda her koşulda bir sonuç üretir ve akış hiç durmaz *(bedeli: İstemci kendi hatasını sunucunun eksikliği sanar — ders kitabı sessiz hatası)*
>
> **→** **İkisini ayır: -32601 → v1'e düş, -32602 → istemci hatası olarak dur** — Yanlış teşhis imkânsızlaşır; hata mesajı doğru yeri gösterir *(bedeli: Sonda bazı durumlarda sonuç yerine hata verir ve akış durur)*
>
>
> **Bu projede seçilen:** İkisini ayır: -32601 → v1'e düş, -32602 → istemci hatası olarak dur. -32601 'bu metot yok' demektir ve gerçekten v1 sunucu anlamına gelir. -32602 ise 'isteğin bozuk' demektir — metot VARDIR, eksik olan bizim gönderdiğimiz _meta bloğudur. İkisini birleştiren bir sonda kendi hatasını karşı tarafın eksikliği diye raporlar. Akışın durması burada bir maliyet değil, doğru davranıştır: teşhis edilemeyen bir durum sessizce varsayılana düşmemelidir.

### Prompt

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

### Sonra elinde ne olacak

- `clients/wizard/wizard.mjs`
- `scripts/verify-contract.mjs`

### Doğrula

```bash
node clients/wizard/wizard.mjs --server ts --auto --json
```

Beklenen çıktı repo kökünde: `0 başarısız`

> ⚠️ **Tuzak:** Python eksik _meta durumunda -32601 döner, yani gerçek bir v1 sunucusuyla aynı kodu. C# -32602 ve açıklayıcı bir mesaj döner. İki SDK'nın aynı hataya farklı kod vermesi, hatalı bir sondanın yalnızca en gürültülü sunucuda fark edilmesine yol açar — diğerlerinde sessizce yanlış çalışır.

**Ne öğrendik**

- Bir uyumluluk sondası yazarken 'karşı taraf desteklemiyor' ile 'ben yanlış sordum' durumlarını ilk günden ayır. Birleştirirsen kendi hatanı karşı tarafın eksikliği diye raporlarsın.
- Aynı hata koduna iki farklı sebep düşebiliyorsa, teşhisi koda değil sebebe bağla; gerekirse ek bir sinyal iste.
- Hata kodlarını isimle karşılaştır, sayıyla değil. Bu revizyon -32004'ü -32022'ye taşıdı; sayı karşılaştıran catch blokları sessizce tutmaz oldu.
- Teşhis edilemeyen bir durumda varsayılana düşme. Durup net bir hata vermek, yanlış bir cevabı doğru sanmaktan iyidir.

Ayrıntı: [docs/08-riskler-ve-sss.md](08-riskler-ve-sss.md)

## 14. ★ Doğrulayıcı yeşildi — çünkü yanlış şeyi ölçüyordu

Üç sunucuyu üreten ajanlar 'tamamlandı' dedi ve scripts/verify-contract.mjs üçünü de uyumlu buldu. İki gerçek parite kırığı bu yeşil tikin arkasında saklıydı.

Birincisi: Python ve C# hiçbir tool'da outputSchema BİLDİRMİYORDU (0/8). Dolayısıyla tools/call cevabında structuredContent üretmiyorlardı ve çağıran taraf JSON'ı metinden ayrıştırmak zorunda kalıyordu. Doğrulayıcı bunu kaçırmıştı çünkü yalnızca tool adlarını, parametreleri ve annotation'ları karşılaştırıyordu — yani sözleşmenin sadece GİRDİ tarafını.

İkincisi davranış paritesiydi: XURRENT_CONFIRM_POLICY=closed ve mock modda TypeScript ile Python onay soruyordu, C# sormadan yazıyordu. C#, ortak K5 kuralını yanlış yorumlamıştı — 'client onay SORAMIYORSA mock'ta engelleme' kuralını 'mock'ta hiç sorma'ya çevirmişti.

Doğrulayıcı genişletildi: her tool outputSchema bildiriyor mu, üst seviye alanlar sözleşmeyle örtüşüyor mu, gerçek bir tools/call'da structuredContent dolu geliyor mu, yanında insan-okunur bir text bloğu var mı, tools/list sırası kanonik mi.

Bir tool sözleşmesi çağıranın ne göndereceği kadar ne alacağını da tarif eder. Yoksa 'üç dil aynı çıktıyı üretir' ölçülemez bir slogandır.

> **Karar noktası:** Ajan raporları nasıl karşılanacak?
>
> ○ Rapora güven; üçü de 'tamamlandı' dedi — En hızlı; ek iş yok *(bedeli: 'Çalıştı' bir delil değil bir iddiadır; bu projede iki gerçek kırık tam olarak buradan geçti)*
>
> ○ Kodu elle gözden geçir — Bağımsız; ek araç gerektirmez *(bedeli: Ölçek büyüdükçe kaçırır; nitekim outputSchema eksikliği gözden kaçmıştı)*
>
> **→** **Doğrulayıcıyı genişlet ve tekrar ölç** — Aynı kusur bir daha kaçmaz; kontrol CI'da kalıcı olur *(bedeli: Doğrulayıcının kendisi bakım isteyen bir koddur)*
>
>
> **Bu projede seçilen:** Doğrulayıcıyı genişlet ve tekrar ölç. Kusur elle gözden geçirmede zaten kaçmıştı; aynı yöntemi tekrarlamak aynı sonucu verirdi. Doğrulayıcıya eklenen her kontrol, o kusurun bir daha sessizce geçmesini imkânsız kılıyor. Bugün üç sunucu da 8/8 outputSchema bildiriyor ve gerçek çağrılarda structuredContent dolu geliyor — bu artık ölçülen bir olgu.

### Prompt

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

### Sonra elinde ne olacak

- `scripts/verify-contract.mjs`
- `servers/python/src/xurrent_mcp/core/schemas.py`
- `servers/csharp/Core/ToolContracts.cs`
- `servers/typescript/src/core/context.ts`
- `servers/csharp/Mcp/McpTools.cs`
- `servers/csharp/Wizard.cs`

### Doğrula

```bash
node scripts/verify-contract.mjs --all
```

Beklenen çıktı repo kökünde: `outputSchema: 8/8 tool bildiriyor`

> ⚠️ **Tuzak:** C#'ın onay davranışı hizalandığında ikinci bir kırık ortaya çıktı: C#'ın kendi iç-süreç sihirbazında OnConfirm hiç bağlanmamıştı, yani onay hiç sorulamıyordu. Bir düzeltme, altındaki ikinci kusuru görünür yapabilir; ilk düzeltmeden sonra tekrar ölçmeden bitirme.

**Ne öğrendik**

- 'Çalıştı' raporu delil değildir. Bir ajanın çıktısını kabul etmeden önce, iddiayı bağımsız olarak ölçen bir komut çalıştır.
- Doğrulayıcının kör noktasını periyodik olarak sorgula: yeşil bir kontrolün ne ölçtüğü kadar NE ÖLÇMEDİĞİ de bilinmelidir.
- Parite şekil değil davranıştır. Aynı tool adlarını sunan iki sunucu, aynı girdiye farklı yanıt veriyorsa parite yoktur.
- Ortak bir kuralı üç yerde uyguluyorsan, kuralın metnini tek yerde yaz ve her implementasyonun ona atıf yapmasını iste. Yorum farkı tam da burada doğar.

Ayrıntı: [scripts/README.md](../scripts/README.md)

## 15. ★ Hesap yoksa live yolu nasıl test edilir?

XURRENT_MODE=live kod yolu bir kez bile çalıştırılmamıştı. Xurrent ücretsiz değil: freemium katmanı yok, self-servis deneme yok, sandbox satış üzerinden talep ediliyor. Yani repoyu klonlayan hiç kimse o yolu deneyemiyordu.

Çözüm sahte veri değil sahte DAVRANIŞ oldu. tools/fake-xurrent gerçek şemanın şeklini ve davranışını taklit eden yerel bir GraphQL ucu: Authorization yoksa 401, hesap header'ı yoksa 400, validation hatasında HTTP 200 + dolu errors, timeIncrement katı olmayan süreyi ret, günlük 480 dakika tavanı, istek başına tek mutation, 20 istek / 2 saniye aşımında 429.

XURRENT_GRAPHQL_URL zaten yapılandırılabilir olduğu için üç sunucunun live yolu TEK SATIR KOD DEĞİŞMEDEN bu uca bağlandı. Veri kaynağı da fixtures/ — yani mock ile live-sahte aynı sayıları üretiyor ve ilk senaryo tam olarak bunu doğruluyor.

Sonuç: üç dil × yedi senaryo = 21 kontrol, hepsi geçti. Ve gerçek bir hata çıktı: C# live adapter'ı günlük mesai tavanı için HER BULK KAYDINDAN ÖNCE ayrı bir LoggedMinutes sorgusu atıyordu. Kayıt başına iki istek demek bu; 8 kayıtlık bir bulk 20/2sn sınırını aşıp 429 alıyordu. TypeScript ve Python kayıt başına tek istek attığı için altında kalıyordu. Mock modda görünmüyordu, çünkü mock'ta HTTP yok.

Düzeltme: baseline gün başına bir kez sorulur, kendi yazdıkların yerel sayılır. 8 kayıt için LoggedMinutes 8 kez değil 1 kez gidiyor.

> **Karar noktası:** Hiç çalıştırılmamış live kod yolu ne yapılacak?
>
> ○ Olduğu gibi bırak, belgede 'test edilmedi' yaz — Dürüst; sıfır iş *(bedeli: Wire seviyesindeki hatalar yayında kalır ve ilk canlı bağlantıda toplu hâlde çıkar)*
>
> ○ Sandbox hesabı talep et ve bekle — Gerçek şemaya karşı doğrulama — tek gerçek kanıt budur *(bedeli: Satış üzerinden yürüyor; ders takvimine sığmaz ve repoyu klonlayan hiç kimse tekrarlayamaz)*
>
> **→** **Davranışı taklit eden yerel bir sunucu yaz** — Live kod yolu wire seviyesinde sürülür; herkes tek komutla tekrarlayabilir *(bedeli: Şema doğruluğunu KANITLAMAZ; bu sınır açıkça ve en görünür yerde yazılmalı)*
>
>
> **Bu projede seçilen:** Davranışı taklit eden yerel bir sunucu yaz. Bu araç tek bir şey yapar: 'live kod yolu hiç çalıştırılmadı' durumunu 'live kod yolu wire seviyesinde çalıştırıldı' durumuna taşır. Şema doğruluğu hâlâ doğrulanmamıştır ve README'nin ilk uyarı kutusu bunu söyler. Karşılığında ölçülebilir bir kazanç geldi: mock modda görünmeyen gerçek bir rate limit hatası bulundu ve düzeltildi.

### Prompt

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

### Sonra elinde ne olacak

- `tools/fake-xurrent/server.mjs`
- `tools/fake-xurrent/senaryolar.mjs`
- `tools/fake-xurrent/README.md`
- `servers/csharp/Xurrent/LiveAdapter.cs`

### Doğrula

```bash
node tools/fake-xurrent/senaryolar.mjs --dil ts
```

Beklenen çıktı repo kökünde: `0 başarısız`

> ⚠️ **Tuzak:** İki yanlış alarm yaşandı. (1) İlk koşuda C# iki senaryoda düştü; izole çalıştırınca ikisini de geçti. Sebep: üç dil aynı sahte sunucu örneğine yazıyordu ve günlük 480 dakika tavanı doluyordu — sırf sırada sonda olduğu için başarısız görünen bir dil. (2) Sonra bulk senaryosu yine düştü; sebep sahte sunucunun timeEntries sorgusunda date filtresini yok saymasıydı. İkisinde de bozuk olan testti, kod değil.

**Ne öğrendik**

- Yapılandırılabilir bir uç adresi, test edilemez bir kod yolunu test edilebilir yapar. Bu tek satırlık tasarım kararı sonradan gerçek bir hata buldurdu.
- Sahte bir sunucunun değeri sahte veride değil, zorladığı KISITLARDA. 'HTTP 200 + errors dolu' gibi bir davranışı taklit etmiyorsan hiçbir şey ölçmüyorsun.
- Kırmızı bir test önce KENDİNİ suçlamalı. Bu koşuda iki yanlış alarm yaşandı ve ikisi de koda dokunulmadan önce çözüldü.
- Bir test aracının NE KANITLAMADIĞINI da yaz. Sınırı yazılmayan bir araç, zamanla bir garanti gibi okunur.

Ayrıntı: [tools/fake-xurrent/README.md](../tools/fake-xurrent/README.md)

---

# Yayın

## 16. Yayın: mantıksal commit'ler ve neyin doğrulanmadığını yazma disiplini

Repo public olarak yayınlanmadan önce bir tarama yapıldı: .env commit edilmiş mi (hayır, .gitignore'da), kaynak ağacında gerçek token kalıbı var mı (yok), build çıktıları commit'lenmiş mi (hayır), mutlak yol sızıntısı var mı (yok), lisans README ile tutarlı mı (MIT, evet).

Değişiklikler dosya başına değil mantıksal olarak bölündü. İlk yayın dört commit'ti: ortak sözleşme ve iskelet, üç dilde sunucu implementasyonu, sihirbaz ile doğrulama script'leri, Türkçe ders notları ve sunum. Sahte Xurrent sunucusu sonradan beşinci commit olarak eklendi — çünkü tek cümleyle anlatılabilen ayrı bir değişiklikti.

Sınır ölçütü şuydu: bir commit tek bir cümleyle anlatılabiliyorsa doğru boyuttadır.

Yayının en zor kısmı kod değildi. README'nin 'Durum ve sınırlar' bölümü, live modun gerçek bir hesaba karşı hiç çalıştırılmadığını ve GraphQL şemasının gözlem değil çıkarım olduğunu açıkça söylüyor. Bir öğretim materyalinde neyin doğrulanmadığını yazmak, neyin çalıştığını yazmak kadar değerlidir.

> **Karar noktası:** Değişiklikler commit'lere nasıl bölünecek?
>
> ○ Tek büyük commit — En hızlı; çakışma yok *(bedeli: Geçmiş okunamaz; tek bir değişiklik geri alınamaz; bisect işe yaramaz)*
>
> ○ Dosya veya klasör başına commit — İnce taneli; her dosyanın gerekçesi ayrı yazılabilir *(bedeli: Yarım çalışan ara durumlar doğar; hiçbir commit tek başına tutarlı değildir)*
>
> **→** **Mantıksal commit: her biri tek cümleyle anlatılabilsin** — Geçmiş bir anlatıya dönüşür; her commit kendi başına tutarlıdır *(bedeli: Değişiklikleri elle gruplamak ve bazen ayrı ayrı test etmek gerekir)*
>
>
> **Bu projede seçilen:** Mantıksal commit: her biri tek cümleyle anlatılabilsin. Bir öğretim reposunda git geçmişi de materyaldir. Dört commit dört cümleyle anlatılabiliyor ve her biri kendi başına derlenip doğrulanabiliyor. Beşinci commit sonradan geldi çünkü 'live yolunu yerel bir sahte uca karşı çalıştır ve ortaya çıkan hatayı düzelt' başlı başına bir cümledir.

### Prompt

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

### Sonra elinde ne olacak

- `README.md`
- `LICENSE`
- `.gitignore`
- `.env.example`

### Doğrula

```bash
git check-ignore -v .env
```

Beklenen çıktı repo kökünde: `.gitignore`

**Ne öğrendik**

- Yayın taraması bir kontrol listesidir, hatırlama işi değil. Listeyi yaz, her maddeye ne bulduğunu yaz, sonra yayınla.
- Commit sınırını 'hangi dosyalar' değil 'tek cümleyle ne anlattığı' belirler.
- Neyin doğrulanmadığını yazmak bir zayıflık itirafı değil, materyalin güvenilirliğidir. Sınırı yazılmamış bir iddia, okuyanın zamanını çalar.
- Sırları taramayı otomatikleştir ve .env'i ilk günden .gitignore'a koy. Sonradan temizlenen bir geçmiş asla tam temizlenmez.

Ayrıntı: [README.md](../README.md)

---

## Bu defteri kendi projene uygulamak

Sıra buradaki adımlara özel değil; genellenebilir olan şu:

1. **Önce keşfet, sonra yaz.** Bu projede en pahalı iş kod yazmak değil, API'nin
   gerçekte ne yapabildiğini bulmaktı. `timeEntryCreate` bir ticket'a bağlanamaz
   bulgusu tüm mimariyi belirledi; kaçırsaydık iki gün sonra baştan yazardık.

2. **Sözleşmeyi implementasyondan önce yaz.** Dil-bağımsız bir sözleşme, üç
   implementasyonun aynı şeyi üretmesini *sağlar*, ummaz.

3. **Test verisini öğretici tasarla.** Rastgele fixture, rastgele güven verir.
   Kapalı sayılması gereken bir kayıt, çakışan iki toplantı, yuvarlanması gereken
   bir süre koyun — filtreniz gerçekten çalışıyor mu görün.

4. **Mimari kararı ölç.** Bu projede "C# için üç ayrı proje gerekir" kararı
   yazılmıştı; ham JSON-RPC sondası onu çürüttü. Ölçmeseydik gereksiz karmaşıklığı
   ders diye öğretecektik.

5. **Kırmızı test önce kendini suçlasın.** İki kez bir dilin "bozuk" olduğunu
   sandık; ikisinde de testin kendisi bozuktu.

6. **Kısıtı sakla, bahane etme.** Karşılanamayan bir ister varsa kullanıcıya
   söyleyin — sessizce başka bir şey yazmayın.

## İlgili

- [10 — Sıfırdan geliştirme](10-sifirdan-gelistirme.md) — aynı yolun anlatımlı hali
- [Atölye koşucusu](../clients/atolye/README.md) — bu adımları interaktif yürütür
- [00 — Genel bakış](00-genel-bakis.md) — projenin ne olduğu
