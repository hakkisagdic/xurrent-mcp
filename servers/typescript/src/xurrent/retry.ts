/**
 * ★ GÜVENİLİRLİK KATMANI — retry politikasının TypeScript implementasyonu.
 *
 * TEK KAYNAK: contract/reliability.md. Buradaki her sabit ve her karar o
 * dosyadan gelir; üç dil (TS/Python/C#) aynı politikayı ayrı kütüphanelerle
 * (p-retry / tenacity / Polly) uygular — "dil bir detaydır" tezinin
 * güvenilirlik ayağı budur.
 *
 * NEDEN p-retry'ın kendi backoff'u DEĞİL: p-retry'ın minTimeout/factor/randomize
 * üçlüsü "tam jitter"ı (rastgele(0, tavan)) birebir veremez — randomize çarpanı
 * 1..2 arasıdır, 0'dan başlamaz. Politika kütüphaneye uydurulMAZ: p-retry'a
 * yalnızca deneme sayacı ve iptal yönetimi bırakılır (minTimeout=0), bekleme
 * BURADA hesaplanır ve onFailedAttempt içinde uyunur. Böylece sözleşmedeki
 * formül — wait_k = rastgele(0, min(CAP, BASE·2^(k-1))) — kelimesi kelimesine
 * koddadır.
 *
 * SINIFLANDIRMA (reliability.md §1-2):
 *   429           → kesin-işlenmedi: HER operasyon sınıfı için retry edilir.
 *   5xx/ağ/timeout→ belirsiz: query + idempotent_update retry eder;
 *                   guarded_create ÖNCE dedup geri-okuması yapar (kayıt varsa
 *                   yazma başarı sayılır, yoksa retry); no_retry ASLA retry etmez.
 *   4xx (429 hariç), GraphQL/payload errors → kesin-reddedildi: ASLA retry.
 *   (GraphQL/payload hataları zaten fırlatılmaz, dönüş değerinde taşınır —
 *    bu katmana hiç ulaşmazlar. Yapısal olarak retry edilemezler.)
 */

import pRetry from "p-retry";

// ─────────────────────────────────────────────────────────────────────────────
// Tipler
// ─────────────────────────────────────────────────────────────────────────────

/** Operasyon sınıfları — retry TRANSPORTUN değil OPERASYONUN özelliğidir. */
export type OperationClass = "query" | "guarded_create" | "idempotent_update" | "no_retry";

/** [retry] izindeki reason değerleri — sözleşme yalnızca bu üçünü tanır. */
export type RetryReason = "429" | "5xx" | "network";

export interface RetryPolicy {
  /** Toplam deneme (ilk istek DAHİL). 1 = retry kapalı. */
  maxAttempts: number;
  baseMs: number;
  capMs: number;
}

/**
 * HTTP/ağ katmanının fırlattığı TEK hata tipi.
 *
 * fetch'in ham TypeError'ı BİLEREK sarmalanır: p-retry, ağ-dışı TypeError'ları
 * onFailedAttempt'i hiç çağırmadan fırlatır — sınıflandırma kontrolü bizim
 * elimizden çıkardı. Kendi tipimiz Error'dan türediği için bu tuzağa düşmez.
 */
export class XurrentRequestError extends Error {
  /** HTTP status; ağ hatası/timeout'ta null. */
  readonly status: number | null;
  /** 429 yanıtındaki Retry-After başlığı, milisaniye. Yoksa null. */
  readonly retryAfterMs: number | null;
  readonly kind: "http" | "network" | "timeout";

