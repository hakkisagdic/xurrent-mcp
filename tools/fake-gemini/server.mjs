#!/usr/bin/env node
/**
 * SAHTE GEMINI SUNUCUSU
 * ═════════════════════
 *
 * Gemini `generateContent` uç noktasının wire formatını taklit eder; amaç
 * chatbot'un LLM yolunu API anahtarı olmadan UÇTAN UCA çalıştırabilmek.
 *
 * ★ NE OLMADIĞI: bir dil modeli. Metin üretmez, akıl yürütmez. Yaptığı şey,
 *   doğru şekilli bir `candidates[].content.parts[]` döndürmek. Chatbot'un
 *   tool döngüsünü, şema çevirisini ve onay akışını test eder — modelin
 *   ne kadar iyi karar verdiğini DEĞİL.
 *
 * ÜÇ MOD:
 *
 *   --mod kayit     Kayıtlardan oynatır. Deterministik; ders ve CI için.
 *                   Eşleşme bulunamazsa net bir hata verir, uydurmaz.
 *
 *   --mod sor       ★ Gelen isteği kuyruğa YAZAR ve yanıt dosyasını BEKLER.
 *                   Yanıtı bir insan (veya bir ajan) yazar. Yani modelin
 *                   yerine geçen sensin. Verilen her yanıt AYRICA kayda
 *                   geçer, böylece bir kez cevaplanan senaryo sonsuza kadar
 *                   `kayit` modunda tekrar oynatılabilir.
 *
 *   --mod otomatik  Kural tabanlı yanıtlayıcı. Kullanıcı mesajındaki anahtar
 *                   kelimelere bakıp uygun tool'u çağırır. İnsansız uçtan uca
 *                   test için; sınıfta beklemeden akış göstermek için.
 *
 * Kullanım:
 *   node tools/fake-gemini/server.mjs --mod otomatik --port 5100
 *   node tools/fake-gemini/server.mjs --mod sor --port 5100
 *   node tools/fake-gemini/server.mjs --mod kayit --port 5100
 *
 * İstemci tarafı:
 *   GEMINI_BASE_URL=http://127.0.0.1:5100  GEMINI_API_KEY=sahte  npm run chat
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KUYRUK = path.join(HERE, "kuyruk");
const KAYITLAR = path.join(HERE, "kayitlar");

const argv = process.argv.slice(2);
const arg = (ad, vars) => {
  const i = argv.indexOf(ad);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : vars;
};
const MOD = arg("--mod", "otomatik");
const PORT = Number(arg("--port", process.env.FAKE_GEMINI_PORT || 5100));
const BEKLEME_SN = Number(arg("--bekleme", 600));   // sor modunda yanıt bekleme süresi
const SESSIZ = argv.includes("--sessiz");
const TOHUM = arg("--tohum") ? Number(arg("--tohum")) : (Date.now() % 2147483647);

if (!["kayit", "sor", "otomatik", "zar"].includes(MOD)) {
  console.error(`Geçersiz --mod: '${MOD}'. İzinli: kayit | sor | otomatik | zar`);
  process.exit(2);
}

// ── tohumlanabilir rastgelelik ──────────────────────────────────────────────
/**
 * mulberry32 — küçük, hızlı, TOHUMLANABİLİR PRNG.
 *
 * NEDEN Math.random() DEĞİL: "zar atar gibi" cevap eğlencelidir ama ders
 * tekrarlanabilir olmak zorundadır. Sunumda ilginç bir akış yakalarsan
 * --tohum <N> ile birebir aynısını tekrar üretirsin. Tohum her koşuda
 * ekrana basılır; kaybolmaz.
 */
