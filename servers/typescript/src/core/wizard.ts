/**
 * timesheet_wizard — sunucu-güdümlü sohbet durum makinesi (contract/wizard.md).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEZ: İnce host'ta (Copilot Studio, düz REPL) chatbot olmak için LLM gerekmez —
 * deterministik durum makinesi + imzalı sessionState yeter. Host yalnızca
 * kullanıcı cümlesini iletir, dönen soruyu gösterir.
 *
 * BU DOSYA İŞ MANTIĞI YENİDEN YAZMAZ: whoami / timesheet bağlamı / açık işler /
 * tekil ve toplu yazma / takvim planı, HEPSİ core/toolimpl.ts'teki aynı
 * fonksiyonlardır. Sihirbaz sadece diyalog katmanıdır.
 *
 * ADIM ETİKETLERİ (üç dilde aynı olmak zorunda — senaryo h + docs/wizard 15.
 * adım bunu sabitler): yanıtın `step`i, az önce İŞLENEN adımın etiketidir;
 * `nextQuestion` ise BİR SONRAKİ adımın sorusudur:
 *
 *   (ilk çağrı)              → step=start          soru: iş seçimi (+ "takvim")
 *   seçim işlendi            → step=pick_work      soru: süre
 *   süre işlendi ("2 saat")  → step=duration       soru: tarih/saat/açıklama
 *   detay işlendi            → step=detail         soru: 3 strateji seçeneği
 *   strateji işlendi         → step=strategy       dry-run planı + evet/hayır
 *   "evet" işlendi           → step=write          done=true, writeResult dolu
 *   "hayır"/iptal            → step=done           done=true
 *   "takvim" işlendi         → step=calendar_plan  öneri listesi + evet/hayır/eleme
 *   takvim onayına geçildi   → step=calendar_confirm  bulk dry-run + evet/hayır
 *
 * NOT — "confirm" etiketi: bu tabloda dry-run planı "strategy" yanıtında
 * gösterilir (strateji cevabı işlenir işlenmez plan çıkarılır); "confirm"
 * etiketi ayrıca ÜRETİLMEZ. Sözleşmedeki enum değeri MRTR/elicitation host
 * varyantı için ayrılmıştır (wizard.md §5) — makine sabit, etiket rezervde.
 *
 * Hatalı/anlaşılamayan cevap: adım DEĞİŞMEZ; reply neyin beklendiğini yeniden
 * anlatır, nextQuestion AYNEN tekrar döner (MRTR'ın "eksikse yeniden sor"
 * kuralının sohbet karşılığı).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type {
  CreateTimeEntryInput,
  TargetType,
  ValidationError,
  WizardChoice,
  WizardQuestion,
  WizardResult,
  WizardStep,
  WorkItem,
} from "../types.js";
import { addDaysISO, diffDaysISO, toOffsetISO, todayISO, zonedToInstant } from "../util/time.js";
import { getTimesheet, type ToolContext } from "./context.js";
import { humanMinutes } from "./result.js";
import {
  finishBulk,
  finishTimeEntry,
  prepareBulk,
  prepareTimeEntry,
  renderBulk,
  renderWriteResult,
  runListOpenWork,
  runListTimeEntries,
  runPlanFromCalendar,
  runWhoami,
} from "./toolimpl.js";
import {
  plannedFingerprintOf,
  signWizardState,
  verifyWizardState,
  type WizardStateData,
} from "./wizard-state.js";

// ─────────────────────────────────────────────────────────────────────────────
// Cevap ayrıştırma (wizard.md §3) — üç dilde birebir aynı kurallar
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Türkçe küçük-harf katlaması: İ→i, I→ı (fake-gemini'deki `katla` deseni).
 * Sözleşme İ/I çiftini AÇIKÇA sabitler — locale'e bırakılmaz.
 */
export function katla(s: string): string {
  return (s ?? "").replace(/İ/g, "i").replace(/I/g, "ı").toLowerCase().trim();
}

const EVET_SETI = new Set(["evet", "onay", "onaylıyorum", "tamam", "e"]);
const HAYIR_SETI = new Set(["hayır", "iptal", "vazgeç", "h"]);

/** evet → true, hayır → false, anlaşılamadı → null. */
export function parseEvetHayir(utterance: string): boolean | null {
  const f = katla(utterance);
  if (EVET_SETI.has(f)) return true;
  if (HAYIR_SETI.has(f)) return false;
  return null;
}

export interface ParsedDuration {
  minutes: number;
  /** true ise "saat" birimiyle girildi — çevirim reply'da AÇIKÇA söylenir. */
  fromHours: boolean;
  raw: string;
}

