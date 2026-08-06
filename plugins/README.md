# Plugin'ler

> **Tez:** Bu projede plugin, çekirdeğe kod enjekte eden bir mekanizma DEĞİLDİR.
> Plugin = **konfigürasyonla seçilen bir adaptör** ya da **paketlenmiş bir yüzey
> tanımı**. Üç dilde dinamik kod yükleme kurmak hem üç kat iş hem üç kat güvenlik
> yüzeyi olurdu; ders bunun yerine zaten var olan dikişleri (fabrikalar, env
> anahtarları, `--exec` kancası) SÖZLEŞMEYE bağlar.

## Model

Her plugin bir dizindir: `plugins/<ad>/manifest.json` +
[`manifest.schema.json`](manifest.schema.json) şeması. İki cins vardır:

| | Yerleşik (`yerlesik: true`) | Paket (`yerlesik: false`) |
|---|---|---|
| Nerede yaşar | Üç sunucunun fabrika dikişlerinde (ör. `CalendarFactory`) | Bu dizindeki artefaktlarda (ör. `connector.yaml`) |
| Nasıl etkinleşir | `secimAnahtari` env'i ile (ör. `CALENDAR_PROVIDER=google`) | Artefakt dış sisteme verilerek (ör. Copilot Studio'ya YAML import) |
| Örnek | `google-calendar`, `msgraph-calendar`, `ics-calendar` | `copilot-studio` |

Manifest, plugin'in **sözleşmesidir**: hangi env anahtarlarına ihtiyaç duyduğu
(hepsi `.env.example`'da belgeli olmak zorunda), hangi dokümanın onu anlattığı,
sağlığının nasıl denetleneceği. `scripts/validate-plugins.mjs` bu sözleşmeyi
CI'da zorlar — dizin adıyla uyuşmayan `ad`, diskte olmayan `dokuman`, belgesiz
env anahtarı kırmızıdır.

## Harici MCP sunucusu da bir "plugin"dir

`scripts/verify-contract.mjs --exec "<komut>"` ve sihirbazın `--exec` bayrağı,
sözleşme doğrulamasını ÜÇ SUNUCUYLA SINIRLAMAZ: aynı sözleşmeyi implemente eden
herhangi bir MCP sunucusu takılabilir ve aynı 14 adımdan geçirilebilir. Plugin
modelinin dördüncü çeyreği budur — sunucunun kendisi de değiştirilebilir bir
parçadır.

## Yeni plugin eklemek

1. `plugins/<ad>/manifest.json` yaz (`ad` = dizin adı).
2. Gerekli env anahtarlarını `.env.example`'a BELGELEYEREK ekle.
3. Yerleşikse: üç sunucunun ilgili fabrikasına adaptörü ekle (bkz.
   [docs/06](../docs/06-uc-dil-karsilastirma.md) — aynı adaptör üç dilde).
   Paketse: artefaktları bu dizine koy ve `artefaktlar` alanına yaz.
4. `node scripts/validate-plugins.mjs` yeşil olana kadar bitmemiştir.

Ayrıntılı anlatım: docs/17 (plugin mimarisi + Copilot Studio yürüyüşü).
