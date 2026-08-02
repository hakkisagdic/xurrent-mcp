#!/usr/bin/env node
/**
 * Sahte Gemini "sor" moduna yanıt yazma yardımcısı.
 *
 * Sunucu `--mod sor` ile çalışırken her isteği kuyruk/istek-NNN.json olarak
 * yazar ve kuyruk/yanit-NNN.json dosyasını bekler. Bu script o dosyayı doğru
 * biçimde yazar; zarfı elle kurmaya gerek kalmaz.
 *
 * Kullanım:
 *   node tools/fake-gemini/yanitla.mjs            # bekleyen istekleri listele
 *   node tools/fake-gemini/yanitla.mjs 1 --goster # isteğin tamamını yazdır
 *   node tools/fake-gemini/yanitla.mjs 1 --metin "Açık işleriniz şunlar: ..."
 *   node tools/fake-gemini/yanitla.mjs 1 --cagri xurrent_list_open_work --args '{"personId":"$me"}'
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KUYRUK = path.join(HERE, "kuyruk");

const argv = process.argv.slice(2);
const arg = (ad) => { const i = argv.indexOf(ad); return i >= 0 ? argv[i + 1] : undefined; };
const bayrak = (ad) => argv.includes(ad);

const bekleyenler = () =>
  fs.existsSync(KUYRUK)
    ? fs.readdirSync(KUYRUK).filter((f) => /^istek-\d+\.json$/.test(f)).sort()
    : [];

const no = argv[0] && /^\d+$/.test(argv[0]) ? argv[0].padStart(3, "0") : null;

if (!no) {
  const b = bekleyenler();
  if (!b.length) {
    console.log("Bekleyen istek yok.");
    console.log("Sunucuyu 'sor' modunda başlatın:");
    console.log("  node tools/fake-gemini/server.mjs --mod sor --port 5100");
    process.exit(0);
  }
  console.log(`${b.length} bekleyen istek:\n`);
  for (const f of b) {
    const d = JSON.parse(fs.readFileSync(path.join(KUYRUK, f), "utf8"));
    const n = /istek-(\d+)/.exec(f)[1];
    console.log(`  #${Number(n)}  ${d.ozet.tur}`);
    if (d.ozet.sonKullaniciMetni) console.log(`      kullanıcı: ${d.ozet.sonKullaniciMetni.slice(0, 90)}`);
    if (d.ozet.donenToolSonucu) console.log(`      tool     : ${d.ozet.donenToolSonucu.name} sonucu döndü`);
    console.log(`      tool'lar : ${d.ozet.mevcutToollar.join(", ")}`);
    console.log("");
  }
  console.log("Yanıtla:");
  console.log("  node tools/fake-gemini/yanitla.mjs <no> --metin \"...\"");
  console.log("  node tools/fake-gemini/yanitla.mjs <no> --cagri <tool> --args '{...}'");
  process.exit(0);
}

const istekDosya = path.join(KUYRUK, `istek-${no}.json`);
if (!fs.existsSync(istekDosya)) {
  console.error(`Bekleyen istek yok: #${Number(no)}  (${istekDosya})`);
  process.exit(1);
}

if (bayrak("--goster")) {
  console.log(fs.readFileSync(istekDosya, "utf8"));
  process.exit(0);
}

const metin = arg("--metin");
const cagriAd = arg("--cagri");

if (!metin && !cagriAd) {
  console.error("--metin veya --cagri vermelisiniz. --goster ile isteği inceleyebilirsiniz.");
  process.exit(2);
}

let govde;
if (cagriAd) {
  const ham = arg("--args") ?? "{}";
  let args;
  try { args = JSON.parse(ham); }
  catch { console.error(`--args geçerli JSON değil: ${ham}`); process.exit(2); }

  // Tool gerçekten sunuluyor mu? Olmayan bir tool'u çağırmak istemcide
  // anlamsız bir hataya döner; burada yakalamak daha öğretici.
  const d = JSON.parse(fs.readFileSync(istekDosya, "utf8"));
  if (!d.ozet.mevcutToollar.includes(cagriAd)) {
    console.error(`'${cagriAd}' bu istekte sunulan tool'lar arasında YOK.`);
    console.error(`Sunulanlar: ${d.ozet.mevcutToollar.join(", ")}`);
    process.exit(2);
  }
  govde = { cagri: { name: cagriAd, args } };
} else {
  govde = { metin };
}

const yanitDosya = path.join(KUYRUK, `yanit-${no}.json`);
fs.writeFileSync(yanitDosya, JSON.stringify(govde, null, 2) + "\n");
console.log(`✔ Yanıt yazıldı: ${yanitDosya}`);
console.log(`  ${cagriAd ? `tool çağrısı → ${cagriAd}` : `metin → ${String(metin).slice(0, 70)}`}`);
console.log("  Sunucu bunu alıp kayda geçirecek; sonraki koşularda 'kayit' modunda oynatılabilir.");