/**
 * "2 saat" → 120 · "2 sa" → 120 · "1,5 saat" → 90 (ondalık virgül kabul) ·
 * "90" → 90 (çıplak sayı DAKİKA) · "45 dk"/"45 dakika" → 45.
 */
export function parseSure(utterance: string): ParsedDuration | null {
  const f = katla(utterance);
  const m = /^(\d+(?:[.,]\d+)?)\s*(saat|sa|dakika|dk)?$/.exec(f);
  if (!m) return null;
  const n = Number((m[1] as string).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2] === "saat" || m[2] === "sa") {
    return { minutes: Math.round(n * 60), fromHours: true, raw: m[1] as string };
  }
  // Çıplak sayı veya dk: DAKİKA. Ondalık dakika anlamsız → reddedilir.
  if (!Number.isInteger(n)) return null;
  return { minutes: n, fromHours: false, raw: m[1] as string };
}

/** choices varken: id · 1-bazlı sıra numarası · label'ın küçük-harf tam eşleşmesi. */
export function parseSecim(utterance: string, choices: WizardChoice[]): WizardChoice | null {
  const f = katla(utterance);
  if (!f) return null;
  const byId = choices.find((c) => katla(c.id) === f);
  if (byId) return byId;
  if (/^\d+$/.test(f)) {
    const idx = Number(f);
    if (idx >= 1 && idx <= choices.length) return choices[idx - 1] as WizardChoice;
    return null;
  }
  return choices.find((c) => katla(c.label) === f) ?? null;
}

export interface ParsedDetail {
  date: string;
  time: string | null;
  description: string | null;
}

/**
 * Serbest metin detay: tarih (bugün/dün/YYYY-MM-DD, yoksa bugün) + opsiyonel
 * saat (HH:MM, 24 saat) + kalanı açıklama. Ör. "dün 14:00 VPN bakımı".
 */
