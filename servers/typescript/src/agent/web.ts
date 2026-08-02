#!/usr/bin/env node
/**
 * Web arayüzü sunucusu.
 *
 * SÖZLEŞME: clients/web/API.md — dört uç nokta, üç backend'de BİREBİR aynı.
 * clients/web altındaki HTML/CSS/JS dile bağımlı DEĞİLDİR; TypeScript, Python ve
 * C# sunucuları aynı dosyaları servis eder. Bu, contract/tools.json'un web
 * katmanındaki karşılığıdır: arayüz hangi dilin arkasında çalıştığını bilmez.
 *
 *   GET  /             → clients/web/index.html
 *   GET  /api/config   → rozetler (SIR İÇERMEZ; yalnızca hasApiKey: boolean)
 *   POST /api/chat     → SSE akışı (text / tool_use / tool_result / elicit / done / error)
 *   POST /api/elicit   → onay yanıtı (SSE tek yönlü olduğu için ayrı istek)
 *
 * ONAY (elicit): akış duraklar ve /api/elicit beklenir. 120 saniye içinde yanıt
 * gelmezse REDDEDİLMİŞ sayılır — cevapsızlık onay değildir (fail-closed).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config.js";
import { createToolContext, type ConfirmFn, type ConfirmOutcome } from "../core/context.js";
import { TOOL_NAMES } from "../core/toolimpl.js";
import { log } from "../util/log.js";
import { createXurrentAdapter } from "../xurrent/index.js";
import { createAnthropicClient, runTurn, type AgentEvent, type ChatMessage } from "./core.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** Sözleşme §3: bekleyen onay 120 saniye sonra OTOMATİK REDDEDİLİR. */
const ELICIT_TIMEOUT_MS = 120_000;

interface PendingElicit {
  resolve: (outcome: ConfirmOutcome) => void;
  timer: NodeJS.Timeout;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * SSE çerçevesi. data TEK SATIR olmalıdır — JSON.stringify satır sonlarını zaten
 * \n olarak kaçırır, ama bunu bilerek yapıyoruz: gövdede ham satır sonu bırakmak
 * çerçeveyi böler ve arayüz olayı SESSİZCE kaçırır.
 */
function sse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const staticRoot = join(cfg.repoRoot, "clients", "web");
  const hasIndex = existsSync(join(staticRoot, "index.html"));