  constructor(
    message: string,
    opts: { status?: number | null; retryAfterMs?: number | null; kind?: "http" | "network" | "timeout" } = {},
  ) {
    super(message);
    this.name = "XurrentRequestError";
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.kind = opts.kind ?? "http";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sınıflandırma
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hatayı sözleşmedeki üç reason'dan birine indirger; sınıflandırılamıyorsa
 * (4xx = kesin-reddedildi, ya da hiç bizim hatamız değil) null döner → retry YOK.
 *
 * Not — timeout da "network" raporlanır: sözleşme §6 izin verdiği üç değeri
 * sayar ve timeout ayrı bir reason DEĞİLDİR (ikisi de "belirsiz" sınıfıdır).
 */
export function classifyReason(err: unknown): RetryReason | null {
  if (!(err instanceof XurrentRequestError)) return null;
  if (err.kind === "network" || err.kind === "timeout") return "network";
  if (err.status === 429) return "429";
  if (err.status !== null && err.status >= 500) return "5xx";
  return null; // 4xx (429 hariç) → kesin-reddedildi, ASLA retry
}

/** Operasyon sınıfı + reason → retry edilebilir mi? (reliability.md §2 tablosu) */
export function isRetryable(reason: RetryReason, opClass: OperationClass): boolean {
  if (reason === "429") return true; // kesin-işlenmedi: herkes için güvenli
  // belirsiz (5xx/network):
  //   no_retry → ASLA (timeSpent artımlı, tekrar = çift sayım)
  //   guarded_create → retry EDİLİR ama yalnızca dedup geri-okuması "yazılmamış"
  //   dediyse (o kontrol retryingRequest içindeki recoverUncertain kancasında).
  return opClass !== "no_retry";
}

// ─────────────────────────────────────────────────────────────────────────────
// Bekleme hesabı — tam jitter + Retry-After tabanı
// ─────────────────────────────────────────────────────────────────────────────

/**
 * k'ıncı tekrarın beklemesi (k = BAŞARISIZ olan denemenin numarası, 1'den başlar):
 *   jitter = rastgele(0, min(CAP, BASE·2^(k-1)))
 *   Retry-After varsa bekleme EN AZ o kadardır → max(jitter, retryAfter).
 */
export function computeWaitMs(
  attemptNumber: number,
  policy: RetryPolicy,
  retryAfterMs: number | null,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.capMs, policy.baseMs * 2 ** (attemptNumber - 1));
  const jitter = Math.floor(random() * Math.max(0, ceiling));
  // "en az Retry-After" garantisi esastır — jitter'ı Retry-After'ın ÜZERİNE
  // eklemek de sözleşmeye uygundur ama max() hedeflenen davranıştır.
  return retryAfterMs !== null && retryAfterMs > jitter ? retryAfterMs : jitter;
}

// ─────────────────────────────────────────────────────────────────────────────
// stderr izleri — üç dilde BİREBİR AYNI biçim (reliability.md §6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * İzler HER ZAMAN stderr'e yazılır. stdout MCP stdio kanalıdır; oraya yazılan
 * tek bir satır bile JSON-RPC çerçevelemesini bozar. Senaryo koşucusu bu
 * satırları REGEX ile saydığı için biçim serbest DEĞİLDİR.
 */
export function traceRetry(op: string, attempt: number, max: number, reason: RetryReason, waitMs: number): void {
  process.stderr.write(`[retry] op=${op} attempt=${attempt}/${max} reason=${reason} waitMs=${Math.trunc(waitMs)}\n`);
}

export function traceDedup(sourceID: string, hit: boolean): void {
  // op sabittir: dedup YALNIZCA timeEntryCreate (Yol A) için mümkündür —
  // sourceID başka hiçbir mutation'da yazılamaz.
  process.stderr.write(`[dedup] op=timeEntryCreate sourceID=${sourceID} hit=${hit}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bekleme — iptal edilebilir uyku
// ─────────────────────────────────────────────────────────────────────────────

/** İptal (AbortSignal) beklemeyi ANINDA keser (reliability.md §3 son madde). */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("İstek iptal edildi."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("İstek iptal edildi."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// retryingRequest — politikanın tamamı tek fonksiyonda
// ─────────────────────────────────────────────────────────────────────────────

export interface RetryingRequestOptions<T> {
  /** [retry] izindeki op alanı: mutation path'i ("timeEntryCreate") ya da "query". */
  label: string;
  opClass: OperationClass;
  policy: RetryPolicy;
  /** Tek bir HTTP denemesi. Başarısızlıkta XurrentRequestError FIRLATMALIDIR. */
  attempt: () => Promise<T>;
  /**
   * YALNIZCA guarded_create: belirsiz hatada (5xx/ağ) çağrılır — dedup
   * geri-okuması. Kayıt bulunduysa sentezlenmiş başarı değeri, bulunamadıysa
   * null döner (retry devam eder). [dedup] izini kancanın kendisi basar.
   */
  recoverUncertain?: (() => Promise<T | null>) | undefined;
  signal?: AbortSignal | undefined;
  /** Test kancaları — üretimde verilmez. */
  random?: () => number;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export async function retryingRequest<T>(opts: RetryingRequestOptions<T>): Promise<T> {
  const { label, opClass, policy, attempt, recoverUncertain, signal } = opts;
  const random = opts.random ?? Math.random;
  const sleepFn = opts.sleepFn ?? abortableSleep;

  return pRetry(
    async () => {
      try {
        return await attempt();
      } catch (err) {
        // guarded_create + belirsiz hata → KÖR RETRY YASAK. Önce "yazılmış mı?"
        // sorusu cevaplanır: deterministik sourceID ile geri-okuma. Kayıt varsa
        // ilk deneme aslında BAŞARILIYDI (yanıt yolda kayboldu) — mevcut kayıt
        // başarı olarak döndürülür ve İKİNCİ bir POST hiç atılmaz.
        const reason = classifyReason(err);
        const uncertain = reason === "5xx" || reason === "network";
        if (opClass === "guarded_create" && uncertain && recoverUncertain) {
          const recovered = await recoverUncertain();
          if (recovered !== null) return recovered;
        }
        throw err;
      }
    },
    {
      retries: Math.max(0, policy.maxAttempts - 1),
      // Bekleme p-retry'a BIRAKILMAZ (dosya başındaki gerekçe): kendi süresi 0.
      minTimeout: 0,
      maxTimeout: 0,
      factor: 1,
      randomize: false,
      ...(signal ? { signal } : {}),
      onFailedAttempt: async ({ error, attemptNumber, retriesLeft }) => {
        const reason = classifyReason(error);
        // kesin-reddedildi (4xx, sınıflandırılamayan) → retry YOK, orijinal hata.
        if (reason === null) throw error;
        // no_retry + belirsiz → ASLA otomatik retry (çift sayım riski).
        if (!isRetryable(reason, opClass)) throw error;
        // Son deneme de düştü → iz YOK (bekleme olmayacak), p-retry hatayı fırlatır.
        if (retriesLeft <= 0) return;

        const retryAfterMs = error instanceof XurrentRequestError ? error.retryAfterMs : null;
        const waitMs = computeWaitMs(attemptNumber, policy, retryAfterMs, random);
        traceRetry(label, attemptNumber, policy.maxAttempts, reason, waitMs);
        await sleepFn(waitMs, signal);
      },
    },
  );
}
