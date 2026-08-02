# Atölye koşucusu

> **Sihirbaz** uygulamanın **ne yaptığını** öğretir.
> **Atölye** uygulamanın **nasıl üretildiğini** öğretir.

| | Sihirbaz | Atölye |
|---|---|---|
| Kod | [`clients/wizard/wizard.mjs`](../wizard/wizard.mjs) | [`atolye.mjs`](atolye.mjs) |
| Ders içeriği | [`docs/wizard/steps.json`](../../docs/wizard/steps.json) | [`docs/atolye/adimlar.json`](../../docs/atolye/adimlar.json) |
| Sözleşme | `docs/wizard/steps.schema.json` | [`docs/atolye/adimlar.schema.json`](../../docs/atolye/adimlar.schema.json) |
| Ne yapar | Üç MCP sunucusundan birine bağlanır, tool'ları **canlı** çağırır | Projenin üretim sırasını anlatır, `--insa` ile o sırayı **gerçekten kurar** |
| Bağımlılık | `@modelcontextprotocol/sdk` | **yok** |

İkisi de aynı sonuç modelini kullanır: `PASS` · `FAIL` · `SKIP`, özet
*"N geçti, M başarısız, K atlandı"*, çıkış kodunu **yalnızca FAIL** etkiler.

```bash
node clients/atolye/atolye.mjs --help
```

---

## Neden bu şekilde tasarlandı

### Dosya içerikleri veri dosyasında **tutulmaz**

`adimlar.json` yalnızca repo köküne göreli **yol** listeler (`uretilenDosyalar[]`);
atölye o dosyaları **repodan** okur.

İçerik kılavuza kopyalansaydı, kod her değiştiğinde kılavuz **sessizce** bayatlar ve
öğrenciye artık var olmayan bir kod öğretilirdi. Bu yüzden *"kılavuzun gösterdiği
dosya repoda yok"* durumu bir uyarı değil, **FAIL**'dir — ve `--insa` verilmemiş
olsa bile kontrol edilir.

### `--auto` "onayı varsay" demek değildir

`--insa` hedef dizini boş değilse atölye onay ister. Etkileşimsiz modda
(`--auto` veya TTY yok) **reddeder ve çıkış kodu 2 döner**; `--uzerine-yaz`
verilmedikçe tek bir dosyaya dokunmaz. Yıkıcı bir işlemi sessizce yapmak,
CI'da fark edilmeyen veri kaybı üretir.

### Prompt blokları sarılmaz

Prompt, öğrencinin **kopyalayacağı** metindir. Sarma veya girinti eklemek,
kopyalanan metni AI'a gerçekten verilenden farklı yapar. Bu yüzden çerçeve
yalnızca üst/alt çizgidir; sol sütunda gutter yoktur.

### Seçilmeyen şıklar da gösterilir

`karar` bloğunda alınmayan seçenekler artıları ve eksileriyle birlikte basılır.
Mühendislik "doğru cevap" değil, **takas** demektir; yalnızca kazanan şıkkı
göstermek dersi yalanlar.

---

## Modlar

### Anlat (varsayılan)

```bash
node clients/atolye/atolye.mjs
```

Adım adım ilerler: anlatım → prompt → karar → üretilen dosyalar → doğrulama →
ne öğrendik → tuzak. Her adımda Enter bekler. **Hiçbir dosya yazılmaz.**

### `--insa <dizin>` — gerçekten inşa eder

```bash
node clients/atolye/atolye.mjs --insa /tmp/atolye-demo
```

Her adımda:

1. `uretilenDosyalar[]` **repodan** okunur (glob destekli: `fixtures/*.json`,
   `servers/*/src/**/*.ts`),
2. hedef dizine aynı göreli yolla kopyalanır,
3. `dogrulama.komut` **hedef dizinde** çalıştırılır ve **gerçek çıktısı** basılır.

Öğrenci sonunda çalışan bir kopyaya sahip olur **ve sırayı öğrenir**.

> **Çalışma dizini:** doğrulama komutu **hedef dizinde** çalışır — doğrulamak
> istediğimiz şey kaynak değil, **inşa edilen kopyadır**. Kullanılan dizin her
> koşuda ekrana basılır.
>
> Repo kökündeki bir dosyaya ihtiyaç duyan komutlar için `ATOLYE_KOK` ortam
> değişkeni her zaman set edilir:
> `node $ATOLYE_KOK/scripts/verify-contract.mjs --all`

### Diğer seçenekler

| Seçenek | Ne yapar |
|---|---|
| `--auto` | Beklemeden geçer (CI) |
| `--json` | STDOUT'a makine-okunur özet; anlatım stderr'e gider |
| `--adim <id>` | Tek adım. **Kısmi eşleşme**: `--adim 05` → `05-...` |
| `--from <id>` | O adımdan itibaren sona kadar |
| `--live` | Adımın promptunu **gerçekten** Claude'a gönderir |
| `--veri <yol>` | Alternatif adım dosyası |
| `--liste` | Adımları listeler ve çıkar |
| `--dogrula` | Veri dosyasını şemaya karşı doğrular ve çıkar |
| `--uzerine-yaz` | Dolu hedef dizini onay sormadan kabul eder |

