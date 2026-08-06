#!/usr/bin/env node
/**
 * SAHTE XURRENT — SENARYO KOŞUCUSU
 * ═════════════════════════════════
 *
 * Sahte sunucuyu ayağa kaldırır, sonra ÜÇ SUNUCUYU DA `XURRENT_MODE=live` ile
 * ona karşı çalıştırır. Amaç: repo'nun bilinen boşluğunu — live kod yolunun hiç
 * çalıştırılmamış olması — kapatmak.
 *
 * ★ NE KANITLAR: HTTP katmanı, auth header'ları, GraphQL sorgu metinlerinin
 *   sunucu tarafından tanınması, errors şekillerinin doğru ele alınması,
 *   two_step'in iki isteği, artımlı timeSpent, rate limit throttling,
 *   429 fırtınasında retry politikası (f) ve kısmi bulk'ın dedup'la güvenli
 *   tekrar-çalıştırılması (g) — bkz. contract/reliability.md.
 *
 * ★ NE KANITLAMAZ: gerçek Xurrent'ın şemasının bizimkiyle aynı olduğunu.
 *   Bkz. README.md.
 *
 * Kullanım:  node tools/fake-xurrent/senaryolar.mjs [--dil ts|py|cs]
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PORT = 4000 + Math.floor(Math.random() * 900);
const URL_ = `http://127.0.0.1:${PORT}`;

const C = { g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };

const SERVERS = {
  ts: ["node", ["servers/typescript/dist/mcp/stdio.js"]],
  py: ["uv", ["--directory", "servers/python", "run", "xurrent-mcp"]],
  cs: ["dotnet", ["run", "--project", "servers/csharp/XurrentMcp.csproj", "--no-build", "--", "stdio"]],
};

const only = process.argv.includes("--dil")
  ? process.argv[process.argv.indexOf("--dil") + 1]
  : null;
const DILLER = only ? { [only]: SERVERS[only] } : SERVERS;

const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "senaryolar", version: "1.0.0" },
};

// ── sahte sunucu ────────────────────────────────────────────────────────────
let fake, fakeLog = "";

function startFake(extraArgs = []) {
  return new Promise((res, rej) => {
    fake = spawn("node", [path.join(HERE, "server.mjs"), "--port", String(PORT), ...extraArgs], {
      cwd: REPO, stdio: ["ignore", "ignore", "pipe"],
    });
    fake.stderr.on("data", (d) => { fakeLog += d.toString(); });
    const t = setTimeout(() => rej(new Error("sahte sunucu açılmadı")), 10000);
    const wait = setInterval(() => {
      if (fakeLog.includes("dinleniyor")) { clearTimeout(t); clearInterval(wait); res(); }
    }, 100);
  });
}

function stopFake() {
  try { fake.kill(); } catch {}
  return new Promise((z) => setTimeout(z, 200));
}

/** Sahte sunucuya DOĞRUDAN GraphQL isteği — senaryoların "bağımsız gözü". */
async function fakeQuery(query, variables = {}) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer senaryo-gozu",
      "x-xurrent-account": "ornek-bt",
    },
    body: JSON.stringify({ query, variables }),
  });
  return r.json();
}

/** Kaos bayraklarını süreç öldürmeden değiştirir (bkz. server.mjs /_kaos). */
async function kaosAyarla(patch) {
  await fetch(`${URL_}/_kaos`, { method: "POST", body: JSON.stringify(patch) });
}

/** Sahte sunucunun gördüğü istek sayısı — stderr satırlarından sayılır. */
const requestCount = () => (fakeLog.match(/\b(ok|GraphQL-HATA)\s*$/gm) ?? []).length;
const resetLog = () => { fakeLog = fakeLog.slice(-200); };

