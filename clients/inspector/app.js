// -----------------------------------------------------------------------------
// clients/inspector/app.js — uygulama içi MCP Inspector'ın ön yüzü
//
// Bağımlılık YOK, CDN YOK, derleme adımı YOK. Tarayıcıya olduğu gibi gider.
//
// Bu dosyanın işi "JSON'u güzel göstermek" değil, ONU AÇIKLAMAK. Resmî
// inspector zaten JSON gösteriyor; buradaki değer, her parçanın NE İŞE
// YARADIĞININ yanında yazması.
// -----------------------------------------------------------------------------

"use strict";

// ═══════════════════════════ Yardımcılar ═══════════════════════════

const $ = (sel, kok = document) => kok.querySelector(sel);
const $$ = (sel, kok = document) => Array.from(kok.querySelectorAll(sel));

function el(etiket, ozellikler = {}, ...cocuklar) {
  const n = document.createElement(etiket);
  for (const [k, v] of Object.entries(ozellikler)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of cocuklar.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Minik JSON boyayıcı. Kütüphane kullanmıyoruz: 25 satır ve ders konusu değil. */
function jsonHtml(deger, vurgulaAnahtarlar = []) {
  const metin = JSON.stringify(deger, null, 2) ?? "undefined";
  const vurgu = new Set(vurgulaAnahtarlar);
  return metin.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
    (eslesme) => {
      let sinif = "j-num";
      if (/^"/.test(eslesme)) {
        if (/:$/.test(eslesme)) {
          const ad = eslesme.replace(/"\s*:$/, "").replace(/^"/, "");
          sinif = vurgu.has(ad) ? "j-key j-mark" : "j-key";
        } else sinif = "j-str";
      } else if (/true|false/.test(eslesme)) sinif = "j-bool";
      else if (/null/.test(eslesme)) sinif = "j-null";
      return `<span class="${sinif}">${esc(eslesme)}</span>`;
    },
  );
}

/** Katlanabilir ham-JSON bloğu. */
function blok(baslik, veri, { tag = null, tagSinif = "", acik = false, ms = null, vurgu = [] } = {}) {
  const d = el("details", { class: "blk", ...(acik ? { open: true } : {}) });
  const s = el("summary", {}, tag ? el("span", { class: "blk-tag " + tagSinif, text: tag }) : null, baslik);
  if (ms !== null && ms !== undefined) s.append(el("span", { class: "blk-ms", text: ms + " ms" }));
  d.append(s, el("div", { class: "blk-body" }, el("pre", { class: "code json", html: jsonHtml(veri, vurgu) })));
  return d;
}

function kart(anahtar, deger, alt = null, sinif = "") {
  return el(
    "div",
    { class: "card " + sinif },
    el("div", { class: "k", text: anahtar }),
    el("div", { class: "v", text: deger }),
    alt ? el("div", { class: "s", text: alt }) : null,
  );
}

async function api(yol, secenekler = {}) {
  const r = await fetch(yol, {
    headers: { "content-type": "application/json" },
    ...secenekler,
    body: secenekler.body ? JSON.stringify(secenekler.body) : undefined,
  });
  let govde = null;
  try {
    govde = await r.json();
  } catch {
    govde = { hata: `Sunucu JSON olmayan cevap döndü (HTTP ${r.status}).` };
  }
  return { ok: r.ok, durum: r.status, govde };
}

/** base64url → metin. requestState'in gövdesini ÇÖZMEK için (imzayı doğrulamak için değil). */
function b64urlCoz(s) {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const dolgulu = t + "=".repeat((4 - (t.length % 4)) % 4);
  const ikili = atob(dolgulu);
  const baytlar = Uint8Array.from(ikili, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: false }).decode(baytlar);
}

/** "#/$defs/WriteResult" → sozlesme.$defs.WriteResult */
function jsonPointer(kok, ref) {
  if (!ref || !ref.startsWith("#/")) return null;
  let cur = kok;
  for (const seg of ref.slice(2).split("/")) {
    if (cur == null) return null;
    cur = cur[seg.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return cur ?? null;
}

function refCoz(sema, kok) {
  let s = sema;
  let koruma = 0;
  while (s && typeof s === "object" && s.$ref && koruma++ < 10) s = jsonPointer(kok, s.$ref);
  return s && typeof s === "object" ? s : null;
}

const fark = (a, b) => [...a].filter((x) => !b.has(x));

// ═══════════════════════════ Durum ═══════════════════════════

const durum = {
  sunucular: [],
  protokoller: [],
  sozlesme: null,
  secilenDil: null,
  secilenProtokol: "2026-07-28",
  oturum: null,
  sonda: null,
  toolsListCevap: null,
  toolsListIstek: null,
  araclar: [], // sunucudan gelen tools/list tool'ları
  seciliTool: null,
  sonCagri: null, // { istek, cevap }
  bekleyenSunucuIstegi: null, // v1 elicitation
  bekleId: null,
  sonArgumanlar: null,
  trafikTimer: null,
};

// ═══════════════════════════ Tema ═══════════════════════════

(function temaKur() {
  const kayitli = localStorage.getItem("inspector-tema");
  if (kayitli) document.documentElement.dataset.theme = kayitli;
  const degistir = () => {
    const su = document.documentElement.dataset.theme;
    const sonraki = su === "dark" ? "light" : su === "light" ? "auto" : "dark";
    document.documentElement.dataset.theme = sonraki;
    localStorage.setItem("inspector-tema", sonraki);
  };
  document.addEventListener("DOMContentLoaded", () => {
    $("#tema-btn")?.addEventListener("click", degistir);
    $("#tema-btn-m")?.addEventListener("click", degistir);
  });
})();

// ═══════════════════════════ Sekmeler ═══════════════════════════

function sekmeAc(ad) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === ad));
  $$(".panel").forEach((p) => (p.hidden = p.dataset.panel !== ad));
  $("#scroll").scrollTop = 0;
  if (ad === "trafik") trafikYenile();
}

// ═══════════════════════════ Başlangıç ═══════════════════════════

document.addEventListener("DOMContentLoaded", async () => {
  $$(".tab").forEach((t) => t.addEventListener("click", () => sekmeAc(t.dataset.tab)));
  $("#nav-btn")?.addEventListener("click", () => document.body.classList.toggle("nav-open"));
  $("#backdrop")?.addEventListener("click", () => document.body.classList.remove("nav-open"));
  $("#baglan-btn").addEventListener("click", baglan);
  $("#kopar-btn").addEventListener("click", kopar);
  $("#kars-btn").addEventListener("click", protokolleriKarsilastir);
  $("#trafik-yenile").addEventListener("click", trafikYenile);
  $("#cagir-btn").addEventListener("click", () => toolCagir());
  $("#args-goster-btn").addEventListener("click", argumanlariGoster);

  const [s, c] = await Promise.all([api("/api/sunucular"), api("/api/sozlesme")]);
  if (!s.ok) {
    $("#sunucu-secim").innerHTML = `<div class="loading-line">Sunucu listesi alınamadı: ${esc(s.govde?.hata ?? "?")}</div>`;
    return;
  }
  durum.sunucular = s.govde.sunucular ?? [];
  durum.protokoller = s.govde.protokoller ?? [];
  durum.sozlesme = c.ok ? c.govde : null;
  durum.secilenDil = (durum.sunucular.find((x) => x.hazir) ?? durum.sunucular[0])?.kod ?? null;
  yanPanelCiz();
  karsilastirmaToolListesiDoldur();

  // Otomatik trafik yenileme — yalnızca sekme açıkken iş yapar.
  durum.trafikTimer = setInterval(() => {
    if (!$("#trafik-otomatik")?.checked) return;
    if ($('.panel[data-panel="trafik"]')?.hidden) return;
    trafikYenile();
  }, 2500);
});

// ═══════════════════════════ Yan panel ═══════════════════════════

function yanPanelCiz() {
  const sk = $("#sunucu-secim");
  sk.innerHTML = "";
  for (const s of durum.sunucular) {
    const secili = durum.secilenDil === s.kod;
    const item = el(
      "label",
      { class: "radio-item" + (secili ? " sel" : "") + (s.hazir ? "" : " disabled") },
      el("input", {
        type: "radio",
        name: "dil",
        value: s.kod,
        ...(secili ? { checked: true } : {}),
        ...(s.hazir ? {} : { disabled: true }),
        onchange: () => {
          durum.secilenDil = s.kod;
          yanPanelCiz();
        },
      }),
      el(
        "div",
        { class: "ri-body" },
        el("div", { class: "ri-title", text: s.etiket }),
        el("div", { class: "ri-sub", text: s.komut }),
        el("div", { class: "ri-sub", text: "SDK: " + s.sdk }),
        s.hazir ? null : el("div", { class: "ri-warn", text: "Hazır değil → " + s.hazirlikIpucu }),
      ),
    );
    sk.append(item);
  }

  const pk = $("#protokol-secim");
  pk.innerHTML = "";
  for (const p of durum.protokoller) {
    const secili = durum.secilenProtokol === p.kod;
    pk.append(
      el(
        "label",
        { class: "radio-item" + (secili ? " sel" : "") },
        el("input", {
          type: "radio",
          name: "protokol",
          value: p.kod,
          ...(secili ? { checked: true } : {}),
          onchange: () => {
            durum.secilenProtokol = p.kod;
            yanPanelCiz();
          },
        }),
        el(
          "div",
          { class: "ri-body" },
          el("div", { class: "ri-title", text: p.etiket }),
          el("div", { class: "ri-sub", text: p.aciklama }),
        ),
      ),
    );
  }
  const aktif = durum.protokoller.find((p) => p.kod === durum.secilenProtokol);
  $("#protokol-aciklama").textContent = aktif
    ? "Sunucu tarafında MCP_PROTOCOL=" + aktif.kod + " ile başlatılır."
    : "";
}

