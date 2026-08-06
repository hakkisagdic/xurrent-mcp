/**
 * timesheet_wizard sessionState codec'i (contract/wizard.md §4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WIRE BİÇİMİ (artık requestState ile BİREBİR AYNI zarf — confirm.ts'teki
 * encodeSignedState/decodeSignedState ortak yardımcıları kullanılır):
 *
 *     base64url(payloadJson) + "." + base64url(HMAC_SHA256(secret, payloadJsonBytes))
 *
 * Bu zarf çapraz-dil taşınabilirliğini İLK burada kanıtladı; paralel konteyner
 * ölçümü requestState'in eski "v1.<gövde>.<imza>" üçlüsünün diller arasında
 * doğrulanamadığını gösterince requestState de BU zarfa taşındı. Sabit
 * vektörler: fixtures/state-vektorleri.json. Anahtar (XURRENT_STATE_SECRET)
 * ikisinde de AYNIDIR (confirm.stateKeyFor).
 *
 * ★ NEDEN payload byte'ları: doğrulayan taraf parse etmeden ÖNCE byte'ları
 *   imzalar — kanonikleştirme GEREKMEZ. Bu sayede TS'in ürettiği state Python'a
 *   verilebilir (çapraz-dil devir, senaryo h): Python TS'in JSON byte'larını
 *   olduğu gibi imzalar, kendi JSON üslubuna çevirmek zorunda kalmaz.
 *
 * ★ Nonce YOK: state her adımda geri döner, tek kullanımlık değildir. write
 *   adımının kendisi confirm/plannedFingerprint korumasındadır.
 *
 * Blob İMZALIDIR, ŞİFRELİ DEĞİLDİR — içine sır konmaz.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { WizardStep } from "../types.js";
import { decodeSignedState, encodeSignedState, stateKeyFor } from "./confirm.js";

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

/** İmzalı sessionState üretir (ortak zarf: confirm.encodeSignedState). */
export function signWizardState(cfg: AppConfig, step: WizardStep, data: WizardStateData): string {
  const payload: WizardStatePayload = {
    v: 1,
    kind: "wizard",
    step,
    exp: Math.floor(Date.now() / 1000) + cfg.wizardTtlSeconds,
    data,
  };
  return encodeSignedState(stateKeyFor(cfg), JSON.stringify(payload));
}

/**
 * Doğrulama İMZA ÖNCE, ham byte'lar üzerinde yapılır (decodeSignedState);
 * payload ancak imza geçtikten SONRA parse edilir. FAIL-CLOSED: her şüphe =
 * geçersiz state; çağıran akışı start'tan başlatır ve bunu AÇIKÇA söyler
 * (sessiz sıfırlama YOK).
 */
export function verifyWizardState(cfg: AppConfig, state: unknown): WizardStateVerify {
  if (typeof state !== "string" || state.length === 0) return { ok: false, reason: "missing" };

  const decoded = decodeSignedState(stateKeyFor(cfg), state);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };

  let payload: WizardStatePayload;
  try {
    payload = JSON.parse(decoded.payloadJson) as WizardStatePayload;
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
