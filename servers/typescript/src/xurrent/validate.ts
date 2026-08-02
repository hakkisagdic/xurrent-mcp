/**
 * Ön kontroller.
 *
 * FELSEFE: Sunucunun reddedeceği bir isteği GÖNDERMEDEN yakalamak, kullanıcıya
 * "neden" diyebilmek demektir. Xurrent validation hatalarını HTTP 200 + errors[]
 * ile döner; mesajlar İngilizce ve teknik olur. Burada aynı kuralları Türkçe ve
 * gerekçeli olarak önden uygularız.
 *
 * İKİ SINIF:
 *   errors[]   → İŞLEM YAPILMAZ. Sunucunun kesin reddedeceği durumlar.
 *   warnings[] → İşlem yapılır ama kullanıcı bilgilendirilir (takas / yetki / yuvarlama).
 */

import type {
  BackdateStrategy,
  CreateTimeEntryInput,
  TimeAllocation,
  TimeTrackingContext,
  ValidationError,
} from "../types.js";
import { diffDaysISO } from "../util/time.js";

export interface PreflightContext {
  timesheet: TimeTrackingContext;
  today: string;
  maxBackdateDays: number;
  meId: string;
  strategy: BackdateStrategy;
  /** Efektif hedef Yol A ise ilgili TimeAllocation (descriptionRequired kontrolü için). */
  allocation?: TimeAllocation | null;
  /** Hedef tarihte o kişiye ait MEVCUT toplam dakika. */
  dayMinutes: number;
  /** Hedef tarihin haftasında o kişiye ait MEVCUT toplam dakika. */
  weekMinutes: number;
}

export interface PreflightResult {
  warnings: string[];
  errors: ValidationError[];
}

