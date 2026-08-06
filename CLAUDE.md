# CLAUDE.md

Bu dosya, bu depoda çalışan Claude ajanları içindir. Kısa tutuldu; her madde
bu projede **gerçekten yaşanmış** bir olaydan geliyor.

---

## ★ 1. Alternatif varsa SOR

**Bir işi yapmanın birden fazla makul yolu varsa, seçmeden önce kullanıcıya sor.**

Seçenekleri, her birinin **artısını ve eksisini**, ve önerini sun. Sonra bekle.
"Makul bir varsayımla ilerledim" bu depoda kabul edilebilir bir cevap değil —
çünkü buradaki kararların çoğu geri alınması pahalı olan mimari kararlar.

Sorman gereken tipik yerler:

- Bir kütüphane/SDK/sağlayıcı seçimi
- Bir kısıtı aşmanın birden çok yolu olması *(bu depoda tam olarak bu oldu:
  ticket'a geçmiş tarihli zaman yazmanın üç yolu vardı, üçü farklı şey feda
  ediyordu — kullanıcı **üçünü de kodlamayı** seçti, ben tek birini seçseydim
  yanlış olurdu)*
- Bir davranışın nerede duracağı (sözleşmede mi, kodda mı, yapılandırmada mı)
- Dosya/klasör düzeni değişikliği
- Bir testin "atlandı" mı "başarısız" mı sayılacağı

**Sormaman gereken yer:** açık bir hatayı düzeltmek, eksik bir testi yazmak,
yazım hatası. Bunlar için sadece yap ve söyle.

Kural şu değil: "her şeyi sor." Kural şu: **senin tercihinle kullanıcının
tercihi farklı olabilecekse, sor.**

---

## 2. Bu depo nedir

Xurrent (ITSM) için bir MCP sunucusu ve chatbot — **üç dilde, tek sözleşmeyle**.
Aynı zamanda bir **AI destekli geliştirme dersinin** materyali.

Bu ikinci nokta önemli: burada kod, öğretilecek şeyin kendisi. Kısayol almak
yalnızca kaliteyi değil **dersi** bozar.

```
contract/tools.json     ← TEK GERÇEK KAYNAK. 8 tool. Önce burası değişir.
contract/protocol.md    ← çift MCP protokol sözleşmesi (2025-11-25 + 2026-07-28)
fixtures/               ← ortak mock veri; üç dil de AYNI dosyaları okur
servers/{typescript,python,csharp}/
clients/{wizard,inspector,atolye,web}/
tools/{fake-xurrent,fake-gemini}/   ← hesapsız/anahtarsız çalıştırma
scripts/                ← doğrulayıcılar ve üreticiler
docs/                   ← 15 bölüm anlatım notu (Türkçe)
```

**Sözleşme önce gelir.** Bir tool'un davranışı değişecekse önce
`contract/tools.json`, sonra üç implementasyon. Tersi sapma üretir ve sapma
`scripts/verify-contract.mjs` ile yakalanır.

---

## 3. Komutlar

```bash
node scripts/test-all.mjs          # HER ŞEY: derleme, birim, sözleşme, uyum, uçtan uca
node scripts/test-all.mjs --hizli  # yavaş adımları atla
node scripts/verify-contract.mjs --all
node scripts/mcp-uyum.mjs --hepsi --protokol ikisi
node clients/wizard/wizard.mjs --server ts|py|cs --auto
```

Değişiklik yaptıysan **`test-all` koş.** 16 adım, ~1 dakika. Kısmi koşu yeterli
değil: bu depodaki hataların çoğu, geliştiricinin bakmadığı katmanda çıktı.

Üretilen dosyaları elle düzenleme:
`docs/11-prompt-defteri.md` ← `scripts/gen-prompt-defteri.mjs`,
`fixtures/calendar.ics` ← `scripts/gen-ics.mjs`.

---

## 4. Yazım kuralları

- **Yorumlar ve kullanıcıya dönen metinler Türkçe; tanımlayıcılar İngilizce.**
- **Commit mesajları İngilizce.**
- Bir tuzağın geçtiği satıra **neden** yorumu yaz. Ne yaptığını değil, *neden*
  öyle yaptığını.
- `stdio` modunda **stdout yalnızca JSON-RPC**. Tüm loglar stderr'e. Tek bir
  `console.log` çerçeveyi bozar ve sunucu "bağlanamıyor" görünür.
- Sırları asla loglama: `XURRENT_TOKEN`, `GEMINI_API_KEY`, `XURRENT_STATE_SECRET`.

---

## 5. Doğrulama disiplini

Bu depodaki hataların **hepsi** uçtan uca testlerden geçmişti. Her biri yalnızca
tek bir katman tarafından yakalandı.

- **"Çalıştı" raporu delil değildir.** Bir ajan ya da önceki bir oturum "hepsi
  geçti" dediyse, **kendin ölç**. Bu depoda birden çok kez rapor yanlış çıktı.
