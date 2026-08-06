# 07 — Sihirbaz

> **Bölüm hedefi:** Dersi yürüten aracı anlamak — sihirbaz nedir, `steps.json` nasıl
> okunur, yeni adım nasıl eklenir ve sunumda nasıl kullanılır.

| ← Önceki | Sonraki → |
|---|---|
| [06 — Üç dil karşılaştırma](06-uc-dil-karsilastirma.md) | [08 — Riskler ve SSS](08-riskler-ve-sss.md) |

---

## Sihirbaz nedir?

**Bir MCP client.** Chatbot değil, demo script'i değil — protokolün istemci tarafı.

```bash
node clients/wizard/wizard.mjs --server ts
```

Yaptığı şey: bir MCP sunucusu başlatır, `tools/list` çağırır, sonra
[`docs/wizard/steps.json`](wizard/steps.json) içindeki 16 adımı sırayla yürütür. Her
adımda **önce anlatır, sonra gerçek bir tool çağrısı yapar, sonra çıktıyı yorumlar.**

Üç özellik onu ders için ideal kılıyor:

| Özellik | Neden önemli |
|---|---|
| **API key gerekmez** | LLM yok. Tool'ları doğrudan çağırır. Sunumda tek arıza noktası daha az. |
| **Hiçbir çıktı önceden yazılmamış** | Ekrandaki her sayı canlı üretilir. Slayt değil, çalışan sistem. |
| **`--server` ile sunucu değişir** | Aynı ders, üç dil. Dersin tezinin kanıtı. |

```
clients/wizard/wizard.mjs        ← MCP client (Node, @modelcontextprotocol/sdk ^1.12.0)
        │
        ├── stdio ──▶ servers/typescript   (--server ts)
        ├── stdio ──▶ servers/python       (--server py)
        └── stdio ──▶ servers/csharp       (--server cs)
                          │
                          └── aynı contract/tools.json, aynı fixtures/
```

---

## Nasıl çalışır?

Bir adımın yaşam döngüsü:

```
1. narrate[]        → anlatım metinlerini sırayla yazdır, Enter bekle
2. callTool         → GERÇEK MCP tool çağrısı (veya listTools / callToolSequence)
3. expect[]         → structuredContent'i beklenen değerlere karşı doğrula
4. reveal[]         → çıktıyı yorumla, tuzağı açıkla
5. quiz             → (varsa) çoktan seçmeli soru + açıklama
6. docs             → ilgili anlatım notuna işaret et
```

**`expect` bloğu bir testtir.** Sihirbaz beklenen değeri görmezse durur ve farkı
gösterir. Yani sihirbaz aynı zamanda üç sunucunun **smoke test'idir**: ders akıp
bitiyorsa implementasyon sözleşmeye uyuyor demektir.

---

## `steps.json` şeması

Dosya: [`docs/wizard/steps.json`](wizard/steps.json). Üç dil de **aynı dosyayı**
yürütür.

### Kök alanlar

| Alan | Tip | Anlamı |
|---|---|---|
| `$schema` | string | `./steps.schema.json` — editör tamamlaması için |
| `version` | string | Şema sürümü (`"1.0.0"`) |
| `title` / `subtitle` | string | Açılış ekranı |
| `estimatedMinutes` | number | Tam ders süresi (45) |
| `_howItWorks` | string | Belge içi not; sihirbaz göstermez |
| `chapters` | array | `{ id, title }` — adımlar buraya bağlanır |
| `steps` | array | Ders akışı, sırayla |
| `placeholders` | object | Yer tutucu sözlüğü (aşağıda) |

### Adım alanları

| Alan | Tip | Anlamı |
|---|---|---|
| `id` | string | `"04-acik-isler"` — sıralı ve okunur |
| `chapter` | string | `chapters[].id` referansı |
| `title` | string | Ekrandaki başlık |
| `narrate` | string[] | Sırayla gösterilen anlatım paragrafları |
| `callTool` | object \| null | `{ name, args }` — tek tool çağrısı. `null` = çağrı yok |
| `callToolSequence` | array | `[{ label, name, args }]` — ardışık çağrılar (strateji karşılaştırması) |
| `listTools` | boolean | `true` ise `tools/list` çağırılır ve envanter gösterilir |
| `table` | object | `{ headers, rows }` — tool çağırmadan bilgi tablosu |
| `expect` | array | Doğrulamalar (aşağıda) |
| `reveal` | string[] | Çıktı gösterildikten **sonra** okunacak yorumlar |
| `quiz` | object | `{ question, options[], answer (index), explain }` |
| `confirmable` | boolean | `true` ise gerçek yazma; kullanıcıdan onay ister |
| `prompt` | string | Kullanıcıya sorulan serbest soru (cevap kaydedilmez) |
| `docs` | string | İlgili anlatım notu, ör. `"docs/02-...#iki-yol"` |