export function parseDetay(utterance: string, today: string): ParsedDetail {
  let date: string | null = null;
  let time: string | null = null;
  const desc: string[] = [];
  for (const token of (utterance ?? "").trim().split(/\s+/).filter(Boolean)) {
    const f = katla(token);
    if (date === null && f === "bugün") {
      date = today;
      continue;
    }
    if (date === null && f === "dün") {
      date = addDaysISO(today, -1);
      continue;
    }
    if (date === null && /^\d{4}-\d{2}-\d{2}$/.test(f)) {
      date = f;
      continue;
    }
    if (time === null && /^([01]?\d|2[0-3]):[0-5]\d$/.test(f)) {
      time = f.length === 4 ? `0${f}` : f;
      continue;
    }
    desc.push(token);
  }
  return { date: date ?? today, time, description: desc.length ? desc.join(" ") : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Soru üreticileri — "adım değişmez" kuralı aynı soruyu AYNEN tekrar ister
// ─────────────────────────────────────────────────────────────────────────────

const TAKVIM_CHOICE: WizardChoice = {
  id: "takvim",
  label: "Takvim: günün toplantılarından öneri üret",
  detail: "calendar_list_today + plan_time_entries_from_calendar ile toplu öneri",
};

function workChoices(items: WorkItem[]): WizardChoice[] {
  return [
    ...items.map((w) => ({
      id: w.id,
      label: `#${w.displayId} — ${w.subject ?? "(konusuz)"}`,
      detail: `${w.kind === "request" ? "Request" : "Task"} · ${w.statusLabel ?? w.status ?? "-"}`,
    })),
    TAKVIM_CHOICE,
  ];
}

function startQuestion(items: WorkItem[]): WizardQuestion {
  return {
    prompt:
      "Hangi işe zaman yazalım? Numara, id ya da başlıkla seçin; takvimden toplu öneri için 'takvim' yazın.",
    choices: workChoices(items),
    expectsFreeText: true,
  };
}

const DURATION_QUESTION: WizardQuestion = {
  prompt:
    "Ne kadar süre? Örnek: '2 saat', '1,5 saat', '90' (çıplak sayı DAKİKA sayılır — sözleşmenin tek birimi dakikadır).",
  expectsFreeText: true,
};

const DETAIL_QUESTION: WizardQuestion = {
  prompt:
    "Tarih (bugün / dün / YYYY-AA-GG), istersen başlangıç saati (SS:DD) ve kısa bir açıklama yazın — ör. 'dün 14:00 VPN bakımı'. Boş bırakırsanız tarih bugün olur.",
  expectsFreeText: true,
};

/** Üç backdate stratejisi — keeps/costs metinleri contract'taki backdateStrategies'ten. */
const STRATEGY_QUESTION: WizardQuestion = {
  prompt: "Hangi yazma stratejisi? (üçü de bir şeyden feragat eder — bkz. seçeneklerin bedeli)",
  choices: [
    {
      id: "two_step",
      label: "İki adımlı telafi (two_step)",
      detail:
        "Korur: ticket bağı, geçmiş tarih (T-1), başlangıç saati. Bedeli: 2 HTTP isteği, atomik değil.",
    },
    {
      id: "link_first",
      label: "Ticket bağı öncelikli (link_first)",
      detail: "Tek istek, atomik; ama tarih HER ZAMAN bugün olur ve başlangıç saati kaydedilmez.",
    },
    {
      id: "date_first",
      label: "Tarih öncelikli (date_first)",
      detail: "date/startedAt tam kontrol; ama kayıt ticket'a BAĞLANMAZ (assignment=null).",
    },
  ],
  expectsFreeText: true,
};

const CONFIRM_QUESTION: WizardQuestion = {
  prompt: "Onaylıyor musunuz? (evet / hayır)",
  choices: [
    { id: "evet", label: "Evet — planı Xurrent'a yaz" },
    { id: "hayır", label: "Hayır — vazgeç, hiçbir şey yazma" },
  ],
  expectsFreeText: true,
};

const CALENDAR_QUESTION: WizardQuestion = {
  prompt:
    "Bu önerilerle devam edilsin mi? 'evet' → toplu dry-run özeti · 'hayır' → vazgeç · 'N hariç' → N numaralı öneriyi ele (ör. '3 hariç').",
  choices: [
    { id: "evet", label: "Evet — önerilerle devam et" },
    { id: "hayır", label: "Hayır — vazgeç" },
  ],
  expectsFreeText: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Sonuç kurucuları
// ─────────────────────────────────────────────────────────────────────────────

interface StepOutput {
  step: WizardStep;
  reply: string;
  nextQuestion: WizardQuestion | null;
  data: WizardStateData | null;
  done: boolean;
  writeResult?: Record<string, unknown> | null;
  errors?: ValidationError[];
}

function finalize(ctx: ToolContext, out: StepOutput): WizardResult {
  const done = out.done;
  return {
    step: out.step,
    reply: out.reply,
    nextQuestion: done ? null : out.nextQuestion,
    // done=true → sessionState null (host için "sohbet bitti" işareti).
    sessionState: done || out.data === null ? null : signWizardState(ctx.cfg, out.step, out.data),
    done,
    writeResult: out.writeResult ?? null,
    errors: out.errors ?? [],
  };
}

function bitti(ctx: ToolContext, reply: string, errors: ValidationError[] = []): WizardResult {
  return finalize(ctx, { step: "done", reply, nextQuestion: null, data: null, done: true, errors });
}

// ─────────────────────────────────────────────────────────────────────────────
// Adım eylemleri
// ─────────────────────────────────────────────────────────────────────────────

async function openItems(ctx: ToolContext, personId: string, signal?: AbortSignal): Promise<WorkItem[]> {
  const work = await runListOpenWork(ctx, { personId, view: "all", first: 100 }, signal);
  return [...work.requests.nodes, ...work.tasks.nodes];
}

/** start eylemi: whoami + timesheet bağlamı; selamla, timeIncrement'i SÖYLE, işleri listele. */
async function startStep(ctx: ToolContext, preamble: string | null, signal?: AbortSignal): Promise<WizardResult> {
  const me = await runWhoami(ctx, signal);
  const ts = await getTimesheet(ctx, "$me", signal);
  const items = await openItems(ctx, "$me", signal);
  const inc = ts.timeIncrement ?? 60;

  const lines: string[] = [];
  if (preamble) lines.push(preamble, "");
  lines.push(
    `Merhaba ${me.person.name ?? ""}! Zaman girişi sihirbazı (LLM'siz, sunucu-güdümlü durum makinesi).`.trim(),
    `Süre kuralı: bu hesabın timeIncrement değeri ${inc} dakika — yazacağım her süre ${inc}'in KATI olmak zorunda.`,
    "",
    `Üzerinizdeki açık işler (${items.length}):`,
  );
  items.forEach((w, i) => {
    lines.push(`  ${i + 1}. #${w.displayId} — ${w.subject ?? "(konusuz)"} [${w.kind}]`);
  });
  lines.push(`  ${items.length + 1}. takvim — günün toplantılarından toplu öneri üret`);

  return finalize(ctx, {
    step: "start",
    reply: lines.join("\n"),
    nextQuestion: startQuestion(items),
    data: { personId: "$me" },
    done: false,
  });
}

/** start cevabı işlenir: iş seçimi ya da "takvim". */
async function handleStart(
  ctx: ToolContext,
  data: WizardStateData,
  utterance: string,
  signal?: AbortSignal,
): Promise<WizardResult> {
  const f = katla(utterance);
  const personId = data.personId ?? "$me";

  // "takvim"/"toplantı" kelimesi takvim dalına saptırır (wizard.md §3).
  if (f.includes("takvim") || f.includes("toplantı")) {
    return calendarPlanStep(ctx, { personId }, signal);
  }

  const items = await openItems(ctx, personId, signal);
  const choices = workChoices(items);
  const secim = parseSecim(utterance, choices);
  if (!secim || secim.id === TAKVIM_CHOICE.id) {
    if (secim?.id === TAKVIM_CHOICE.id) return calendarPlanStep(ctx, { personId }, signal);
    // Anlaşılamadı: adım DEĞİŞMEZ, aynı soru AYNEN döner.
    return finalize(ctx, {
      step: "start",
      reply:
        `"${utterance}" bir seçimle eşleşmedi. Listeden 1-${items.length} arası bir numara, ` +
        "bir iş id'si ya da başlığın tamamını yazın; takvim için 'takvim' deyin.",
      nextQuestion: startQuestion(items),
      data,
      done: false,
    });
  }

  const w = items.find((it) => it.id === secim.id)!;
  return finalize(ctx, {
    step: "pick_work",
    reply:
      `Seçilen iş: #${w.displayId} — ${w.subject ?? "(konusuz)"} [${w.kind}]` +
      `${w.statusLabel ? ` · durum: ${w.statusLabel}` : ""}\nid: ${w.id}`,
    nextQuestion: DURATION_QUESTION,
    data: {
      ...data,
      targetType: w.kind,
      targetId: w.id,
      targetLabel: `#${w.displayId} — ${w.subject ?? ""}`.trim(),
    },
    done: false,
  });
}

/** pick_work cevabı işlenir: süre. Çevirim AÇIKÇA söylenir; kat değilse SORULUR. */
async function handlePickWork(
  ctx: ToolContext,
  data: WizardStateData,
  utterance: string,
  signal?: AbortSignal,
): Promise<WizardResult> {
  const sure = parseSure(utterance);
  if (!sure) {
    return finalize(ctx, {
      step: "pick_work",
      reply:
        `"${utterance}" bir süre olarak anlaşılamadı. Kabul edilen biçimler: ` +
        "'2 saat', '2 sa', '1,5 saat', '90 dk', '90' (çıplak sayı DAKİKA).",
      nextQuestion: DURATION_QUESTION,
      data,
      done: false,
    });
  }

  const ts = await getTimesheet(ctx, data.personId ?? "$me", signal);
  const inc = ts.timeIncrement ?? 60;
  if (inc > 0 && sure.minutes % inc !== 0) {
    // Sessizce YUVARLANMAZ — kullanıcıya sorulur (wizard.md §2 duration satırı).
    const down = Math.floor(sure.minutes / inc) * inc;
    const up = down + inc;
    return finalize(ctx, {
      step: "pick_work",
      reply:
        `${sure.minutes} dakika bu hesapta yazılamaz: timeIncrement=${inc}, süre ${inc}'in KATI olmalı. ` +
        `Sessizce yuvarlamıyorum — ${down > 0 ? `${down} veya ` : ""}${up} dakika yazabilirim; hangisini istersiniz?`,
      nextQuestion: DURATION_QUESTION,
      data,
      done: false,
    });
  }

  const cevrim = sure.fromHours
    ? `«${sure.raw} saat» → ${sure.minutes} dakika olarak çevirdim (Xurrent'ın tek süre birimi DAKİKADIR). `
    : `${sure.minutes} dakika olarak aldım. `;
  return finalize(ctx, {
    step: "duration",
    reply: cevrim + `Kayıt: ${data.targetLabel ?? "?"} · ${humanMinutes(sure.minutes)}.`,
    nextQuestion: DETAIL_QUESTION,
    data: { ...data, minutes: sure.minutes },
    done: false,
  });
}

/** duration cevabı işlenir: tarih + saat + açıklama. */
async function handleDuration(ctx: ToolContext, data: WizardStateData, utterance: string): Promise<WizardResult> {
  const today = todayISO(ctx.cfg.timeZone);
  const d = parseDetay(utterance, today);

  const delta = diffDaysISO(today, d.date);
  if (delta > ctx.cfg.maxBackdateDays) {
    return finalize(ctx, {
      step: "duration",
      reply:
        `${d.date} izin verilen geriye yazma sınırının dışında ` +
        `(XURRENT_MAX_BACKDATE_DAYS=${ctx.cfg.maxBackdateDays} → en eski ${addDaysISO(today, -ctx.cfg.maxBackdateDays)}). ` +
        "Daha yakın bir tarih verin.",
      nextQuestion: DETAIL_QUESTION,
      data,
      done: false,
    });
  }
  if (d.description && d.description.length > 80) {
    return finalize(ctx, {
      step: "duration",
      reply: `Açıklama ${d.description.length} karakter — Xurrent üst sınırı 80. Kısaltıp tekrar yazın.`,
      nextQuestion: DETAIL_QUESTION,
      data,
      done: false,
    });
  }

  const startedAt = d.time ? toOffsetISO(zonedToInstant(d.date, d.time, ctx.cfg.timeZone), ctx.cfg.timeZone) : undefined;
  const parts = [
    `Tarih: ${d.date}${d.date === today ? " (bugün)" : ""}`,
    startedAt ? `başlangıç: ${d.time}` : "başlangıç saati: yok",
    d.description ? `açıklama: "${d.description}"` : "açıklama: yok",
  ];
  return finalize(ctx, {
    step: "detail",
    reply:
      parts.join(" · ") +
      "\n\nŞimdi yazma stratejisi: Xurrent'ta 'ticket'a bağlı + geçmiş tarihli + saatli' kayıt TEK mutation ile mümkün değil; üç yol da bir şeyden feragat eder.",
    nextQuestion: STRATEGY_QUESTION,
    data: {
      ...data,
      date: d.date,
      ...(startedAt ? { startedAt } : {}),
      ...(d.description ? { description: d.description } : {}),
    },
    done: false,
  });
}

function wizardEntryInput(data: WizardStateData, dryRun: boolean): CreateTimeEntryInput {
  return {
    targetType: (data.targetType ?? "request") as TargetType,
    targetId: data.targetId ?? "",
    minutes: data.minutes ?? 0,
    ...(data.date ? { date: data.date } : {}),
    ...(data.startedAt ? { startedAt: data.startedAt } : {}),
    ...(data.description ? { description: data.description } : {}),
    ...(data.strategy ? { backdateStrategy: data.strategy as CreateTimeEntryInput["backdateStrategy"] } : {}),
    dryRun,
  };
}

/** detail cevabı işlenir: strateji seçimi → dry-run planı göster, onay iste. */
async function handleDetail(
  ctx: ToolContext,
  data: WizardStateData,
  utterance: string,
  signal?: AbortSignal,
): Promise<WizardResult> {
  const secim = parseSecim(utterance, STRATEGY_QUESTION.choices ?? []);
  if (!secim) {
    return finalize(ctx, {
      step: "detail",
      reply:
        `"${utterance}" strateji seçenekleriyle eşleşmedi. 1-3 arası numara ya da ` +
        "two_step / link_first / date_first yazın.",
      nextQuestion: STRATEGY_QUESTION,
      data,
      done: false,
    });
  }

  const withStrategy = { ...data, strategy: secim.id };
  // AYNI çekirdek: xurrent_create_time_entry'nin planlama + ön kontrol yolu.
  const prepared = await prepareTimeEntry(ctx, wizardEntryInput(withStrategy, true), signal);
  if (prepared.result.errors.length > 0) {
    return bitti(
      ctx,
      "Plan ön kontrolden geçemedi — hiçbir şey yazılmadı:\n" +
        prepared.result.errors.map((e) => `  ✖ ${e.message}`).join("\n") +
        "\n\nSihirbazı yeniden başlatıp farklı değerlerle deneyebilirsiniz.",
      prepared.result.errors,
    );
  }

  // Onaylanan planın parmak izi: write adımı bundan sapan HİÇBİR planı yazmaz.
  const fingerprint = plannedFingerprintOf(prepared.result.planned);
  return finalize(ctx, {
    step: "strategy",
    reply: renderWriteResult(prepared.result),
    nextQuestion: CONFIRM_QUESTION,
    data: { ...withStrategy, plannedFingerprint: fingerprint },
    done: false,
  });
}

/** strategy cevabı işlenir: evet → yaz + geri-oku; hayır → bitir. */
async function handleStrategy(
  ctx: ToolContext,
  data: WizardStateData,
  utterance: string,
  signal?: AbortSignal,
): Promise<WizardResult> {
  const karar = parseEvetHayir(utterance);
  if (karar === null) {
    return finalize(ctx, {
      step: "strategy",
      reply: `"${utterance}" anlaşılamadı — 'evet' (${[...EVET_SETI].join("/")}) ya da 'hayır' (${[...HAYIR_SETI].join("/")}) bekliyorum.`,
      nextQuestion: CONFIRM_QUESTION,
      data,
      done: false,
    });
  }
  if (!karar) {
    return bitti(ctx, "Vazgeçildi — HİÇBİR mutation gönderilmedi. Yeni bir kayıt için sihirbazı tekrar çağırın.");
  }

  // ── write: plan yeniden kurulur, parmak izi DOĞRULANIR, sonra yazılır ──────
  const prepared = await prepareTimeEntry(ctx, wizardEntryInput(data, false), signal);
  const fingerprint = plannedFingerprintOf(prepared.result.planned);
  if (fingerprint !== data.plannedFingerprint) {
    const msg =
      "Onaylanan plan ile yazılacak plan AYNI DEĞİL (plannedFingerprint uyuşmadı) — yazma REDDEDİLDİ. " +
      "sessionState onaylanandan farklı bir planı işaret ediyor; sihirbazı baştan başlatın.";
    return bitti(ctx, msg, [{ message: msg }]);
  }
  if (prepared.result.errors.length > 0) {
    return bitti(
      ctx,
      "Yazma öncesi ön kontrol başarısız — hiçbir şey yazılmadı:\n" +
        prepared.result.errors.map((e) => `  ✖ ${e.message}`).join("\n"),
      prepared.result.errors,
    );
  }

  // Sihirbazın kendi confirm adımı ONAYIN KENDİSİDİR: protokol seviyesinde
  // (elicitation/MRTR) İKİNCİ bir onay istenmez — karar outcome olarak geçilir.
  const result = await finishTimeEntry(ctx, prepared, { action: "accept" }, signal);

  // ── geri-okuma: xurrent_list_time_entries'in AYNI çekirdeği ────────────────
  const sid = plannedSourceId(prepared.result.planned as Array<{ input: Record<string, unknown> }>);
  const today = todayISO(ctx.cfg.timeZone);
  const page = await runListTimeEntries(
    ctx,
    sid
      ? { sourceId: sid }
      : { personId: data.personId ?? "$me", dateFrom: data.date ?? today, dateTo: data.date ?? today },
    signal,
  ).catch(() => null);

  const lines = [renderWriteResult(result), ""];
  if (page) {
    lines.push(
      `GERİ-OKUMA (xurrent_list_time_entries${sid ? `, sourceId=${sid}` : ""}): ` +
        `${page.timeEntries.length} kayıt, toplam ${page.totalMinutes} dk.`,
    );
    if (result.deduped === true) {
      lines.push("DEDUP: aynı sourceID'li kayıt zaten vardı — yazma atlandı, çift kayıt OLUŞMADI.");
    }
  } else {
    lines.push("GERİ-OKUMA yapılamadı — yazma sonucu yukarıdaki rapora dayanır.");
  }

  return finalize(ctx, {
    step: "write",
    reply: lines.join("\n"),
    nextQuestion: null,
    data: null,
    done: true,
    writeResult: result as unknown as Record<string, unknown>,
    errors: result.errors,
  });
}

/** Planlanan adımların input'larından deterministik sourceID'yi çıkarır (varsa). */
function plannedSourceId(planned: Array<{ input: Record<string, unknown> }>): string | null {
  for (const step of planned) {
    const inner = (step.input?.["input"] ?? {}) as Record<string, unknown>;
    const sid = inner["sourceID"];
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Takvim dalı
// ─────────────────────────────────────────────────────────────────────────────

/** calendar_plan eylemi: takvim + açık işlerden öneri listesi (ASLA yazmaz). */
async function calendarPlanStep(
  ctx: ToolContext,
  data: WizardStateData,
  signal?: AbortSignal,
): Promise<WizardResult> {
  const plan = await runPlanFromCalendar(ctx, { personId: data.personId ?? "$me" }, signal);
  if (plan.proposals.length === 0) {
    return bitti(ctx, `${plan.date} için öneriye dönüşecek gerçek toplantı yok — yazılacak bir şey çıkmadı.`);
  }

  const entries = plan.proposals.map((p) => ({
    targetType: p.suggestedTargetType ?? "time_allocation",
    targetId: p.suggestedTargetId ?? "",
    minutes: p.roundedMinutes,
    startedAt: p.startedAt,
    description: p.meetingTitle.slice(0, 80),
  }));

  const draft = { date: plan.date, entries };
  const lines = [
    `Takvimden ${plan.proposals.length} öneri (${plan.date}, toplam ${plan.totals.proposedMinutes} dk):`,
  ];
  plan.proposals.forEach((p, i) => {
    lines.push(
      `  ${i + 1}. ${p.meetingTitle} — ${p.rawMinutes}→${p.roundedMinutes} dk → ${p.suggestedTargetLabel ?? "?"}` +
        (p.needsUserDecision ? "  ⚠ eşleşme belirsiz (varsayılan hedef önerildi)" : ""),
    );
  });
  lines.push("", "Bu tool yapısal olarak YAZMAZ — yazma ancak onaydan sonra, bulk adımında olur.");

  return finalize(ctx, {
    step: "calendar_plan",
    reply: lines.join("\n"),
    nextQuestion: CALENDAR_QUESTION,
    data: { ...data, calendarDraft: draft },
    done: false,
  });
}

/** calendar_plan cevabı: evet → bulk dry-run özeti · 'N hariç' → eleme · hayır → bitti. */
async function handleCalendarPlan(
  ctx: ToolContext,
  data: WizardStateData,
  utterance: string,
  signal?: AbortSignal,
): Promise<WizardResult> {
  const draft = data.calendarDraft;
  if (!draft || draft.entries.length === 0) {
    return bitti(ctx, "Takvim taslağı bulunamadı — sihirbazı baştan başlatın.", [
      { message: "calendarDraft yok" },
    ]);
  }

  const f = katla(utterance);
  const eleme = /^(\d+)\s*hariç$/.exec(f);
  if (eleme) {
    const idx = Number(eleme[1]);
    if (idx < 1 || idx > draft.entries.length) {
      return finalize(ctx, {
        step: "calendar_plan",
        reply: `${idx} numaralı öneri yok (1-${draft.entries.length}).`,
        nextQuestion: CALENDAR_QUESTION,
        data,
        done: false,
      });
    }
    const kalan = draft.entries.filter((_, i) => i !== idx - 1);
    if (kalan.length === 0) {
      return bitti(ctx, "Tüm öneriler elendi — yazılacak kalem kalmadı.");
    }
    const lines = [`${idx}. öneri elendi. Kalan ${kalan.length} kalem:`];
    kalan.forEach((e, i) => lines.push(`  ${i + 1}. ${e.description ?? "?"} — ${e.minutes} dk`));
    return finalize(ctx, {
      step: "calendar_plan",
      reply: lines.join("\n"),
      nextQuestion: CALENDAR_QUESTION,
      data: { ...data, calendarDraft: { date: draft.date, entries: kalan } },
      done: false,
    });
  }

  const karar = parseEvetHayir(utterance);
  if (karar === null) {
    return finalize(ctx, {
      step: "calendar_plan",
      reply: `"${utterance}" anlaşılamadı — 'evet', 'hayır' ya da 'N hariç' (ör. '3 hariç') bekliyorum.`,
      nextQuestion: CALENDAR_QUESTION,
      data,
      done: false,
    });
  }
  if (!karar) return bitti(ctx, "Vazgeçildi — hiçbir şey yazılmadı.");

  // AYNI çekirdek: xurrent_create_time_entries_bulk'un planlama yolu (dry-run).
  const rows = draft.entries.map((e) => bulkRow(e, draft.date));
  const b = await prepareBulk(ctx, { entries: rows, dryRun: true, stopOnError: false }, signal);
  const fingerprint = plannedFingerprintOf(b.planned);
  const reply =
    renderBulk(b.dryRunResult!) +
    "\n\n⚠ Bulk yazma ATOMİK DEĞİLDİR: GraphQL istek başına 1 mutation kabul eder, kısmi başarı mümkündür ve her satır ayrı raporlanır.";
  return finalize(ctx, {
    step: "calendar_confirm",
    reply,
    nextQuestion: CONFIRM_QUESTION,
    data: { ...data, plannedFingerprint: fingerprint },
    done: false,
  });
}

function bulkRow(
  e: NonNullable<WizardStateData["calendarDraft"]>["entries"][number],
  date: string,
): Record<string, unknown> {
  return {
    targetType: e.targetType,
    targetId: e.targetId,
    minutes: e.minutes,
    date,
    ...(e.startedAt ? { startedAt: e.startedAt } : {}),
    ...(e.description ? { description: e.description } : {}),
  };
}

/** calendar_confirm cevabı: evet → bulk yaz + geri-oku; hayır → bitti. */
async function handleCalendarConfirm(
  ctx: ToolContext,
  data: WizardStateData,
  utterance: string,
  signal?: AbortSignal,
): Promise<WizardResult> {
  const karar = parseEvetHayir(utterance);
  if (karar === null) {
    return finalize(ctx, {
      step: "calendar_confirm",
      reply: `"${utterance}" anlaşılamadı — 'evet' ya da 'hayır' bekliyorum.`,
      nextQuestion: CONFIRM_QUESTION,
      data,
      done: false,
    });
  }
  if (!karar) return bitti(ctx, "Vazgeçildi — hiçbir şey yazılmadı.");

  const draft = data.calendarDraft;
  if (!draft || draft.entries.length === 0) {
    return bitti(ctx, "Takvim taslağı bulunamadı — sihirbazı baştan başlatın.", [
      { message: "calendarDraft yok" },
    ]);
  }

  const rows = draft.entries.map((e) => bulkRow(e, draft.date));
  const b = await prepareBulk(ctx, { entries: rows, dryRun: false, stopOnError: false }, signal);
  const fingerprint = plannedFingerprintOf(b.planned);
  if (fingerprint !== data.plannedFingerprint) {
    const msg =
      "Onaylanan bulk planı ile yazılacak plan AYNI DEĞİL (plannedFingerprint uyuşmadı) — yazma REDDEDİLDİ.";
    return bitti(ctx, msg, [{ message: msg }]);
  }

  // Sihirbazın calendar_confirm adımı onayın kendisidir — outcome accept geçilir.
  const result = b.dryRunResult ?? (await finishBulk(ctx, b, { action: "accept" }, signal));

  const page = await runListTimeEntries(
    ctx,
    { personId: data.personId ?? "$me", dateFrom: draft.date, dateTo: draft.date },
    signal,
  ).catch(() => null);

  const rowErrors: ValidationError[] = result.results.flatMap((r) => r.errors);
  const lines = [renderBulk(result), ""];
  if (page) {
    lines.push(
      `GERİ-OKUMA (xurrent_list_time_entries, ${draft.date}): ${page.timeEntries.length} kayıt, toplam ${page.totalMinutes} dk.`,
    );
    if ((result.summary.deduped ?? 0) > 0) {
      lines.push(`DEDUP: ${result.summary.deduped} kalem zaten yazılmıştı — atlandı, çift kayıt OLUŞMADI.`);
    }
  }

  // WizardResult.writeResult sözleşmede $defs/WriteResult'tır; bulk sonucu o
  // şekle EŞLENİR (zorunlu alanlar korunur), satır ayrıntısı reply'da yaşar.
  const writeResult: Record<string, unknown> = {
    dryRun: result.dryRun,
    strategy: ctx.cfg.backdateStrategy,
    strategyExplanation:
      "Takvim dalı: bulk yazım — her kalem kendi planıyla SIRAYLA yürütüldü; satır ayrıntısı reply metnindedir.",
    planned: result.planned,
    warnings: [
      "Bulk ATOMİK DEĞİLDİR — kısmi başarı mümkündür.",
      `özet: istenen=${result.summary.requested} oluşan=${result.summary.created} başarısız=${result.summary.failed} atlanan=${result.summary.skipped} dedup=${result.summary.deduped ?? 0}`,
    ],
    timeEntry: null,
    deduped: (result.summary.deduped ?? 0) > 0 && result.summary.created === 0,
    errors: rowErrors,
  };

  return finalize(ctx, {
    step: "write",
    reply: lines.join("\n"),
    nextQuestion: null,
    data: null,
    done: true,
    writeResult,
    errors: rowErrors,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Giriş noktası
// ─────────────────────────────────────────────────────────────────────────────

export interface WizardArgs {
  utterance?: string;
  sessionState?: string;
}

export async function runWizard(ctx: ToolContext, args: WizardArgs, signal?: AbortSignal): Promise<WizardResult> {
  // İlk çağrı: state yok → start.
  if (args.sessionState === undefined || args.sessionState === "") {
    return startStep(ctx, null, signal);
  }

  const check = verifyWizardState(ctx.cfg, args.sessionState);
  if (!check.ok) {
    // SESSİZ SIFIRLAMA YOK: neden baştan başladığımız AÇIKÇA söylenir.
    const preamble =
      check.reason === "expired"
        ? `Oturumun süresi doldu (XURRENT_WIZARD_TTL=${ctx.cfg.wizardTtlSeconds} sn) — nazikçe baştan başlıyoruz.`
        : "sessionState DOĞRULANAMADI (imza geçersiz ya da bozuk) — güvenlik gereği sohbet baştan başlıyor. " +
          "Bu blob imzalıdır; üzerinde oynanmış ya da başka bir sırla üretilmiş olabilir.";
    return startStep(ctx, preamble, signal);
  }

  const utterance = args.utterance ?? "";
  const { step, data } = check.payload;
  switch (step) {
    case "start":
      return handleStart(ctx, data, utterance, signal);
    case "pick_work":
      return handlePickWork(ctx, data, utterance, signal);
    case "duration":
      return handleDuration(ctx, data, utterance);
    case "detail":
      return handleDetail(ctx, data, utterance, signal);
    case "strategy":
    case "confirm": // rezerv etiket — evet/hayır beklenen aynı nokta (bkz. üst not)
      return handleStrategy(ctx, data, utterance, signal);
    case "calendar_plan":
      return handleCalendarPlan(ctx, data, utterance, signal);
    case "calendar_confirm":
      return handleCalendarConfirm(ctx, data, utterance, signal);
    default: {
      // write/done state olarak taşınmaz (done=true → state null); gelirse bozulmuştur.
      return startStep(
        ctx,
        `Beklenmeyen adım "${step}" — sohbet baştan başlıyor (state bitmiş bir akışı işaret ediyor).`,
        signal,
      );
    }
  }
}