export function preflight(input: CreateTimeEntryInput, ctx: PreflightContext): PreflightResult {
  const warnings: string[] = [];
  const errors: ValidationError[] = [];
  const ts = ctx.timesheet;
  const date = input.date ?? ctx.today;
  const minutes = input.minutes;

  // ── 1) timeIncrement ──────────────────────────────────────────────────────
  // Xurrent entegrasyonlarındaki EN YAYGIN sessiz hata. timeIncrement hem
  // MİNİMUM hem ADIM'dır. Varsayılanı 60'tır: varsayılan yapılandırmada
  // 45 dakikalık bir giriş sunucu tarafından REDDEDİLİR.
  const inc = ts.timeIncrement ?? 60;
  if (inc > 0 && Math.abs(minutes) % inc !== 0) {
    const down = Math.floor(Math.abs(minutes) / inc) * inc;
    const up = down + inc;
    errors.push({
      message:
        `Süre ${minutes} dakika, ancak bu hesabın timeIncrement değeri ${inc}. ` +
        `timeSpent ${inc}'in KATI olmak zorundadır (hem minimum hem adım). ` +
        `Önerilen: ${down || inc} veya ${up} dakika.`,
      path: ["minutes"],
    });
  }
  if (minutes === 0) {
    errors.push({ message: "Süre 0 dakika olamaz.", path: ["minutes"] });
  }

  // ── 2) Negatif süre ───────────────────────────────────────────────────────
  if (minutes < 0 && input.correction !== true) {
    errors.push({
      message: "Negatif timeSpent yalnızca correction=true ile gönderilebilir (düzeltme kaydı).",
      path: ["minutes"],
    });
  }
  if (minutes < 0 && input.correction === true) {
    warnings.push("Düzeltme (correction) kaydı oluşturuluyor — mevcut toplamdan süre DÜŞÜLECEK.");
  }

  // ── 3) Tarih sınırları (ister: T veya T-1) ────────────────────────────────
  const delta = diffDaysISO(ctx.today, date); // pozitif = geçmiş
  if (delta > ctx.maxBackdateDays) {
    errors.push({
      message:
        `${date} tarihi izin verilen geriye yazma sınırının dışında ` +
        `(en fazla ${ctx.maxBackdateDays} gün geriye — XURRENT_MAX_BACKDATE_DAYS).`,
      path: ["date"],
    });
  }
  if (delta < 0) {
    warnings.push(`${date} GELECEK bir tarih — timesheet'te ileri tarihli kayıt beklenmedik olabilir.`);
  }

  // ── 4) Strateji ile tarih/saat/kişi talebinin uyumu ───────────────────────
  if (ctx.strategy === "link_first" && delta > 0) {
    warnings.push(
      `link_first stratejisi ${date} tarihini KARŞILAYAMAZ; kayıt ${ctx.today} tarihiyle oluşacak.`,
    );
  }

  // ── 5) Yol A / Yol B anahtarları ──────────────────────────────────────────
  const usesPathA = ctx.strategy === "date_first" || input.targetType === "time_allocation";
  if (usesPathA && ts.allocationTimeTracking === false) {
    errors.push({
      message:
        "Bu organizasyonda allocationTimeTracking=false — Yol A (timeEntryCreate) TAMAMEN kapalıdır. " +
        "date_first stratejisi kullanılamaz.",
      path: ["backdateStrategy"],
    });
  }
  if (!usesPathA && ts.assignmentTimeTracking === false) {
    errors.push({
      message:
        "Bu organizasyonda assignmentTimeTracking=false — Yol B (requestUpdate/taskUpdate) TAMAMEN kapalıdır. " +
        "link_first ve two_step kullanılamaz.",
      path: ["backdateStrategy"],
    });
  }

  // ── 6) Zorunlu alanlar ────────────────────────────────────────────────────
  if (ts.requireNote === true && !input.note) {
    errors.push({ message: "Bu organizasyonda requireNote=true — note alanı zorunludur.", path: ["note"] });
  }
  if (ts.requireTimeEntryDescription === true && !input.description) {
    errors.push({
      message: "Bu organizasyonda requireTimeEntryDescription=true — description alanı zorunludur.",
      path: ["description"],
    });
  }
  if (ctx.allocation?.descriptionRequired === true && !input.description) {
    errors.push({
      message: `"${ctx.allocation.name}" allocation'ında descriptionRequired=true — açıklama olmadan yazılamaz.`,
      path: ["description"],
    });
  }
  if (input.description && input.description.length > 80) {
    errors.push({
      message: `Açıklama ${input.description.length} karakter — üst sınır 80 karakterdir.`,
      path: ["description"],
    });
  }
  if (input.note && ctx.strategy === "date_first") {
    warnings.push(
      "note alanı yalnızca Yol B'de anlamlıdır; date_first (timeEntryCreate) bu alanı GÖNDEREMEZ — göz ardı edilecek.",
    );
  }

  // ── 7) Mesai sınırları ────────────────────────────────────────────────────
  const workday = ts.workday ?? 480;
  const dayTotal = ctx.dayMinutes + Math.max(0, minutes);
  if (ts.allowWorkdayOvertime === false && dayTotal > workday) {
    errors.push({
      message:
        `${date} için toplam ${dayTotal} dakika olurdu; günlük sınır ${workday} dakika ve ` +
        "allowWorkdayOvertime=false. Kayıt sunucu tarafından reddedilir.",
      path: ["minutes"],
    });
  } else if (dayTotal > workday) {
    warnings.push(`${date} günlük toplam ${dayTotal} dakikaya çıkıyor (sınır ${workday}, fazla mesai açık).`);
  }

  const workweek = ts.workweek ?? 2400;
  const weekTotal = ctx.weekMinutes + Math.max(0, minutes);
  if (ts.allowWorkweekOvertime === false && weekTotal > workweek) {
    errors.push({
      message:
        `Haftalık toplam ${weekTotal} dakika olurdu; sınır ${workweek} ve allowWorkweekOvertime=false.`,
      path: ["minutes"],
    });
  }

  // ── 8) Başkası adına yazma ────────────────────────────────────────────────
  if (input.personId && input.personId !== "$me" && input.personId !== ctx.meId) {
    warnings.push(
      `personId authenticated user'dan FARKLI (${input.personId}). ` +
        "Bu işlem manager / substitute / Account Administrator yetkisi gerektirir; yetki yoksa sunucu reddeder.",
    );
  }

  // ── 9) startedAt biçimi ───────────────────────────────────────────────────
  if (input.startedAt && !/[Zz]$|[+-]\d{2}:\d{2}$/.test(input.startedAt)) {
    errors.push({
      message:
        `startedAt offset TAŞIMIYOR: "${input.startedAt}". ` +
        "ISO8601 timestamp'te offset ZORUNLUDUR (ör. 2026-08-01T14:00:00+03:00).",
      path: ["startedAt"],
    });
  }
  if (input.startedAt && input.startedAt.slice(0, 10) !== date) {
    warnings.push(
      `startedAt (${input.startedAt.slice(0, 10)}) ile date (${date}) farklı günler. ` +
        "startedAt yalnızca metadata'dır; timesheet gününü date belirler.",
    );
  }

  return { warnings, errors };
}

/**
 * Süreyi timeIncrement katına yuvarlar.
 * Yuvarlama HER ZAMAN raporlanır — sessizce yuvarlamak kullanıcının faturasını değiştirir.
 */
export function roundToIncrement(
  minutes: number,
  increment: number,
  mode: "nearest" | "up" | "down",
): number {
  if (increment <= 0) return minutes;
  const q = minutes / increment;
  const rounded =
    mode === "up" ? Math.ceil(q) : mode === "down" ? Math.floor(q) : Math.round(q);
  // En az bir birim: 5 dakikalık bir toplantı "0 dakika" olarak yazılmamalı.
  return Math.max(increment, rounded * increment);
}