### `expect` doğrulamaları

İki biçim:

```jsonc
// 1) structuredContent içindeki bir yolu kontrol et
{ "path": "requests.totalCount", "equals": 3,
  "explain": "3 açık Request. 4. kayıt (70120) 'completed' olduğu için elendi." }

{ "path": "person.name", "exists": true,
  "explain": "Authenticated user çözüldü." }

// 2) tools/list üzerinde özel kontrol
{ "check": "toolCount", "equals": 8,
  "explain": "Sözleşmede 8 tool var: 4 okuma, 2 yazma, 1 takvim, 1 önizleme." }
```

**`path` her zaman `structuredContent`'e görelidir**, `content[].text`'e değil. Metin
özeti iyileştirilebilir; **sözleşme yapıdadır** ([03](03-mcp-tasarimi.md)).

`.length` sonekiyle dizi uzunluğu kontrol edilir: `"effortClasses.length"`,
`"planned.length"`, `"proposals.length"`.

### Yer tutucular

`.ics` gibi, `steps.json` de **mutlak tarih taşımaz** — demo hangi gün çalıştırılırsa
çalışsın "dün" hep dün olsun diye:

| Yer tutucu | Değer |
|---|---|
| `{{today}}` | Bugünün tarihi, `YYYY-MM-DD` |
| `{{yesterday}}` | Dünün tarihi, `YYYY-MM-DD` |
| `{{tzOffset}}` | Yapılandırılmış saat diliminin o günkü UTC offset'i, ör. `+03:00` |

Kullanımı:

```json
"args": {
  "date": "{{yesterday}}",
  "startedAt": "{{yesterday}}T14:00:00{{tzOffset}}"
}
```

Sihirbaz argümanları göndermeden **hemen önce** yer değiştirir. Aynı sözleşme
[`fixtures/README.md`](../fixtures/README.md)'deki `dayOffset` mekanizmasıyla
uyumludur — ikisi de aynı "bugün"e göre hesaplanır.

> **DST notu:** `{{tzOffset}}` sabit değil, **o günün** offset'idir. Europe/Istanbul
> için bugün `+03:00`; DST uygulayan bir dilimde tarih değişince offset de değişir.
> Sabit bir string yazmak, yılda iki kez bir saatlik kayma üretirdi.

---

## Ders akışı: 16 adım, 8 bölüm

| Bölüm | Adım | Konu | Tool |
|---|---|---|---|
| **Giriş** | 01 | Neden MCP? | — |
| | 02 | İlk el sıkışma: `tools/list` | `listTools` |
| **Okuma** | 03 | Bağlantı smoke test'i | `xurrent_whoami` |
| | 04 | **İSTER #1** — açık işler | `xurrent_list_open_work` |
| **Kısıt** | 05 | `timeIncrement`'i bilmeden yazamazsın | `xurrent_get_time_tracking_context` |
| | 06 | **★ Dersin kalbi** — iki mutation, farklı yetenekler | `table` (çağrı yok) |
| **Yazma** | 07 | Önce plan: dry-run | `xurrent_create_time_entry` (dryRun) |
| | 08 | Üç strateji yan yana | `callToolSequence` ×3 |
| **Takvim** | 09 | **İSTER #4** — takvimi oku | `calendar_list_today` |
| | 10 | Toplantıları öneriye çevir | `plan_time_entries_from_calendar` |
| **Yazma** | 11 | Gerçekten yaz — onayla | `xurrent_create_time_entry` (`confirmable`) |
| **Protokol** | 12 | **★ Spec iş ortasında değişti** | `callTool` + `table` |
| | 13 | Aynı iş mantığı, iki protokol kabuğu | `compareProtocols` (`xurrent_create_time_entry`) |
| **Sohbet** | 14 | Yazılanı geri oku — kesin mesajlaşmanın gözü | `xurrent_list_time_entries` |
| | 15 | LLM'siz chatbot: üç turluk diyalog | `timesheet_wizard` (`callToolSequence` + `{{prev.sessionState}}`) |
| **Kapanış** | 16 | Sunucuyu değiştir | `xurrent_whoami` |

Akış kasıtlı: **okuma → kısıtı keşfet → planla → yaz.** Öğrenci "önce keşfet, sonra
yaz" ilkesini anlatılarak değil, **yaşayarak** öğrenir.

Adım 06 hiç tool çağırmaz — sadece bir `table` gösterir. Dersin en önemli fikri
(iki yol, ikisi de yetersiz) bir API çağrısıyla gösterilemez; **gösterilmeyeni
anlatmak** gerekir.

---

## Yeni adım nasıl eklenir?

