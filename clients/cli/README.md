# xmcp — bağımsız MCP istemci CLI'ı

> **Ne olduğu:** Ham stdio JSON-RPC konuşan, **çift-era**'lı (2026-07-28 ve
> 2025-11-25) bir MCP **client**'ı + `timesheet_wizard` için Ink TUI'li ince
> sohbet host'u. "İstemci de dilden bağımsızdır" tezinin **dördüncü kanıtı**:
> wizard (SDK'lı Node client), inspector (tarayıcı), Claude Code (`.mcp.json`)
> ve şimdi xmcp (SDK'sız, ham tel). Aynı üç sunucuya bağlanır, aynı sözleşmeyi
> görür.
>
> **Ne olmadığı:** SDK sarmalayıcısı değildir. İki revizyonu tek koddan konuşmak
> dersin kendisidir: v2'nin `_meta` zarfı, `server/discover` sondası, MRTR
> döngüsü ve v1'in `initialize` el sıkışması + sunucu-başlatmalı elicitation'ı
> [lib/rpc.mjs](lib/rpc.mjs) içinde satır satır okunabilir. (Aynı yaklaşım:
> inspector'ın proxy'si ve wizard'ın protokol karşılaştırma bölümü.)

## Kurulum ve çalıştırma

```bash
cd clients/cli && npm install          # yalnızca ink + react (derleme adımı YOK)
node xmcp.mjs tools --server ts        # veya: npx . / npm link → xmcp tools
```

Ink arayüzü JSX'siz, `React.createElement` ile yazılmıştır — node dosyayı
doğrudan çalıştırır, build/transpile gerekmez.

## Fiiller

| Fiil | Ne yapar |
|---|---|
| `tools` | `tools/list` → tablo: isim, tür (annotation özeti), açıklamanın ilk cümlesi. `--json` ham sonucu basar |
| `call <tool>` | `tools/call`; `structuredContent`'i basar. **`errors[]` dolu veya `isError=true` = çıkış 1** (repo kuralı). MRTR/elicitation onayı terminalden sorulur |
| `chat` | `timesheet_wizard`'ı süren **ince host**: reply + nextQuestion gösterilir, cevap `utterance` + `sessionState` (AYNEN, opak) olarak geri gider. TTY'de Ink TUI; boru/`--script`'te düz mod |
| `probe` | Era/yetenek raporu: taze süreçte `server/discover` (_meta İLE) + taze süreçte `initialize` — sunucunun varsayılanının HANGİ era'ları kabul ettiğini gösterir |
| `conformance` | `scripts/verify-contract.mjs --all` + `scripts/mcp-uyum.mjs --hepsi` sarmalayıcısı; biri düşerse çıkış ≠ 0 |

## Bayraklar

| Bayrak | Anlamı |
|---|---|
| `-s, --server ts\|py\|cs` | Spawn edilecek sunucu (varsayılan: ts). Komutlar wizard.mjs/.mcp.json ile birebir aynı ALLOWLIST'tir |
| `--exec "<komut>"` | Üçü DIŞINDA, sözleşmeyi konuşan herhangi bir MCP sunucusu (gelişmiş) |
| `--era 2026\|2025` | Revizyonu sabitler (sunucuya `MCP_PROTOCOL` ile de söylenir — stdio'da tek süreç tek protokol konuşur). Varsayılan **auto**: `server/discover` denenir; `-32601` → `initialize`'a düşülür; `-32602` → İSTEMCİ hatasıdır, düşülMEZ |
| `--timeout <ms>` | İstek başına zaman aşımı (varsayılan 60000; cs 180000) |
| `--json` | STDOUT'a makine-okunur çıktı; insan anlatısı stderr'e |
| `--no-color` | ANSI renklerini kapatır |
| `call --args '<json>'` | Tool argümanları |
| `call --dry-run` | Argümanlara `{"dryRun":true}` ekler — hiçbir mutation gitmez |
| `chat --script "c1\nc2"` | Cevapları satır satır bu metinden okur (aşağıya bakın) |

## Örnekler

```bash
node xmcp.mjs tools --server ts
node xmcp.mjs call xurrent_whoami --server py
node xmcp.mjs call xurrent_whoami --server ts --era 2025      # v1 el sıkışmasıyla
node xmcp.mjs call xurrent_create_time_entry --server ts --dry-run \
  --args '{"targetType":"time_allocation","targetId":"TW9jay9UaW1lQWxsb2NhdGlvbi8x","minutes":30,"description":"deneme"}'
node xmcp.mjs chat --server ts                                 # TTY → Ink TUI
node xmcp.mjs probe --server cs                                # iki era'yı da raporlar
node xmcp.mjs conformance
```

## `--script` hilesi — sohbeti test edilebilir kılan şey

Sohbet TTY'de Ink TUI açar; ama TUI test edilemezlik demek DEĞİLDİR, çünkü
sohbetin beyni istemcide değil sunucudadır. Düz mod aynı döngünün süssüz hâlidir
ve cevapları `--script`'ten (ya da borulanmış stdin'den) okur:

```bash
node xmcp.mjs chat --server ts --script "1
2 saat
dün 14:00 xmcp deneme
two_step
evet"
```

Diyalog `done=true`'ya ulaşır, `writeResult` özeti basılır, çıkış 0. CI tam
olarak bunu koşar; aynı script `--server py`/`--server cs` ile de birebir aynı
adımlardan geçer — çünkü durum makinesi `contract/wizard.md`'nin kendisidir,
host değil.

★ İnce host sözleşmesinin tamamı iki alandır: dönen `reply` + `nextQuestion`
gösterilir, `sessionState` **AYNEN** geri gönderilir. İmzalıdır ve opaktır;
istemci içine bakmaz, bakamaz (`HMAC`, bkz. contract/wizard.md §4).

## Era pazarlığı — sondanın iki tuzağı

1. `server/discover` **_meta İLE** gönderilir. Onsuz Python `-32601`
   (yanıltıcı), C# `-32602` döner ve sonda v2 sunucuyu v1 sanır.
2. `-32602` "metadata eksik" **istemci hatasıdır**: metot VAR demektir. Bu
   durumda v1'e düşülMEZ; xmcp net hata basar. `-32601` ise gerçekten "v1
   sunucu" demektir ve `initialize`'a düşülür. Ayrıntı: `contract/protocol.md`.

`probe` iki sondayı iki TAZE süreçte atar — bağlantı ilk mesajla bir era'ya
sabitlendiği için (ölçülmüş gerçek) aynı süreçte ikisini denemek yanılttır.

## Güvenlik notları

- xmcp yalnızca üç bilinen sunucu komutunu spawn eder (`ts`/`py`/`cs`
  ALLOWLIST'i — wizard.mjs/.mcp.json ile aynı). Keyfi komut yalnızca kullanıcının
  KENDİ verdiği `--exec` ile mümkündür; hiçbir sunucu çıktısı komuta dönüşmez.
- Onay (elicitation/MRTR) istemleri **kullanıcıya** sorulur; TTY yoksa
  fail-closed davranılır (decline). Onay kararı asla otomatik "evet"lenmez.
- `sessionState`/`requestState` imzalı ve opaktır; xmcp bunları değiştirmeden
  geri gönderir — değiştirme girişimini sunucu HMAC ile yakalar.
- stdio disiplini: çocuk sürecin stdout'u SADECE JSON-RPC'dir; sunucu logları
  stderr'de toplanır ve yalnızca hata anında gösterilir.

## Ayrıntı

- Tool sözleşmesi: [contract/tools.json](../../contract/tools.json) ·
  sohbet durum makinesi: [contract/wizard.md](../../contract/wizard.md) ·
  çift era: [contract/protocol.md](../../contract/protocol.md)
- Kardeş istemciler: [clients/wizard](../wizard/) (SDK'lı ders sihirbazı),
  [clients/inspector](../inspector/) (tarayıcıda ham tel)
