/**
 * timesheet_wizard sessionState codec'i (contract/wizard.md §4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRE BİÇİMİ (requestState codec'iyle AYNI AİLE ama FARKLI biçim — bkz. aşağı):
 *
 *     base64url(payloadJson) + "." + base64url(HMAC_SHA256(secret, payloadJsonBytes))
 *
 * requestState (core/confirm.ts) "v1.<gövde>.<imza>" üçlüsü kullanır ve MAC'i
 * "v1.<gövde>" STRING'i üzerinde hesaplar. Sözleşme wizard için İKİ parçalı
 * biçimi ve MAC'in HAM PAYLOAD BYTE'LARI üzerinde hesaplanmasını şart koşar.
 * Bu yüzden requestState codec'i DEĞİŞTİRİLMEDİ; küçük, ayrı bir codec yazıldı.
 * Anahtar (XURRENT_STATE_SECRET) İKİSİNDE DE AYNIDIR (confirm.stateKeyFor).
 *
 * ★ NEDEN payload byte'ları: doğrulayan taraf parse etmeden ÖNCE byte'ları
 *   imzalar — kanonikleştirme GEREKMEZ. Bu sayede TS'in ürettiği state Python'a
 *   verilebilir (çapraz-dil devir, senaryo h): Python TS'in JSON byte'larını
 *   olduğu gibi imzalar, kendi JSON üsluibuna çevirmek zorunda kalmaz.
 *
 * ★ Nonce YOK: state her adımda geri döner, tek kullanımlık değildir. write
 *   adımının kendisi confirm/plannedFingerprint korumasındadır.
 *
 * Blob İMZALIDIR, ŞİFRELİ DEĞİLDİR — içine sır konmaz.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { WizardStep } from "../types.js";
import { stateKeyFor } from "./confirm.js";

/** §4'teki payload alanları. data içeriği adım ilerledikçe dolar. */
export interface WizardStateData {
  personId?: string;
  targetType?: string;
  targetId?: string;
  targetLabel?: string;
  minutes?: number;
  date?: string;
  startedAt?: string;
  description?: string;
  strategy?: string;
  /** confirm'de gösterilen planın sha256 kısaltması — write bunu yeniden doğrular. */
  plannedFingerprint?: string;
  /** Takvim dalı: öneriden türetilen taslak kalemler + elenen indeksler. */
  calendarDraft?: {
    date: string;
    entries: Array<{
      targetType: string;
      targetId: string;
      minutes: number;
      startedAt?: string;
      description?: string;
    }>;
  };
}

export interface WizardStatePayload {
  v: 1;
  kind: "wizard";
  step: WizardStep;
  /** Unix saniye — bu andan sonra state geçersizdir (XURRENT_WIZARD_TTL). */
  exp: number;
  data: WizardStateData;
}

export type WizardStateVerify =
  | { ok: true; payload: WizardStatePayload }
  | { ok: false; reason: "missing" | "malformed" | "bad-signature" | "expired" | "bad-payload" };

function mac(cfg: AppConfig, payloadBytes: Buffer): Buffer {
  return createHmac("sha256", stateKeyFor(cfg)).update(payloadBytes).digest();
}

/** İmzalı sessionState üretir. */
export function signWizardState(cfg: AppConfig, step: WizardStep, data: WizardStateData): string {
  const payload: WizardStatePayload = {
    v: 1,
    kind: "wizard",
    step,
    exp: Math.floor(Date.now() / 1000) + cfg.wizardTtlSeconds,
    data,
  };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  return `${bytes.toString("base64url")}.${mac(cfg, bytes).toString("base64url")}`;
}

/**
 * Doğrulama İMZA ÖNCE, ham byte'lar üzerinde yapılır; payload ancak imza
 * geçtikten SONRA parse edilir. FAIL-CLOSED: her şüphe = geçersiz state; çağıran
 * akışı start'tan başlatır ve bunu AÇIKÇA söyler (sessiz sıfırlama YOK).
 */
export function verifyWizardState(cfg: AppConfig, state: unknown): WizardStateVerify {
  if (typeof state !== "string" || state.length === 0) return { ok: false, reason: "missing" };

  const dot = state.lastIndexOf(".");
  if (dot <= 0 || dot === state.length - 1) return { ok: false, reason: "malformed" };

  let payloadBytes: Buffer;
  let givenMac: Buffer;
  try {
    payloadBytes = Buffer.from(state.slice(0, dot), "base64url");
    givenMac = Buffer.from(state.slice(dot + 1), "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // ★ İMZA ÖNCE — ham payload byte'ları üzerinde, parse edilmeden.
  const expected = mac(cfg, payloadBytes);
  // timingSafeEqual uzunluklar farklıysa FIRLATIR — önce uzunluğu kontrol et.
  if (givenMac.length !== expected.length || !timingSafeEqual(givenMac, expected)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: WizardStatePayload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8")) as WizardStatePayload;
  } catch {
    return { ok: false, reason: "bad-payload" };
  }
  if (payload?.v !== 1 || payload?.kind !== "wizard" || typeof payload?.step !== "string") {
    return { ok: false, reason: "bad-payload" };
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "expired" };
  }
  if (payload.data === null || typeof payload.data !== "object") {
    return { ok: false, reason: "bad-payload" };
  }
  return { ok: true, payload };
}

/** Anahtarları özyinelemeli sıralar — JSON.stringify'ın sırası girdiye bağlıdır. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * plannedFingerprint (wizard.md §4): confirm'de gösterilen planın sha256
 * kısaltması. write adımı fingerprint'i AYNI plandan yeniden hesaplar;
 * eşleşmezse yazmaz — state'le oynayıp onaylanandan farklı bir şey yazdırma
 * girişimi böyle kapanır. Kanonik JSON (sıralı anahtarlar, kompakt) üzerinden
 * 16 hex karakter.
 */
export function plannedFingerprintOf(planned: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(planned))).digest("hex").slice(0, 16);
}