  const pending = new Map<string, PendingElicit>();

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      // ── GET /api/config ──────────────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/api/config") {
        // SIR SIZDIRMAZ: anahtarın kendisi değil, yalnızca VAR MI bilgisi döner.
        json(res, 200, {
          mode: cfg.mode,
          strategy: cfg.backdateStrategy,
          calendarProvider: cfg.calendarProvider,
          model: cfg.anthropicModel,
          hasApiKey: cfg.anthropicApiKey.length > 0,
          language: "typescript",
          dryRunForced: cfg.forceDryRun,
          timeZone: cfg.timeZone,
          maxBackdateDays: cfg.maxBackdateDays,
          toolCount: TOOL_NAMES.length,
        });
        return;
      }

      // ── POST /api/elicit ─────────────────────────────────────────────────
      if (req.method === "POST" && url.pathname === "/api/elicit") {
        let body: { id?: string; accept?: boolean };
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          json(res, 400, { ok: false, error: "Gövde geçerli JSON değil." });
          return;
        }
        if (typeof body.id !== "string") {
          json(res, 400, { ok: false, error: "id alanı zorunludur." });
          return;
        }
        const entry = pending.get(body.id);
        if (!entry) {
          json(res, 404, { ok: false, error: "Onay isteği bulunamadı veya zaman aşımına uğradı." });
          return;
        }
        clearTimeout(entry.timer);
        pending.delete(body.id);
        entry.resolve(body.accept === true ? { action: "accept" } : { action: "decline" });
        json(res, 200, { ok: true });
        return;
      }

      // ── POST /api/chat (SSE) ─────────────────────────────────────────────
      if (req.method === "POST" && url.pathname === "/api/chat") {
        let body: { messages?: ChatMessage[] };
        try {
          body = JSON.parse((await readBody(req)) || "{}");
        } catch {
          json(res, 400, { ok: false, error: "Gövde geçerli JSON değil." });
          return;
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          // Ters vekil arkasında bu olmadan akış tamponlanır ve metin tur bitince
          // topluca düşer — "canlı akıyor" hissi kaybolur.
          "X-Accel-Buffering": "no",
        });

        const abort = new AbortController();
        const myPending = new Set<string>();

        // Sözleşme §2.5: istemci bağlantıyı kaparsa bekleyen onay REDDEDİLMİŞ sayılır.
        res.on("close", () => {
          abort.abort();
          for (const id of myPending) {
            const e = pending.get(id);
            if (e) {
              clearTimeout(e.timer);
              pending.delete(id);
              e.resolve({ action: "decline", reason: "istemci bağlantıyı kapattı" });
            }
          }
        });

        const confirm: ConfirmFn = (request) =>
          new Promise<ConfirmOutcome>((resolveConfirm) => {
            const id = `el_${randomUUID()}`;
            myPending.add(id);
            const timer = setTimeout(() => {
              pending.delete(id);
              myPending.delete(id);
              resolveConfirm({ action: "decline", reason: "zaman aşımı (120 sn)" });
            }, ELICIT_TIMEOUT_MS);
            pending.set(id, {
              resolve: (o) => {
                myPending.delete(id);
                resolveConfirm(o);
              },
              timer,
            });
            sse(res, "elicit", {
              id,
              message: `${request.summary} Onaylıyor musun?`,
              kind: "confirm",
              confirmLabel: "Onayla",
              cancelLabel: "İptal",
              details: Object.fromEntries(Object.entries(request.fields).map(([k, v]) => [k, String(v)])),
              schema: {
                type: "object",
                properties: { onay: { type: "boolean", title: "Onaylıyorum" } },
                required: ["onay"],
              },
            });
          });

        const ctx = createToolContext(cfg, createXurrentAdapter(cfg), confirm);

        let client;
        try {
          client = createAnthropicClient(cfg);
        } catch (err) {
          // En yaygın sebep: ANTHROPIC_API_KEY yok. Sessiz boş akış yerine sebebi söylenir.
          sse(res, "error", { message: err instanceof Error ? err.message : String(err), code: "no_api_key" });
          res.end();
          return;
        }

        const emit = (e: AgentEvent) => {
          const { type, ...rest } = e as AgentEvent & { type: string };
          sse(res, type, rest);
        };

        await runTurn(client, cfg, ctx, body.messages ?? [], emit, abort.signal);
        res.end();
        return;
      }

      // ── statik dosyalar ──────────────────────────────────────────────────
      if (req.method === "GET") {
        if (!hasIndex) {
          res.writeHead(200, { "Content-Type": MIME[".html"]! });
          res.end(FALLBACK_HTML);
          return;
        }
        const rel = url.pathname === "/" ? "/index.html" : url.pathname;
        const filePath = resolve(join(staticRoot, normalize(rel)));
        // Path traversal koruması: kök dışına çıkan hiçbir yol servis edilmez.
        if (!filePath.startsWith(resolve(staticRoot))) {
          res.writeHead(403).end("Yasak");
          return;
        }
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
          res.end(readFileSync(filePath));
          return;
        }
        // SPA davranışı: bilinmeyen yol index.html'e düşer.
        res.writeHead(200, { "Content-Type": MIME[".html"]! });
        res.end(readFileSync(join(staticRoot, "index.html")));
        return;
      }

      res.writeHead(404).end("Bulunamadı");
    })().catch((err) => {
      log.error("web isteği hatası", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) res.writeHead(500).end("Sunucu hatası");
      else res.end();
    });
  });

  http.listen(cfg.webPort, () => {
    log.info(
      `Web arayüzü: http://localhost:${cfg.webPort}  (statik: ${hasIndex ? staticRoot : "gömülü yedek sayfa"})`,
    );
  });
}