- **Kırmızı bir test önce kendini suçlasın.** Üç kez ölçüm aracının kendisi
  bozuktu: saat dilimine bağlı kırılan bir test, paylaşılan durumdan yanlış
  alarm veren bir koşucu, ve *kurcalama tespitini* test ederken hiç kurcalamayan
  bir sonda.
- **Mimari kararı ölç.** "C# için üç ayrı proje gerekir" planı, ham JSON-RPC
  sondasıyla çürütüldü.
- **Negatif test yaz.** Bir düzeltmeyi kasten boz ve hatanın geri geldiğini gör.
  Yakalanamayan bir düzeltme, düzeltme değildir.
- Bir ihlali kapatamıyorsan **kapattım deme.** `scripts/bilinen-ihlaller.json`
  bir borç defteridir; gerekçesiyle oraya yaz. Şu an **boş** — öyle kalsın.

---

## 6. Bu depoda seni ısıracak tuzaklar

Hepsi `contract/tools.json` içinde `teachingNotes` olarak da duruyor.

| Tuzak | Sonuç |
|---|---|
| `RequestFilter.member` vs `TaskFilter.assignee` | Karıştırırsan **boş liste**, hata değil |
| `view` varsayılanı `current_account` | `all` geçmezsen işlerin bir kısmı görünmez |
| `TaskStatus`'ta **beş** terminal durum | Yalnızca `completed`'ı elemek yetmez |
| `timeIncrement` (varsayılan 60) | Katı olmayan süre **sessizce reddedilir** |
| Yol B'de `timeSpent` **artımlı** | "Toplamı 60 yap" değil, "üzerine 60 ekle" |
| Graph `dateTime`: offset yok, 7 kesirli hane | Doğrudan parse edersen yanlış instant |
| Google `singleEvents` varsayılanı `false` | Tekrarlayan toplantılar hiç görünmez |
| MCP `-32601` vs `-32602` | `-32601` "eski sunucu" sinyalidir; yanlış yerde dönersen uyumluluk sondası yanılır |
| `XURRENT_STATE_SECRET` boşsa süreç başına rastgele | Çok replikalı dağıtımda onay akışı **sessizce** kırılır |

---

## 7. Git

- **Onay almadan commit veya push yapma.** Mesajı da teyit ettir.
- **Paralel ajan çalışırken `git add -A` kullanma.** Bu oturumda bir commit,
  başka bir ajanın dosyalarını kendi mesajıyla alakasız şekilde içine aldı.
  Kapsamı açıkça belirt: `git add servers/typescript docs/`.
- Commit öncesi sır taraması yap: `.env` yok mu, gerçek token kalıbı var mı,
  `node_modules`/`.venv`/`bin`/`obj` sızmış mı.

---

## 8. Ders materyaline özel

- **Doğrulanamayan sayı yazma.** `docs/` ve `docs/atolye/adimlar.json` içindeki
  her rakam repodan üretilebilir olmalı.
- **Kısıtı sakla, bahane etme.** Karşılanamayan bir ister varsa kullanıcıya
  söyle; sessizce başka bir şey yapma.
- Bir ders adımı **ortam yapılandırmasına bağlı olmamalı.** Sihirbaz adımları
  `provider` gibi alanları açıkça verir — varsayılana güvenmek, ders gün
  değiştiğinde kırılmasına yol açtı.
- `docs/` bölümleri birbirine ve README'ye linkli olmalı.

---

## 9. Bilinen sınırlar

- **`live` mod gerçek bir Xurrent hesabına karşı hiç çalıştırılmadı.**
  `tools/fake-xurrent` bunu wire seviyesinde test eder, şema doğruluğunu
  **kanıtlamaz**. Açık maddeler: `docs/08-riskler-ve-sss.md` → `DOĞRULANMALI`.
- **Gerçek Gemini API'sine hiç istek atılmadı** (`tools/fake-gemini` ile test edildi).
- Google ve Microsoft Graph takvim sağlayıcıları gerçek uçlara karşı denenmedi.

Bu sınırlar README'de ve `docs/08`'de de yazılı. Bir şeyi doğruladığında
**oradaki maddeyi güncelle** — liste yalnızca küçülmeli.

---

## 10. Metrikler — bir değişikliği tutma ya da atma kuralı

