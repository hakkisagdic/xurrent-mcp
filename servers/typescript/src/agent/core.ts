/**
 * Chatbot çekirdeği — Gemini tool döngüsü.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MİMARİ KARAR: Chatbot, MCP client OLARAK DEĞİL, tool'ları DOĞRUDAN (in-process)
 * çağıran bir yol seçti. Gerekçe:
 *
 *   1) Aynı süreçte çalışan bir MCP client + server çifti, ders için hiçbir şey
 *      kanıtlamadan iki ekstra hareketli parça ekler (alt süreç, stdio çerçeveleme,
 *      yaşam döngüsü). Protokol vaadi zaten clients/wizard ile kanıtlanıyor:
 *      o GERÇEK bir MCP client'tır ve üç sunucuya da bağlanır.
 *
 *   2) ONAY doğrudan yolda daha dürüst çalışıyor: terminalde readline, web'de SSE
 *      `elicit` olayı. MCP client üzerinden gitseydik onay isteğini yine bu katmanın
 *      protokole çevirmesi gerekirdi — yani aynı kod, bir sarmalayıcı fazlası.
 *
 * Tool tanımları SÖZLEŞMENİN AYNISIDIR: JSON Schema'lar core/schemas.ts'teki zod
 * şemalarından üretilir; MCP tools/list ile chatbot'un gördüğü şema TEK kaynaktan gelir.
 *
 * ★ AMA AYNI ŞEMA AYNEN GÖNDERİLEMEZ. MCP inputSchema tam JSON Schema 2020-12'dir;
 *   Gemini functionDeclarations yalnızca OpenAPI'nin bir alt kümesini kabul eder.
 *   Aradaki çeviriyi llm/schema.ts yapar ve NE ATTIĞINI stderr'e raporlar.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ToolContext } from "../core/context.js";
import {
  candidateParts,
  functionCalls,
  plainText,
  type GeminiClient,
  type GeminiContent,
  type GeminiFunctionDeclaration,
  type GeminiPart,
} from "../llm/gemini.js";
import {
  formatTranslationReport,
  mcpSchemaToGemini,
  type SchemaTranslation,
  type TranslationReportEntry,
} from "../llm/schema.js";
import { runCalendarListToday } from "../tools/calendar-list-today.js";
import { runBulk } from "../tools/create-time-entries-bulk.js";
import { runCreateTimeEntry } from "../tools/create-time-entry.js";
import { runFindPerson } from "../tools/find-person.js";
import { runListOpenWork } from "../tools/list-open-work.js";
import { runPlanFromCalendar } from "../tools/plan-from-calendar.js";
import { runTimeTrackingContext } from "../tools/time-tracking-context.js";
import { runWhoami } from "../tools/whoami.js";
import {
  bulkInput,
  calendarInput,
  createTimeEntryInput,
  findPersonInput,
  listOpenWorkInput,
  planInput,
  timeTrackingContextInput,
  whoamiInput,
} from "../core/schemas.js";

/**
 * Gemini 3.x'te düşünme (thinking) varsayılan açıktır ve maxOutputTokens düşünme +
 * metni BİRLİKTE sınırlar. Düşük bir değer verilirse model "düşünürken" biter ve
 * boş cevap gelir — bu, sessiz ve teşhisi zor bir hatadır.
 */
export const MAX_OUTPUT_TOKENS = 16000;

/** Ders çıktıları deterministik olsun diye sıcaklık 0. */
export const TEMPERATURE = 0;

/**
 * Tool döngüsünün azami tur sayısı. Sonsuz döngüye karşı sigorta: kötü bir model
 * (veya sahte bir sunucu) aynı tool'u sonsuza kadar çağırabilir.
 */
export const MAX_TOOL_STEPS = 12;

