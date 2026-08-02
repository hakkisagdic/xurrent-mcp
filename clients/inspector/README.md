# clients/inspector — uygulama içi MCP Inspector

> Resmî `@modelcontextprotocol/inspector` genel amaçlıdır ve iyidir.
> Bu ekran onun yerine geçmez; onun **bilemeyeceği** şeyleri ekler.

Bağımlılık **yok**, CDN **yok**, derleme adımı **yok**. Node 24 standart kütüphanesi
ve üç statik dosya.

```bash
node clients/inspector/sunucu.mjs --port 5200
# → http://127.0.0.1:5200
```

`--open` eklerseniz tarayıcıyı da açar. `--host` ile dinlenen adres değişir
(varsayılan `127.0.0.1`; değiştirmeden önce aşağıdaki **Güvenlik** başlığını okuyun).

Anlatım ve resmî inspector'la karşılaştırma: [`docs/13-inspector.md`](../../docs/13-inspector.md)

---

## Ne ekliyor?

| # | Bölüm | Resmî inspector'da neden yok |
|---|---|---|
| 1 | **Protokol paneli** — hangi revizyon, *nasıl* anlaşıldı | Resmî istemci `initialize` ile bağlanır; sondanın kendisini göstermez |
| 2 | **Sözleşme karşılaştırması** — `tools/list` vs `contract/tools.json` | Bizim sözleşmemizi bilmez |
| 3 | **`teachingNotes`** | MCP'de böyle bir alan yok; bu repoya ait |
| 4 | **Şemadan üretilmiş form** — tip, enum, `required`, `default`, `pattern`, `maxLength` | Form üretir ama kısıtları ve sözleşme açıklamalarını yan yana koymaz |
| 5 | **Yanıt anatomisi** — her parçanın ne işe yaradığı | JSON'ı gösterir, anlatmaz |
| 6 | **MRTR / onay akışı** — adım adım, `requestState` çözümlü | Akışı çizmez; CLI modu `elicitation` yeteneğini hiç bildirmez |
| 7 | **Güvenlik işaretlemesi** — yazma tool'ları belirgin, `dryRun` açık gelir | Yazma tool'unu okuma tool'undan görsel olarak ayırmaz |
| 8 | **İki revizyonu yan yana çalıştırma** | Tek bağlantı, tek revizyon |

Buna karşılık resmî inspector **her** MCP sunucusuyla çalışır; bu ekran yalnızca
bu repodaki üç sunucuyla çalışır (bilinçli bir allowlist — aşağıya bakın).

---

## Dosyalar

```
sunucu.mjs   Node 24, bağımlılıksız. Statik dosya servisi + stdio JSON-RPC proxy'si.
index.html   Tek sayfa, beş sekme.
style.css    Açık/koyu tema, mobil uyumlu. Tek bir dış kaynak referansı yok.
app.js       Ön yüz mantığı. import/require yok; tarayıcıya olduğu gibi gider.
```

---

## HTTP uçları

Hepsi `application/json`. Aynı origin'den konuşulur; CORS yoktur.

| Uç | Gövde | Döner |
|---|---|---|
| `GET /` | — | `index.html` |
| `GET /api/sunucular` | — | Üç sunucu tanımı (`hazir` bayrağı dahil), protokol seçenekleri, sözleşme özeti, aktif oturum |
| `GET /api/sozlesme` | — | `contract/tools.json` (tarayıcı canlı doğrulamayı kendisi yapar) |
| `POST /api/baglan` | `{dil, protokol}` | Sunucuyu başlatır, **sondayı atar**, `tools/list` çeker. Ham istek/cevaplarla döner |
| `POST /api/cagir` | `{metod, params, timeoutMs?}` | Ham JSON-RPC isteğini iletir. `tur` ∈ `yanit` \| `sunucu-istegi` \| `hata` |
| `POST /api/yanitla` | `{id, sonuc, bekleId?}` | v1'de sunucunun **sorduğu** isteğe cevap verir ve asıl cevabı bekler |
| `POST /api/karsilastir` | `{dil, tool, args, otoOnay?}` | Aynı tool'u **iki ayrı süreçte**, iki revizyonla çalıştırır ve `structuredContent`'leri karşılaştırır |
| `GET /api/kayit` | — | O ana kadarki tüm ham JSON-RPC trafiği + sunucunun stderr'i |
| `GET /api/kopar` | — | Oturumu kapatır, özet döner |