// ── MCP çağrısı (live modda) ────────────────────────────────────────────────
function callTool(dil, tool, args, extraEnv = {}) {
  const [cmd, argv] = SERVERS[dil];
  return new Promise((res) => {
    const p = spawn(cmd, argv, {
      cwd: REPO,
      env: {
        ...process.env,
        XURRENT_MODE: "live",
        XURRENT_GRAPHQL_URL: URL_,
        XURRENT_TOKEN: "sahte-token",
        XURRENT_ACCOUNT: "ornek-bt",
        XURRENT_DRY_RUN: "0",
        XURRENT_CONFIRM_POLICY: "open",   // senaryolarda onay kanalı yok
        MCP_PROTOCOL: "2026-07-28",
        ...apiEnv,                        // rest koşusunda XURRENT_API + XURRENT_REST_URL
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    // Sunucunun stderr'i toplanır: [retry]/[dedup] izleri buradan sayılır
    // (contract/reliability.md §6 — izler stdout'a YAZILAMAZ, stdio MCP kanalıdır).
    let errBuf = "";
    p.stderr.on("data", (d) => { errBuf += d.toString(); });
    const bitir = (sonuc) => res({ stderr: errBuf, ...sonuc });
    const t = setTimeout(() => { try { p.kill(); } catch {} bitir({ timeout: true }); }, 120000);
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!l) continue;
        clearTimeout(t); try { p.kill(); } catch {}
        try { return bitir({ msg: JSON.parse(l) }); } catch { return bitir({ raw: l }); }
      }
    });
    p.on("error", (e) => { clearTimeout(t); bitir({ err: e.message }); });
    p.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { _meta: META, name: tool, arguments: args },
    }) + "\n");
  });
}

/** Sunucu stderr'indeki [retry] izlerini sayar; reason filtresi opsiyonel. */
function retryIzleri(r, reason = null) {
  const satirlar = (r.stderr ?? "").split("\n").filter((l) => l.includes("[retry]"));
  return reason ? satirlar.filter((l) => l.includes(`reason=${reason}`)) : satirlar;
}

const sc = (r) => r.msg?.result?.structuredContent;
const isErr = (r) => r.msg?.result?.isError === true;
const text = (r) => r.msg?.result?.content?.[0]?.text ?? "";

/**
 * Başarısızlığın GERÇEK sebebini yazar.
 *
 * Önceki hâli `isErr(r) ? text(r) : "errors=[]"` idi ve isError=false ama
 * structuredContent.errors DOLU olduğunda ekrana "errors=[]" basıyordu —
 * yani kontrol kırmızıyken kanıt yeşil görünüyordu. Bir sonraki kişiyi
 * yanlış yola sokan tam olarak buydu; hatayı bulmak yarım saat aldı.
 */
function nedenBasarisiz(r) {
  const hatalar = sc(r)?.errors ?? [];
  if (hatalar.length) {
    return hatalar.map((e) => e?.message ?? JSON.stringify(e)).join(" | ").slice(0, 160);
  }
  if (isErr(r)) return "isError=true · " + text(r).replace(/\s+/g, " ").slice(0, 140);
  if (r.timeout) return "zaman aşımı";
  if (r.err) return "süreç hatası: " + r.err;
  return "errors=[] (beklenen sonuç)";
}

// ── tarih: SUNUCULARIN kullandığı saat diliminde ────────────────────────────
/**
 * ★ toISOString() KULLANMA. O UTC tarihi verir; üç sunucu ise "bugün"ü
 * XURRENT_TIMEZONE'da (varsayılan Europe/Istanbul, UTC+3) hesaplar.
 *
 * Yerel 00:00–03:00 arasında UTC tarihi bir gün geridedir. Oradan bir gün daha
 * çıkarınca istenen T-1, sunucunun gözünde T-2 olur ve XURRENT_MAX_BACKDATE_DAYS=1
 * yüzünden yazma HAKLI OLARAK reddedilir. Sonuç: yalnızca gecenin belirli üç
 * saatinde kırmızıya dönen bir test.
 *
 * Bu, projenin kendi dersinin bir örneği: kırmızı test önce kendini suçlamalı.
 * Sunucular doğru davranıyordu; ölçen taraf yanlış tarihi soruyordu.
 */
const TZ = process.env.XURRENT_TIMEZONE || "Europe/Istanbul";

