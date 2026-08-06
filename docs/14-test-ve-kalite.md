# 14 — Test ve kalite

> **Tez:** Bu repoda **altı** ayrı doğrulama katmanı var ve hiçbiri gereksiz değil.
> Her katman **farklı bir hata sınıfı** yakalar; bir üst katmanın geçmesi alt
> katmanın doğru olduğunu **kanıtlamaz**. Bölümün omurgası bu iddianın ispatı:
> bu repoda gerçekten olmuş **üç kusur**, üçü de uçtan uca testlerden **sessizce
> geçmişti** ve her biri **yalnızca tek bir katman** tarafından yakalandı.

---

## Tek komut

```bash
node scripts/test-all.mjs
```

Altı katmanın hepsini sırayla koşar, her adım için **ad · süre · durum · kanıt**
basar, sonunda özet tablo verir.

```bash
node scripts/test-all.mjs --hizli                    # yavaş adımları atla
node scripts/test-all.mjs --sadece sozlesme,birim    # ad veya grup öneki
node scripts/test-all.mjs --liste                    # adımları listele
node scripts/test-all.mjs --json                     # rapor stdout'a, anlatım stderr'e
node scripts/test-all.mjs --bilinen-ihlaller         # kayıtlı MUST ihlalleri KALDI sayılmasın
```

### Üç durum modeli — sihirbaz ve atölye ile aynı

| Durum | Anlamı | Çıkış kodunu etkiler mi |
|---|---|---|
| `GEÇTİ` | Kontrol çalıştı ve tuttu | — |
| `KALDI` | Kontrol çalıştı ve **tutmadı** | **evet**, exit 1 |
| `ATLANDI` | Kontrol **çalıştırılamadı** (ön koşul yok) | hayır |

Bu ayrım bilinçlidir ve tek bir gözlemden doğdu: `dotnet` kurulu olmayan bir
makinede C# adımlarının kırmızı yanması, **gerçek bir kırılmayı gürültüye gömer.**
Ön koşulu olmayan adım `ATLANDI`'dır ve **asla** çıkış kodunu 1 yapmaz. Aynı
mantık adım bağımlılıklarına da uygulanır: `derle-ts` kalırsa ondan türeyen altı
adım kırmızı yanmaz, `ATLANDI` olur ve tek bir kök neden gösterilir.

---

### Ölçülmüş koşu — 2026-08-05, node 24, macOS

Sayılar tahmin değil; aşağıdaki tablo gerçek bir koşunun çıktısıdır.

| adım | süre | durum | kanıt |
|---|---|---|---|
| `derle-ts` | 1.4s | GEÇTİ | tsc temiz · `dist/mcp/stdio.js` üretildi |
| `derle-py` | 0.1s | GEÇTİ | `uv sync` tamam |
| `derle-cs` | 0.7s | GEÇTİ | derleme başarılı · uyarı yok |
| `birim-ts` | 0.4s | GEÇTİ | 304 geçti |
| `birim-py` | 1.0s | GEÇTİ | pytest: 395 geçti |
| `birim-cs` | 2.0s | GEÇTİ | 432 geçti (`XurrentMcp.Tests` + `sema-testi`) |
| `sozlesme` | 1.6s | GEÇTİ | 3/3 sunucu · **10 tool** |
| `mcp-uyum` | 25s | GEÇTİ | 6 koşu · 252 madde geçti · **MUST ihlali yok** |
| `adimlar` | 0.0s | GEÇTİ | 16 adım şemaya uygun |
| `adimlar-atolye` | 0.0s | GEÇTİ | atölye adım dosyası şemaya uygun |
| `prompt-defteri` | 0.0s | GEÇTİ | docs/11 ↔ `adimlar.json` güncel |
| `pluginler` | 0.0s | GEÇTİ | 7 manifest şemaya ve anlamsal kurallara uygun |
| `konektor` | 0.0s | GEÇTİ | connector.yaml ↔ üretici senkron |
| `sihirbaz-ts` | 0.7s | GEÇTİ | 24 geçti, 0 başarısız, 0 atlandı |
| `sihirbaz-py` | 1.7s | GEÇTİ | 24 geçti, 0 başarısız, 0 atlandı |
| `sihirbaz-cs` | 4.3s | GEÇTİ | 24 geçti, 0 başarısız, 0 atlandı |
| `senaryolar` | 67s | GEÇTİ | 62 geçti (GraphQL a–g + `[rest]` a–e + çapraz-dil h) |
| `atolye` | 0.1s | GEÇTİ | 16 adım · 16 geçti |
| `kabuk-http` | 3.1s | GEÇTİ | 3 dilde: v1 oturum ✓ v2 10 tool ✓ anahtarsız 401 ✓ |
| `wire-denetimi` | 0.5s | GEÇTİ | 31 iddia · 31 geçti |

