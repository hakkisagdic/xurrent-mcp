#!/usr/bin/env node
// -----------------------------------------------------------------------------
// google-auth.mjs — TEK SEFERLİK Google Calendar yetkilendirmesi
//
// NEDEN bu script var:
//   Google OAuth akışı (tarayıcı açma, loopback dinleme, PKCE, kod takası) her
//   dilde ayrı ayrı yazılırsa ÜÇ KEZ yazılmış ve üç kez hata yapılmış olur.
//   Bunun yerine akış BİR KEZ burada çalışır, refresh_token diske yazılır ve
//   TypeScript/Python/C# sunucuları o dosyayı okuyup token'ı DÜZ BİR HTTP POST
//   ile yeniler. Böylece üç dilde de OAuth kütüphanesi GEREKMEZ.
//
//   Dosya şeması scripts/README.md içinde belgelenmiştir — üç implementasyon da
//   oradaki şemaya göre okur.
//
// Kapsam (scope): calendar.events.readonly — SADECE okuma. Bilinçli olarak
//   dar tutulmuştur; bu araç takvime hiçbir şey yazmaz.
//
// Kullanım:
//   node scripts/google-auth.mjs [--print-url] [--calendar-id <id>] [--force]
// -----------------------------------------------------------------------------

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const TOKEN_FILE_VERSION = 1;

// ── Argümanlar ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(name + "="));
  return inline ? inline.slice(name.length + 1) : fallback;
}

// ── Renk / çıktı ─────────────────────────────────────────────────────────────
const COLOR = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code, s) => (COLOR ? `[${code}m${s}[0m` : String(s));
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const say = (s = "") => process.stdout.write(s + "\n");