/** TZ'de gün farkıyla tarih, YYYY-MM-DD. gunFarki=0 bugün, -1 dün. */
function tarihTZ(gunFarki = 0) {
  const bugun = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  // Gün aritmetiğini UTC öğlen üzerinden yap: DST ve gün sınırı kaymalarından etkilenmez.
  const d = new Date(`${bugun}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + gunFarki);
  return d.toISOString().slice(0, 10);
}

// ── sonuç toplama ───────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const rows = [];
// Aktif koşunun API'si ve check öneki — REST koşusunda "[rest]" etiketi düşer.
let apiEnv = {};
let checkOnek = "";
function check(dil, ad, ok, detay) {
  ok ? pass++ : fail++;
  const tamAd = checkOnek + ad;
  rows.push({ dil, ad: tamAd, ok, detay });
  console.log(`  ${ok ? C.g + "✔" : C.r + "✘"}${C.x} ${tamAd.padEnd(46)} ${C.d}${detay}${C.x}`);
}

// ── senaryolar ──────────────────────────────────────────────────────────────
async function kos(dil, opts = {}) {
  const api = opts.api ?? "graphql";
  console.log(`\n${C.b}══ ${dil.toUpperCase()} — live mod (${api}), sahte Xurrent'a karşı ══${C.x}`);

  // a) PARİTE — live sonuçları mock ile birebir aynı mı?
  {
    const r = await callTool(dil, "xurrent_list_open_work", { personId: "$me" });
    const s = sc(r);
    check(dil, "a) açık iş paritesi (mock = live)",
      s?.requests?.totalCount === 3 && s?.tasks?.totalCount === 3,
      `requests=${s?.requests?.totalCount} tasks=${s?.tasks?.totalCount} (beklenen 3/3)`);
  }
  {
    const r = await callTool(dil, "xurrent_get_time_tracking_context", { personId: "$me" });
    const s = sc(r);
    check(dil, "a) timeIncrement + effortClass eleme",
      s?.timeIncrement === 30 && s?.effortClasses?.length === 3,
      `timeIncrement=${s?.timeIncrement} effortClasses=${s?.effortClasses?.length} (beklenen 30 / 3)`);
  }

  // c) timeIncrement ihlali — sunucu reddediyor, istemci BAŞARISIZ diye raporluyor mu?
  {
    const r = await callTool(dil, "xurrent_create_time_entry", {
      targetType: "request", targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4",
      minutes: 45, description: "timeIncrement ihlali", dryRun: false,
    });
    const s = sc(r);
    const yakalandi = isErr(r) || (s?.errors?.length ?? 0) > 0;
    check(dil, "c) timeIncrement ihlali BAŞARISIZ sayılıyor", yakalandi,
      yakalandi ? "reddedildi (doğru)" : `SESSİZCE GEÇTİ — ${text(r).slice(0, 60)}`);
  }

  // b) two_step GERÇEKTEN iki istek gönderiyor mu ve bağ korunuyor mu?
  {
    resetLog();
    const oncesi = requestCount();
    const r = await callTool(dil, "xurrent_create_time_entry", {
      targetType: "request", targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4",
      // T-1, SUNUCUNUN saat diliminde. XURRENT_MAX_BACKDATE_DAYS=1 sınırındayız;
      // UTC'den türetmek gece yarısı–03:00 arasında T-2 üretir ve reddedilir.
      minutes: 60, date: tarihTZ(-1),
      description: "two_step live", dryRun: false, backdateStrategy: "two_step",
    });
    await new Promise((z) => setTimeout(z, 300));
    const istek = requestCount() - oncesi;
    const s = sc(r);
    // Yazma yolu en az iki mutation göndermeli (parent update + timeEntryUpdate).
    check(dil, "b) two_step ≥2 istek gönderdi", istek >= 2, `${istek} istek görüldü`);

    // Detay nedenBasarisiz() üzerinden gelir; kırmızı bir kontrolün yanında
    // yeşil görünen bir kanıt basmamak için. Başarılı hâlde de kullanılan
    // tarihi ve saat dilimini yaz — bu kontrol bir kez saat dilimi yüzünden
    // kırıldı, bir dahakine kanıt ekranda dursun.
    check(dil, "b) yazma başarılı, errors boş",
      !isErr(r) && (s?.errors?.length ?? 0) === 0,
      (s?.errors?.length ?? 0) === 0 && !isErr(r)
        ? `errors=[] · planned=${s?.planned?.length ?? 0} · date=${tarihTZ(-1)} (TZ ${TZ})`
        : nedenBasarisiz(r));
  }

  // d) HTTP 200 + errors dolu → istemci bunu BAŞARI sanmamalı
  {
    const r = await callTool(dil, "xurrent_create_time_entry", {
      targetType: "time_allocation", targetId: "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
      minutes: -60, description: "negatif, correction yok", dryRun: false,
    });
    const s = sc(r);
    const yakalandi = isErr(r) || (s?.errors?.length ?? 0) > 0;
    check(dil, "d) HTTP 200 + errors dolu = BAŞARISIZ", yakalandi,
      yakalandi ? "hata olarak raporlandı" : "SESSİZCE BAŞARILI SAYILDI");
  }

  // e) rate limit — bulk throttling olmadan 20/2sn sınırına takılır
  {
    resetLog();
    const entries = Array.from({ length: 8 }, (_, i) => ({
      targetType: "time_allocation", targetId: "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
      minutes: 30, description: `bulk ${i + 1}`,
    }));
    const r = await callTool(dil, "xurrent_create_time_entries_bulk", { entries, dryRun: false, stopOnError: false });
    const s = sc(r);
    const olusan = s?.summary?.created ?? 0;
    check(dil, "e) bulk throttling (8 kayıt, 429 yok)", olusan === 8,
      `created=${olusan}/8 failed=${s?.summary?.failed ?? "?"}`);
  }

  // f) KAOS: 429 fırtınası — retry politikası devrede mi? (contract/reliability.md)
  // 429 "kesin-işlenmedi" sınıfıdır: istemci Retry-After'a uyup tekrarlamalı,
  // akış BAŞARIYLA bitmeli ve kayıt ÇİFTLENMEMELİDİR.
  // (REST koşusunda atlanır: retry katmanı transport-üstü aynı katmandır,
  //  kanıtı GraphQL koşusunda bir kez verilir; süre bütçesi — bkz. docs/15.)
  if (!opts.sadeceTemel) {
    await kaosAyarla({ k429: 3 });
    const r = await callTool(dil, "xurrent_create_time_entry", {
      targetType: "time_allocation", targetId: "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
      minutes: 30, description: "kaos 429 firtinasi", dryRun: false,
    });
    const s = sc(r);
    const izler = retryIzleri(r, "429");
    check(dil, "f) 429 fırtınası: retry ile yazma başarılı",
      !isErr(r) && (s?.errors?.length ?? 0) === 0 && izler.length >= 1,
      !isErr(r) && (s?.errors?.length ?? 0) === 0
        ? `errors=[] · [retry reason=429] izi=${izler.length}`
        : `${nedenBasarisiz(r)} · [retry] izi=${izler.length}`);

    // Bağımsız göz: senaryo koşucusu fake'e DOĞRUDAN bakar — istemcinin
    // raporuna güvenmek, karneyi öğrenciye yazdırmaktır.
    const q = await fakeQuery(
      "query Goz { timeEntries(filter: {date: $date}) { nodes { id description } } }",
      { date: tarihTZ(0) });
    const adet = (q.data?.timeEntries?.nodes ?? [])
      .filter((n) => n.description === "kaos 429 firtinasi").length;
    check(dil, "f) çift kayıt yok (tam-bir-kez)", adet === 1,
      `aynı kayıttan ${adet} adet (beklenen 1)`);
  }

  // g) KAOS: kısmi bulk → AYNI komutun tekrarı eksiği tamamlar, çifti önler.
  // Bulk atomik değildir; kurtarma yolu "tekrar çalıştır"dır ve bunun güvenli
  // olması sourceID dedup geri-okumasına dayanır (reliability.md §5).
  if (!opts.sadeceTemel) {
    await kaosAyarla({ kirDesc: "kirik-kalem" });
    const entries = Array.from({ length: 4 }, (_, i) => ({
      targetType: "time_allocation", targetId: "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
      minutes: 30, description: i === 2 ? "kirik-kalem g" : `tekrar kalem ${i + 1}`,
    }));
    // Amaç retry değil KURTARMA: denemeyi 2'ye indirip kırık kalemi hızlı düşür.
    const env = { XURRENT_RETRY_MAX_ATTEMPTS: "2" };

    const r1 = await callTool(dil, "xurrent_create_time_entries_bulk",
      { entries, dryRun: false, stopOnError: false }, env);
    const s1 = sc(r1);
    check(dil, "g) kaoslu bulk: 3 yazıldı, 1 düştü",
      s1?.summary?.created === 3 && s1?.summary?.failed === 1,
      `created=${s1?.summary?.created} failed=${s1?.summary?.failed} (beklenen 3/1)`);

    await kaosAyarla({ kirDesc: null });
    const r2 = await callTool(dil, "xurrent_create_time_entries_bulk",
      { entries, dryRun: false, stopOnError: false }, env);
    const s2 = sc(r2);
    check(dil, "g) tekrar: eksik tamamlandı, kalanlar deduped",
      s2?.summary?.created === 1 && (s2?.summary?.deduped ?? 0) === 3,
      `created=${s2?.summary?.created} deduped=${s2?.summary?.deduped ?? 0} (beklenen 1/3)`);

    const q = await fakeQuery(
      "query Goz { timeEntries(filter: {date: $date}) { nodes { id description } } }",
      { date: tarihTZ(0) });
    const nodes = q.data?.timeEntries?.nodes ?? [];
    const adetler = entries.map((e) => nodes.filter((n) => n.description === e.description).length);
    check(dil, "g) çift kayıt yok (4 kalem × 1)",
      adetler.length === 4 && adetler.every((a) => a === 1),
      `adetler=[${adetler.join(",")}] (beklenen hepsi 1)`);
  }
}

// ── ana akış ────────────────────────────────────────────────────────────────
console.log(`${C.b}Sahte Xurrent senaryoları${C.x}  ${C.d}${URL_}${C.x}`);
console.log(`${C.y}Not:${C.x} bu koşu "Xurrent'a karşı doğrulandı" anlamına GELMEZ — yalnızca live`);
console.log(`kod yolunun wire seviyesinde çalıştığını gösterir. Bkz. tools/fake-xurrent/README.md\n`);

// ★ HER DİL İÇİN TAZE SUNUCU.
//
// Neden: sahte sunucu yazmaları bellekte biriktirir ve fixtures'taki
// allowWorkdayOvertime=false + workday=480 kısıtını GERÇEKTEN uygular. Üç dil
// aynı örneğe yazarsa ilk ikisi günlük bütçeyi tüketir ve üçüncüsünün yazmaları
// reddedilir — sonuç, sırf sırada sonda olduğu için başarısız görünen bir dil.
//
// Bu, paylaşılan değişebilir durumun ürettiği KLASİK yanlış alarmdır. İlk
// koşuda tam olarak bu oldu: C# 2 senaryoda düştü, izole çalıştırınca ikisini de
// geçti. Testin kendisi bozuktu, kod değil.
for (const dil of Object.keys(DILLER)) {
  // 1) GraphQL koşusu — tam set (a–g)
  apiEnv = {};
  checkOnek = "";
  await startFake();
  try {
    await kos(dil);
  } finally {
    try { fake.kill(); } catch {}
    await new Promise((z) => setTimeout(z, 200));
    fakeLog = "";
  }

  // 2) REST koşusu — temel set (a–e). AYNI tool sözleşmesi, İKİNCİ transport:
  // parite kanıtı "transport bir adaptör detayıdır" tezinin ta kendisi (docs/16).
  apiEnv = { XURRENT_API: "rest", XURRENT_REST_URL: `${URL_}/v1` };
  checkOnek = "[rest] ";
  await startFake();
  try {
    await kos(dil, { api: "rest", sadeceTemel: true });
  } finally {
    try { fake.kill(); } catch {}
    await new Promise((z) => setTimeout(z, 200));
    fakeLog = "";
    apiEnv = {};
    checkOnek = "";
  }
}

// h) ÇAPRAZ-DİL DEVİR — sohbet TS'te başlar, Python'da sürer, C#'ta biter.
//
// timesheet_wizard'ın sessionState'i HMAC'i payload BYTE'LARI üzerinde hesaplar
// (contract/wizard.md §4): kanonikleştirme gerekmez, bu yüzden bir dilin
// ürettiği state başka dile verilebilir. Sır ÜÇ süreçte de aynı olmak zorunda —
// boş bırakılsaydı her süreç rastgele üretir ve devir sessizce çökerdi.
if (!only) {
  console.log(`\n${C.b}══ H — çapraz-dil devir (ts → py → cs) ══${C.x}`);
  await startFake();
  const ORTAK = { XURRENT_STATE_SECRET: "senaryo-h-ortak-sirri-0123456789ab" };
  try {
    const r1 = await callTool("ts", "timesheet_wizard", {}, ORTAK);
    const s1 = sc(r1);
    check("h", "h) TS: sohbet başladı (step=start)",
      s1?.step === "start" && !!s1?.sessionState && s1?.done === false,
      `step=${s1?.step} state=${s1?.sessionState ? "var" : "YOK"}`);

    const r2 = await callTool("ts", "timesheet_wizard",
      { utterance: "1", sessionState: s1?.sessionState }, ORTAK);
    const s2 = sc(r2);
    check("h", "h) TS: iş seçildi (step=pick_work)",
      s2?.step === "pick_work" && !!s2?.sessionState,
      `step=${s2?.step}`);

    const r3 = await callTool("py", "timesheet_wizard",
      { utterance: "2 saat", sessionState: s2?.sessionState }, ORTAK);
    const s3 = sc(r3);
    check("h", "h) PY: TS'in state'ini kabul etti (step=duration)",
      s3?.step === "duration" && !!s3?.sessionState,
      `step=${s3?.step} (start'a düşmedi = imza çapraz-dil doğrulandı)`);
    check("h", "h) PY: 120 dk çevirimi söylendi",
      (s3?.reply ?? "").includes("120"),
      (s3?.reply ?? "").includes("120") ? "reply 120 içeriyor" : `reply: ${String(s3?.reply).slice(0, 80)}`);

    const r4 = await callTool("cs", "timesheet_wizard",
      { utterance: "dün 14:00 VPN bakımı", sessionState: s3?.sessionState }, ORTAK);
    const s4 = sc(r4);
    check("h", "h) CS: PY'nin state'ini kabul etti (step=detail)",
      s4?.step === "detail" && (s4?.nextQuestion?.choices?.length ?? 0) === 3,
      `step=${s4?.step} strateji-seçenekleri=${s4?.nextQuestion?.choices?.length ?? 0} (beklenen 3)`);
  } finally {
    try { fake.kill(); } catch {}
    await new Promise((z) => setTimeout(z, 200));
    fakeLog = "";
  }
} else {
  console.log(`\n${C.d}(h çapraz-dil devir senaryosu --dil ile atlandı: iki dil gerekir)${C.x}`);
}

console.log(`\n${C.b}═══ ÖZET ═══${C.x}`);
console.log(`  ${C.g}${pass} geçti${C.x} · ${fail ? C.r : C.d}${fail} başarısız${C.x}`);
if (fail) {
  console.log(`\n  ${C.r}Başarısız olanlar:${C.x}`);
  for (const r of rows.filter((x) => !x.ok)) console.log(`    [${r.dil}] ${r.ad} — ${r.detay}`);
}
process.exit(fail ? 1 : 0);
