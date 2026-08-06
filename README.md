# xurrent-mcp

> **Xurrent (ITSM) için MCP sunucusu ve chatbot — üç dilde, aynı sözleşmeyle.**
> AI destekli geliştirme dersi için hazırlanmış örnek uygulama ve öğretim materyali.

Bir kişinin Xurrent'taki açık taleplerini listeler, kullanıcıyla süre üzerine
müzakere eder, zaman girişlerini kaydeder, yazılanı geri okuyup doğrular ve günün
takvimini okuyup her toplantıyı zaman girişine çevirir. Sohbet yeteneği sunucunun
kendisindedir (`timesheet_wizard`): LLM'siz bir terminalden de, Copilot Studio'dan
da aynı diyalog yürür.

**Aynı MCP sözleşmesi TypeScript, Python ve C# ile ayrı ayrı implemente edilmiştir**
— iki API transportuyla (GraphQL + REST v1) ve iki MCP protokol çağıyla.
Dersin tezi budur: *MCP bir protokoldür; dil, transport ve çağ birer detaydır.*

---

## 60 saniyede başla

Hiçbir token, hesap veya internet bağlantısı gerekmez. Varsayılan **mock** moddur.

```bash
cp .env.example .env
```

Sonra herhangi bir dili seç:

```bash
cd servers/typescript && npm install && npm run build && npm run wizard
```

```bash
cd servers/python && uv sync && uv run xurrent-mcp --wizard
```

```bash
cd servers/csharp && dotnet run -- wizard
```

Üç komut da **aynı dersi** verir, **aynı sayıları** üretir.

---

## Neyi çözüyor

| # | İster | Karşılayan tool |
|---|---|---|
| 1 | İlgili kişinin açık görev/taleplerini id ve açıklama ile listele | `xurrent_list_open_work` |
| 2 | Her biri için kullanıcı süre belirtsin (başlangıç saati, tarih T veya T-1) | `xurrent_create_time_entry` — müzakere chatbot'ta ya da `timesheet_wizard`'ın kendisinde |
| 3 | Girişleri ilgili kişi ve görev için Xurrent'a kaydet | `xurrent_create_time_entry`, `..._bulk`; geri-okuma doğrulaması `xurrent_list_time_entries` |
| 4 | Günün takvimini oku, her toplantıyı zaman girişi olarak ekle | `calendar_list_today` → `plan_time_entries_from_calendar` |

Sözleşme toplam **10 tool**dur ([contract/tools.json](contract/tools.json)):
5 okuma, 2 yazma, 1 takvim, 1 önizleme, 1 sohbet.

### ⚠️ İster #2 ve #3 birlikte, Xurrent API'sinde tek adımda mümkün değil

Bu projenin en önemli bulgusu — ve dersin ana konusu:

| | **Yol A** `timeEntryCreate` | **Yol B** `requestUpdate` / `taskUpdate` |
|---|---|---|
| Ticket'a bağlar mı? | ❌ `assignment` = null | ✅ tek yol |
| `date` (T-1) kontrolü | ✅ | ❌ sunucu "bugün" atar |
| `startedAt` (başlangıç saati) | ✅ | ❌ |
| `personId` (başkası adına) | ✅ | ❌ authenticated user |

`TimeEntryCreateInput` içinde `requestId`/`taskId`/`assignmentId` **yoktur**.

Çözüm üç stratejiye ayrıldı ve **üçü de kodlandı** (`XURRENT_BACKDATE_STRATEGY`):

- **`two_step`** — Yol B ile yaz, ardından `timeEntryUpdate` ile `date`/`startedAt`/`personId` düzelt.
  Her şeyi korur; 2 istek, atomik değil.
  *Neden çalışır:* `TimeEntryUpdateInput`'ta `assignment` alanı **yoktur**, dolayısıyla 2. adım ticket bağını bozamaz.
- **`link_first`** — Sadece Yol B. Tek istek, atomik; tarih her zaman bugün.
- **`date_first`** — Sadece Yol A. Tarih/saat tam doğru; kayıt ticket'a bağlanmaz.

Ayrıntı: [docs/02-zaman-girisi-modeli.md](docs/02-zaman-girisi-modeli.md)

---

## Repo yapısı