Beş adımda. Örnek: kişi arama tool'unu derse eklemek.

**1 — Bölümü seç veya ekle.**

```json
"chapters": [
  { "id": "okuma", "title": "Okuma tool'ları: veriyi görmek" }
]
```

**2 — Adımı `steps` dizisine, doğru sıraya ekle.**

```json
{
  "id": "03b-kisi-bul",
  "chapter": "okuma",
  "title": "Başkası adına yazmak: kişiyi bul",
  "narrate": [
    "Şimdiye kadar hep kendi adımıza çalıştık. Peki bir yönetici, ekibindeki birinin zamanını girmek isterse?",
    "Önce kişiyi çözmemiz gerekiyor. Xurrent'ta PersonFilter.primaryEmail bir TextFilter'dır ve TAM eşleşme yapar."
  ],
  "callTool": {
    "name": "xurrent_find_person",
    "args": { "email": "burak.sahin@ornek.com" }
  },
  "expect": [
    { "path": "totalCount", "equals": 1,
      "explain": "Tam eşleşme bulundu — tek kayıt." }
  ],
  "reveal": [
    "TAM eşleşme: 'burak' yazarak bu kaydı BULAMAZDIN. Substring araması yok.",
    "Bulunamasaydı suggestFuzzy=true dönerdi ve chatbot serbest metin aramayı önerebilirdi.",
    "Dönen id'yi not et: xurrent_create_time_entry'de personId olarak KULLANILABİLİR — ama yetki gerekir."
  ],
  "quiz": {
    "question": "'ayse' yazarak arama yapsaydık ne olurdu?",
    "options": [
      "ayse.demir@ornek.com bulunurdu",
      "Boş sonuç dönerdi",
      "Hata alırdık"
    ],
    "answer": 1,
    "explain": "primaryEmail bir TextFilter'dır ve TAM eşleşme yapar. Substring aramaz — boş sonuç döner, hata vermez."
  },
  "docs": "docs/01-xurrent-api.md#kimlik"
}
```

**3 — Fixture'ı kontrol et.** Kullandığın e-posta
[`fixtures/people.json`](../fixtures/people.json)'da var mı? `expect` değerlerin
fixture'la tutuyor mu?

**4 — Üç sunucuda da çalıştır.**

```bash
node clients/wizard/wizard.mjs --server ts --json | tail -5
node clients/wizard/wizard.mjs --server py --json | tail -5
node clients/wizard/wizard.mjs --server cs --json | tail -5
```

Bir dilde `expect` patlıyorsa **o dilde bir sözleşme sapması var demektir.** Sihirbaz
bunu bulmuş olur.

**5 — `docs` alanını gerçek bir başlığa bağla.** Bu belgelerdeki tüm çapalar
(`#kimlik`, `#iki-yol`, `#stratejiler`, `#timeincrement`, `#dry-run`, `#onay`,
`#eslestirme`) açıkça tanımlıdır — kırık link bırakma.

### Yeni adım eklerken üç kural

| Kural | Neden |
|---|---|
| **Her adım bir tuzak öğretsin** | "Ve şimdi de şu tool var" değersizdir. `reveal` boşsa adım gereksizdir. |
| **`expect` mutlaka olsun** | Doğrulaması olmayan adım ders değil, gösteridir. Ve sözleşme testi zayıflar. |
| **Mutlak tarih yazma** | Yer tutucuları kullan. Yarın çalışmayan bir ders yazma. |

---

## Çalıştırma bayrakları

| Bayrak | Davranış | Kullanım |
|---|---|---|
| `--server ts\|py\|cs` | Hangi sunucuya bağlanılacağı (varsayılan `ts`) | Her zaman |
| *(mod bayrağı yok)* | İnteraktif: her adımda Enter bekler, quiz sorar | **Ders anlatımı** |
| `--auto` | Enter beklemez, quiz'leri atlar, baştan sona akar | **Prova / kayıt** |
| `--json` | Anlatımı bastırır; her adım için tek satır JSON basar | **CI / doğrulama** |
| `--step <id>` | Yalnızca o adımı çalıştırır (`--step 06`) | **Hızlı demo / hata ayıklama** |

`--step` kısmi id kabul eder: `--step 06` → `06-iki-yol`. Tek bir fikri göstermek
için ideal ([demo/senaryo.md](demo/senaryo.md) → A bölümü tam olarak bunu kullanır).

`--auto` iki yerde işe yarar:

- **Sunum provası** — 45 dakikalık dersin ne kadar sürdüğünü ölçmek.
- **Ekran kaydı** — beklemesiz akış temiz bir video verir.

`--json` çıktısı satır-JSON (JSONL):

