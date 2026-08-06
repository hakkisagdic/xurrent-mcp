/**
 * ★ RETRY POLİTİKASININ BİRİM TESTİ — contract/reliability.md'nin kanıtı.
 *
 * NE KANITLIYOR: retry kararı TRANSPORTUN değil OPERASYONUN özelliğidir.
 * Aynı 500 hatası timeEntryUpdate'te retry edilir, requestUpdate'te ASLA;
 * 429 ise HERKES için güvenle tekrarlanır. Senaryo koşucusu (f)(g) bunu uçtan
 * uca gösterir; burada aynı politika AĞSIZ, milisaniyesiz ve deterministik
 * olarak ölçülür — jitter'a sahte random, uykuya sahte sleep enjekte edilir.
 *
 * Çalıştırma: npm run build && npm test (derlenmiş dist/ okunur).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  XurrentRequestError,
  classifyReason,
  computeWaitMs,
  isRetryable,
  retryingRequest,
  traceDedup,
  traceRetry,
} from "../../dist/xurrent/retry.js";

// ── stderr yakalayıcı ────────────────────────────────────────────────────────
// İzler process.stderr'e yazılır (stdout MCP kanalıdır); testte geçici olarak
// araya girip satırları toplarız.
function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  const restore = () => {
    process.stderr.write = orig;
  };
  return Promise.resolve()
    .then(fn)
    .then(
      (v) => {
        restore();
        return { value: v, lines };
      },
      (e) => {
        restore();
        return { error: e, lines };
      },
    );
}

const err429 = (retryAfterMs = null) =>
  new XurrentRequestError("HTTP 429", { status: 429, retryAfterMs, kind: "http" });
const err500 = () => new XurrentRequestError("HTTP 500", { status: 500, kind: "http" });
const err422 = () => new XurrentRequestError("HTTP 422", { status: 422, kind: "http" });
const errNet = () => new XurrentRequestError("fetch failed", { kind: "network" });
const errTimeout = () => new XurrentRequestError("zaman aşımı", { kind: "timeout" });

const POLICY = { maxAttempts: 5, baseMs: 500, capMs: 8000 };
const noSleep = async () => {};

// ─────────────────────────────────────────────────────────────────────────────
// Sınıflandırma (reliability.md §1)
// ─────────────────────────────────────────────────────────────────────────────

test("classifyReason: 429 → '429' (kesin-işlenmedi)", () => {
  assert.equal(classifyReason(err429()), "429");
});

test("classifyReason: 5xx → '5xx' (belirsiz)", () => {
  assert.equal(classifyReason(err500()), "5xx");
  assert.equal(classifyReason(new XurrentRequestError("x", { status: 503 })), "5xx");
});

test("classifyReason: ağ hatası ve timeout AYNI reason'a düşer — 'network'", () => {
  assert.equal(classifyReason(errNet()), "network");
  assert.equal(classifyReason(errTimeout()), "network");
});

test("classifyReason: 4xx (429 hariç) sınıflandırılMAZ → retry yok", () => {
  assert.equal(classifyReason(err422()), null);
  assert.equal(classifyReason(new XurrentRequestError("x", { status: 401 })), null);
});

test("classifyReason: yabancı hatalar (iptal dahil) retry edilemez", () => {
  assert.equal(classifyReason(new Error("her şey olabilir")), null);
  assert.equal(classifyReason(undefined), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Sınıf tablosu (reliability.md §2)
// ─────────────────────────────────────────────────────────────────────────────

test("★ 429 DÖRT operasyon sınıfında da retry edilebilir — parent update'ler DAHİL", () => {
  for (const cls of ["query", "guarded_create", "idempotent_update", "no_retry"]) {
    assert.equal(isRetryable("429", cls), true, `429 ${cls} için güvenli olmalı`);
  }
});

test("★ belirsiz (5xx/network) no_retry sınıfında ASLA retry edilmez", () => {
  assert.equal(isRetryable("5xx", "no_retry"), false);
  assert.equal(isRetryable("network", "no_retry"), false);
});

test("belirsiz hata query/guarded_create/idempotent_update için retry edilebilir", () => {
  for (const cls of ["query", "guarded_create", "idempotent_update"]) {
    assert.equal(isRetryable("5xx", cls), true);
    assert.equal(isRetryable("network", cls), true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bekleme formülü: wait_k = rastgele(0, min(CAP, BASE·2^(k-1))) (§3)
// ─────────────────────────────────────────────────────────────────────────────

test("computeWaitMs: tavan üstel büyür ve CAP'te kırpılır", () => {
  const p = { maxAttempts: 9, baseMs: 500, capMs: 8000 };
  const birim = (k) => computeWaitMs(k, p, null, () => 0.999999);
  // k=1 → tavan 500, k=2 → 1000, k=3 → 2000, k=4 → 4000, k=5+ → 8000 (CAP)
  assert.ok(birim(1) < 500);
  assert.ok(birim(2) < 1000 && birim(2) >= 500);
  assert.ok(birim(5) < 8000 && birim(5) >= 4000);
  assert.ok(birim(8) < 8000, "CAP aşılamaz");
});

test("computeWaitMs: TAM jitter — random=0 iken bekleme 0'dır (0'dan başlar, 1x'ten değil)", () => {
  assert.equal(computeWaitMs(3, POLICY, null, () => 0), 0);
});

test("★ Retry-After bekleme TABANIDIR: jitter küçükse Retry-After kazanır", () => {
  // jitter 0 (random=0) ama Retry-After 1000 ms → bekleme EN AZ 1000 olmalı.
  assert.equal(computeWaitMs(1, POLICY, 1000, () => 0), 1000);
  // jitter Retry-After'dan büyükse jitter kalır (max davranışı).
  const w = computeWaitMs(5, POLICY, 1000, () => 0.9);
  assert.ok(w >= 1000 && w > 1000 - 1, `w=${w} en az Retry-After olmalı`);
  assert.equal(w, Math.floor(0.9 * 8000));
});

// ─────────────────────────────────────────────────────────────────────────────
// retryingRequest — deneme sayacı ve iz biçimi
// ─────────────────────────────────────────────────────────────────────────────

const RETRY_RE = /^\[retry\] op=[A-Za-z]+ attempt=\d+\/\d+ reason=(429|5xx|network) waitMs=\d+\n$/;
const DEDUP_RE = /^\[dedup\] op=timeEntryCreate sourceID=\S+ hit=(true|false)\n$/;

test("★ iz biçimi sözleşmeyle BİREBİR aynı — senaryo koşucusu bu satırları regex'le sayar", async () => {
  const { lines } = await captureStderr(() => {
    traceRetry("timeEntryCreate", 2, 5, "429", 1234);
    traceDedup("xmcp-abcdef0123456789", true);
    traceDedup("xmcp-abcdef0123456789", false);
  });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "[retry] op=timeEntryCreate attempt=2/5 reason=429 waitMs=1234\n");
  assert.match(lines[0], RETRY_RE);
  assert.match(lines[1], DEDUP_RE);
  assert.match(lines[2], DEDUP_RE);
  assert.equal(lines[1], "[dedup] op=timeEntryCreate sourceID=xmcp-abcdef0123456789 hit=true\n");
});

test("429 fırtınası: query 3 kez düşüp 4.'de geçer; iz sayısı 3, attempt'ler 1/5 2/5 3/5", async () => {
  let calls = 0;
  const { value, lines } = await captureStderr(() =>
    retryingRequest({
      label: "query",
      opClass: "query",
      policy: POLICY,
      attempt: async () => {
        calls++;
        if (calls <= 3) throw err429();
        return "tamam";
      },
      random: () => 0,
      sleepFn: noSleep,
    }),
  );
  assert.equal(value, "tamam");
  assert.equal(calls, 4);
  const izler = lines.filter((l) => l.startsWith("[retry]"));
  assert.equal(izler.length, 3);
  assert.equal(izler[0], "[retry] op=query attempt=1/5 reason=429 waitMs=0\n");
  assert.equal(izler[2], "[retry] op=query attempt=3/5 reason=429 waitMs=0\n");
});

test("★ XURRENT_RETRY_MAX_ATTEMPTS=1 retry'ı KAPATIR: tek deneme, iz yok", async () => {
  let calls = 0;
  const { error, lines } = await captureStderr(() =>
    retryingRequest({
      label: "query",
      opClass: "query",
      policy: { maxAttempts: 1, baseMs: 500, capMs: 8000 },
      attempt: async () => {
        calls++;
        throw err429();
      },
      sleepFn: noSleep,
    }),
  );
  assert.equal(calls, 1);
  assert.ok(error instanceof XurrentRequestError);
  assert.equal(lines.filter((l) => l.startsWith("[retry]")).length, 0, "bekleme olmayacak → iz olmamalı");
});

test("★ no_retry sınıfı: 429'da retry EDER, 500'de tek denemede bırakır", async () => {
  // 429 → parent update bile tekrarlanır (istek hiç işlenmedi).
  let calls429 = 0;
  const a = await captureStderr(() =>
    retryingRequest({
      label: "requestUpdate",
      opClass: "no_retry",
      policy: POLICY,
      attempt: async () => {
        calls429++;
        if (calls429 === 1) throw err429();
        return "yazildi";
      },
      random: () => 0,
      sleepFn: noSleep,
    }),
  );
  assert.equal(a.value, "yazildi");
  assert.equal(calls429, 2);
  assert.match(a.lines[0], /reason=429/);

  // 500 → belirsiz: ASLA otomatik retry (çift sayım riski). Tek çağrı, iz yok.
  let calls500 = 0;
  const b = await captureStderr(() =>
    retryingRequest({
      label: "requestUpdate",
      opClass: "no_retry",
      policy: POLICY,
      attempt: async () => {
        calls500++;
        throw err500();
      },
      sleepFn: noSleep,
    }),
  );
  assert.equal(calls500, 1);
  assert.ok(b.error instanceof XurrentRequestError);
  assert.equal(b.lines.filter((l) => l.startsWith("[retry]")).length, 0);
});

test("4xx (kesin-reddedildi) HİÇBİR sınıfta retry edilmez", async () => {
  for (const cls of ["query", "guarded_create", "idempotent_update", "no_retry"]) {
    let calls = 0;
    const { error } = await captureStderr(() =>
      retryingRequest({
        label: "query",
        opClass: cls,
        policy: POLICY,
        attempt: async () => {
          calls++;
          throw err422();
        },
        sleepFn: noSleep,
      }),
    );
    assert.equal(calls, 1, `${cls}: 422 tek denemede bırakılmalı`);
    assert.ok(error instanceof XurrentRequestError);
  }
});

test("Retry-After sleepFn'e GERÇEKTEN taşınır: bekleme en az başlıktaki kadar", async () => {
  let calls = 0;
  const uykular = [];
  await captureStderr(() =>
    retryingRequest({
      label: "query",
      opClass: "query",
      policy: POLICY,
      attempt: async () => {
        calls++;
        if (calls === 1) throw err429(2000); // Retry-After: 2 sn
        return "ok";
      },
      random: () => 0, // jitter 0 → bekleme tamamen Retry-After'dan gelmeli
      sleepFn: async (ms) => {
        uykular.push(ms);
      },
    }),
  );
  assert.deepEqual(uykular, [2000]);
});

test("★ guarded_create + 5xx: dedup kancası kayıt BULURSA retry İPTAL, ikinci deneme YOK", async () => {
  let attempts = 0;
  let recovers = 0;
  const mevcut = { id: "TE-1", sourceID: "xmcp-var" };
  const { value, lines } = await captureStderr(() =>
    retryingRequest({
      label: "timeEntryCreate",
      opClass: "guarded_create",
      policy: POLICY,
      attempt: async () => {
        attempts++;
        throw err500();
      },
      recoverUncertain: async () => {
        recovers++;
        return mevcut; // geri-okuma kaydı buldu → ilk POST aslında ulaşmıştı
      },
      sleepFn: noSleep,
    }),
  );
  assert.equal(value, mevcut);
  assert.equal(attempts, 1, "ikinci POST ATILMAMALI — çift kayıt tam böyle oluşurdu");
  assert.equal(recovers, 1);
  assert.equal(lines.filter((l) => l.startsWith("[retry]")).length, 0, "kurtarıldı → retry izi olmamalı");
});

test("guarded_create + 5xx: dedup kancası kayıt BULAMAZSA retry devam eder", async () => {
  let attempts = 0;
  let recovers = 0;
  const { value, lines } = await captureStderr(() =>
    retryingRequest({
      label: "timeEntryCreate",
      opClass: "guarded_create",
      policy: POLICY,
      attempt: async () => {
        attempts++;
        if (attempts === 1) throw err500();
        return "yeni-kayit";
      },
      recoverUncertain: async () => {
        recovers++;
        return null; // yazılmamış → retry güvenli
      },
      random: () => 0,
      sleepFn: noSleep,
    }),
  );
  assert.equal(value, "yeni-kayit");
  assert.equal(attempts, 2);
  assert.equal(recovers, 1);
  const izler = lines.filter((l) => l.startsWith("[retry]"));
  assert.equal(izler.length, 1);
  assert.match(izler[0], /op=timeEntryCreate attempt=1\/5 reason=5xx/);
});

test("guarded_create + 429: dedup kancası HİÇ çağrılmaz (istek işlenmedi — kayıt olamaz)", async () => {
  let attempts = 0;
  let recovers = 0;
  await captureStderr(() =>
    retryingRequest({
      label: "timeEntryCreate",
      opClass: "guarded_create",
      policy: POLICY,
      attempt: async () => {
        attempts++;
        if (attempts === 1) throw err429();
        return "ok";
      },
      recoverUncertain: async () => {
        recovers++;
        return null;
      },
      random: () => 0,
      sleepFn: noSleep,
    }),
  );
  assert.equal(attempts, 2);
  assert.equal(recovers, 0, "429 kesin-işlenmedi'dir; geri-okuma İSRAFTIR");
});

test("deneme bütçesi tükenince son hata fırlar: 5 deneme, 4 iz", async () => {
  let calls = 0;
  const { error, lines } = await captureStderr(() =>
    retryingRequest({
      label: "query",
      opClass: "query",
      policy: POLICY,
      attempt: async () => {
        calls++;
        throw errNet();
      },
      random: () => 0,
      sleepFn: noSleep,
    }),
  );
  assert.equal(calls, 5, "toplam deneme = maxAttempts (ilk istek dahil)");
  assert.ok(error instanceof XurrentRequestError);
  const izler = lines.filter((l) => l.startsWith("[retry]"));
  assert.equal(izler.length, 4, "son başarısızlıkta bekleme yok → iz de yok");
  assert.match(izler[3], /attempt=4\/5 reason=network/);
});