**20 geçti · 0 kaldı · 0 atlandı (~110 sn).**

> Tarihî not: 2026-08-03 tarihli İLK koşuda `mcp-uyum` 8 MUST ihlaliyle
> kırmızıydı ve tablo 16 adımdı. İhlallerin hepsi kapatıldı (docs/12'deki
> BULGU bölümleri), borç defteri boşaldı ve boş kaldı; sözleşme 10 tool'a,
> doğrulama 20 adıma çıktı. Kırmızıdan yeşile giden yol dersin kendisidir.

---

## Piramit

```
                        ┌───────────────────────────────┐
        wire            │  wire-denetimi (31 iddia)     │   İstemci DOĞRU MU konuşuyor
                        ├───────────────────────────────┤
        uçtan uca       │  sihirbaz ×3 · senaryolar     │   Akış çalışıyor mu
                        │  atölye                       │
                        ├───────────────────────────────┤
        protokol        │  mcp-uyum (65 madde)          │   Spec'e uyuyor mu
                        ├───────────────────────────────┤
        sözleşme        │  verify-contract              │   Üç dil AYNI şeyi mi sunuyor
                        ├───────────────────────────────┤
        veri şeması     │  validate-steps · defter       │   Ders verisi tutarlı mı
                        ├───────────────────────────────┤
        birim           │  ts: node --test              │   Çekirdek mantık doğru mu
                        │  py: pytest · cs: dotnet test │
                        └───────────────────────────────┘
```

Klasik piramitten iki farkı var:

1. **Sözleşme katmanı ayrı bir kat.** Çünkü bu repoda "aynı şeyi yapıyorlar"
   iddiası ürünün kendisidir. Üç dil ayrı ayrı doğru olabilir ve yine de
   **birbirinden farklı** olabilir; bunu yalnızca üçünü yan yana koyan bir
   katman yakalar.
2. **Wire katmanı en tepede.** Uçtan uca testler "akış tamamlandı mı" sorusunu
   cevaplar. Wire denetimi "**doğru mu konuştuk**" sorusunu. İkincisi olmadan,
   yanlış ama çalışan bir istemci fark edilmez — nitekim edilmedi (Vaka B).

---

## Katman katman: ne yakalar, ne YAKALAMAZ

### 1 — Birim: çekirdek iş mantığı

| | |
|---|---|
| **Nerede** | `servers/typescript/src/**/*.test.mjs` · `servers/python/tests/` · `servers/csharp/XurrentMcp.Tests/` |
| **Nasıl** | `npm test` · `uv run pytest -q` · `dotnet test` + `dotnet run -- sema-testi` |
| **test-all adımı** | `birim-ts` · `birim-py` · `birim-cs` |

**Yakalar:** stratejilerin ürettiği mutation sayısı ve sırası; `timeIncrement`
katı olmayan süre; 80 karakteri aşan açıklama; backdate sınırı; takvim atlama
kuralları; çakışan toplantıların **bir kez** sayılması; gece yarısını aşan
toplantının pencereye kırpılması; `iCalUID` + başlangıç anı ile tekilleştirme;
`requestState` imza/parmak izi/TTL/nonce doğrulaması; göreli tarih
materyalizasyonu.

**YAKALAMAZ:** bu mantığın **dışarıya nasıl sunulduğunu**. Bir birim testi
`validate()` fonksiyonunun doğru hatayı ürettiğini kanıtlar; o hatanın MCP
yanıtında `isError=true` olarak görünüp görünmediğini **bilmez**. Vaka C tam
olarak bu boşluktan geçti.

> ★ **Kural:** birim testleri **I/O yapmaz, ağa çıkmaz, gerçek zamana bağlı
> olmaz.** Zaman ve rastgelelik enjekte edilebilir olmalıdır. Fixture okumak
> serbesttir. Gerekçesi aşağıda: *Kırılgan test vakası*.

> ★ **Kural:** testin adı **NE doğruladığını** söyler. `test1` değil,
> `two_step ikinci adımda assignment göndermez` gibi. Bir test kırıldığında
> okunan ilk şey adıdır; adı bir soruya cevap vermiyorsa test iki kez okunur.

### 2 — Veri şeması: ders verisinin tutarlılığı

| | |
|---|---|
| **Nerede** | `scripts/validate-steps.mjs` · `scripts/gen-prompt-defteri.mjs --kontrol` |
| **test-all adımı** | `adimlar` · `prompt-defteri` |

**Yakalar:** `docs/wizard/steps.json` şemadan sapması; `docs/11-prompt-defteri.md`
ile kaynağı `docs/atolye/adimlar.json` arasındaki **ayrışma** (defter üretilir,
elle yazılmaz).