if (has("--help") || has("-h")) {
  say(
    [
      "",
      bold("google-auth.mjs") + dim(" — tek seferlik Google Calendar yetkilendirmesi"),
      "",
      bold("KULLANIM"),
      "  node scripts/google-auth.mjs [seçenekler]",
      "",
      bold("SEÇENEKLER"),
      "  --print-url          Tarayıcıyı açmaz, URL'yi ekrana basar (uzak/SSH oturumları için)",
      "  --calendar-id <id>   Token dosyasına yazılacak takvim kimliği (varsayılan: primary)",
      "  --out <yol>          Token dosyası yolu (varsayılan: GOOGLE_TOKEN_PATH veya ~/.xurrent-mcp/google-token.json)",
      "  --force              Mevcut token dosyasının üzerine sormadan yazar",
      "  --no-verify          Sonunda takvim okuma testini atlar",
      "",
      bold("NE ZAMAN ÇALIŞTIRILIR"),
      "  CALENDAR_PROVIDER=google kullanılacaksa BİR KEZ. Refresh token süresiz geçerlidir",
      "  (kullanıcı erişimi iptal etmedikçe veya uygulama 'Testing' modunda 7 gün geçmedikçe).",
      "",
      bold("KAPSAM"),
      `  ${SCOPE}`,
      "  Yalnızca OKUMA. Bu araç takvime hiçbir şey yazmaz.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

// ── .env yükleyici (gerçek ortam değişkenlerini EZMEZ) ──────────────────────
function loadDotEnv(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[line.slice(0, eq).trim()] = v;
  }
  return env;
}
const dotenv = loadDotEnv(path.join(ROOT, ".env"));
const cfg = (k, d = "") => process.env[k] || dotenv[k] || d;

const CLIENT_ID = cfg("GOOGLE_CLIENT_ID");
const CLIENT_SECRET = cfg("GOOGLE_CLIENT_SECRET");
const CALENDAR_ID = opt("--calendar-id", cfg("GOOGLE_CALENDAR_ID", "primary"));

function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
const TOKEN_PATH = path.resolve(
  expandHome(opt("--out", cfg("GOOGLE_TOKEN_PATH", "~/.xurrent-mcp/google-token.json"))),
);

// ── Kimlik bilgisi yoksa: NET ve ADIM ADIM Türkçe yönlendirme ───────────────
if (!CLIENT_ID || !CLIENT_SECRET) {
  say("");
  say(red(bold("  GOOGLE_CLIENT_ID ve/veya GOOGLE_CLIENT_SECRET tanımlı değil.")));
  say("");
  say(dim("  Aranan yerler:"));
  say(dim(`    • ortam değişkenleri`));
  say(dim(`    • ${path.join(ROOT, ".env")}`));
  say("");
  say(bold("  NASIL ALINIR — 8 adım (ücretsiz, ~5 dakika)"));
  say("");
  const steps = [
    ["1", "Google Cloud Console'a git:  https://console.cloud.google.com/"],
    ["2", "Üstteki proje seçiciden YENİ PROJE oluştur (örn. \"xurrent-mcp\")."],
    [
      "3",
      "Sol menü → \"APIs & Services\" → \"Library\" → \"Google Calendar API\" ara ve ENABLE de. " +
        "Bu adım atlanırsa token alınır ama her istek 403 döner.",
    ],
    [
      "4",
      "\"APIs & Services\" → \"OAuth consent screen\":\n" +
        "     • User type: kişisel Gmail için \"External\", Workspace için \"Internal\"\n" +
        "     • Uygulama adı ve destek e-postasını doldur\n" +
        "     • Scopes adımında bir şey EKLEME (bu script kapsamı kendisi ister)",
    ],
    [
      "5",
      "\"External\" seçtiysen \"Test users\" bölümüne KENDİ Gmail adresini ekle.\n" +
        "     Eklemezsen giriş sırasında \"access_denied\" alırsın.",
    ],
    [
      "6",
      "\"Credentials\" → \"Create Credentials\" → \"OAuth client ID\"\n" +
        "     • Application type: " +
        bold("Desktop app") +
        "   ← ÖNEMLİ\n" +
        "     Neden: Desktop app tipinde loopback (http://127.0.0.1:<rastgele port>) yönlendirmesi\n" +
        "     kayıt gerektirmez. \"Web application\" seçersen her portu tek tek kaydetmen gerekir.",
    ],
    ["7", "Çıkan Client ID ve Client Secret değerlerini kopyala."],
    [
      "8",
      "Proje kökündeki .env dosyasına yapıştır:\n" +
        dim("       GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com\n") +
        dim("       GOOGLE_CLIENT_SECRET=GOCSPX-...."),
    ],
  ];
  for (const [n, text] of steps) {
    const [first, ...rest] = text.split("\n");
    say(`  ${cyan(bold(n + ")"))} ${first}`);
    for (const r of rest) say(`  ${r}`);
    say("");
  }
  say(bold("  Sonra tekrar çalıştır:"));
  say(cyan("     node scripts/google-auth.mjs"));
  say("");
  say(
    dim(
      "  NOT: Google Workspace kullanıyorsan ve kullanıcı onayı istemiyorsan alternatif yol\n" +
        "  service account + domain-wide delegation'dır (.env içindeki GOOGLE_SA_* alanları).\n" +
        "  O yol @gmail.com hesaplarında ÇALIŞMAZ.",
    ),
  );
  say("");
  process.exit(1);
}

// ── Mevcut token dosyası ─────────────────────────────────────────────────────
if (existsSync(TOKEN_PATH) && !has("--force")) {
  let existing = null;
  try {
    existing = JSON.parse(readFileSync(TOKEN_PATH, "utf8"));
  } catch {
    /* bozuk dosya — üzerine yazacağız */
  }
  say("");
  say(yellow(`  Token dosyası zaten var: ${TOKEN_PATH}`));
  if (existing?.updated_at) say(dim(`  son güncelleme: ${existing.updated_at}`));
  if (existing?.scope) say(dim(`  kapsam: ${existing.scope}`));
  say("");
  say(`  Üzerine yazmak için: ${cyan("node scripts/google-auth.mjs --force")}`);
  say("");
  process.exit(0);
}

// ── PKCE ─────────────────────────────────────────────────────────────────────
// Desktop/loopback akışında client_secret gerçek anlamda gizli DEĞİLDİR
// (kullanıcının diskinde durur). PKCE, araya giren bir uygulamanın yakaladığı
// authorization code'u kullanamamasını sağlar. Google bunu artık zorunlu tutuyor.
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const codeVerifier = b64url(crypto.randomBytes(64)); // 43–128 karakter aralığında
const codeChallenge = b64url(crypto.createHash("sha256").update(codeVerifier).digest());
const stateToken = b64url(crypto.randomBytes(24)); // CSRF koruması

// ── Tarayıcıyı aç ────────────────────────────────────────────────────────────
function openBrowser(url) {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
    return true;
  } catch {
    return false;
  }
}

// ── HTML yanıt sayfaları ─────────────────────────────────────────────────────
function page(title, body, tone) {
  const color = tone === "ok" ? "#15803d" : "#b91c1c";
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  :root{color-scheme:light dark}
  body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:grid;place-items:center;
       min-height:100vh;margin:0;background:#f6f7f9;color:#14161a}
  @media(prefers-color-scheme:dark){body{background:#0f1115;color:#e6e9ef}
    .card{background:#161a20 !important;border-color:#262c36 !important}}
  .card{background:#fff;border:1px solid #dfe3ea;border-radius:14px;padding:28px 32px;max-width:520px;
        box-shadow:0 4px 20px rgba(0,0,0,.08)}
  h1{margin:0 0 10px;font-size:20px;color:${color}}
  p{margin:0;line-height:1.6;font-size:15px}
  code{font-family:ui-monospace,Menlo,monospace;font-size:13px}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

// ── Loopback sunucusu + akış ────────────────────────────────────────────────
function waitForCode(server) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Zaman aşımı: 5 dakika içinde giriş tamamlanmadı.")), 300000);
    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      const done = (status, html, result) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        clearTimeout(timer);
        result instanceof Error ? reject(result) : resolve(result);
      };

      if (err) {
        return done(
          400,
          page(
            "Yetkilendirme reddedildi",
            `Google şu hatayı döndürdü: <code>${err}</code><br><br>` +
              `Uygulaman "Testing" modundaysa Google Cloud Console → OAuth consent screen → Test users ` +
              `bölümüne kendi e-postanı eklemen gerekir.`,
          ),
          new Error(`Google yetkilendirmeyi reddetti: ${err}`),
        );
      }
      // state DOĞRULAMASI: eşleşmiyorsa istek bu oturuma ait değildir (CSRF).
      if (state !== stateToken) {
        return done(
          400,
          page("Güvenlik hatası", "state değeri eşleşmedi. Yetkilendirme iptal edildi."),
          new Error("state eşleşmedi — istek bu oturuma ait değil."),
        );
      }
      if (!code) {
        return done(400, page("Kod alınamadı", "Yanıtta authorization code yok."), new Error("code yok"));
      }
      done(
        200,
        page(
          "Yetkilendirme tamamlandı ✓",
          "Bu sekmeyi kapatabilirsin. Kalan adımlar terminalde devam ediyor.",
          "ok",
        ),
        code,
      );
    });
  });
}

