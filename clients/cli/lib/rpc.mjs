// -----------------------------------------------------------------------------
// clients/cli/lib/rpc.mjs — ham stdio JSON-RPC MCP istemcisi (çift era)
//
// NEDEN SDK YOK: xmcp iki MCP revizyonunu (2025-11-25 ve 2026-07-28) AYNI koddan
// konuşur. İki revizyon iki farklı SDK paketi ister; ikisini birden taşımak hem
// ağırlık hem de dersi gizlemek olurdu. Protokolün tamamı satır-sonlu JSON-RPC
// 2.0'dır — burada TELİ görüyoruz. (Aynı yaklaşım: clients/inspector/sunucu.mjs
// ve clients/wizard/wizard.mjs'in protokol karşılaştırma bölümü.)
//
// ★ ERA FARKI TEK CÜMLEDE:
//   2025-11-25 → initialize el sıkışması; sunucu onay için client'a İSTEK
//                gönderir (elicitation/create).
//   2026-07-28 → el sıkışma YOK; her istek _meta zarfı taşır; sunucu onay için
//                SONUÇ döner (resultType:"input_required") ve client aynı çağrıyı
//                YENİ id ile inputResponses + requestState ekleyerek tekrarlar.
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const V2_VERSION = "2026-07-28";
export const V1_VERSION = "2025-11-25";

const META_VER = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_INFO = "io.modelcontextprotocol/clientInfo";

export const CLIENT_INFO = { name: "xurrent-xmcp", version: "1.0.0" };
// elicitation yeteneğini BİLDİRİYORUZ: sunucu yazma öncesi onayı doğrudan
// kullanıcıdan isteyebilsin. Bildirmezsek sunucu fail-closed davranır.
export const CLIENT_CAPS = { elicitation: {} };

// Spec 2026-07-28 hata kodları — sondanın DOĞRU yorumu bunlara bağlıdır:
//   -32601 "Method not found"  → sunucu v2 KONUŞMUYOR (v1'e düşülebilir)
//   -32602 "_meta eksik/bozuk" → İSTEMCİ hatası; v1'e DÜŞÜLMEZ (bkz. wizard.mjs:
//          bu ikisini karıştıran sonda v2 sunucuyu ömür boyu v1 sanar)
export const RPC = {
  PARSE_ERROR: -32700,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  MISSING_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
};

/** v2'de HER isteğe eklenen zarf. Bir istekte unutmak o isteği reddettirir. */
export function v2Meta(protocol = V2_VERSION) {
  return {
    [META_VER]: protocol,
    [META_CAPS]: CLIENT_CAPS,
    [META_INFO]: CLIENT_INFO,
  };
}

// ── Sunucu tanımları — ALLOWLIST ────────────────────────────────────────────
// wizard.mjs / inspector / .mcp.json ile birebir aynı komutlar. --exec dışında
// keyfi komut çalıştırılamaz. C# için --no-build: sunucular önceden derlidir,
// istemcinin görevi derlemek değildir (senaryolar.mjs de böyle yapar).
export function serverDefs(ROOT) {
  return {
    ts: {
      label: "TypeScript",
      command: "node",
      args: [path.join(ROOT, "servers", "typescript", "dist", "mcp", "stdio.js")],
      hint: "cd servers/typescript && npm install && npm run build",
      defaultTimeout: 60000,
    },
    py: {
      label: "Python",
      command: "uv",
      args: ["--directory", path.join(ROOT, "servers", "python"), "run", "xurrent-mcp"],
      hint: "cd servers/python && uv sync",
      defaultTimeout: 60000,
    },
    cs: {
      label: "C#",
      command: "dotnet",
      args: ["run", "--project", path.join(ROOT, "servers", "csharp", "XurrentMcp.csproj"), "--no-build", "--", "stdio"],
      hint: "cd servers/csharp && dotnet build",
      defaultTimeout: 180000, // dotnet açılışı yavaştır; wizard.mjs de cs'e daha uzun tanır
    },
  };
}

// ── .env yükleyici (bağımlılıksız; gerçek ortam değişkenlerini EZMEZ) ───────
function loadDotEnv(file) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v;
  }
  return env;
}

