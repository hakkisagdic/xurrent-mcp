# clients/web — backend sözleşmesi

`clients/web/` altındaki dosyalar **statiktir ve dile bağımlı değildir**. TypeScript, Python
ve C# backend'leri aynı dosyaları servis eder ve aşağıdaki **dört uç noktayı birebir aynı
şekilde** implemente eder. Arayüzün hangi dilin arkasında çalıştığını bilmesine gerek yoktur —
bu, `contract/tools.json`'un web katmanındaki karşılığıdır.

> **Neden ayrı bir sözleşme dosyası?** Aynı HTML/JS üç backend'e de takılacaksa, uçların
> adı/şekli üç kez tahmin edilemez. Bu dosya tek gerçek kaynaktır; uyuşmazlık varsa hata
> backend'dedir.

---

## 0. Statik dosyalar

| Yol | İçerik |
|---|---|
| `GET /` | `clients/web/index.html` |
| `GET /style.css` | `clients/web/style.css` |
| `GET /app.js` | `clients/web/app.js` |

`Content-Type` doğru gönderilmelidir (`text/html; charset=utf-8`, `text/css; charset=utf-8`,
`text/javascript; charset=utf-8`). Başka statik dosya yoktur; **CDN yoktur, harici font yoktur**.

Dinlenen port: `WEB_PORT` (varsayılan `8787`).

---

## 1. `GET /api/config`

Arayüz açılışta bir kez çağırır. Sol paneldeki rozetleri doldurur.

**Yanıt** `200 application/json`

```jsonc
{
  "mode": "mock",                    // "mock" | "live"        — XURRENT_MODE
  "strategy": "two_step",            // "two_step" | "link_first" | "date_first"
  "calendarProvider": "mock",        // "mock" | "ics" | "google" | "graph" | "auto"
  "model": "claude-opus-5",          // ANTHROPIC_MODEL
  "hasApiKey": true,                 // ANTHROPIC_API_KEY dolu mu

  // --- aşağıdakiler İSTEĞE BAĞLIDIR; yoksa arayüz sessizce gizler ---
  "language": "typescript",          // "typescript" | "python" | "csharp" — rozet olarak gösterilir
  "dryRunForced": false,             // XURRENT_DRY_RUN=1 ise true; arayüz kalıcı uyarı gösterir
  "timeZone": "Europe/Istanbul",
  "maxBackdateDays": 1,
  "toolCount": 8
}
```

`hasApiKey: false` ise arayüz yazma alanını kilitler ve `.env` içine `ANTHROPIC_API_KEY`
eklenmesi gerektiğini söyleyen Türkçe bir uyarı gösterir.

---

## 2. `POST /api/chat`

Sohbetin tamamı **her istekte yeniden gönderilir**; backend oturum durumu tutmaz
(elicitation bekleyen istekler hariç, bkz. §3).

**İstek** `application/json`

```jsonc
{
  "messages": [
    { "role": "user", "content": "bugünkü toplantılarımı yaz" },
    { "role": "assistant", "content": [ /* backend'in döndürdüğü bloklar, aynen */ ] },
    { "role": "user", "content": "evet, onaylıyorum" }
  ]
}
```

**`messages` dizisi ARAYÜZ TARAFINDAN YORUMLANMAZ.** Arayüz, en son `done` olayında gelen
`messages` değerini olduğu gibi saklar ve bir sonraki istekte aynen geri gönderir. Böylece
Anthropic'in `tool_use` / `tool_result` blok biçimi arayüze sızmaz ve üç backend kendi SDK'sının
doğal biçimini kullanabilir.

**Yanıt** `200 text/event-stream`

Zorunlu başlıklar:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

> **Not:** `EventSource` yalnızca GET destekler. Bu yüzden arayüz `fetch()` + `ReadableStream`
> ile SSE'yi kendisi ayrıştırır. Backend açısından fark yoktur: standart SSE çerçevesi
> (`event:` + `data:` + boş satır) gönderilir.

### Olay türleri

Her çerçeve `event: <tür>` ve tek satırlık `data: <json>` içerir. `data` **tek satır** olmalıdır
(JSON içindeki satır sonları `\n` olarak kaçırılır).

#### `text` — model metni (parça parça)

```jsonc
{ "delta": "Bugün 5 gerçek toplantın var" }
```

#### `tool_use` — model bir tool çağırıyor

```jsonc
{
  "id": "toolu_01ABC",                    // aynı id tool_result'ta tekrar eder
  "name": "xurrent_list_open_work",
  "args": { "personId": "$me" }
}
```

#### `tool_result` — tool çalıştı

```jsonc
{
  "id": "toolu_01ABC",
  "name": "xurrent_list_open_work",
  "isError": false,
  "durationMs": 42,
  "summary": "3 açık talep, 3 açık görev",  // Türkçe, tek satır; arayüz kartın başlığında gösterir
  "result": { /* tool'un yapılandırılmış çıktısı, aynen */ }
}
```

`summary` **backend tarafından üretilir** (arayüz tool semantiğini bilmez). Üretilemiyorsa
`null` gönderilir; arayüz o zaman yalnızca ham JSON'u gösterir.