function prngUret(tohum) {
  let a = tohum >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prngUret(TOHUM);
const sec = (dizi) => dizi[Math.floor(rnd() * dizi.length)];
const zarAt = (yuz) => Math.floor(rnd() * yuz) + 1;

const log = (...a) => { if (!SESSIZ) console.error("[sahte-gemini]", ...a); };
fs.mkdirSync(KUYRUK, { recursive: true });
fs.mkdirSync(KAYITLAR, { recursive: true });

let sayac = 0;

// ── yanıt zarfı ─────────────────────────────────────────────────────────────
/**
 * Gemini'nin gerçek cevap şekli. parts[] ya {text} ya {functionCall} taşır.
 * functionCall'da `id` ZORUNLUDUR — istemci functionResponse'ta aynı id'yi
 * geri göndermek zorunda, yoksa API eşleştiremez.
 */
function zarf(parts, finishReason = "STOP") {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
    modelVersion: "sahte-gemini",
  };
}
const metin = (t) => zarf([{ text: t }]);
const cagri = (name, args, id) =>
  zarf([{ functionCall: { id: id ?? `sahte-${++sayac}`, name, args: args ?? {} } }]);

// ── istek özeti (kuyruğa ve loga yazılan okunur hâl) ────────────────────────
function ozetle(body) {
  const contents = body.contents ?? [];
  const araclar = (body.tools ?? []).flatMap((t) => t.functionDeclarations ?? []);
  const sonKullanici = [...contents].reverse().find((c) => c.role === "user");
  const sonMetin = (sonKullanici?.parts ?? []).map((p) => p.text).filter(Boolean).join(" ");
  const bekleyenYanit = (sonKullanici?.parts ?? []).find((p) => p.functionResponse);

  return {
    tur: bekleyenYanit ? "tool-sonucu-donuyor" : "kullanici-mesaji",
    sonKullaniciMetni: sonMetin || null,
    donenToolSonucu: bekleyenYanit
      ? {
          name: bekleyenYanit.functionResponse.name,
          id: bekleyenYanit.functionResponse.id,
          response: bekleyenYanit.functionResponse.response,
        }
      : null,
    mevcutToollar: araclar.map((a) => a.name),
    turSayisi: contents.length,
    systemInstruction: body.systemInstruction?.parts?.map((p) => p.text).join("\n") ?? null,
  };
}

/**
 * Kayıt anahtarı: aynı durum → aynı yanıt. Deterministik oynatmanın temeli.
 *
 * Türkçe metni ÖNCE katlarız (katla), sonra sadeleştiririz. Doğrudan
 * replace(/[^a-z0-9]/) yapmak "bugün neler yaptım"ı "bug-n-neler-yapt-m"a
 * çevirir: okunmaz ve, daha kötüsü, farklı iki cümle aynı anahtara düşebilir.
 */
function anahtar(o) {
  const p = o.tur === "tool-sonucu-donuyor"
    ? `tool:${o.donenToolSonucu.name}:${o.turSayisi}`
    : `msg:${katla(o.sonKullaniciMetni).slice(0, 80)}`;
  return p.replace(/[^a-z0-9:]+/g, "-").replace(/^-|-$/g, "");
}

// ── MOD: otomatik ───────────────────────────────────────────────────────────
/**
 * Kural tabanlı yanıtlayıcı. Model DEĞİL — sadece akışı sürecek kadar karar verir.
 * Sıra bilinçli: bağlam çekilmeden yazma yapılmaz (sistem promptunun kuralı).
 */
/**
 * Türkçe metni ASCII'ye katlar. Sebep: kullanıcılar diakritiksiz yazar
 * ("acik islerim"), regex'i Türkçe karakterle kurmak sessizce eşleşmez.
 * Ayrıca Türkçe'nin i/I ikilisi yüzünden toLowerCase() tek başına yetmez:
 * "İŞ" → toLowerCase() → "i̇ş" (birleşik nokta) olur ve "is" ile eşleşmez.
 */