**YAKALAMAZ:** adımların **anlamlı** olup olmadığını. Şemaya uygun ama yanlış
bir `expect` bloğu bu katmandan geçer; onu sihirbaz koşusu yakalar.

### 3 — Sözleşme: üç dil aynı şeyi mi sunuyor

| | |
|---|---|
| **Nerede** | `scripts/verify-contract.mjs` |
| **Nasıl** | Üç sunucuyu ayağa kaldırır, `tools/list` + `tools/call` çıktısını `contract/tools.json` ile karşılaştırır |
| **test-all adımı** | `sozlesme` |

**Yakalar:** bir tool adının, parametre adının, `annotation`'ın veya
`structuredContent` alanının üç dilden **birinde kayması**. Bu kayma sessizdir:
sihirbaz genellikle yine çalışır, yalnızca *o dilde* farklı bir şey yapar.

**YAKALAMAZ:** protokol seviyesindeki davranışı. Sözleşme "hangi tool'lar var ve
ne döndürüyorlar" der; "bozuk JSON'a hangi hata kodu dönüyor" demez.

### 4 — Protokol: MCP spec uyumu

| | |
|---|---|
| **Nerede** | `scripts/mcp-uyum.mjs` — 65 madde, SDK **kullanmadan**, ham JSON-RPC |
| **test-all adımı** | `mcp-uyum` |
| **Anlatım** | [12 — MCP uyum](12-mcp-uyum.md) |

**Yakalar:** hata kodları, `id` tipi korunması, notification'a yanıt vermeme,
stdout'un yalnızca JSON-RPC olması, `resultType` / `ttlMs` / `cacheScope`,
kaldırılmış RPC'lerin gerçekten `-32601` dönmesi, MRTR onay turunun tamamı,
`isError` semantiği.

★ **Neden SDK kullanmıyor:** SDK ile yazılmış bir test, SDK'nın kabul ettiği her
şeyi doğru sayar. Spec ihlallerinin çoğu **SDK'nın hoş gördüğü** yerlerdedir. Bu
yüzden bu doğrulayıcı sürece düz JSON satırları yazar ve düz JSON satırları okur.

**YAKALAMAZ:** iş mantığının doğruluğunu. `timeIncrement` hesabı tamamen yanlış
olabilir; protokol açısından kusursuz bir yanıt olarak döner.

### 5 — Uçtan uca: akış çalışıyor mu

| | |
|---|---|
| **Nerede** | `clients/wizard/wizard.mjs` (3 dil) · `tools/fake-xurrent/senaryolar.mjs` · `clients/atolye/atolye.mjs` |
| **test-all adımı** | `sihirbaz-ts` · `sihirbaz-py` · `sihirbaz-cs` · `senaryolar` · `atolye` |

**Yakalar:** parçaların birleşimini. Sihirbaz gerçek bir MCP client'tır ve ders
akışının her adımının **beklenen sayıları** ürettiğini doğrular. `senaryolar`
`XURRENT_MODE=live` kod yolunu yerel sahte Xurrent'a karşı koşar — HTTP
katmanı, auth header'ları, GraphQL metinleri, `errors[]` şekilleri, `two_step`'in
iki isteği, bulk throttling.

**YAKALAMAZ — ve bu bölümün ana mesajı budur:** *sessiz* yanlışları. Uçtan uca
test "sonuç geldi mi" diye bakar. Sonucun **nasıl** geldiğine bakmaz. Aşağıdaki
üç vakanın üçü de bu katmandan **yeşil** geçti.

### 6 — Wire: doğru mu konuşuyoruz

| | |
|---|---|
| **Nerede** | `tools/fake-gemini/wire-denetimi.mjs` — 31 iddia |
| **test-all adımı** | `wire-denetimi` |

Sahte Gemini sunucusu istemciyi **çalıştırır**; bu sonda istemciyi **denetler**.
Her isteğin gövdesi tek tek iddiaya sokulur: anahtar header'da mı, URL'de değil
mi; `systemInstruction` ayrı alanda mı; `contents` içinde `system` rolü var mı;
gönderilen şemada Gemini'nin kabul etmediği anahtar kelime kalmış mı;
`functionResponse.id`, `functionCall.id` ile eşleşiyor mu.

**Yakalar:** protokolün *lehçesini*. MCP `inputSchema` tam JSON Schema 2020-12;
Gemini OpenAPI'nin dar bir alt kümesini kabul eder. Çevirici neyi düşürdüğünü
raporlar, bu sonda **düşürmesi gerekeni düşürdüğünü** doğrular.

**YAKALAMAZ:** cevabın kalitesini. Model saçmalıyor olabilir; wire formatı
kusursuz olur.

---

