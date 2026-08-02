/* ==========================================================================
   xurrent-mcp — web arayüzü mantığı
   Bağımlılık YOK. Backend sözleşmesi: clients/web/API.md
   Üç dil de aynı dört ucu sunar; bu dosya hangi dilin arkada olduğunu BİLMEZ.
   ========================================================================== */
"use strict";

// ── Durum ────────────────────────────────────────────────────────────────────
const state = {
  /**
   * Sohbet geçmişi. İÇERİĞİ ARAYÜZ TARAFINDAN YORUMLANMAZ (API.md §2):
   * backend'in `done` olayında döndürdüğü dizi aynen saklanır ve bir sonraki
   * istekte aynen geri gönderilir. Böylece Anthropic'in tool_use/tool_result
   * blok biçimi arayüze sızmaz ve üç backend kendi SDK biçimini kullanabilir.
   */
  messages: [],
  config: null,
  busy: false,
  /** Yanıt bekleyen onay istekleri: elicitId → kart elemanı */
  pendingElicits: new Map(),
  /** Devam eden tool kartları: toolUseId → kart elemanı */
  toolCards: new Map(),
  abort: null,
};

// ── Kısayollar ───────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const chatInner = $("chat-inner");
const chatEl = $("chat");

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text; // textContent → XSS yok, kaçırmaya gerek yok
  return n;
}

// Sohbet penceresi "aşağıya yapışır" — ama kullanıcı yukarı kaydırdıysa DEĞİL.
// Akış sırasında saniyede onlarca kez çağrılır; bu yüzden yumuşak kaydırma
// KULLANILMAZ (her çağrı animasyonu baştan başlatır ve kaydırma takılı kalır).
let stickToBottom = true;
chatEl.addEventListener("scroll", () => {
  stickToBottom = chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - 48;
});

function scrollToBottom(force = false) {
  if (!stickToBottom && !force) return;
  chatEl.scrollTop = chatEl.scrollHeight;
}

function hideEmpty() {
  const e = $("empty");
  if (e) e.remove();
}

// ── Tema ─────────────────────────────────────────────────────────────────────
// Varsayılan: işletim sisteminin tercihi (prefers-color-scheme).
// Kullanıcı düğmeye basarsa seçim localStorage'a yazılır ve otomatiği EZER.
const THEMES = ["auto", "light", "dark"];
function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("xurrent-theme", t);
  } catch {
    /* gizli mod: sessizce geç */
  }
}
function cycleTheme() {
  let cur = "auto";
  try {
    cur = localStorage.getItem("xurrent-theme") || "auto";
  } catch {}
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
}
(function initTheme() {
  try {
    const saved = localStorage.getItem("xurrent-theme");
    if (saved && THEMES.includes(saved)) applyTheme(saved);
    else document.documentElement.removeAttribute("data-theme");
  } catch {
    document.documentElement.removeAttribute("data-theme");
  }
})();

// ── /api/config ──────────────────────────────────────────────────────────────
const MODE_LABEL = { mock: "mock (fixtures)", live: "CANLI XURRENT" };
const STRATEGY_LABEL = {
  two_step: "two_step",
  link_first: "link_first",
  date_first: "date_first",
};
const STRATEGY_HINT = {
  two_step: "İki adım: önce ticket'a bağlar, sonra tarihi/saati düzeltir. Her şeyi korur ama <strong>atomik değildir</strong>.",
  link_first: "Tek adım. Ticket bağı korunur ama <strong>tarih her zaman bugün</strong> olur; T-1 karşılanamaz.",
  date_first: "Tek adım. Tarih ve saat tam doğru ama kayıt <strong>ticket'a bağlanmaz</strong>.",
};
const PROVIDER_LABEL = {
  mock: "mock", ics: "ics dosyası", google: "Google Calendar", graph: "Microsoft Graph", auto: "auto",
};
const LANG_LABEL = { typescript: "TypeScript", python: "Python", csharp: "C#" };

function badge(label, value, tone) {
  const b = el("div", "badge");
  if (tone) b.dataset.tone = tone;
  b.append(el("span", "dot"), el("span", "label", label), el("span", "value", value));
  return b;
}