```
contract/tools.json     ← dil-bağımsız tool sözleşmesi (10 tool). Tek gerçek kaynak.
contract/protocol.md    ← çift protokol sözleşmesi (2025-11-25 + 2026-07-28)
contract/reliability.md ← retry/dedup/"kesin mesajlaşma" politikası — tek sahip
contract/wizard.md      ← timesheet_wizard sohbet durum makinesi sözleşmesi
fixtures/               ← ortak mock veri. Üç dil de aynı dosyaları okur.
docs/                   ← anlatım notları (Türkçe, 19 bölüm + demo senaryosu + sunum)
docs/wizard/steps.json  ← sihirbaz ders akışı (16 adım). Üç dil de aynı dosyayı yürütür.
servers/typescript/     ├─ MCP sunucusu + chatbot + web (aynı sözleşme;
servers/python/         ├─  GraphQL + REST adaptörleri, çift-çağ HTTP)
servers/csharp/         └─  (+ resmî Xurrent.GraphQL SDK seçeneği)
clients/wizard/         ← MCP client sihirbaz — üç sunucuya da bağlanır
clients/cli/            ← xmcp: ham JSON-RPC istemcisi + Ink TUI sohbet
clients/inspector/      ← açıklamalı protokol ekranı (127.0.0.1:5200)
clients/web/            ← ortak statik web arayüzü, üç backend de servis eder
plugins/                ← plugin manifest'leri + Copilot Studio konektör paketi
tools/fake-xurrent/     ← sahte Xurrent: GraphQL + REST yüzeyi + kaos modu
```

---

## Üç çalıştırma modu

Her dil üçünü de destekler.

