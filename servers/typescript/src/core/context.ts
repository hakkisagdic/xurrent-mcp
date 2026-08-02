/**
 * Tool'ların ortak bağlamı.
 *
 * TASARIM KARARI — onay (confirm) bir BAĞIMLILIK olarak enjekte edilir:
 *   - MCP sunucusunda   → protokol seviyesinde elicitation
 *   - Sihirbazda        → terminalde readline sorusu
 *   - Chatbot'ta        → terminalde readline sorusu
 * Böylece "yazmadan önce onay al" kuralı tek bir yerde yaşar ve taşıyıcıya
 * (transport) göre değişmez. Onayı LLM'e bırakmıyoruz: LLM ikna edilebilir,
 * protokol seviyesindeki onay edilemez.
 */

import type { AppConfig } from "../config.js";
import type { TimeTrackingContext } from "../types.js";
import type { XurrentAdapter } from "../xurrent/index.js";

export interface ConfirmRequest {
  /** Kullanıcıya gösterilecek Türkçe özet. */
  summary: string;
  /** Onay diyaloğunda gösterilecek ek alanlar (dakika, tarih, hedef...). */
  fields: Record<string, string | number | boolean>;
}

export type ConfirmOutcome =
  | { action: "accept" }
  | { action: "decline"; reason?: string }
  | { action: "cancel" }
  /** Client elicitation desteklemiyor — politika devreye girer. */
  | { action: "unsupported" };

export type ConfirmFn = (req: ConfirmRequest) => Promise<ConfirmOutcome>;

export interface ToolContext {
  cfg: AppConfig;
  xurrent: XurrentAdapter;
  confirm: ConfirmFn;
  /** Session içi timesheet cache — sözleşme bunu açıkça istiyor. */
  timesheet?: TimeTrackingContext | null;
}

export function createToolContext(
  cfg: AppConfig,
  xurrent: XurrentAdapter,
  confirm: ConfirmFn,
): ToolContext {
  return { cfg, xurrent, confirm, timesheet: null };
}

/** timeIncrement bilinmeden yazma yapılamaz → her yazma yolunda bu çağrılır. */
export async function getTimesheet(ctx: ToolContext, personId: string, signal?: AbortSignal): Promise<TimeTrackingContext> {
  if (ctx.timesheet) return ctx.timesheet;
  const ts = await ctx.xurrent.getTimeTrackingContext(personId, signal);
  ctx.timesheet = ts;
  return ts;
}

/**
 * K5 — ONAY SORULACAK MI?
 *
 * Bu, "kullanıcıya soru sorulsun mu" kararıdır; "soru sorulamıyorsa ne olur"
 * kararı bir alttaki resolveUnsupportedConfirm'dedir. İkisi birlikte
 * XURRENT_CONFIRM_POLICY'nin ÜÇ değerini tanımlar (üç dilde de aynı):
 *
 *   dryRun=true / XURRENT_DRY_RUN=1  → ASLA sorulmaz. Hiçbir mutation gitmiyor,
 *                                      onay istemek güvenlik değil gürültüdür.
 *   XURRENT_CONFIRM_POLICY=open      → ASLA sorulmaz. YALNIZCA CI/otomasyon.
 *   XURRENT_CONFIRM_POLICY=closed    → VARSAYILAN. Sorulur; kanal yoksa politika devreye girer.
 *   XURRENT_CONFIRM_POLICY=strict    → Sorulur ve onay ZORUNLUDUR; kanal yoksa
 *                                      mock modda BİLE yazılmaz.
 */
export function requiresConfirmation(cfg: AppConfig, dryRun: boolean): boolean {
  if (dryRun || cfg.forceDryRun) return false;
  if (cfg.confirmPolicy === "open") return false;
  // closed ve strict: onay SORULUR. Aralarındaki fark yalnızca client
  // soramadığında ortaya çıkar — bkz. resolveUnsupportedConfirm.
  return true;
}

/**
 * Client onay soramıyorsa (elicitation yok / MRTR yeteneği bildirilmemiş) politika.
 *
 * ÜÇ DİLDE DE AYNI KURAL (K5):
 *   open           → devam et, uyarı bas (CI/otomasyon)
 *   strict         → REDDET — mock modda bile
 *   mock + closed  → devam et, uyarı bas
 *   live + closed  → REDDET  (varsayılan, güvenli)
 *
 * Mock modda fail-closed davranmanın hiçbir güvenlik karşılığı yoktur: ortada
 * yazılacak gerçek bir system of record YOKTUR, fixtures/ klasörü vardır. Buna
 * karşılık bedeli büyüktür — dersin 11. adımı (gerçek yazma) etkileşimsiz
 * ortamlarda hiç çalışmaz ve üç dil farklı sonuç üretir.
 *
 * "strict" tam da bu gevşemeyi KAPATMAK için vardır: onay akışını mock modda
 * uçtan uca (kanal yoksa reddederek) göstermek isteyen ders/gösterim ayarıdır.
 */
export function resolveUnsupportedConfirm(cfg: AppConfig): { allowed: boolean; message: string } {
  if (cfg.confirmPolicy === "open") {
    return {
      allowed: true,
      message:
        "Client onay (elicitation) desteklemiyor; XURRENT_CONFIRM_POLICY=open olduğu için onaysız devam edildi. Bu ayar yalnızca CI/otomasyon içindir.",
    };
  }
  if (cfg.confirmPolicy === "strict") {
    return {
      allowed: false,
      message:
        "Client onay (elicitation/MRTR) desteklemiyor ve XURRENT_CONFIRM_POLICY=strict. Yazma REDDEDİLDİ — " +
        "strict modda onay MOCK modda da ZORUNLUDUR. Varsayılan 'closed' olsaydı mock modda uyarıyla devam edilirdi.",
    };
  }
  if (cfg.mode === "mock") {
    return {
      allowed: true,
      message:
        "Client protokol seviyesinde onay soramıyor. MOCK modda çalışıldığı için yazma ENGELLENMEDİ — " +
        "fixtures/ klasörüne yazılıyor, gerçek bir kayıt sistemi etkilenmiyor. Live modda bu istek REDDEDİLİRDİ.",
    };
  }
  return {
    allowed: false,
    message:
      "Client onay (elicitation) desteklemiyor ve XURRENT_CONFIRM_POLICY=closed (varsayılan, güvenli). Yazma REDDEDİLDİ. " +
      "Onaysız yazmak için XURRENT_CONFIRM_POLICY=open yapılmalıdır — tavsiye edilmez.",
  };
}