function renderConfig(cfg) {
  const box = $("badges");
  box.textContent = "";

  // Mod rozetinde CANLI durumu kırmızı ve nabızlıdır — kazayla gerçek Xurrent'a
  // yazmanın en ucuz önlemi, modun her an görünür olmasıdır.
  box.append(badge("Mod", MODE_LABEL[cfg.mode] ?? cfg.mode, cfg.mode === "live" ? "live" : "ok"));
  box.append(badge("Strateji", STRATEGY_LABEL[cfg.strategy] ?? cfg.strategy ?? "—", "warn"));
  box.append(badge("Takvim", PROVIDER_LABEL[cfg.calendarProvider] ?? cfg.calendarProvider ?? "—"));
  if (cfg.language) box.append(badge("Sunucu", LANG_LABEL[cfg.language] ?? cfg.language));
  box.append(badge("Model", cfg.model ?? "—"));
  if (cfg.dryRunForced) box.append(badge("Dry-run", "ZORUNLU", "warn"));
  if (cfg.timeZone) box.append(badge("Saat dilimi", cfg.timeZone));

  const hint = STRATEGY_HINT[cfg.strategy];
  if (hint) {
    $("hint").innerHTML = `<strong>${STRATEGY_LABEL[cfg.strategy]}</strong> — ${hint}`;
    $("hint-slot").hidden = false;
  }

  if (cfg.hasApiKey === false) {
    $("input").disabled = true;
    $("send").disabled = true;
    $("input").placeholder = "ANTHROPIC_API_KEY tanımlı değil";
    $("note").innerHTML =
      "<strong>ANTHROPIC_API_KEY tanımlı değil.</strong> <code>.env</code> dosyasına ekleyip sunucuyu yeniden başlat. " +
      "(MCP sunucusunu Claude Code'a takacaksan bu anahtar gerekmez — LLM'i host uygulama sağlar.)";
  }
}

async function loadConfig() {
  try {
    const r = await fetch("/api/config");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.config = await r.json();
    renderConfig(state.config);
  } catch (err) {
    $("badges").textContent = "";
    $("badges").append(badge("Bağlantı", "yok", "live"));
    addErrorCard("Yapılandırma okunamadı", `/api/config yanıt vermedi: ${err.message}`);
  }
}

// ── Mesaj balonları ──────────────────────────────────────────────────────────
function addMessage(role, text) {
  hideEmpty();
  const wrap = el("div", `msg ${role}`);
  wrap.append(el("div", "avatar", role === "user" ? "S" : "X"));
  const body = el("div", "body");
  const bubble = el("div", "bubble", text ?? "");
  body.append(bubble);
  wrap.append(body);
  chatInner.append(wrap);
  scrollToBottom();
  return bubble;
}

function addErrorCard(title, message) {
  hideEmpty();
  const c = el("div", "error-card");
  c.append(el("strong", null, title));
  c.append(document.createTextNode(message));
  chatInner.append(c);
  scrollToBottom();
}

function addThinking() {
  const t = el("div", "thinking");
  t.append(el("span", "spinner"), el("span", null, "Düşünüyor…"));
  chatInner.append(t);
  scrollToBottom();
  return t;
}

// ── Tool kartı ───────────────────────────────────────────────────────────────
function addToolCard(ev) {
  hideEmpty();
  const card = el("div", "tool-card");
  card.dataset.state = "running";

  const head = el("div", "tool-head");
  head.append(el("span", "tool-icon", "🔧"));
  head.append(el("span", "tool-name", ev.name));
  const status = el("span", "tool-status", "çalışıyor…");
  head.append(status);
  card.append(head);

  const body = el("div", "tool-body");

  // Argümanlar "chip" olarak — LLM'in tool'a NE gönderdiği dersin bir parçasıdır.
  const kv = el("div", "kv");
  const entries = Object.entries(ev.args ?? {});
  if (entries.length === 0) {
    kv.append(el("span", "chip", "(argüman yok)"));
  } else {
    for (const [k, v] of entries) {
      const chip = el("span", "chip");
      chip.append(el("b", null, k + ": "));
      chip.append(document.createTextNode(typeof v === "object" ? JSON.stringify(v) : String(v)));
      kv.append(chip);
    }
  }
  body.append(kv);
  card.append(body);

  chatInner.append(card);
  scrollToBottom();
  return { card, head, body, status };
}