function katla(s) {
  return (s ?? "")
    .replace(/İ/g, "I").replace(/I/g, "i")
    .toLowerCase()
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" }[c]))
    .normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function otomatikYanit(o) {
  const t = katla(o.sonKullaniciMetni);
  const var_ = (n) => o.mevcutToollar.includes(n);

  if (o.tur === "tool-sonucu-donuyor") {
    const n = o.donenToolSonucu.name;
    // Bağlam geldiyse sıradaki adıma geç; aksi halde özetle bitir.
    if (n === "xurrent_whoami" && var_("xurrent_list_open_work"))
      return cagri("xurrent_list_open_work", { personId: "$me" });
    if (n === "xurrent_list_open_work" && var_("xurrent_get_time_tracking_context"))
      return cagri("xurrent_get_time_tracking_context", { personId: "$me" });
    if (n === "calendar_list_today" && var_("plan_time_entries_from_calendar"))
      return cagri("plan_time_entries_from_calendar", { personId: "$me" });
    return metin(
      `Tool sonucu alındı (${n}). Sahte Gemini burada gerçek bir model gibi yorum yapmaz; ` +
      `akışın çalıştığını göstermek için özetle bitiriyorum.`);
  }

  // Desenler KATLANMIŞ metne göre yazılır: hepsi ASCII, hepsi küçük harf.
  if (/takvim|toplant|bugun/.test(t) && var_("calendar_list_today"))
    return cagri("calendar_list_today", { provider: "mock" });
  if (/acik|talep|gorev|isler|is |liste/.test(t) && var_("xurrent_list_open_work"))
    return cagri("xurrent_list_open_work", { personId: "$me" });
  if (/kim|ben |hesap/.test(t) && var_("xurrent_whoami"))
    return cagri("xurrent_whoami", {});
  if (/yaz|kaydet|gir/.test(t) && var_("xurrent_get_time_tracking_context"))
    // Yazmadan ÖNCE bağlam. timeIncrement bilinmeden süre seçilemez.
    return cagri("xurrent_get_time_tracking_context", { personId: "$me" });

  return metin(
    "Sahte Gemini otomatik modda. Anahtar kelime eşleşmedi; deneyin: " +
    "'açık işlerim neler', 'bugünkü takvimim', 'zaman yazalım'.");
}

// ── MOD: zar ────────────────────────────────────────────────────────────────
/**
 * ZAR MODU — rastgele ama DURUM FARKINDA yanıtlar.
 *
 * Amaç: API anahtarı olmadan, her koşuda farklı bir sohbet görmek. Chatbot'un
 * tek bir sabit akışa göre yazılmadığını, gerçekten değişken bir modelle baş
 * edebildiğini test eder.
 *
 * ★ Saf rastgelelik işe yaramaz: sunulmayan bir tool'u çağıran ya da tool
 *   sonucunu görmezden gelen bir yanıt döngüyü kırar ve hiçbir şey öğretmez.
 *   Bu yüzden zar, önce DURUMA bakar (kullanıcı mesajı mı, tool sonucu mu;
 *   hangi tool'lar sunulmuş), sonra o durumda GEÇERLİ olan seçenekler arasından
 *   atar. Rastgelelik cevabın içeriğinde, protokol uyumunda değil.
 *
 * Yüzlerce alternatif tek tek yazılmadı; üç parçalı şablonlar birleşimsel
 * olarak binlerce farklı metin üretir. Sayı başlangıçta ekrana basılır.
 */
const Z = {
  acilis: [
    "Bakıyorum,", "Tamam,", "Şöyle görünüyor:", "Kontrol ettim,", "Elimdeki veriye göre,",
    "Kısaca:", "Özetlersem,", "Sonuç şu:", "Baktım ve", "Durum şu:",
  ],
  govde: [
    "açık kayıtlarınızı listeledim",
    "takviminizi okudum ve gerçek toplantıları ayıkladım",
    "zaman girişi bağlamını çektim",
    "önerilen planı hazırladım",
    "kayıtları eşleştirdim",
    "süreleri hesapladım",
    "çakışan toplantıları tek kez saydım",
    "yuvarlama gereken süreleri işaretledim",
    "hangi kaydın hangi toplantıya ait olduğunu çıkardım",
    "belirsiz kalan eşleşmeleri ayırdım",
    "günlük toplamı kontrol ettim",
    "yazma planını çıkardım",
  ],
  kapanis: [
    "Devam edeyim mi?",
    "Onaylarsanız yazayım.",
    "Hangisiyle başlayalım?",
    "Detay ister misiniz?",
    "Yazmadan önce planı göstereyim mi?",
    "Bir şey eklemek ister misiniz?",
    "Devamında ne yapmamı istersiniz?",
    "Bu haliyle uygun mu?",
    "Eksik gördüğünüz bir şey var mı?",
    "Onay verirseniz kaydediyorum.",
  ],
  soruBasi: [
    "Bir noktayı netleştireyim:",
    "Emin olmak için soruyorum:",
    "Tahmin etmek istemiyorum:",
    "Burada karar sizin:",
    "İki seçenek var:",
    "Belirsiz bir yer var:",
    "Sormadan geçmeyeyim:",
    "Şunu doğrulayalım:",
  ],
  soruGovde: [
    "hangi kayda yazalım?",
    "süreyi yuvarlayayım mı?",
    "tarih bugün mü, dün mü?",
    "bu toplantıyı atlayayım mı?",
    "hangi strateji uygulansın?",
    "başlangıç saatini koruyalım mı?",
  ],
};
const ZAR_METIN_SAYISI =
  Z.acilis.length * Z.govde.length * Z.kapanis.length +
  Z.soruBasi.length * Z.soruGovde.length;

/** Sunulan tool'lar içinden, niyete uyanları ağırlıklandırarak seç. */
function zarToolSec(o) {
  const t = katla(o.sonKullaniciMetni);
  const sunulan = o.mevcutToollar;
  const uygun = [];
  const ekle = (ad, agirlik) => {
    if (sunulan.includes(ad)) for (let i = 0; i < agirlik; i++) uygun.push(ad);
  };

  // Niyete uyanlar ağır basar; ama diğer okuma tool'ları da havuzda kalır ki
  // her koşu birebir aynı olmasın.
  if (/takvim|toplant|bugun/.test(t)) ekle("calendar_list_today", 6);
  if (/acik|talep|gorev|isler|liste/.test(t)) ekle("xurrent_list_open_work", 6);
  if (/kim|ben |hesap/.test(t)) ekle("xurrent_whoami", 6);
  if (/yaz|kaydet|gir|plan/.test(t)) {
    ekle("xurrent_get_time_tracking_context", 5);
    ekle("plan_time_entries_from_calendar", 3);
  }

  // Havuz boşsa: yalnızca OKUMA tool'larından seç. Zar asla kendiliğinden
  // yazma tool'u çağırmaz — yanlışlıkla kayıt oluşturmak ders değil, kaza olur.
  if (!uygun.length) {
    for (const ad of ["xurrent_whoami", "xurrent_list_open_work",
                      "xurrent_get_time_tracking_context", "calendar_list_today",
                      "plan_time_entries_from_calendar"]) ekle(ad, 1);
  }
  return uygun.length ? sec(uygun) : null;
}

const ZAR_ARGS = {
  xurrent_whoami: () => ({}),
  xurrent_list_open_work: () => ({ personId: "$me", ...(rnd() < 0.3 ? { first: 10 * zarAt(5) } : {}) }),
  xurrent_get_time_tracking_context: () => ({ personId: "$me" }),
  calendar_list_today: () => ({ provider: "mock", ...(rnd() < 0.25 ? { includeDeclined: true } : {}) }),
  plan_time_entries_from_calendar: () => ({ personId: "$me",
    ...(rnd() < 0.3 ? { roundingMode: sec(["nearest", "up", "down"]) } : {}) }),
};

function zarYanit(o) {
  // Tool sonucu döndüyse: ya zinciri sürdür ya özetle bitir.
  if (o.tur === "tool-sonucu-donuyor") {
    const zincir = {
      xurrent_whoami: "xurrent_list_open_work",
      xurrent_list_open_work: "xurrent_get_time_tracking_context",
      calendar_list_today: "plan_time_entries_from_calendar",
    }[o.donenToolSonucu.name];

    if (zincir && o.mevcutToollar.includes(zincir) && rnd() < 0.6)
      return cagri(zincir, (ZAR_ARGS[zincir] ?? (() => ({})))());

    return metin(`${sec(Z.acilis)} ${sec(Z.govde)}. ${sec(Z.kapanis)}`);
  }

  // Kullanıcı mesajı: çoğunlukla tool çağır, bazen soru sor.
  const soruMu = rnd() < 0.15;
  if (soruMu) return metin(`${sec(Z.soruBasi)} ${sec(Z.soruGovde)}`);

  const tool = zarToolSec(o);
  if (!tool) return metin(`${sec(Z.acilis)} ${sec(Z.govde)}. ${sec(Z.kapanis)}`);
  return cagri(tool, (ZAR_ARGS[tool] ?? (() => ({})))());
}

// ── MOD: kayit ──────────────────────────────────────────────────────────────
function kayitOku(k) {
  const f = path.join(KAYITLAR, `${k}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}
function kayitYaz(k, ozet, yanit) {
  fs.writeFileSync(path.join(KAYITLAR, `${k}.json`), JSON.stringify({
    _aciklama: "sahte-gemini kaydı. 'sor' modunda verilen yanıt buraya düştü; 'kayit' modunda tekrar oynatılır.",
    anahtar: k, ozet, yanit,
  }, null, 2) + "\n");
}

// ── MOD: sor ────────────────────────────────────────────────────────────────
/**
 * ★ İsteği dosyaya yazar, yanıt dosyasını bekler.
 *
 * Neden dosya: hiçbir protokol icat etmeden, herhangi bir insan veya ajan
 * (Claude Code dahil) Read/Write ile araya girebilsin diye. Kuyruk gözle
 * okunur, yanıt elle yazılabilir; tools/fake-gemini/yanitla.mjs kolaylaştırır.
 */
async function sorVeBekle(ozet, ham) {
  const n = ++sayac;
  const istekDosya = path.join(KUYRUK, `istek-${String(n).padStart(3, "0")}.json`);
  const yanitDosya = path.join(KUYRUK, `yanit-${String(n).padStart(3, "0")}.json`);

  fs.writeFileSync(istekDosya, JSON.stringify({
    _nasil: [
      "Bu isteğe yanıt vermek için AŞAĞIDAKİ yolu yaz:",
      yanitDosya,
      "",
      "Metin yanıtı:        { \"metin\": \"...\" }",
      "Tool çağrısı:        { \"cagri\": { \"name\": \"xurrent_list_open_work\", \"args\": { \"personId\": \"$me\" } } }",
      "Kolay yol:           node tools/fake-gemini/yanitla.mjs " + n + " --metin \"...\"",
      "                     node tools/fake-gemini/yanitla.mjs " + n + " --cagri xurrent_whoami",
    ],
    ozet,
    hamIstek: ham,
  }, null, 2) + "\n");

  log("");
  log(`┌─ İSTEK #${n} — YANIT BEKLENİYOR`);
  log(`│  tür      : ${ozet.tur}`);
  if (ozet.sonKullaniciMetni) log(`│  kullanıcı: ${ozet.sonKullaniciMetni.slice(0, 100)}`);
  if (ozet.donenToolSonucu) log(`│  tool     : ${ozet.donenToolSonucu.name} sonucu döndü`);
  log(`│  tool'lar : ${ozet.mevcutToollar.length} adet`);
  log(`│  istek    : ${istekDosya}`);
  log(`└─ yanıt   : ${yanitDosya}`);
  log("");

  const bitis = Date.now() + BEKLEME_SN * 1000;
  while (Date.now() < bitis) {
    if (fs.existsSync(yanitDosya)) {
      const y = JSON.parse(fs.readFileSync(yanitDosya, "utf8"));
      const yanit = y.cagri
        ? cagri(y.cagri.name, y.cagri.args, y.cagri.id)
        : metin(y.metin ?? "(boş yanıt)");
      // Bir kez cevaplandı; sonsuza kadar oynatılabilsin.
      kayitYaz(anahtar(ozet), ozet, yanit);
      log(`✔ İSTEK #${n} yanıtlandı ve kayda geçti (${anahtar(ozet)})`);
      fs.rmSync(istekDosya, { force: true });
      fs.rmSync(yanitDosya, { force: true });
      return yanit;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  log(`✘ İSTEK #${n} zaman aşımı (${BEKLEME_SN} sn)`);
  return metin(`Sahte Gemini: yanıt ${BEKLEME_SN} saniyede gelmedi, istek zaman aşımına uğradı.`);
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const gonder = (kod, govde) => {
    res.writeHead(kod, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(govde));
  };
  const hata = (kod, mesaj, status) =>
    gonder(kod, { error: { code: kod, message: mesaj, status: status ?? "INVALID_ARGUMENT" } });

  const url = new URL(req.url, "http://x");

  if (req.method === "GET" && url.pathname === "/saglik")
    return gonder(200, { ok: true, mod: MOD, kuyruk: KUYRUK, kayitlar: KAYITLAR });

  if (req.method !== "POST") return hata(405, "Yalnızca POST desteklenir.");

  // Gerçek API anahtarı x-goog-api-key header'ında bekler. URL'e koymak
  // anahtarın erişim loglarına düşmesi demektir; sahte sunucu da aynı kuralı zorlar.
  if (!req.headers["x-goog-api-key"])
    return hata(401, "x-goog-api-key header'ı eksik. Anahtarı URL'e KOYMAYIN — log'a düşer.", "UNAUTHENTICATED");

  const m = /^\/v1beta\/models\/([^:]+):(generateContent|streamGenerateContent)$/.exec(url.pathname);
  if (!m) return hata(404, `Bilinmeyen yol: ${url.pathname}. Beklenen: /v1beta/models/{model}:generateContent`, "NOT_FOUND");

  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 8e6) req.destroy(); });
  req.on("end", async () => {
    let body;
    try { body = JSON.parse(raw); } catch { return hata(400, "Gövde geçerli JSON değil."); }
    if (!Array.isArray(body.contents) || body.contents.length === 0)
      return hata(400, "contents alanı zorunludur ve boş olamaz.");

    const ozet = ozetle(body);
    const k = anahtar(ozet);
    log(`${MOD.padEnd(9)} ${m[1].padEnd(20)} ${ozet.tur.padEnd(22)} tool=${ozet.mevcutToollar.length}`);

    try {
      if (MOD === "otomatik") return gonder(200, otomatikYanit(ozet));
      if (MOD === "zar") return gonder(200, zarYanit(ozet));

      if (MOD === "kayit") {
        const kayit = kayitOku(k);
        if (!kayit) {
          // Uydurmak yerine açıkça söyle: eksik kayıt sessizce yanlış cevaptan iyidir.
          return hata(404,
            `Kayıt bulunamadı: '${k}'. Bu senaryo henüz cevaplanmamış. ` +
            `'--mod sor' ile bir kez cevaplayın; yanıt otomatik olarak kayda geçer.`, "NOT_FOUND");
        }
        return gonder(200, kayit.yanit);
      }

      return gonder(200, await sorVeBekle(ozet, body));
    } catch (e) {
      log("iç hata:", e?.message);
      return hata(500, `Sahte Gemini iç hatası: ${e?.message}`, "INTERNAL");
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`dinleniyor : http://127.0.0.1:${PORT}`);
  log(`mod        : ${MOD}`);
  if (MOD === "zar") {
    log(`tohum      : ${TOHUM}   ← aynı koşuyu tekrarlamak için: --tohum ${TOHUM}`);
    log(`metin havuzu: ${ZAR_METIN_SAYISI} farklı cümle (birleşimsel)`);
  }
  if (MOD === "sor") log(`kuyruk     : ${KUYRUK}`);
  log(`kayıtlar   : ${KAYITLAR} (${fs.readdirSync(KAYITLAR).filter((f) => f.endsWith(".json")).length} kayıt)`);
  log("");
});
