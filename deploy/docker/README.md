# Konteynerleme — `deploy/docker/`

> Üç dilin MCP sunucusu için Dockerfile'lar, anahtarsız ayağa kalkan tam yığın
> ve iki doğrulama betiği.
>
> **Bu bir taslaktır.** Çalışıyor — ama karar gerektiren noktalar
> [`KARARLAR.md`](KARARLAR.md) içinde toplandı. Oradaki maddeler kapatılmadan
> bu iskelet üretime gitmemeli.

---

## 60 saniyede

```bash
docker compose -f deploy/docker/compose.yaml up -d --build
./deploy/docker/duman-testi.sh
```

Beklenen çıktı:

```
xurrent-mcp — konteyner duman testi

  GEÇTİ  TypeScript   xurrent_whoami → TW9jay9QZXJzb24vMQ (fixtures/ imajda, mock mod çalışıyor)
  GEÇTİ  Python       xurrent_whoami → TW9jay9QZXJzb24vMQ (fixtures/ imajda, mock mod çalışıyor)
  GEÇTİ  C#           xurrent_whoami → TW9jay9QZXJzb24vMQ (fixtures/ imajda, mock mod çalışıyor)

3 geçti · 0 kaldı
```

**Hiçbir anahtar gerekmez.** Xurrent mock moddadır (`fixtures/`), LLM sahte
Gemini'dir. `.env` dosyası olmadan çalışması bilinçli bir kabul kriteridir.

Kapatmak için:

```bash
docker compose -f deploy/docker/compose.yaml down
```

---

## Dosyalar

