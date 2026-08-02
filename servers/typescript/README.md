# servers/typescript

Xurrent MCP sunucusunun **TypeScript** implementasyonu. `contract/tools.json`'daki 8 tool'u
birebir sunar; `fixtures/` klasöründeki veriyi okur ve Python/C# sunucularıyla **aynı sayıları** üretir.

**İki protokol revizyonunu birden konuşur** — `2025-11-25` (v1) ve `2026-07-28` (v2).
Ayrıntı: [`contract/protocol.md`](../../contract/protocol.md)

## Kurulum

```bash
npm install && npm run build
```

Hiçbir token gerekmez — varsayılan **mock** moddur.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm run build` | `src/` → `dist/` |
| `npm run dev` | izleme modunda derleme |
| `npm start` | MCP **stdio** sunucusu (`.mcp.json` bunu bekler: `dist/mcp/stdio.js`) |
| `npm run http` | MCP **Streamable HTTP** sunucusu (`MCP_HTTP_PORT`, varsayılan 8788) |
| `npm run chat` | terminal chatbot (`ANTHROPIC_API_KEY` gerekir) |
| `npm run web` | web arayüzü (`WEB_PORT`, varsayılan 8787) — `clients/web` servis edilir |
| `npm run wizard` | `docs/wizard/steps.json` dersini in-process yürütür ve beklenen sayıları doğrular |
| `npm run gen:ics` | `fixtures/calendar.json` → `fixtures/calendar.ics` (o günkü tarihlere göre) |
| `npm run verify` | gerçek bir MCP client ile `tools/list` çekip `contract/tools.json`'a karşı doğrular |
| `npm run probe:protocols` | 8 tool'u İKİ protokolde çalıştırıp `structuredContent`'lerin özdeşliğini kanıtlar |
| `npm run probe:state` | `requestState` kurcalama/replay testleri (ham JSON-RPC ile) |

## Çift protokol

`MCP_PROTOCOL` ortam değişkeni hangi revizyonun **advertise** edileceğini seçer:

| Değer | stdio | HTTP |
|---|---|---|
| `2026-07-28` | **varsayılan** — v2 adaptörü | `/mcp/v2` (ve `/mcp`) |
| `2025-11-25` | v1 adaptörü | `/mcp/v1` (ve `/mcp`) |
| `both` | **GEÇERSİZ** — net bir Türkçe hata verip çıkar (exit 2) | `/mcp/v1` **ve** `/mcp/v2` birlikte |

`both` stdio'da neden geçersiz: stdio tek bir çift yönlü borudur; iki revizyonu aynı boruda
ayrıştıracak bir yol adresi yoktur. HTTP'de `path` bunu doğal olarak çözer.

### Geriye dönük uyumluluk

v2 adaptörü eski client'lara da cevap verir (`serveStdio` varsayılanı `legacy: 'serve'`):
düz bir `initialize` gelirse bağlantı 2025-era'ya sabitlenir ve SDK'nın *legacy shim*'i
`input_required` sonucunu sunucu-başlatmalı `elicitation/create` isteğine çevirir.
Yani **tek bir handler iki era'ya birden hizmet eder** — bu ölçülmüştür, varsayım değildir.

### Onay: aynı çekirdek, iki kabuk

```
                    ┌─ mcp/v1 ─→ elicitation/create   (sunucu İSTEK gönderir)
core/toolimpl ──────┤
  { kind:"confirm" }└─ mcp/v2 ─→ InputRequiredResult  (sunucu SONUÇ döner)
```

`core/toolimpl.ts` onayın **nasıl** sorulacağını bilmez. 28 Temmuz 2026 revizyonu onay akışını
tamamen değiştirdi; bu dosyada tek satır değişmedi.

### `requestState` bir güvenlik sınırıdır

v2'de sunucu state tutmaz: "kullanıcı şu işlemi onayladı" bilgisi client üzerinden geri gelir ve
spec bunu açıkça **saldırgan kontrolündeki girdi** sayar. `src/core/confirm.ts` bu blob'u
**HMAC-SHA256** ile imzalar ve içine dört şey gömer:

| Alan | Neyi engeller |
|---|---|
| `principal` | çapraz kullanıcı kullanımı |
| `exp` | replay penceresi (`XURRENT_STATE_TTL`, varsayılan 300 sn) |
| `fingerprint` | onaylanan çağrıdan **farklı** bir çağrıya iliştirme (metod + argüman SHA-256'sı) |
| `nonce` | tekrar oynatma — süreç içi tek kullanımlık set |

Doğrulama **fail-closed**'dır: başarısızlıkta yazma yapılmaz, `isError: true` + Türkçe açıklama döner.
Blob **imzalıdır, şifreli değildir** — client içeriği okuyabilir, o yüzden içine sır konmaz.

> `XURRENT_STATE_SECRET` boş bırakılırsa anahtar süreç başında **rastgele** üretilir. Sunucu
> yeniden başladığında bekleyen onaylar geçersiz olur — bu bir kusur değil, **istenen davranıştır**.

## Dosya haritası

```
src/config.ts               env okuma + zod doğrulama (.env parser dahil, dotenv yok)
src/types.ts                sözleşme tipleri
src/util/time.ts            IANA saat dilimi aritmetiği (Intl ile; luxon yok)
src/util/log.ts             TÜM loglar stderr'e — stdio'da stdout sadece JSON-RPC içindir

src/core/                   ★ PROTOKOLDEN BAĞIMSIZ ÇEKİRDEK
  toolimpl.ts               8 tool'un SAF hâli + TOOL_SPECS + runToolCore → ToolOutcome
  confirm.ts                requestState HMAC imzalama/doğrulama (principal, exp, fingerprint, nonce)
  context.ts                ToolContext + onay politikası (mock/live ayrımı)
  schemas.ts                zod girdi/çıktı şemaları — 8/8 tool outputSchema beyan eder
  result.ts                 ToolResult yardımcıları (structuredContent + Türkçe metin)