function rawDetails(label, obj) {
  const d = el("details", "raw");
  d.append(el("summary", null, label));
  d.append(el("pre", null, JSON.stringify(obj, null, 2)));
  return d;
}

function fillToolResult(parts, ev) {
  const { card, head, body, status } = parts;
  const res = ev.result;

  status.textContent = ev.durationMs != null ? `${ev.durationMs} ms` : "tamam";
  card.dataset.state = ev.isError ? "error" : "done";
  head.querySelector(".tool-icon").textContent = ev.isError ? "⛔" : "✅";

  // Yazma/okuma ayrımı ARAYÜZDE tool adına bakılarak yapılmaz — sonuçta dryRun
  // alanının varlığı yeterli sinyaldir. Böylece arayüz tool semantiğinden bağımsız kalır.
  const isWriteShape = res && typeof res === "object" && "dryRun" in res;
  const isDryRun = isWriteShape && res.dryRun === true;
  if (isDryRun) {
    card.dataset.kind = "dryrun";
    head.insertBefore(el("span", "tag dryrun", "dry-run"), status);
  } else if (isWriteShape) {
    head.insertBefore(el("span", "tag write", "yazma"), status);
  } else if (!ev.isError) {
    head.insertBefore(el("span", "tag read", "okuma"), status);
  }

  // Özet satırı — backend üretir (API.md §2). Yoksa yalnızca ham JSON gösterilir.
  if (ev.summary) {
    const s = el("div", "summary-line");
    s.append(el("span", ev.isError ? "bad" : "ok", ev.isError ? "✘ " : "✔ "));
    s.append(document.createTextNode(ev.summary));
    body.append(s);
  }

  // ── dry-run özel görünümü: PLAN ve UYARILAR gizlenmez ────────────────────
  if (Array.isArray(res?.planned) && res.planned.length) {
    const plan = el("div", "plan");
    plan.append(
      el(
        "div",
        "plan-title",
        isDryRun
          ? `Planlanan ${res.planned.length} mutation — hiçbiri gönderilmedi`
          : `Çalıştırılan ${res.planned.length} mutation`,
      ),
    );
    for (const step of res.planned) {
      const s = el("div", "plan-step");
      const h = el("div", "plan-step-head");
      if (step.stepLabel) h.append(el("span", "plan-step-label", step.stepLabel));
      h.append(el("span", "plan-step-path", step.path ?? "?"));
      s.append(h);
      if (step.mutation) s.append(el("pre", null, String(step.mutation).trim()));
      if (step.input && Object.keys(step.input).length) s.append(rawDetails("değişkenler", step.input));
      plan.append(s);
    }
    body.append(plan);
  }

  if (res?.strategyExplanation) {
    const p = el("div", "summary-line");
    p.style.color = "var(--fg-muted)";
    p.style.fontSize = "13px";
    p.textContent = res.strategyExplanation;
    body.append(p);
  }

  // Uyarılar HER ZAMAN görünür. "Atomik değildir", "tarih bugün olacak",
  // "ticket'a bağlanmayacak" gibi maddeler saklanırsa tool yalan söylemiş olur.
  const warnings = [];
  if (Array.isArray(res?.warnings)) warnings.push(...res.warnings);
  for (const p of res?.planned ?? []) if (Array.isArray(p.warnings)) warnings.push(...p.warnings);
  if (warnings.length) {
    const ul = el("ul", "warnings");
    for (const w of [...new Set(warnings)]) ul.append(el("li", null, w));
    body.append(ul);
  }

  if (Array.isArray(res?.errors) && res.errors.length) {
    const ul = el("ul", "warnings");
    for (const e of res.errors) ul.append(el("li", null, e.message ?? JSON.stringify(e)));
    body.append(ul);
  }

  body.append(rawDetails("ham JSON", res ?? { bilgi: "sonuç yok" }));
  scrollToBottom();
}