```jsonc
{"step":"04-acik-isler","tool":"xurrent_list_open_work","ok":true,"expects":2,"failed":0,"ms":12}
{"step":"05-zaman-baglami","tool":"xurrent_get_time_tracking_context","ok":true,"expects":2,"failed":0,"ms":8}
```

Boru hattında kullanımı:

```bash
# Herhangi bir adım başarısızsa çıkış kodu != 0
node clients/wizard/wizard.mjs --server py --auto --json > /tmp/py.jsonl || echo "PY BAŞARISIZ"

# Üç dilin çıktısı aynı mı? (ms alanı hariç)
for s in ts py cs; do
  node clients/wizard/wizard.mjs --server $s --auto --json \
    | sed 's/,"ms":[0-9]*//' > /tmp/$s.jsonl
done
diff /tmp/ts.jsonl /tmp/py.jsonl && diff /tmp/ts.jsonl /tmp/cs.jsonl && echo "ÜÇÜ AYNI"
```

Son komut dersin tezini **tek satırda** kanıtlar.

`--auto` ve `--json` birleştirilebilir. `--auto` olmadan `--json` interaktif kalır
(Enter bekler) — otomasyon için ikisini birlikte kullan.

---

## Derste nasıl kullanılır?

### Hazırlık (dersten önce)

```bash
cp .env.example .env                  # mock mod varsayılan; düzenleme gerekmez
cd servers/typescript && npm install && npm run build && cd ../..
node scripts/gen-ics.mjs              # .ics fixture'ını bugüne göre üret
node clients/wizard/wizard.mjs --server ts --auto   # prova, süreyi ölç
```

`gen-ics` adımı yalnızca `ics` sağlayıcısını göstereceksen gerekli. `mock` her zaman
doğru tarihlerle çalışır.

### Anlatım sırasında

| Yapılacak | Neden |
|---|---|
| Terminali **büyük fontla** aç | Arka sıra `planned[].mutation` metnini okuyabilmeli |
| Adım 06'da **dur** | Dersin kalbi. Tabloyu tartış, aceleye getirme. |
| Adım 08'de üç çıktıyı **yan yana göster** | Takas fikrinin en net anı |
| Quiz'leri **sesli sor** | Öğrenciler cevaplasın, sonra `explain`'i oku |
| Adım 12'de **sunucuyu değiştir** | Kapanış ancak canlı yapılırsa etki eder |

### Kapanış

```bash
node clients/wizard/wizard.mjs --server py
```

İlk üç adımı göster ve durdur. Aynı çıktılar. Söylenecek cümle:

> *"Tek bir adım değişmedi. Çünkü sözleşme `contract/tools.json`'da, veri
> `fixtures/`'ta, ders `steps.json`'da. Üç sunucu da sadece birer implementasyon."*

---

## Sihirbaz vs chatbot vs Claude Code

Üçü de aynı sunucuya bağlanır. Farkları:

| | **Sihirbaz** | **Chatbot** | **Claude Code** |
|---|---|---|---|
| LLM | ❌ yok | ✅ `ANTHROPIC_API_KEY` | ✅ host sağlar |
| Akış | Sabit (`steps.json`) | Serbest diyalog | Serbest diyalog |
| Çıktı | Doğrulanır (`expect`) | Doğrulanmaz | Doğrulanmaz |
| İnternet | ❌ gerekmez (mock) | ✅ gerekir | ✅ gerekir |
| Amaç | **Öğretmek + doğrulamak** | Ürünü göstermek | Entegrasyonu göstermek |
| Sunum riski | En düşük | Orta (API/quota) | Orta (onay akışı) |

**Sunum sırası önerisi:** sihirbaz → Claude Code → chatbot. Önce garantili olan,
sonra etkileyici olan. Ayrıntı: [demo/senaryo.md](demo/senaryo.md).

---

## Özet

| Konu | Sonuç |
|---|---|
| Sihirbaz nedir | Bir **MCP client**; LLM kullanmaz |
| Ders kaynağı | [`docs/wizard/steps.json`](wizard/steps.json) — üç dil aynı dosyayı yürütür |
| `expect` | Adım doğrulaması **ve** sözleşme smoke test'i |
| `path` | Her zaman `structuredContent`'e görelidir |
| Tarihler | Yer tutucu: `{{today}}`, `{{yesterday}}`, `{{tzOffset}}` |
| Yeni adım | Bir tuzak öğretsin, `expect` taşısın, mutlak tarih yazmasın |
| `--auto` | Beklemesiz akış — prova ve kayıt |
| `--json` | JSONL çıktı — CI ve üç dil karşılaştırması |
| Sunum rolü | En düşük riskli demo; ilk o gösterilir |

Sıradaki bölüm işlerin ters gitme ihtimallerini ele alıyor:
[08 — Riskler ve SSS](08-riskler-ve-sss.md).
