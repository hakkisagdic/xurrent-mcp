# 18 — CLI: `xmcp` ve terminalden sohbet

> **Bölüm hedefi:** "İstemci de dilden bağımsızdır" tezinin dördüncü kanıtını
> vermek — tek bir CLI istemcisi, üç sunucuya, iki protokol çağıyla, ham
> JSON-RPC konuşarak bağlanır; ve `timesheet_wizard` sayesinde terminalde
> LLM'siz bir chatbot deneyimi sunar.

| ← Önceki | Sonraki → |
|---|---|
| [17 — Plugin ve Copilot Studio](17-plugin-ve-copilot.md) | [19 — Dağıtım](19-dagitim.md) |

Kod: [`clients/cli/`](../clients/cli/) · Ayrıntılı kullanım: [`clients/cli/README.md`](../clients/cli/README.md)

---

## Neden bir CLI daha?

Repoda zaten dört istemci var (sihirbaz, atölye, inspector, web chat). `xmcp`
onların yapmadığı üç şeyi yapar:

1. **Ham JSON-RPC, iki çağ birden.** Sihirbaz resmî SDK kullanır; `xmcp`
   protokolü elle konuşur — `server/discover` dener, `-32601` görürse
   `initialize`'a düşer (`-32602` görürse DÜŞMEZ: o istemci hatasıdır).
   Öğrenci `--era 2025|2026` ile aynı tool'u iki zarfla çağırıp farkı görür.
2. **Terminalden gerçek sohbet.** `xmcp chat`, `timesheet_wizard`'ı süren bir
   Ink TUI'dir: transcript, ok tuşlarıyla seçim, adım/sunucu/çağ gösteren alt
   bilgi. Host'ta LLM yok — akıl, sunucudaki durum makinesinde.
3. **Testler ve entegrasyonlar için tek kapı.** `xmcp call` betiklerde
   kullanılabilir (`--json`, boş olmayan `errors[]` = exit 1);
   `xmcp conformance` sözleşme + uyum denetimlerini tek komuta bağlar.

## Fiiller

| Komut | Ne yapar |
|---|---|
| `xmcp tools --server ts` | `tools/list` — 10 tool, `ttlMs`/`cacheScope` ile |
| `xmcp call <tool> --args '<json>' [--dry-run]` | `tools/call`; `structuredContent`'i basar; hata = exit 1 |
| `xmcp chat [--script "…"]` | `timesheet_wizard` REPL — TTY'de Ink TUI, TTY yoksa/`--script` ile düz mod |
| `xmcp probe --server cs` | Çağ/yetenek keşfi: `server/discover` + `initialize`, serverInfo, tool sayısı |
| `xmcp conformance` | `verify-contract --all` + `mcp-uyum` sarmalayıcısı |

Ortak bayraklar: `--server ts|py|cs` (varsayılan ts) · `--exec "<komut>"`
(sözleşmeyi implemente eden HERHANGİ bir sunucu — plugin tezinin istemci ayağı) ·
`--era 2026|2025|auto` · `--json` · `--timeout`.

```bash
cd clients/cli && npm install
node xmcp.mjs chat --server py
```

## Terminalden sohbet: 30 saniyelik kanıt

```bash
node xmcp.mjs chat --server ts --script "1
2 saat
dün 14:00 VPN bakımı
two_step
evet"
```

Çıktıda sırasıyla: açık işler listesi → "2 saat → **120 dakika**" çevirisi →
detay özeti → üç stratejinin bedelleriyle seçimi → dry-run planı → yazım +
geri-okuma özeti. Aynı script'i `--server py` ya da `--server cs` ile çalıştırın:
**aynı adımlar, aynı sayılar.** (`--script` hilesi aynı zamanda CI'ın chat'i
başsız test etme yoludur.)

> 🎤 **Anlatım notu:** Burada durup vurgulayın: az önce UI'sız, LLM'siz,
> tarayıcısız bir chatbot kullanıldı. Sohbet yeteneği ürünün değil,
> SÖZLEŞMENİN özelliğiydi (`timesheet_wizard`, docs/wizard sözleşmesi) —
> Copilot Studio'ya bağlanınca da (docs/17) aynı makine konuşacak.

## MRTR ve elicitation: istemci tarafında nasıl görünür?

`xmcp call` bir yazma tool'unu onay gerektiren durumda çağırırsa:

- **2026 çağında** sunucu `resultType: "input_required"` döner; `xmcp` soruyu
  terminalde sorar, cevabı `inputResponses` + AYNEN geri verilen `requestState`
  ile isteği **yeni bir id'yle** tekrarlar (MRTR'nin öğrettiği kural).
- **2025 çağında** sunucu bağlantı üzerinden `elicitation/create` İSTEĞİ
  gönderir; `xmcp` cevabı aynı kanaldan döndürür.

İki akışın da kodu `clients/cli/lib/rpc.mjs`'te yan yana durur — docs/09'daki
tablonun çalışan hâli.

## Sınırlar (dürüst liste)

- Ink TUI yanıt beklerken basılan tuşları biriktirmez (type-ahead yok) —
  soru ekrana gelince yazmak yeterlidir.
- `xmcp` sunucuyu her çağrıda taze başlatır (stdio); uzun oturum isteyen
  kullanım için HTTP transport'a bağlanan bir istemci ödev olarak bırakılmıştır.
- `--exec` dışında yalnız üç bilinen sunucu komutu çalıştırılır (allowlist) —
  inspector'daki güvenlik duruşunun aynısı.
