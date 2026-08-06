# Ders sihirbazı

> **Ne olduğu:** Bir MCP **client**'ı. Üç sunucudan birini stdio üzerinden
> başlatır, [docs/wizard/steps.json](../../docs/wizard/steps.json)'daki adımları
> sırayla yürütür — bağlan → çağır → doğrula → anlat — ve PASS/FAIL/SKIP raporlar.
>
> **Ne olmadığı:** Ders içeriği burada gömülü DEĞİLDİR. Adımlar, beklenen sayılar,
> anlatım metinleri tamamen `steps.json`'dan gelir. Dersin tezi ("MCP bir
> protokoldür, dil bir detaydır") ancak TEK client'ın ÜÇ sunucuya bağlanıp AYNI
> çıktıyı üretmesiyle kanıtlanabilir; metin client'a gömülü olsaydı kanıt
> değersizleşirdi.

## Çalıştırma

```bash
node clients/wizard/wizard.mjs --server ts        # TypeScript sunucusuyla
node clients/wizard/wizard.mjs --server py --auto # Python, sormadan uçtan uca
node clients/wizard/wizard.mjs --server cs --json # C#, makine-okunur rapor
```

Kısayollar: `npm run wizard` (servers/typescript) · `uv run xurrent-mcp --wizard`
(servers/python) · `dotnet run -- wizard` (servers/csharp) — üçü de aynı dosyayı
çağırır.

## Bayraklar

| Bayrak | Anlamı |
|---|---|
| `--server ts\|py\|cs` | Hangi sunucu spawn edilecek |
| `--exec "<komut>"` | Üçü DIŞINDA, sözleşmeyi implemente eden herhangi bir MCP sunucusu — plugin modelinin "sunucu da değiştirilebilir parçadır" kanıtı |
| `--auto` | Onay sorularını sormadan uçtan uca koş (CI böyle koşar) |
| `--step <id>` / `--only <id,id>` / `--from <id>` | Adım seçimi |
| `--list-steps` | Adımları listele ve çık |
| `--json` / `--no-color` / `--verbose` | Rapor biçimi |
| `--no-probe` | Protokol keşif sondasını atla |

## Sonuç modeli

**PASS** — kontrol çalıştı ve tuttu · **FAIL** — çalıştı ve TUTMADI (gerçek
uyumsuzluk) · **SKIP** — ÇALIŞTIRILAMADI (ön koşul yok: sunucu o revizyonu
konuşmuyor, kullanıcı adımı atladı). SKIP başarısızlık değildir; çıkış kodunu
yalnızca FAIL etkiler.

Sihirbaz bağlanmadan önce protokol sondası koşar (`server/discover` → olmazsa
`initialize`), MRTR turlarını client tarafında yürütür ve `13-iki-kabuk`
adımında aynı tool'u iki protokol revizyonuyla çalıştırıp `structuredContent`
çıktısını kanonik JSON'da karşılaştırır.

## Ayrıntı

- Adım şeması ve yeni adım ekleme: [docs/07-sihirbaz.md](../../docs/07-sihirbaz.md)
- Adım dosyası doğrulaması: `node scripts/validate-steps.mjs` (CI'da `adimlar` adımı)
- Sunum akışında kullanım: [docs/demo/senaryo.md](../../docs/demo/senaryo.md)
