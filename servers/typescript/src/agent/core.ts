/**
 * Chatbot çekirdeği — Anthropic toolRunner döngüsü.
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
 *   2) Bilinen bir tip uyumsuzluğu var: MCP Client.callTool() legacy {toolResult}
 *      şeklini içeren bir union döndürür ve mcpTools()'a doğrudan verilemez.
 *      Çözümü unsafe cast değil, ince bir adapter'dır:
 *          { callTool: (p) => mcp.callTool(p) as Promise<{content: ...; isError?: boolean}> }
 *      Bu adapter'ı yazmak mümkündü; ama (1)'deki maliyet karşılığında faydası yoktu.
 *
 *   3) ONAY doğrudan yolda daha dürüst çalışıyor: terminalde readline, web'de SSE
 *      `elicit` olayı. MCP client üzerinden gitseydik onay isteğini yine bu katmanın
 *      protokole çevirmesi gerekirdi — yani aynı kod, bir sarmalayıcı fazlası.
 *
 * Tool tanımları SÖZLEŞMENİN AYNISIDIR: JSON Schema'lar tools/schemas.ts'teki zod
 * şemalarından üretilir; MCP tools/list ile chatbot'un gördüğü şema TEK kaynaktan gelir.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Anthropic from "@anthropic-ai/sdk";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.mjs";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { runCalendarListToday } from "../tools/calendar-list-today.js";
import type { ToolContext } from "../core/context.js";
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

/** Opus 5'te thinking varsayılan AÇIKTIR ve max_tokens thinking+text'i BİRLİKTE sınırlar. */
export const MAX_TOKENS = 16000;

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