function toolListesiCiz() {
  const kutu = $("#tool-listesi");
  kutu.innerHTML = "";
  const sozlesmeTools = durum.sozlesme?.tools ?? [];
  for (const t of durum.araclar) {
    const sz = sozlesmeTools.find((x) => x.name === t.name);
    const yazma = t.annotations?.readOnlyHint === false || sz?.annotations?.readOnlyHint === false;
    const kind = sz?.kind ?? (yazma ? "write" : "read");
    kutu.append(
      el(
        "button",
        {
          class:
            "tool-item" +
            (yazma ? " write" : "") +
            (durum.seciliTool === t.name ? " sel" : ""),
          type: "button",
          onclick: () => toolSec(t.name),
        },
        el("span", { class: "ti-name", text: t.name }),
        el("span", {
          class: "badge " + (kind === "write" ? "badge-write" : kind === "preview" ? "badge-preview" : "badge-read"),
          text: kind === "write" ? "YAZMA" : kind === "preview" ? "ÖNİZLEME" : "OKUMA",
        }),
      ),
    );
  }
  $("#tool-sayisi").textContent = `(${durum.araclar.length})`;
  $("#tool-listesi-bolum").hidden = durum.araclar.length === 0;
}

// ═══════════════════════════ Bağlan / Kopar ═══════════════════════════

function baglantiDurumu(metin, sinif) {
  $("#conn-state").innerHTML = "";
  $("#conn-state").append(el("span", { class: "dot " + sinif }), el("span", { text: metin }));
  $("#topbar-state").textContent = metin;
}

async function baglan() {
  if (!durum.secilenDil) return;
  const btn = $("#baglan-btn");
  btn.disabled = true;
  baglantiDurumu("Bağlanılıyor…", "dot-off");
  $("#protokol-bos").hidden = false;
  $("#protokol-bos").textContent = "Sunucu başlatılıyor… (C# ilk açılışta yavaş olabilir)";
  $("#protokol-icerik").hidden = true;

  const r = await api("/api/baglan", {
    method: "POST",
    body: { dil: durum.secilenDil, protokol: durum.secilenProtokol },
  });
  btn.disabled = false;

  if (!r.ok) {
    baglantiDurumu("Bağlanamadı", "dot-err");
    $("#protokol-bos").hidden = true;
    $("#protokol-icerik").hidden = false;
    protokolHataCiz(r.govde);
    sekmeAc("protokol");
    return;
  }

  durum.oturum = r.govde.oturum;
  durum.sonda = r.govde.sonda;
  durum.toolsListCevap = r.govde.toolsList?.cevap ?? null;
  durum.toolsListIstek = r.govde.toolsList?.istek ?? null;
  durum.araclar = durum.toolsListCevap?.result?.tools ?? [];
  durum.seciliTool = null;
  durum.sonCagri = null;

  baglantiDurumu(
    `${durum.oturum.etiket} · ${durum.sonda.konusulan === "v2" ? "v2 2026-07-28" : "v1 2025-11-25"}`,
    "dot-on",
  );
  $("#kopar-btn").disabled = false;
  toolListesiCiz();
  protokolCiz();
  sozlesmeCiz();
  $("#tool-bos").hidden = false;
  $("#tool-icerik").hidden = true;
  sekmeAc("protokol");
  document.body.classList.remove("nav-open");
}

async function kopar() {
  await api("/api/kopar");
  durum.oturum = null;
  durum.araclar = [];
  durum.seciliTool = null;
  durum.sonCagri = null;
  toolListesiCiz();
  baglantiDurumu("Bağlı değil", "dot-off");
  $("#kopar-btn").disabled = true;
  $("#protokol-icerik").hidden = true;
  $("#protokol-bos").hidden = false;
  $("#protokol-bos").textContent = "Oturum kapatıldı. Yeniden bağlanabilirsiniz.";
  $("#sozlesme-icerik").hidden = true;
  $("#sozlesme-bos").hidden = false;
  $("#tool-icerik").hidden = true;
  $("#tool-bos").hidden = false;
}

// ═══════════════════════════ PANEL 1 — PROTOKOL ═══════════════════════════

function protokolHataCiz(govde) {
  const k = $("#protokol-kartlar");
  k.innerHTML = "";
  $("#protokol-yorum").innerHTML = "";
  $("#sonda-adimlar").innerHTML = "";
  const sonda = govde?.sonda;
  k.append(kart("Sonuç", "BAŞARISIZ", govde?.hata ?? "", "err"));
  if (sonda?.istemciHatasi) {
    $("#protokol-yorum").append(
      el(
        "div",
        { class: "explain err" },
        el("p", { html: "<strong>Bu bir İSTEMCİ hatasıdır, sunucunun eksiği değil.</strong>" }),
        el("p", { text: sonda.yorum }),
        el("p", {
          html:
            "Ayrım kritik: <code>-32601</code> gerçekten “v1 sunucu” demektir, <code>-32602</code> ise " +
            "“sondanız hatalı” demektir. İkisini karıştıran bir uyumluluk sondası, v2 konuşan bir sunucuyu " +
            "v1 sanar. Bu repodaki sihirbaz tam olarak bu hatayı yaptı ve ölçümle yakalandı.",
        }),
      ),
    );
  } else if (govde?.hata) {
    $("#protokol-yorum").append(
      el("div", { class: "explain err" }, el("p", { text: govde.hata }), govde.ipucu ? el("p", { text: "İpucu: " + govde.ipucu }) : null),
    );
  }
  for (const a of sonda?.adimlar ?? []) {
    $("#sonda-adimlar").append(sondaAdimCiz(a));
  }
  if (govde?.stderr?.length) {
    $("#sonda-adimlar").append(
      el("h2", { class: "sec-title", text: "Sunucu stderr" }),
      el("pre", { class: "code", text: govde.stderr.join("\n") }),
    );
  }
}

function sondaAdimCiz(a) {
  const kutu = el("div", {});
  kutu.append(
    el("div", { class: "anat" },
      el("div", { class: "anat-head" }, el("span", { class: "n", text: a.baslik })),
      el("div", { class: "anat-body" },
        blok("İSTEK — istemciden sunucuya", a.istek, {
          tag: "→ GİDEN",
          tagSinif: "out",
          acik: true,
          vurgu: ["_meta", "io.modelcontextprotocol/protocolVersion", "io.modelcontextprotocol/clientCapabilities", "io.modelcontextprotocol/clientInfo"],
        }),
        a.cevap
          ? blok("CEVAP — sunucudan istemciye", a.cevap, {
              tag: "← GELEN",
              tagSinif: "in",
              acik: true,
              ms: a.sureMs ?? null,
              vurgu: ["supportedVersions", "protocolVersion", "serverInfo", "resultType", "ttlMs", "cacheScope", "error", "code"],
            })
          : el("div", { class: "explain" }, el("p", { text: "Bu bir BİLDİRİMDİR (notification): id alanı yoktur, dolayısıyla cevabı da yoktur." })),
      ),
    ),
  );
  return kutu;
}

function protokolCiz() {
  const s = durum.sonda;
  $("#protokol-bos").hidden = true;
  $("#protokol-icerik").hidden = false;

  const k = $("#protokol-kartlar");
  k.innerHTML = "";
  k.append(
    kart("Konuşulan revizyon", s.konusulan === "v2" ? "2026-07-28 (v2)" : "2025-11-25 (v1)", "MCP_PROTOCOL=" + durum.oturum.protokol, "ok"),
    kart("Nasıl anlaşıldı", s.yontem, s.konusulan === "v2" ? "el sıkışma YOK" : "üç ayaklı el sıkışma", "info"),
    kart("Sunucu", s.serverInfo?.name ?? "?", "v" + (s.serverInfo?.version ?? "?") + (s.serverInfo?.title ? " · " + s.serverInfo.title : "")),
    kart("supportedVersions", (s.supportedVersions ?? []).join(", ") || "—"),
    kart(
      "tools/list cache",
      durum.toolsListCevap?.result?.ttlMs !== undefined && durum.toolsListCevap?.result?.ttlMs !== null
        ? `ttlMs=${durum.toolsListCevap.result.ttlMs}`
        : "—",
      durum.toolsListCevap?.result?.cacheScope ? "cacheScope=" + durum.toolsListCevap.result.cacheScope : "v1'de böyle bir alan yok",
      s.konusulan === "v2" ? (durum.toolsListCevap?.result?.ttlMs === 300000 ? "ok" : "err") : "",
    ),
  );

  const y = $("#protokol-yorum");
  y.innerHTML = "";
  y.append(
    el(
      "div",
      { class: "explain" },
      el("p", { html: "<strong>Ne oldu?</strong> " + esc(s.yorum) }),
      s.konusulan === "v2"
        ? el("p", {
            html:
              "v2'de <code>_meta.io.modelcontextprotocol/protocolVersion</code>, " +
              "<code>…/clientCapabilities</code> ve <code>…/clientInfo</code> <strong>her istekte</strong> gider. " +
              "Bir tanesini unutmak isteği reddettirir — ve hata mesajı yanıltıcıdır: Python <code>-32601</code>, " +
              "C# <code>-32602</code> döner. Yukarıdaki giden isteklerde bu blok sarı ile işaretlidir.",
          })
        : el("p", {
            html:
              "v1'de sürüm ve yetenekler <code>initialize</code> el sıkışmasında <strong>bir kez</strong> bildirilir; " +
              "sonraki isteklerde <code>_meta</code> yoktur. Bağlantı stateful'dur — sunucu, oturum boyunca " +
              "client'ın kim olduğunu hatırlar.",
          }),
    ),
  );

  const ad = $("#sonda-adimlar");
  ad.innerHTML = "";
  for (const a of s.adimlar ?? []) ad.append(sondaAdimCiz(a));
  if (durum.toolsListIstek) {
    ad.append(
      sondaAdimCiz({
        baslik: `${(s.adimlar?.length ?? 0) + 1}. tools/list — keşif`,
        istek: durum.toolsListIstek,
        cevap: durum.toolsListCevap,
      }),
    );
  }
}