async function exchangeToken(params) {
  const res = await fetch(TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Token takası başarısız (HTTP ${res.status}): ${json.error ?? "?"}` +
        (json.error_description ? ` — ${json.error_description}` : ""),
    );
  }
  return json;
}

async function main() {
  const server = http.createServer();
  // 127.0.0.1: "localhost" bazı sistemlerde ::1'e çözülür ve Google'ın loopback
  // eşleşmesi bozulur. Port 0 → işletim sistemi boş bir port verir.
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authUrl =
    AUTH_URI +
    "?" +
    new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      // access_type=offline + prompt=consent → refresh_token GARANTİ gelir.
      // prompt atlanırsa Google, daha önce onay verilmiş hesaplarda refresh_token
      // GÖNDERMEZ ve script sessizce işe yaramaz bir dosya yazar.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state: stateToken,
    }).toString();

  say("");
  say(bold("  Google Calendar yetkilendirmesi"));
  say(dim(`  kapsam       : ${SCOPE}`));
  say(dim(`  yönlendirme  : ${redirectUri}`));
  say(dim(`  hedef dosya  : ${TOKEN_PATH}`));
  say("");

  if (has("--print-url")) {
    say("  Aşağıdaki adresi tarayıcında aç:");
    say("");
    say("  " + cyan(authUrl));
  } else {
    say("  Tarayıcı açılıyor… açılmazsa aşağıdaki adresi elle aç:");
    say("");
    say("  " + dim(authUrl));
    openBrowser(authUrl);
  }
  say("");
  say(yellow("  Bekleniyor… (iptal için Ctrl+C)"));

  let code;
  try {
    code = await waitForCode(server);
  } finally {
    server.close();
  }

  say("");
  say(dim("  Authorization code alındı, token'a çevriliyor…"));

  const tok = await exchangeToken({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    code_verifier: codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  if (!tok.refresh_token) {
    say("");
    say(red(bold("  UYARI: yanıtta refresh_token YOK.")));
    say(
      yellow(
        "  Bu genellikle hesabın bu uygulamaya daha önce onay vermiş olmasından kaynaklanır.\n" +
          "  https://myaccount.google.com/permissions adresinden uygulamanın erişimini kaldırıp\n" +
          "  script'i --force ile tekrar çalıştır.",
      ),
    );
    say("");
    process.exit(1);
  }

  // ── Dosyayı yaz: dizin 0700, dosya 0600 ────────────────────────────────────
  // Bu dosya bir SIRDIR. .gitignore'da "*-token.json" deseniyle zaten hariç
  // tutulmuştur ama izinleri de daraltıyoruz: sadece sahibi okuyabilsin.
  const now = new Date().toISOString();
  const payload = {
    version: TOKEN_FILE_VERSION,
    provider: "google",
    created_at: now,
    updated_at: now,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    token_uri: TOKEN_URI,
    scope: tok.scope ?? SCOPE,
    token_type: tok.token_type ?? "Bearer",
    refresh_token: tok.refresh_token,
    access_token: tok.access_token ?? null,
    // expires_at: EPOCH SANİYE. expires_in (göreli) saklamak işe yaramaz —
    // dosya diskte beklerken geçerlilik süresi akmaya devam eder.
    expires_at: tok.expires_in ? Math.floor(Date.now() / 1000) + Number(tok.expires_in) : null,
    calendar_id: CALENDAR_ID,
  };

  const dir = path.dirname(TOKEN_PATH);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* Windows'ta chmod anlamsızdır */
  }
  writeFileSync(TOKEN_PATH, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    /* Windows */
  }

  say("");
  say(green(bold("  ✔ Token kaydedildi")));
  say(dim(`    ${TOKEN_PATH}  (izin 0600)`));

  // ── Doğrulama: gerçekten okuyabiliyor muyuz? ───────────────────────────────
  if (!has("--no-verify") && payload.access_token) {
    try {
      const now = new Date();
      const timeMin = new Date(now.getTime() - 86400000).toISOString();
      const timeMax = new Date(now.getTime() + 86400000).toISOString();
      const u = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
      );
      // singleEvents=true ZORUNLUDUR: varsayılan false'tur ve tekrarlayan
      // toplantılar açılmadan (ham RRULE olarak) döner.
      u.searchParams.set("singleEvents", "true");
      u.searchParams.set("orderBy", "startTime");
      u.searchParams.set("maxResults", "5");
      u.searchParams.set("timeMin", timeMin);
      u.searchParams.set("timeMax", timeMax);
      const r = await fetch(u, { headers: { authorization: `Bearer ${payload.access_token}` } });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        say(green(`  ✔ Takvim okuma testi başarılı — son 24 saatte ${(j.items ?? []).length} etkinlik görüldü.`));
      } else {
        say(yellow(`  ⚠ Takvim okuma testi başarısız (HTTP ${r.status}): ${j.error?.message ?? "?"}`));
        if (r.status === 403) {
          say(yellow("    Google Cloud Console'da \"Google Calendar API\" ENABLE edilmemiş olabilir."));
        }
      }
    } catch (e) {
      say(yellow(`  ⚠ Doğrulama isteği yapılamadı: ${e.message}`));
    }
  }

  say("");
  say(bold("  Şimdi .env dosyanda:"));
  say(cyan("     CALENDAR_PROVIDER=google"));
  if (CALENDAR_ID !== "primary") say(cyan(`     GOOGLE_CALENDAR_ID=${CALENDAR_ID}`));
  say("");
  say(dim("  Üç sunucu da bu dosyayı okuyup access token'ı düz bir HTTP POST ile yeniler."));
  say(dim("  Dosya şeması: scripts/README.md → \"google-token.json şeması\""));
  say("");
}

main().catch((err) => {
  say("");
  say(red(bold(`  ✘ ${err.message}`)));
  say("");
  process.exit(1);
});
