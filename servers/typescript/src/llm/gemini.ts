/**
 * Gemini sağlayıcısı — SDK YOK, düz `fetch`.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * TASARIM KARARI: resmi SDK kurulmadı. İki gerekçe:
 *
 *   1) Bağımlılık azlığı. Bu repo bilinçli olarak bağımlılık-fakiri; tek bir
 *      HTTP POST için bir SDK ağacı taşımak bedava değildir.
 *   2) Ders. Wire formatı GÖRÜNÜR olmalı. `contents` / `parts` / `functionCall`
 *      / `functionResponse` alanlarını bir SDK'nın arkasına saklarsak, "iki
 *      sağlayıcı, iki tool-calling lehçesi" tezi kanıtlanamaz.
 *
 * UÇ NOKTA
 *   POST {BASE}/v1beta/models/{model}:generateContent
 *   BASE varsayılan https://generativelanguage.googleapis.com
 *   GEMINI_BASE_URL ile değiştirilebilir (sahte sunucuya yönlendirmek için).
 *
 * ★ KİMLİK DOĞRULAMA: anahtar `x-goog-api-key` HEADER'ında gider.
 *   URL query parametresine ASLA konmaz — query string ters vekil, tarayıcı
 *   geçmişi ve sunucu erişim loglarına düz metin olarak düşer.
 *
 * ★ HATA: HTTP 200 gelse bile gövdede `error` alanı olabilir. İKİSİ DE kontrol
 *   edilir; yalnızca `res.ok` bakmak sessizce boş cevap üretir.
 */

import type { AppConfig } from "../config.js";
import type { GeminiSchema } from "./schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Wire tipleri — Gemini generateContent
// ─────────────────────────────────────────────────────────────────────────────

export interface GeminiFunctionCall {
  /** ★ functionResponse'ta AYNISI geri gönderilmek zorundadır. */
  id?: string;
  name: string;
  args?: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  /** ★ functionCall.id ile BİREBİR aynı olmalı; yoksa API çağrıyı sonuca eşleyemez. */
  id?: string;
  name: string;
  /** OBJE olmak ZORUNDA — düz string kabul edilmez. */
  response: Record<string, unknown>;
}

export interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  /** Gemini düşünme özetleri; okunur ama yeniden gönderilirken korunur. */
  thought?: boolean;
  thoughtSignature?: string;
}

/** ★ Rol yalnızca "user" veya "model" olabilir. "system" rolü YOKTUR. */
export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  /** MCP inputSchema'nın Gemini lehçesine çevrilmiş hâli (bkz. llm/schema.ts). */
  parameters?: GeminiSchema;
}

export interface GeminiRequest {
  contents: GeminiContent[];
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[];
  /** ★ Sistem mesajı contents içine KONMAZ; ayrı alandadır. */
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
    topP?: number;
    candidateCount?: number;
  };
}

export interface GeminiCandidate {
  content?: GeminiContent;
  finishReason?: string;
  index?: number;
}

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

export interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: GeminiUsage;
  modelVersion?: string;
  /** HTTP 200 ile birlikte de gelebilir. */
  error?: { code?: number; message?: string; status?: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hata
// ─────────────────────────────────────────────────────────────────────────────

export class GeminiError extends Error {
  readonly httpStatus: number | null;
  readonly apiStatus: string | null;

  constructor(message: string, httpStatus: number | null = null, apiStatus: string | null = null) {
    super(message);
    this.name = "GeminiError";
    this.httpStatus = httpStatus;
    this.apiStatus = apiStatus;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// İstemci
// ─────────────────────────────────────────────────────────────────────────────

export interface GeminiClient {
  readonly model: string;
  readonly baseUrl: string;
  generateContent(request: GeminiRequest, signal?: AbortSignal): Promise<GeminiResponse>;
}

export function createGeminiClient(cfg: AppConfig): GeminiClient {
  if (!cfg.geminiApiKey) {
    throw new Error(
      "GEMINI_API_KEY tanımlı değil. Chatbot için gereklidir. " +
        "(Yalnızca MCP sunucusu olarak kullanacaksanız gerekmez — LLM'i host uygulama sağlar.) " +
        "Anahtarsız uçtan uca deneme için: tools/fake-gemini/server.mjs + GEMINI_BASE_URL.",
    );
  }

  const baseUrl = cfg.geminiBaseUrl.replace(/\/+$/, "");
  const model = cfg.geminiModel;
  const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  return {
    model,
    baseUrl,
    async generateContent(request, signal) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // ★ Anahtar HEADER'da. Query parametresine konursa log'a düşer.
            "x-goog-api-key": cfg.geminiApiKey,
          },
          body: JSON.stringify(request),
          signal: signal ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new GeminiError(`Gemini'ye bağlanılamadı (${url}): ${message}`);
      }

      const raw = await res.text();
      let body: GeminiResponse;
      try {
        body = raw ? (JSON.parse(raw) as GeminiResponse) : {};
      } catch {
        throw new GeminiError(
          `Gemini yanıtı geçerli JSON değil (HTTP ${res.status}): ${raw.slice(0, 200)}`,
          res.status,
        );
      }

      // ★ İKİ KONTROL BİRDEN: HTTP durumu VE gövdedeki error alanı.
      if (!res.ok || body.error) {
        const apiMessage = body.error?.message ?? raw.slice(0, 200) ?? "(gövde boş)";
        throw new GeminiError(
          `Gemini hatası (HTTP ${res.status}${body.error?.status ? `, ${body.error.status}` : ""}): ${apiMessage}`,
          res.status,
          body.error?.status ?? null,
        );
      }

      return body;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Küçük yardımcılar
// ─────────────────────────────────────────────────────────────────────────────

/** İlk adaydaki part'lar. Aday yoksa boş dizi — çağıran tarafta "cevap gelmedi" olarak görünür. */
export function candidateParts(res: GeminiResponse): GeminiPart[] {
  return res.candidates?.[0]?.content?.parts ?? [];
}

/** Part'lardaki tool çağrıları. */
export function functionCalls(parts: GeminiPart[]): GeminiFunctionCall[] {
  return parts.map((p) => p.functionCall).filter((c): c is GeminiFunctionCall => Boolean(c && c.name));
}

/** Part'lardaki düz metin. `thought` işaretli part'lar KULLANICIYA GÖSTERİLMEZ. */
export function plainText(parts: GeminiPart[]): string {
  return parts
    .filter((p) => typeof p.text === "string" && p.thought !== true)
    .map((p) => p.text as string)
    .join("");
}