**1 — MCP sunucusu olarak (LLM'i host sağlar, API key gerekmez)**

```bash
claude
```

`.mcp.json` zaten hazır. Claude Code açılınca `xurrent-ts` sunucusunu onaylayın,
ardından *"bugünkü toplantılarımı Xurrent'a yaz"* deyin.

**2 — Terminal chatbot** (`GEMINI_API_KEY` gerekir — ya da sahte Gemini, aşağıda)

```bash
cd servers/typescript && npm run chat
```

**3 — Web arayüzü** (`GEMINI_API_KEY` gerekir — ya da sahte Gemini, aşağıda)

```bash
cd servers/typescript && npm run web    # → http://localhost:8787
```

**4 — Terminalden LLM'siz sohbet** (`xmcp` — API key gerekmez)

```bash
cd clients/cli && npm install && node xmcp.mjs chat --server ts
```

Sohbetin aklı sunucudaki `timesheet_wizard` durum makinesindedir; `xmcp` yalnız
soruları gösterir. Ayrıntı: [18 — CLI](docs/18-cli.md).

**5 — Copilot Studio'ya tool olarak** (public HTTPS + `MCP_API_KEY` gerekir)

Sunucu `MCP_PROTOCOL=both` ile HTTP modunda başlatılır, dev tunnel ile dışarı
açılır, üretilen konektörle bağlanır. Yürüyüş: [plugins/copilot-studio](plugins/copilot-studio/README.md).

**Bonus — Sihirbaz:** yukarıdaki `npm run wizard`. API key gerekmez; tool'ları
doğrudan çağırır, LLM kullanmaz.

### API anahtarı olmadan chatbot

LLM sağlayıcısı **Gemini**. Anahtarınız yoksa yerel sahte sunucuyu kullanın —
istemci kodunda tek satır değişmez:

```bash
node tools/fake-gemini/server.mjs --mod zar --tohum 42
```

```bash
GEMINI_BASE_URL=http://127.0.0.1:5100 GEMINI_API_KEY=sahte npm run chat
```

Dört mod var: `otomatik` (kural tabanlı), `zar` (rastgele ama tohumlanabilir —
aynı tohum aynı akışı verir), `sor` (isteği kuyruğa yazar, **yanıtı siz
yazarsınız** ve verdiğiniz yanıt kayda geçer), `kayit` (kaydedilenleri oynatır).
Ayrıntı: [tools/fake-gemini](tools/fake-gemini/README.md)

MCP sözleşmesi ile Gemini arasındaki şema farkı ayrı bir konu: MCP `inputSchema`
tam JSON Schema 2020-12, Gemini ise OpenAPI'nin dar bir alt kümesini kabul eder.
Aradaki çevirici neyi attığını raporlar — `additionalProperties`, `pattern`,
`maxLength`, `minimum` gibi anahtarlar Gemini'ye gitmez.

---

## Protokol vaadini kanıtla

Sihirbaz bir **MCP client**'tır — hangi sunucuya bağlanacağı parametreyle seçilir:

```bash
node clients/wizard/wizard.mjs --server ts
node clients/wizard/wizard.mjs --server py
node clients/wizard/wizard.mjs --server cs
```

Üçü de aynı 16 adımı, aynı çıktılarla yürütür. Adım sonucu üç durumludur —
`PASS` · `FAIL` · `SKIP` — ve özet *"N geçti, M başarısız, K atlandı"* biçimindedir.
Sözleşme uyumu otomatik doğrulanır:

```bash
node scripts/verify-contract.mjs --all
```

Tek komutla tüm doğrulama katmanları (derleme, birim, sözleşme, protokol uyumu,
kaos senaryoları, HTTP yüzeyi, wire denetimi):

```bash
node scripts/test-all.mjs
```

---

## MCP protokol revizyonu

Bu repo MCP'nin **iki protokol revizyonunu birden** ele alır ve farkı ders konusu yapar.

| | `2025-11-25` (v1) | `2026-07-28` (v2) |
|---|---|---|
| Bağlantı | `initialize` el sıkışması | El sıkışma **yok** — stateless |
| Keşif | `initialize` sonucu | **`server/discover`** (zorunlu) |
| Kullanıcıya soru sorma | `elicitation/create` (sunucu istek gönderir) | **MRTR** — `InputRequiredResult` (sunucu sonuç döner) |
| HTTP oturumu | `Mcp-Session-Id` | **Yok** |

`2026-07-28` revizyonu **tam olarak bizim onay akışımızı** kaldırdı. Tool sözleşmesi
([`contract/tools.json`](contract/tools.json)) ise iki çağ arasında **değişmez** — aynı
10 tool, aynı çıktı alanları, aynı beklenen sayılar. Dersin ana mesajı bu:

> İş mantığını protokolden ayırdıysan, breaking change seni **ince bir adaptör
> katmanında** yakalar — tüm uygulamada değil.

Sunucu tarafında revizyon seçimi `MCP_PROTOCOL` ile yapılır:
`2026-07-28` (varsayılan) · `2025-11-25` · `both`.

- Sözleşme: [`contract/protocol.md`](contract/protocol.md)
- Anlatım: [09 — Protokol geçişi](docs/09-protokol-gecisi.md) — MRTR sequence
  diyagramları, `requestState` imzalama şeması, ve **ölçülmüş** SDK protokol destek
  tablosu

---

## Gerçek Xurrent'a bağlanmak

`.env` içinde:

```bash
XURRENT_MODE=live
XURRENT_TOKEN=<personal access token>
XURRENT_ACCOUNT=<hesap slug'ı, örn. "widget" — numerik DEĞİL>
XURRENT_DRY_RUN=1          # ← ilk bağlantıda 1 bırakın
XURRENT_API=graphql        # graphql (varsayılan) | rest | graphql-sdk (yalnız C#)
```

`XURRENT_DRY_RUN=1` iken hiçbir mutation gönderilmez; planlanan mutation'lar ve
uyarılar döner. Çıktıyı inceledikten sonra `0` yapın. Rate limit'e karşı retry,
idempotency ve geri-okuma politikası hazırdır ve kaos senaryolarıyla kanıtlıdır —
bkz. [contract/reliability.md](contract/reliability.md) ve
[15 — Güvenilirlik](docs/15-guvenilirlik.md).

> **Bölge notu:** `eu` diye bir bölge **yoktur**. Geçerli değerler: Global (varsayılan),
> `au`, `uk`, `ch`, `us`. Global zaten Avrupa'dır.

---

## Takvim sağlayıcıları

| Sağlayıcı | Kurulum | Not |
|---|---|---|
| `mock` | yok | Varsayılan. `fixtures/calendar.json` |
| `ics` | yok | `.ics` dosyası veya yayınlanmış URL |
| `google` | `node scripts/google-auth.mjs` | Kişisel Gmail dahil çalışır |
| `graph` | Azure AD app registration | Microsoft 365 / Outlook |

Google için OAuth bir kez yapılır; token `~/.xurrent-mcp/google-token.json`
dosyasına yazılır ve **üç dil de aynı dosyayı okur**. Bilinçli bir tasarım:
OAuth akışını üç kez implemente etmek yerine token yenilemeyi düz bir HTTP POST'a indirir.

---

## Anlatım notları

| Bölüm | Konu |
|---|---|
| [00 — Genel bakış](docs/00-genel-bakis.md) | Problem, mimari, MCP neden |
| [01 — Xurrent API](docs/01-xurrent-api.md) | GraphQL, auth, veri modeli, filtre tuzakları |
| [02 — Zaman girişi modeli](docs/02-zaman-girisi-modeli.md) | ★ İki yol, üç strateji, `timeIncrement` |
| [03 — MCP tasarımı](docs/03-mcp-tasarimi.md) | Tool envanteri, dry-run, onay mekanizması |
| [04 — Takvim](docs/04-takvim.md) | Graph vs Google, normalizasyon, eşleştirme |
| [05 — Chatbot](docs/05-chatbot.md) | Sistem promptu, diyalog sözleşmesi, MRTR |
| [06 — Üç dil karşılaştırma](docs/06-uc-dil-karsilastirma.md) | Aynı sözleşme, üç SDK |
| [07 — Sihirbaz](docs/07-sihirbaz.md) | `steps.json`, ders akışı, `expect` blokları |
| [08 — Riskler ve SSS](docs/08-riskler-ve-sss.md) | Bilinen tuzaklar, `DOĞRULANMALI` listesi |
| [09 — Protokol geçişi](docs/09-protokol-gecisi.md) | ★ `2026-07-28`, MRTR, `requestState`, ölçüm |
| [10 — Sıfırdan geliştirme](docs/10-sifirdan-gelistirme.md) | ★ Bu proje nasıl üretildi — kararlar, tuzaklar |
| [11 — Prompt defteri](docs/11-prompt-defteri.md) | ★ Sırayla çalıştırılacak 16 prompt, kopyala-yapıştır |
| [12 — MCP uyumu](docs/12-mcp-uyum.md) | Spec uyum checklist'i, ölçülmüş sonuçlar, bilinen ihlaller |
| [13 — Inspector](docs/13-inspector.md) | Resmî inspector kullanımı + kendi açıklayıcı ekranımız |
| [14 — Test ve kalite](docs/14-test-ve-kalite.md) | Test piramidi, her katmanın neyi yakaladığı |
| [15 — Güvenilirlik](docs/15-guvenilirlik.md) | ★ Retry, dedup, kaos senaryoları, "kesin mesajlaşma" |
| [16 — REST ve resmî SDK](docs/16-rest-ve-sdk.md) | İkinci transport, 422 modeli, vendor SDK ölçümü |
| [17 — Plugin ve Copilot Studio](docs/17-plugin-ve-copilot.md) | Plugin modeli, konektör, tunnel yürüyüşü |
| [18 — CLI](docs/18-cli.md) | `xmcp`: ham JSON-RPC istemcisi + TUI sohbet |
| [Demo senaryosu](docs/demo/senaryo.md) | Sunumda adım adım ne yapılacak |
| [Sunum](docs/sunum.html) | Tek dosyalık, bağımlılıksız sunum sayfası |

---

## Atölye — projeyi sıfırdan yeniden üret

Sihirbaz uygulamanın **ne yaptığını** öğretir. Atölye **nasıl üretildiğini**.

```bash
node clients/atolye/atolye.mjs                          # anlat: 16 adım, prompt'lar ve kararlar
node clients/atolye/atolye.mjs --insa ~/atolye-denemem  # gerçekten inşa et ve doğrula
node clients/atolye/atolye.mjs --adim 05                # tek adım
```

Her adımda o adımda AI'a verilen **gerçek prompt**, insanın verdiği **karar** (seçilmeyen
şıklarla birlikte), üretilen dosyalar ve çalıştırılan **doğrulama komutu** var.
`--insa` dosyaları repodan hedef dizine kopyalar ve doğrulamaları gerçekten koşturur —
sonunda çalışan bir kopya ve sırayı bilen bir öğrenci kalır.