export const SYSTEM_PROMPT = `Sen Xurrent (ITSM) zaman takibi asistanısın. Kullanıcıyla TÜRKÇE konuşursun.

GÖREVİN
- Kişinin açık Request/Task'larını listelemek,
- kullanıcıyla süre üzerine MÜZAKERE etmek (hangi ticket, kaç dakika, hangi tarih),
- onayı alındıktan sonra zaman girişlerini Xurrent'a kaydetmek,
- günün takvimini okuyup her toplantıyı zaman girişi önerisine çevirmek.

DEĞİŞMEZ KURALLAR
1. ZAMAN YAZMADAN ÖNCE mutlaka xurrent_get_time_tracking_context çağır. timeIncrement
   bilinmeden süre SEÇİLEMEZ. Sonucu oturum boyunca hatırla, tekrar tekrar çağırma.
2. Tüm süreler DAKİKA cinsindendir. Kullanıcı "2 saat" derse 120'ye çevir ve
   ÇEVİRDİĞİNİ SÖYLE. Saat/saniye asla kullanma.
3. Süre timeIncrement'in KATI olmalıdır. Yuvarlama gerekiyorsa ÖNCE SOR, sessizce yuvarlama.
4. Node id'lerini (opak base64 string'ler) ASLA uydurma, tahmin etme veya hatırladığını sanma.
   Her id bir tool çıktısından gelmek zorundadır. Elinde id yoksa önce listeleme tool'unu çağır.
5. Yazmadan önce dryRun=true ile planı göster ve kullanıcının onayını al. Onay
   protokol seviyesinde ayrıca sorulur; sen onayı VARSAYMA.
6. Yol B'de (request/task hedefli yazma) timeSpent ARTIMLIDIR: "üzerine ekle" demektir,
   "toplamı bu yap" değil. Kullanıcı toplamı söylüyorsa farkı hesapla ve teyit et.
7. Eşleşmeden emin değilsen SOR. plan_time_entries_from_calendar needsUserDecision=true
   dönen her öneri için kullanıcıya hangi ticket olduğunu sormalısın.
8. Bulk yazma ATOMİK DEĞİLDİR. Kısmi başarı olduğunda hangi satırların yazıldığını,
   hangilerinin yazılmadığını AÇIKÇA söyle.
9. Bir işlem uyarı (warning) döndürdüyse uyarıları kullanıcıya AKTAR. Özellikle
   "tarih bugün olacak", "ticket'a bağlanmayacak", "atomik değil" uyarılarını gizleme.
10. Bilmediğin bir şeyi uydurma. Tool bir alan döndürmediyse "bilinmiyor" de.

ÜSLUP: Kısa, net, teknik ama anlaşılır. Sayıları ve id'leri açıkça yaz. Emoji kullanma.`;

/** zod raw shape → JSON Schema (MCP tarafının gördüğü şeyin AYNISI). */
function toInputSchema(shape: Record<string, z.ZodTypeAny>): Record<string, unknown> {
  const json = z.toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>;
  return { ...json, type: "object" };
}

/**
 * Tool çıktısını TEK SATIRLIK Türkçe özete indirger.
 *
 * Neden backend'de: arayüz tool semantiğini BİLMEZ (clients/web/API.md'nin kuralı).
 * Özeti üretebilecek tek yer, sözleşmeyi bilen taraftır.
 */