`result` içinde `dryRun: true` ve `planned[]` varsa arayüz **özel dry-run görünümüne** geçer:
planlanan mutation'lar ve `warnings[]` kartın gövdesinde belirgin şekilde listelenir.
Bu, `contract/tools.json` içindeki `WriteResult` / `PlannedMutation` şekliyle aynıdır.

#### `elicit` — kullanıcı onayı gerekiyor

Backend akışı **duraklatır** ve `POST /api/elicit` bekler.

```jsonc
{
  "id": "el_1",                            // /api/elicit'e aynen geri gönderilir
  "message": "Request #70248 kaydına 120 dakika yazılacak. Onaylıyor musun?",
  "kind": "confirm",                       // şimdilik tek değer
  "confirmLabel": "Onayla",                // isteğe bağlı
  "cancelLabel": "İptal",                  // isteğe bağlı
  "details": {                             // isteğe bağlı; arayüz anahtar/değer tablosu çizer
    "Hedef": "Request #70248 — Raporlama ekranı yavaş",
    "Süre": "120 dakika",
    "Tarih": "2026-08-01 (dün)",
    "Strateji": "two_step (2 mutation, atomik değil)"
  },
  "schema": { /* MCP requestedSchema, aynen; arayüz göstermez ama saklar */ }
}
```

#### `done` — tur bitti

```jsonc
{
  "stopReason": "end_turn",
  "messages": [ /* GÜNCELLENMİŞ tam sohbet; arayüz bunu saklar */ ],
  "usage": { "inputTokens": 1234, "outputTokens": 567 }   // isteğe bağlı
}
```

`done` geldikten sonra backend akışı kapatır.

#### `error` — kurtarılamaz hata

```jsonc
{ "message": "Xurrent GraphQL 401: token geçersiz.", "code": "xurrent_auth" }
```

Arayüz hatayı sohbette kırmızı bir kart olarak gösterir ve yazma alanını yeniden açar.
`error` sonrası `done` **gönderilmez**.

### Sıralama kuralları

1. Bir tur birden çok `text` / `tool_use` / `tool_result` / `elicit` içerebilir.
2. Her `tool_use` için **mutlaka** aynı `id` ile bir `tool_result` gelir (hata olsa bile,
   `isError: true` ile).
3. `elicit` yalnızca yazma tool'larından önce çıkar; yanıt gelmeden akış ilerlemez.
4. Akış **her zaman** ya `done` ya `error` ile biter.
5. İstemci bağlantıyı kaparsa backend akışı iptal eder ve bekleyen elicitation'ı
   **reddedilmiş** sayar (fail-closed).

---

## 3. `POST /api/elicit`

`elicit` olayına verilen yanıt. Ayrı bir istektir çünkü SSE tek yönlüdür.

**İstek**

```jsonc
{ "id": "el_1", "accept": true }
```

**Yanıt** `200 application/json`

```jsonc
{ "ok": true }
```

Hatalar:

| Durum | Kod | Gövde |
|---|---|---|
| `id` bulunamadı / süresi doldu | `404` | `{ "ok": false, "error": "Onay isteği bulunamadı veya zaman aşımına uğradı." }` |
| Gövde hatalı | `400` | `{ "ok": false, "error": "..." }` |

**Zaman aşımı:** backend bekleyen bir elicitation'ı **120 saniye** sonra otomatik olarak
**reddeder** (`accept: false`) ve akışa devam eder. Varsayılan güvenlidir: cevapsızlık onay
değildir (`XURRENT_CONFIRM_POLICY=closed` ile aynı ilke).

---

## 4. Backend tarafında dikkat edilecekler

- **Elicitation MCP üzerinden gelir.** Web backend'i aynı zamanda bir MCP *client*'ıdır;
  sunucudan gelen `elicitation/create` isteğini `elicit` SSE olayına çevirir, `/api/elicit`
  yanıtını da MCP yanıtına (`accept` / `decline`) çevirir. Onay diyaloğu **LLM'e bırakılmaz**.
- **Sırlar asla yanıtta yer almaz.** `/api/config` yalnızca `hasApiKey: boolean` döner;
  anahtarın kendisi, Xurrent token'ı ve takvim kimlik bilgileri hiçbir uca sızmaz.
- **SSE tamponlanmamalıdır.** Ters vekil (nginx vb.) arkasında `X-Accel-Buffering: no`
  gönderilmezse metin akışı parça parça görünmez, tur bitince topluca düşer.
- **`data:` tek satırdır.** JSON'u serileştirirken satır sonu bırakılırsa SSE çerçevesi bozulur
  ve arayüz olayı sessizce kaçırır.
- **Aynı `id` disiplini.** `tool_use.id` ile `tool_result.id` eşleşmezse arayüz kartı
  tamamlayamaz ve "çalışıyor" durumunda asılı kalır.

---

## 5. Hızlı elle test

```bash
curl -s localhost:8787/api/config | jq

curl -N -X POST localhost:8787/api/chat \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"açık işlerimi listele"}]}'

curl -s -X POST localhost:8787/api/elicit \
  -H 'content-type: application/json' \
  -d '{"id":"el_1","accept":true}'
```