/** clients/web henüz yoksa kullanılan minimal ama ÇALIŞAN yedek arayüz. */
const FALLBACK_HTML = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Xurrent MCP — sohbet (TypeScript)</title>
<style>
 body{font-family:system-ui,sans-serif;max-width:820px;margin:2rem auto;padding:0 1rem;background:#0f1115;color:#e6e6e6}
 h1{font-size:1.1rem} #log{border:1px solid #2a2f3a;border-radius:8px;padding:1rem;min-height:50vh;white-space:pre-wrap}
 .u{color:#7ee787} .b{color:#79c0ff} .t{color:#8b949e;font-size:.85em} .e{color:#ff7b72}
 form{display:flex;gap:.5rem;margin-top:1rem} input{flex:1;padding:.6rem;border-radius:6px;border:1px solid #2a2f3a;background:#161b22;color:inherit}
 button{padding:.6rem 1rem;border-radius:6px;border:0;background:#238636;color:#fff;cursor:pointer}
 .confirm{border:1px solid #d29922;border-radius:8px;padding:.75rem;margin:.5rem 0;background:#1c1a14}
</style></head><body>
<h1>Xurrent zaman takibi asistanı <span class="t">— TypeScript / gömülü yedek arayüz</span></h1>
<div id="log"></div>
<form id="f"><input id="m" placeholder="bugünkü toplantılarımı Xurrent'a yaz" autocomplete="off"><button>Gönder</button></form>
<script>
const log=document.getElementById('log');let messages=[];
function add(cls,txt){const d=document.createElement('div');d.className=cls;d.textContent=txt;log.appendChild(d);log.scrollTop=log.scrollHeight;}
function askElicit(p){const box=document.createElement('div');box.className='confirm';
 box.textContent=p.message+"\\n"+Object.entries(p.details||{}).map(([k,v])=>k+': '+v).join("\\n")+"\\n";
 const yes=document.createElement('button');yes.textContent=p.confirmLabel||'Onayla';
 const no=document.createElement('button');no.textContent=p.cancelLabel||'İptal';no.style.background='#da3633';no.style.marginLeft='.5rem';
 const send=a=>{fetch('/api/elicit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:p.id,accept:a})});box.innerHTML='<span class="t">'+(a?'Onaylandı':'Reddedildi')+'</span>';};
 yes.onclick=()=>send(true);no.onclick=()=>send(false);box.append(yes,no);log.appendChild(box);log.scrollTop=log.scrollHeight;}
document.getElementById('f').onsubmit=async e=>{e.preventDefault();
 const inp=document.getElementById('m');const msg=inp.value.trim();if(!msg)return;inp.value='';add('u','sen> '+msg);
 messages=messages.concat([{role:'user',content:msg}]);
 const res=await fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages})});
 const reader=res.body.getReader();const dec=new TextDecoder();let buf='';
 for(;;){const {value,done}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});
  const parts=buf.split("\\n\\n");buf=parts.pop();
  for(const p of parts){const ev=/^event: (.+)$/m.exec(p)?.[1];const dm=/^data: (.+)$/m.exec(p)?.[1];if(!ev||!dm)continue;
   const d=JSON.parse(dm);
   if(ev==='text')add('b','bot> '+d.delta);
   else if(ev==='tool_use')add('t','  [tool] '+d.name+' '+JSON.stringify(d.args));
   else if(ev==='tool_result')add('t','  [sonuç] '+(d.summary||d.name));
   else if(ev==='elicit')askElicit(d);
   else if(ev==='done')messages=d.messages;
   else if(ev==='error')add('e','  HATA: '+d.message);}}
};
</script></body></html>`;

main().catch((err) => {
  log.error("web sunucusu başlatılamadı", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