Anlatılan hikâye uydurma değil: bu repo tam olarak öyle üretildi. Yanlış çıkan mimari
kararlar, kaçırılan kusurlar ve iki yanlış alarm dahil.

**Derste kullanmak için:** [11 — Prompt defteri](docs/11-prompt-defteri.md) aynı 16 adımın
sırayla kopyalanıp çalıştırılacak prompt'larını verir. Defter `docs/atolye/adimlar.json`'dan
**üretilir** (`node scripts/gen-prompt-defteri.mjs`), böylece prompt'lar ile atölye asla ayrışmaz.

---

## Durum ve sınırlar

- **Mock mod uçtan uca çalışır ve test edilmiştir.** Sahte Xurrent'a karşı live
  kod yolu da (GraphQL **ve** REST, kaos senaryoları dahil) wire seviyesinde koşar.
- **Live mod gerçek bir Xurrent hesabına karşı çalıştırılmamıştır** — şemalar
  resmi dokümantasyondan çıkarılmıştır. [`docs/08-riskler-ve-sss.md`](docs/08-riskler-ve-sss.md)
  içinde `DOĞRULANMALI` etiketli maddeler ilk canlı bağlantıda kontrol edilmelidir
  (REST yanıt şekilleri, `TimeEntryFilter.sourceID`, resmî SDK davranışı dahil).
- **D11 ölçüldü:** Claude Code her iki MCP revizyonunu da kabul ediyor
  (`.mcp.json`'daki `xurrent-ts-v1` kaydı bu ölçümün aracıdır) — bkz. docs/08.
- **Copilot Studio bağlantısının tenant gerektiren yarısı elle koşulur**;
  CI yalnız konektör senkronunu ve oturumlu el sıkışmayı doğrular (docs/17).
- Bu bir **öğretim materyalidir**; üretim kullanımı için token yönetimi, hata
  telemetrisi ve çok kullanıcılı yetkilendirme eklenmelidir.

## Lisans

MIT
