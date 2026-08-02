# scripts/ — yardımcı script'ler

Bu klasördeki script'lerin **hiçbirinin bağımlılığı yoktur**. Düz Node 20+ ile çalışırlar,
`npm install` gerektirmezler. Sebebi bilinçlidir: bunlar üç dilin de kullandığı **ortak**
araçlardır; birine bağımlılık eklemek üç ekosistemden birini ayrıcalıklı kılardı.

| Script | Ne yapar | Ne zaman çalıştırılır |
|---|---|---|
| [`gen-ics.mjs`](#gen-icsmjs) | `fixtures/calendar.json` → `fixtures/calendar.ics` | `ics` sağlayıcısı test edilecekse; **sunumdan hemen önce** |
| [`google-auth.mjs`](#google-authmjs) | Tek seferlik Google Calendar OAuth; refresh token'ı diske yazar | `CALENDAR_PROVIDER=google` kullanılacaksa **bir kez** |
| [`verify-contract.mjs`](#verify-contractmjs) | `tools/list` + `tools/call` çıktısını `contract/tools.json`'a karşı doğrular | Her sunucu değişikliğinden sonra ve **CI'da** |
| [`validate-steps.mjs`](#validate-stepsmjs) | `docs/wizard/steps.json` → `docs/wizard/steps.schema.json` doğrulaması | Ders adımları her değiştiğinde ve **CI'da** |

`lib/mini-jsonschema.mjs` bir script değil, `validate-steps.mjs`'in kullandığı ~250 satırlık
bağımlılıksız JSON Schema (draft 2020-12 alt kümesi) doğrulayıcısıdır.

Hepsinin `--help` seçeneği vardır.

---

## `gen-ics.mjs`

```bash
node scripts/gen-ics.mjs                          # fixtures/calendar.ics üretir
node scripts/gen-ics.mjs --print                  # dosyaya yazmaz, ekrana basar
node scripts/gen-ics.mjs --date 2026-08-02        # 'bugün'ü sabitler (test için)
node scripts/gen-ics.mjs --tz Europe/Berlin       # başka saat dilimi
node scripts/gen-ics.mjs --out /tmp/takvim.ics
```

### Neden gerekli

`fixtures/calendar.json` içindeki tarihler **görelidir** (`dayOffset: 0` = bugün, `-1` = dün).
Demo hangi gün çalıştırılırsa çalışsın aynı dersi versin diye böyle kurgulanmıştır.

Ama `.ics` **gerçek bir dosya formatıdır** ve göreli tarih taşıyamaz — her `VEVENT` mutlak bir
`DTSTART` içermek zorundadır. Bu yüzden `.ics`, o anki tarihe göre yeniden üretilir.

> `fixtures/calendar.ics` **`.gitignore`'dadır**. Kaynak `calendar.json`, `.ics` türevdir.
> Dünkü `.ics` dosyası yanlış günü gösterir; sunum sabahı bir kez çalıştırmak yeterlidir.

### Üretilen dosyada ne var

| Özellik | Nasıl üretilir | Hangi dersi verir |
|---|---|---|
| `VTIMEZONE` | Ocak/Temmuz offset'leri karşılaştırılır; farklıysa AB DST kuralı yazılır | Europe/Istanbul 2016'dan beri kalıcı `+03` — DST yok, tek `STANDARD` bileşeni |
| `DTSTART;TZID=...` | Yerel saat + TZID | UTC'ye çevirmek DST günlerinde **sessizce yanlış instant** üretir |
| Tüm gün etkinliği | `VALUE=DATE` + **exclusive** `DTEND` (ertesi gün) | Süre instant farkından **hesaplanamaz** |
| `TRANSP:TRANSPARENT` | `free: true` olanlar | Graph'te `showAs=free`, Google'da `transparency=transparent` |
| `ATTENDEE;PARTSTAT=DECLINED` | `declined: true` olanlar | Reddedilen toplantı takvimde **durmaya devam eder**; sunucu tarafında filtre yoktur |
| Satır katlama | 75 **oktet** sınırı, devam satırı boşlukla başlar | RFC 5545 §3.1 — `ş` 2 bayttır, karakter saymak yetmez |
| `CRLF` satır sonu | Her satır | RFC 5545 zorunluluğu |

### Doğrulama

```bash
node scripts/gen-ics.mjs
grep -c 'BEGIN:VEVENT' fixtures/calendar.ics    # 10 (bugün 8 + dün 2)
```

`CALENDAR_PROVIDER=ics` ile çalıştırılan sunucu, `calendar_list_today` çağrısında
`mock` sağlayıcısıyla **aynı sayıları** üretmelidir: `rawCount=8, count=5, filteredOut=3,
busyMinutes=225, naiveSumMinutes=255`.

---

## `google-auth.mjs`

```bash
node scripts/google-auth.mjs                     # tarayıcı açar
node scripts/google-auth.mjs --print-url         # SSH/uzak oturum: URL'yi basar
node scripts/google-auth.mjs --force             # mevcut token'ın üzerine yazar
node scripts/google-auth.mjs --calendar-id ekip@ornek.com
```

Önce `.env` içinde `GOOGLE_CLIENT_ID` ve `GOOGLE_CLIENT_SECRET` dolu olmalıdır.
Boşsa script **nasıl alınacağını 8 adımda Türkçe anlatır** ve çıkar.

### Neden ayrı bir script

OAuth akışı (tarayıcı açma, loopback dinleme, PKCE, kod takası) **üç dilde ayrı ayrı
yazılsaydı üç kez yazılmış ve üç kez hata yapılmış olurdu.** Bunun yerine:

1. Akış **bir kez** burada çalışır.
2. `refresh_token` diske yazılır.
3. Üç sunucu da o dosyayı okur ve access token'ı **düz bir HTTP POST** ile yeniler.

Böylece üç dilde de OAuth kütüphanesi **gerekmez**. Bu, "ortak katman"ın en somut örneğidir.

### Akışın önemli noktaları

- **Client tipi `Desktop app` olmalıdır.** Loopback yönlendirmesi (`http://127.0.0.1:<port>`)
  yalnızca bu tipte kayıt gerektirmez. `Web application` seçilirse her portu tek tek kaydetmek
  gerekir — ve port her çalıştırmada değişir.
- **`127.0.0.1`, `localhost` değil.** `localhost` bazı sistemlerde `::1`'e çözülür ve Google'ın
  loopback eşleşmesi bozulur.
- **`access_type=offline` + `prompt=consent` birlikte.** `prompt` atlanırsa Google, daha önce
  onay verilmiş hesaplarda `refresh_token` **göndermez** ve elinizde işe yaramaz bir dosya kalır.
  Script bu durumu yakalar ve hata verir.
- **PKCE (S256) zorunludur.** Desktop akışında `client_secret` gerçek anlamda gizli değildir
  (kullanıcının diskinde durur); PKCE, yakalanan authorization code'un kullanılmasını engeller.
- **`state` doğrulanır.** Eşleşmezse istek reddedilir (CSRF).
- Kapsam **yalnızca okuma**: `https://www.googleapis.com/auth/calendar.events.readonly`.

### `google-token.json` şeması

Varsayılan yol: `~/.xurrent-mcp/google-token.json`
(`GOOGLE_TOKEN_PATH` ile değiştirilebilir). Dizin `0700`, dosya `0600` izniyle yazılır.

```jsonc
{
  "version": 1,                    // şema sürümü — okurken kontrol edilmeli
  "provider": "google",
  "created_at": "2026-08-02T14:31:07.221Z",
  "updated_at": "2026-08-02T14:31:07.221Z",

  "client_id":     "1234-abc.apps.googleusercontent.com",
  "client_secret": "GOCSPX-...",
  "token_uri":     "https://oauth2.googleapis.com/token",

  "scope":      "https://www.googleapis.com/auth/calendar.events.readonly",
  "token_type": "Bearer",

  "refresh_token": "1//0g...",     // SÜREKLİ — asıl değerli alan budur
  "access_token":  "ya29....",     // geçici, ~1 saat
  "expires_at":    1785000000,     // EPOCH SANİYE (göreli expires_in DEĞİL)

  "calendar_id": "primary"
}
```

> **`expires_at` neden epoch saniye?** `expires_in` (göreli, "3599 saniye sonra") saklamak işe
> yaramaz: dosya diskte beklerken süre akmaya devam eder. Mutlak an saklanır ki okuyan taraf
> `expires_at - 60 <= now` kontrolüyle yenileme kararını doğru versin.

### Üç sunucu bu dosyayı nasıl kullanır

Sözleşme budur; TypeScript, Python ve C# aynı adımları uygular:

1. Dosyayı oku. Yoksa veya `version` bilinmiyorsa **Türkçe hata**:
   *"Google token bulunamadı — `node scripts/google-auth.mjs` çalıştırın."*
2. `access_token` varsa ve `expires_at - 60 > now` ise onu kullan.
3. Değilse **düz bir HTTP POST** ile yenile:

```http
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

client_id=<client_id>&client_secret=<client_secret>&refresh_token=<refresh_token>&grant_type=refresh_token
```

Yanıt:

```jsonc
{ "access_token": "ya29....", "expires_in": 3599, "scope": "...", "token_type": "Bearer" }
```

4. **Yanıtta `refresh_token` YOKTUR** — bu normaldir. Mevcut `refresh_token` korunur;
   yalnızca `access_token` ve `expires_at` güncellenir.
5. Dosyayı geri yazarken izinleri **`0600` olarak koru**.
6. `invalid_grant` hatası → kullanıcı erişimi iptal etmiş veya uygulama "Testing" modunda
   7 günü doldurmuştur. Türkçe mesaj: *"Google yetkisi geçersiz — `node scripts/google-auth.mjs --force` ile yeniden yetkilendirin."*

### Takvim okurken (hatırlatma)

```
GET https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events
    ?singleEvents=true          ← ZORUNLU (varsayılan false!)
    &orderBy=startTime          ← yalnızca singleEvents=true iken çalışır
    &timeMin=2026-08-02T00:00:00+03:00      ← offset ZORUNLU
    &timeMax=2026-08-03T00:00:00+03:00
```

`transparency` alanı varsayılan `"opaque"` iken **yanıtta çıkmaz** → `(ev.transparency ?? "opaque")`.

---

## `verify-contract.mjs`

```bash
node scripts/verify-contract.mjs --all
node scripts/verify-contract.mjs --server ts
node scripts/verify-contract.mjs --all --skip-missing     # derlenmemiş dili atla
node scripts/verify-contract.mjs --all --no-call          # tools/call yapmadan
node scripts/verify-contract.mjs --all --json             # CI için
```

İlgili sunucuyu stdio üzerinden başlatır, **uyumluluk sondası** yapar, `tools/list` ve gerçek
bir `tools/call` çalıştırır, sonucu `contract/tools.json` ile karşılaştırır.

Sonda, sunucunun hangi revizyonu konuştuğunu belirler:

```
server/discover (zorunlu _meta ile)
  ├─ başarılı                 → v2 (2026-07-28)
  ├─ -32601 Method not found  → v1'e düş (initialize)
  └─ -32602 params geçersiz   → İSTEMCİ hatası; v1'e DÜŞÜLMEZ, script hata verir
```

> Son satır ders niteliğindedir: `_meta` göndermeden atılan bir sonda Python'da
> `-32601 Method not found` (yanıltıcı), C#'ta `-32602` döner. İkisini de "sunucu v2
> konuşmuyor" diye yorumlamak, kendi istemci hatanı sunucunun eksikliği sanmaktır.

| Kontrol | Neden önemli |
|---|---|
| Tool sayısı ve adları | Bir ad kayarsa sihirbaz ve chatbot **sessizce** yanlış çalışır |
| `inputSchema.properties` anahtarları | Parametre adı farkı → LLM tool'u yanlış çağırır, hata almaz |
| `required` alanları | Zorunluluk kaybolursa eksik argümanla çağrı geçer gider |
| `annotations` (özellikle `readOnlyHint`) | Claude Code izin isterken buna bakar; yanlışsa **yazan bir tool onaysız çalışır** |
| `description` dolu mu | Boş açıklama = LLM'in tool'u nasıl kullanacağını bilmemesi |
| **`outputSchema` bildiriliyor mu** | Bildirilmezse `tools/call` cevabında `structuredContent` **üretilmez**; çağıran taraf JSON'ı metinden ayrıştırmak zorunda kalır |
| **`outputSchema` üst seviye alanları** | Sözleşmedeki `output` ile birebir örtüşmeli (`$ref`'ler çözülerek) |
| **Gerçek `tools/call` → `structuredContent` dolu mu** | Şema bildirmek yetmez; çağrının kendisi de yapılandırılmış veri döndürmeli |
| **`structuredContent` yanında text block var mı** | Yapılandırılmış çıktıyı okuyamayan client'lar (ve insanlar) hâlâ var |
| **`tools/list` sırası** | v2 sırayı **deterministik** ister (LLM prompt cache isabeti); kanonik sıra sözleşmedeki sıradır |
| **v2: `ttlMs` + `cacheScope`** | v2'de liste cache alanları **zorunludur**; statik listemiz için `300000` / `"public"` |
| **v2: `resultType`** | v2'de sonuç zarfında `resultType` zorunludur (`"complete"`) |
| stdout kirliliği | stdio transport'ta stdout **sadece** JSON-RPC içindir; tek satır log protokolü bozar |

> **Neden çıktı tarafı sonradan eklendi:** script uzun süre yalnızca *girdi* tarafını
> karşılaştırdı. Bu yüzden iki sunucunun hiç `outputSchema` bildirmediği ve dolayısıyla
> `structuredContent` üretmediği **kaçtı**. Bir tool sözleşmesi, çağıranın ne göndereceği
> kadar ne *alacağını* da tarif eder; yoksa "üç dil aynı çıktıyı üretir" tezi ölçülemez
> bir slogandır.

Farklar tablo hâlinde yazdırılır. **Fark varsa çıkış kodu 1'dir** — CI'da doğrudan kullanılabilir.

Birden çok sunucu doğrulandıysa sonunda **iki çapraz karşılaştırma** tablosu basılır:
her tool üç dilde de var mı, ve protokol/çıktı sözleşmesi üç dilde de aynı mı?

### Gelişmiş: rastgele bir MCP sunucusunu doğrula

```bash
node scripts/verify-contract.mjs --exec "node /yol/baska-mcp-sunucusu.js"
```

Aynı seçenek sihirbazda da vardır (`clients/wizard/wizard.mjs --exec "..."`).

---

## `validate-steps.mjs`

```bash
node scripts/validate-steps.mjs
node scripts/validate-steps.mjs --json                     # CI için
node scripts/validate-steps.mjs --steps /yol/steps.json    # başka bir ders dosyası
```

`docs/wizard/steps.json`'u `docs/wizard/steps.schema.json`'a karşı doğrular. İki katman:

1. **Yapısal** — JSON Schema. Şema `additionalProperties: false` ile katıdır: sihirbazın
   tanımadığı bir anahtar **sessizce yok sayılır**, yani derste hiç çalışmayan bir bölüm olur.
2. **Anlamsal** — saf JSON Schema'nın ifade *edemediği* referans bütünlüğü:

| Kontrol | Örnek hata |
|---|---|
| `chapter` id'si `chapters[]` içinde var mı | `"chapter": "yok-boyle-bolum"` |
| Adım id'leri tekil mi | aynı id iki kez |
| `callTool` / `callToolSequence` / `compareProtocols` tool adları sözleşmede var mı | `xurrent_yok` |
| `quiz.answer` seçenek sayısını aşıyor mu (0 tabanlı) | 3 seçenek, `answer: 9` |
| Tablo satır uzunlukları başlık sayısıyla eşleşiyor mu | 3 başlık, 1 hücreli satır |
| `expect` ön koşulu var mı | `path` kontrolü var ama adımda hiç tool çağrısı yok |
| `docs` yolu diskte var mı | `docs/yok.md` |

Uyarılar (`⚠`) çıkış kodunu **etkilemez**; ihlaller (`✘`) 1 döndürür.

---

## Sihirbaz (bu klasörde değil ama ilgili)

```bash
cd clients/wizard && npm install      # tek bağımlılık: @modelcontextprotocol/sdk
node clients/wizard/wizard.mjs --server ts
node clients/wizard/wizard.mjs --server py --auto --json    # CI
node clients/wizard/wizard.mjs --server py --step 06        # tek adım (kısmi id eşleşmesi)
node clients/wizard/wizard.mjs --server ts --from 12 --auto # 12. adımdan sona kadar
```

Sihirbaz da bir **MCP client**'tır ve `docs/wizard/steps.json` dosyasındaki adımları yürütür.

### Üç durumlu sonuç: PASS / FAIL / SKIP

| Durum | Anlamı | Çıkış koduna etkisi |
|---|---|---|
| `PASS` | Kontrol çalıştı ve tuttu | — |
| `FAIL` | Kontrol çalıştı ve **tutmadı** | çıkış kodu **1** |
| `SKIP` | Kontrol **çalıştırılamadı** (ön koşul yok) | yok — 0 kalır |

Özet satırı: `N geçti, M başarısız, K atlandı`.

`SKIP`'in tanımı bilinçli olarak dardır: *"çalıştı ama tutmadı"* asla `SKIP` olamaz — yoksa
sihirbaz kendi hatalarını kendi affeder. Tipik `SKIP` sebepleri: kullanıcı `confirmable` bir
yazma adımını onaylamadı, ya da sunucu `compareProtocols`'un istediği revizyonu konuşmuyor.

### Adım seçimi

`--step` / `--only` / `--from` id'leri **üç kademede** eşleştirir: birebir → önek → içerik.
İlk dolu kademe kazanır, böylece tam id yazan kişi kısmi eşleşmenin gürültüsüne takılmaz.
`--step 06` → `06-iki-yol`. Adım id'leri için: `--list-steps`.

### Uyumluluk sondası

Sihirbaz bağlanmadan **önce** ayrı ve kısa ömürlü bir süreçte `server/discover` gönderir
(zorunlu `_meta` ile) ve konuştuğu protokolü **ekranda gösterir**. Sonda ayrı süreçte
çalışır çünkü `initialize` yapılmış bir bağlantı v2 zarflı istekleri reddeder
(*"this connection serves the handshake protocol era"*).

### Protokol karşılaştırması

`steps.json` içindeki `compareProtocols` adımları **aynı tool'u iki MCP revizyonuyla** çağırır
(sunucu tarafı `MCP_PROTOCOL` ile seçilir) ve çıktıların **birebir aynı** olduğunu doğrular
(`expect: { check: "protocolsAgree" }`):

| | `2025-11-25` | `2026-07-28` |
|---|---|---|
| El sıkışma | `initialize` → `notifications/initialized` | **yok** — `server/discover` |
| Sürüm bildirimi | handshake'te bir kez | her istekte `_meta.io.modelcontextprotocol/protocolVersion` |
| Onay | sunucu → client **isteği** (`elicitation/create`) | sunucu → **sonuç** (`resultType: "input_required"`), client isteği **yeni id** ile tekrarlar (MRTR) |

Bu adımlar SDK yerine **ham JSON-RPC** kullanır: iki revizyon iki farklı SDK paketi gerektirir
ve teli doğrudan göstermek dersin kendisidir. Karşılaştırma `structuredContent`'lerin
**kanonik JSON**'ı üzerinden yapılır.

Sunucu ikinci revizyonu henüz konuşmuyorsa kontrol `SKIP` olur — `FAIL` değil. Ölçülemeyen
bir şeyi başarısız saymak, yeşil olması gereken CI'ları kırmızıya boyar ve asıl kırmızıları
görünmez yapar.

---

## Tipik sıra

```bash
cp .env.example .env                      # 1) yapılandırma (hiçbir şey doldurmadan çalışır)
node scripts/gen-ics.mjs                  # 2) .ics'i bugüne göre üret (isteğe bağlı)
node scripts/validate-steps.mjs           # 3) ders dosyası şemasına uyuyor mu?
node scripts/verify-contract.mjs --all    # 4) üç sunucu da sözleşmeye uyuyor mu?
node clients/wizard/wizard.mjs --server ts   # 5) dersi yürüt
```

Google takvimi kullanılacaksa 1. ile 2. arasında bir kez:

```bash
node scripts/google-auth.mjs
```