# ★ Üç gerçek vaka — hepsi uçtan uca testten sessizce geçti

Bunlar örnek değil, **kayıt**. Üçü de bu repoda oldu, üçü de sihirbazı yeşil
bıraktı, üçü de **yalnızca tek bir katman** tarafından yakalandı.

## Vaka A — Sihirbaz `_meta`'sız `server/discover` gönderiyordu

**Yakalayan katman:** protokol (ham JSON-RPC sondası).
**Sessizce geçtiği katmanlar:** birim, sözleşme, uçtan uca, wire.

Sihirbaz uzun süre *"bu sunucu yeni revizyonu konuşmuyor"* dedi. **Sunucu
konuşuyordu.** Uyumluluk sondası `server/discover`'ı zorunlu `_meta` bloğu
**olmadan** gönderiyordu:

| Sunucu | `_meta` yokken dönen hata | Yorumu |
|---|---|---|
| Python | `-32601 Method not found` | Gerçek bir v1 sunucuyla **birebir aynı kod** |
| C# | `-32602` + *"requires per-request metadata…"* | Açıkça "sondan hatalı" der |

İki kodu ayırmayan bir sonda, v2 konuşan bir sunucuyu **ömür boyu** v1 sanar.

**Neden diğer katmanlar göremedi:** sihirbaz v1'e düşüp akışı tamamlıyordu. 17
kontrolün 17'si geçiyordu. Sözleşme doğrulaması da v1 üzerinden geçiyordu, çünkü
tool listesi iki revizyonda da aynı. Yani **her şey yeşildi ve ölçüm yanlıştı.**

**Düzeltme iki parçalı:** sondaya üç zorunlu `_meta` anahtarı eklendi ve
`-32602`/`-32021` alındığında **v1'e düşülmemesi** kuralı kondu.

**Ders:** *"Sunucu bunu desteklemiyor"* sonucuna varmadan önce **isteğinin
doğru olduğunu** kanıtla. Aynı hata kodu iki farklı sebepten gelebilir; bir
sondanın işi o iki sebebi ayırmaktır.

## Vaka B — TypeScript parametresiz tool'a boş `parameters` gönderiyordu

**Yakalayan katman:** wire.
**Sessizce geçtiği katmanlar:** birim, sözleşme, protokol, uçtan uca.

`xurrent_whoami` parametresizdir. TypeScript istemcisi Gemini'ye tool tanımını
gönderirken boş bir `parameters` nesnesi ekliyordu. Gemini bunu **kabul ediyor**,
sohbet **çalışıyor**, tool **çağrılıyordu**.

**Neden diğer katmanlar göremedi:** hiçbiri istemcinin **giden isteğinin
gövdesine** bakmıyor. Sözleşme doğrulaması MCP tarafına bakar, LLM tarafına
değil. Uçtan uca test sonucun geldiğini görür. Sahte Gemini sunucusu da isteği
memnuniyetle kabul eder — çünkü onun işi "çalışıyor mu" sorusunu cevaplamak.

Bu ayrımı görünür kılmak için sahte sunucudan **ayrı** bir araç yazıldı:
`wire-denetimi.mjs`. Sahte sunucu *"çalışıyor mu"*, sonda *"**doğru mu**
konuşuyor"* sorusunu cevaplar.

**Ders:** *"Çalışıyor"* ile *"doğru"* aynı şey değildir. Karşı taraf hoşgörülüyse
yanlışın maliyeti **ertelenir**, ortadan kalkmaz — sağlayıcı bir gün katılaşır ve
kimse o değişikliği senin lehçe hatanla ilişkilendirmez.

## Vaka C — Python ve C# iş kuralı hatasında `isError` bildirmiyordu

**Yakalayan katman:** protokol (uyum denetleyicisi, madde `T7`).
**Sessizce geçtiği katmanlar:** birim, sözleşme, uçtan uca, wire.

`minutes: 7` gönderildi. Hesabın `timeIncrement` değeri 30 olduğu için bu geçersiz
bir iş isteğidir ve **üç sunucu da bunu doğru tespit ediyordu** — `errors[]` üçünde
de doluydu:

```
ts  isError = true         errors[] = [{ "message": "Süre 7 dakika, ancak … timeIncrement 30 …" }]
py  isError = false     ✘  errors[] = [{ "message": "7 dakika, hesabin timeIncrement … kati degil …" }]
cs  isError = undefined ✘  errors[] = [{ "message": "Süre 7 dakika, ancak … timeIncrement 30 dakika …" }]
```

Sorun **tespitte değil, bildirimde**. MCP spec'inde `isError` alanı yoksa `false`
kabul edilir. Yani Python "başarılı" diyor, C# de "başarılı" diyordu — hâlbuki
ikisi de içeride hatayı bulmuştu.

