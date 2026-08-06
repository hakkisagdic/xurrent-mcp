#!/usr/bin/env node
/**
 * SAHTE XURRENT GraphQL SUNUCUSU
 * ═══════════════════════════════
 *
 * NE OLDUĞU: Xurrent GraphQL API'sinin ŞEKLİNİ ve DAVRANIŞINI taklit eden yerel
 * bir sunucu. Amacı, gerçek bir Xurrent hesabı olmadan `XURRENT_MODE=live` kod
 * yolunun çalıştırılabilmesi.
 *
 * ★ NE OLMADIĞI — bunu abartmıyoruz:
 *   Bu sunucuya karşı geçen bir test, "Xurrent'a karşı doğrulandı" ANLAMINA GELMEZ.
 *   Gerçek Xurrent'ın şeması bizim dokümantasyondan çıkardığımızdan farklı olabilir.
 *   Yaptığı şey: "live yolu hiç çalıştırılmadı" → "live yolu wire seviyesinde
 *   çalıştırıldı". Şema doğruluğu hâlâ DOĞRULANMAMIŞ durumdadır.
 *
 * TAM BİR GraphQL MOTORU DEĞİLDİR. Gelen sorgunun ROOT FIELD'ını tanıyıp doğru
 * şekilli JSON döndürür; selection set'i ayrıştırmaz, istenmeyen alanları da
 * döndürür. Bu bilinçli: amaç şema doğrulaması değil, istemci kod yolunu sürmek.
 *
 * Root field'a göre ayırt ediyoruz, operation adına göre DEĞİL — çünkü üç
 * implementasyon aynı işlem için farklı operation adları kullanıyor
 * (Whoami / Me, AddTimeToRequest / LogTimeOnRequest / RequestUpdate).
 * Gerçek bir GraphQL sunucusu da operation adına bakmaz.
 *
 * Kullanım:
 *   node tools/fake-xurrent/server.mjs [--port 4000] [--quiet]
 *
 * KAOS MODU (bilinçli, tohumlu arıza enjeksiyonu — bkz. contract/reliability.md):
 *   --kaos-429 <n>        sonraki n istek 429 + retry-after:1 alır (retry kanıtı)
 *   --kaos-500 <n>        sonraki n istek 500 alır
 *   --kaos-500-oran <p>   her istek p olasılıkla 500 alır (0..1, --tohum ile deterministik)
 *   --gecikme-ms <ms>     her yanıt bu kadar geciktirilir
 *   --kaos-kir-desc <s>   description'ı <s> içeren HER timeEntryCreate 500 alır —
 *                         retry'ın KURTARAMAYACAĞI kalıcı kırık kalem (senaryo g)
 *   --tohum <n>           oranlı kaosun PRNG tohumu (fake-gemini'deki desenin aynısı)
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FIXTURES = process.env.XURRENT_FIXTURES_DIR || path.join(REPO, "fixtures");
const TZ = process.env.XURRENT_TIMEZONE || "Europe/Istanbul";

const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf("--port") + 1]) || Number(process.env.FAKE_XURRENT_PORT) || 4000;
const QUIET = args.includes("--quiet");

const log = (...a) => { if (!QUIET) console.error("[sahte-xurrent]", ...a); };

// ── kaos modu ───────────────────────────────────────────────────────────────
// Arızalar SABİT DEĞİL, bayrakla açılır; oranlı kaos tohumla DETERMİNİSTİKTİR.
// Amaç: istemcinin retry/dedup politikasını (contract/reliability.md) kanıtlamak.
const numArg = (name, def = 0) => {
  const i = args.indexOf(name);
  const n = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(n) ? n : def;
};
const KAOS = {
  k429: numArg("--kaos-429"),
  k500: numArg("--kaos-500"),
  oran500: numArg("--kaos-500-oran"),
  gecikmeMs: numArg("--gecikme-ms"),
  kirDesc: args.includes("--kaos-kir-desc") ? args[args.indexOf("--kaos-kir-desc") + 1] : null,
};

// mulberry32 — fake-gemini'nin "zar" modundaki desenin aynısı: aynı tohum,
// aynı arıza dizisi. Math.random kullansaydık kırmızı koşu TEKRARLANAMAZDI.
let prngState = (numArg("--tohum", 1) >>> 0) || 1;
function prng() {
  prngState = (prngState + 0x6d2b79f5) >>> 0;
  let t = prngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ── fixtures ────────────────────────────────────────────────────────────────
const read = (f) => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
const F = {
  people: read("people.json"),
  requests: read("requests.json"),
  tasks: read("tasks.json"),
  effortClasses: read("effort-classes.json"),
  timesheet: read("timesheet-settings.json"),
  allocations: read("time-allocations.json"),
  timeEntries: read("time-entries.json"),
};

// ── tarih yardımcıları ──────────────────────────────────────────────────────
// Fixtures göreli tarih taşır (dayOffset + yerel saat). Materyalizasyon üç dilde
// aynı sonucu vermek zorunda; burada da aynı kuralı uyguluyoruz.

/** Verilen anda TZ'in UTC offset'i, "+03:00" biçiminde. */
function tzOffset(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, timeZoneName: "longOffset",
  }).formatToParts(at);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  const m = /GMT([+-])(\d{2}):?(\d{2})?/.exec(name);
  if (!m) return "+00:00";
  return `${m[1]}${m[2]}:${m[3] ?? "00"}`;
}