/** Çocuk sürecin ortamı: .env → varsayılanlar → gerçek process.env (o kazanır). */
export function buildChildEnv(ROOT) {
  const dotenv = loadDotEnv(path.join(ROOT, ".env"));
  return {
    ...dotenv,
    XURRENT_MODE: process.env.XURRENT_MODE ?? dotenv.XURRENT_MODE ?? "mock",
    XURRENT_TIMEZONE: process.env.XURRENT_TIMEZONE ?? dotenv.XURRENT_TIMEZONE ?? "Europe/Istanbul",
    CALENDAR_PROVIDER: process.env.CALENDAR_PROVIDER ?? dotenv.CALENDAR_PROVIDER ?? "mock",
    XURRENT_BACKDATE_STRATEGY:
      process.env.XURRENT_BACKDATE_STRATEGY ?? dotenv.XURRENT_BACKDATE_STRATEGY ?? "two_step",
    XURRENT_FIXTURES_DIR:
      process.env.XURRENT_FIXTURES_DIR ?? dotenv.XURRENT_FIXTURES_DIR ?? path.join(ROOT, "fixtures"),
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
  };
}

export class RpcError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Tek MCP sunucu süreci + satır-sonlu JSON-RPC istemcisi.
 *
 * Yaşam döngüsü: new McpClient(...) → open(era) → listTools()/callTool() → close().
 * Bir xmcp çağrısı = BİR süreç. Sohbet (chat) dahil: timesheet_wizard'ın
 * sessionState'i zaten her turda geri döndüğü için süreç boyu state gerekmez.
 */
export class McpClient {
  /**
   * @param {object} o
   * @param {{label:string,command:string,args:string[]}} o.srv sunucu tanımı
   * @param {string} o.cwd  çocuk sürecin çalışma dizini (repo kökü)
   * @param {object} o.env  çocuk sürecin ortamı
   * @param {number} o.timeoutMs  istek başına zaman aşımı
   * @param {(req:{message:string,requestedSchema:object})=>Promise<{action:string,content?:object}>} [o.onElicit]
   *        Onay/elicitation isteğini kullanıcıya soran geri çağrı. Verilmezse decline edilir.
   */
  constructor({ srv, cwd, env, timeoutMs = 60000, onElicit = null }) {
    this.srv = srv;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.onElicit = onElicit;
    this.era = null; // "2026" | "2025" — open() belirler
    this.protocolVersion = null; // telde konuşulan sürüm dizesi
    this.serverInfo = null;
    this.supportedVersions = [];
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderrBuf = "";
    this.closed = false;
  }