**Neden ciddi:** bu sonucu okuyan taraf bir **LLM**'dir. `isError` false ise model
*"zaman girişi yazıldı"* der ve kullanıcıya öyle bildirir. Sessiz veri kaybı değil,
**sessiz yalan**. `errors[]` dizisini okuyacak kadar dikkatli olması modelin
insafına kalmıştır — ve protokolün varlık sebebi tam olarak bunu insafa
bırakmamaktır.

**Neden diğer katmanlar göremedi:** birim testleri `validate()`'in doğru hatayı
ürettiğini görüyordu — üretiyordu zaten. Sözleşme doğrulaması `errors[]` alanının
**var olduğunu** görüyordu — vardı. Sihirbaz `errors[]` doluysa adımı `FAIL`
sayıyordu, yani sihirbaz da **doğru** davranıyordu. Kimse `isError` bayrağının
kendisini sormamıştı.

**Düzeltme:** `errors.length > 0` ise `isError = true`. Tek satır, üç dilde de
**MCP adaptör katmanında**, iş mantığına dokunmadan.

**Ders:** aynı bilgiyi iki yoldan sunan bir arayüzde, **tüketicinin hangi yolu
okuduğu** bir uygulama detayı değil, sözleşmenin parçasıdır.

## Üçünün ortak dersi

| Vaka | Kusurun yeri | Yakalayan | Sihirbaz ne diyordu |
|---|---|---|---|
| A | İstemcinin **isteği** | protokol sondası | 17/17 geçti |
| B | İstemcinin **lehçesi** | wire denetimi | sohbet çalışıyor |
| C | Sunucunun **bildirimi** | uyum denetleyicisi | adım doğru FAIL'lendi |

Üçü de **uçtan uca yeşilken** vardı. Bir katmanın geçmesi, altındaki veya
üstündeki katmanın doğru olduğunu kanıtlamaz. Piramidin var oluş sebebi budur:
**her katman farklı bir hata sınıfı yakalar.**

---

# ★ Kırılgan test vakası — gecenin üç saatinde kırmızıya dönen test

Bu, kusurun **testin kendisinde** olduğu vaka. Anlatılmasının sebebi: bir katman
eklemek yetmez, o katmanın **kendisi güvenilir olmalıdır**.

## Belirti

`tools/fake-xurrent/senaryolar.mjs` içindeki `two_step` senaryosu **yalnızca
yerel saat 00:00 ile 03:00 arasında** kırmızıya dönüyordu. Gündüz 21 kontrolün
21'i geçiyordu. Sunucular bozuk görünüyordu; bozuk olan testti.

## Kök neden

Test, geriye dönük tarihi `toISOString()` ile türetiyordu:

```js
date: new Date(Date.now() - 864e5).toISOString().slice(0, 10)   // ✘ UTC tarihi
```

Üç sunucu ise "bugün"ü `XURRENT_TIMEZONE`'da (varsayılan `Europe/Istanbul`,
UTC+3) hesaplar ve `XURRENT_MAX_BACKDATE_DAYS=1` sınırını uygular.

**Yerel 00:00–03:00 arasında UTC tarihi bir gün geridedir.** Oradan bir gün daha
çıkarınca istenen T-1, sunucunun gözünde **T-2** olur ve yazma **haklı olarak**
reddedilir.

## Düzeltme

