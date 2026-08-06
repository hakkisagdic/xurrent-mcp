# Demo senaryosu — sunum script'i

> **Bölüm hedefi:** Sunumu adım adım yürütmek. Her adımda **kopyala-yapıştır komut**,
> **beklenen çıktı**, **söylenecek cümle** ve **süre tahmini** var.

| ← Önceki | Ana sayfa |
|---|---|
| [09 — Protokol geçişi](../09-protokol-gecisi.md) | [00 — Genel bakış](../00-genel-bakis.md) |

Üç bölüm:

| Bölüm | Süre | Ne zaman |
|---|---|---|
| **[A) Hızlı demo](#a)** | 10 dk | Meetup, sprint demo, yönetici sunumu |
| **[B) Tam ders](#b)** | 45 dk | Asıl senaryo — AI destekli geliştirme dersi |
| **[C) Yedek plan](#c)** | 10–45 dk | İnternet yok / API key düştü |

---

## Sunumdan önce (T-30 dakika)

Bu blok **sunum salonunda**, izleyici gelmeden çalıştırılır.

```bash
cd ~/Projects/xurrent-mcp

# 1) Yapılandırma — mock varsayılan, düzenleme gerekmez
cp -n .env.example .env

# 2) Fixture'ları temizle (önceki provalardan kalıntı olmasın)
git checkout fixtures/time-entries.json

# 3) Üç sunucuyu da derle / hazırla
cd servers/typescript && npm install && npm run build && cd ../..
cd servers/python     && uv sync                       && cd ../..
cd servers/csharp     && dotnet build                  && cd ../..

# 4) Sihirbaz istemcisi
cd clients/wizard && npm install && cd ../..

# 5) .ics fixture'ını BUGÜNE göre üret (ics sağlayıcısını göstereceksen)
node scripts/gen-ics.mjs

# 6) Sözleşme uyumunu doğrula — 3 sunucu da geçmeli
node scripts/verify-contract.mjs --all

# 7) Prova: baştan sona, beklemesiz
node clients/wizard/wizard.mjs --server ts --auto
```

### Kontrol listesi

| ✓ | Kontrol |
|---|---|
| ☐ | `verify-contract --all` **geçti** |
| ☐ | Sihirbaz `--auto` provası hatasız bitti |
| ☐ | `XURRENT_MOCK_PERSIST` **ayarlı değil** (fixture'lar sabit kalsın) |
| ☐ | Terminal fontu **büyük** (arka sıra GraphQL metnini okuyabilmeli) |
| ☐ | 8787 ve 8788 portları boş |
| ☐ | Uyku / bildirim / ekran koruyucu kapalı |
| ☐ | `ANTHROPIC_API_KEY` çalışıyor *(B bölümü için — yoksa C planı)* |
| ☐ | Claude Code açılıyor ve `.mcp.json` okunuyor *(B bölümü için)* |

---

<a id="a"></a>

# A) 10 dakikalık hızlı demo

**Hedef:** Tek bir fikir. *"API'nin gerçekte ne yapabildiğini keşfetmek, kod
yazmaktan önce gelir."*

Sihirbazı **kullanmadan**, elle üç komut. Anlatım tempolu.

### A1 — Problem (1 dk, komut yok)

> *"Dört cümlelik bir ister listem var: kişinin açık taleplerini listele, süre al,
> Xurrent'a yaz, takvimi okuyup toplantıları zaman girişine çevir.*
> *Dört cümle. Hepsi masumca duruyor. Bir tanesi API seviyesinde imkânsız — ve
> hangisi olduğunu ancak keşfederek buluyorsunuz."*

### A2 — Sekiz tool (2 dk)

```bash
npx @modelcontextprotocol/inspector \
  node servers/typescript/dist/mcp/stdio.js
```

**Beklenen:** Tarayıcı açılır, `tools/list` **10 tool** gösterir.

> *"Bu bir MCP sunucusu. Sekiz yetenek bildiriyor: dört okuma, iki yazma, bir takvim,
> bir önizleme. Şu ikisine dikkat: `xurrent_create_time_entry` `readOnlyHint: false`
> — Claude Code bunun için izin sorar. `plan_time_entries_from_calendar` ise
> `readOnlyHint: true`; yapısal olarak yazamayan bir tool."*

Inspector'da `xurrent_list_open_work`'ü elle çağır → `totalCount: 3` / `3`.

> *"Canlı çıktı. Fixture'da dört Request var; biri `completed`, elendi. Dört Task var;
> biri `approved` — ve `approved` da kapalı bir durum. Task'ta beş terminal durum var,
> Request'te bir. Bu asimetriyi bilmeyen bir filtre kapalı işleri açık sanar."*

### A3 — ★ Kısıt (4 dk)

```bash
node clients/wizard/wizard.mjs --server ts --step 06
```

*(Yalnızca 06. adımı çalıştırır — "iki mutation, farklı yetenekler" tablosu.)*

> *"İsterimiz şunu söylüyordu: ticket'a bağlı + başlangıç saatli + dünkü tarihli bir
> zaman girişi.*
>
> *`TimeEntryCreateInput`'un 17 alanı var. `requestId` yok. `taskId` yok.
> `assignmentId` yok. Yani `timeEntryCreate` bir ticket'a **bağlanamaz**.*
>
> *Ticket'a bağlamanın tek yolu `requestUpdate`'e `timeSpent` göndermek. Ama o yolda
> tarihi sunucu 'bugün' yapıyor, kişiyi authenticated user yapıyor.*
>
> *İki yol var, ikisi de tek başına isteri karşılamıyor. Bu bulguyu kod yazmadan
> ÖNCE bulduk. Bulmasaydık iki gün sonra baştan yazardık."*

Ardından çözümü göster:

```bash
node clients/wizard/wizard.mjs --server ts --step 07 --auto
```

**Beklenen:** `planned.length = 2` → `1/2 requestUpdate`, `2/2 timeEntryUpdate`.

> *"Çözüm `TimeEntryUpdateInput`'ta saklı: orada da `assignment` alanı **yok**.
> Bir alan input şemasında yoksa güncellenemez — dolayısıyla mevcut değeri korunur.
> Ticket bağını bozacak bir alan olmadığı için, tarihi güncellemek bağı bozamıyor.*
> *Kısıtın kendisi bize garantiyi veriyor."*

### A4 — Protokol vaadi (2 dk)

```bash
node clients/wizard/wizard.mjs --server py --step 04 --auto
```

**Beklenen:** Adım 04'ün **aynı** çıktısı — `totalCount: 3` / `3`.

> *"Az önceki TypeScript'ti. Bu Python. Aynı tool, aynı sayı, aynı ders.*
> *Çünkü sözleşme `contract/tools.json`'da, veri `fixtures/`'ta. Sunucular sadece
> birer implementasyon."*

### A5 — Kapanış (1 dk, komut yok)

> *"Bu projede en çok zaman alan iş kod yazmak değildi — API'nin gerçekte ne
> yapabildiğini keşfetmekti.*
>
> *AI destekli geliştirmenin en yüksek getirili adımı: **yazmadan önce keşfet.**
> Model kod yazmakta çok iyi. Yanlış sözleşmeye göre yazılmış kodu iki gün sonra
> silmek ise hiç ucuz değil."*

### A) süre dağılımı

| Adım | Süre |
|---|---|
| A1 Problem | 1 dk |
| A2 Sekiz tool | 2 dk |
| A3 ★ Kısıt | 4 dk |
| A4 Protokol vaadi | 2 dk |
| A5 Kapanış | 1 dk |
| **Toplam** | **10 dk** |

---

<a id="b"></a>

# B) 45 dakikalık tam ders

Omurga sihirbaz. Chatbot ve Claude Code sonda, isteğe bağlı.

### B0 — Açılış (3 dk, komut yok)

Slayt yok. Ekranda repo ağacı.

> *"Elimizde somut bir iş var: bir kişinin Xurrent'taki açık taleplerini listelemek,
> kullanıcıdan süre almak, kaydetmek, ve günün takvimini zaman girişine çevirmek.*
>
> *Bunu düz kodla da yazabilirdik. Neden MCP?*
>
> *Çünkü asıl zorluk API çağrısı yapmak değil — **müzakere**. Kullanıcı 'dün 2 saat
> VPN işine baktım' diyor. Hangi ticket? Süre yuvarlanacak mı? Dünkü tarih kabul
> edilir mi? Bu bir diyalog.*
>
> *Ve dersin tezi şu: **MCP bir protokoldür, dil seçimi bir detaydır.** Şimdi bunu
> kanıtlayacağız."*

Repo yapısını 30 saniyede göster: `contract/`, `fixtures/`, `servers/` ×3, `docs/`.

### B1 — Sihirbaz: adımlar 01–05 (12 dk)

```bash
node clients/wizard/wizard.mjs --server ts
```

Adım adım ilerle. Anahtar anlar:

| Adım | Süre | Söylenecek |
|---|---|---|
| **01** Neden MCP | 2 dk | "Bir kez yaz, her yerde kullan. Claude Code'a da, kendi chatbot'una da, bu sihirbaza da takılır." |
| **02** `tools/list` | 2 dk | "LLM'in tool'u nasıl kullanacağını öğrenmesinin **tek** yolu bu açıklamalar. Kötü description = yanlış kullanılan tool." |
| **03** `whoami` | 2 dk | "`person.id`'ye bak — opak base64. **Bu ID'ler asla elle üretilmez.** Chatbot'un sistem promptunda bu ayrı bir madde." |
| **04** ★ Açık işler | 4 dk | Üç tuzağı tek tek aç. **Quiz'i sesli sor.** |
| **05** `timeIncrement` | 2 dk | "Varsayılan 60. Yani varsayılan bir hesapta '45 dakika çalıştım' **yazılamaz**. Sessizce reddedilir." |

**Adım 04'te durup soru sor:**

> *"Task listesini çekerken filtrede `member` alanını kullansaydık ne olurdu?
> (a) hata alırdık, (b) boş liste dönerdi, (c) filtre yok sayılırdı"*

Cevaplar gelsin, sonra `explain`'i oku. **Sessiz hata** kavramını burada yerleştir.

### B2 — ★ Dersin kalbi: adımlar 06–08 (12 dk)

| Adım | Süre | Söylenecek |
|---|---|---|
| **06** İki yol | 5 dk | **Acele etme.** Tabloyu satır satır oku. Tahtaya çiz. |
| **07** Dry-run | 3 dk | "`planned[].mutation`'da gönderilecek GraphQL **birebir** duruyor. Anlatmıyoruz — gösteriyoruz." |
| **08** Üç strateji | 4 dk | Üç `planned` çıktısını yan yana göster. |

**Adım 06 için tahta çizimi:**

```
İSTER:  ticket'a bağlı  +  T-1 tarih  +  başlangıç saati

Yol A  timeEntryCreate      ✅ tarih  ✅ saat   ❌ TICKET
Yol B  requestUpdate        ❌ tarih  ❌ saat   ✅ ticket
                                 ↓
              TimeEntryUpdateInput'ta assignment YOK
                                 ↓
              → update ticket bağını BOZAMAZ
                                 ↓
              two_step:  1) requestUpdate   2) timeEntryUpdate
```

**Adım 08'de sor:**

> *"Yönetim 'her ticket'a ne kadar zaman harcandı' raporunu istiyor. Hangi strateji
> uygun değil?"*

Cevap: `date_first` — kayıt ticket'a bağlanmaz, ticket bazlı raporda görünmez.

> *"Hiçbiri 'doğru cevap' değil. Mimari kararlar doğru/yanlış değil, **takas**tır.
> Hangisinin doğru olduğunu senin raporlama ihtiyacın belirler."*

### B3 — Takvim: adımlar 09–10 (8 dk)

| Adım | Süre | Söylenecek |
|---|---|---|
| **09** Takvimi oku | 5 dk | "Takviminde doğum günü var. Öğle arası var. Reddettiğin bir retro var. İki toplantı çakışıyor. Biri 45 dakika." |
| **10** Öneri üret | 3 dk | "Bu tool **asla yazmaz**. Yapısal olarak yazma yeteneği yok." |

**Adım 09'da 225 vs 255 farkını vurgula:**

> *"`busyMinutes` 225, `naiveSumMinutes` 255. Fark 30 dakika — çünkü 10:00-11:00 ve
> 10:30-11:30 çakışıyor. Naif toplama güvenirsen **30 dakika fazla** zaman yazarsın.*
> *İkisini de raporluyoruz, çünkü farklı sorulara cevap veriyorlar. Ve fark sıfırdan
> büyükse, bu kullanıcıya bir soru sorulması gerektiğinin sinyali."*

**Adım 10'da belirsizliği göster:**

> *"'VPN kopma sorunu kök neden' önerisine bak: hem Request #70301'e hem Task #4419'a
> benziyor. Heuristik en yüksek skoru seçebilirdi — **seçmiyor.**
> `needsUserDecision: true` dönüyor. Bot tahmin etmek yerine **soruyor.**"*

### B4 — Gerçek yazma: adım 11 (4 dk)

| Adım | Süre | Söylenecek |
|---|---|---|
| **11** Onaylı yazma | 4 dk | Elicitation diyaloğu ekranda görünür. |

> *"Şimdiye kadar hep `dryRun` kullandık. Şimdi gerçekten yazacağız — mock modda,
> yani güvendeyiz.*
>
> *MCP'nin **elicitation** özelliği devreye giriyor: sunucu, istemci üzerinden
> **doğrudan kullanıcıya** soru soruyor.*
>
> *Bu mimari bir karar: onay diyaloğunu LLM'e bırakmıyoruz. **LLM ikna edilebilir;
> protokol seviyesindeki onay edilemez.**"*

Yazma bittikten sonra:

> *"Ve unutma: Yol B'de `timeSpent` **artımlıdır**. 60 gönderdik, 'toplamı 60 yap'
> demedik — 'üzerine 60 ekle' dedik. Entegrasyonlarda çift sayma hatalarının bir
> numaralı kaynağı bu."*

### B5 — Protokol vaadi: adım 16 (3 dk)

```bash
# Sihirbazı kapat, Python ile aç
node clients/wizard/wizard.mjs --server py
```

İlk üç adımı göster, durdur.

> *"Tek bir adım değişmedi. Aynı tool'lar, aynı çıktılar, aynı sayılar.*
> *Çünkü sözleşme `contract/tools.json`'da, veri `fixtures/`'ta, ders
> `steps.json`'da. Üç sunucu da sadece birer implementasyon.*
>
> *AI destekli geliştirmede asıl beceri kod yazmak değil — **doğru sözleşmeyi tarif
> etmek.** Sözleşme netse implementasyon dili gerçekten bir detaydır."*

Sonra kanıtı otomatikleştir:

```bash
node scripts/verify-contract.mjs --all
```

> *"Ve bu bir iddia değil — test."*

### B6 — Bonus: Claude Code (3 dk, isteğe bağlı)

> **İnternet veya onay akışı riskliyse bu adımı atla.** Ders B5'te tamdır.

```bash
claude
```

`xurrent-ts` sunucusunu onayla, sonra yaz:

```
bugünkü toplantılarımı Xurrent'a yazmak istiyorum, önce bir plan çıkar
```

**Beklenen:** Claude sırayla `calendar_list_today` → `plan_time_entries_from_calendar`
çağırır, 5 öneri gösterir, yuvarlama uyarısını iletir, belirsiz olanı sorar.

> *"Aynı sunucu. Tek satır kod değişmedi. Sadece istemci değişti."*

### B) süre dağılımı

| Bölüm | Süre |
|---|---|
| B0 Açılış | 3 dk |
| B1 Adımlar 01–05 | 12 dk |
| B2 ★ Adımlar 06–08 | 12 dk |
| B3 Takvim 09–10 | 8 dk |
| B4 Yazma 11 | 4 dk |
| B5 Protokol vaadi 12 | 3 dk |
| B6 Claude Code *(bonus)* | 3 dk |
| **Toplam** | **45 dk** |

**Süre daralırsa kesme sırası:** B6 → B3'ün ikinci yarısı → B1'in 01. adımı.
**B2'yi asla kesme.**

---

<a id="c"></a>

# C) Yedek plan — internet yok

**İyi haber:** dersin **%90'ı internetsiz çalışır.**

| Bileşen | İnternetsiz |
|---|---|
| Sihirbaz (16 adım) | ✅ |
| Mock Xurrent adapter | ✅ |
| Mock takvim | ✅ |
| `verify-contract` | ✅ |
| Inspector | ✅ *(paket önceden çekilmişse)* |
| Chatbot | ❌ |
| Claude Code | ❌ |
| Web arayüzü (LLM tarafı) | ❌ |

### C1 — Önceden hazırlık (internet varken)

```bash
# Bağımlılıkları önden çek
cd servers/typescript && npm install && npm run build && cd ../..
cd servers/python     && uv sync                       && cd ../..
cd servers/csharp     && dotnet build                  && cd ../..
cd clients/wizard     && npm install                   && cd ../..

# Inspector'ı önden indir (npx aksi halde ağa çıkar)
npx --yes @modelcontextprotocol/inspector --version

# Provayı çevrimdışı doğrula
node clients/wizard/wizard.mjs --server ts --auto
```

Wi-Fi'yi kapat ve prova komutunu **tekrar** çalıştır. Geçiyorsa C planı hazır.

### C2 — Ders akışı (B ile aynı, B6 yok)

B0 → B5 aynen uygulanır. Tek fark: B6 (Claude Code) yerine sözlü kapanış:

> *"Bu sunucuyu Claude Code'a takmak tek satırlık bir yapılandırma —
> `.mcp.json` zaten repoda. İnternet olduğunda `claude` yazıp
> *'bugünkü toplantılarımı Xurrent'a yaz'* demeniz yetiyor.*
>
> *Ama dikkat edin: bugün gördüğünüz her şey **LLM olmadan** çalıştı. Sihirbaz bir MCP
> client'ıdır, tool'ları doğrudan çağırır. LLM ürünün parçası — dersin değil.*
>
> *Bu da bir tasarım kararıydı: en kritik demoyu en kırılgan bağımlılıktan
> ayırmak."*

Bu, kayıp gibi görünen şeyi bir öğretim noktasına çevirir.

### C3 — Ekstra süre varsa

İnternetsiz derste B6'nın 3 dakikası boşalır. Doldurmak için:

**Seçenek 1 — Üç dili yan yana çalıştır (3 dk):**

```bash
for s in ts py cs; do
  echo "=== $s ==="
  node clients/wizard/wizard.mjs --server $s --step 04 --auto --json
done
```

> *"Üç farklı dil, üç farklı runtime, aynı JSON."*

**Seçenek 2 — Sözleşmeyi aç (3 dk):**

```bash
less contract/tools.json
```

`teachingNotes` alanlarını göster.

> *"Bu alanlar hem ders notu hem çalışan prompt. LLM'in tool'u nasıl kullanacağını
> öğrendiği yer tam olarak burası."*

**Seçenek 3 — Strateji seçim ağacını tartış (3 dk):**
[02 — Seçim rehberi](../02-zaman-girisi-modeli.md#stratejiler) diyagramını tahtaya çiz
ve öğrencilere sor: *"Sizin kurumunuzda hangisi?"*

**Seçenek 4 — Kaos senaryosunu CANLI koş (1 dk):**

```bash
node tools/fake-xurrent/senaryolar.mjs --dil ts
```

> *"Şimdi sunucuya bilerek arıza enjekte ediyoruz: üç kez 429, sonra bir kalem
> kalıcı kırık. İzleyin: retry politikası yazmayı kurtarıyor, kısmen kırılan
> bulk AYNI komutla tekrar çalıştırılınca `deduped` ile tamamlanıyor — çift
> kayıt yok. Güvenilirlik iddia değil, ölçüm."* (bkz. [15](../15-guvenilirlik.md))

**Seçenek 5 — LLM'siz sohbeti göster (2 dk):**

```bash
cd clients/cli && node xmcp.mjs chat --server ts --script "1
2 saat
dün 14:00 VPN bakımı
two_step
evet"
```

> *"Az önce UI'sız, LLM'siz, tarayıcısız bir chatbot kullandık. Sohbetin aklı
> sunucudaki `timesheet_wizard` durum makinesinde — Copilot Studio'ya bağlanınca
> da aynı makine konuşacak. Ve '2 saat'in 120 dakikaya çevrildiğini bot'un
> SÖYLEDİĞİNE dikkat."* (bkz. [18](../18-cli.md))

---

## Sunum sonrası

### Öğrenciye bırakılacak tek komut

```bash
git clone <repo> && cd xurrent-mcp && cp .env.example .env
cd servers/typescript && npm install && npm run build && npm run wizard
```

> *"Token yok, hesap yok, internet yok. Aynı ders, kendi makinenizde."*

### Okuma sırası önerisi

| Sıra | Bölüm | Neden |
|---|---|---|
| 1 | [`contract/tools.json`](../../contract/tools.json) | Sözleşme önce |
| 2 | [`fixtures/README.md`](../../fixtures/README.md) | Veri neden böyle kurgulandı |
| 3 | [02 — Zaman girişi modeli](../02-zaman-girisi-modeli.md) | Dersin kalbi |
| 4 | [03 — MCP tasarımı](../03-mcp-tasarimi.md) | Tool sınırları, dry-run, onay |
| 5 | `servers/<dil>/src` | Kod **en son** |

> *"Kodu en son okuyun. Sözleşmeyi anlamadan koda bakmak, kodun **neden** öyle
> olduğunu göstermez."*

### Ödev önerileri

| Zorluk | Ödev |
|---|---|
| Kolay | `steps.json`'a `xurrent_find_person` adımı ekle ([07](../07-sihirbaz.md)'deki şablon) |
| Orta | Dördüncü bir dilde (Go / Rust / Java) `xurrent_whoami` + `xurrent_list_open_work` yaz, `verify-contract`'ı geçir |
| Zor | `xurrent_delete_time_entry` tool'u tasarla: hangi `annotations`? `destructiveHint` nasıl olmalı? Elicitation metni ne demeli? |
| En zor | [08 — `DOĞRULANMALI`](../08-riskler-ve-sss.md#dogrulanmali) listesindeki **D5**'i canlı bir hesapta doğrula ve `two_step`'i sağlamlaştır |

---

## Tek sayfalık hızlı referans

Sunum sırasında elinin altında bulunsun.

```bash
# --- Sihirbaz ---
node clients/wizard/wizard.mjs --server ts        # interaktif
node clients/wizard/wizard.mjs --server py        # Python sunucusu
node clients/wizard/wizard.mjs --server cs        # C# sunucusu
node clients/wizard/wizard.mjs --server ts --auto # beklemesiz
node clients/wizard/wizard.mjs --server ts --step 06   # tek adım

# --- Doğrulama ---
node scripts/verify-contract.mjs --all

# --- Inspector ---
npx @modelcontextprotocol/inspector node servers/typescript/dist/mcp/stdio.js

# --- Chatbot / web (API key gerekir) ---
cd servers/typescript && npm run chat
cd servers/typescript && npm run web        # http://localhost:8787

# --- Claude Code ---
claude
claude mcp reset-project-choices            # onayları sıfırla

# --- Temizlik ---
git checkout fixtures/time-entries.json     # mock yazmaları geri al
node scripts/gen-ics.mjs                    # .ics'i bugüne göre üret
```

### Ezberlenecek sayılar

| Değer | Nerede |
|---|---|
| **10** | tool sayısı (`tools/list`) |
| **3 / 3** | açık Request / Task |
| **30** | `timeIncrement` |
| **3** | effort class (4'ten biri `disabled`) |
| **8 → 5** | ham etkinlik → gerçek toplantı |
| **225 / 255** | `busyMinutes` / `naiveSumMinutes` |
| **5** | takvim önerisi |
| **2 / 1 / 1** | `planned.length` — `two_step` / `link_first` / `date_first` |

### Üç cümlelik özet

> **1.** `timeEntryCreate` bir ticket'a bağlanamaz — `TimeEntryCreateInput`'ta
> `requestId`/`taskId`/`assignmentId` yoktur.
>
> **2.** `TimeEntryUpdateInput`'ta da `assignment` yoktur — bu yüzden güncelleme
> ticket bağını **bozamaz**, ve `two_step` stratejisi mümkün olur.
>
> **3.** Sözleşme netse implementasyon dili gerçekten bir detaydır — üç sunucu, aynı
> 16 adım, aynı sayılar.
