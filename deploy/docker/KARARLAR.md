# Konteynerleme — açık kararlar

> Bu bir **taslaktır**. Çalışan bir iskelet var (üç imaj kalkıyor, altı servis
> sağlıklı, üç dilde `tools/call` cevap veriyor) ama **karar gerektiren** noktalar
> bilerek açık bırakıldı. Aşağıdaki her madde bir seçim ister.
>
> Uydurma bulut hesabı, kaynak adı veya bölge **kullanılmadı**. Ölçülmemiş hiçbir
> şey iddia edilmedi; ölçülenler "ÖLÇÜLDÜ" etiketiyle işaretli.

**Kapsam notu:** bu görevde yazma izni yalnızca `deploy/docker/` altındaydı.
Aşağıdaki maddelerin çoğunun **doğru düzeltmesi uygulama kaynağındadır** ve
kasten yapılmadı. Konteyner katmanındaki geçici yamalar (socat köprüsü gibi)
görünür bırakıldı; imaj içinde `sed` ile kaynak yamalamak konteynerdeki kod ile
repodaki kodu sessizce ayrıştırırdı.

---

## Özet tablo

| # | Konu | Aciliyet | Kim karar verir |
|---|---|---|---|
| [K-01](#k-01) | Sunucular `127.0.0.1`'e çakılı — konteynerde erişilemez | **Yüksek** | Uygulama sahibi |
| [K-02](#k-02) | Python HTTP transport: oturumlu, v1-only, Host kilitli | **Yüksek** | Uygulama sahibi |
| [K-03](#k-03) | Python repo kökünü `parents[4]` ile buluyor | Orta | Uygulama sahibi |
| [K-04](#k-04) | MCP uç nokta yolu üç dilde farklı; sağlık ucu yok | Orta | Sözleşme sahibi |
| [K-05](#k-05) | `.dockerignore` dosya-başı mı, kök mü | Düşük | Repo sahibi |
| [K-06](#k-06) | Taban imaj ve paket sürümleri sabitlensin mi | Orta | Repo sahibi |
| [K-07](#k-07) | `XURRENT_STATE_SECRET` üretimde nereden gelecek | **Yüksek** | Platform sahibi |
| [K-08](#k-08) | `requestState` biçimi diller arası uyumsuz | Düşük | Sözleşme sahibi |
| [K-09](#k-09) | İmaj etiketleme ve kayıt defteri | Orta | Platform sahibi |
| [K-10](#k-10) | CI'ya imaj inşası eklensin mi | Orta | Repo sahibi |

---

<a id="k-01"></a>
## K-01 — Sunucular `127.0.0.1`'e çakılı: konteynerde port yayınlansa bile erişilemez

**Durum: geçici yama ile çalışıyor.**

### Bulgu

Bu repodaki sunucuların çoğu dinleme adresini **kod içinde** loopback'e sabitler
ve dışarıdan geçersiz kılınamaz:

| Dosya | Satır | Kod |
|---|---|---|
| `servers/python/src/xurrent_mcp/server.py` | 205 | `uvicorn.Config(app, host="127.0.0.1", …)` |
| `servers/python/src/xurrent_mcp/web.py` | 178 | `uvicorn.run(…, host="127.0.0.1", …)` |
| `servers/csharp/Agent/WebHost.cs` | — | `builder.WebHost.UseUrls($"http://localhost:{…}")` |
| `tools/fake-xurrent/server.mjs` | 491 | `server.listen(PORT, "127.0.0.1")` |
| `tools/fake-gemini/server.mjs` | 460 | `server.listen(PORT, "127.0.0.1")` |

TypeScript **tek istisnadır**: `src/mcp/http.ts` → `http.listen(port)` (host
argümanı yok) ve `src/agent/web.ts:250` aynı şekilde → tüm arayüzlere bağlanır.

Yerel geliştirmede loopback **doğru** varsayılandır. Konteynerde ölümcüldür:
konteynerin loopback'i kendisine aittir.

### ÖLÇÜLDÜ: C#'ta ortam değişkeni yolu KAPALI

`net10.0` ile minimal bir sonda yazıldı (`WebApplication` + `UseUrls("http://localhost:19999")`):

```
ASPNETCORE_URLS=http://0.0.0.0:19999  →  BOUND=http://localhost:19999
DOTNET_URLS=http://0.0.0.0:19999      →  BOUND=http://localhost:19999
```

Kodda çağrılan `UseUrls`, yapılandırmaya ortam değişkenleri okunduktan **sonra**
yazdığı için kazanır. Yani "ENV ile düzeltiriz" **işe yaramaz**. Python'da ise
zaten hiçbir ortam değişkeni yoktur; adres literaldir.

### Şu an ne yapılıyor

`deploy/docker/bin/loopback-kopru.sh` uygulamayı loopback'te yüksek bir portta
(`port + 10000`) dinletip `0.0.0.0`'daki gerçek portu **socat** ile ona bağlıyor.

```
dış dünya ──▶ 0.0.0.0:8788 (socat) ──▶ 127.0.0.1:18788 (uygulama)
```

Köprü bilerek görünür; sağlık kontrolü **dış** porttan geçtiği için köprü
ölürse konteyner `unhealthy` olur.

### KARAR GEREKİYOR

- **(a) Kaynağı düzelt (önerilen).** Her sunucuya bir dinleme-adresi ortam
  değişkeni ekle — `MCP_HTTP_HOST` / `WEB_HOST`, varsayılanı `127.0.0.1` kalsın
  (yerel güvenlik bozulmasın), konteyner `0.0.0.0` versin. Üç dilde toplam
  ~6 satır. Sonrasında socat ve köprü betiği **tamamen silinir**.
- **(b) Köprüyü kalıcılaştır.** Kaynağa dokunma. Bedeli: her imajda socat, her
  konteynerde fazladan bir süreç, ve "neden 18788?" sorusunu her yeni gelene
  anlatmak.
- **(c) `network_mode: host`.** Yalnızca Linux'ta çalışır, Docker Desktop'ta
  (macOS/Windows) çalışmaz. Ders makineleri karışıksa **uygun değil**.

---

<a id="k-02"></a>
## K-02 — Python'un HTTP transport'u: oturum tutuyor, v1 konuşuyor, Host kilitli

**Durum: kısmen çalışıyor — yalnızca ana makineden erişilebilir.**

### Bulgu

`servers/python/src/xurrent_mcp/server.py:202` şöyle:

```python
app = server.streamable_http_app()
```

Tüm parametreler varsayılan. Konteynerde koşturulup **ölçüldü**; üç sonuç da
dağıtımı doğrudan ilgilendiriyor:

| # | Ölçüm | Sonuç |
|---|---|---|
| a | Oturumsuz `tools/call` | `-32600 "Bad Request: Missing session ID"` |
| b | `initialize` yanıtı | `protocolVersion: "2025-11-25"` + `mcp-session-id` header'ı |
| c | `server/discover` (oturumlu, `_meta` ile) | `-32601 Method not found` |
| d | `Host: mcp-py:8788` ile istek | **HTTP 421 "Invalid Host header"** |

Yani:

1. **`stateless_http` varsayılan olarak `False`.** Python çok replikalı bir
   dağıtımda **sticky session ister** — sırrı paylaşmak yetmez. Bu, K-07'deki
   sır probleminden bile büyüktür.
2. **HTTP yolu 2026-07-28 konuşmaz.** `contract/protocol.md`'deki ölçüm tablosu
   Python için "ikisi de" diyor — ama o ölçüm **stdio** üzerinden yapılmıştı.
   HTTP transport'ta v2 yoktur. Belge bu ayrımı yapmıyor.
3. **DNS rebinding koruması açık.** SDK, `host="127.0.0.1"` varsayılanını görünce
   `allowed_hosts`'u `127.0.0.1:*`, `localhost:*`, `[::1]:*` ile sınırlar.
   Sonuç: **konteynerden konteynere çağrı çalışmaz.** compose'da `mcp-py`
   servisine yalnızca ana makineden `127.0.0.1:8798` ile erişilebilir.

### Şu an ne yapılıyor

- Sağlık kontrolü Python için `initialize` sondası kullanıyor
  (`MCP_SAGLIK_METODU=initialize`). `server/discover` ile ölçseydik konteyner
  sonsuza dek `unhealthy` kalır ve sebebi yapılandırma sanılırdı.
- `duman-testi.sh` Python için ayrı bir çağrı dizisi yürütüyor:
  `initialize` → oturum al → `notifications/initialized` → `tools/call`.
- compose'da bu sınır yorumla işaretli.

### KARAR GEREKİYOR

Üçü de **tek çağrının argümanlarıyla** düzelir:

```python
app = server.streamable_http_app(
    stateless_http=True,                       # (a) ve kısmen (b)
    transport_security=TransportSecuritySettings(
        allowed_hosts=[...],                   # (d) — konteyner servis adları
    ),
)
uvicorn.Config(app, host=os.getenv("MCP_HTTP_HOST", "127.0.0.1"), …)  # K-01
```

- **(a) Hepsini düzelt.** Python HTTP'de de stateless ve v2 olur; üç dil
  gerçekten aynı hizaya gelir. Ders tezini ("dil bir detaydır") en çok
  güçlendiren seçenek.
- **(b) Yalnızca `allowed_hosts`'u aç.** Konteynerler arası çağrı çalışır ama
  Python hâlâ oturumlu ve v1 kalır → çok replikalı dağıtımda sticky şart.
- **(c) Olduğu gibi bırak, belgele.** Python'u "yalnızca stdio ve tek replika"
  diye işaretle. Dürüst ama ders tezini zayıflatır.

> **Not:** `allowed_hosts`'u tamamen kapatmak (`enable_dns_rebinding_protection=False`)
> en kolay yoldur ama korumayı kaldırır. Ders materyalinde güvenlik önlemini
> "kolay olsun diye" kapatmak kötü bir örnektir; liste vermek daha doğrudur.

---

<a id="k-03"></a>
## K-03 — Python repo kökünü dosya derinliğinden buluyor

**Durum: imaj düzeni buna uyacak şekilde kuruldu, çalışıyor.**

### Bulgu

`servers/python/src/xurrent_mcp/config.py:68`:

```python
def _repo_root() -> Path:
    # servers/python/src/xurrent_mcp/config.py -> repo koku 4 seviye yukarida
    return Path(__file__).resolve().parents[4]
```

Paket `site-packages`'a kurulursa `parents[4]` `.venv` çıkar → `fixtures/`
bulunamaz → **mock mod sessizce çöker**. TypeScript (`contract/tools.json` +
`fixtures/` arayarak yukarı yürür) ve C# (`contract/tools.json` arayarak) bu
tuzağa düşmez.

### Şu an ne yapılıyor

`Dockerfile.python` paketi **kurmuyor**: `uv sync --no-install-project` ile
yalnızca bağımlılıklar kuruluyor, kaynak `/uygulama/servers/python/src` altında
bırakılıyor ve `PYTHONPATH` ile gösteriliyor. Çalıştırma `python -m xurrent_mcp`.

Bedeli: imaj, kaynak ağaç düzenine **bağımlı**. `servers/python/` bir gün taşınırsa
imaj sessizce bozulur.

### KARAR GEREKİYOR

- **(a) Diğer iki dille aynı yöntemi kullan.** `contract/tools.json` arayarak
  yukarı yürü. Üç dil aynı kuralı uygular, imaj düzeni serbest kalır.
- **(b) `XURRENT_REPO_ROOT` ortam değişkeni ekle**, yoksa mevcut davranışa düş.
  En küçük değişiklik.
- **(c) `importlib.resources` ile veriyi pakete göm.** En "Python'ca" yol, ama
  `fixtures/`'ın üç dil tarafından paylaşılması fikrini bozar — bu repoda
  fixtures ortak olmalı.
- **(d) Olduğu gibi bırak**, imaj düzeni bağımlılığını belgele. (Şu anki hâl.)

---

<a id="k-04"></a>
## K-04 — MCP uç nokta yolu üç dilde farklı; adanmış sağlık ucu yok

**Durum: sağlık kontrolü protokolle yapılıyor, ek uç EKLENMEDİ.**

### Bulgu 1 — yollar ayrışmış

| Dil | MCP uç noktası | Kaynak |
|---|---|---|
| TypeScript | `/mcp`, `/mcp/v1`, `/mcp/v2` | `src/mcp/http.ts` (PATH_DEFAULT) |
| Python | `/mcp` | `streamable_http_app()` varsayılanı |
| **C#** | **`/`** | `Agent/WebHost.cs` → `app.MapMcp()` argümansız |

Sözleşme "aynı 8 tool" diyor ve bu doğru — ama **adres** aynı değil. Bir MCP
client'ı üç sunucuya da bağlamak isteyen kişi bunu deneyerek öğreniyor.

### Bulgu 2 — sağlık ucu yok

Görev "`/saglik` veya eşdeğeri; yoksa **EKLEME**, belirt" diyordu. Ölçüm:

| Bileşen | Sağlık ucu |
|---|---|
| MCP HTTP transport (üç dilde de) | **YOK** |
| web modu — Python | `GET /api/health` var |
| web modu — TypeScript, C# | `GET /api/config` var (sağlık değil, rozet verisi) |
| `tools/fake-gemini` | `GET /saglik` var |
| `tools/fake-xurrent` | **YOK** (POST dışı her şeye 405) |

**Hiçbir sağlık ucu eklenmedi.**

### Şu an ne yapılıyor

Sağlık, **protokolün kendisiyle** ölçülüyor: `server/discover` (TS, C#) ya da
`initialize` (Python — bkz. K-02). Bu aslında `GET /saglik`'ten güçlüdür: tek
POST hem HTTP yığınının ayakta olduğunu hem sunucunun MCP konuştuğunu hem de
yapılandırmanın ayrıştığını birlikte kanıtlar. Yan fayda: sağlık kontrolü aynı
zamanda bir uyum sondasıdır — `resultType` düşerse konteyner `unhealthy` olur.

Yol farkı `MCP_SAGLIK_YOLU` ile imaj başına ayarlanıyor (`/mcp`, `/mcp`, `/`).

### KARAR GEREKİYOR

- **(a) Yolları hizala.** C#'ta `app.MapMcp("/mcp")`. Tek satır, kalıcı fayda.
- **(b) Ayrık bırak, belgele.** `contract/protocol.md`'ye "HTTP uç noktaları"
  tablosu ekle.
- **(c) Adanmış `/saglik` ucu ekle.** Üç dile de. Basitleştirir ama protokol
  sondasının verdiği ek kanıtı kaybettirir; ayrıca üç yerde daha kod demektir.

---

<a id="k-05"></a>
## K-05 — `.dockerignore` dosya-başı mı, bağlam kökünde mi

**Durum: dosya-başı listeler kullanılıyor, çalışıyor.**

İnşa bağlamı **repo kökü olmak zorunda** (üç dil `contract/` + `fixtures/`
paylaşıyor). Docker normalde `.dockerignore`'u bağlam kökünde arar — ama bu
görevde repo kökü yazılabilir alan değildi.

BuildKit önce `<Dockerfile yolu>.dockerignore` dosyasına bakar. Bu yüzden:

```
deploy/docker/Dockerfile.typescript.dockerignore
deploy/docker/Dockerfile.python.dockerignore
deploy/docker/Dockerfile.csharp.dockerignore
deploy/docker/Dockerfile.sahte.dockerignore
```

Yan fayda: her imaj yalnızca kendi gereksizlerini eliyor — Python imajı
`servers/typescript`'i, TypeScript imajı `servers/python`'ı bağlama bile almıyor.

### KARAR GEREKİYOR

- **(a) Böyle kalsın.** Dosya-başı ayrım korunur, dört liste bakılır.
- **(b) Kök `.dockerignore`'a taşı.** Tek dosya, ama en dar ortak küme olur:
  her imaj diğerlerinin ağırlığını da bağlama alır.
- **(c) İkisi birden.** Kökte ortak güvenlik listesi (sırlar, `.git`), dosya
  başında dile özgü elemeler. En temizi ama iki yere bakılır.

---

<a id="k-06"></a>
## K-06 — Taban imajlar ve paket sürümleri sabitlenmemiş

**Durum: etikete göre çözülüyor.**

```dockerfile
FROM node:24-alpine
FROM python:3.13-slim
FROM mcr.microsoft.com/dotnet/sdk:10.0
FROM mcr.microsoft.com/dotnet/aspnet:10.0
COPY --from=ghcr.io/astral-sh/uv:0.9.21 …     # ← tek sabitlenmiş olan
```

`apk add socat curl` ve `apt-get install socat curl` de sürümsüz.
**hadolint uyarıyor:** DL3018 (apk), DL3008 (apt).

Bu repo "ders çıktıları deterministik olmalı" diyor ve `package.json`'da MCP SDK
sürümlerini bilerek sabitlemiş. Aynı titizlik taban imajlara uygulanmamış durumda.

### KARAR GEREKİYOR

- **(a) Digest ile sabitle** — `node:24-alpine@sha256:…`. Tam tekrarlanabilirlik.
  Bedeli: güvenlik yamalarını elle takip etmek (Dependabot/Renovate bunu yapar).
- **(b) Etiket kalsın, yenileme otomatik olsun.** Renovate taban imajları PR ile
  günceller. Ders günü sürprizi riski kalır ama düşük.
- **(c) Şimdilik böyle.** Taslak için kabul edilebilir; sunumdan önce
  yeniden değerlendirilmeli.

apt/apk sürüm sabitleme ayrı bir sorudur: sabitlenen sürüm depodan düşünce
inşa **kırılır**. Genelde taban imaj digest'i sabitlemek yeterlidir.

---

<a id="k-07"></a>
## K-07 — `XURRENT_STATE_SECRET` üretimde nereden gelecek

**Durum: compose'da literal — YALNIZCA yerel demo için.**

### Neden bu maddenin merkezde olması gerekiyor

MRTR onay akışı `requestState`'i HMAC-SHA256 ile imzalayıp **istemciye emanet
eder**; istemci ikinci istekte geri getirir. Anahtar boşsa **süreç başında
rastgele üretilir**. Çok replikalı HTTP dağıtımında ikinci istek başka bir
replikaya düşerse imza doğrulanamaz ve **onay akışı sessizce kırılır**.

### ÖLÇÜLDÜ — iddia değil, gösterildi

`deploy/docker/replika-deneyi.sh` bunu iki konteynerle yeniden üretiyor:

```
1) A replikası (:19101) onay istedi.
   requestState: 314 karakter, imzalı — 'v1.eyJwcmluY2lwY…'

2) AYNI onay, B replikasına (:19102) — SIR PAYLAŞILMIŞ
   YAZILDI — imza tuttu. Onay replikalar arasında TAŞINDI.
           Sticky session GEREKMEDİ; stateless vaadi gerçek oldu.

3) AYNI onay, C replikasına (:19103) — SIR PAYLAŞILMAMIŞ
   REDDEDİLDİ — imza tutmadı. İşte üretimdeki o sessiz arıza.
           Kullanıcı: "onayladım ama yazılmadı." Logda yalnızca "imza geçersiz".
```

### Sticky session ile ilişkisi — ikisi birlikte

2026-07-28 stateless'tır; oturum yoktur. Bu yüzden **sticky session gerekmez**.
Ama bu cümle **yalnızca sır paylaşıldığında** doğrudur:

| | Sır paylaşılmış | Sır paylaşılmamış |
|---|---|---|
| Protokol | stateless | stateless *görünür* |
| Gerçek davranış | gerçekten stateless | gizliden gizliye stateful |
| Sticky session | **gerekmez** | zorunlu *görünür* — ama replika ölünce yine kırılır |
| Ölçekleme | serbest | yanlış tasarım örtülmüş olur |

Sırrı paylaşmak, protokolün stateless **vaadini** altyapıda **gerçeğe çeviren**
adımdır. Sticky session bu durumda bir çözüm değil, yanlış tasarımı örten bir
yamadır.

> **Ayrıca (K-02):** Python'un HTTP transport'u oturum tuttuğu için sır
> paylaşılsa **bile** sticky ister. Yani bu tablo bugün yalnızca TypeScript ve
> C# için geçerlidir.

### KARAR GEREKİYOR

Üretimde sır nereden gelecek?

- **(a) Kubernetes Secret + `envFrom`.** En yaygın. Sır etcd'de durur;
  etcd şifrelemesi ayrıca açılmalı.
- **(b) Harici sır yöneticisi** (External Secrets Operator, CSI driver ile
  Vault/Cloud KMS). Sır kümede **hiç** durmaz. Daha çok parça.
- **(c) Dosya olarak bağla ve uygulama dosyadan okusun.** Ortam değişkeni
  `/proc/<pid>/environ` ve çökme dökümlerinde görünür; dosya görünmez. Bedeli:
  üç dilde `XURRENT_STATE_SECRET_FILE` desteği eklemek.

Ek sorular — hepsi cevapsız:

- **Rotasyon.** Anahtar döndüğünde uçuştaki onaylar geçersiz olur. İki anahtarlı
  (eski + yeni doğrula, yeni ile imzala) geçiş penceresi ister. Bugün kod bunu
  desteklemiyor.
- Aynı soru `XURRENT_TOKEN` ve `GEMINI_API_KEY` için de geçerli.
- **Üçü de imaja ASLA girmemeli.** Şu anki dört imajda hiçbir sır yok; `ENV`
  ile verilen bir sır `docker history` ile geri okunur.

---

<a id="k-08"></a>
## K-08 — `requestState` biçimi diller arası uyumsuz

**Durum: bulgu kaydedildi, etkisi sınırlı.**

ÖLÇÜLDÜ: TypeScript'in ürettiği `requestState` (`v1.<base64url>`, 314 karakter)
**aynı sırra sahip** bir C# replikasına gönderildiğinde:

```
YAZMA REDDEDİLDİ. requestState base64url olarak çözülemedi.
```

Yani sır paylaşılsa bile **diller karışık bir kümede** onay taşınamaz. Aynı dilin
replikaları arasında sorun yok (K-07'de gösterildi).

**Pratikte önemi düşük:** kimse tek bir yük dengeleyicinin arkasına üç farklı
dilde implementasyon koymaz. Yine de sözleşme "aynı 8 tool, aynı çıktı" diyor;
`requestState` bu vaadin **dışında** kalıyor ve bu yazılı değil.

### KARAR GEREKİYOR

- **(a) Belgele ve geç.** `contract/protocol.md`'ye "requestState biçimi
  implementasyona özeldir, diller arası taşınabilir değildir" satırı.
- **(b) Biçimi sözleşmeye al.** Üç dil aynı zarfı üretsin. Ders açısından güzel
  bir "sözleşme nereye kadar uzanır?" tartışması açar. Maliyeti gerçek.

---

<a id="k-09"></a>
## K-09 — İmaj etiketleme ve kayıt defteri

**Durum: yerel `:draft` etiketi, kayıt defteri yok.**

Şu an dört imaj yerelde `:draft` ile duruyor. CD yok, kayıt defteri yok.

### KARAR GEREKİYOR

- **Kayıt defteri:** GHCR (repo zaten GitHub'da, `GITHUB_TOKEN` yetiyor,
  public repo için ücretsiz) · Docker Hub · bulut sağlayıcı kaydı.
  *Uydurma bir hesap adı yazılmadı — seçim kullanıcınındır.*
- **Etiketleme:** `git describe` / commit SHA (tekrarlanabilir, önerilen) ·
  semver · `latest` (ders için pratik, üretimde tehlikeli).
- **Çok mimarili mi?** Ders makineleri arm64 (Apple Silicon) ve amd64 karışık
  olacaksa `buildx --platform linux/amd64,linux/arm64` gerekir. Bu taslak
  **yalnızca ana makinenin mimarisinde** (burada: arm64) denendi.
- **Attestation/SBOM** üretilsin mi? BuildKit `--provenance` / `--sbom` ile
  verir; ders materyali için "tedarik zinciri" başlığı açar.

---

<a id="k-10"></a>
## K-10 — CI'ya imaj inşası eklensin mi

**Durum: eklenmedi.** `.github/workflows/ci.yml` bu görevde değiştirilmedi
(silinmemesi gerekiyordu; genişletme ayrı bir karardır).

Mevcut CI `test-all` koşuyor ve tek job'da üç dili birlikte doğruluyor —
gerekçesi dosyanın başında yazılı ve **iyi bir gerekçe**.

### KARAR GEREKİYOR

- **(a) Ayrı bir `imajlar` job'ı ekle.** Dört imajı inşa et, compose'u kaldır,
  `duman-testi.sh` + `replika-deneyi.sh` koştur. `test-all`'a dokunma.
  En düşük riskli seçenek; `replika-deneyi.sh` CI'da koşarsa K-07 dersi
  her PR'da yeniden kanıtlanır.
- **(b) `test-all`'a 17. adım olarak ekle.** Tek komut vaadi korunur ama
  `test-all` Docker'a bağımlı hale gelir — bugün değil.
- **(c) Yalnızca etiket/release'de inşa et.** PR süresi kısa kalır, ama
  Dockerfile regresyonu geç fark edilir.

> Not: hadolint ve shellcheck bu görevde elle koşturuldu ve **temiz** çıktı.
> CI'ya eklenirlerse ucuz bir kalite kapısı olurlar.
