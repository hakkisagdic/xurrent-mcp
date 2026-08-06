# CI/CD kararları — açık uçlar ve gerekçeler

> Bu belge `.github/` altındaki iş akışlarının **neden öyle** olduğunu ve
> **neyin hâlâ karara bağlanmadığını** tutar. Taslak durumundaki her `TODO(K-n)`
> buradaki bir maddeye işaret eder.
>
> Durum etiketleri:
> **KARAR** verildi ve uygulandı · **AÇIK** kullanıcı seçmeli · **TAKİP** verildi ama izlenmeli

## Ne üretildi

| Dosya | Ne yapar |
|---|---|
| `.github/workflows/ci.yml` | push/PR → hızlı (derleme·birim·şema) → yavaş (sözleşme·uyum·uçtan uca·wire) → özet |
| `.github/workflows/release.yml` | `v*` etiketi → doğrulama → 3 imaj (GHCR) → SBOM + GitHub Release |
| `.github/workflows/guvenlik.yml` | haftalık + PR → npm/pip/nuget denetimi, gitleaks, PR bağımlılık farkı |
| `.github/dependabot.yml` | npm · uv · nuget · github-actions, haftalık |
| `.github/actions/ortam-kur/action.yml` | Node 24 · Python 3.13 (uv) · .NET 10 kurulumu + önbellek, tek yerde |
| `.github/scripts/rapor-ozeti.mjs` | `test-all --json` → Markdown özet (CI özeti ve sürüm notu aynı üreteci kullanır) |
| `.github/scripts/guvenlik-esigi.mjs` | üç denetim aracının çıktısını tek şiddet modeline indirger, eşiği uygular |
| `.github/gitleaks.toml` | gizli anahtar taraması yapılandırması ve gerekçeli izin listesi |

---

## ★ K-2 — `XURRENT_STATE_SECRET` replikalar arası PAYLAŞILAN sır olmak zorundadır

**Durum: KARAR (CI/CD tarafı) · IaC tarafında UYGULANMALI**

Bu, dağıtım tasarımının merkezinde duran kısıt. Burada tekrar ediliyor çünkü
imajı üreten yer burasıdır ve imajı kullanan kişi bunu bilmeden dağıtırsa
hata **hiçbir logda görünmez**.

MCP `2026-07-28` onay akışı (MRTR) HMAC ile imzalı bir `requestState` üretir ve
bunu **istemciye emanet eder**; istemci ikinci istekte geri getirir. İmza
anahtarı `XURRENT_STATE_SECRET`'tır ve **boş bırakılırsa süreç başında rastgele
üretilir** (bkz. `.env.example`).

Sonuç: HTTP transport ile **çok replikalı** bir dağıtımda ikinci istek başka bir
replikaya düşerse imza doğrulanamaz ve **onay akışı kırılır**. Kullanıcı
"onayladım ama yazılmadı" der.

İki cümle **birlikte** doğrudur ve ayrı ayrı yanıltıcıdır:

1. `2026-07-28` stateless olduğu için **sticky session GEREKMEZ**.
2. Bu, **yalnızca** `XURRENT_STATE_SECRET` replikalar arasında paylaşıldığında doğrudur.

CI/CD tarafında yapılanlar:

- Sır imaja **girmez** — `release.yml` içinde `build-args` yok; sır ne `ARG` ne
  `ENV` olarak geçer (build arg `docker history`'de kalır ve imajı çeken herkes okur).
- Bu bir slogan değil, **ölçülen** bir iddia: "İmaj sır taşımıyor" adımı imaj
  konfigürasyonunu registry'den okur ve üç sır adını arar.
- Uyarı, üretilen **her GitHub Release notunun** içine yazılır.

**IaC tarafında karara bağlanacak:** sır nereden gelecek (bulut sır yöneticisi ·
Kubernetes Secret · dosya montajı) ve **rotasyonu** nasıl olacak. Rotasyon anında
bekleyen onaylar geçersizleşir — bu kabul edilebilir mi, yoksa iki anahtarlı
(eski+yeni) bir geçiş penceresi mi gerekir?

---

## K-1 — Dockerfile yolu ve derleme bağlamı · **KARAR (IaC tarafıyla hizalandı)**

`release.yml` şu sözleşmeye bağlıdır:

| | değer |
|---|---|
| Dockerfile yolu | `deploy/docker/Dockerfile.typescript` · `.python` · `.csharp` |
| derleme bağlamı | **depo kökü** (`context: .`) |
| yoksayma listesi | `deploy/docker/Dockerfile.<dil>.dockerignore` (BuildKit otomatik bulur) |
| varsayılan mod | `http` — stdio konteynerde anlamsızdır (IaC tarafının kararı) |

★ Bağlamın depo kökü olması **zorunlu**, tercih değil: üç sunucu da
`contract/tools.json` ve `fixtures/` okur; dahası TypeScript'in kök bulucusu
(`src/config.ts → findRepoRoot`) depo kökünü tam olarak bu iki yolla tanır.
Bağlamı `servers/<dil>/` yapan bir imaj, ilk `xurrent_list_open_work` çağrısında
"fixtures yok" ile düşer.

`release.yml`'deki "Ön koşul — Dockerfile var mı" adımı bu yolu **denetler**:
IaC tarafı dosyayı taşırsa iş akışı sessizce başka bir şey üretmez, açık bir
hatayla kırılır.

★ Varsayılan mod `http` olduğu için **K-2 doğrudan devreye girer**: bu imajdan
birden fazla replika koşturan herkes paylaşılan `XURRENT_STATE_SECRET` vermek
zorundadır.

**Kalan küçük tutarsızlık:** `deploy/docker/compose.yaml` yerel imajları
`xurrent-mcp-typescript:draft` (uzun ad) diye adlandırıyor; GHCR'ye itilen adlar
`xurrent-mcp-ts|py|cs` (kısa ad). İkisi farklı amaca hizmet ediyor (yerel geliştirme
vs yayın) ama isim farkı karıştırabilir. **Karar:** birleştirilsin mi?

---

## K-3 — İmaj mimarileri · **AÇIK**

Şu an yalnızca `linux/amd64`. `linux/arm64` (Apple Silicon, Graviton) eklemek
QEMU emülasyonu ister ve .NET/uv derlemelerinde koşu süresini **kat kat**
artırır. Alternatif: arm64 için yerel ARM koşucusu.

**Soru:** ders/demo makinelerinde arm64 gerekiyor mu? Gerekmiyorsa bu satır
olduğu gibi kalmalı.

---

## K-4 — PR'ye bot yorumu · **KARAR: yazılmıyor**

`GITHUB_STEP_SUMMARY` kullanılıyor, PR'ye yorum yazılmıyor. Gerekçe: yorum
yazmak `pull-requests: write` ister ve bu yetki fork'tan gelen PR'lerde
`pull_request_target` gibi risk yüzeyleri açar. Özet sayfası aynı bilgiyi taşır
ve **hiçbir yazma yetkisi istemez**.

`dependency-review-action` için de aynı çizgi: `comment-summary-in-pr: never`.

**Değiştirilmek istenirse:** `ozet` işine `pull-requests: write` eklenir ve
`gh pr comment` çağrılır. Sadece `pull_request` olayında, fork'lardan gelen
PR'lerde davranışın ne olacağı ayrıca kararlaştırılmalı.

---

## K-5 — `pip-audit` şiddet üretmez · **KARAR: bilinmeyen KIRAR (yumuşatılabilir)**

`npm audit` ve `dotnet list package --vulnerable` bulguya bir şiddet verir;
`pip-audit` **vermez**. Elimizde "bir Python bağımlılığı için danışma kaydı var"
bilgisinden fazlası yoktur.

| seçenek | bedeli |
|---|---|
| bilinmeyen = düşük | gerçek bir kritik CVE **sessizce** geçer |
| bilinmeyen = yüksek **(seçildi)** | önemsiz bir danışma kaydı ders günü CI'yı kırabilir |

Sessiz geçmek gürültüden pahalıdır. Yumuşatma bir **karar** olmalı, alışkanlık
değil: `workflow_dispatch → bilinmeyen: rapor`.

**Alternatif (araştırılmadı):** OSV API'sinden CVSS çekip şiddeti kendimiz
hesaplamak. Ağ bağımlılığı ve ek karmaşıklık getirir.

---

## K-6 — NuGet kilit dosyası yok · **TAKİP**

`servers/csharp` altında `packages.lock.json` **yok**. Sonuçları:

- `actions/setup-dotnet`'in yerleşik `cache: true` girdisi kullanılamıyor
  (kilit dosyası ister); `~/.nuget/packages` elle önbelleğe alınıyor ve anahtar
  csproj sağlamasına bağlanıyor.
- Önbellek **yaklaşıktır**: aynı csproj bir gün farklı bir transitif sürüm
  çözebilir. Doğruluğu bozmaz, önbelleğin bir kez bayatlamasına yol açar.
- Daha önemlisi: npm (`package-lock.json`) ve Python (`uv.lock`) **birebir
  tekrarlanabilir**, C# değil. Üç dilin aynı sözleşmeyi verdiğini iddia eden bir
  repoda bu bir asimetridir.

**Öneri:** `<RestorePackagesWithLockFile>true</RestorePackagesWithLockFile>` ve
kilit dosyasının commit'lenmesi. `servers/csharp` yazma alanımızın dışında —
kullanıcı karar vermeli.

---

## K-7 — Sürüm numarasının tek kaynağı yok · **AÇIK**

`package.json` → `1.0.0`, `pyproject.toml` → `1.0.0`, `XurrentMcp.csproj` →
**sürüm alanı yok**. Etiket (`v1.2.3`) ile bunlar arasında hiçbir bağ
denetlenmiyor: `v2.0.0` etiketi atıldığında imajlar `2.0.0` etiketlenir ama
`package.json` `1.0.0` demeye devam eder.

**Seçenekler:**
1. Etiket ile üç manifesto arasında CI'da tutarlılık denetimi (yeni bir test-all adımı).
2. Sürümü yalnızca etikette tutmak, manifestolardan **kaldırmak**.
3. Etiketten manifestoları üreten bir sürüm script'i.

---

## K-8 — İmaj kanıtı (provenance / attestation) · **KARAR: kapalı, gözden geçirilebilir**

`docker/build-push-action` içinde `provenance: false`, `sbom: false`. Gerekçe:
buildx'in ürettiği çok-manifestli yapı bazı registry istemcilerini şaşırtıyor ve
bu derste imajın manifest'i **sade** kalsın istiyoruz. SBOM ayrıca üretilip
**Release ekine** konuyor — bir CVE duyurulduğunda sorulan soru "hangi imajımda
var" olduğu için imaj bazlı SBOM doğru cevaptır.

**Açılmak istenirse:** `actions/attest-build-provenance` + `id-token: write` +
`attestations: write`. Sigstore ile imzalı köken kaydı üretir.

---

## K-9 — gitleaks: resmî eylem değil, resmî imaj · **KARAR (bedeli var)**

`gitleaks/gitleaks-action` **ticari lisanslıdır** (Gitleaks LLC EULA); kuruluş
depolarında `GITLEAKS_LICENSE` ister. Bu repo **MIT** ve bir öğretim
materyalidir — kopyalandığında kuruluş deposunda lisans hatası verecek bir hattı
örnek göstermek yanlış olurdu. Bu yüzden **MIT lisanslı gitleaks ikilisi kendi
konteyner imajından** koşuluyor.

**Bedeli açıkça:** `GITLEAKS_SURUM` bir `run:` adımının içindeki etikettir;
**dependabot bunu güncelleyemez**. Elle takip gerekir.

**Alternatif:** eylemi SHA ile pinlemek ve lisans notunu README'ye yazmak.

---

## K-10 — MCP SDK'ları dependabot'un rutin güncellemesinden muaf · **KARAR**

MCP SDK sürümleri bilerek sabitlenmiştir; sihirbazın 14 adımı ve uyum
denetleyicisinin 252 maddesi **bu sürümlere karşı ölçülmüştür**. Haftalık bir
zıplama, dersi her hafta yeniden ölçmek demektir.

Körlük **değil**: yalnızca `version-update:semver-*` türleri yok sayılıyor.
Dependabot'un **güvenlik** güncellemeleri bundan etkilenmez — SDK'da bir açık
duyurulursa PR yine açılır.

---

## K-11 — Zorunlu kontrol (branch protection) · **AÇIK, elle yapılmalı**

İş akışları hazır ama dal koruma kuralı **repo ayarıdır**, YAML'den gelmez.

**Öneri:** `main` dalında zorunlu kontrol olarak **yalnızca `ci / özet`** seçilsin.
`özet` işi hem hızlı hem yavaş işin sonucuna bakan bir kapıdır (`needs.*.result`),
ve okuyan insana **tek birleşik tablo** verir.

`guvenlik / *` işlerinin zorunlu olup olmayacağı ayrı bir karar: haftalık koşuda
yeni bir CVE duyurulduğunda **kod değişmeden** kırmızıya döner ve o anda açık
olan bütün PR'leri bloke eder. Bu istenen olabilir de olmayabilir de.

---

## K-12 — GHCR paket görünürlüğü · **AÇIK, ilk yayında elle yapılmalı**

★ Tuzak: GHCR'ye **ilk kez** itilen bir paket, depo public olsa bile
**private** başlar. `docker pull ghcr.io/hakkisagdic/xurrent-mcp-ts` diyen
öğrenci `denied` alır ve sebebi iş akışı logunda **görünmez** (itme başarılıdır).

İlk sürümden sonra üç paketin de görünürlüğü **public** yapılmalı ve
`xurrent-mcp` deposuna bağlanmalıdır (Packages → Package settings).

**Karar:** imajlar gerçekten public mi olacak? Ders materyali için evet
görünüyor, ama bu bir yayın kararıdır.

---

## K-13 — SARIF / code scanning · **AÇIK**

gitleaks raporu SARIF üretiyor ama **artifact** olarak duruyor.
`github/codeql-action/upload-sarif` ile GitHub'ın "Security → Code scanning"
sekmesine yüklenebilir; bulgular satır satır kodun üstünde görünür.

Bedeli: `security-events: write` yetkisi ve bir üçüncü taraf eylem daha.

---

## K-14 — Yavaş iş derlemeyi tekrar koşuyor · **KARAR (bilinçli maliyet)**

`ci.yml`'de yavaş iş `derleme` grubunu baştan koşar (~1-2 dk).

Alternatifi `dist/` + `bin/` + `.venv`'i işler arasında artifact ile taşımaktı.
Reddedildi: `.venv` **taşınabilir değildir** (mutlak yollar gömülüdür) ve bayat
bir derleme çıktısını ölçme riski, yeniden derlemenin bedelinden pahalıdır.
Ayrıca `test-all`'ın `gerektirir` bağı ancak o koşuda **gerçekten ölçülmüş** bir
derlemeye dayandığında anlamlıdır.

---

## Doğrulama durumu — ne koşturuldu, ne koşturulmadı

**GitHub Actions yerelde koşturulamaz.** Aşağıdaki iş akışlarının GitHub'ta
gerçekten yeşil yandığı **ölçülmemiştir**; ilk push/etiket bunu gösterecektir.

| ne | nasıl doğrulandı |
|---|---|
| YAML sözdizimi (5 dosya) | `python3 -c "import yaml; yaml.safe_load(...)"` — **koşturuldu, temiz** |
| iş akışı şeması + `${{ }}` ifadeleri + `run:` blokları | `actionlint 1.7.12` (konteynerden) — **koşturuldu, çıkış 0** (shellcheck dahil) |
| `rapor-ozeti.mjs` | gerçek `test-all --json` raporlarıyla; iki rapor birleştirme, "en kötü durum kazanır", eksik dosya ve KALDI çıkış kodu — **koşturuldu** |
| `guvenlik-esigi.mjs` · npm | **gerçek** `npm audit --json` (1 orta bulgu: `hono` ReDoS) — eşik `yuksek`'te geçti, `orta`'da kırdı |
| `guvenlik-esigi.mjs` · pip | **gerçek** `uv export` + `pip-audit` (bulgu yok) + sentetik bulgu ile `bilinmeyen=kir/rapor` ayrımı |
| `guvenlik-esigi.mjs` · nuget | **gerçek** `dotnet 10.0.302 list package --vulnerable --format json` + sentetik (string `High`, sayısal `3`, `Low`) |
| `gitleaks.toml` izin listesi | gitleaks `v8.30.1` konteyneriyle **4 senaryo**: işaretsiz gerçek anahtar → yakalandı · "sahte" işaretli → geçti · `.env.example` → geçti · `docs/` içinde işaretsiz → **yakalandı** |
| gitleaks — bu deponun geçmişi | 15 commit, 3.14 MB tarandı — **bulgu yok** |
| imaj üretimi | `docker build -f deploy/docker/Dockerfile.typescript .` — **koşturuldu, başarılı** |
| "imaj sır taşımıyor" adımı | gerçek imajda üç sır da yok (yanlış pozitif yok: `XURRENT_TIMEZONE` karışmıyor); `ENV XURRENT_STATE_SECRET=` gömülü sentetik imajda **yakalandı** |
| ci.yml özet kabuk bloğu | rapor varken ve hiç yokken ayrı ayrı **koşturuldu** |
| `uv sync --frozen` (kilit ayrışmıyor) | **koşturuldu, temiz** |
| iş akışı semantiği (needs, matrix, artifact akışı, izinler) | **KOŞTURULMADI** — yerel karşılığı yok |
| GHCR'ye itme, `imagetools inspect`, SBOM, Release oluşturma | **KOŞTURULMADI** — GitHub/registry gerektirir |
| dependabot yapılandırması | **KOŞTURULMADI** — yalnızca GitHub tarafında değerlendirilir |

★ **GitHub Actions yerelde koşturulamaz.** `actionlint` sözdizimini, bağlam
kullanımını ve kabuk bloklarını denetler; işlerin gerçekten yeşil yandığını
**göstermez**. İlk push ve ilk `v*` etiketi bunu gösterecektir.
