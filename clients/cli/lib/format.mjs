// -----------------------------------------------------------------------------
// clients/cli/lib/format.mjs — renk, tablo, metin yardımcıları
//
// wizard.mjs'in çizim desenlerinin sadeleştirilmiş hâli. Bağımlılık yok:
// tablo ve sarma elle çizilir; Ink yalnızca chat TUI'sinde devreye girer.
// -----------------------------------------------------------------------------

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

/** Renk fabrikası: makePaint(false) tüm kodları boş dizeye indirger. */
export function makePaint(useColor) {
  const C = new Proxy(CODES, { get: (t, k) => (useColor ? t[k] ?? "" : "") });
  const paint = (code, s) => (useColor ? `${code}${s}${C.reset}` : String(s));
  return { C, paint };
}

export function visibleLength(s) {
  // ANSI kaçış dizileri görünür genişliğe sayılmaz.
  return String(s).replace(/\x1b\[[0-9;]*m/g, "").length;
}

export function wrapText(text, width) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    const lead = para.match(/^\s*/)[0];
    // Tek başına kolona sığmayan kelimeler (uzun tool adları, id'ler) sert bölünür;
    // aksi hâlde tablo çizgileri taşar.
    const words = para
      .trim()
      .split(/\s+/)
      .flatMap((w) => {
        if (visibleLength(w) <= width - lead.length) return [w];
        const chunks = [];
        for (let i = 0; i < w.length; i += Math.max(1, width - lead.length)) {
          chunks.push(w.slice(i, i + Math.max(1, width - lead.length)));
        }
        return chunks;
      });
    let line = lead;
    for (const w of words) {
      const cand = line === lead ? lead + w : line + " " + w;
      if (visibleLength(cand) > width && line !== lead) {
        out.push(line);
        line = lead + w;
      } else {
        line = cand;
      }
    }
    out.push(line);
  }
  return out;
}

export function termWidth(stream = process.stdout) {
  const raw = stream.columns || 100;
  return Math.max(80, Math.min(110, raw));
}

/** Hücre içi sarma destekli basit tablo (wizard.mjs deseninin küçüğü). */
export function renderTable(headers, rows, { maxWidth = 100, paint = (c, s) => String(s), C = {} } = {}) {
  const cols = headers.length;
  const all = [headers, ...rows];
  const natural = new Array(cols).fill(0);
  for (const r of all) {
    for (let i = 0; i < cols; i++) {
      for (const ln of String(r[i] ?? "").split("\n")) natural[i] = Math.max(natural[i], visibleLength(ln));
    }
  }
  const borders = cols * 3 + 1;
  const avail = maxWidth - borders;
  const widths = natural.slice();
  let guard = 0;
  while (widths.reduce((a, b) => a + b, 0) > avail && guard++ < 5000) {
    let idx = 0;
    for (let i = 1; i < cols; i++) if (widths[i] > widths[idx]) idx = i;
    if (widths[idx] <= 8) break;
    widths[idx]--;
  }
  const gline = (l, m, r) => paint(C.gray ?? "", l + widths.map((w) => "─".repeat(w + 2)).join(m) + r);
  const out = [gline("┌", "┬", "┐")];
  const emit = (cells, bold) => {
    const wrapped = cells.map((c, i) => {
      const lines = [];
      for (const seg of String(c ?? "").split("\n")) lines.push(...wrapText(seg, widths[i]));
      return lines.length ? lines : [""];
    });
    const h = Math.max(...wrapped.map((x) => x.length));
    for (let k = 0; k < h; k++) {
      const parts = wrapped.map((x, i) => {
        const txt = x[k] ?? "";
        const pad = " ".repeat(Math.max(0, widths[i] - visibleLength(txt)));
        return " " + (bold ? paint(C.bold ?? "", txt) : txt) + pad + " ";
      });
      out.push(paint(C.gray ?? "", "│") + parts.join(paint(C.gray ?? "", "│")) + paint(C.gray ?? "", "│"));
    }
  };
  emit(headers, true);
  out.push(gline("├", "┼", "┤"));
  for (const r of rows) emit(r, false);
  out.push(gline("└", "┴", "┘"));
  return out;
}

/** Açıklamanın ilk cümlesi — tablolarda gürültüyü keser. */
export function firstSentence(s) {
  const t = String(s ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const m = t.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : t).trim();
}

/** Annotation'lardan tür özeti: sözleşmedeki "kind" alanının tel karşılığı. */
export function annotationSummary(tool) {
  const a = tool?.annotations ?? {};
  const parts = [a.readOnlyHint ? "okuma" : "yazma"];
  if (a.destructiveHint) parts.push("yıkıcı");
  if (a.idempotentHint) parts.push("idempotent");
  if (a.openWorldHint) parts.push("open-world");
  return parts.join(" · ");
}

/**
 * WriteResult'ı (contract/tools.json $defs/WriteResult) okunur satırlara döker.
 * Hem düz chat modu hem Ink TUI aynı satırları kullanır — iki mod arasında
 * anlatı farkı olmasın diye tek yerde üretilir.
 */
export function writeResultLines(wr) {
  if (!wr || typeof wr !== "object") return ["(writeResult yok)"];
  const lines = [];
  lines.push(`dryRun: ${wr.dryRun ? "evet" : "hayır"} · strateji: ${wr.strategy ?? "-"}`);
  if (wr.strategyExplanation) lines.push(`gerekçe: ${firstSentence(wr.strategyExplanation)}`);
  const planned = Array.isArray(wr.planned) ? wr.planned : [];
  if (planned.length) {
    lines.push(
      `planned (${planned.length} mutation): ` +
        planned.map((p) => `${p.path}${p.stepLabel ? ` [${p.stepLabel}]` : ""}`).join(" → "),
    );
  }
  const te = wr.timeEntry;
  if (te && typeof te === "object") {
    const bits = [];
    if (te.id) bits.push(`id=${te.id}`);
    if (te.date) bits.push(`date=${te.date}`);
    if (te.timeSpent != null) bits.push(`timeSpent=${te.timeSpent} dk`);
    if (te.description) bits.push(`açıklama="${te.description}"`);
    lines.push(`timeEntry: ${bits.join(" · ") || JSON.stringify(te)}`);
  }
  if (wr.deduped) lines.push("deduped: EVET — aynı sourceID'li kayıt zaten vardı, yazma atlandı");
  for (const w of wr.warnings ?? []) lines.push(`uyarı: ${w}`);
  const errs = wr.errors ?? [];
  if (errs.length) for (const e of errs) lines.push(`HATA: ${e?.message ?? JSON.stringify(e)}`);
  else lines.push("errors: [] (temiz — repo kuralına göre işlem BAŞARILI)");
  return lines;
}
