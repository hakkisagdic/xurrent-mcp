# `timesheet_wizard` Sözleşmesi — sunucu-güdümlü sohbet durum makinesi

> **Tez:** İnce host'ta (Copilot Studio, düz bir REPL) chatbot olmak için LLM
> gerekmez — deterministik bir durum makinesi + imzalı oturum durumu yeter.
> Bu tool, MCP sunucusunun kendisini "chat yapmaya müsait" kılar: host yalnızca
> kullanıcı cümlesini iletir ve dönen soruyu gösterir. Üç dil BU dosyayı
> birebir implemente eder; sihirbaz adımı üçünde aynı diyaloğu doğrular.

## 1. Tool arayüzü

Girdi (`input`):

| Alan | Tip | Anlam |
|---|---|---|
| `utterance` | string? | Kullanıcının son cümlesi. İlk çağrıda boş olabilir. |
| `sessionState` | string? | Önceki yanıttan aynen geri gönderilen imzalı opak durum. İlk çağrıda yok. |

Çıktı (`output` → `$defs/WizardResult`):

| Alan | Tip | Anlam |
|---|---|---|
| `step` | enum | Bu yanıtı **ÜRETEN** adım (§2 tablosundaki satır). İlk çağrı `"start"` döner; her geçerli cevap makineyi bir satır ilerletir ve yanıt o satırın adıyla döner (örn. iş seçimi cevabı → `"pick_work"` + süre sorusu; süre cevabı → `"duration"` + detay sorusu). Anlaşılmayan cevapta `step` DEĞİŞMEZ. Bozuk/süresi geçmiş state → `"start"` + açıklayan `reply` |
| `reply` | string | Kullanıcıya gösterilecek Türkçe metin |
| `nextQuestion` | object? | Yapılandırılmış soru: `{prompt, choices?: [{id, label, detail?}], expectsFreeText?: bool}` — `done=true` iken yok |
| `sessionState` | string? | YENİ imzalı durum; host bir sonraki çağrıda aynen geri gönderir. `done=true` iken yok |
| `done` | boolean | Akış bitti mi |
| `writeResult` | object? | `write` adımı gerçekleştiyse `$defs/WriteResult` |
| `errors` | array | `$defs/ValidationError` listesi (boş = sorun yok) |

Kurallar:
- Tool `kind: "chat"` sınıfındadır; `annotations`: `readOnlyHint: false`
  (write adımı vardır), `idempotentHint: false`, `openWorldHint: true`.
- **LLM sağlayıcılarına ÇEVRİLMEZ**: Gemini `functionDeclarations` listesine
  girmez (chatbot kendi kendini çağırır döngüsü). `wire-denetimi` bunu doğrular.
- Onay yine protokol seviyesindedir: `write` adımına geçiş MRTR/elicitation
  destekleyen host'ta oradan; desteklemeyen host'ta `confirm` adımının açık
  "evet" cevabıyla olur. `XURRENT_CONFIRM_POLICY=strict` wizard'da da geçerlidir.

## 2. Adımlar ve geçişler

```
start ──► pick_work ──► duration ──► detail ──► strategy ──► confirm ──► write ──► done
             │                                                  ▲
             └── "takvim" ────► calendar_plan ──► calendar_confirm ─┘ (bulk yazım)
```

| Adım | Sunucu ne yapar | Beklenen cevap |
|---|---|---|
| `start` | `whoami` + `get_time_tracking_context`; selamlar, `timeIncrement`'i SÖYLER; açık işleri listeler (`list_open_work`) — id'li numaralı liste + "takvim" seçeneği | seçim |
| `pick_work` | Seçilen işi doğrular, özetler | süre sorusuna geçer |
| `duration` | Süreyi ayrıştırır ("2 saat" → **120 dk** çevirimi AÇIKÇA söylenir), `timeIncrement` katına yuvarlama gerekiyorsa SORAR | süre |
| `detail` | Tarih (bugün/dün/`YYYY-MM-DD`, `XURRENT_MAX_BACKDATE_DAYS` sınırı) + başlangıç saati (`HH:MM`, opsiyonel) + açıklama (≤80) | serbest metin |
| `strategy` | Üç yolu `backdateStrategies.keeps/costs` metinleriyle sunar (`choices`: two_step/link_first/date_first) | seçim |
| `confirm` | `dryRun=true` planı gösterir: planned mutation'lar + uyarılar | evet/hayır |
| `write` | `dryRun=false` yazım + `xurrent_list_time_entries` geri-okuması; sonucu ve `deduped`/uyarıları raporlar | — (`done=true`) |
| `calendar_plan` | `calendar_list_today` + `plan_time_entries_from_calendar`; öneri listesi + toplam dakika | evet/hayır/eleme ("3 hariç") |
| `calendar_confirm` | Bulk dry-run özeti; "bulk atomik DEĞİLDİR" uyarısı | evet/hayır |

Hatalı/anlaşılamayan cevap: adım DEĞİŞMEZ; `reply` neyin beklendiğini yeniden
anlatır, `nextQuestion` aynen tekrar döner. (MRTR'daki "eksikse yeniden sor"
kuralının sohbet karşılığı.)

