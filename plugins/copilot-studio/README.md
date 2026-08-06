# Copilot Studio plugin'i

> **Ne yapar:** Xurrent MCP sunucusunu Microsoft Copilot Studio'ya bir "tool"
> olarak bağlar. Copilot Studio'daki bir agent, sunucunun tool'larını
> (`xurrent_list_open_work`, `xurrent_create_time_entry`, …) otomatik keşfeder ve
> sohbet içinde çağırır — yani chatbot yüzeyi Microsoft tarafında, iş mantığı
> bizim MCP sunucumuzda yaşar. Kendi UI'ımızı yazmadan chat, tam olarak budur.

## Neden `/mcp/v1` (2025-11-25) — güncel spec değil?

Copilot Studio bugün **oturumlu Streamable HTTP** konuşur: `initialize` el
sıkışması yapar ve `Mcp-Session-Id` bekler. MCP'nin güncel `2026-07-28` revizyonu
ise oturumları KALDIRDI (bkz. [docs/09](../../docs/09-protokol-gecisi.md)).
Çift-çağ mimarisi tam bu an içindir: aynı çekirdek, `/mcp/v1`'de oturumlu eski
çağı, `/mcp/v2`'de stateless yeni çağı servis eder. Copilot Studio `/mcp/v1`'e
bağlanır; Claude Code `/mcp/v2` ya da stdio kullanır. **Sözleşme değişmez.**

> ✅ Copilot Studio'nun `initialize`'da hangi sürümü önerdiği tenant'ta görülür —
> ama **etkisizdir**: `/mcp/v1` ucu dört aday öneriyle ölçüldü (`2024-11-05` →
> `2025-11-25`) ve dördünde de `200 + Mcp-Session-Id` döndü (D18, docs/08).
> Müzakere standart MCP istemci davranışıdır.

## Güvenlik modeli

```
Copilot Studio ──X-MCP-Api-Key──▶ MCP sunucusu (HTTPS tunnel) ──Bearer PAT──▶ Xurrent
```

- **Xurrent PAT'i sunucuda kalır** (`.env` → `XURRENT_TOKEN`). Copilot Studio
  Xurrent kimliği GÖRMEZ.
- Copilot Studio yalnızca **MCP API anahtarını** taşır (`MCP_API_KEY` env'i ile
  eşleşen `X-MCP-Api-Key` başlığı). Anahtar boşsa sunucu yalnızca loopback'ten
  istek kabul eder — repo'nun varsayılan güvenlik duruşu korunur.
- Konektör YAML'ındaki `securityDefinitions.api_key` bu başlığı Copilot Studio'nun
  bağlantı ekranında sorulan bir alana çevirir.

## Kurulum yürüyüşü (demo)

### 0. Ön koşul: sunucuyu HTTP modunda başlat

```bash
cd servers/typescript && MCP_PROTOCOL=both MCP_API_KEY=gizli-anahtar npm run http
```

(Python: `uv run xurrent-mcp --http` · C#: `dotnet run -- http`. Üçü de aynı
yolları servis eder; ders gereği hangisini seçtiğiniz fark etmez.)

### 1. HTTPS tunnel aç

Copilot Studio yalnızca **public HTTPS** uca bağlanabilir. Microsoft'un kendi
aracı [dev tunnels](https://learn.microsoft.com/azure/developer/dev-tunnels/):

```bash
devtunnel user login
devtunnel host -p 8788 --allow-anonymous
```

Çıktıdaki `https://<tunnel-id>.devtunnels.ms` adresinin host kısmını not al.
(ngrok/cloudflared da çalışır; fark etmez — HTTPS host'u olan her şey olur.)

> Not: `--allow-anonymous` tuneli herkese açar; kapı artık `MCP_API_KEY`'dir.
> Anahtarsız tunnel açmayın.

### 2. Konektör YAML'ını kendi host'unla üret

```bash
node scripts/gen-connector.mjs --host <tunnel-id>.devtunnels.ms
```

Bu, `plugins/copilot-studio/connector.yaml` dosyasını günceller. Taahhüt edilen
sürüm yer tutucu host taşır; gerçek tunnel adresi commit'lenmez.

### 3. Copilot Studio'da bağla — iki yol

**Yol 1 — MCP onboarding sihirbazı (önerilen):** Copilot Studio → Agent →
**Tools → Add a tool → New tool → Model Context Protocol**. Server URL:
`https://<tunnel-id>.devtunnels.ms/mcp/v1` · Authentication: **API key**,
tip **Header**, ad `X-MCP-Api-Key`. Create → bağlantı oluştururken anahtarı gir
(`gizli-anahtar`).

**Yol 2 — Custom connector (YAML ile):** Power Apps → Custom connectors →
**Import an OpenAPI file** → `connector.yaml`. `x-ms-agentic-protocol:
mcp-streamable-1.0` alanı sayesinde Copilot Studio konektörü MCP sunucusu olarak
tanır ve tool'ları keşfeder.

### 4. Doğrula

Agent'ın Tools listesinde sunucunun tool'ları görünmelidir. Test sohbeti:

> *"Üzerimdeki açık işleri listele"* → `xurrent_list_open_work` çağrılır
> *"Dün VPN işine 2 saat harcadım, kaydet"* → context + dry-run + onay + yazım

Copilot Studio elicitation desteklemiyorsa onay akışı `timesheet_wizard`
tool'unun yapılandırılmış `next_question` alanıyla yürür (bkz. docs/17).

## CI'da ne denetlenir

Gerçek tenant CI'da yoktur; denetlenebilir olan iki şey denetlenir:

1. `node scripts/gen-connector.mjs --kontrol` — taahhütlü YAML üreticiyle senkron mu
2. Oturumlu el sıkışma smoke testi — `/mcp/v1`'e `initialize` POST'u
   `Mcp-Session-Id` başlığı döndürüyor mu (bkz. `scripts/test-all.mjs`)

Tenant gerektiren adımlar (3–4) `DOĞRULANMALI` listesindedir ve elle koşulur.