### Örnek

```bash
curl -s localhost:5200/api/sunucular | jq '.sozlesme'

curl -s -X POST localhost:5200/api/baglan \
  -H 'content-type: application/json' \
  -d '{"dil":"ts","protokol":"2026-07-28"}' | jq '.sonda.konusulan, .sonda.yontem'
# "v2"
# "server/discover"

curl -s -X POST localhost:5200/api/cagir \
  -H 'content-type: application/json' \
  -d '{"metod":"tools/call","params":{"name":"xurrent_whoami","arguments":{}}}' \
  | jq '.cevap.result.resultType, (.cevap.result.structuredContent|keys)'
# "complete"
# ["account","mode","person","rateLimit"]

curl -s localhost:5200/api/kopar | jq '.ozet.mesajSayisi'
```

---

## Tasarım kararları

**Her istek/cevabın hamı saklanır.** Bu araç "teli görmek" için var. Özet üretmek
kolaydı; özet, öğrencinin protokolü *görmesini* engeller.

**Karşılaştırma iki ayrı süreç açar.** `initialize` yapılmış bir bağlantıya v2 zarflı
istek göndermek reddedilir (*"this connection serves the handshake protocol era"*).
İki revizyon **aynı bağlantı üzerinde denenemez** — bu ölçülmüş bir kısıt, tercih değil.

**Cevap beklerken sunucu isteği araya girebilir.** v1'de sunucu, `tools/call` cevabını
vermeden önce bize `elicitation/create` **isteği** gönderir. O istek cevaplanmadan
cevabımız asla gelmez. `bekle()` bu iki olasılığı birlikte bekler; aksi hâlde ders
sırasında ekranda kilitlenme görünürdü — ki bu tam olarak v1'in terk edilme sebeplerinden biridir.

**Sözleşme kontrolü `scripts/verify-contract.mjs` ile aynı kuralları uygular.**
CI'da geçen şey ekranda da geçmeli; yoksa iki farklı "doğru" ortaya çıkar.

---

## Güvenlik

- **Allowlist.** Tarayıcı yalnızca `ts`, `py`, `cs` değerlerinden birini seçebilir;
  komutu **kendisi veremez**. Bir inspector'ın en kolay güvenlik hatası
  "komutu kullanıcıdan al, aynen çalıştır"dır — o kapı burada kapalıdır.
- **Yalnızca loopback.** Varsayılan `127.0.0.1`. `--host 0.0.0.0` verirseniz, yerel
  ağdaki herkes bu makinede süreç başlatabilir hâle gelir.
- **Her zaman mock.** Çocuk süreçler `XURRENT_MODE=mock` ile başlatılır ve `.env`
  okunmaz. Bir *inceleme* aracı gerçek bir ITSM hesabına yazmamalıdır.
- **`dryRun` varsayılan AÇIK.** Sözleşmedeki varsayılan `false`'tur; bu ekran onu
  bilerek ters çevirir. Kapatan kişi bunu *bilerek* yapar.
- **Statik dosya allowlist'i.** Servis edilen dört yol sabittir; path traversal
  yoktur.

---

## Doğrulama

Tarayıcısız ortamda da sınanabilir:

```bash
node --check clients/inspector/sunucu.mjs
node --check clients/inspector/app.js
node clients/inspector/sunucu.mjs --port 5200 &   # sonra yukarıdaki curl'ler
```

`app.js`'in saf mantığı (sözleşme karşılaştırıcısı, `requestState` çözücü, `$ref`
çözümleyici, örnek argüman üreteci) DOM olmadan `node:vm` içinde sahte bir DOM ile
yüklenip test edilebilir — yöntem [`docs/13-inspector.md`](../../docs/13-inspector.md)
içinde anlatılır.
