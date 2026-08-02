# Sahte Gemini sunucusu

> ## ⚠️ Bu bir dil modeli DEĞİLDİR
>
> Metin üretmez, akıl yürütmez. Yaptığı tek şey doğru şekilli bir
> `candidates[].content.parts[]` döndürmek.
>
> Test ettiği şey: chatbot'un **tool döngüsü**, **şema çevirisi**, `functionCall`/
> `functionResponse` id eşleştirmesi ve onay akışı. Test **etmediği** şey: modelin ne
> kadar iyi karar verdiği.

## Neden var

Chatbot'un LLM yolu, API anahtarı olmadığı için hiç uçtan uca çalıştırılamamıştı —
repo'nun ikinci büyük boşluğuydu. Bu sunucu `GEMINI_BASE_URL` üzerinden devreye girer;
istemci kodunda tek satır değişmez.

```bash
node tools/fake-gemini/server.mjs --mod otomatik --port 5100
```

```bash
GEMINI_BASE_URL=http://127.0.0.1:5100 GEMINI_API_KEY=sahte npm run chat
```

## Üç mod

| Mod | Ne yapar | Ne zaman |
|---|---|---|
| `otomatik` | Kural tabanlı yanıtlayıcı; anahtar kelimeye göre doğru tool'u çağırır | İnsansız uçtan uca test, CI, sunumda beklemeden akış göstermek |
| `sor` | ★ İsteği kuyruğa yazar, **yanıtı bir insanın yazmasını bekler** | Senaryoyu bir kez elle oynamak; modelin yerine geçmek |
| `kayit` | Daha önce verilmiş yanıtları oynatır | Ders ve CI — deterministik |

### `sor` modu — modelin yerine sen geçersin

```bash
node tools/fake-gemini/server.mjs --mod sor --port 5100
```

Her istek `kuyruk/istek-NNN.json` olarak yazılır ve sunucu `kuyruk/yanit-NNN.json`
dosyasını bekler. Bekleyenleri görmek ve cevaplamak için:

```bash
node tools/fake-gemini/yanitla.mjs                                   # bekleyenleri listele
node tools/fake-gemini/yanitla.mjs 1 --goster                        # isteğin tamamı
node tools/fake-gemini/yanitla.mjs 1 --cagri calendar_list_today --args '{"provider":"mock"}'
node tools/fake-gemini/yanitla.mjs 1 --metin "Bugün 5 toplantınız var..."
```

**Verdiğiniz her yanıt `kayitlar/` altına düşer.** Yani bir senaryoyu bir kez
cevaplarsınız, sonra sınıfta `--mod kayit` ile sonsuza kadar aynı şekilde oynatılır.
İnsan emeği bir kez harcanır, deterministiklik kalıcı olur.

Dosya tabanlı olması bilinçli: yeni bir protokol icat etmeden herhangi bir insan
**veya ajan** (Claude Code dahil) araya Read/Write ile girebilsin diye.

### `kayit` modu eksik kayıtta ne yapar

Uydurmaz. Net bir `404` ve anahtarı döndürür:

```
Kayıt bulunamadı: 'msg:bugun-neler-yaptim-xurrent-e-yazalim'.
Bu senaryo henüz cevaplanmamış. '--mod sor' ile bir kez cevaplayın.
```

Sessizce yanlış cevap vermek, açıkça "bilmiyorum" demekten kötüdür.

## Gerçek API'den taklit ettiği davranışlar

| Kural | Davranış |
|---|---|
| `x-goog-api-key` header yok | **401**. Anahtarı URL query'sine koymak erişim loglarına düşürür; sahte sunucu da bunu zorlar |
| Bilinmeyen yol | **404** + beklenen yol bilgisi |
| `contents` boş veya yok | **400** |
| Gövde JSON değil | **400** |
| Hata gövdesi | Gerçek API gibi `{ error: { code, message, status } }` |

`functionCall.id` her çağrıda üretilir; istemcinin `functionResponse`'ta **aynı id'yi**
geri göndermesi gerekir — gerçek API bunu şart koşuyor ve en sık atlanan ayrıntı bu.

## Türkçe metin katlama

`otomatik` mod anahtar kelimeleri **katlanmış** metinde arar: diakritikler ASCII'ye
indirilir ve `İ/I` özel olarak ele alınır.

Sebep: kullanıcılar diakritiksiz yazar (`acik islerim`), ve Türkçe'de
`"İŞ".toLowerCase()` → `"i̇ş"` (birleşik nokta) verir, `"is"` ile eşleşmez.
Regex'i Türkçe karakterle kurmak sessizce tutmaz.

## Sınırları

- Streaming (`streamGenerateContent`) yolu tanınır ama **stream etmez**, tek parça döner.
- Token sayıları her zaman `0`.
- `generationConfig` okunur ama **etkisizdir**.
- Paralel `functionCall` (tek turda birden çok çağrı) desteklenmez.
- `otomatik` mod bir modeli taklit etmez; sabit bir karar ağacıdır.

Gerçek Gemini'ye geçtiğinizde bunların hiçbiri sizi korumaz — bu sunucu yalnızca
**kendi kodunuzun** doğru konuştuğunu gösterir.

## İlgili

- [tools/fake-xurrent](../fake-xurrent/README.md) — aynı yaklaşımın Xurrent API'si için hâli
- [docs/05-chatbot.md](../../docs/05-chatbot.md) — sistem promptu ve diyalog sözleşmesi
