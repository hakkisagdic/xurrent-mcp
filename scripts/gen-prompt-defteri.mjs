#!/usr/bin/env node
/**
 * PROMPT DEFTERİ ÜRETİCİ
 *
 * docs/atolye/adimlar.json → docs/11-prompt-defteri.md
 *
 * NEDEN ÜRETİLİYOR, ELLE YAZILMIYOR: prompt'ların tek bir kaynağı olmalı.
 * Atölye koşucusu (clients/atolye/atolye.mjs) da aynı dosyayı okuyor. Defteri
 * elle yazsaydık, bir prompt değiştiğinde ikisi sessizce ayrışırdı — ders
 * materyallerinin en yaygın ölüm sebebi bu.
 *
 * Kullanım:  node scripts/gen-prompt-defteri.mjs [--kontrol]
 *   --kontrol : üretmez, mevcut dosya güncel mi diye bakar (CI için, exit 1)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KAYNAK = path.join(ROOT, "docs", "atolye", "adimlar.json");
const HEDEF = path.join(ROOT, "docs", "11-prompt-defteri.md");
const KONTROL = process.argv.includes("--kontrol");

const d = JSON.parse(fs.readFileSync(KAYNAK, "utf8"));
const fazAdi = Object.fromEntries(d.fazlar.map((f) => [f.id, f.baslik]));

const ONSOZ = `# 11 — Prompt defteri

> **Bu dosya üretilmiştir.** Kaynak: [\`docs/atolye/adimlar.json\`](atolye/adimlar.json).
> Elle düzenleme; \`node scripts/gen-prompt-defteri.mjs\` ile yeniden üret.

Bu defter, [xurrent-mcp](../README.md) projesini sıfırdan üretmek için sırayla
verilecek prompt'ları içerir. Derste kopyala-yapıştır kullanılmak üzere yazıldı.

---

## Nasıl kullanılır

**Tek oturumda, sırayla.** Prompt'lar birbirinin çıktısına dayanır — 4. adım,
2. adımda bulunan kısıtları bilmek zorundadır. Her prompt'u yeni bir sohbette
çalıştırırsanız bağlam kopar ve sonuç tutmaz.

**Boş bir dizinde başlayın.** İlk prompt kod yazdırmaz; tasarım kararı sorar.

**Her adımdan sonra doğrulayın.** Adımların çoğunda çalıştırılabilir bir doğrulama
komutu var. Geçmeden bir sonrakine geçmeyin — bu dersin yarısı zaten "iddiayı
ölçmeden kabul etme" üzerine.

**Kararları siz verin.** Her adımda bir *karar noktası* var ve seçenekler
listelenmiş. Modelin önerisini onaylamak da bir karardır, ama farkında olarak yapın:
bu projede yanlış çıkan mimari kararlar oldu ve onları ölçüm düzeltti.

### Beklenti yönetimi — dürüst olalım

Bu prompt'ları çalıştırmak bu repoyu **birebir** üretmez. LLM'ler deterministik
değildir; dosya düzeni, değişken adları ve yorumlar farklı çıkar.

Üretmesi gereken şey: **aynı mimari, aynı kısıtlar ve aynı doğrulanabilir sayılar.**
\`requests=3\`, \`tasks=3\`, \`timeIncrement=30\`, takvimde \`8→5\` etkinlik,
\`busyMinutes=225\` vs \`naiveSumMinutes=255\`, \`two_step\` için \`planned.length=2\`.
Bu sayılar tutuyorsa doğru şeyi üretmişsinizdir.

Referans uygulama karşılaştırma için hazır:

\`\`\`bash
node clients/atolye/atolye.mjs --insa ~/atolye-referans
\`\`\`

### Hangi modelle

Bu repo **Claude Opus 5** ile üretildi. Araştırma adımları (2. adım) web
erişimi olan bir ortam ister. Kod yazan adımlar dosya sistemine yazabilen bir
ortam ister — Claude Code, Cursor, ya da benzeri bir agentic araç.

Prompt'lar tek bir modele bağlı değil, ama "kod yazma, önce cevapla" tipi
kısıtlara uymayan bir model bu dersin tamamını bozar: erken kod yazmak zaten
kaçınmaya çalıştığımız hatanın kendisi.

---
`;

const SONSOZ = `
---

## Bu defteri kendi projene uygulamak

Sıra buradaki adımlara özel değil; genellenebilir olan şu:

1. **Önce keşfet, sonra yaz.** Bu projede en pahalı iş kod yazmak değil, API'nin
   gerçekte ne yapabildiğini bulmaktı. \`timeEntryCreate\` bir ticket'a bağlanamaz
   bulgusu tüm mimariyi belirledi; kaçırsaydık iki gün sonra baştan yazardık.

2. **Sözleşmeyi implementasyondan önce yaz.** Dil-bağımsız bir sözleşme, üç
   implementasyonun aynı şeyi üretmesini *sağlar*, ummaz.

3. **Test verisini öğretici tasarla.** Rastgele fixture, rastgele güven verir.
   Kapalı sayılması gereken bir kayıt, çakışan iki toplantı, yuvarlanması gereken
   bir süre koyun — filtreniz gerçekten çalışıyor mu görün.

4. **Mimari kararı ölç.** Bu projede "C# için üç ayrı proje gerekir" kararı
   yazılmıştı; ham JSON-RPC sondası onu çürüttü. Ölçmeseydik gereksiz karmaşıklığı
   ders diye öğretecektik.

5. **Kırmızı test önce kendini suçlasın.** İki kez bir dilin "bozuk" olduğunu
   sandık; ikisinde de testin kendisi bozuktu.

6. **Kısıtı sakla, bahane etme.** Karşılanamayan bir ister varsa kullanıcıya
   söyleyin — sessizce başka bir şey yazmayın.

## İlgili

- [10 — Sıfırdan geliştirme](10-sifirdan-gelistirme.md) — aynı yolun anlatımlı hali
- [Atölye koşucusu](../clients/atolye/README.md) — bu adımları interaktif yürütür
- [00 — Genel bakış](00-genel-bakis.md) — projenin ne olduğu
`;

const parcalar = [ONSOZ];

parcalar.push(`## Adımlar\n`);
parcalar.push("| # | Adım | Faz | Doğrulama |");
parcalar.push("|---|---|---|---|");
d.adimlar.forEach((a, i) => {
  const dg = a.dogrulama ? "var" : "—";
  parcalar.push(`| ${String(i + 1).padStart(2, "0")} | [${a.baslik}](#${i + 1}-${slug(a.baslik)}) | ${fazAdi[a.faz] ?? a.faz} | ${dg} |`);
});
parcalar.push("");

let sonFaz = null;
d.adimlar.forEach((a, i) => {
  const n = i + 1;

  if (a.faz !== sonFaz) {
    parcalar.push(`\n---\n\n# ${fazAdi[a.faz] ?? a.faz}\n`);
    sonFaz = a.faz;
  }

  parcalar.push(`## ${n}. ${a.baslik}\n`);

  // Hikâye — neden bu adım var
  for (const p of a.anlat) parcalar.push(p + "\n");

  // Karar noktası ÖNCE gelir: prompt'u çalıştırmadan önce neyi tartışacağını bil.
  if (a.karar) {
    parcalar.push(`> **Karar noktası:** ${a.karar.soru}\n>`);
    for (const s of a.karar.secenekler) {
      // Girinti YOK: blockquote içinde 4 boşluk kod bloğu olarak render olur.
      const secili = s.etiket === a.karar.secilen;
      const isaret = secili ? "**→**" : "○";
      const etiket = secili ? `**${s.etiket}**` : s.etiket;
      const arti = s.artisi ? ` — ${s.artisi}` : "";
      const eksi = s.eksisi ? ` *(bedeli: ${s.eksisi})*` : "";
      parcalar.push(`> ${isaret} ${etiket}${arti}${eksi}`);
      parcalar.push(">");
    }
    parcalar.push(`>\n> **Bu projede seçilen:** ${a.karar.secilen}. ${a.karar.neden}\n`);
  }

  if (a.prompt) {
    parcalar.push(`### Prompt\n`);
    parcalar.push("```text");
    parcalar.push(a.prompt.trimEnd());
    parcalar.push("```\n");
  } else {
    parcalar.push(`*Bu adımda prompt yok — saf insan kararı.*\n`);
  }

  if (a.uretilenDosyalar?.length) {
    parcalar.push(`### Sonra elinde ne olacak\n`);
    for (const f of a.uretilenDosyalar) parcalar.push(`- \`${f}\``);
    parcalar.push("");
  }

  if (a.dogrulama) {
    const nerede = a.dogrulama.calismaDizini === "hedef" ? "inşa edilen dizinde" : "repo kökünde";
    parcalar.push(`### Doğrula\n`);
    parcalar.push("```bash");
    parcalar.push(a.dogrulama.komut);
    parcalar.push("```\n");
    parcalar.push(`Beklenen çıktı ${nerede}: \`${a.dogrulama.beklenen}\`` +
      (a.dogrulama.atlanabilir ? " *(ön koşul yoksa atlanabilir)*" : "") + "\n");
  }

  if (a.tuzak) {
    parcalar.push(`> ⚠️ **Tuzak:** ${a.tuzak}\n`);
  }

  if (a.ogrenim?.length) {
    parcalar.push(`**Ne öğrendik**\n`);
    for (const o of a.ogrenim) parcalar.push(`- ${o}`);
    parcalar.push("");
  }

  if (a.docs) parcalar.push(`Ayrıntı: [${a.docs}](${path.relative("docs", a.docs) || a.docs})\n`);
});

parcalar.push(SONSOZ);

const cikti = parcalar.join("\n").replace(/\n{3,}/g, "\n\n");

function slug(s) {
  return s.toLowerCase()
    .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" }[c]))
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

if (KONTROL) {
  const mevcut = fs.existsSync(HEDEF) ? fs.readFileSync(HEDEF, "utf8") : "";
  if (mevcut !== cikti) {
    console.error("✘ docs/11-prompt-defteri.md GÜNCEL DEĞİL.");
    console.error("  Çalıştır: node scripts/gen-prompt-defteri.mjs");
    process.exit(1);
  }
  console.log("✔ docs/11-prompt-defteri.md güncel.");
  process.exit(0);
}

fs.writeFileSync(HEDEF, cikti);
const promptlu = d.adimlar.filter((a) => a.prompt).length;
console.log(`✔ docs/11-prompt-defteri.md üretildi`);
console.log(`  ${d.adimlar.length} adım · ${promptlu} prompt · ${d.fazlar.length} faz`);
console.log(`  ${cikti.split("\n").length} satır, ${(cikti.length / 1024).toFixed(1)} KB`);