  start() {
    this.child = spawn(this.srv.command, this.srv.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (e) => this.#failAll(new RpcError(`Sunucu başlatılamadı: ${e.message}`)));
    this.child.on("exit", (code) => {
      if (!this.closed) {
        this.#failAll(
          new RpcError(
            `Sunucu süreci kapandı (kod ${code}).` +
              (this.stderrBuf ? ` Son stderr:\n${this.tailStderr()}` : ""),
          ),
        );
      }
    });
    // Sunucu logları stderr'e akar (stdio'da stdout SADECE JSON-RPC içindir).
    // Toplarız; yalnızca hata durumunda gösteririz — TUI'yi kirletmemek için.
    this.child.stderr.on("data", (d) => {
      this.stderrBuf += d.toString();
      if (this.stderrBuf.length > 64_000) this.stderrBuf = this.stderrBuf.slice(-32_000);
    });

    let buf = "";
    this.child.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // JSON olmayan satır (protokol ihlali olurdu) — verify-contract'ın işi
        }
        this.#onMessage(msg);
      }
    });
    return this;
  }

  tailStderr(n = 6) {
    return this.stderrBuf.trim().split("\n").slice(-n).join("\n");
  }

  #failAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  #send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }

  #onMessage(msg) {
    // Sunucudan gelen İSTEK — yalnızca v1'de olur (elicitation/create).
    if (msg.method && msg.id !== undefined) {
      this.#handleServerRequest(msg);
      return;
    }
    // Bildirimler (notifications/message vb.) sessizce geçilir.
    if (msg.method) return;
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  async #handleServerRequest(msg) {
    if (msg.method === "elicitation/create") {
      // v1 onay kanalı: sunucu SORUYOR, client kullanıcıya iletip CEVAP yazıyor.
      let result = { action: "decline" };
      if (this.onElicit) {
        try {
          result = await this.onElicit({
            message: msg.params?.message ?? "Sunucu onay istiyor.",
            requestedSchema: msg.params?.requestedSchema ?? {},
          });
        } catch {
          result = { action: "decline" };
        }
      }
      this.#send({ jsonrpc: "2.0", id: msg.id, result });
      return;
    }
    // Desteklemediğimiz sunucu-başlatmalı istekler: dürüstçe -32601.
    this.#send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: RPC.METHOD_NOT_FOUND, message: `istemci bu metodu desteklemiyor: ${msg.method}` },
    });
  }

  /**
   * Ham istek. v2 era'sında _meta zarfı OTOMATİK eklenir — el sıkışma olmadığı
   * için sunucunun sürümü/yetenekleri öğrenebileceği başka an yoktur.
   * @returns {Promise<{result?:object, error?:object}>} ham JSON-RPC yanıtı
   */
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RpcError(
            `Zaman aşımı (${this.timeoutMs} ms): ${method}` +
              (this.stderrBuf ? `\nSunucu stderr (son satırlar):\n${this.tailStderr()}` : ""),
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const p =
        this.era === "2026"
          ? { ...(params ?? {}), _meta: { ...v2Meta(this.protocolVersion ?? V2_VERSION), ...(params?._meta ?? {}) } }
          : params;
      this.#send({ jsonrpc: "2.0", id, method, params: p });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  /**
   * Bağlantıyı açar ve era'yı belirler.
   *
   * @param {"auto"|"2026"|"2025"} era
   *   auto → server/discover dene (_meta İLE); -32601 gelirse initialize'a düş.
   *          -32602/-32021 gelirse DÜŞME: bu istemci hatasıdır, net hata ver.
   *   2026 → yalnızca server/discover; başarısızsa hata.
   *   2025 → yalnızca initialize el sıkışması; başarısızsa hata.
   */
  async open(era = "auto") {
    if (era === "2026" || era === "auto") {
      this.era = "2026"; // request() _meta eklesin diye geçici olarak v2 varsay
      this.protocolVersion = V2_VERSION;
      const disc = await this.request("server/discover", {});
      if (!disc.error) {
        this.supportedVersions = disc.result?.supportedVersions ?? [];
        this.serverInfo = disc.result?.serverInfo ?? null;
        return {
          era: "2026",
          method: "server/discover",
          detail: `server/discover kabul edildi — supportedVersions=${JSON.stringify(this.supportedVersions)}`,
        };
      }
      const code = disc.error.code;
      if (code === RPC.INVALID_PARAMS || code === RPC.MISSING_CLIENT_CAPABILITY) {
        // ★ v1'e DÜŞMÜYORUZ: "-32602 metadata eksik" metodun VAR olduğunu söyler;
        //   eksik olan bizim _meta'mızdır. Bunu "v1 sunucu" diye okumak, v2 konuşan
        //   sunucuyu ömür boyu v1 sanmaktır (bkz. contract/protocol.md).
        throw new RpcError(
          `Sonda YANLIŞ gönderildi (${code}: ${disc.error.message}). Sunucu v2 konuşuyor; ` +
            `eksik olan istemcinin _meta bloğudur. Bu bir İSTEMCİ hatasıdır, v1'e düşülmez.`,
          { code },
        );
      }
      if (era === "2026") {
        throw new RpcError(
          `Sunucu ${V2_VERSION} konuşmuyor (server/discover → ${code}: ${disc.error.message}). ` +
            `--era 2025 deneyin.`,
          { code },
        );
      }
      if (code !== RPC.METHOD_NOT_FOUND && code !== RPC.UNSUPPORTED_PROTOCOL_VERSION) {
        throw new RpcError(`server/discover beklenmeyen hata (${code}: ${disc.error.message})`, { code });
      }
      // -32601 → sunucu v2 konuşmuyor; v1 el sıkışmasına DÜŞ (aynı süreçte —
      // wizard.mjs'in sondasıyla aynı desen).
    }

    this.era = "2025";
    this.protocolVersion = V1_VERSION;
    const init = await this.request("initialize", {
      protocolVersion: V1_VERSION,
      capabilities: CLIENT_CAPS,
      clientInfo: CLIENT_INFO,
    });
    if (init.error) {
      throw new RpcError(
        `initialize reddedildi (${init.error.code}: ${init.error.message}) — ` +
          `sunucu ne ${V2_VERSION} ne ${V1_VERSION} kabul etti.`,
        { code: init.error.code },
      );
    }
    this.protocolVersion = init.result?.protocolVersion ?? V1_VERSION;
    this.serverInfo = init.result?.serverInfo ?? null;
    this.supportedVersions = this.protocolVersion ? [this.protocolVersion] : [];
    this.notify("notifications/initialized");
    return {
      era: "2025",
      method: "initialize",
      detail: `initialize kabul edildi (sunucu: ${this.protocolVersion})`,
    };
  }

  /** tools/list — ham sonuç döner ({tools:[...], ttlMs?, cacheScope?}). */
  async listTools() {
    const res = await this.request("tools/list", {});
    if (res.error) throw new RpcError(`tools/list hatası (${res.error.code}: ${res.error.message})`);
    return res.result;
  }

  /**
   * tools/call + MRTR döngüsü.
   *
   * v2'de "input_required" bir HATA değil SONUÇ türüdür: ilk istek SONLANIR,
   * client kullanıcıya sorar ve AYNI çağrıyı YENİ id ile tekrarlar —
   * inputResponses + requestState (imzalı blob, AYNEN geri) ekleyerek.
   * v1'de aynı onay, sunucu-başlatmalı elicitation/create isteğiyle gelir ve
   * #handleServerRequest cevaplar; burada ek iş yoktur.
   *
   * @returns {object} ham CallToolResult (result alanı)
   */
  async callTool(name, args = {}) {
    const baseParams = { name, arguments: args };
    let res = await this.request("tools/call", baseParams);
    let rounds = 1;
    while (this.era === "2026" && !res.error && res.result?.resultType === "input_required" && rounds < 4) {
      const inputResponses = {};
      for (const [key, req] of Object.entries(res.result.inputRequests ?? {})) {
        let answer = { action: "decline" };
        if (this.onElicit) {
          try {
            answer = await this.onElicit({
              message: req?.message ?? "Sunucu ek bilgi istiyor.",
              requestedSchema: req?.requestedSchema ?? {},
              type: req?.type ?? "elicitation/create",
            });
          } catch {
            answer = { action: "decline" };
          }
        }
        inputResponses[key] = answer;
      }
      // ★ YENİ id ile — bunlar bağımsız isteklerdir; requestState aynen geri gider.
      res = await this.request("tools/call", {
        ...baseParams,
        inputResponses,
        requestState: res.result.requestState,
      });
      rounds++;
    }
    if (res.error) throw new RpcError(`tools/call hatası (${res.error.code}: ${res.error.message})`);
    return res.result;
  }

  close() {
    this.closed = true;
    if (this.child) {
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* zaten kapandı */
      }
      // Borular event loop'u tutmasın: ana süreç exitCode ile DOĞAL çıkar
      // (process.exit stdout'u yarıda keser — bkz. xmcp.mjs:finish).
      for (const s of [this.child.stdin, this.child.stdout, this.child.stderr]) {
        try {
          s?.destroy();
        } catch {
          /* önemsiz */
        }
      }
      try {
        this.child.unref();
      } catch {
        /* önemsiz */
      }
    }
  }
}

