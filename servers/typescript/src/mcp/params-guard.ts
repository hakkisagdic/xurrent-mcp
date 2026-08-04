/**
 * GEÇERSİZ PARAMS KORUYUCUSU — v1 (2025-11-25) yolu için.
 *
 * SORUN: JSON-RPC 2.0, şemayı sağlamayan bir isteğe `-32602 Invalid params`
 * dönmeyi ZORUNLU kılar. `@modelcontextprotocol/sdk@1.30.0` şema doğrulamasını
 * `setRequestHandler` sarmalayıcısının İÇİNDE yapar:
 *
 *     this._requestHandlers.set(method, (request, extra) => {
 *         const parsed = parseWithCompat(requestSchema, request);   // ← ZodError
 *         return Promise.resolve(handler(parsed, extra));
 *     });
 *
 * Fırlayan ZodError'un sayısal bir `code` alanı yoktur; `_onrequest`'in reddi
 * ele alan dalı ise şunu yapar (shared/protocol.js):
 *
 *     code: Number.isSafeInteger(error['code']) ? error['code'] : ErrorCode.InternalError
 *
 * Sonuç: her şema hatası `-32603 Internal error` olur. AYRIM ÖNEMLİDİR —
 * -32603 "bende bir şeyler ters gitti, tekrar dene" demektir; istemci aynı
 * isteği tekrar gönderir ve sonsuza kadar başarısız olur. -32602 ise "isteğin
 * kendisi hatalı" demektir: istemci isteği DÜZELTMEDEN tekrar denememelidir.
 *
 * NEDEN "SDK böyle yapıyor" bir mazeret DEĞİL: aynı SDK'nın v2 kuşağı
 * (@modelcontextprotocol/server 2.0.0) aynı senaryoda -32602 döndürüyor.
 * Yani sapma protokolün değil, bu SÜRÜMÜN eksiğidir.
 *
 * ÇÖZÜM — parse-guard.ts ile AYNI KALIP: SDK ile dövüşme, ÖNÜNE geç.
 * Fark, hangi katmana girdiğimizdedir:
 *
 *     stdin → [parse-guard: BAYT/SATIR düzeyi] → transport → [BU KORUYUCU:
 *     ÇÖZÜLMÜŞ MESAJ düzeyi] → SDK
 *
 * ★ KRİTİK TASARIM KARARI: doğrulamayı KENDİMİZ YAZMIYORUZ. SDK'nın kullandığı
 *   ŞEMA NESNESİNİN TA KENDİSİNİ (CallToolRequestSchema, ListToolsRequestSchema)
 *   çağırıyoruz. Bunun sonucu şudur: bizim GEÇİRDİĞİMİZ her mesajı SDK da
 *   geçirir, bizim REDDETTİĞİMİZ her mesajı SDK da reddederdi — yalnızca yanlış
 *   kodla. Yani çalışan trafiği bozma riski YOKTUR; tek değişen, zaten
 *   başarısız olacak isteğin hata KODU ve MESAJIdır.
 */

import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** zod sürümünden bağımsız, ihtiyacımız kadar dar bir arayüz. */
interface SemaBenzeri {
  safeParse(veri: unknown): { success: boolean; error?: { issues?: unknown } };
}

/** Transport'tan ihtiyacımız olan yüzey — test etmek için sahtesi kolayca yazılır. */
export interface KorunabilirTransport {
  onmessage?: ((mesaj: never, ek?: never) => void) | undefined;
  send(mesaj: never, secenekler?: never): Promise<void>;
}

export interface ParamsHatasi {
  code: number;
  message: string;
  data: { issues: { path: string; code: string; message: string }[] };
}

export interface ParamsGuardSecenekleri {
  /** Reddedilen isteği bildirmek için (stderr'e log). */
  onReject?: (metot: string, id: unknown, hata: ParamsHatasi) => void;
  /** Hata yanıtı gönderilemezse. */
  onSendError?: (err: unknown) => void;
}

/**
 * DOĞRULANAN METOTLAR — bu sunucunun v1'de gerçekten servis ettiği istekler.
 *
 * Liste bilerek DARdır. `initialize`, `ping`, `completion/complete` gibi
 * metotları SDK kendi kurallarıyla karşılıyor; onlara burada dokunmak, spec'in
 * izin verdiği bir varyasyonu yanlışlıkla reddetme riski taşırdı. Bir metodu
 * buraya eklemenin tek koşulu, SDK'nın O İSTEK İÇİN KULLANDIĞI ŞEMANIN
 * BİREBİR AYNISINI vermektir (bkz. sdk/dist/esm/server/mcp.js →
 * setToolRequestHandlers).
 */