// ── Onay kartı (MCP elicitation) ─────────────────────────────────────────────
function addElicitCard(ev) {
  hideEmpty();
  const card = el("div", "elicit");

  const title = el("div", "elicit-title");
  title.append(el("span", null, "🔐"), el("span", null, "Onay gerekiyor"));
  card.append(title);
  card.append(el("div", "elicit-msg", ev.message ?? "Sunucu onay istiyor."));

  if (ev.details && typeof ev.details === "object" && Object.keys(ev.details).length) {
    const dl = el("dl", "elicit-details");
    for (const [k, v] of Object.entries(ev.details)) {
      const row = el("div");
      row.append(el("dt", null, k), el("dd", null, String(v)));
      dl.append(row);
    }
    card.append(dl);
  }

  const actions = el("div", "elicit-actions");
  const yes = el("button", "btn primary", ev.confirmLabel || "Onayla");
  const no = el("button", "btn secondary", ev.cancelLabel || "İptal");
  yes.type = "button";
  no.type = "button";
  actions.append(yes, no);
  card.append(actions);

  const resolve = async (accept) => {
    yes.disabled = true;
    no.disabled = true;
    try {
      const r = await fetch("/api/elicit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ev.id, accept }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      actions.remove();
      card.classList.add("resolved");
      const v = el("div", `elicit-verdict ${accept ? "yes" : "no"}`, accept ? "✔ Onaylandı" : "✘ İptal edildi");
      card.append(v);
    } catch (err) {
      yes.disabled = false;
      no.disabled = false;
      addErrorCard("Onay gönderilemedi", err.message);
    }
    state.pendingElicits.delete(ev.id);
  };

  yes.addEventListener("click", () => resolve(true));
  no.addEventListener("click", () => resolve(false));

  chatInner.append(card);
  scrollToBottom();
  state.pendingElicits.set(ev.id, card);
  return card;
}

// ── SSE ayrıştırma ───────────────────────────────────────────────────────────
// EventSource yalnızca GET destekler; sohbet POST olduğu için çerçeveleri
// fetch + ReadableStream üzerinden kendimiz ayrıştırıyoruz (API.md §2).
function parseFrame(frame) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    // ":" ile başlayan satırlar SSE yorumudur (keep-alive) — yok sayılır.
  }
  if (!dataLines.length) return null;
  let data = null;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    data = { raw: dataLines.join("\n") };
  }
  return { event, data };
}

async function streamChat(messages) {
  state.abort = new AbortController();
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    signal: state.abort.signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`/api/chat HTTP ${res.status}${txt ? " — " + txt.slice(0, 200) : ""}`);
  }
  if (!res.body) throw new Error("Yanıt gövdesi yok — tarayıcı akışı desteklemiyor olabilir.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let thinking = addThinking();
  let bubble = null;
  let finished = false;

  const dropThinking = () => {
    if (thinking) {
      thinking.remove();
      thinking = null;
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // \r\n → \n: bazı sunucular CRLF gönderir, çerçeve sınırı bozulmasın.
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const parsed = parseFrame(frame);
        if (!parsed) continue;
        const { event, data } = parsed;

        if (event === "text") {
          dropThinking();
          if (!bubble) bubble = addMessage("assistant", "");
          bubble.classList.add("streaming");
          bubble.textContent += data.delta ?? "";
          scrollToBottom();
        } else if (event === "tool_use") {
          dropThinking();
          if (bubble) bubble.classList.remove("streaming");
          bubble = null; // tool'dan sonraki metin YENİ bir balona yazılır
          state.toolCards.set(data.id, addToolCard(data));
        } else if (event === "tool_result") {
          const parts = state.toolCards.get(data.id);
          if (parts) {
            fillToolResult(parts, data);
            state.toolCards.delete(data.id);
          } else {
            // tool_use kaçmışsa yine de göster — sessizce yutmak en kötüsü.
            const p = addToolCard({ id: data.id, name: data.name, args: {} });
            fillToolResult(p, data);
          }
          thinking = addThinking();
        } else if (event === "elicit") {
          dropThinking();
          if (bubble) bubble.classList.remove("streaming");
          bubble = null;
          addElicitCard(data);
          thinking = addThinking();
        } else if (event === "done") {
          finished = true;
          if (Array.isArray(data.messages)) state.messages = data.messages;
          dropThinking();
          if (bubble) bubble.classList.remove("streaming");
          bubble = null;
        } else if (event === "error") {
          finished = true;
          dropThinking();
          if (bubble) bubble.classList.remove("streaming");
          bubble = null;
          addErrorCard("Hata", data.message ?? "Bilinmeyen hata");
        }
      }
    }
  } finally {
    dropThinking();
    if (bubble) bubble.classList.remove("streaming");
    // Yarım kalan tool kartlarını "asılı" bırakma.
    for (const [, parts] of state.toolCards) {
      parts.status.textContent = "yanıt gelmedi";
      parts.card.dataset.state = "error";
    }
    state.toolCards.clear();
  }

  if (!finished) {
    addErrorCard("Akış beklenmedik şekilde kesildi", "Sunucu 'done' veya 'error' göndermeden bağlantıyı kapattı.");
  }
}