/** zod raw shape → Anthropic input_schema (JSON Schema). Tek gerçek kaynak: schemas.ts */
function toInputSchema(shape: Record<string, z.ZodTypeAny>): {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
} {
  const json = z.toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>;
  delete json["$schema"];
  return { ...(json as { type: "object" }), type: "object" };
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

/** Sözleşmedeki 8 tool'u Anthropic runnable tool'larına çevirir. */
export function buildTools(ctx: ToolContext, hooks: ToolHooks = {}): BetaRunnableTool<any>[] {
  const mk = (
    name: string,
    description: string,
    shape: Record<string, z.ZodTypeAny>,
    run: (args: any) => Promise<unknown>,
  ): BetaRunnableTool<any> => ({
    name,
    description,
    input_schema: toInputSchema(shape),
    parse: (content: unknown) => (content ?? {}) as Record<string, unknown>,
    run: async (args: Record<string, unknown>, context) => {
      const id = (context?.toolUse as { id?: string } | undefined)?.id ?? `${name}-${Date.now()}`;
      hooks.onStart?.(id, name, args);
      const started = Date.now();
      try {
        const result = await run(args);
        hooks.onEnd?.({
          id,
          name,
          isError: false,
          durationMs: Date.now() - started,
          summary: summarizeToolResult(name, result),
          result,
        });
        // Modele metin gider; arayüze yapılandırılmış nesne (hook üzerinden).
        return JSON.stringify(result, null, 2);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        hooks.onEnd?.({
          id,
          name,
          isError: true,
          durationMs: Date.now() - started,
          summary: `hata: ${message}`,
          result: { error: message },
        });
        throw err;
      }
    },
  });

  return [
    mk("xurrent_whoami", "Authenticated kullanıcıyı, hesabı ve modu döner. Bağlantı smoke test'i.", whoamiInput, () =>
      runWhoami(ctx),
    ),
    mk(
      "xurrent_find_person",
      "Kişiyi birincil e-posta ile bulur. TAM eşleşme yapar (substring değil).",
      findPersonInput,
      (a) => runFindPerson(ctx, a),
    ),
    mk(
      "xurrent_list_open_work",
      "Bir kişinin üzerindeki AÇIK Request ve Task'ları id + açıklama ile listeler.",
      listOpenWorkInput,
      (a) => runListOpenWork(ctx, a),
    ),
    mk(
      "xurrent_get_time_tracking_context",
      "ZAMAN YAZMADAN ÖNCE ZORUNLU: timeIncrement, effort class'lar, timesheet kısıtları.",
      timeTrackingContextInput,
      (a) => runTimeTrackingContext(ctx, a),
    ),
    mk(
      "xurrent_create_time_entry",
      "Tek bir zaman girişi oluşturur. dryRun=true ile hiçbir mutation gönderilmez.",
      createTimeEntryInput,
      (a) => runCreateTimeEntry(ctx, a),
    ),
    mk(
      "xurrent_create_time_entries_bulk",
      "Birden çok zaman girişini sırayla oluşturur. ATOMİK DEĞİLDİR.",
      bulkInput,
      (a) => runBulk(ctx, a),
    ),
    mk(
      "calendar_list_today",
      "Günün takvimini okur, normalize eder, gerçek toplantıları filtreler.",
      calendarInput,
      (a) => runCalendarListToday(ctx, a),
    ),
    mk(
      "plan_time_entries_from_calendar",
      "Takvim + açık işlerden zaman girişi ÖNERİSİ üretir. ASLA YAZMAZ.",
      planInput,
      (a) => runPlanFromCalendar(ctx, a),
    ),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tur yürütme
// ─────────────────────────────────────────────────────────────────────────────

export type ChatMessage = Anthropic.Beta.Messages.BetaMessageParam;

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
  | { type: "done"; stopReason: string | null; messages: ChatMessage[]; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "error"; message: string; code?: string };

export function createAnthropicClient(cfg: AppConfig): Anthropic {
  if (!cfg.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY tanımlı değil. Chatbot için gereklidir. " +
        "(Yalnızca MCP sunucusu olarak kullanacaksanız gerekmez — LLM'i host uygulama sağlar.)",
    );
  }
  return new Anthropic({ apiKey: cfg.anthropicApiKey });
}

/**
 * Tek bir konuşma turu. DURUM TUTMAZ: gelen messages dizisi girdidir, dönen
 * messages dizisi çıktıdır. Web sözleşmesi (clients/web/API.md §2) bunu şart koşuyor
 * ve aynı zamanda doğru tasarım: sohbet durumu sunucunun belleğinde yaşamaz.
 */
export async function runTurn(
  client: Anthropic,
  cfg: AppConfig,
  ctx: ToolContext,
  messages: ChatMessage[],
  onEvent: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<ChatMessage[]> {
  const tools = buildTools(ctx, {
    onStart: (id, name, args) => onEvent({ type: "tool_use", id, name, args }),
    onEnd: (p) => onEvent({ type: "tool_result", ...p }),
  });

  const runner = client.beta.messages.toolRunner({
    model: cfg.anthropicModel,
    // Opus 5'te thinking varsayılan açıktır ve max_tokens thinking + text'i BİRLİKTE
    // sınırlar. Düşük bir değer verilirse model "düşünürken" biter ve boş cevap gelir.
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [...messages],
    tools,
  });

  if (signal) runner.setRequestOptions({ signal });

  try {
    for await (const message of runner) {
      for (const block of message.content) {
        // tool_use bloklarını burada yayınlamıyoruz: hook zaten ARGÜMANLARLA
        // birlikte ve tool_result ile AYNI id üzerinden yayınlıyor.
        if (block.type === "text") onEvent({ type: "text", delta: block.text });
      }
    }
    const final = await runner.done();
    // Runner her turda assistant mesajını ve tool_result mesajını KENDİ listesine
    // ekler. Elle eklemeye kalkarsak tool_use/tool_result çiftleri bozulur ve
    // sonraki turda API 400 döner. Kopyalıyoruz: liste aynı referans olabilir.
    const updated = [...(runner.params.messages as ChatMessage[])];
    onEvent({
      type: "done",
      stopReason: final.stop_reason ?? null,
      messages: updated,
      usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
    });
    return updated;
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

export function createAgent(cfg: AppConfig, ctx: ToolContext): AgentSession {
  const client = createAnthropicClient(cfg);
  let history: ChatMessage[] = [];
  return {
    get history() {
      return history;
    },
    async ask(userText, onEvent, signal) {
      const next: ChatMessage[] = [...history, { role: "user", content: userText }];
      history = await runTurn(client, cfg, ctx, next, onEvent, signal);
    },
  };
}