`--adim` / `--from` id eşleşmesi üç kademelidir — **birebir → önek → içerik** —
ve ilk dolu kademe kazanır. Sebep pratiktir: sunumda kimse `05-fixture` yazmaz,
`05` yazar.

---

## `--live` — promptu gerçekten gönder

`ANTHROPIC_API_KEY` varsa adımın promptu `POST /v1/messages` ile gönderilir
(`anthropic-version: 2023-06-01`, model `claude-opus-5`) ve üretilen çıktı,
`uretilenDosyalar[0]` ile **yan yana** gösterilir; farklı satırların ayracı
kalınlaşır.

Anahtar yoksa net bir Türkçe mesajla **SKIP** edilir — hata değildir.

Uç nokta `ANTHROPIC_BASE_URL` ile değiştirilebilir. Bu, `XURRENT_GRAPHQL_URL`
ile aynı desendir ve aynı sebeple vardır: **yapılandırılabilir bir uç, tek satır
kod değiştirmeden test edilebilir bir kod yolu demektir**
(bkz. [`tools/fake-xurrent`](../../tools/fake-xurrent/README.md)).

---

## Sonuç modeli

| Durum | Anlamı |
|---|---|
| `PASS` | Kontrol çalıştı ve tuttu |
| `FAIL` | Kontrol çalıştı ve **tutmadı** — gerçek bir uyumsuzluk |
| `SKIP` | Kontrol **çalıştırılamadı** (ön koşul yok) — başarısızlık **değildir** |

Çalışan kontroller:

| Kontrol | Ne zaman çalışır |
|---|---|
| `dosyalar` | Her modda — `uretilenDosyalar[]` repoda gerçekten var mı? |
| `kopyalama` | Yalnızca `--insa` |
| `dogrulama` | Yalnızca `--insa` |
| `canli` | Yalnızca `--live` |

**Doğrulamanın sert kapısı çıkış kodudur.** `beklenen` alanı şemaya göre
"çıktıda aranan metin **veya** insan-okunur beklenti" olabilir; birebir
bulunamaması tek başına FAIL saymaz — ama sessizce de geçilmez, ekrana sarı bir
uyarı basılır ve JSON raporda `beklenenEslesti: false` görünür.

### Çıkış kodları

| Kod | Anlamı |
|---|---|
| `0` | Hiç FAIL yok (SKIP'ler etkilemez) |
| `1` | En az bir kontrol başarısız |
| `2` | Hatalı parametre, eksik/bozuk veri dosyası veya reddedilen hedef dizin |

---

## Veri dosyası yoksa ya da bozuksa

Atölye **çökmez**, net bir Türkçe mesajla çıkar:

- **dosya yok** → aranan yol + `--veri` ipucu, çıkış 2
- **geçersiz JSON** → satır/sütun ve o satırın kendisi işaretlenerek, çıkış 2
- **şemaya uymuyor** → ihlallerin listesi (`adimlar[0].ogrenim: zorunlu alan eksik`), çıkış 2

Şema ihlali bilinçli olarak **ölümcüldür**: tanınmayan bir alanı sessizce yok
saymak, derste hiç çalışmayan bir bölüm demektir.

`$schema` anahtarı doğrulamadan önce ayıklanır — o bir **meta** anahtardır, veri
değildir (şemanın kökünde `additionalProperties: false` olduğu için tek başına
tüm dosyayı reddettirirdi).

Şema doğrulaması [`scripts/lib/mini-jsonschema.mjs`](../../scripts/lib/mini-jsonschema.mjs)
ile yapılır — bağımlılıksız, repo içi. Dosya bulunamazsa atölye yapısal
doğrulamayı atlar ve **bunu söyler**.

---

## Güvenlik

`adimlar.json` bir **girdidir**, güvenilen bir kaynak değil:

- `uretilenDosyalar[]` repo kökünün dışına çıkamaz (`../../etc/hosts` reddedilir),
- kopyalama hedefi, hedef dizinin dışına çıkamaz,
- glob gezinirken `node_modules`, `.git`, `dist`, `bin`, `obj`, `.venv` ve
  benzeri build/bağımlılık dizinlerine girilmez.

---

## CI

```bash
node clients/atolye/atolye.mjs --dogrula                  # şema + bütünlük
node clients/atolye/atolye.mjs --auto --json > rapor.json # bayatlama kontrolü
```

İkincisi `--insa` olmadan da anlamlıdır: `dosyalar` kontrolleri gerçekten
çalışır, yani **kılavuzun gösterdiği her dosyanın repoda durduğu** her koşuda
doğrulanır.