// ── Sonuç okuma ─────────────────────────────────────────────────────────────
// MCP tools/call iki şekilde veri döndürebilir: structuredContent (outputSchema
// varsa) veya content[].text. İkisini de kabul ederiz (wizard.mjs ile aynı).
export function extractStructured(result) {
  if (result && result.structuredContent != null && typeof result.structuredContent === "object") {
    return { data: result.structuredContent, source: "structuredContent" };
  }
  const texts = (result?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text);
  for (const t of texts) {
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object") return { data: parsed, source: "content[].text (JSON)" };
    } catch {
      /* metin JSON değil */
    }
  }
  return { data: null, source: "content[].text (düz metin)", text: texts.join("\n") };
}

/**
 * Repo kuralı: isError=true VEYA structuredContent.errors[] dolu = BAŞARISIZ.
 * (HTTP 200 + errors dolu tuzağının MCP karşılığı — bkz. senaryolar.mjs (d).)
 */
export function isFailure(result) {
  if (result?.isError === true) return true;
  const { data } = extractStructured(result);
  return Array.isArray(data?.errors) && data.errors.length > 0;
}

/** Elicitation şemasındaki alanları makul varsayılanlarla doldurur (kabul için). */
export function fillSchemaDefaults(schema) {
  const content = {};
  for (const [k, spec] of Object.entries(schema?.properties ?? {})) {
    if (Array.isArray(spec?.enum)) content[k] = spec.enum[0];
    else if (spec?.type === "boolean") content[k] = true;
    else if (spec?.type === "number" || spec?.type === "integer") content[k] = spec?.default ?? 0;
    else content[k] = spec?.default ?? "";
  }
  return content;
}