// ── Gönderme ─────────────────────────────────────────────────────────────────
async function send(text) {
  const t = text.trim();
  if (!t || state.busy) return;

  state.busy = true;
  $("send").disabled = true;
  $("input").value = "";
  autoSize();

  stickToBottom = true; // yeni mesaj gönderildiğinde her zaman en alta dön
  addMessage("user", t);
  scrollToBottom(true);
  // İlk turda geçmiş boştur; sonraki turlarda backend'in döndürdüğü diziye eklenir.
  const outgoing = [...state.messages, { role: "user", content: t }];
  state.messages = outgoing;

  try {
    await streamChat(outgoing);
  } catch (err) {
    if (err.name !== "AbortError") addErrorCard("İstek başarısız", err.message);
  } finally {
    state.busy = false;
    state.abort = null;
    if (state.config?.hasApiKey !== false) $("send").disabled = false;
    $("input").focus();
  }
}

// ── Yazma alanı ──────────────────────────────────────────────────────────────
function autoSize() {
  const ta = $("input");
  // "auto" YETMEZ: flex kutusunda auto yükseklik kapsayıcıya göre çözülür ve
  // scrollHeight yanlış (kocaman) gelir. 0'a çekince scrollHeight her zaman
  // İÇERİĞİN gerçek yüksekliğini verir.
  ta.style.height = "0px";
  ta.style.height = Math.min(Math.max(ta.scrollHeight, 34), 180) + "px";
}

// ── Olay bağlantıları ────────────────────────────────────────────────────────
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  send($("input").value);
});

$("input").addEventListener("input", autoSize);
$("input").addEventListener("keydown", (e) => {
  // Enter gönderir, Shift+Enter satır atlar. IME (Türkçe/CJK) sırasında dokunma.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send($("input").value);
  }
});

for (const b of document.querySelectorAll(".example")) {
  b.addEventListener("click", () => {
    $("input").value = b.textContent.trim();
    autoSize();
    $("input").focus();
    document.body.classList.remove("nav-open");
  });
}

$("theme-btn").addEventListener("click", cycleTheme);
$("theme-btn-m").addEventListener("click", cycleTheme);
$("nav-btn").addEventListener("click", () => document.body.classList.toggle("nav-open"));
$("backdrop").addEventListener("click", () => document.body.classList.remove("nav-open"));

$("clear-btn").addEventListener("click", () => {
  if (state.busy && state.abort) state.abort.abort();
  state.messages = [];
  state.toolCards.clear();
  state.pendingElicits.clear();
  chatInner.textContent = "";
  const empty = el("div", "empty");
  empty.id = "empty";
  empty.append(el("h1", null, "Sohbet temizlendi"));
  empty.append(el("p", null, "Yeni bir istekle başlayabilirsin."));
  chatInner.append(empty);
  document.body.classList.remove("nav-open");
});

// ── Başlat ───────────────────────────────────────────────────────────────────
loadConfig();
// İlk boyutlandırma İLK YERLEŞİMDEN SONRA yapılmalı: defer script'i yerleşim
// tamamlanmadan çalışır ve o anda okunan scrollHeight gerçeği yansıtmaz
// (kutu, kapsayıcı yüksekliğine göre şişmiş görünür).
requestAnimationFrame(autoSize);
window.addEventListener("load", autoSize);