export function summarizeToolResult(name: string, result: unknown): string | null {
  const r = result as Record<string, any>;
  try {
    switch (name) {
      case "xurrent_whoami":
        return `${r.person?.name ?? "?"} — ${r.account?.name ?? r.account?.id ?? "?"} (${r.mode})`;
      case "xurrent_find_person":
        return `${r.totalCount} kişi bulundu`;
      case "xurrent_list_open_work":
        return `${r.requests?.totalCount ?? 0} açık talep, ${r.tasks?.totalCount ?? 0} açık görev`;
      case "xurrent_get_time_tracking_context":
        return `timeIncrement ${r.timeIncrement} dk · ${r.effortClasses?.length ?? 0} effort class · ${
          r.timeAllocations?.length ?? 0
        } allocation`;
      case "xurrent_create_time_entry":
        if (r.errors?.length) return `başarısız: ${r.errors[0].message}`;
        return r.dryRun
          ? `dry-run · ${r.strategy} · ${r.planned?.length ?? 0} mutation planlandı`
          : `kayıt oluştu · ${r.strategy} · TimeEntry ${r.timeEntry?.id ?? "?"}`;
      case "xurrent_create_time_entries_bulk":
        return `${r.summary?.created ?? 0}/${r.summary?.requested ?? 0} kayıt oluştu · ${
          r.summary?.failed ?? 0
        } başarısız · toplam ${r.summary?.totalMinutes ?? 0} dk`;
      case "calendar_list_today":
        return `${r.totals?.count ?? 0} gerçek toplantı (${r.totals?.rawCount ?? 0} ham, ${
          r.totals?.filteredOut ?? 0
        } elendi) · meşgul ${r.totals?.busyMinutes ?? 0} dk`;
      case "plan_time_entries_from_calendar":
        return `${r.proposals?.length ?? 0} öneri · ${r.totals?.proposedMinutes ?? 0} dk · ${
          r.proposals?.filter((p: any) => p.needsUserDecision).length ?? 0
        } tanesi kullanıcı kararı bekliyor`;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export interface ToolHooks {
  onStart?: (id: string, name: string, args: unknown) => void;
  onEnd?: (payload: {
    id: string;
    name: string;
    isError: boolean;
    durationMs: number;
    summary: string | null;
    result: unknown;
  }) => void;
}

/** Sözleşmedeki bir tool'un chatbot tarafındaki çalıştırılabilir hâli. */
export interface AgentTool {
  name: string;
  /** Gemini'ye gönderilen bildirim (şema ÇEVRİLMİŞ hâliyle). */
  declaration: GeminiFunctionDeclaration;
  /** Şema çevirisinin raporu — ders artifaktı; testte de kullanılır. */
  translation: SchemaTranslation;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Bildirimler ctx'e BAĞLI DEĞİLDİR: aynı sözleşme, aynı şema, aynı çeviri.
 * Bir kez hesaplanır — her turda 8 şemayı yeniden çevirmek boş iştir.
 */
interface ToolSpec {
  name: string;
  declaration: GeminiFunctionDeclaration;
  translation: SchemaTranslation;
  bind: (ctx: ToolContext) => (args: Record<string, unknown>) => Promise<unknown>;
}

let cachedSpecs: ToolSpec[] | null = null;

/** Rapor süreç başına BİR KEZ basılır; her tur tekrar basmak logu boğar. */
let reportPrinted = false;

function toolSpecs(): ToolSpec[] {
  if (cachedSpecs) return cachedSpecs;

  const mk = (
    name: string,
    description: string,
    shape: Record<string, z.ZodTypeAny>,
    run: (ctx: ToolContext, args: any) => Promise<unknown>,
  ): ToolSpec => {
    const mcpSchema = toInputSchema(shape);
    // ★ ÇEVİRİ BURADA: MCP (JSON Schema 2020-12) → Gemini (OpenAPI alt kümesi).
    const translation = mcpSchemaToGemini(mcpSchema);

    // ★ Parametresiz tool'da `parameters` HİÇ GÖNDERİLMEZ.
    //
    // Gemini'de bu alan opsiyoneldir ve `{type:"object", properties:{}}` göndermek
    // "argümanı olmayan fonksiyon"u ifade etmenin garantili yolu DEĞİLDİR — boş
    // properties bazı sürümlerde reddedilir. Opsiyonel bir alanı hiç göndermemek
    // reddedilemez; boş göndermek edilebilir. Gerçek API'ye soramadığımız için
    // ihtiyatlı taraf açık.
    //
    // Python ve C# implementasyonları bunu baştan doğru yapıyordu; TypeScript
    // ayrık kalmıştı. Wire denetimi (tools/fake-gemini yanındaki sonda) yakaladı.
    const bosSema =
      translation.schema?.type === "object" &&
      Object.keys(translation.schema.properties ?? {}).length === 0;

    return {
      name,
      declaration: bosSema
        ? { name, description }
        : { name, description, parameters: translation.schema },
      translation,
      bind: (ctx) => (args) => run(ctx, args ?? {}),
    };
  };

  cachedSpecs = [
    mk(
      "xurrent_whoami",
      "Authenticated kullanıcıyı, hesabı ve modu döner. Bağlantı smoke test'i.",
      whoamiInput,
      (ctx) => runWhoami(ctx),
    ),
    mk(
      "xurrent_find_person",
      "Kişiyi birincil e-posta ile bulur. TAM eşleşme yapar (substring değil).",
      findPersonInput,
      (ctx, a) => runFindPerson(ctx, a),
    ),
    mk(
      "xurrent_list_open_work",
      "Bir kişinin üzerindeki AÇIK Request ve Task'ları id + açıklama ile listeler.",
      listOpenWorkInput,
      (ctx, a) => runListOpenWork(ctx, a),
    ),
    mk(
      "xurrent_get_time_tracking_context",
      "ZAMAN YAZMADAN ÖNCE ZORUNLU: timeIncrement, effort class'lar, timesheet kısıtları.",
      timeTrackingContextInput,
      (ctx, a) => runTimeTrackingContext(ctx, a),
    ),
    mk(
      "xurrent_create_time_entry",
      "Tek bir zaman girişi oluşturur. dryRun=true ile hiçbir mutation gönderilmez.",
      createTimeEntryInput,
      (ctx, a) => runCreateTimeEntry(ctx, a),
    ),
    mk(
      "xurrent_create_time_entries_bulk",
      "Birden çok zaman girişini sırayla oluşturur. ATOMİK DEĞİLDİR.",
      bulkInput,
      (ctx, a) => runBulk(ctx, a),
    ),
    mk(
      "calendar_list_today",
      "Günün takvimini okur, normalize eder, gerçek toplantıları filtreler.",
      calendarInput,
      (ctx, a) => runCalendarListToday(ctx, a),
    ),
    mk(
      "plan_time_entries_from_calendar",
      "Takvim + açık işlerden zaman girişi ÖNERİSİ üretir. ASLA YAZMAZ.",
      planInput,
      (ctx, a) => runPlanFromCalendar(ctx, a),
    ),
  ];

  if (!reportPrinted) {
    reportPrinted = true;
    const entries: TranslationReportEntry[] = cachedSpecs.map((t) => ({ name: t.name, translation: t.translation }));
    // stdout DEĞİL stderr: stdio modunda stdout yalnızca JSON-RPC taşır.
    process.stderr.write(formatTranslationReport(entries) + "\n");
  }

  return cachedSpecs;
}

/** Sözleşmedeki 8 tool'u, verilen bağlama bağlanmış hâlde döner. */
export function buildTools(ctx: ToolContext): AgentTool[] {
  return toolSpecs().map((spec) => ({
    name: spec.name,
    declaration: spec.declaration,
    translation: spec.translation,
    run: spec.bind(ctx),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Tur yürütme
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sohbet mesajı = Gemini `Content`.
 *
 * clients/web/API.md §2: `messages` dizisi ARAYÜZ TARAFINDAN YORUMLANMAZ; arayüz
 * `done` olayında ne aldıysa aynen geri gönderir. Yani backend kendi doğal biçimini
 * kullanabilir — burada o biçim Gemini'nin `contents` dizisidir.
 */
export type ChatMessage = GeminiContent;

/** clients/web/API.md'deki SSE olaylarının birebir karşılığı. */
export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; id: string; name: string; args: unknown }
  | {
      type: "tool_result";
      id: string;
      name: string;
      isError: boolean;
      durationMs: number;
      summary: string | null;
      result: unknown;
    }
  | {
      type: "done";
      stopReason: string | null;
      messages: ChatMessage[];
      usage?: { inputTokens: number; outputTokens: number };
    }
  | { type: "error"; message: string; code?: string };

/**
 * Arayüzden gelen mesajları Gemini `contents` biçimine normalize eder.
 *
 * İki biçim gelebilir:
 *   1) Arayüzün ürettiği yeni kullanıcı mesajı: { role: "user", content: "metin" }
 *   2) Bizim `done` olayında verdiğimiz doğal biçim: { role: "user"|"model", parts: [...] }
 *
 * ★ Rol eşlemesi: "assistant" → "model". Gemini'de "assistant" rolü YOKTUR ve
 *   "system" rolü de yoktur (sistem mesajı systemInstruction alanına gider).
 */
export function toGeminiContents(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) return [];
  const out: ChatMessage[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null) continue;
    const m = raw as Record<string, unknown>;
    const role = m["role"] === "model" || m["role"] === "assistant" ? "model" : "user";

    if (Array.isArray(m["parts"])) {
      out.push({ role, parts: m["parts"] as GeminiPart[] });
      continue;
    }
    const content = m["content"];
    if (typeof content === "string") {
      out.push({ role, parts: [{ text: content }] });
      continue;
    }
    if (Array.isArray(content)) {
      // Savunma amaçlı: blok dizisi geldiyse metin bloklarını topla.
      const text = content
        .map((b) => (typeof b === "string" ? b : ((b as Record<string, unknown>)?.["text"] as string) ?? ""))
        .join("");
      if (text) out.push({ role, parts: [{ text }] });
    }
  }
  return out;
}

/** `functionResponse.response` OBJE olmak zorundadır; düz değerler sarmalanır. */
function asResponseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { result: value };
}

/**
 * Tek bir konuşma turu. DURUM TUTMAZ: gelen messages dizisi girdidir, dönen
 * messages dizisi çıktıdır. Web sözleşmesi (clients/web/API.md §2) bunu şart koşuyor
 * ve aynı zamanda doğru tasarım: sohbet durumu sunucunun belleğinde yaşamaz.
 *
 * ★ TOOL DÖNGÜSÜ (Gemini lehçesi):
 *     contents += { role: "model", parts: [{ functionCall: {id, name, args} }] }
 *     contents += { role: "user",  parts: [{ functionResponse: {id, name, response} }] }
 *   Sıra ve id eşleşmesi ZORUNLUDUR. Tool sonucu "user" rolüyle döner — Gemini'de
 *   "tool" diye bir rol yoktur.
 */
export async function runTurn(
  client: GeminiClient,
  cfg: AppConfig,
  ctx: ToolContext,
  messages: ChatMessage[],
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const tools = buildTools(ctx);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const contents: ChatMessage[] = [...messages];

  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const res = await client.generateContent(
        {
          contents,
          tools: [{ functionDeclarations: tools.map((t) => t.declaration) }],
          // ★ Sistem mesajı contents içine KONMAZ.
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: { temperature: TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS },
        },
        signal,
      );

      inputTokens += res.usageMetadata?.promptTokenCount ?? 0;
      outputTokens += res.usageMetadata?.candidatesTokenCount ?? 0;

      const parts = candidateParts(res);
      stopReason = res.candidates?.[0]?.finishReason ?? null;

      const text = plainText(parts);
      if (text) onEvent({ type: "text", delta: text });

      const calls = functionCalls(parts);

      // Modelin turu geçmişe AYNEN eklenir. functionCall part'ları burada durmalı,
      // yoksa bir sonraki istekte functionResponse'un eşleşeceği çağrı kalmaz.
      if (parts.length > 0) contents.push({ role: "model", parts });

      if (calls.length === 0) break;

      const responseParts: GeminiPart[] = [];
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i] as (typeof calls)[number];
        // Arayüz kartı id ile eşleşir. Model id vermediyse deterministik bir tane üretilir
        // — ama bu id API'ye GÖNDERİLMEZ (aşağıya bak).
        const eventId = call.id ?? `${call.name}-${step}-${i}`;
        const args = (call.args ?? {}) as Record<string, unknown>;
        onEvent({ type: "tool_use", id: eventId, name: call.name, args });

        const started = Date.now();
        const tool = byName.get(call.name);
        let result: unknown;
        let isError = false;

        if (!tool) {
          isError = true;
          result = { error: `Bilinmeyen tool: ${call.name}` };
        } else {
          try {
            result = await tool.run(args);
          } catch (err) {
            isError = true;
            result = { error: err instanceof Error ? err.message : String(err) };
          }
        }

        onEvent({
          type: "tool_result",
          id: eventId,
          name: call.name,
          isError,
          durationMs: Date.now() - started,
          summary: isError
            ? `hata: ${(result as { error?: string }).error ?? "bilinmiyor"}`
            : summarizeToolResult(call.name, result),
          result,
        });

        // ★ id EŞLEŞMESİ: functionCall.id ile functionResponse.id AYNI olmak ZORUNDA.
        //   Model id göndermediyse biz de göndermeyiz — uydurulmuş bir id, API'nin
        //   hiçbir çağrıyla eşleştiremeyeceği bir yanıt üretir.
        const responsePart: GeminiPart = {
          functionResponse: {
            ...(call.id !== undefined ? { id: call.id } : {}),
            name: call.name,
            // response OBJE olmak zorunda; hata da yapılandırılmış olarak gider.
            response: asResponseObject(result),
          },
        };
        responseParts.push(responsePart);
      }

      // ★ Tool sonuçları "user" rolüyle döner. Gemini'de "tool" rolü YOKTUR.
      contents.push({ role: "user", parts: responseParts });
    }

    onEvent({ type: "done", stopReason, messages: contents, usage: { inputTokens, outputTokens } });
    return contents;
  } catch (err) {
    onEvent({ type: "error", message: err instanceof Error ? err.message : String(err) });
    return messages;
  }
}

/** Terminal chatbot için geçmişi kendi tutan ince sarmalayıcı. */
export interface AgentSession {
  ask(userText: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void>;
  readonly history: ChatMessage[];
}

export function createAgent(cfg: AppConfig, ctx: ToolContext, client: GeminiClient): AgentSession {
  let history: ChatMessage[] = [];
  return {
    get history() {
      return history;
    },
    async ask(userText, onEvent, signal) {
      const next: ChatMessage[] = [...history, { role: "user", parts: [{ text: userText }] }];
      history = await runTurn(client, cfg, ctx, next, onEvent, signal);
    },
  };
}