**Kuyruk etiketleri (normatif — üç implementasyonun ortak seçimi):** strateji
cevabını işleyip dry-run planını + evet/hayır sorusunu taşıyan yanıt
`step="strategy"` döner; "evet" cevabını işleyip YAZAN yanıt `step="write"` +
`done=true` + `writeResult` döner. `"confirm"` etiketi yanıtlarda ÜRETİLMEZ
(enum'da rezervdir; iç durum olarak kullanılabilir). Vazgeçme ("hayır") ya da
ölümcül hata `step="done"` ile kapanır.

## 3. Cevap ayrıştırma kuralları (üç dilde birebir aynı)

| Bağlam | Kabul edilen | Örnek |
|---|---|---|
| `choices` varken | choice `id`'si; 1-bazlı sıra numarası; label'ın küçük-harf tam eşleşmesi | "2", "two_step" |
| süre | `N saat` / `N sa` → N·60 · `N dk` / `N dakika` → N · `N.5 saat` → N·60+30 · çıplak sayı → **dakika** | "2 saat", "90" |
| tarih | `bugün` → T · `dün` → T-1 · `YYYY-MM-DD` | "dün" |
| saat | `HH:MM` (24 saat) | "14:00" |
| onay | evet: `evet`, `onay`, `onaylıyorum`, `tamam`, `e` · hayır: `hayır`, `iptal`, `vazgeç`, `h` | |
| takvim | `takvim`, `toplantı` kelimesi `start`/`pick_work` cevabında | "takvimden al" |
| `detail` (birleşik) | Tek cümleden sırayla ÇIKARILIR: (1) `bugün`/`dün`/`YYYY-MM-DD` deseni → tarih (yoksa **bugün**), (2) `HH:MM` deseni → başlangıç saati (yoksa yok), (3) desenler çıkarıldıktan sonra kalan kırpılmış metin → açıklama (boşsa iş etiketi kullanılır) | "dün 14:00 VPN bakımı" |

Ayrıştırma **Türkçe küçük-harf katlaması** ile yapılır (İ→i, I→ı;
fake-gemini'deki `katla` deseninin aynısı). Sayılar için ondalık virgül de
kabul edilir ("1,5 saat").

## 4. `sessionState` — imzalı oturum durumu

Wire biçimi (requestState codec'iyle aynı aile, ayrı amaç):

```
base64url(payloadJson) + "." + base64url(HMAC_SHA256(XURRENT_STATE_SECRET, payloadJsonBytes))
```

- Doğrulama İMZA ÖNCE yapılır; imzasız/bozuk state = akış `start`'tan başlar ve
  `reply` bunu açıkça söyler (sessiz sıfırlama YOK).
- Payload alanları: `{"v": 1, "kind": "wizard", "step": "...", "exp": <epoch sn>,
  "data": {personId?, targetType?, targetId?, targetLabel?, minutes?, date?,
  startedAt?, description?, strategy?, plannedFingerprint?, calendarDraft?}}`
- `exp`: `XURRENT_WIZARD_TTL` (varsayılan **1800 sn** — çok adımlı sohbet,
  requestState'in 300'ünden uzun). Süresi geçmiş state = nazik yeniden başlama.
- Nonce YOK (state her adımda geri döner, tek-kullanımlık değildir); `write`
  adımının kendisi confirm/MRTR korumasındadır.
- **HMAC, payload byte'ları üzerinde hesaplanır** — kanonikleştirme GEREKMEZ:
  doğrulayan taraf parse etmeden önce byte'ları imzalar. Bu sayede
  **çapraz-dil devir çalışır**: TS'in ürettiği state Python'a verilebilir
  (aynı `XURRENT_STATE_SECRET` ile). Senaryo koşucusu bunu kanıtlar.
- `plannedFingerprint`: `confirm` adımında gösterilen planın sha256 kısaltması;
  `write` adımı fingerprint'i yeniden hesaplayıp EŞLEŞMEZSE yazmaz
  (state'le oynanıp onaylanandan farklı bir şey yazdırma girişimi).

## 5. İnce host / MRTR host farkı

- **İnce host** (Copilot Studio, `xmcp chat`, curl): her yanıt
  `resultType:"complete"` + `nextQuestion` ile döner; host sadece gösterir.
- **MRTR/elicitation host'u**: sunucu `confirm` adımında protokol onayını
  kullanmayı SEÇEBİLİR; sohbet akışı değişmez. v1'de `elicitation/create`,
  v2'de `InputRequiredResult`.

## 6. Doğrulama

- Sihirbaz (`steps.json`) yeni adım: aynı diyalog dizisi üç sunucuda koşulur,
  `reply` metinleri değil **`step`/`done`/yapı** karşılaştırılır (metin dili
  esnek, makine sabittir).
- Çapraz-dil devri: senaryo koşucusu TS'te `duration` adımına kadar gelir,
  `sessionState`'i Python sunucusuna verir, akış kaldığı yerden sürer.
- `wire-denetimi`: `timesheet_wizard` Gemini'ye çevrilen tool listesinde YOK.