/** TZ'de "bugün", YYYY-MM-DD. */
function todayLocal() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function dateFromOffset(dayOffset) {
  const base = new Date(`${todayLocal()}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + (dayOffset ?? 0));
  return base.toISOString().slice(0, 10);
}

function instant(dayOffset, hhmm) {
  const d = dateFromOffset(dayOffset);
  return `${d}T${hhmm ?? "00:00"}:00${tzOffset()}`;
}

// ── durum (süreç ömrü boyunca) ──────────────────────────────────────────────
let nextId = 1000;
const mintId = (kind) => Buffer.from(`Mock/${kind}/${nextId++}`).toString("base64").replace(/=+$/, "");

/** Oluşturulan/var olan time entry'ler. assignment BİLEREK ayrı tutuluyor. */
const store = F.timeEntries.timeEntries.map((t) => ({
  id: t.id,
  personId: t.personId,
  date: dateFromOffset(t.dayOffset),
  startedAt: t.startedAtLocal ? instant(t.dayOffset, t.startedAtLocal) : null,
  timeSpent: t.timeSpent,
  description: t.description,
  effortClassId: t.effortClassId,
  correction: !!t.correction,
  assignment: t.assignmentId ? { type: t.assignmentType, id: t.assignmentId } : null,
  timeAllocationId: null,
  source: t.source,
  sourceID: t.sourceID,
}));

const ME = F.people.people.find((p) => p.id === F.people.me);
const TS_SET = F.timesheet.timesheetSetting;

// ── rate limit: 20 istek / 2 saniye ─────────────────────────────────────────
// Gerçek Xurrent'ın sınırı. Bulk yazma bu yüzden throttle edilmek zorunda.
const RATE_WINDOW_MS = 2000;
const RATE_MAX = 20;
let hits = [];
function rateCheck() {
  const now = Date.now();
  hits = hits.filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX) return { ok: false, remaining: 0 };
  hits.push(now);
  return { ok: true, remaining: RATE_MAX - hits.length };
}

// ── yardımcılar ─────────────────────────────────────────────────────────────
const gqlError = (message) => ({ errors: [{ message }] });
/** Xurrent'ta validation hataları HTTP 200 + payload.errors DOLU olarak döner. */
const payloadError = (field, message, path_ = null) => ({
  data: { [field]: { clientMutationId: null, errors: [{ message, path: path_ }], timeEntry: null } },
});

const OPEN_REQUEST_STATUSES = new Set(F.requests._openStatuses);
const OPEN_TASK_STATUSES = new Set(F.tasks._openStatuses);

function requestNode(r) {
  return {
    id: r.id, requestId: r.requestId, subject: r.subject, status: r.status,
    completedAt: r.completedAtOffsetDays != null ? instant(r.completedAtOffsetDays, "17:00") : null,
    nextTargetAt: r.targetAtOffsetDays != null ? instant(r.targetAtOffsetDays, "17:00") : null,
    updatedAt: instant(r.updatedAtOffsetDays, "12:00"),
    createdAt: instant(r.createdAtOffsetDays, "09:00"),
    team: { id: "TW9jay9UZWFtLzE", name: r.team },
    member: { id: r.memberId, name: F.people.people.find((p) => p.id === r.memberId)?.name ?? null },
    timeSpent: r.timeSpentTotalMinutes ?? 0,
  };
}

function taskNode(t) {
  return {
    id: t.id, taskId: t.taskId, subject: t.subject, status: t.status,
    finishedAt: t.finishedAtOffsetDays != null ? instant(t.finishedAtOffsetDays, "17:00") : null,
    completionTargetAt: t.targetAtOffsetDays != null ? instant(t.targetAtOffsetDays, "17:00") : null,
    updatedAt: instant(t.updatedAtOffsetDays, "12:00"),
    createdAt: instant(t.createdAtOffsetDays, "09:00"),
    team: { id: "TW9jay9UZWFtLzE", name: t.team },
    member: { id: t.assigneeId, name: F.people.people.find((p) => p.id === t.assigneeId)?.name ?? null },
    workflow: t.workflowId ? { id: t.workflowId, subject: t.workflowSubject } : null,
    request: t.linkedRequestId ? { id: t.linkedRequestId } : null,
    timeSpent: t.timeSpentTotalMinutes ?? 0,
  };
}

const personNode = (p) => ({
  id: p.id, name: p.name, primaryEmail: p.primaryEmail, jobTitle: p.jobTitle,
  timeZone: p.timeZone, disabled: p.disabled, employeeID: p.employeeID,
  organization: p.organization,
});

const ec = (id) => {
  const e = F.effortClasses.effortClasses.find((x) => x.id === id);
  return e ? { id: e.id, name: e.name } : null;
};

const timeEntryNode = (t) => ({
  id: t.id, date: t.date, timeSpent: t.timeSpent, startedAt: t.startedAt,
  description: t.description, correction: t.correction,
  source: t.source ?? null, sourceID: t.sourceID ?? null,
  person: { id: t.personId, name: F.people.people.find((p) => p.id === t.personId)?.name ?? null },
  effortClass: ec(t.effortClassId),
  timeAllocation: t.timeAllocationId
    ? (() => {
        const a = F.allocations.timeAllocations.find((x) => x.id === t.timeAllocationId);
        return a ? { id: a.id, name: a.name } : null;
      })()
    : null,
  // ★ assignment: timeEntryCreate ile oluşan kayıtta HER ZAMAN null.
  assignment: t.assignment
    ? (t.assignment.type === "Request"
        ? { __typename: "Request", id: t.assignment.id,
            requestId: F.requests.requests.find((r) => r.id === t.assignment.id)?.requestId ?? null }
        : { __typename: "Task", id: t.assignment.id,
            taskId: F.tasks.tasks.find((x) => x.id === t.assignment.id)?.taskId ?? null })
    : null,
});

/** Günlük toplam — allowWorkdayOvertime kontrolü için. */
const minutesOn = (personId, date) =>
  store.filter((t) => t.personId === personId && t.date === date && !t.correction)
       .reduce((s, t) => s + t.timeSpent, 0);

// ── mutation ortak doğrulaması ──────────────────────────────────────────────
/**
 * Gerçek Xurrent'ın reddettiği durumlar. Sahte sunucunun asıl değeri BURASI —
 * sahte veri değil, sahte DAVRANIŞ. İstemcinin bu hataları doğru ele alıp
 * almadığını ancak böyle test edebiliriz.
 */
function validateWrite({ timeSpent, correction, description, personId, date }) {
  if (typeof timeSpent !== "number" || Number.isNaN(timeSpent))
    return "timeSpent zorunludur ve tam sayı olmalıdır (dakika).";

  // Negatif süre yalnızca düzeltme kaydında.
  if (timeSpent < 0 && !correction)
    return "Negatif timeSpent yalnızca correction: true ile gönderilebilir.";

  // ★ En yaygın sessiz hata: timeIncrement katı olmayan süre.
  const inc = TS_SET.timeIncrement;
  if (inc && Math.abs(timeSpent) % inc !== 0)
    return `timeSpent (${timeSpent}) bu organizasyonun timeIncrement değerinin (${inc}) katı değil.`;

  // REST dokümantasyonunda description için 80 karakter sınırı var.
  if (typeof description === "string" && description.length > 80)
    return `description en fazla 80 karakter olabilir (gönderilen: ${description.length}).`;

  // Günlük mesai tavanı.
  if (TS_SET.allowWorkdayOvertime === false && timeSpent > 0) {
    const d = date || todayLocal();
    const total = minutesOn(personId || ME.id, d) + timeSpent;
    if (total > TS_SET.workday)
      return `Günlük toplam ${total} dakikaya çıkıyor; bu organizasyonda workday sınırı ` +
             `${TS_SET.workday} dakika ve allowWorkdayOvertime kapalı.`;
  }
  return null;
}

// ── REST v1 yüzeyi ──────────────────────────────────────────────────────────
// Aynı fixture durumu, aynı davranış kuralları — İKİNCİ bir wire biçimi.
// GraphQL ile bilinçli farklar (dersin konusu, bkz. docs/16):
//   · Alan adları snake_case'tir (started_at, time_spent) — sourceID HARİÇ
//     (Xurrent REST dokümantasyonu da sourceID yazar).
//   · Validation hatası HTTP 422 + {errors:[...]} döner — GraphQL'in
//     "HTTP 200 + payload.errors" modelinin tam tersi.
//   · whoami/context tek istekte alınamaz: /me, /account, /timesheet_settings,
//     /effort_classes, /time_allocations ayrı ayrıdır (1 sorgu vs N istek).
// ⚠️ Gerçek REST yanıt şekilleri dokümantasyondan ÇIKARIMDIR; alan adları ve
//    hata gövdesi biçimi DOĞRULANMALI'dır (docs/08).

const personRest = (p) => ({
  id: p.id, name: p.name, primary_email: p.primaryEmail, job_title: p.jobTitle,
  time_zone: p.timeZone, disabled: p.disabled,
  organization: p.organization ? { id: p.organization.id, name: p.organization.name } : null,
});

const requestRest = (r) => ({
  id: r.id, subject: r.subject, status: r.status,
  next_target_at: r.targetAtOffsetDays != null ? instant(r.targetAtOffsetDays, "17:00") : null,
  updated_at: instant(r.updatedAtOffsetDays, "12:00"),
  team: { name: r.team },
  member: { id: r.memberId, name: F.people.people.find((p) => p.id === r.memberId)?.name ?? null },
  time_spent: r.timeSpentTotalMinutes ?? 0,
  // REST'te görünen numara "id" ile aynı kavram değildir; UI numarası ayrı alan.
  source_display_id: r.requestId,
});

const taskRest = (t) => ({
  id: t.id, subject: t.subject, status: t.status,
  completion_target_at: t.targetAtOffsetDays != null ? instant(t.targetAtOffsetDays, "17:00") : null,
  updated_at: instant(t.updatedAtOffsetDays, "12:00"),
  team: { name: t.team },
  member: { id: t.assigneeId, name: F.people.people.find((p) => p.id === t.assigneeId)?.name ?? null },
  workflow: t.workflowId ? { id: t.workflowId, subject: t.workflowSubject } : null,
  time_spent: t.timeSpentTotalMinutes ?? 0,
  source_display_id: t.taskId,
});

const timeEntryRest = (t) => ({
  id: t.id, date: t.date, started_at: t.startedAt, time_spent: t.timeSpent,
  description: t.description, correction: t.correction,
  source: t.source ?? null, sourceID: t.sourceID ?? null,
  person: { id: t.personId, name: F.people.people.find((p) => p.id === t.personId)?.name ?? null },
  effort_class: ec(t.effortClassId),
  time_allocation: t.timeAllocationId
    ? (() => { const a = F.allocations.timeAllocations.find((x) => x.id === t.timeAllocationId);
               return a ? { id: a.id, name: a.name } : null; })()
    : null,
  assignment: t.assignment ? { type: t.assignment.type, id: t.assignment.id } : null,
});

function handleRest(method, segs, q, body) {
  const notFound = (m) => ({ code: 404, body: { errors: [{ message: m }] } });
  // ★ REST hata modeli: 422 + errors gövdesi. GraphQL'deki "200 + payload.errors"
  // dersinin ikizi — istemci HTTP koduna BAKMAK zorundadır.
  const unprocessable = (m, attr = null) => ({ code: 422, body: { errors: [{ message: m, attribute: attr }] } });
  const pid = (v) => (v === "$me" || !v ? ME.id : v);
  const kaynak = segs[0];

  if (method === "GET") {
    if (kaynak === "me") return { code: 200, body: personRest(ME) };
    if (kaynak === "account") return { code: 200, body: F.people.account };
    if (kaynak === "people") {
      const email = q.get("primary_email");
      const found = F.people.people.filter((p) => !email || p.primaryEmail === email);
      return { code: 200, body: found.map(personRest) };
    }
    if (kaynak === "requests" && !segs[1]) {
      const m = pid(q.get("member"));
      return { code: 200, body: F.requests.requests
        .filter((r) => r.memberId === m && OPEN_REQUEST_STATUSES.has(r.status)).map(requestRest) };
    }
    if (kaynak === "tasks" && !segs[1]) {
      const a = pid(q.get("assignee"));
      return { code: 200, body: F.tasks.tasks
        .filter((t) => t.assigneeId === a && OPEN_TASK_STATUSES.has(t.status)).map(taskRest) };
    }
    if (kaynak === "timesheet_settings") {
      const s = TS_SET;
      return { code: 200, body: [{
        id: s.id, name: s.name, unit: s.unit, workday: s.workday, workweek: s.workweek,
        time_increment: s.timeIncrement, percentage_increment: s.percentageIncrement,
        allow_workday_overtime: s.allowWorkdayOvertime, allow_workweek_overtime: s.allowWorkweekOvertime,
        allocation_time_tracking: s.allocationTimeTracking, assignment_time_tracking: s.assignmentTimeTracking,
        require_note: s.requireNote, require_time_entry_description: s.requireTimeEntryDescription,
        request_effort_class: ec(s.defaults.requestEffortClassId),
        task_effort_class: ec(s.defaults.taskEffortClassId),
        project_task_effort_class: ec(s.defaults.projectTaskEffortClassId),
        problem_effort_class: ec(s.defaults.problemEffortClassId),
        time_allocation_effort_class: ec(s.defaults.timeAllocationEffortClassId),
      }] };
    }
    if (kaynak === "effort_classes") {
      // disabled olanlar BİLEREK dahil — eleme GraphQL'deki gibi CLIENT tarafında.
      return { code: 200, body: F.effortClasses.effortClasses.map((e) => ({
        id: e.id, name: e.name, position: e.position,
        cost_multiplier: e.costMultiplier, disabled: e.disabled })) };
    }
    if (kaynak === "time_allocations") {
      return { code: 200, body: F.allocations.timeAllocations.map((a) => ({
        id: a.id, name: a.name, group: a.group, description_required: a.descriptionRequired })) };
    }
    if (kaynak === "time_entries") {
      const person = q.get("person") ? pid(q.get("person")) : null;
      const from = q.get("date_from");
      const to = q.get("date_to");
      const exact = q.get("date");
      const bySource = q.get("sourceID");
      const rows = store
        .filter((t) => (!person || t.personId === person)
          && (!from || t.date >= from)
          && (!to || t.date <= to)
          && (!exact || t.date === exact)
          && (!bySource || t.sourceID === bySource))
        .slice().reverse().slice(0, 100);
      return { code: 200, body: rows.map(timeEntryRest) };
    }
    return notFound(`Bilinmeyen REST kaynağı: GET /v1/${segs.join("/")}`);
  }

  if (method === "POST" && kaynak === "time_entries" && !segs[1]) {
    const input = {
      timeSpent: body.time_spent, correction: !!body.correction,
      description: body.description, personId: body.person_id, date: body.date,
    };
    const bad = validateWrite(input);
    if (bad) return unprocessable(bad, "time_spent");
    const entry = {
      id: mintId("TimeEntry"),
      personId: body.person_id || ME.id,
      date: body.date || todayLocal(),
      startedAt: body.started_at ?? null,
      timeSpent: body.time_spent,
      description: body.description ?? null,
      effortClassId: body.effort_class_id ?? TS_SET.defaults.timeAllocationEffortClassId,
      correction: !!body.correction,
      timeAllocationId: body.time_allocation_id ?? null,
      // ★ GraphQL ile AYNI kısıt: REST'te de time entry bir ticket'a bağlanamaz.
      assignment: null,
      source: body.source ?? null,
      sourceID: body.sourceID ?? null,
    };
    store.push(entry);
    return { code: 201, body: timeEntryRest(entry) };
  }

  if (method === "PATCH" && kaynak === "time_entries" && segs[1]) {
    const t = store.find((x) => x.id === segs[1]);
    if (!t) return notFound(`TimeEntry bulunamadı: ${segs[1]}`);
    if (body.time_spent != null) {
      const bad = validateWrite({ timeSpent: body.time_spent, correction: !!body.correction,
        description: body.description, personId: t.personId, date: body.date });
      if (bad) return unprocessable(bad, "time_spent");
      t.timeSpent = body.time_spent;
    }
    // two_step'in dayanağı REST'te de aynı: assignment'a DOKUNULMAZ.
    if (body.date != null) t.date = body.date;
    if (body.started_at != null) t.startedAt = body.started_at;
    if (body.person_id != null) t.personId = body.person_id;
    if (body.description != null) t.description = body.description;
    if (body.effort_class_id != null) t.effortClassId = body.effort_class_id;
    if (body.source != null) t.source = body.source;
    if (body.sourceID != null) t.sourceID = body.sourceID;
    return { code: 200, body: timeEntryRest(t) };
  }

  if (method === "PATCH" && (kaynak === "requests" || kaynak === "tasks") && segs[1]) {
    // ⚠️ Yol B'nin REST karşılığı: PATCH ile time_spent göndermek. Gerçek REST'te
    // bu parametrenin adı/varlığı DOĞRULANMAMIŞTIR (docs/08) — davranış GraphQL
    // requestUpdate/taskUpdate ile bilinçli olarak AYNI tutuldu.
    const rows = kaynak === "requests" ? F.requests.requests : F.tasks.tasks;
    const parent = rows.find((r) => r.id === segs[1]);
    if (!parent) return notFound(`${kaynak === "requests" ? "Request" : "Task"} bulunamadı: ${segs[1]}`);
    if (body.time_spent != null) {
      const bad = validateWrite({ timeSpent: body.time_spent, correction: false,
        description: body.time_entry_description, personId: ME.id, date: todayLocal() });
      if (bad) return unprocessable(bad, "time_spent");
      const entry = {
        id: mintId("TimeEntry"),
        personId: ME.id,                     // ★ kontrol EDİLEMEZ — authenticated user
        date: todayLocal(),                  // ★ kontrol EDİLEMEZ — bugün
        startedAt: null,
        timeSpent: body.time_spent,          // ★ ARTIMLI
        description: body.time_entry_description ?? null,
        effortClassId: body.time_spent_effort_class_id ?? TS_SET.defaults.requestEffortClassId,
        correction: false,
        timeAllocationId: null,
        assignment: { type: kaynak === "requests" ? "Request" : "Task", id: parent.id },
        source: null, sourceID: null,
      };
      store.push(entry);
      parent.timeSpentTotalMinutes = (parent.timeSpentTotalMinutes ?? 0) + body.time_spent;
    }
    return { code: 200, body: kaynak === "requests" ? requestRest(parent) : taskRest(parent) };
  }

  return notFound(`Bilinmeyen REST yolu: ${method} /v1/${segs.join("/")}`);
}

// ── root field yönlendirmesi ────────────────────────────────────────────────
function handle(query, variables) {
  const v = variables || {};
  const has = (field) => new RegExp(`(^|[\\s{])${field}\\s*[({]`, "m").test(query);

  // ── MUTATIONLAR (önce bakılır) ──────────────────────────────────────────

  if (has("timeEntryCreate")) {
    const input = v.input ?? {};
    const bad = validateWrite(input);
    if (bad) return payloadError("timeEntryCreate", bad, ["timeSpent"]);

    const entry = {
      id: mintId("TimeEntry"),
      personId: input.personId || ME.id,
      date: input.date || todayLocal(),
      startedAt: input.startedAt ?? null,
      timeSpent: input.timeSpent,
      description: input.description ?? null,
      effortClassId: input.effortClassId ?? TS_SET.defaults.timeAllocationEffortClassId,
      correction: !!input.correction,
      timeAllocationId: input.timeAllocationId ?? null,
      // ★ KRİTİK: TimeEntryCreateInput'ta assignment alanı YOKTUR.
      // Bu yolla oluşan kayıt bir ticket'a BAĞLANAMAZ. Sahte sunucu bunu
      // taklit etmezse ders yalan söyler.
      assignment: null,
      source: input.source ?? null,
      sourceID: input.sourceID ?? null,
    };
    store.push(entry);
    return { data: { timeEntryCreate: {
      clientMutationId: input.clientMutationId ?? null, errors: [], timeEntry: timeEntryNode(entry) } } };
  }

  if (has("timeEntryUpdate")) {
    const input = v.input ?? {};
    const t = store.find((x) => x.id === input.id);
    if (!t) return payloadError("timeEntryUpdate", `TimeEntry bulunamadı: ${input.id}`, ["id"]);

    if (input.timeSpent != null) {
      const bad = validateWrite({ ...input, personId: t.personId });
      if (bad) return payloadError("timeEntryUpdate", bad, ["timeSpent"]);
      t.timeSpent = input.timeSpent;
    }
    // ★ two_step'in tüm dayanağı: TimeEntryUpdateInput'ta assignment YOKTUR,
    // dolayısıyla bu adım ticket bağını BOZAMAZ. Aşağıda t.assignment'a
    // BİLEREK dokunulmuyor.
    if (input.date != null) t.date = input.date;
    if (input.startedAt != null) t.startedAt = input.startedAt;
    if (input.personId != null) t.personId = input.personId;
    if (input.description != null) t.description = input.description;
    if (input.effortClassId != null) t.effortClassId = input.effortClassId;

    return { data: { timeEntryUpdate: {
      clientMutationId: input.clientMutationId ?? null, errors: [], timeEntry: timeEntryNode(t) } } };
  }

  const PARENT = [
    ["requestUpdate", "Request", () => F.requests.requests],
    ["taskUpdate", "Task", () => F.tasks.tasks],
    ["projectTaskUpdate", "ProjectTask", () => []],
    ["problemUpdate", "Problem", () => []],
  ];
  for (const [field, kind, rows] of PARENT) {
    if (!has(field)) continue;
    const input = v.input ?? {};
    const parent = rows().find((r) => r.id === input.id);
    if (!parent && rows().length)
      return { data: { [field]: { clientMutationId: null,
        errors: [{ message: `${kind} bulunamadı: ${input.id}`, path: ["id"] }], [kind.toLowerCase()]: null } } };

    if (input.timeSpent != null) {
      const bad = validateWrite({
        timeSpent: input.timeSpent, correction: false,
        description: input.timeEntryDescription, personId: ME.id, date: todayLocal(),
      });
      if (bad) return { data: { [field]: { clientMutationId: null,
        errors: [{ message: bad, path: ["timeSpent"] }], [kind.toLowerCase()]: null } } };

      // ★ Bu yolda date SUNUCU tarafından "bugün", person authenticated user
      // olarak atanır — istek ne gönderirse göndersin. Kontrol EDİLEMEZ.
      const entry = {
        id: mintId("TimeEntry"),
        personId: ME.id,
        date: todayLocal(),
        startedAt: null,
        timeSpent: input.timeSpent,   // ★ ARTIMLI: mevcut toplamın ÜZERİNE eklenir
        description: input.timeEntryDescription ?? null,
        effortClassId: input.timeSpentEffortClassId ?? TS_SET.defaults.requestEffortClassId,
        correction: false,
        timeAllocationId: null,
        assignment: { type: kind, id: input.id },
        source: null, sourceID: null,
      };
      store.push(entry);
      if (parent) parent.timeSpentTotalMinutes = (parent.timeSpentTotalMinutes ?? 0) + input.timeSpent;
    }

    const node = kind === "Request" && parent ? requestNode(parent)
               : kind === "Task" && parent ? taskNode(parent)
               : { id: input.id };
    return { data: { [field]: {
      clientMutationId: input.clientMutationId ?? null, errors: [], [kind.toLowerCase()]: node } } };
  }

  // ── SORGULAR ────────────────────────────────────────────────────────────

  // TimeTrackingContext de "me" içerir; ondan önce effortClasses'a bakılır.
  if (has("effortClasses")) {
    return { data: {
      me: { id: ME.id, organization: { ...ME.organization, timesheetSetting: {
        id: TS_SET.id, name: TS_SET.name, unit: TS_SET.unit,
        workday: TS_SET.workday, workweek: TS_SET.workweek,
        timeIncrement: TS_SET.timeIncrement, percentageIncrement: TS_SET.percentageIncrement,
        allowWorkdayOvertime: TS_SET.allowWorkdayOvertime,
        allowWorkweekOvertime: TS_SET.allowWorkweekOvertime,
        allocationTimeTracking: TS_SET.allocationTimeTracking,
        assignmentTimeTracking: TS_SET.assignmentTimeTracking,
        requireNote: TS_SET.requireNote,
        requireTimeEntryDescription: TS_SET.requireTimeEntryDescription,
        requestEffortClass: ec(TS_SET.defaults.requestEffortClassId),
        taskEffortClass: ec(TS_SET.defaults.taskEffortClassId),
        projectTaskEffortClass: ec(TS_SET.defaults.projectTaskEffortClassId),
        problemEffortClass: ec(TS_SET.defaults.problemEffortClassId),
        timeAllocationEffortClass: ec(TS_SET.defaults.timeAllocationEffortClassId),
      } } },
      // ★ disabled olanlar BİLEREK döndürülüyor: EffortClassFilter'da "disabled"
      // filtresi YOKTUR, eleme CLIENT tarafında yapılmak zorundadır.
      effortClasses: { nodes: F.effortClasses.effortClasses.map((e) => ({
        id: e.id, name: e.name, position: e.position,
        costMultiplier: e.costMultiplier, disabled: e.disabled })) },
      timeAllocations: { nodes: F.allocations.timeAllocations.map((a) => ({
        id: a.id, name: a.name, group: { id: "TW9jay9Hcm91cC8x", name: a.group },
        descriptionRequired: a.descriptionRequired })) },
    } };
  }

  if (has("people")) {
    const email = v.email;
    // PersonFilter.primaryEmail bir TextFilter'dır: TAM eşleşme, substring değil.
    const found = F.people.people.filter((p) => p.primaryEmail === email);
    return { data: { people: { totalCount: found.length, nodes: found.map(personNode) } } };
  }

  if (has("requests")) {
    const pid = v.personId === "$me" ? ME.id : v.personId;
    const rows = F.requests.requests
      .filter((r) => r.memberId === pid && OPEN_REQUEST_STATUSES.has(r.status));
    return { data: { requests: {
      totalCount: rows.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: rows.map(requestNode) } } };
  }

  if (has("tasks")) {
    const pid = v.personId === "$me" ? ME.id : v.personId;
    const rows = F.tasks.tasks
      .filter((t) => t.assigneeId === pid && OPEN_TASK_STATUSES.has(t.status));
    return { data: { tasks: {
      totalCount: rows.length,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: rows.map(taskNode) } } };
  }

  if (has("timeEntries")) {
    const pid = v.personId === "$me" ? ME.id : v.personId;
    // ★ Tarih filtresini GERÇEKTEN uygula. Üç implementasyon iki farklı değişken
    // adı kullanıyor: TS/Python `dateFrom` (greaterThanOrEqualTo), C# `date`
    // (tam eşleşme, günlük toplam için). Filtreyi yok saymak, istemcinin başka
    // günlerin kayıtlarını "bugün" sanmasına ve workday tavanına yanlış yerden
    // çarpmasına yol açar — bu sahte sunucunun ilk sürümündeki gerçek hataydı.
    const from = v.dateFrom;
    const to = v.dateTo;       // xurrent_list_time_entries aralık sorgusu (dahil)
    const exact = v.date;
    // sourceID filtresi: dedup geri-okuması (reliability.md §5). Gerçek
    // TimeEntryFilter'da bu filtrenin varlığı DOĞRULANMALI'dır (D14).
    const bySource = v.sourceID;
    const rows = store
      .filter((t) => (!pid || t.personId === pid)
        && (!from || t.date >= from)
        && (!to || t.date <= to)
        && (!exact || t.date === exact)
        && (!bySource || t.sourceID === bySource))
      .slice()
      .reverse()
      .slice(0, exact || bySource || to ? 100 : 5);
    return { data: { timeEntries: { nodes: rows.map(timeEntryNode) } } };
  }

  if (has("me") || has("account")) {
    return { data: {
      me: personNode(ME),
      account: F.people.account,
      rateLimit: { limit: RATE_MAX, cost: 1, remaining: RATE_MAX - hits.length, resetAt: 0 },
    } };
  }

  return gqlError("Tanınmayan sorgu. Sahte sunucu yalnızca bu projenin kullandığı " +
                  "root field'ları destekler: me, account, people, requests, tasks, " +
                  "effortClasses, timeEntries, timeEntryCreate, timeEntryUpdate, " +
                  "requestUpdate, taskUpdate, projectTaskUpdate, problemUpdate.");
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const sendNow = (code, body, extra = {}) => {
    const json = JSON.stringify(body);
    res.writeHead(code, {
      "content-type": "application/json",
      "x-ratelimit-limit": String(RATE_MAX),
      "x-ratelimit-remaining": String(Math.max(0, RATE_MAX - hits.length)),
      "x-ratelimit-reset": String(Math.ceil(RATE_WINDOW_MS / 1000)),
      "x-ratelimit-cost": "1",
      ...extra,
    });
    res.end(json);
  };
  // --gecikme-ms tüm yanıtlara uygulanır (zaman aşımı/yavaşlık senaryoları).
  const send = (code, body, extra = {}) =>
    KAOS.gecikmeMs > 0 ? void setTimeout(() => sendNow(code, body, extra), KAOS.gecikmeMs)
                       : sendNow(code, body, extra);

  // İKİ YÜZEY: /v1/* REST'tir (GET/POST/PATCH), geri kalanı GraphQL (yalnız POST).
  const u = new URL(req.url, "http://yerel");
  const isRest = u.pathname === "/v1" || u.pathname.startsWith("/v1/");

  if (!isRest && req.url !== "/_kaos" && req.method !== "POST")
    return send(405, gqlError("GraphQL yüzeyinde yalnızca POST desteklenir. REST yüzeyi /v1 altındadır."));

  // ── /_kaos: TEST YÜZEYİ (gerçek Xurrent'ta yoktur) ──
  // Kaos bayraklarını süreç ÖLDÜRÜLMEDEN değiştirir. Neden gerekli: sahte sunucu
  // yazmaları bellekte tutar; senaryo (g) "kaoslu bulk → kaossuz tekrar" akışında
  // süreci yeniden başlatmak store'u sıfırlar ve dedup kanıtını imkânsız kılar.
  if (req.url === "/_kaos") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try {
        const patch = JSON.parse(raw || "{}");
        for (const k of ["k429", "k500", "oran500", "gecikmeMs", "kirDesc"]) {
          if (k in patch) KAOS[k] = patch[k];
        }
        log("kaos güncellendi".padEnd(24), JSON.stringify(KAOS));
        sendNow(200, { data: { kaos: KAOS } });
      } catch {
        sendNow(400, gqlError("Kaos gövdesi geçerli JSON değil."));
      }
    });
    return;
  }

  // ── auth: gerçek sunucunun reddettiği durumlar ──
  const auth = req.headers["authorization"];
  if (!auth || !/^Bearer\s+.+/i.test(auth))
    return send(401, gqlError("Authorization header eksik veya hatalı. Beklenen: 'Bearer <token>'."));
  if (!req.headers["x-xurrent-account"])
    return send(400, gqlError("X-Xurrent-Account header zorunludur (hesap slug'ı, numerik değil)."));

  // ── kaos: auth'tan SONRA, rate-check'ten ÖNCE ──
  // 429 kaosu "istek işlenmeden reddedildi" sınıfını taklit eder — istemci
  // Retry-After'a uyup tekrarlamalı, kayıt ÇİFTLENMEMELİDİR (senaryo f).
  if (KAOS.k429 > 0) {
    KAOS.k429--;
    log("429 KAOS".padEnd(24), `kalan=${KAOS.k429}`);
    return send(429, gqlError("Kaos: rate limit."), { "retry-after": "1" });
  }
  if (KAOS.k500 > 0) {
    KAOS.k500--;
    log("500 KAOS".padEnd(24), `kalan=${KAOS.k500}`);
    return send(500, gqlError("Kaos: sunucu iç hatası."));
  }
  if (KAOS.oran500 > 0 && prng() < KAOS.oran500) {
    log("500 KAOS(oran)".padEnd(24), `p=${KAOS.oran500}`);
    return send(500, gqlError("Kaos: sunucu iç hatası (oranlı)."));
  }

  const rl = rateCheck();
  if (!rl.ok) {
    // 429 GÖRÜNÜR olmalı: istemcinin throttle etmediğini ancak böyle fark ederiz.
    log("429 RATE-LIMIT".padEnd(24), `${RATE_MAX} istek / ${RATE_WINDOW_MS / 1000} sn aşıldı`);
    return send(429, gqlError(`Rate limit aşıldı: ${RATE_MAX} istek / ${RATE_WINDOW_MS / 1000} saniye.`),
      { "retry-after": "2" });
  }

  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 2e6) req.destroy(); });
  req.on("end", () => {
    // ── REST yüzeyi ──
    if (isRest) {
      let restBody = {};
      if (raw) {
        try { restBody = JSON.parse(raw); }
        catch { return send(400, { errors: [{ message: "Gövde geçerli JSON değil." }] }); }
      }
      // --kaos-kir-desc REST karşılığı: aynı bayrak iki yüzeyde de kırar.
      if (KAOS.kirDesc && req.method === "POST" && u.pathname === "/v1/time_entries"
          && String(restBody.description ?? "").includes(KAOS.kirDesc)) {
        log("500 KAOS(kir-desc)".padEnd(24), `REST ${KAOS.kirDesc}`);
        return send(500, { errors: [{ message: `Kaos: '${KAOS.kirDesc}' kalemi kalıcı kırık.` }] });
      }
      try {
        const segs = u.pathname.replace(/^\/v1\/?/, "").split("/").filter(Boolean);
        const out = handleRest(req.method, segs, u.searchParams, restBody);
        log(`REST ${req.method} /v1/${segs.join("/")}`.padEnd(24), out.code < 400 ? "ok" : String(out.code));
        return send(out.code, out.body);
      } catch (e) {
        log("REST iç hata:", e?.message);
        return send(500, { errors: [{ message: `Sahte sunucu iç hatası: ${e?.message}` }] });
      }
    }

    // ── GraphQL yüzeyi ──
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, gqlError("Gövde geçerli JSON değil.")); }

    const query = String(body.query ?? "");
    if (!query) return send(400, gqlError("query alanı zorunludur."));

    // --kaos-kir-desc: eşleşen timeEntryCreate HER SEFERİNDE 500 alır.
    // Retry bu kalemi KURTARAMAZ — kısmi bulk + tekrar-çalıştırma dersinin
    // (senaryo g) kalıcı kırık kalemi budur.
    if (KAOS.kirDesc && /timeEntryCreate/.test(query)
        && String(body.variables?.input?.description ?? "").includes(KAOS.kirDesc)) {
      log("500 KAOS(kir-desc)".padEnd(24), KAOS.kirDesc);
      return send(500, gqlError(`Kaos: '${KAOS.kirDesc}' kalemi kalıcı kırık.`));
    }

    // GraphQL istek başına 1 mutation kabul eder.
    const mutationCount = (query.match(/\bmutation\b/g) ?? []).length;
    if (mutationCount > 1)
      return send(200, gqlError("İstek başına yalnızca 1 mutation gönderilebilir."));

    try {
      const out = handle(query, body.variables);
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      log(op.padEnd(24), out.errors ? "GraphQL-HATA" : "ok");
      send(200, out);
    } catch (e) {
      log("iç hata:", e?.message);
      send(500, gqlError(`Sahte sunucu iç hatası: ${e?.message}`));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`dinleniyor: http://127.0.0.1:${PORT}`);
  log(`fixtures   : ${FIXTURES}`);
  log(`saat dilimi: ${TZ} (offset ${tzOffset()})`);
  if (!QUIET) console.error("");
});

export { server, PORT };