```js
const TZ = process.env.XURRENT_TIMEZONE || "Europe/Istanbul";

/** TZ'de gün farkıyla tarih, YYYY-MM-DD. gunFarki=0 bugün, -1 dün. */
function tarihTZ(gunFarki = 0) {
  const bugun = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  // Gün aritmetiğini UTC öğlen üzerinden yap: DST ve gün sınırı kaymalarından etkilenmez.
  const d = new Date(`${bugun}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + gunFarki);
  return d.toISOString().slice(0, 10);
}
```

İki ayrıntı önemli:

1. **Tarih, ölçülen tarafın saat diliminde sorulmalı.** Test ile sunucu farklı
   takvimlere bakıyorsa test bir *fark* değil, bir *yanlış anlama* ölçer.
2. **Gün aritmetiği UTC öğlen üzerinden yapılır.** Gün sınırında yapılan
   aritmetik DST geçişlerinde sessizce kayar; öğlen o kaymanın dışındadır.

## İkinci kusur: kanıt yalan söylüyordu

Aynı kontrolün başarısızlık detayı `isErr(r) ? text(r) : "errors=[]"` idi. Yani
`isError=false` ama `structuredContent.errors` **dolu** olduğunda ekrana
`errors=[]` basıyordu — **kırmızı bir kontrolün yanında yeşil görünen bir kanıt.**
Hatayı bulmak bu yüzden yarım saat aldı.

Artık `nedenBasarisiz()` gerçek sebebi yazıyor; başarılı hâlde de **kullanılan
tarihi ve saat dilimini** basıyor:

```
✔ b) yazma başarılı, errors boş    errors=[] · planned=2 · date=2026-08-02 (TZ Europe/Istanbul)
```

## Ders

- **Kırmızı test önce kendini suçlamalı.** Sunucular doğru davranıyordu; ölçen
  taraf yanlış tarihi soruyordu.
- **Testin kanıtı, testin sonucundan daha önemlidir.** Yanlış kanıt, hiç kanıt
  olmamasından kötüdür: yanlış yöne saatler harcatır.
- ★ **Testler gerçek zamana bağlı olmamalıdır.** "Şimdi" enjekte edilebilir
  olmalıdır. Bir test, günün saatine göre farklı sonuç veriyorsa, o test bir
  ölçüm aracı değil, bir **kumar**dır.

---

## İkinci kırılgan vaka — koşucunun kendisi: boru mu, dosya mı?

`test-all.mjs` yazılırken çıktı. Elde koşulduğunda çalışan, koşucudan
çağrıldığında **çalışmayan** bir komut:

```bash
node scripts/mcp-uyum.mjs --hepsi --json > rapor.json   # ✔ 130 KB, geçerli JSON
```

```
✘ mcp-uyum   84s  KALDI   JSON rapor okunamadı
```

Sebep, çıktının kendisinde değil, **nereye yazıldığındaydı.** Node'da
`process.stdout.write()` bir **boruya** yazarken asenkrondur; hemen ardından
gelen `process.exit()` yazımı **yarıda keser**. Repodaki `--json` üreten
script'lerin hepsi bu deseni kullanıyor:

```js
if (JSON_MODE) process.stdout.write(JSON.stringify(rapor, null, 2) + "\n");
process.exit(rapor.ok ? 0 : 1);
```

Dosyaya yazım POSIX'te senkron olduğu için kabuk yönlendirmesi (`> rapor.json`)
sorunsuz çalışır. Boru 64 KB'lık tamponu dolduğu anda kesilir — yani **rapor
büyüdükçe** ortaya çıkan bir kusur. `verify-contract` (~10 KB) geçiyordu,
`mcp-uyum` (~130 KB) geçmiyordu.

**Çözüm:** koşucu, JSON üreten alt süreçlerin `stdout`'unu boruya değil
**geçici bir dosyaya** yönlendirir ve süreç bittikten sonra o dosyayı okur —
kabuğun yaptığının aynısı.

### Ders

- Bir kusur **boyuta bağlı** olarak ortaya çıkıyorsa, küçük örnekle yapılan
  doğrulama onu **asla** görmez. `verify-contract` yıllarca yeşil kalabilirdi.
- **Aracını kendi aracınla çalıştır.** Bu kusur, komutlar elle koşulduğu sürece
  görünmezdi; ancak bir üst koşucu onları *program olarak* çağırınca ortaya çıktı.
- `stdout` bir sözleşmedir ve **hedefine göre davranışı değişir**. "Ekranda
  görünüyor" ile "boruya eksiksiz yazıldı" aynı iddia değildir.

---

## Bilinen ihlaller defteri

`scripts/bilinen-ihlaller.json` bir **mazeret listesi değil, borç defteridir**.
Buradaki bir madde `--bilinen-ihlaller` bayrağıyla `KALDI` yerine `ATLANDI`
sayılır — CI'yı kırmaz ama **görünür kalır**.

Üç kural dosyanın kendi başında yazılıdır ve kısaca şudur:

1. Bir madde eklemek için `nedenKapali` doldurulmalıdır: `ustAkim` (hata SDK'da,
   bizim kodumuzda değil) veya `tasarim` (bilinçli sapma, gerekçesi yazılı).
   *"Sonra bakarız"* geçerli bir neden değildir.
2. Listede olup **artık görülmeyen** madde, koşuda
   `★ ARTIK GÖRÜLMÜYOR (listeden çıkarın)` uyarısı üretir. Bu uyarıyı gören kaydı
   **siler**. Liste yalnızca küçülmelidir.
3. Listede **olmayan** bir MUST ihlali her zaman `KALDI`'dır. `--bilinen-ihlaller`
   bir sessizleştirme anahtarı değildir; yalnızca **zaten kayda geçmiş** olanı
   sessizleştirir.

**Defter bugün BOŞTUR** — ve boş kalması bir CI kuralıdır. Ama boşalma hikâyesi
kuralların neden böyle olduğunu anlatır:

Defter bir süre yalnız `ustAkim` maddeler taşıdı: TypeScript ve Python
SDK'larının stdio transport'u bozuk JSON satırını sessizce düşürüyordu (`J5`) ve
iki SDK şema doğrulama hatasını `-32602` yerine `-32603`'e sarmalıyordu (`J4`).
C# aynı testte `-32700` döndüğü için bunlar *"SDK'lar böyle yapar"* mazeretiyle
kapatılamazdı — **aynı spec, aynı sürüm, farklı sonuç.** Çözüm SDK'yı beklemek
olmadı: her iki dilde SDK'nın önüne ince birer nöbetçi katman yazıldı
(`parse-guard`, `params-guard`, `envelope-guard`) ve maddeler ölçümle kapandı;
koşucu `★ ARTIK GÖRÜLMÜYOR` uyarısı üretti, kayıtlar silindi.

### Defterde bilerek YER ALMAMIŞ bir ihlal

`M4` (C# / `2026-07-28`) uzun süre açık kaldı: sunucu, client `elicitation`
desteklemediğini bildirmesine rağmen `elicitation/create` istiyordu
([docs/12 § BULGU 4](12-mcp-uyum.md)). Deftere **alınmadı**, çünkü `nedenKapali`
için geçerli iki değerden (`ustAkim`, `tasarim`) hiçbirine uymuyordu: hata bizim
C# adaptör kodumuzdaydı ve **düzeltilebilirdi**.

Bir MUST ihlalini *"düzeltilebilir ama henüz düzeltmedik"* diye maskelemek
defteri bir **çöp kutusuna** çevirir. Bu yüzden `--bilinen-ihlaller` bayrağıyla
bile kırmızı kaldı — düzeltilene kadar:

```
✘ mcp-uyum   45s  KALDI   6 koşu · 240 madde geçti ·
                          LİSTEDE OLMAYAN 1 MUST ihlali: cs/2026-07-28/M4 ·
                          4 bilinen ihlal maskelendi        (tarihî çıktı)