export const V1_ISTEK_SEMALARI: Map<string, SemaBenzeri> = new Map<string, SemaBenzeri>([
  ["tools/call", CallToolRequestSchema as unknown as SemaBenzeri],
  ["tools/list", ListToolsRequestSchema as unknown as SemaBenzeri],
]);

function issueOzeti(ham: unknown): { path: string; code: string; message: string }[] {
  if (!Array.isArray(ham)) return [];
  return ham.slice(0, 5).map((i) => {
    const o = (i ?? {}) as Record<string, unknown>;
    const yol = Array.isArray(o["path"]) && o["path"].length ? o["path"].join(".") : "(kök)";
    return {
      path: yol,
      code: typeof o["code"] === "string" ? o["code"] : "invalid",
      message: typeof o["message"] === "string" ? o["message"] : "geçersiz değer",
    };
  });
}

/**
 * Mesajı inceler; şema ihlali varsa -32602 gövdesi, yoksa null döner.
 *
 * Üç şeye DOKUNMAZ (hepsi bilinçli):
 *   • yanıtlar (method yok)             → koruyucunun işi değil
 *   • notification'lar (id yok)         → id'siz isteğe yanıt YASAKTIR (uyum J6)
 *   • listede olmayan metotlar          → "metot yok" kararını SDK verir (-32601)
 */
export function paramsHatasiBul(mesaj: unknown, semalar: Map<string, SemaBenzeri> = V1_ISTEK_SEMALARI): ParamsHatasi | null {
  if (!mesaj || typeof mesaj !== "object" || Array.isArray(mesaj)) return null;
  const m = mesaj as Record<string, unknown>;

  if (typeof m["method"] !== "string") return null;
  if (m["id"] === undefined || m["id"] === null) return null;

  const sema = semalar.get(m["method"]);
  if (!sema) return null;

  const sonuc = sema.safeParse(mesaj);
  if (sonuc.success) return null;

  const issues = issueOzeti(sonuc.error?.issues);
  // Mesaj HANGİ ALANIN hatalı olduğunu SÖYLER. C# SDK'sı burada yalnızca
  // "An error occurred." diyor ve hata ayıklamayı imkânsızlaştırıyor; kötü
  // örneği tekrarlamıyoruz. Kanonik "Invalid params" öneki korunur.
  const detay = issues.length ? issues.map((i) => `${i.path} → ${i.message}`).join("; ") : "istek şemayı sağlamıyor";
  return { code: -32602, message: `Invalid params: ${detay}`, data: { issues } };
}

/**
 * Koruyucuyu bir transport'a takar. **`server.connect(transport)` ÇAĞRILDIKTAN
 * SONRA** çağrılmalıdır: Protocol.connect, `onmessage`'i kendi işleyicisiyle
 * DEĞİŞTİRİR — daha önce takarsak üzerimize yazar ve koruyucu hiç çalışmaz.
 */
export function parametreKoruyucusuTak(
  transport: KorunabilirTransport,
  secenekler: ParamsGuardSecenekleri = {},
  semalar: Map<string, SemaBenzeri> = V1_ISTEK_SEMALARI,
): void {
  const sdkOnMessage = transport.onmessage;
  if (typeof sdkOnMessage !== "function") {
    throw new Error("parametreKoruyucusuTak: transport.onmessage yok — connect()'ten SONRA çağrılmalı.");
  }

  transport.onmessage = ((mesaj: unknown, ek?: unknown) => {
    const hata = paramsHatasiBul(mesaj, semalar);
    if (!hata) {
      sdkOnMessage(mesaj as never, ek as never);
      return;
    }

    const m = mesaj as Record<string, unknown>;
    secenekler.onReject?.(String(m["method"]), m["id"], hata);
    // Geçersiz istek SDK'ya HİÇ ulaşmaz — ulaşsaydı -32603 üretirdi.
    void Promise.resolve(
      transport.send({ jsonrpc: "2.0", id: m["id"], error: hata } as never),
    ).catch((err) => secenekler.onSendError?.(err));
  }) as KorunabilirTransport["onmessage"];
}