function karsilastirmaToolListesiDoldur() {
  const sec = $("#kars-tool");
  sec.innerHTML = "";
  for (const t of durum.sozlesme?.tools ?? []) {
    sec.append(el("option", { value: t.name, text: `${t.name} (${t.kind})` }));
  }
}

async function protokolleriKarsilastir() {
  if (!durum.secilenDil) return;
  const tool = $("#kars-tool").value;
  const sozlesmeTool = (durum.sozlesme?.tools ?? []).find((t) => t.name === tool);
  const args = ornekArgumanlar(sozlesmeTool);

  $("#kars-btn").disabled = true;
  $("#kars-durum").textContent = "İki süreç başlatılıyor… (yavaş olabilir)";
  $("#kars-sonuc").innerHTML = "";

  const r = await api("/api/karsilastir", {
    method: "POST",
    body: { dil: durum.secilenDil, tool, args, otoOnay: true },
  });
  $("#kars-btn").disabled = false;
  $("#kars-durum").textContent = "";

  const kutu = $("#kars-sonuc");
  if (!r.ok) {
    kutu.append(el("div", { class: "explain err" }, el("p", { text: r.govde?.hata ?? "Karşılaştırma başarısız." })));
    return;
  }
  const g = r.govde;

  kutu.append(
    el(
      "div",
      { class: "explain " + (g.karsilastirma.structuredContentAyni ? "ok" : "warn") },
      el("p", { html: "<strong>Sonuç:</strong> " + esc(g.karsilastirma.yorum) }),
      el("p", {
        html:
          "Karşılaştırma <em>kanonik JSON</em> üzerinden yapılır: nesne anahtarları sıralanır, sonra metinler " +
          "birebir kıyaslanır. Anahtar sırası bir fark değildir; içerik farkı ise farktır.",
      }),
    ),
  );

  const yan = el("div", { class: "yanyana" });
  for (const [ad, sonuc] of [
    ["v2 — 2026-07-28", g.v2],
    ["v1 — 2025-11-25", g.v1],
  ]) {
    const s = el("div", {});
    s.append(
      el(
        "div",
        { class: "anat" },
        el(
          "div",
          { class: "anat-head" },
          el("span", { class: "n", text: ad }),
          el("span", { class: "badge " + (sonuc.ok ? "badge-read" : "badge-write"), text: sonuc.ok ? "ÇALIŞTI" : "OLMADI" }),
        ),
        el(
          "div",
          { class: "anat-body" },
          el("p", { class: "anat-why", html: "<strong>El sıkışma:</strong> " + esc(sonuc.elSikisma ?? "—") }),
          el("p", { class: "anat-why", html: "<strong>Onay akışı:</strong> " + esc(sonuc.onayAkisi) }),
          el("p", { class: "anat-why", html: "<strong>tools/call tur sayısı:</strong> " + esc(sonuc.turSayisi) }),
          sonuc.hata ? el("div", { class: "explain err" }, el("p", { text: sonuc.hata })) : null,
          sonuc.sonuc ? blok("structuredContent", sonuc.sonuc.structuredContent ?? null, { tag: "ÇIKTI", tagSinif: "in" }) : null,
          blok(`Ham trafik (${sonuc.tel?.length ?? 0} mesaj)`, sonuc.tel ?? [], { tag: "TEL" }),
        ),
      ),
    );
    yan.append(s);
  }
  kutu.append(yan);

  kutu.append(
    el(
      "div",
      { class: "explain" },
      el("p", {
        html:
          "<strong>Dersin ana mesajı:</strong> soldaki ve sağdaki <em>tel</em> tamamen farklı — biri el sıkışıyor, " +
          "diğeri sıkışmıyor; biri sunucudan istek alıyor, diğeri sonuç. Ama <code>structuredContent</code> aynı. " +
          "İş mantığını protokolden ayırdıysan, breaking change seni ince bir adaptör katmanında yakalar.",
      }),
    ),
  );
}

/** Sözleşmedeki şemadan makul bir örnek argüman üretir (karşılaştırma için). */
function ornekArgumanlar(sozlesmeTool) {
  const sema = sozlesmeTool?.input ?? {};
  const zorunlu = new Set(sema.required ?? []);
  const cikti = {};
  for (const [ad, spec] of Object.entries(sema.properties ?? {})) {
    if (!zorunlu.has(ad)) continue;
    if (Array.isArray(spec.enum)) cikti[ad] = spec.enum[0];
    else if (spec.type === "integer" || spec.type === "number") cikti[ad] = 60;
    else if (spec.type === "boolean") cikti[ad] = false;
    else if (spec.type === "array") cikti[ad] = [];
    else cikti[ad] = ad.toLowerCase().includes("id") ? "TW9jay9SZXF1ZXN0LzcwMjQ4" : "";
  }
  // Yazma tool'unda dryRun HER ZAMAN açık gider: bu araç gerçek yazma yapmaz.
  if ("dryRun" in (sema.properties ?? {})) cikti.dryRun = true;
  return cikti;
}

// ═══════════════════════════ PANEL 2 — SÖZLEŞME ═══════════════════════════

/**
 * scripts/verify-contract.mjs'in tarayıcı sürümü.
 * AYNI kontroller: tool adları, parametreler, required, annotation'lar,
 * outputSchema, çıktı alanları, tools/list sırası ve v2 cache alanları.
 */
function sozlesmeKarsilastir(gelenAraclar, listResult, mod) {
  const sozlesme = durum.sozlesme;
  const beklenen = sozlesme?.tools ?? [];
  const beklenenAd = new Map(beklenen.map((t) => [t.name, t]));
  const gelenAd = new Map(gelenAraclar.map((t) => [t.name, t]));
  const farklar = [];
  const ekle = (tool, tur, ayrinti) => farklar.push({ tool, tur, ayrinti });

  if (gelenAraclar.length !== beklenen.length) {
    ekle("(genel)", "tool sayısı", `beklenen ${beklenen.length}, gelen ${gelenAraclar.length}`);
  }
  for (const n of fark(new Set(beklenenAd.keys()), new Set(gelenAd.keys()))) ekle(n, "EKSİK tool", "sunucuda yok");
  for (const n of fark(new Set(gelenAd.keys()), new Set(beklenenAd.keys()))) ekle(n, "FAZLA tool", "sözleşmede yok");

  for (const ad of [...beklenenAd.keys()].filter((n) => gelenAd.has(n))) {
    const bek = beklenenAd.get(ad);
    const gel = gelenAd.get(ad);
    const sema = gel.inputSchema ?? {};

    if (sema.type !== "object") ekle(ad, "inputSchema.type", `beklenen "object", gelen ${JSON.stringify(sema.type)}`);

    const bekProps = new Set(Object.keys(bek.input?.properties ?? {}));
    const gelProps = new Set(Object.keys(sema.properties ?? {}));
    for (const p of fark(bekProps, gelProps)) ekle(ad, "EKSİK parametre", p);
    for (const p of fark(gelProps, bekProps)) ekle(ad, "FAZLA parametre", p);

    const bekReq = new Set(bek.input?.required ?? []);
    const gelReq = new Set(sema.required ?? []);
    for (const p of fark(bekReq, gelReq)) ekle(ad, "required kaybolmuş", `${p} sözleşmede zorunlu, sunucuda değil`);
    for (const p of fark(gelReq, bekReq)) ekle(ad, "required fazladan", `${p} sunucuda zorunlu, sözleşmede değil`);

    // Annotation'lar: Claude Code izin isterken bunlara bakar. readOnlyHint'in
    // yanlış olması "yazan bir tool'u onaysız çalıştırmak" demektir.
    for (const [k, v] of Object.entries(bek.annotations ?? {})) {
      if ((gel.annotations ?? {})[k] !== v) {
        ekle(ad, `annotations.${k}`, `beklenen ${JSON.stringify(v)}, gelen ${JSON.stringify((gel.annotations ?? {})[k])}`);
      }
    }

    if (!gel.description || String(gel.description).trim().length < 10) {
      ekle(ad, "description", "boş veya çok kısa — LLM tool'u yanlış kullanır");
    }

    const bekOut = refCoz(bek.output, sozlesme);
    const gelOut = gel.outputSchema;
    if (!gelOut || typeof gelOut !== "object") {
      ekle(ad, "outputSchema YOK", "sözleşmede 'output' var ama sunucu bildirmiyor → structuredContent üretilmez");
    } else if (bekOut) {
      if (gelOut.type !== undefined && gelOut.type !== "object") {
        ekle(ad, "outputSchema.type", `beklenen "object", gelen ${JSON.stringify(gelOut.type)}`);
      }
      const bo = new Set(Object.keys(bekOut.properties ?? {}));
      const go = new Set(Object.keys(gelOut.properties ?? {}));
      for (const p of fark(bo, go)) ekle(ad, "EKSİK çıktı alanı", p);
      for (const p of fark(go, bo)) ekle(ad, "FAZLA çıktı alanı", `${p} — sözleşmede yok`);
      for (const p of fark(new Set(bekOut.required ?? []), new Set(gelOut.required ?? []))) {
        ekle(ad, "çıktı required kaybolmuş", `${p} sözleşmede zorunlu, outputSchema'da değil`);
      }
    }
  }

  // tools/list DETERMİNİSTİK sırada dönmelidir (LLM prompt cache isabeti).
  const bSira = beklenen.map((t) => t.name);
  const gSira = gelenAraclar.map((t) => t.name);
  if (gSira.length === bSira.length && gSira.join("|") !== bSira.join("|")) {
    const ilk = gSira.findIndex((n, i) => n !== bSira[i]);
    ekle("(genel)", "tools/list sırası", `${ilk + 1}. sırada "${bSira[ilk]}" beklenirken "${gSira[ilk]}" geldi`);
  }

  // v2'ye özgü zarf alanları
  if (mod === "v2") {
    if (listResult?.ttlMs !== 300000) {
      ekle("(tools/list)", "ttlMs", `beklenen 300000, gelen ${JSON.stringify(listResult?.ttlMs)} — v2'de ZORUNLU`);
    }
    if (listResult?.cacheScope !== "public") {
      ekle("(tools/list)", "cacheScope", `beklenen "public", gelen ${JSON.stringify(listResult?.cacheScope)}`);
    }
  }

  return farklar;
}