```

Defterde olan sessizleşir, olmayan kırmızı kalır. **Fark, listeye girmek için
gerekçe yazmış olmaktır.** Bugünkü çıktı: `6 koşu · 252 madde geçti · MUST
ihlali yok` — ve defter boş.

`$cozulmusKayit` bölümü tarih düşürür: `T7` (Vaka C) düzeltildi ve 2026-08-03
ölçümünde altı koşunun **altısında da** geçti. **Defterin küçülmesi ölçülebilir
bir ilerleme göstergesidir.**

---

## CI

`.github/workflows/ci.yml` — her `push` ve her `pull_request`'te koşar.

| | |
|---|---|
| Koşucu | `ubuntu-latest` (macOS değil — geliştirme makinesinden farklı olması **kasıtlı**) |
| Node | 24 |
| Python | 3.13, `uv` ile |
| .NET | 10 |
| Zaman aşımı | 30 dakika |
| Komut | `node scripts/test-all.mjs --json` |

Üç bilinçli karar:

**`matrix` YOK.** Bu repoda "üç dil" bir matris ekseni değil, **tek bir
sözleşmenin üç implementasyonu**dur. `verify-contract` ve `mcp-uyum` üç sunucuyu
aynı anda ayağa kaldırıp **karşılaştırır**; üçünü ayrı job'lara bölmek bu
karşılaştırmayı imkânsız kılardı. Matrix burada paralellik değil, **körlük**
üretirdi.

**`TZ: Europe/Istanbul`.** CI'yı UTC'de koşturmak *"yerelde geçiyor, CI'da
kalıyor"* sınıfı bir farkı davet ederdi — yukarıdaki kırılgan test vakası tam
olarak bu ailedendir. Ders hangi dilimde anlatılıyorsa CI o dilimde koşar.

**`--bilinen-ihlaller` varsayılan DEĞİL.** Bilinen bir MUST ihlalini
sessizleştirmek bir **karar** olmalıdır, bir alışkanlık değil. Elle koşuda
(`workflow_dispatch`) açılabilir.

Ağ erişimi yalnızca **kurulum** adımlarında gerekir (`npm ci`, `uv sync`,
`dotnet restore`). Testlerin kendisi ağ istemez: `XURRENT_MODE=mock`,
`CALENDAR_PROVIDER=mock`, ve LLM çağrısı yapan tek adım yerel sahte Gemini'ye
konuşur.

---

## Kendi projende bu piramidi nasıl kurarsın

Bu repo bir öğretim materyali; asıl mesele piramidi **kendi projene** taşımak.
Sıra önemlidir — her adım bir öncekinin bıraktığı boşluğu kapatır.

### 1. Önce sözleşmeyi yaz, sonra testi

Bir arayüzün *"aynı"* olduğunu iddia ediyorsan, o iddianın **makine tarafından
okunabilir** bir kaynağı olmalı. Bu repoda `contract/tools.json`. Sende bir
OpenAPI dosyası, bir `.proto`, bir JSON Schema olabilir. Kural şu: **sözleşme
koddan türetilmez, kod sözleşmeden doğrulanır.** Türetirsen, kod kaydığında
sözleşme de kayar ve test hiçbir şey yakalamaz.

### 2. En ucuz katmanı en sık koş

| Katman | Tipik süre | Ne sıklıkta |
|---|---|---|
| birim | saniyeler | her kayıtta |
| sözleşme | ~10 sn | her commit |
| protokol / uçtan uca | dakikalar | her push |

`--hizli` bayrağının varlık sebebi budur: geliştirme döngüsünde yavaş katmanları
atlayıp saniyeler içinde geri bildirim almak.

### 3. Çekirdek mantığı I/O'dan ayır — testin ilk müşterisi mimaridir

`strategies`, `validate`, `calendar`, `matching`, `confirm` bu repoda **saf**
fonksiyonlardır: ağ yok, dosya yok, saat yok. Bu bir test kolaylığı değil, bir
**mimari sonuç**tur. Saf olmayan bir çekirdeği test etmek için mock yazarsın;
mock yazdığın an testin gerçekliğe olan bağı zayıflar.

**Pratik kural:** "şimdi" ve "rastgele" **parametre**dir, global değil.

```js
function planla(girdi, { simdi = () => new Date() } = {}) { … }   // ✔
function planla(girdi) { const t = new Date(); … }                // ✘ test kumar olur
```

### 4. Her dış sınır için bir "sahte karşı taraf" **ve** bir "denetçi" yaz

İkisi farklı araçtır ve bu ayrımı görmeyen projeler Vaka B'yi kaçırır:

| Araç | Sorusu | Bu repodaki örneği |
|---|---|---|
| Sahte sunucu | *Çalışıyor mu?* | `tools/fake-xurrent/server.mjs` · `tools/fake-gemini/server.mjs` |
| Denetçi | *Doğru mu konuşuyor?* | `tools/fake-gemini/wire-denetimi.mjs` |

Sahte sunucu hoşgörülüdür — amacı akışı yürütmektir. Denetçi katıdır — amacı
giden isteğin **her alanını** iddiaya sokmaktır.

### 5. Spec'e uyumu SDK ile ölçme

Kullandığın SDK ile yazılmış bir uyum testi, **SDK'nın kabul ettiği her şeyi
doğru sayar**. Spec ihlallerinin çoğu tam olarak SDK'nın hoş gördüğü yerlerdedir.
En az bir sonda **ham protokolü** konuşmalıdır.

### 6. Üç durumu ayır: geçti / kaldı / **atlandı**

İki durumlu bir koşucu, ön koşulu olmayan her şeyi başarısızlığa çevirir ve
insanlar **kırmızıya bakmayı bırakır**. Bu, bir test paketinin ölme biçimidir.
`ATLANDI` durumu koşuyu dürüst tutar: *"bunu ölçemedim"* ile *"bunu ölçtüm ve
tutmadı"* aynı şey değildir.

### 7. Kanıt yazdır, sonuç değil

`✔ geçti` bir sonraki kişiye hiçbir şey söylemez. `✔ 21 geçti · date=2026-08-02
(TZ Europe/Istanbul)` bir dahaki kırılmada **yarım saat kazandırır**. Her kontrol
kendi kanıtını basmalı ve o kanıt kontrol kırmızıyken de **doğru** olmalıdır —
kırılgan test vakasının ikinci dersi buydu.

### 8. İhlalleri gizleme, defterine yaz

Kapatamadığın bir uyumsuzluk varsa iki yanlış seçenek vardır: testi silmek veya
`skip` işaretleyip unutmak. Doğru olan üçüncüsüdür: **gerekçesiyle birlikte bir
dosyaya yaz**, koşuda görünür kalsın, ve o dosyanın **yalnızca küçülmesine** izin
ver.

---

## İlgili bölümler

| Bölüm | Bağlantı |
|---|---|
| MCP uyum checklist'i ve bulguların tam dökümü | [12 — MCP uyum](12-mcp-uyum.md) |
| Sihirbazın adım modeli ve `expect` blokları | [07 — Sihirbaz](07-sihirbaz.md) |
| Bu projenin nasıl üretildiği, kaçırılan kusurlar dahil | [10 — Sıfırdan geliştirme](10-sifirdan-gelistirme.md) |
| Bilinen tuzaklar ve `DOĞRULANMALI` listesi | [08 — Riskler ve SSS](08-riskler-ve-sss.md) |
| Script'lerin tek tek kullanımı | [`scripts/README.md`](../scripts/README.md) |
