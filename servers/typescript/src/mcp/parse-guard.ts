/**
 * BOZUK JSON KORUYUCUSU — stdin ile SDK arasına girer.
 *
 * SORUN: JSON-RPC 2.0, ayrıştırılamayan bir gövdeye `-32700 Parse error`
 * dönmeyi ZORUNLU kılar. Hem `@modelcontextprotocol/sdk` (v1) hem
 * `@modelcontextprotocol/server` (v2) bozuk satırı SESSİZCE yutuyor: istemci
 * yanıt bekler, hiç gelmez, çağrı süresiz asılı kalır. Sessiz yutma, açık
 * hatadan kötüdür — istemci neyin yanlış olduğunu asla öğrenemez.
 *
 * NEDEN "SDK böyle yapıyor" bir mazeret DEĞİL: C# SDK'sı aynı senaryoda
 * `-32700` döndürüyor (scripts/mcp-uyum.mjs · madde J5). Yani davranış
 * protokolün değil, implementasyonun bir eksiği. Düzeltilebilir olduğunu
 * bir dil zaten kanıtlıyor.
 *
 * ÇÖZÜM: satırları SDK'ya ulaşmadan önce doğrula. Ayrıştırılabilenler
 * dokunulmadan geçer; ayrıştırılamayanlar düşürülür ve yerine spec'in
 * istediği hata yazılır. SDK'nın içine girmiyoruz, önüne geçiyoruz.
 */

import { Transform } from "node:stream";

/**
 * Bozuk gövdeden `id`'yi kurtarmayı dener.
 *
 * NEDEN uğraşıyoruz: spec, ayrıştırma hatasında `id: null` dönmeye izin verir,
 * ama istemcinin isteğini eşleştirebilmesi için gerçek id çok daha faydalıdır.
 * Kesilmiş bir mesajda (`{"jsonrpc":"2.0","id":991,"method":...`) id genellikle
 * sağlamdır — gövde sonradan kopmuştur. C# SDK'sı da bunu yapıyor.
 *
 * Kurtarılamıyorsa null döner; bu da spec'e uygundur.
 */
export function idKurtar(satir: string): string | number | null {
  const m = /"id"\s*:\s*(?:(-?\d+)|"((?:[^"\\]|\\.)*)")/.exec(satir);
  if (!m) return null;
  return m[1] !== undefined ? Number(m[1]) : m[2]!;
}

export interface ParseGuardSecenekleri {
  /** Hata yanıtının yazılacağı akış. Varsayılan process.stdout. */
  cikis?: NodeJS.WritableStream;
  /** Düşürülen satırı bildirmek için (stderr'e log). */
  onDrop?: (satir: string, id: string | number | null) => void;
}

/**
 * stdin → [koruyucu] → SDK
 *
 * Satır tabanlı çalışır çünkü stdio transport'u da satır tabanlıdır: her
 * JSON-RPC mesajı tek satırdır. Tamamlanmamış son parça tamponda bekletilir —
 * bir mesajın iki `data` olayına bölünmesi normaldir ve onu bozuk saymak
 * gerçek trafiği kırardı.
 */
export function createParseGuard(secenekler: ParseGuardSecenekleri = {}): Transform {
  const cikis = secenekler.cikis ?? process.stdout;
  let tampon = "";

  return new Transform({
    transform(parca, _kodlama, devam) {
      tampon += parca.toString("utf8");

      let i: number;
      while ((i = tampon.indexOf("\n")) >= 0) {
        const ham = tampon.slice(0, i);
        tampon = tampon.slice(i + 1);

        const satir = ham.trim();
        if (!satir) continue; // boş satır: transport'ta anlamsız, sessizce atlanır

        try {
          JSON.parse(satir);
        } catch {
          const id = idKurtar(satir);
          secenekler.onDrop?.(satir, id);
          cikis.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: {
                code: -32700,
                message: "Parse error: gövde geçerli JSON değil.",
              },
            }) + "\n",
          );
          continue; // bozuk satır SDK'ya HİÇ ulaşmaz
        }

        this.push(ham + "\n");
      }
      devam();
    },

    flush(devam) {
      // Akış kapanırken tamponda kalan varsa o da bir mesaj olamaz.
      const satir = tampon.trim();
      if (satir) {
        try {
          JSON.parse(satir);
          this.push(tampon);
        } catch {
          const id = idKurtar(satir);
          secenekler.onDrop?.(satir, id);
          cikis.write(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32700, message: "Parse error: gövde geçerli JSON değil." },
            }) + "\n",
          );
        }
      }
      devam();
    },
  });
}