function sozlesmeCiz() {
  const sozlesme = durum.sozlesme;
  if (!sozlesme) return;
  $("#sozlesme-bos").hidden = true;
  $("#sozlesme-icerik").hidden = false;

  const listResult = durum.toolsListCevap?.result ?? {};
  const farklar = sozlesmeKarsilastir(durum.araclar, listResult, durum.sonda?.konusulan);

  const k = $("#sozlesme-kartlar");
  k.innerHTML = "";
  const outSayisi = durum.araclar.filter((t) => t.outputSchema && typeof t.outputSchema === "object").length;
  k.append(
    kart("Sözleşme", "v" + (sozlesme.contractVersion ?? "?"), `${(sozlesme.tools ?? []).length} tool`, "info"),
    kart("Sonuç", farklar.length === 0 ? "TAM UYUMLU" : `${farklar.length} FARK`, farklar.length ? "aşağıda kırmızı" : "hiç fark yok", farklar.length ? "err" : "ok"),
    kart("outputSchema", `${outSayisi}/${(sozlesme.tools ?? []).length}`, "bildiren tool sayısı", outSayisi === (sozlesme.tools ?? []).length ? "ok" : "err"),
    kart(
      "tools/list sırası",
      farklar.some((f) => f.tur === "tools/list sırası") ? "BOZUK" : "sözleşmeyle aynı",
      "deterministik sıra prompt cache isabetini artırır",
      farklar.some((f) => f.tur === "tools/list sırası") ? "err" : "ok",
    ),
  );

  const fk = $("#sozlesme-farklar");
  fk.innerHTML = "";
  if (farklar.length) {
    const t = el("table", { class: "grid" });
    t.append(el("thead", {}, el("tr", {}, el("th", { text: "Tool" }), el("th", { text: "Fark türü" }), el("th", { text: "Ayrıntı" }))));
    const tb = el("tbody", {});
    for (const f of farklar) {
      tb.append(el("tr", { class: "bad" }, el("td", { class: "mono-sm", text: f.tool }), el("td", { class: "err", text: f.tur }), el("td", { text: f.ayrinti })));
    }
    t.append(tb);
    fk.append(
      el("div", { class: "explain err" }, el("p", { html: `<strong>${farklar.length} fark bulundu.</strong> Sözleşme ihlali, üç dilin “aynı” olduğu iddiasını çürütür.` })),
      el("div", { class: "table-scroll" }, t),
    );
  } else {
    fk.append(
      el(
        "div",
        { class: "explain ok" },
        el("p", { html: "<strong>Sözleşmeye tam uyumlu.</strong> Aynı tool adları, aynı parametreler, aynı annotation'lar, aynı çıktı alanları, aynı sıra." }),
        el("p", {
          html:
            "Bu kontrolün <code>scripts/verify-contract.mjs</code> ile <strong>aynı</strong> kuralları uygulaması bilinçlidir: " +
            "CI'da geçen şey ekranda da geçmeli, yoksa iki farklı “doğru” ortaya çıkar.",
        }),
      ),
    );
  }

  const tb = $("#sozlesme-tablo tbody");
  tb.innerHTML = "";
  (sozlesme.tools ?? []).forEach((bt, i) => {
    const gel = durum.araclar.find((t) => t.name === bt.name);
    const toolFark = farklar.filter((f) => f.tool === bt.name);
    const props = gel ? Object.keys(gel.inputSchema?.properties ?? {}) : [];
    const outSay = gel?.outputSchema ? Object.keys(gel.outputSchema.properties ?? {}).length : null;
    tb.append(
      el(
        "tr",
        { class: toolFark.length || !gel ? "bad" : "" },
        el("td", { text: String(i + 1) }),
        el("td", { class: "mono-sm", text: bt.name }),
        el("td", { class: bt.annotations?.readOnlyHint === true ? "ok" : "err", text: bt.annotations?.readOnlyHint === true ? "evet" : "HAYIR" }),
        el("td", { class: outSay === null ? "err" : "ok", text: outSay === null ? "YOK" : `${outSay} alan` }),
        el("td", { class: "mono-sm", text: props.length ? props.join(", ") : "—" }),
        el("td", { class: !gel ? "err" : toolFark.length ? "err" : "ok", text: !gel ? "EKSİK" : toolFark.length ? `${toolFark.length} fark` : "OK" }),
      ),
    );
  });
}

// ═══════════════════════════ PANEL 3 — TOOL ═══════════════════════════

function toolSec(ad) {
  durum.seciliTool = ad;
  durum.sonCagri = null;
  durum.bekleyenSunucuIstegi = null;
  toolListesiCiz();
  toolCiz();
  sekmeAc("tool");
  document.body.classList.remove("nav-open");
}

function toolCiz() {
  const gel = durum.araclar.find((t) => t.name === durum.seciliTool);
  const sz = (durum.sozlesme?.tools ?? []).find((t) => t.name === durum.seciliTool);
  if (!gel && !sz) return;
  $("#tool-bos").hidden = true;
  $("#tool-icerik").hidden = false;
  $("#mrtr-bolum").hidden = true;
  $("#yanit-bolum").hidden = true;

  const yazma = (gel?.annotations ?? sz?.annotations ?? {}).readOnlyHint === false;
  $("#tool-adi").textContent = durum.seciliTool;
  $("#tool-ozet").textContent = sz?.summary ?? gel?.description ?? "";

  // ── Rozetler: annotation'lar ekranda okunur olsun ───────────────────────
  const rz = $("#tool-rozetler");
  rz.innerHTML = "";
  const ann = gel?.annotations ?? sz?.annotations ?? {};
  rz.append(
    el("span", { class: "badge " + (yazma ? "badge-write" : "badge-read"), text: yazma ? "YAZMA TOOL'U" : "SALT OKUNUR" }),
    sz?.kind ? el("span", { class: "badge", text: "kind: " + sz.kind }) : null,
  );
  for (const [k, v] of Object.entries(ann)) {
    rz.append(el("span", { class: "badge", text: `${k}: ${v}` }));
  }

  // ── Güvenlik uyarısı ────────────────────────────────────────────────────
  const gv = $("#tool-guvenlik");
  gv.innerHTML = "";
  if (yazma) {
    gv.append(
      el(
        "div",
        { class: "explain err" },
        el("p", { html: "<strong>⚠ Bu bir YAZMA tool'udur</strong> — <code>readOnlyHint: false</code>." }),
        el("p", {
          html:
            "Aşağıdaki formda <code>dryRun</code> <strong>kasıtlı olarak AÇIK</strong> gelir. " +
            "Sözleşmedeki varsayılan <code>false</code>'tur; bu ekran onu bilerek ters çevirir. " +
            "Kapatmak isteyen kişi bunu <em>bilerek</em> yapmalıdır.",
        }),
        el("p", {
          html:
            "Not: bu inspector çocuk süreçleri her zaman <code>XURRENT_MODE=mock</code> ile başlatır. " +
            "<code>dryRun</code> kapalı olsa bile gerçek bir ITSM hesabına yazılmaz — ama alışkanlık " +
            "canlı ortama taşınır, o yüzden burada da doğru davranıyoruz.",
        }),
      ),
    );
  } else {
    gv.append(
      el(
        "div",
        { class: "explain ok" },
        el("p", { html: "<strong>Salt okunur tool.</strong> <code>readOnlyHint: true</code> — çağırmak yan etki üretmez." }),
      ),
    );
  }

  // ── teachingNotes ───────────────────────────────────────────────────────
  const nk = $("#tool-notlar");
  nk.innerHTML = "";
  const notlar = sz?.teachingNotes ?? [];
  if (!notlar.length) {
    nk.append(
      el("div", { class: "explain" }, el("p", { text: "Bu tool için sözleşmede teachingNotes yok. (8 tool'un 6'sında var.)" })),
    );
  } else {
    const liste = el("ol", {});
    for (const n of notlar) liste.append(el("li", { text: n }));
    nk.append(
      el(
        "div",
        { class: "explain warn" },
        el("p", {
          html:
            "<code>teachingNotes</code> MCP'de <strong>olmayan</strong>, bu repoya ait bir alandır. " +
            "Sunucular onu <code>tools/list</code>'te yayınlamaz; bu ekran doğrudan " +
            "<code>contract/tools.json</code>'dan okur. Resmî inspector bunları göremez.",
        }),
        liste,
      ),
    );
  }

  formCiz(gel, sz);
  outputSemaCiz(gel, sz);
  $("#args-onizleme").hidden = true;
  $("#cagir-durum").textContent = "";
}

