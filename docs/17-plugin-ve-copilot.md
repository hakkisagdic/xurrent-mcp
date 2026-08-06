# 17 — Plugin mimarisi ve Copilot Studio

> **Bölüm hedefi:** "Eklenti" kelimesini üç dilli bir projede ayakları yere
> basan bir modele çevirmek; Copilot Studio'yu bu modelin ilk *paket* plugin'i
> olarak bağlamak; ve bunu yaparken çift-çağ mimarisinin (docs/09) neden bir
> lüks değil ZORUNLULUK olduğunu göstermek.

| ← Önceki | Sonraki → |
|---|---|
| [16 — REST ve resmî SDK](16-rest-ve-sdk.md) | [18 — CLI](18-cli.md) |

Şema: [`plugins/manifest.schema.json`](../plugins/manifest.schema.json) ·
Doğrulama: `node scripts/validate-plugins.mjs` (CI'da `pluginler` adımı) ·
Paket: [`plugins/copilot-studio/`](../plugins/copilot-studio/)

---

## Plugin nedir — ve bu projede ne DEĞİLDİR

Refleks tanım "çalışma anında kod yükleyen mekanizma"dır. Üç dilde bunu kurmak
üç ayrı yükleme mekanizması, üç ayrı güvenlik yüzeyi ve üç ayrı sürümleme derdi
demektir — ders değeri düşük, bakım maliyeti yüksek.

> 🎤 **Anlatım notu:** Salona sorun: *"Takvimi Google yerine Outlook'tan okumak
> istiyorum. Kaç satır kod değişmeli?"* Doğru cevap sıfırdır: `CALENDAR_PROVIDER=graph`.
> Peki bu bir plugin sistemi midir? Bu bölüm "evet, sözleşmesi yazılırsa" der.

Bu projedeki tanım:

> **Plugin = konfigürasyonla seçilen bir adaptör (yerleşik) ya da paketlenmiş
> bir yüzey tanımı (paket) + bunu belgeleyen bir manifest.**

| Cins | Nerede yaşar | Nasıl etkinleşir | Örnek |
|---|---|---|---|
| **Yerleşik** | Üç sunucunun fabrika dikişlerinde | `secimAnahtari` env'i | `google-calendar`, `msgraph-calendar`, `ics-calendar` |
| **Paket** | `plugins/<ad>/` dizinindeki artefaktlarda | Artefakt dış sisteme verilerek | `copilot-studio` |

Fabrikalar zaten vardı (`calendar/index.ts` → `CalendarFactory` deseni, adaptör
seçimi). Bu bölümün eklediği şey kod değil **sözleşme**: her plugin bir
`manifest.json` taşır, `scripts/validate-plugins.mjs` bunu CI'da zorlar:

- `ad` dizin adıyla birebir aynı mı
- `dokuman` diskte var mı
- `gerektirdigiEnv` anahtarlarının HEPSİ `.env.example`'da belgeli mi
- `yerlesik: true` ise `secimAnahtari` var mı (env ile seçilemeyen yerleşik
  plugin etkinleştirilemez — ölü manifest'tir)
- `artefaktlar` diskte var mı

Steps/adimlar dosyalarından öğrenilen kural burada da geçerli: **editörde
kırmızı çizgi yoksa CI çizsin.** Yanlış env adı yazan manifest, plugin'i
sessizce kullanılamaz kılar; sessiz hata en kötü hata sınıfıdır.

Dördüncü çeyrek: **sunucunun kendisi de takılabilir parçadır.**
`verify-contract.mjs --exec "<komut>"` ve sihirbazın `--exec` bayrağı, sözleşmeyi
implemente eden HERHANGİ bir MCP sunucusunu aynı 14 adımdan geçirir.

## Copilot Studio: chatbot yüzeyi Microsoft'ta, iş mantığı bizde

İster listesinde "chatbot" var ama bu repo bilinçli olarak UI yazmaz.
Copilot Studio tam bu boşluğu doldurur: Microsoft'un agent platformu MCP
sunucularını **tool** olarak bağlar — tool listesini kendisi keşfeder,
orkestrasyonu kendi LLM'i yapar, sohbet arayüzü Teams/web'de hazırdır.

```
Kullanıcı ⇄ Copilot Studio agent'ı ⇄ [X-MCP-Api-Key] ⇄ MCP sunucumuz ⇄ [Bearer PAT] ⇄ Xurrent
```

İki güvenlik kararı:

1. **Xurrent PAT'i sunucuda kalır.** Copilot Studio Xurrent kimliği görmez;
   yalnızca MCP sunucusunun kapı anahtarını (`MCP_API_KEY` ↔ `X-MCP-Api-Key`
   başlığı) taşır. Anahtar boşsa sunucu yalnız loopback dinler — tunnel açmadan
   önceki varsayılan duruş korunur.
2. **Onay akışı LLM'e bırakılmaz** (docs/03'teki karar burada da geçerli).
   Copilot Studio'nun elicitation desteği ölçülene kadar onay,
   `timesheet_wizard`'ın yapılandırılmış `next_question` alanıyla yürür —
   sunucu-güdümlü, atlatılamaz.

### Neden `/mcp/v1` — güncel spec dururken eski çağ?

Copilot Studio bugün **oturumlu** Streamable HTTP konuşur: `initialize` el
sıkışması + `Mcp-Session-Id`. Güncel `2026-07-28` revizyonu oturumları kaldırdı
(docs/09). İki dünya arasında köprü, çift-çağ mimarisinin ta kendisidir:

| İstemci | Uç | Çağ |
|---|---|---|
| Claude Code (stdio) | stdio | `2026-07-28` |
| Copilot Studio | `/mcp/v1` | `2025-11-25`, oturumlu |
| Herhangi bir modern host | `/mcp/v2` | `2026-07-28`, stateless |

> 🎤 **Anlatım notu:** Bu tablo, docs/09'da "neden iki çağı da tutuyoruz?"
> sorusunun cevabıdır. Spec ilerledi ama ekosistem eşzamanlı ilerlemez; çift çağ
> bir nostalji değil, **entegrasyon gerçeğidir**. Tahtaya: *"sözleşme değişmez,
> çağ bir adaptördür."*

### Konektör: üretilen YAML

Power Platform custom connector'ı swagger 2.0 ister; kritik satır:

```yaml
x-ms-agentic-protocol: mcp-streamable-1.0
```

Bu işaretle Copilot Studio endpoint'i REST operasyonu değil **MCP sunucusu**
olarak ele alır ve `tools/list`'i kendisi çağırır. YAML elle yazılmaz —
`scripts/gen-connector.mjs` üretir (host her demoda değişir; elle düzenlenen
YAML, prompt defteri gibi sessizce eskirdi). Taahhütlü kopya yer tutucu host
taşır; `--kontrol` CI'da senkronu denetler (`konektor` adımı).

### Kurulum yürüyüşü

Adım adım: [`plugins/copilot-studio/README.md`](../plugins/copilot-studio/README.md).
Özet: HTTP modunda sunucu (`MCP_API_KEY` dolu) → `devtunnel host -p 8788` →
`gen-connector.mjs --host <tunnel>` → Copilot Studio'da MCP onboarding sihirbazı
(Server URL `/mcp/v1`, auth: API key, header `X-MCP-Api-Key`) → Tools listesinde
sunucunun tool'ları.

CI neyi denetler, neyi DENETLEYEMEZ:

| Denetlenen (CI) | Denetlenemeyen (tenant ister) |
|---|---|
| YAML ↔ üretici senkronu | Gerçek keşif + tool çağrısı davranışı |
| `/mcp/v1` oturumlu el sıkışma smoke testi | Elicitation desteğinin olup olmadığı |
| Plugin manifest sözleşmesi | |
| **Sürüm müzakeresi (D18 ✅):** `/mcp/v1` dört aday öneriyle ölçüldü — `2024-11-05`/`2025-03-26`/`2025-06-18`/`2025-11-25` önerilerinin DÖRDÜNDE de üç sunucu `200 + Mcp-Session-Id` veriyor (TS/Py öneriyi aynen kabul eder, C# spec kuralınca `2025-11-25` önerir). Copilot hangi sürümü önerirse önersin uç uyumludur | |

## Yeni plugin eklemek (özet)

1. `plugins/<ad>/manifest.json` (`ad` = dizin adı)
2. Env anahtarlarını `.env.example`'a belgeleyerek ekle
3. Yerleşikse üç dile adaptör (docs/06 deseni), paketse artefaktlar
4. `node scripts/validate-plugins.mjs` yeşilse bitti

> 🎤 **Anlatım notu:** Kapanış vurgusu: bu bölümde tek satır "plugin framework"
> kodu yazılmadı. Yazılan şey bir ŞEMA, bir DOĞRULAYICI ve bir ÜRETİCİ — yani
> sözleşme. Projenin genel tezinin ("asıl beceri doğru sözleşmeyi tarif etmek")
> mimariye uygulanmış hâli.