src/mcp/shared.ts           iki adaptörün paylaştığı serverInfo/instructions/cache ipuçları
src/mcp/v1/server.ts        2025-11-25 adaptörü — @modelcontextprotocol/sdk@1.30.0 + elicitation
src/mcp/v2/server.ts        2026-07-28 adaptörü — @modelcontextprotocol/server@2.0.0 + MRTR
src/mcp/protocols.ts        sihirbaz kancası: AVAILABLE_PROTOCOLS + runUnderProtocol
src/mcp/{stdio,http}.ts     MCP_PROTOCOL'e göre v1/v2/both

src/xurrent/queries.ts      GraphQL metinleri (dry-run çıktısında birebir gösterilir)
src/xurrent/strategies.ts   ★ üç backdate stratejisi
src/xurrent/validate.ts     ön kontroller → errors[] (bloklayan) + warnings[] (bilgilendiren)
src/xurrent/mock.ts         fixtures adapter — Yol A/Yol B kısıtlarını da taklit eder
src/xurrent/live.ts         gerçek GraphQL adapter
src/calendar/*              mock / ics / google / graph + ortak normalizasyon
src/tools/*                 8 ince sarmalayıcı — iş mantığı core/toolimpl.ts'te
src/agent/{core,cli,web}.ts chatbot çekirdeği + terminal + web (clients/web/API.md sözleşmesi)
src/wizard.ts               ders akışını yürüten sihirbaz (in-process)
scripts/probe-*.mjs         protokol özdeşliği ve requestState güvenlik sondaları
```

## Ortam değişkenleri (bu faz eklenenler)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `MCP_PROTOCOL` | `2026-07-28` | `2026-07-28` \| `2025-11-25` \| `both` |
| `XURRENT_CONFIRM_POLICY` | `closed` | `closed` = onay sorulur; **kanal yoksa** live'da RED, mock'ta uyarıyla devam · `open` = onay **hiç** sorulmaz (yalnızca CI) · `strict` = onay **mock modda da zorunlu**; kanal yoksa mock'ta bile RED |
| `XURRENT_STATE_SECRET` | *(boş)* | `requestState` HMAC anahtarı. Boşsa süreç başında rastgele üretilir. |
| `XURRENT_STATE_TTL` | `300` | `requestState` geçerlilik süresi (saniye) |

### `XURRENT_CONFIRM_POLICY` — üç değer, tek tablo

Karar iki parçaya bölünmüştür ve ikisi de `src/core/context.ts` içindedir:
`requiresConfirmation()` **soru sorulacak mı**, `resolveUnsupportedConfirm()`
**soru sorulamıyorsa ne olur** sorusunu cevaplar.

| | onay sorulur mu? | client soramıyorsa (mock) | client soramıyorsa (live) |
|---|---|---|---|
| `closed` *(varsayılan)* | evet | uyarı + **yazılır** | **RED** |
| `open` | **hayır** | yazılır (uyarı) | yazılır (uyarı) |
| `strict` | evet | **RED** | **RED** |

`dryRun=true` veya `XURRENT_DRY_RUN=1` iken onay **hiçbir politikada** sorulmaz —
ortada gönderilecek mutation yoktur, onay istemek güvenlik değil gürültüdür.

`strict` bir **ders/gösterim** ayarıdır: onay akışını (v2'de `input_required` →
kullanıcıya sor → isteği **yeni id** ile tekrarla → yaz) mock modda uçtan uca,
hiçbir gevşeme olmadan göstermek için vardır.

```bash
XURRENT_CONFIRM_POLICY=strict npm run probe:state          # ham JSON-RPC ile MRTR turu
XURRENT_CONFIRM_POLICY=strict node ../../clients/wizard/wizard.mjs --server ts --step 11
```

## Üç dilde ortak kurallar

Bu implementasyon aşağıdaki kuralları Python ve C# ile **birebir aynı** uygular:

- 8/8 tool `outputSchema` beyan eder ve `tools/call` cevabında `structuredContent` döner —
  yanı sıra **her zaman** okunabilir bir Türkçe `text` bloğu da yayınlanır.
- Sihirbaz adım sonucu **üç durumludur**: PASS / FAIL / **SKIP**. Ön koşulu sağlanmadığı için
  çalıştırılamayan bir kontrol SKIP'tir, FAIL değil. Özet: `"N geçti, M başarısız, K atlandı"`.
- Mock modda `xurrent_whoami.rateLimit` **her zaman `null`**'dır. Uydurma bir sayaç (ya da
  gerçek epoch taşıyan bir `resetAt`) çıktıyı deterministik olmaktan çıkarır.
- Mock modda `XURRENT_CONFIRM_POLICY=closed` + `dryRun=false` iken yazma **engellenmez**;
  fail-closed yalnızca **live** modda uygulanır (bkz. `src/core/context.ts`).
  Bu gevşemeyi kapatan değer `strict`'tir: onay kanalı yoksa **mock modda da** yazma reddedilir.
- `XURRENT_CONFIRM_POLICY` üç değer tanır — `closed` (varsayılan), `open`, `strict` —
  ve tanınmayan bir değer sessizce `closed`'a düşerken **stderr'e uyarı** basılır.
- `plan_time_entries_from_calendar` yedek hedef zinciri:
  `defaultTargetId` argümanı → `DEFAULT_TIME_ALLOCATION_ID` → hesaptaki **ilk** TimeAllocation.