/** inputSchema → form. Tip, enum, required, default, pattern, maxLength GÖRÜNÜR. */
function formCiz(gel, sz) {
  const form = $("#tool-form");
  form.innerHTML = "";
  const sema = gel?.inputSchema ?? sz?.input ?? {};
  const sozlesmeProps = sz?.input?.properties ?? {};
  const zorunlu = new Set(sema.required ?? []);
  const props = Object.entries(sema.properties ?? {});

  if (!props.length) {
    form.append(el("div", { class: "explain" }, el("p", { text: "Bu tool argüman almaz. inputSchema boş bir nesnedir." })));
    return;
  }

  for (const [ad, spec] of props) {
    const szSpec = sozlesmeProps[ad] ?? {};
    const zor = zorunlu.has(ad);
    const dryRun = ad === "dryRun";
    const alan = el("div", { class: "field" + (zor ? " required" : "") + (dryRun ? " dry" : ""), "data-alan": ad });

    // Şemadaki KISITLARIN HEPSİ rozet olarak görünür — form gizlemez, gösterir.
    const meta = el("div", { class: "field-meta" });
    const tip = spec.type ?? (Array.isArray(spec.enum) ? "enum" : szSpec.type ?? "?");
    meta.append(el("span", { class: "badge", text: "tip: " + (Array.isArray(tip) ? tip.join("|") : tip) }));
    if (zor) meta.append(el("span", { class: "badge badge-req", text: "ZORUNLU" }));
    if (Array.isArray(spec.enum)) meta.append(el("span", { class: "badge", text: `enum: ${spec.enum.length} değer` }));
    if (spec.default !== undefined) meta.append(el("span", { class: "badge", text: "default: " + JSON.stringify(spec.default) }));
    if (spec.pattern) meta.append(el("span", { class: "badge", text: "pattern: " + spec.pattern }));
    if (spec.maxLength !== undefined) meta.append(el("span", { class: "badge", text: "maxLength: " + spec.maxLength }));
    if (spec.minimum !== undefined) meta.append(el("span", { class: "badge", text: "minimum: " + spec.minimum }));
    if (spec.maximum !== undefined) meta.append(el("span", { class: "badge", text: "maximum: " + spec.maximum }));

    const aciklama = szSpec.description ?? spec.description ?? "";
    const bas = el("div", { class: "field-head" }, el("span", { class: "field-name", text: ad, title: aciklama || ad }), meta);
    alan.append(bas);
    if (aciklama) alan.append(el("div", { class: "field-desc", text: aciklama, title: aciklama }));

    // ── Girdi elemanı ────────────────────────────────────────────────────
    let girdi;
    if (Array.isArray(spec.enum)) {
      girdi = el("select", { "data-tip": "enum" });
      if (!zor) girdi.append(el("option", { value: "", text: "(gönderme)" }));
      for (const v of spec.enum) girdi.append(el("option", { value: String(v), text: String(v) }));
      if (spec.default !== undefined) girdi.value = String(spec.default);
    } else if (spec.type === "boolean") {
      // ★ ÜÇ DURUMLU: "gönderme" ile "false gönder" AYNI ŞEY DEĞİLDİR.
      //   Alan yoksa sunucudaki varsayılan uygulanır; false gönderirsen varsayılanı EZERSİN.
      girdi = el("select", { "data-tip": "boolean" });
      girdi.append(
        el("option", { value: "", text: "(gönderme — sunucu varsayılanı uygulanır)" }),
        el("option", { value: "true", text: "true" }),
        el("option", { value: "false", text: "false" }),
      );
      girdi.value = dryRun ? "true" : "";
    } else if (spec.type === "integer" || spec.type === "number") {
      girdi = el("input", { type: "number", "data-tip": spec.type, placeholder: zor ? "zorunlu" : "(boş = gönderme)" });
      if (spec.default !== undefined) girdi.value = String(spec.default);
    } else if (spec.type === "array" || spec.type === "object") {
      girdi = el("textarea", { "data-tip": "json", placeholder: spec.type === "array" ? "[]" : "{}", spellcheck: "false" });
    } else {
      const uzun = (spec.maxLength ?? 0) > 120 || ad === "note" || ad === "description";
      girdi = uzun
        ? el("textarea", { "data-tip": "string", spellcheck: "false", placeholder: zor ? "zorunlu" : "(boş = gönderme)" })
        : el("input", { type: "text", "data-tip": "string", spellcheck: "false", placeholder: zor ? "zorunlu" : "(boş = gönderme)" });
      if (spec.default !== undefined) girdi.value = String(spec.default);
    }
    girdi.name = ad;
    alan.append(girdi);

    if (dryRun) {
      alan.append(
        el("div", {
          class: "field-desc",
          html:
            "<strong>Inspector bu alanı bilerek <code>true</code> ile açar.</strong> " +
            "Sözleşmedeki varsayılan <code>false</code>'tur — yani hiç göndermezsen gerçek yazma denenir.",
        }),
      );
    }
    form.append(alan);
  }

  form.append(
    el(
      "div",
      { class: "explain" },
      el("p", {
        html:
          "<strong>Bu form şemadan üretildi.</strong> Elle yazılmadı: alan adları, tipler, enum'lar, " +
          "<code>required</code>, <code>default</code>, <code>pattern</code> ve <code>maxLength</code> " +
          "doğrudan sunucunun bildirdiği <code>inputSchema</code>'dan geliyor. LLM'in gördüğü şey de tam olarak budur — " +
          "form, o şemanın insan hâlidir.",
      }),
      el("p", {
        html:
          "Boş bırakılan alanlar <strong>gönderilmez</strong>. Bu önemli: bir alanı hiç göndermemek ile " +
          "<code>false</code>/boş string göndermek farklı şeylerdir; ilkinde sunucu varsayılanı uygulanır.",
      }),
    ),
  );
}

function outputSemaCiz(gel, sz) {
  const kutu = $("#tool-output-sema");
  kutu.innerHTML = "";
  const out = gel?.outputSchema;
  if (!out) {
    kutu.append(
      el(
        "div",
        { class: "explain err" },
        el("p", {
          html:
            "<strong>Bu tool outputSchema bildirmiyor.</strong> Sonuç: <code>tools/call</code> cevabında " +
            "<code>structuredContent</code> üretilmez ve çağıran taraf JSON'ı METİNDEN ayrıştırmak zorunda kalır. " +
            "“Üç dil aynı çıktıyı üretir” tezi tam burada kırılır.",
        }),
      ),
    );
    return;
  }
  const alanlar = Object.keys(out.properties ?? {});
  const req = new Set(out.required ?? []);
  const liste = el("div", { class: "badge-row" });
  for (const a of alanlar) {
    liste.append(el("span", { class: "badge " + (req.has(a) ? "badge-req" : ""), text: a + (req.has(a) ? " *" : "") }));
  }
  kutu.append(
    el(
      "div",
      { class: "explain ok" },
      el("p", {
        html:
          `<strong>${alanlar.length} çıktı alanı bildiriliyor</strong> (yıldızlılar zorunlu). ` +
          "Bir tool sözleşmesi, çağıranın ne GÖNDERECEĞİ kadar ne ALACAĞINI da tarif eder; " +
          "yoksa iki implementasyonun “aynı” olduğu ölçülemez.",
      }),
      liste,
    ),
    blok("outputSchema (ham)", out, { tag: "ŞEMA" }),
  );
}

