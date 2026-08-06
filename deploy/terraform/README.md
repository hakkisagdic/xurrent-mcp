# deploy/terraform — dağıtım iskeleti

> **Bu bir TASLAKTIR.** Çalışan bir iskelet ve açık kararların listesi.
> Gerçek bir buluta **hiçbir şey uygulanmadı** (`apply` yok, `init` yok).
> Anlatım ve kararlar: [`docs/15-dagitim.md`](../../docs/15-dagitim.md)

---

## Neden var

Bu repoda CI vardı, CD ve IaC yoktu. Bu klasör **IaC** tarafını dolduruyor —
ama bir "hazır dağıtım" olarak değil, **bir karar listesi + iskelet** olarak.

★ Tasarımın merkezinde tek bir kısıt var: MCP `2026-07-28` onay akışı (MRTR)
HMAC ile imzalı bir `requestState` üretir ve istemciye emanet eder. İmza anahtarı
`XURRENT_STATE_SECRET`'tir ve **boş bırakılırsa süreç başında rastgele üretilir.**
Çok replikalı bir HTTP dağıtımında bu, onay akışını **sessizce** kırar.

Bu yüzden Terraform anahtarı **kendisi üretir**, sır deposuna yazar ve **tüm
replikalara aynı değeri** verir. Ayrıntı: `docs/15-dagitim.md § Kırılma senaryosu`.

---

## Yapı

```
modules/mcp-service/            ← ARAYÜZ. Platform-bağımsız.
                                  ★ XURRENT_STATE_SECRET burada üretilir:
                                    kısıt MCP'den gelir, buluttan değil.
modules/platform-gcp-cloud-run/ ← TEK sağlayıcı-bağımlı modül.
                                  Somut bulut adı geçen tek yer burasıdır.
envs/dev/                       ← ÖRNEK ortam. Değer seçer, mantık kurmaz.
dogrula.py                      ← terraform kurulu değilken doğrulama
```

Platform seçimi (Cloud Run) **gerekçeleriyle ve alternatifleriyle**
`docs/15-dagitim.md § K2`'de tartışılıyor. Değiştirmek isterseniz
`modules/platform-*` altına ikinci bir modül yazmanız yeterli — arayüz değişmez.

---

## Sırlar

| Sır | Nereden gelir | Terraform ne yapar |
|---|---|---|
| `XURRENT_TOKEN` | Xurrent PAT | **Sadece kabı açar.** Değeri hiç görmez. |
| `GEMINI_API_KEY` | Google AI | **Sadece kabı açar.** Değeri hiç görmez. |
| `XURRENT_STATE_SECRET` | — | ★ **Üretir** ve sır deposuna yazar. |

`terraform.tfvars` içinde **hiçbir sır düz metin bulunmaz** — yalnızca sır
deposundaki *kimlikler*. `extra_env` değişkeni sır görünümlü anahtar adlarını
(`token`/`secret`/`key`/...) `validation` ile **reddeder.**

> ⚠️ Terraform **state**, ürettiği `XURRENT_STATE_SECRET`'i düz metin tutar.
> `sensitive = true` yalnızca ekran çıktısını gizler. **State de bir sırdır.**
> Bkz. `envs/dev/backend.tf.example` ve `docs/15-dagitim.md § K7`.

---

## Çalıştırma

★ **Bu makinede `terraform` da `tofu` da kurulu değil** — bu iskelet yazılırken
`terraform fmt -check` ve `terraform validate` **çalıştırılamadı.**

Kurunca sırayla bunlar koşulmalı:

```bash
terraform -chdir=deploy/terraform/envs/dev init -backend=false
terraform fmt -recursive -check deploy/terraform
terraform -chdir=deploy/terraform/envs/dev validate
```

Bu üçü geçene kadar **`plan` bile koşmayın**, `apply` hiç koşmayın.

### Bu arada: `dogrula.py`

Resmî araçların yokluğunda üç katman doğrulanıyor:

```bash
uv run --no-project --with python-hcl2 python deploy/terraform/dogrula.py deploy/terraform
```

1. **Ayrıştırma** — gerçek bir HCL2 ayrıştırıcısı dosyayı okuyabiliyor mu
2. **Biçim** — `=` hizası, girinti, sekme, satır sonu boşluğu
3. **Anlam** — tanımsız `var.`/`local.`/kaynak atıfları, modül çağrısında
   bilinmeyen ya da eksik argüman, alt modülden var olmayan çıktı okumak

**Ne yakalamaz:** sağlayıcı şema uyumu. `google_cloud_run_v2_service` gerçekten
`session_affinity` alanı kabul ediyor mu — bunu yalnızca sağlayıcı indirilerek
doğrulanır. Yani `TEMIZ` çıktısı **"apply çalışır" demek değildir.**

Betiğin kendisi de sabotajla sınandı: tanımsız değişken, bozuk hizalama ve
bilinmeyen modül argümanı **üçü de yakalandı.** (Bu repoda "kontrol ettiğini
sandığın ama etmeyen test" bir kez yaşandı; tekrarlanmasın.)

---

## Uygulamadan önce okunacaklar

Üç engel var ve üçü de `docs/15-dagitim.md`'de dosya/satır referansıyla yazılı:

1. **Python ve C# sunucuları `127.0.0.1`'e bağlanıyor** — konteyner dışından
   erişilemezler. `deploy/docker/bin/loopback-kopru.sh` bunu socat ile yamalıyor.
   ★ Yama bir sözleşme getiriyor: `KOPRU_PORT_DEGISKENI`. Terraform bunu
   `server_mode`'a göre ayarlar — ayarlamasaydı `web` modu **sessizce** kırılırdı.
2. **MCP HTTP taşıyıcısında kimlik doğrulama yok** — üç dilde de yok. (§ K4)
3. **Sağlık ucu yok** — bu yüzden TCP sondası kullanılıyor. İmajdaki
   `HEALTHCHECK` bunu çözmez: **Cloud Run Docker HEALTHCHECK'i yok sayar.**

Ve asıl soru: **bunu gerçekten dağıtmalı mısınız?** Bu bir ders reposu.
Cevap büyük olasılıkla "hayır" — gerekçesi `docs/15-dagitim.md` son bölümde.
