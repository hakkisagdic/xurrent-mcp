#!/usr/bin/env node
/**
 * GEMINI WIRE FORMAT DENETLEYİCİSİ
 * ════════════════════════════════
 *
 * Sahte Gemini sunucusu istemciyi ÇALIŞTIRIR; bu sonda istemciyi DENETLER.
 * Gerçek Gemini gibi davranır ama her isteğin gövdesini tek tek iddiaya sokar:
 * anahtar header'da mı, systemInstruction ayrı alanda mı, şemada Gemini'nin
 * kabul etmediği anahtar kelime kaldı mı, functionResponse.id functionCall.id
 * ile eşleşiyor mu.
 *
 * Neden ayrı bir araç: sahte sunucu "çalışıyor mu" sorusunu cevaplar, bu sonda
 * "DOĞRU MU konuşuyor" sorusunu. İkincisi olmadan, yanlış ama çalışan bir
 * istemci fark edilmez — nitekim TypeScript parametresiz tool için boş
 * `parameters` gönderiyordu ve bunu yalnızca bu sonda yakaladı.
 *
 * Kullanım (ayrı terminalde istemciyi bu porta yönlendir):
 *   node tools/fake-gemini/wire-denetimi.mjs &
 *   cd servers/typescript && echo "acik islerim" | \
 *     GEMINI_BASE_URL=http://127.0.0.1:5104 GEMINI_API_KEY=sahte npm run chat
 *
 * Çıkış kodu: tüm iddialar geçerse 0, biri bile kalırsa 1.
 */
import http from "node:http";

const PORT = 5104;
let tur = 0;
const CALL_ID = "probe-call-1";
const bulgular = [];
const ok = (ad, kosul, detay = "") => bulgular.push(`${kosul ? "GECTI" : "KALDI"}  ${ad}${detay ? "  <- " + detay : ""}`);

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    tur++;
    if (tur === 1) {
      ok("anahtar x-goog-api-key header'inda", req.headers["x-goog-api-key"] === "sahte", String(req.headers["x-goog-api-key"]));
      ok("anahtar URL query'sinde DEGIL", ![...url.searchParams.keys()].some(k => /key/i.test(k)), url.search || "(query yok)");
      ok("yol /v1beta/models/{model}:generateContent", /^\/v1beta\/models\/[^:]+:generateContent$/.test(url.pathname), url.pathname);
    }
    const b = JSON.parse(raw);

    if (tur === 1) {
      ok("systemInstruction ayri alanda", typeof b.systemInstruction?.parts?.[0]?.text === "string");
      ok("contents icinde 'system' rolu YOK", !b.contents.some(c => c.role === "system"));
      ok("roller yalnizca user|model", b.contents.every(c => c.role === "user" || c.role === "model"), JSON.stringify(b.contents.map(c => c.role)));
      ok("tools[0].functionDeclarations var (8 tool)", b.tools?.[0]?.functionDeclarations?.length === 8, String(b.tools?.[0]?.functionDeclarations?.length));
      const json = JSON.stringify(b.tools[0].functionDeclarations);
      ok("gonderilen semada '$' ile baslayan anahtar YOK", !/"\$[a-zA-Z]/.test(json));
      for (const kw of ["additionalProperties", "pattern", "minimum", "maximum", "maxLength", "minItems", "maxItems", "oneOf", "anyOf", "allOf", "const", "format", "default"])
        ok(`semada '${kw}' YOK`, !new RegExp(`"${kw}"\\s*:`).test(json));
      ok("whoami 'parameters' gondermiyor", !("parameters" in b.tools[0].functionDeclarations.find(d => d.name === "xurrent_whoami")));
      ok("generationConfig var", typeof b.generationConfig === "object");
      // Tool cagrisi uret.
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ functionCall: { id: CALL_ID, name: "xurrent_whoami", args: {} } }] }, finishReason: "STOP" }],
      }));
    }

    if (tur === 2) {
      const son = b.contents.at(-1);
      const fr = son?.parts?.[0]?.functionResponse;
      ok("tool sonucu 'user' rolu ile donuyor", son?.role === "user", String(son?.role));
      ok("bir onceki tur 'model' rolu + functionCall", b.contents.at(-2)?.role === "model" && !!b.contents.at(-2)?.parts?.[0]?.functionCall);
      ok("functionResponse.id === functionCall.id", fr?.id === CALL_ID, `${fr?.id} vs ${CALL_ID}`);
      ok("functionResponse.name dogru", fr?.name === "xurrent_whoami", String(fr?.name));
      ok("functionResponse.response bir OBJE", fr && typeof fr.response === "object" && !Array.isArray(fr.response), typeof fr?.response);
      ok("response icerigi tool ciktisini tasiyor", JSON.stringify(fr?.response ?? {}).includes("Ay"), JSON.stringify(fr?.response).slice(0, 90));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Denetim bitti." }] }, finishReason: "STOP" }] }));
      setTimeout(() => { console.log(bulgular.join("\n")); process.exit(bulgular.some(b => b.startsWith("KALDI")) ? 1 : 0); }, 300);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "bitti" }] }, finishReason: "STOP" }] }));
  });
}).listen(PORT, "127.0.0.1", () => console.error("probe dinliyor " + PORT));