function formArgumanlariTopla() {
  const args = {};
  const hatalar = [];
  for (const alan of $$("#tool-form .field")) {
    alan.classList.remove("invalid");
    const ad = alan.dataset.alan;
    const girdi = alan.querySelector("input, select, textarea");
    if (!girdi) continue;
    const tip = girdi.dataset.tip;
    const ham = girdi.value;
    if (ham === "" || ham === null) continue; // boş = GÖNDERME
    if (tip === "boolean") args[ad] = ham === "true";
    else if (tip === "integer") {
      const n = Number(ham);
      if (!Number.isInteger(n)) {
        hatalar.push(`${ad}: tam sayı olmalı`);
        alan.classList.add("invalid");
      } else args[ad] = n;
    } else if (tip === "number") {
      const n = Number(ham);
      if (Number.isNaN(n)) {
        hatalar.push(`${ad}: sayı olmalı`);
        alan.classList.add("invalid");
      } else args[ad] = n;
    } else if (tip === "json") {
      try {
        args[ad] = JSON.parse(ham);
      } catch {
        hatalar.push(`${ad}: geçerli JSON değil`);
        alan.classList.add("invalid");
      }
    } else args[ad] = ham;
  }
  // Zorunlu alan kontrolü — sunucuya gitmeden önce yakalanabilenler burada yakalanır.
  const gel = durum.araclar.find((t) => t.name === durum.seciliTool);
  for (const r of gel?.inputSchema?.required ?? []) {
    if (!(r in args)) {
      hatalar.push(`${r}: ZORUNLU alan boş`);
      $(`#tool-form .field[data-alan="${CSS.escape(r)}"]`)?.classList.add("invalid");
    }
  }
  return { args, hatalar };
}

function argumanlariGoster() {
  const { args, hatalar } = formArgumanlariTopla();
  const kutu = $("#args-onizleme");
  kutu.hidden = false;
  kutu.innerHTML = "";
  if (hatalar.length) {
    kutu.append(el("div", { class: "explain err" }, el("p", { text: "Form hataları: " + hatalar.join(" · ") })));
  }
  kutu.append(
    blok("Gönderilecek tools/call params", { name: durum.seciliTool, arguments: args }, { tag: "→ GİDECEK", tagSinif: "out", acik: true }),
  );
}

async function toolCagir(ekParams = null) {
  const { args, hatalar } = formArgumanlariTopla();
  if (hatalar.length && !ekParams) {
    $("#cagir-durum").textContent = "Form hataları: " + hatalar.join(" · ");
    return;
  }
  durum.sonArgumanlar = args;
  $("#cagir-btn").disabled = true;
  $("#cagir-durum").textContent = "Gönderiliyor…";

  const params = { name: durum.seciliTool, arguments: args, ...(ekParams ?? {}) };
  const r = await api("/api/cagir", { method: "POST", body: { metod: "tools/call", params } });
  $("#cagir-btn").disabled = false;

  if (!r.ok) {
    $("#cagir-durum").textContent = r.govde?.hata ?? "Çağrı başarısız.";
    return;
  }
  $("#cagir-durum").textContent = r.govde.sureMs !== undefined ? `${r.govde.sureMs} ms` : "";
  durum.sonCagri = { istek: r.govde.istek, cevap: r.govde.cevap };

  if (r.govde.tur === "sunucu-istegi") {
    // v1 yolu: sunucu bize İSTEK gönderdi. tools/call cevabı hâlâ bekliyor.
    durum.bekleyenSunucuIstegi = r.govde.sunucuIstegi;
    durum.bekleId = r.govde.bekleId;
    v1OnayCiz(r.govde.istek, r.govde.sunucuIstegi);
    return;
  }
  if (r.govde.tur === "hata") {
    $("#cagir-durum").textContent = r.govde.hata;
    return;
  }

  const sonuc = r.govde.cevap?.result;
  if (sonuc?.resultType === "input_required") {
    v2MrtrCiz(r.govde.istek, r.govde.cevap);
    return;
  }
  $("#mrtr-bolum").hidden = true;
  yanitAnatomisiCiz(r.govde.istek, r.govde.cevap);
}

// ── MRTR / onay görselleştirmesi ───────────────────────────────────────────

function akisAdimi(no, baslik, alt, icerik, durumSinifi = "") {
  return el(
    "div",
    { class: "flow-step" },
    el("div", { class: "flow-rail" }, el("div", { class: "flow-dot " + durumSinifi, text: String(no) }), el("div", { class: "flow-line" })),
    el("div", { class: "flow-body" }, el("div", { class: "flow-title", text: baslik }), alt ? el("div", { class: "flow-sub", text: alt }) : null, icerik),
  );
}

/** requestState imzalıdır. İÇERİĞİ okunmamalıdır — ama gövdesi base64'tür ve okunabilir. */
function requestStateCoz(rs) {
  const kutu = el("div", { class: "state-decode" });
  kutu.append(
    el("h4", { text: "requestState — imzalı, opak blob" }),
    el("p", {
      class: "anat-why",
      html:
        "Spec bunu açıkça <strong>saldırgan kontrolündeki girdi</strong> olarak tanımlar. Client onu " +
        "<strong>anlamak zorunda değildir ve anlamamalıdır</strong>: aynen geri göndermekle yükümlüdür. " +
        "Aşağıdaki çözüm yalnızca DERS içindir — base64 şifreleme değildir, imza da doğrulanmamıştır.",
    }),
  );
  const parcalar = String(rs).split(".");
  kutu.append(el("p", { class: "anat-why", text: `Blob ${parcalar.length} parçadan oluşuyor (nokta ile ayrılmış).` }));
  parcalar.forEach((p, i) => {
    let coz = null;
    try {
      const metin = b64urlCoz(p);
      coz = JSON.parse(metin);
    } catch {
      coz = null;
    }
    if (coz && typeof coz === "object") {
      kutu.append(blok(`Parça ${i + 1} — GÖVDE (base64url → JSON)`, coz, { tag: "ÇÖZÜLDÜ", tagSinif: "srv", acik: true }));
      const alanlar = Object.keys(coz);
      kutu.append(
        el(
          "div",
          { class: "explain" },
          el("p", { html: "<strong>Gövdedeki alanlar ve ne işe yaradıkları:</strong>" }),
          el(
            "ul",
            {},
            alanlar.map((a) =>
              el("li", {
                html:
                  `<code>${esc(a)}</code> — ` +
                  esc(
                    {
                      principal: "authenticated person id. Başka principal ile gelen state REDDEDİLİR (çapraz kullanıcı saldırısı).",
                      fingerprint: "metod adı + tool argümanlarının SHA-256 özeti. Farklı bir çağrıya iliştirilen state REDDEDİLİR.",
                      nonce: "tek kullanımlık değer. Süreç içi bir sette tutulur; replay'i engeller.",
                      exp: "son kullanma zamanı (unix saniye). 5 dakikalık TTL.",
                      iat: "üretilme zamanı (unix saniye).",
                      tool: "hangi tool için üretildiği.",
                      method: "hangi tool/metod için üretildiği.",
                      v: "state formatının sürümü.",
                    }[a] ?? "sunucuya özel alan.",
                  ),
              }),
            ),
          ),
        ),
      );
    } else {
      kutu.append(
        el("p", {
          class: "anat-why",
          html: `Parça ${i + 1}: <code>${esc(p.slice(0, 24))}…</code> — JSON'a çözülmedi. Bu ya format öneki ya da <strong>HMAC-SHA256 imzasıdır</strong>; imza okunacak bir şey değildir.`,
        }),
      );
    }
  });
  return kutu;
}