| Dosya | Ne |
|---|---|
| `Dockerfile.typescript` | TypeScript sunucusu (MCP http + web modu) |
| `Dockerfile.python` | Python sunucusu |
| `Dockerfile.csharp` | C# / .NET sunucusu |
| `Dockerfile.sahte` | Sahte Xurrent + sahte Gemini (tek imaj, iki rol) |
| `Dockerfile.*.dockerignore` | Dosya-başı yoksayma listeleri — bkz. [K-05](KARARLAR.md#k-05) |
| `compose.yaml` | Altı servislik yerel tam yığın |
| `bin/loopback-kopru.sh` | **İmajın içine girer.** 127.0.0.1'e çakılı sunucuları dışarı açar |
| `bin/saglik-kontrol.sh` | **İmajın içine girer.** MCP protokolüyle sağlık kontrolü |
| `duman-testi.sh` | Ana makinede koşar. Üç sunucuya gerçek `tools/call` atar |
| `replika-deneyi.sh` | Ana makinede koşar. Paylaşılan sır dersini **gösterir** |
| `KARARLAR.md` | ★ Açık kararlar — kullanıcı seçmeli |

---

## Servisler ve portlar

```bash
docker compose -f deploy/docker/compose.yaml ps
```

| Servis | Ana makine | Konteyner | Uç nokta |
|---|---|---|---|
| `mcp-ts` | 8788 | 8788 | `POST /mcp` |
| `mcp-py` | 8798 | 8788 | `POST /mcp` |
| `mcp-cs` | 8808 | 8788 | `POST /` ← kökte, `/mcp` değil |
| `web` | 8787 | 8787 | `http://localhost:8787` |
| `sahte-xurrent` | 4000 | 4000 | `POST /` (GraphQL) |
| `sahte-gemini` | 5100 | 5100 | `GET /saglik` |

Konteyner portu üçünde de **aynı** (8788), ana makine portları **farklı** —
sözleşmenin dilden bağımsız olduğunu, farkın yalnızca yayınlama ayrıntısında
kaldığını göstermek için.

> **C# uç noktası `/`'tür.** `app.MapMcp()` argümansız çağrılıyor
> (`Agent/WebHost.cs`). Diğer ikisi `/mcp` kullanır. Bkz. [K-04](KARARLAR.md#k-04).

---

## İmaj boyutları

Ölçüldü — `docker image ls`, `linux/arm64`, çok aşamalı inşa sonrası:

| İmaj | Boyut | Taban |
|---|---|---|
| `xurrent-mcp-sahte` | **241 MB** | `node:24-alpine` |
| `xurrent-mcp-python` | **265 MB** | `python:3.13-slim` |
| `xurrent-mcp-typescript` | **288 MB** | `node:24-alpine` |
| `xurrent-mcp-csharp` | **383 MB** | `mcr.microsoft.com/dotnet/aspnet:10.0` (368 MB) |

Okuma notları:

- **C# imajının neredeyse tamamı taban imajdır** (368 MB'ın üstüne ~15 MB).
  Uygulama kodu küçüktür; ağırlık ASP.NET Core runtime + ICU + tzdata'dır.
  ICU **zorunludur**: `XurrentMcp.csproj` `InvariantGlobalization=false` der,
  çünkü `TimeZoneInfo.FindSystemTimeZoneById("Europe/Istanbul")` ve Türkçe
  kültür karşılaştırmaları invariant modda çalışmaz. Alpine varyantına geçilirse
  `icu-libs` + `tzdata` **elle** eklenmeli — yoksa saat dilimi sessizce UTC'ye
  düşer (`Config.cs` → `catch → TimeZoneInfo.Utc`) ve ders çıktılarındaki
  saatler kayar.
- **TypeScript imajı Python'dan büyük**, çünkü `node_modules` içinde **iki MCP
  SDK kuşağı** yan yana duruyor (v1 `@modelcontextprotocol/sdk`, v2
  `@modelcontextprotocol/{core,server,client}`). Bu bilinçli — bkz. `package.json`
  içindeki `_dependencyNote`.
- Bu sayılar **sıkıştırılmamış** yerel boyutlardır; kayıt defterine itilirken
  katmanlar sıkışır ve paylaşılan taban katmanları bir kez iner.

Küçültme yolları (hiçbiri yapılmadı, hepsi karar ister): distroless/chiseled
taban, .NET için `PublishTrimmed`, `node_modules` yerine tek dosyaya bundle.

---

## Neden varsayılan komut `http`, `stdio` değil

**stdio transport konteynerde anlamsızdır.** stdio'da MCP client sunucuyu bir
**alt süreç** olarak başlatır ve onun `stdin`/`stdout`'una yazar. Konteyner ise
client'ın alt süreci değildir; `docker run -i` ile taklit edilebilir ama o zaman
her oturum için bir konteyner doğar ve ölür — uzun ömürlü imajın anlamı kalmaz.

Streamable HTTP, *"bir porta bakan uzun ömürlü süreç"* tanımına uyan **tek**
transport'tur. stdio denemek isteyen repodan doğrudan çalıştırmalı:

```bash
cd servers/typescript && npm start
```

---

## Sağlık kontrolü — adanmış bir `/saglik` ucu YOK

Ölçüm sonucu, eklenmedi:

| Bileşen | Sağlık ucu |
|---|---|
| MCP HTTP transport (üç dilde de) | **YOK** |
| web modu — Python | `GET /api/health` var |
| web modu — TypeScript, C# | `GET /api/config` var (rozet verisi, sağlık değil) |
| `tools/fake-gemini` | `GET /saglik` var |
| `tools/fake-xurrent` | **YOK** — POST dışı her isteğe 405 |

Bunun yerine sağlık **protokolün kendisiyle** ölçülüyor: `bin/saglik-kontrol.sh`
bir `server/discover` (TypeScript, C#) ya da `initialize` (Python) POST'u atar.

Bu aslında `GET /saglik`'ten **güçlüdür**: tek POST hem HTTP yığınının ayakta
olduğunu, hem sunucunun MCP konuştuğunu, hem tool kayıtlarının yüklendiğini
birlikte kanıtlar. Yan fayda — sağlık kontrolü aynı zamanda bir **uyum
sondasıdır**: `resultType` alanı düşerse ya da `_meta` zorunluluğu bozulursa
konteyner `unhealthy` olur ve regresyon dağıtım katmanında da yakalanır.

`sahte-xurrent` için sağlık kontrolü, belgelenmiş **405** yanıtını arar. "Süreç
ayakta ve HTTP konuşuyor" demektir; daha fazlasını iddia etmiyoruz.

---

## ★ `XURRENT_STATE_SECRET` — bu yığının merkezindeki kısıt

MRTR onay akışı `requestState`'i HMAC-SHA256 ile imzalayıp **istemciye emanet
eder**; istemci ikinci istekte geri getirir. Anahtar boşsa **süreç başında
rastgele üretilir**.

Çok replikalı bir HTTP dağıtımında ikinci istek başka bir replikaya düşerse imza
doğrulanamaz ve **onay akışı sessizce kırılır**. Kullanıcı *"onayladım ama
yazılmadı"* der; logda yalnızca "imza geçersiz" görünür; yük dengeleyici
sağlıklı olduğu için altyapı tarafında da alarm çalmaz.

`compose.yaml` bu yüzden **sabit bir değer** verir ve üç sunucu da aynı değeri
paylaşır. Gerekçesi dosyanın başında uzun uzun yazılı.

### Bunu iddia etmiyoruz — gösteriyoruz

```bash
./deploy/docker/replika-deneyi.sh
```

Üç replika kaldırır (ikisi aynı sırra sahip, biri değil), bir MRTR onayı üretir
ve aynı onayı ikisine de götürür:

```
2) AYNI onay, B replikasına (:19102) — SIR PAYLAŞILMIŞ
   YAZILDI — imza tuttu. Onay replikalar arasında TAŞINDI.
           Sticky session GEREKMEDİ; stateless vaadi gerçek oldu.

3) AYNI onay, C replikasına (:19103) — SIR PAYLAŞILMAMIŞ
   REDDEDİLDİ — imza tutmadı. İşte üretimdeki o sessiz arıza.
```

### Sticky session ile ilişkisi

2026-07-28 stateless'tır — oturum yoktur, `Mcp-Session-Id` yoktur. Bu yüzden
**sticky session gerekmez.** Ama bu cümle **yalnızca sır paylaşıldığında**
doğrudur:

| | Sır paylaşılmış | Sır paylaşılmamış |
|---|---|---|
| Protokol | stateless | stateless *görünür* |
| Gerçek davranış | gerçekten stateless | gizliden gizliye stateful |
| Sticky session | **gerekmez** | zorunlu *görünür* — ama replika ölünce yine kırılır |

Sırrı paylaşmak, protokolün stateless **vaadini** altyapıda **gerçeğe çeviren**
adımdır. Paylaşılmazsa sticky session bir çözüm değil, yanlış tasarımı örten bir
yamadır.

> ⚠️ **Python'da bu tablo bugün geçerli değil.** HTTP transport'u oturum tutuyor;
> sır paylaşılsa bile sticky ister. Bkz. [K-02](KARARLAR.md#k-02).

### Sırlar imaja ASLA girmez

`XURRENT_TOKEN` · `GEMINI_API_KEY` · `XURRENT_STATE_SECRET`

Dört imajın hiçbirinde bu değişkenler tanımlı **değildir**. `ENV` ya da `ARG`
ile verilen bir sır `docker history` ile geri okunur — imajı gören herkes sırrı
görür. `.dockerignore` listeleri ayrıca `.env`, `*.pem` ve `*-token.json`
dosyalarını bağlama bile almaz.

`compose.yaml`'daki state secret **yerel demo değeridir** ve herkese açık bir
repoda duruyor. Üretimde bir sır yöneticisinden gelmeli — bkz.
[K-07](KARARLAR.md#k-07).

---

## Bilinen sınırlar

Hepsi ölçüldü, hiçbiri gizlenmedi. Ayrıntı ve seçenekler [`KARARLAR.md`](KARARLAR.md).

| Sınır | Etki | Madde |
|---|---|---|
| Sunucular `127.0.0.1`'e çakılı; C#'ta `ASPNETCORE_URLS` bunu **ezemez** | Her konteynerde socat köprüsü | [K-01](KARARLAR.md#k-01) |
| Python HTTP: oturumlu, `2025-11-25` konuşuyor, `Host` localhost'a kilitli | `mcp-py`'ye **yalnızca ana makineden** erişilir; konteynerden konteynere HTTP 421 | [K-02](KARARLAR.md#k-02) |
| Python repo kökünü `parents[4]` ile buluyor | İmaj kaynak ağaç düzenine bağımlı | [K-03](KARARLAR.md#k-03) |
| MCP yolu üç dilde farklı (`/mcp`, `/mcp`, `/`) | Client yapılandırması dile göre değişir | [K-04](KARARLAR.md#k-04) |
| Taban imajlar digest ile sabitlenmemiş | İnşa tam tekrarlanabilir değil | [K-06](KARARLAR.md#k-06) |
| `requestState` biçimi diller arası uyumsuz | Karışık dilli küme mümkün değil | [K-08](KARARLAR.md#k-08) |
| Yalnızca ana makinenin mimarisinde denendi (arm64) | Çok mimarili inşa yapılmadı | [K-09](KARARLAR.md#k-09) |
| CI'ya imaj inşası eklenmedi | Dockerfile regresyonu yakalanmaz | [K-10](KARARLAR.md#k-10) |

---

## Tek tek inşa etmek

İnşa bağlamı **repo kökü olmak zorunda** — üç dil `contract/` ve `fixtures/`
dizinlerini paylaşır.

```bash
docker build -f deploy/docker/Dockerfile.typescript -t xurrent-mcp-typescript:draft .
docker build -f deploy/docker/Dockerfile.python     -t xurrent-mcp-python:draft     .
docker build -f deploy/docker/Dockerfile.csharp     -t xurrent-mcp-csharp:draft     .
docker build -f deploy/docker/Dockerfile.sahte      -t xurrent-mcp-sahte:draft      .
```

Tek başına çalıştırmak:

```bash
docker run --rm -p 8788:8788 xurrent-mcp-typescript:draft
```

---

## Web arayüzünü başka bir dille koşmak

`clients/web` statik dosyaları üç backend'de de aynıdır; arayüz hangi dilin
arkasında çalıştığını **bilmez**. compose'daki `web` servisi TypeScript imajını
kullanıyor — sebebi tercih değil ölçüm: `web` modunda `0.0.0.0`'a bağlanan tek
dil o.

Python ya da C# ile koşmak için loopback köprüsünü web portuna yöneltmek gerekir:

```yaml
  web-py:
    image: xurrent-mcp-python:draft
    command: ["python", "-m", "xurrent_mcp", "--web"]
    environment:
      KOPRU_PORT_DEGISKENI: WEB_PORT      # ← köprü artık WEB_PORT'u çeviriyor
      KOPRU_VARSAYILAN_PORT: "8787"
      WEB_PORT: "8787"
      GEMINI_BASE_URL: http://sahte-gemini:5100
      GEMINI_API_KEY: sahte
    ports: ["8797:8787"]
```

---

## Doğrulama

Bu taslak yazılırken koşturulanlar ve sonuçları:

| Kontrol | Komut | Sonuç |
|---|---|---|
| Dört imaj inşası | `docker compose … build` | **4/4 başarılı** |
| Yığın ayağa kalkıyor | `docker compose … up -d` | **6/6 servis `healthy`** |
| Gerçek `tools/call` | `./duman-testi.sh` | **3 geçti · 0 kaldı** |
| Paylaşılan sır dersi | `./replika-deneyi.sh` | **Beklendiği gibi: paylaşılan → yazdı, paylaşılmayan → reddetti** |
| Dockerfile lint | `hadolint` 2.15.1 | Yalnızca sürüm sabitleme uyarıları — bkz. [K-06](KARARLAR.md#k-06) |
| Kabuk betiği lint | `shellcheck` (koalaman/shellcheck:stable) | **Dört betik de temiz, uyarı yok** |

`compose.yaml` şema doğrulaması: `docker compose config --quiet` → geçerli.

> Ölçüm ortamı: Docker 29.6.2, Compose v5.3.1, `linux/arm64` (Apple Silicon).
> `linux/amd64` denenmedi.