> Bu bölüm [karpathy/autoresearch](https://github.com/karpathy/autoresearch)
> yaklaşımından uyarlandı: **sabit bütçeli deney, tek karşılaştırılabilir ölçü,
> açık tut-veya-at kuralı.**
>
> Bir fark var ve önemli: oradaki `val_bpb` bir **süreklilik**tir, iyileşmesi
> beklenir. Bizim ölçülerimizin çoğu **kısıttır** — tutmak zorundadır. Hepsini
> tek bir skalara toplamak, ölçüsüz şeyleri toplamak olur ve bir regresyonu
> başka bir iyileşmenin arkasına saklar. Bu yüzden ikiye ayrılmıştır.

### Bütçe

```bash
node scripts/test-all.mjs          # ~62 sn · 16 adım
```

**Bir değişiklik tek bütçede doğrulanabilmelidir.** Doğrulanamıyorsa değişiklik
çok büyüktür; böl. `autoresearch`'ün 5 dakikası neyse bu 62 saniye odur:
ucuz olduğu için **her** değişiklikten sonra koşulur, ve pahalı olmadığı için
atlanmasının mazereti yoktur.

### KAPI — tutmak zorunda (ihlali = değişiklik ATILIR)

Bunlar puan değil, geçme şartıdır. Biri bile düşerse gerisine bakılmaz.

| Kapı | Bugünkü değer |
|---|---|
| `test-all` adımları | **16 / 16** |
| MCP MUST ihlali | **0** |
| MCP SHOULD ihlali | **0** |
| Sözleşmeye uyan sunucu | **3 / 3** |
| Sihirbaz (her dil) | **17 / 17 × 3** |
| `bilinen-ihlaller.json` | **boş** |

### SKOR — iyileştirilmeye çalışılan, SIRALI okunur

Toplanmaz, **sözlüksel** okunur: üstteki eşitse alttakine bakılır. Bir üstteki
kötüleşiyorsa alttaki ne kadar iyileşirse iyileşsin **değişiklik kötüdür**.

| # | Ölçü | Yön | Bugün |
|---|---|---|---|
| 1 | Uyum maddesi (geçen) | ↑ | **252** |
| 2 | Live kod yolu senaryosu | ↑ | **21** |
| 3 | Gemini wire iddiası | ↑ | **29** |
| 4 | Birim test | ↑ | **843** (218 ts · 300 py · 325 cs) |
| 5 | `test-all` süresi | ↓ | **62 sn** |

### Tut-veya-at

```
KAPI'lardan biri düştü            → AT. Gerekçe aramadan.
KAPI tam, SKOR sözlükselde kötü   → AT ya da NEDEN kabul edilebilir olduğunu yaz.
KAPI tam, SKOR aynı               → tut (davranış değişmediyse), ama neyi iyileştirdiğini söyle.
KAPI tam, SKOR iyi                → tut.
```

Bir değişikliği "sonra bakarız" diye tutma. `bilinen-ihlaller.json` bir borç
defteridir ve **boştur** — öyle kalması bir hedeftir, bir tesadüf değil.

### ★ Karşılaştırılabilirlik — bizim `val_bpb`-vocab-bağımsızlığımız

`autoresearch`'te metrik, model mimarisi değişse bile kıyaslanabilir olacak
şekilde seçilmiştir. Bizdeki karşılığı:

**Bir sayı, üç dilde ve iki protokol revizyonunda aynı anlama gelmiyorsa metrik
değildir.**

- Bir dilde iyileşip diğerinde kötüleşen bir değişiklik **iyileşme değildir** —
  bu deponun tezi "üç dil aynı şeyi üretir"dir.
- `2026-07-28`'de geçip `2025-11-25`'te düşen bir kontrol **geçmemiştir**.
- Bu yüzden `test-all` üç dili de, `mcp-uyum` iki revizyonu da koşar. Tek dil
  koşup "geçti" demek, ölçmemekle aynı şey.

### Metrik OLMAYAN şeyler

Bu maddelerin hepsi bu depoda gerçekten yaşandı.

- **Test sayısı kalite değildir.** 843 test var; yüz tane önemsiz test eklemek
  bu sayıyı büyütür, hiçbir şey iyileştirmez. Sayıyı ancak **yeni bir hata
  sınıfı** yakalayan test artırmalı.
- **"Hepsi yeşil" delil değildir.** Bu depoda **üç kez** ölçüm aracının kendisi
  bozuktu: saat dilimine bağlı kırılan bir test, paylaşılan durumdan yanlış alarm
  veren bir koşucu, ve kurcalama tespitini sınarken hiç kurcalamayan bir sonda.
  Sonuncusu bir güvenlik özelliğini "doğruladı" — hiç sınamadan.
- **Tekrar üretilemeyen sayı metrik değildir.** Bir ölçüm koşudan koşuya
  değişiyorsa önce **ölçeni** düzelt. Kararsız bir kontrol, olmayan kontrolden
  kötüdür: güven verir, korumaz.
- **Kapsam yüzdesi hedef değildir.** Bu depodaki hataların hiçbiri "satır
  çalıştırılmadı" diye kaçmadı; **yanlış katmanda** arandıkları için kaçtılar.

### Yeni metrik eklemek

Ekleyebilirsin, ama üç sorunun cevabı yazılı olmalı:

1. Bu sayı **hangi hata sınıfını** yakalar, ve mevcut hangi ölçü onu kaçırıyor?
2. Üç dilde ve iki revizyonda **aynı anlama** geliyor mu?
3. Aynı girdide **aynı sonucu** veriyor mu? (Beş kez koş ve göster.)

Üçüne de cevap veremiyorsan, eklediğin şey bir metrik değil bir gürültüdür.