function v2MrtrCiz(istek, cevap) {
  const sonuc = cevap.result;
  const bolum = $("#mrtr-bolum");
  const kutu = $("#mrtr-icerik");
  bolum.hidden = false;
  $("#yanit-bolum").hidden = true;
  kutu.innerHTML = "";

  kutu.append(
    el(
      "div",
      { class: "explain warn" },
      el("p", {
        html:
          "<strong>Sunucu “eksik bilgi var” dedi — ama bunu bir HATA olarak değil, bir SONUÇ TÜRÜ olarak söyledi.</strong> " +
          "<code>resultType: \"input_required\"</code>. İlk istek burada <em>sonlandı</em>; sunucu hiçbir state tutmuyor.",
      }),
      el("p", {
        html:
          "Bu, 2026-07-28 revizyonunun <strong>MRTR</strong> (Multi Round-Trip Requests) desenidir ve " +
          "v1'deki <code>elicitation/create</code> isteğinin yerini almıştır.",
      }),
    ),
  );

  const akis = el("div", { class: "flow" });
  akis.append(
    akisAdimi(
      1,
      "tools/call — ilk istek",
      `JSON-RPC id: ${JSON.stringify(istek.id)}`,
      blok("Giden istek", istek, { tag: "→ GİDEN", tagSinif: "out" }),
      "done",
    ),
    akisAdimi(
      2,
      "InputRequiredResult — sunucunun CEVABI",
      "Bu bir cevap. Sunucu istekte bulunmadı; sonuç döndü ve istek KAPANDI.",
      el(
        "div",
        {},
        blok("Gelen sonuç", sonuc, { tag: "← GELEN", tagSinif: "in", acik: true, vurgu: ["resultType", "inputRequests", "requestState"] }),
        sonuc.requestState ? requestStateCoz(sonuc.requestState) : null,
      ),
      "done",
    ),
  );

  // Kullanıcıya sorulan form
  const sorular = Object.entries(sonuc.inputRequests ?? {});
  const cevaplar = {};
  const soruKutu = el("div", {});
  for (const [anahtar, istekTanimi] of sorular) {
    // ★ Zarf: { method, params: { message, requestedSchema, mode } }
    const p = istekTanimi.params ?? istekTanimi;
    const sema = p.requestedSchema ?? {};
    const f = el("div", { class: "anat" });
    f.append(
      el(
        "div",
        { class: "anat-head" },
        el("span", { class: "n", text: anahtar }),
        el("span", { class: "badge", text: istekTanimi.method ?? "elicitation/create" }),
      ),
    );
    const govde = el("div", { class: "anat-body" });
    govde.append(el("pre", { class: "code", text: p.message ?? "(mesaj yok)" }));
    const alanlar = {};
    for (const [ad, spec] of Object.entries(sema.properties ?? {})) {
      const satir = el("div", { class: "field" });
      satir.append(
        el(
          "div",
          { class: "field-head" },
          el("span", { class: "field-name", text: ad }),
          el(
            "div",
            { class: "field-meta" },
            el("span", { class: "badge", text: "tip: " + (spec.type ?? "?") }),
            (sema.required ?? []).includes(ad) ? el("span", { class: "badge badge-req", text: "ZORUNLU" }) : null,
          ),
        ),
        spec.title || spec.description ? el("div", { class: "field-desc", text: spec.title ?? spec.description }) : null,
      );
      let g;
      if (spec.type === "boolean") {
        g = el("select", {});
        g.append(el("option", { value: "true", text: "true (onaylıyorum)" }), el("option", { value: "false", text: "false" }));
      } else {
        g = el("input", { type: "text", placeholder: "(isteğe bağlı)" });
      }
      satir.append(g);
      alanlar[ad] = { g, spec };
      govde.append(satir);
    }
    cevaplar[anahtar] = alanlar;
    f.append(govde);
    soruKutu.append(f);
  }

  const dugmeler = el(
    "div",
    { class: "cagir-bar" },
    el("button", {
      class: "primary-btn",
      type: "button",
      text: "Onayla → AYNI çağrıyı YENİ id ile tekrar gönder",
      onclick: () => mrtrTekrarGonder(sonuc, cevaplar, "accept"),
    }),
    el("button", {
      class: "ghost-btn",
      type: "button",
      text: "Reddet",
      onclick: () => mrtrTekrarGonder(sonuc, cevaplar, "decline"),
    }),
  );

  akis.append(
    akisAdimi(3, "Kullanıcıya sorulur", "Client, sunucunun istediği bilgiyi kullanıcıdan toplar.", el("div", {}, soruKutu, dugmeler), "wait"),
    akisAdimi(
      4,
      "tools/call — AYNI çağrı, YENİ JSON-RPC id",
      "params: aynı name + arguments, EK OLARAK inputResponses ve requestState.",
      el(
        "div",
        { class: "explain" },
        el("p", {
          html:
            "<strong>id FARKLI olmak ZORUNDADIR.</strong> Bunlar bağımsız iki JSON-RPC isteğidir; " +
            "ikincisi birincinin devamı değil, sunucunun <code>requestState</code> sayesinde " +
            "“hatırlayabildiği” yeni bir istektir.",
        }),
      ),
      "wait",
    ),
    akisAdimi(5, "Sonuç", "resultType: \"complete\" — iş biter.", el("div", { class: "explain" }, el("p", { text: "Yukarıdaki düğmeye basınca burası dolacak." })), "wait"),
  );

  kutu.append(akis);
}

async function mrtrTekrarGonder(oncekiSonuc, cevaplar, aksiyon) {
  const inputResponses = {};
  for (const [anahtar, alanlar] of Object.entries(cevaplar)) {
    if (aksiyon !== "accept") {
      inputResponses[anahtar] = { action: "decline" };
      continue;
    }
    const content = {};
    for (const [ad, { g, spec }] of Object.entries(alanlar)) {
      if (spec.type === "boolean") content[ad] = g.value === "true";
      else if (g.value !== "") content[ad] = g.value;
    }
    inputResponses[anahtar] = { action: "accept", content };
  }
  await toolCagir({ inputResponses, requestState: oncekiSonuc.requestState });
}

function v1OnayCiz(istek, sunucuIstegi) {
  const bolum = $("#mrtr-bolum");
  const kutu = $("#mrtr-icerik");
  bolum.hidden = false;
  $("#yanit-bolum").hidden = true;
  kutu.innerHTML = "";

  kutu.append(
    el(
      "div",
      { class: "explain warn" },
      el("p", {
        html:
          "<strong>Sunucu BİZE bir JSON-RPC İSTEĞİ gönderdi.</strong> Bu v1'in (2025-11-25) onay yoludur: " +
          "<code>elicitation/create</code>. Dikkat — bu bir <em>sonuç</em> değil, <em>istek</em>tir; " +
          "yani bağlantı çift yönlü ve <strong>stateful</strong> olmak zorundadır.",
      }),
      el("p", {
        html:
          "Bu istek cevaplanmadan <code>tools/call</code> cevabı ASLA gelmez. Cevaplamayan bir client " +
          "kendini kilitler — v2'nin bu deseni terk etme sebeplerinden biri budur.",
      }),
    ),
  );

  const p = sunucuIstegi.params ?? {};
  const sema = p.requestedSchema ?? {};
  const alanlar = {};
  const soruKutu = el("div", { class: "anat" });
  soruKutu.append(
    el("div", { class: "anat-head" }, el("span", { class: "n", text: sunucuIstegi.method }), el("span", { class: "badge", text: "id: " + JSON.stringify(sunucuIstegi.id) })),
  );
  const govde = el("div", { class: "anat-body" });
  govde.append(el("pre", { class: "code", text: p.message ?? "(mesaj yok)" }));
  for (const [ad, spec] of Object.entries(sema.properties ?? {})) {
    const satir = el("div", { class: "field" });
    satir.append(
      el(
        "div",
        { class: "field-head" },
        el("span", { class: "field-name", text: ad }),
        el("div", { class: "field-meta" }, el("span", { class: "badge", text: "tip: " + (spec.type ?? "?") })),
      ),
      spec.title || spec.description ? el("div", { class: "field-desc", text: spec.title ?? spec.description }) : null,
    );
    let g;
    if (spec.type === "boolean") {
      g = el("select", {});
      g.append(el("option", { value: "true", text: "true (onaylıyorum)" }), el("option", { value: "false", text: "false" }));
    } else g = el("input", { type: "text", placeholder: "(isteğe bağlı)" });
    satir.append(g);
    alanlar[ad] = { g, spec };
    govde.append(satir);
  }
  soruKutu.append(govde);

  const akis = el("div", { class: "flow" });
  akis.append(
    akisAdimi(1, "tools/call — istemciden sunucuya", `id: ${JSON.stringify(istek.id)}`, blok("Giden istek", istek, { tag: "→ GİDEN", tagSinif: "out" }), "done"),
    akisAdimi(
      2,
      "elicitation/create — SUNUCUDAN İSTEMCİYE İSTEK",
      "Yön TERSİNE döndü. Bu, v2'de artık yoktur.",
      blok("Gelen istek", sunucuIstegi, { tag: "← SUNUCU İSTEĞİ", tagSinif: "srv", acik: true }),
      "done",
    ),
    akisAdimi(
      3,
      "ElicitResult — cevabımız",
      "Aynı id ile cevap veririz. Ancak bundan sonra tools/call cevabı gelir.",
      el(
        "div",
        {},
        soruKutu,
        el(
          "div",
          { class: "cagir-bar" },
          el("button", { class: "primary-btn", type: "button", text: "Onayla ve gönder", onclick: () => v1Yanitla(sunucuIstegi.id, alanlar, "accept") }),
          el("button", { class: "ghost-btn", type: "button", text: "Reddet", onclick: () => v1Yanitla(sunucuIstegi.id, alanlar, "decline") }),
        ),
      ),
      "wait",
    ),
    akisAdimi(4, "tools/call cevabı", "İlk isteğin cevabı NİHAYET gelir — aynı id ile.", el("div", { class: "explain" }, el("p", { text: "Yukarıdaki düğmeye basınca burası dolacak." })), "wait"),
  );
  kutu.append(akis);
}

async function v1Yanitla(id, alanlar, aksiyon) {
  const content = {};
  for (const [ad, { g, spec }] of Object.entries(alanlar)) {
    if (spec.type === "boolean") content[ad] = g.value === "true";
    else if (g.value !== "") content[ad] = g.value;
  }
  const sonuc = aksiyon === "accept" ? { action: "accept", content } : { action: "decline" };
  $("#cagir-durum").textContent = "Cevap gönderiliyor…";
  const r = await api("/api/yanitla", { method: "POST", body: { id, sonuc, bekleId: durum.bekleId } });
  $("#cagir-durum").textContent = "";
  if (!r.ok) {
    $("#cagir-durum").textContent = r.govde?.hata ?? "Yanıt gönderilemedi.";
    return;
  }
  durum.bekleyenSunucuIstegi = null;
  if (r.govde.tur === "yanit") {
    yanitAnatomisiCiz(durum.sonCagri?.istek ?? null, r.govde.cevap);
    $("#mrtr-icerik").append(
      el(
        "div",
        { class: "explain ok" },
        el("p", { html: "<strong>Döngü kapandı.</strong> Sunucunun isteğini cevapladık, ardından ilk <code>tools/call</code> isteğimizin cevabı geldi. Aşağıda anatomisi var." }),
      ),
    );
  } else if (r.govde.tur === "sunucu-istegi") {
    v1OnayCiz(durum.sonCagri?.istek ?? null, r.govde.sunucuIstegi);
  } else {
    $("#cagir-durum").textContent = r.govde.hata ?? "?";
  }
}

// ── Yanıt anatomisi ────────────────────────────────────────────────────────

function anatomiParcasi(ad, varMi, aciklama, icerik, sinif = "") {
  const k = el("div", { class: "anat" + (varMi ? "" : " missing") });
  k.append(
    el(
      "div",
      { class: "anat-head" },
      el("span", { class: "n", text: ad }),
      el("span", { class: "badge " + (varMi ? "badge-read" : "badge-write"), text: varMi ? "VAR" : "YOK" }),
      sinif ? el("span", { class: "badge " + sinif, text: sinif === "badge-v2" ? "v2'de ZORUNLU" : "" }) : null,
    ),
  );
  const g = el("div", { class: "anat-body" });
  g.append(el("p", { class: "anat-why", html: aciklama }));
  if (icerik) g.append(icerik);
  k.append(g);
  return k;
}

function yanitAnatomisiCiz(istek, cevap) {
  const bolum = $("#yanit-bolum");
  const kutu = $("#yanit-icerik");
  bolum.hidden = false;
  kutu.innerHTML = "";

  if (cevap?.error) {
    kutu.append(
      el(
        "div",
        { class: "explain err" },
        el("p", {
          html:
            "<strong>Bu bir JSON-RPC PROTOKOL hatasıdır</strong> (<code>error</code> alanı), " +
            "iş kuralı hatası değil. İkisini karıştırmak yaygın bir hatadır: protokol hatası " +
            "“isteğin kendisi geçersiz”, <code>isError:true</code> ise “istek geçerliydi ama iş kuralı reddetti” demektir.",
        }),
      ),
      blok("Ham hata", cevap.error, { tag: "← GELEN", tagSinif: "bad", acik: true }),
    );
    return;
  }

  const r = cevap?.result ?? {};
  const v2 = durum.sonda?.konusulan === "v2";

  kutu.append(
    el(
      "div",
      { class: "explain" },
      el("p", {
        html:
          "Aşağıda <code>tools/call</code> cevabının <strong>her parçası</strong> ayrı ayrı etiketlendi. " +
          "Resmî inspector bu JSON'ı gösterir; buradaki fark, her alanın <em>ne işe yaradığının</em> yanında yazması.",
      }),
    ),
  );

  // content[]
  const content = r.content ?? [];
  kutu.append(
    anatomiParcasi(
      "content[]",
      content.length > 0,
      "<strong>İNSAN (ve LLM) İÇİN.</strong> Okunabilir bloklar dizisi — metin, resim, kaynak bağlantısı. " +
        "LLM'in bağlamına giren asıl şey budur. <code>structuredContent</code> olsa bile bu dizi " +
        "boş bırakılmamalıdır: yapılandırılmış veriyi okuyamayan client'lar (ve insanlar) hâlâ vardır." +
        (content.length ? ` Bu cevapta ${content.length} blok var (${content.map((c) => c.type).join(", ")}).` : ""),
      content.length
        ? el(
            "div",
            {},
            ...content.map((c, i) =>
              c.type === "text"
                ? el("details", { class: "blk", ...(i === 0 ? { open: true } : {}) },
                    el("summary", {}, el("span", { class: "blk-tag in", text: "text" }), `content[${i}] — ${String(c.text ?? "").length} karakter`),
                    el("div", { class: "blk-body" }, el("pre", { class: "code", text: c.text ?? "" })))
                : blok(`content[${i}] — ${c.type}`, c, { tag: c.type }),
            ),
          )
        : null,
    ),
  );

  // structuredContent
  const sc = r.structuredContent;
  const scVar = sc != null && typeof sc === "object" && Object.keys(sc).length > 0;
  const szTool = (durum.sozlesme?.tools ?? []).find((t) => t.name === durum.seciliTool);
  const bekOut = refCoz(szTool?.output, durum.sozlesme);
  const eksikAlanlar = scVar ? (bekOut?.required ?? []).filter((a) => !(a in sc)) : [];
  kutu.append(
    anatomiParcasi(
      "structuredContent",
      scVar,
      "<strong>MAKİNE İÇİN.</strong> Tool'un <code>outputSchema</code>'sına uyan yapılandırılmış çıktı. " +
        "Çağıran taraf metni ayrıştırmak zorunda kalmaz — “üç dil aynı çıktıyı üretir” tezi ancak bu alan " +
        "doluysa ÖLÇÜLEBİLİR. Sunucu <code>outputSchema</code> bildirmezse bu alan hiç üretilmez." +
        (eksikAlanlar.length ? ` <span class="err">Sözleşmede zorunlu ama eksik: ${esc(eksikAlanlar.join(", "))}</span>` : ""),
      scVar ? blok("structuredContent", sc, { tag: "VERİ", tagSinif: "in", acik: true }) : null,
    ),
  );

  // isError
  const isError = r.isError;
  kutu.append(
    anatomiParcasi(
      "isError",
      isError !== undefined,
      "<strong>İŞ KURALI HATASI BAYRAĞI.</strong> JSON-RPC <code>error</code> ile KARIŞTIRILMAMALIDIR. " +
        "<code>isError:true</code> demek “istek protokol açısından geçerliydi, sunucu çalıştı, ama iş " +
        "reddedildi/başarısız oldu” demektir — LLM bunu okuyup düzeltebilir. Protokol hatasını ise okuyamaz." +
        (isError === true ? ' <span class="err">Bu cevapta true — işlem BAŞARISIZ.</span>' : isError === false ? " Bu cevapta false." : ""),
      null,
    ),
  );

  // resultType
  kutu.append(
    anatomiParcasi(
      "resultType",
      r.resultType !== undefined,
      "<strong>SONUÇ ZARFI TÜRÜ.</strong> 2026-07-28'de <strong>zorunludur</strong>: " +
        "<code>\"complete\"</code> (iş bitti) veya <code>\"input_required\"</code> (eksik bilgi var, MRTR başlar). " +
        "Alanı olmayan bir sonucu client <code>\"complete\"</code> saymalıdır — eski sunucularla uyum kuralı budur. " +
        (v2
          ? r.resultType === "complete"
            ? "Bu cevapta <code>complete</code> — doğru."
            : `Bu cevapta <code>${esc(String(r.resultType))}</code>.`
          : "Bu oturum v1 konuşuyor; alanın olmaması BEKLENEN durumdur."),
      null,
      v2 ? "badge-v2" : "",
    ),
  );

  // _meta.serverInfo
  const si = r._meta?.["io.modelcontextprotocol/serverInfo"];
  kutu.append(
    anatomiParcasi(
      "_meta.io.modelcontextprotocol/serverInfo",
      Boolean(si),
      "<strong>SUNUCU KİMLİĞİ.</strong> v2'de el sıkışma olmadığı için sunucunun kim olduğunu söyleyebileceği " +
        "tek yer sonuçların <code>_meta</code>'sıdır — bu yüzden HER sonuçta tekrar gelir. " +
        "v1'de aynı bilgi <code>initialize</code> cevabında BİR KEZ verilir ve bağlantı boyunca hatırlanır.",
      si ? blok("serverInfo", si, { tag: "META", acik: true }) : null,
    ),
  );

  kutu.append(
    el("h2", { class: "sec-title", text: "Ham istek ve cevap" }),
    istek ? blok("İstek", istek, { tag: "→ GİDEN", tagSinif: "out" }) : null,
    blok("Cevap", cevap, { tag: "← GELEN", tagSinif: "in" }),
  );
}

// ═══════════════════════════ PANEL 4 — HAM TRAFİK ═══════════════════════════

async function trafikYenile() {
  const r = await api("/api/kayit");
  const liste = $("#trafik-liste");
  liste.innerHTML = "";
  const kayit = r.govde?.kayit ?? [];
  $("#trafik-ozet").textContent = kayit.length ? `${kayit.length} mesaj` : "Kayıt yok (bağlı değilsiniz).";
  for (const k of kayit.slice().reverse()) {
    const tagSinif =
      k.tur === "istek" ? "out" : k.tur === "yanit" ? "in" : k.tur === "sunucu-istegi" ? "srv" : k.tur === "cop" ? "bad" : "";
    const metod = k.ham?.method ?? (k.ham?.error ? "(hata cevabı)" : "(sonuç)");
    const d = blok(`#${k.sira} · ${metod}${k.ham?.id !== undefined ? " · id=" + JSON.stringify(k.ham.id) : ""}`, k.ham, {
      tag: `${k.yon} ${k.tur}`,
      tagSinif,
      vurgu: ["_meta", "resultType", "requestState", "inputRequests", "structuredContent", "isError"],
    });
    if (k.not) {
      d.querySelector(".blk-body").prepend(el("div", { class: "explain" }, el("p", { text: k.not })));
    }
    liste.append(d);
  }
  const st = r.govde?.stderr ?? [];
  $("#trafik-stderr").textContent = st.length ? st.join("\n") : "—";
}
