/**
 * `_meta` ZARFI KORUYUCUSU — v2 (2026-07-28) stdio yolu için.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SORUN — "metot yok" ile "isteğin bozuk" AYNI KODLA anlatılıyordu.
 *
 * 2026-07-28 revizyonunda el sıkışma YOKTUR; her istek kendi `_meta` zarfını
 * taşır. Spec bu yüzden stdio'da `server/discover`'ı GERİYE DÖNÜK UYUMLULUK
 * SONDASI olarak önerir (bkz. contract/protocol.md · "Client tarafı"):
 *
 *     server/discover gönder
 *       ├─ başarılı            → sunucu v2
 *       └─ -32601 Method not found → sunucu 2026 ÖNCESİ; initialize'a düş
 *
 * Yani `-32601` bu bağlamda "bu sunucu v1" ANLAMINA GELİR. Eksik/bozuk bir
 * `_meta` için de aynı kodu döndürürsek iki durum AYIRT EDİLEMEZ hâle gelir ve
 * sonda, v2 konuşan bir sunucuyu v1 sanar. Bu repodaki sihirbaz gerçekten bu
 * hataya düştü (docs/12-mcp-uyum.md · madde Y2b).
 *
 * NEDEN OLUYORDU: `serveStdio` bağlantının era'sını AÇILIŞ MESAJINA bakarak
 * seçer ve `legacy: 'serve'` varsayılanıyla, zarf iddiası TAŞIMAYAN her mesajı
 * "2025-era trafiği" sayıp bağlantıyı v1 örneğine sabitler. v1 sunucusunda
 * `server/discover` diye bir metot yoktur → `-32601`. Kod teknik olarak
 * doğrudur; YANLIŞ OLAN, isteğin sessizce v1'e yönlendirilmesidir.
 *
 * İkinci ve daha sinsi sonuç: bu sabitleme BULAŞICIDIR. Sonda önce eksik
 * zarflı bir istek gönderirse bağlantı v1'e kilitlenir ve AYNI bağlantıdaki
 * SONRAKİ geçerli v2 istekleri de `-32601` alır. `_meta.clientInfo`'suz istek
 * bu yüzden reddediliyordu (madde Y3b) — clientInfo'nun kendisi hiç suçlu
 * değildi.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ÇÖZÜM — parse-guard.ts / params-guard.ts ile AYNI KALIP: SDK ile dövüşme,
 * ÖNÜNE geç. Üç koruyucu üç ayrı katmanda durur:
 *
 *     stdin → [parse-guard: BAYT/SATIR] → transport → [BU KORUYUCU: ERA/ZARF]
 *           → serveStdio → SDK örneği → [params-guard: ŞEMA (v1 yolunda)]
 *
 * ★ KRİTİK TASARIM KARARI: KARARI KENDİMİZ VERMİYORUZ. SDK'nın kendi public
 *   sınıflandırıcısını (`classifyInboundRequest`) çağırıyoruz — `serveStdio`
 *   açılış mesajını tam olarak bu kurallarla sınıflandırır. Bizim "eksik zarf"
 *   dediğimiz her mesaja SDK de "legacy/no-claim" der; farkımız yalnızca o
 *   mesaja ne YAPTIĞIMIZDIR: sessizce v1'e düşürmek yerine `-32602` ile
 *   "isteğin eksik" deriz. Sınıflandırma SDK'nın, karar bizim.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NEYE DOKUNMAZ (hepsi bilinçli):
 *
 *   • initialize (zarfsız)   → GERÇEK 2025 el sıkışmasıdır. Geçirilir ve
 *                              bağlantı "eski era" olarak işaretlenir; ondan
 *                              sonra koruyucu tamamen SESSİZLEŞİR. Eski bir
 *                              client v2 sürecine bağlanmaya devam edebilir.
 *   • zarf VAR ama bozuk     → SDK zaten `-32602` + hangi anahtarın bozuk
 *                              olduğunu döndürüyor (uyum Y15). Tekrarlamayız.
 *   • desteklenmeyen sürüm   → SDK `-32022` döndürüyor (uyum Y14b).
 *   • notification (id'siz)  → id'siz isteğe yanıt YASAKTIR (uyum J6).
 *   • yanıt mesajları        → koruyucunun işi değil.
 *   • HTTP transport'u       → orada `MCP-Protocol-Version` header'ı vardır ve
 *                              SDK aynı durumda ZATEN `-32602` döndürür.
 *                              Boşluk yalnızca stdio'da, çünkü orada header
 *                              katmanı yoktur — gövde tek sinyaldir.
 */

import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  classifyInboundRequest,
  isJSONRPCRequest,
} from "@modelcontextprotocol/server";
import type { KorunabilirTransport } from "./params-guard.js";

/**
 * 2026-07-28 zarfının ZORUNLU anahtarları.
 *
 * ★ `io.modelcontextprotocol/clientInfo` BİLEREK YOKTUR. Spec onu SHOULD
 *   tutar ("Clients SHOULD identify themselves on each request"), MUST değil.
 *   Zorunlu kılmak spec'ten KATI davranmak olurdu ve kendini tanıtmayan ama
 *   tamamen uyumlu bir client'ı kırardı (uyum maddesi Y3b).
 *
 * Anahtar adları SDK'nın kendi sabitlerinden gelir; elle yazılmış string yok.
 * meta-guard.test.mjs bu listeyi SDK'nın kendi "missing" raporuyla karşılaştırır,
 * böylece SDK'nın zorunlu kümesi değişirse test önce kırılır.
 */
export const ZORUNLU_ZARF_ANAHTARLARI: readonly string[] = [
  PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
];

export interface ZarfHatasi {
  code: number;
  message: string;
  data: { envelope: { missing: string[] } };
}

/** Koruyucunun bir mesaj için verdiği karar. */
export type ZarfKarari =
  | { tur: "gec" }
  /** Zarfsız `initialize` = 2025 el sıkışması. Geçir ve bağlantıyı eski era'ya sabitle. */
  | { tur: "eski-el-sikismasi" }
  | { tur: "reddet"; hata: ZarfHatasi };

function nesneMi(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Eksik ZORUNLU zarf anahtarlarını listeler.
 *
 * `_meta` hiç yoksa `["_meta"]` döner — SDK'nın HTTP tarafında ürettiği
 * `data.envelope.missing` ile aynı biçim, böylece iki taşıyıcının hata gövdesi
 * tek bir okuyucuyla ayrıştırılabilir.
 */
export function eksikZarfAnahtarlari(mesaj: unknown): string[] {
  const params = nesneMi(mesaj) ? mesaj["params"] : undefined;
  const meta = nesneMi(params) ? params["_meta"] : undefined;
  if (!nesneMi(meta)) return ["_meta"];
  return ZORUNLU_ZARF_ANAHTARLARI.filter((anahtar) => !(anahtar in meta));
}

/**
 * Mesajı SDK'nın kendi kurallarıyla sınıflandırır ve ne yapılacağını söyler.
 *
 * `httpMethod: "POST"` sentetiktir: `classifyInboundRequest` taşıyıcıdan
 * bağımsız bir GÖVDE sınıflandırıcısıdır ve stdio'da her mesaj bir POST
 * gövdesine denktir. Header ALANLARI KASITLI OLARAK BOŞ bırakılır — stdio'da
 * header yoktur ve uydurulmuş bir header, SDK'nın "header ile gövde çelişiyor"
 * dalını (-32020) yanlışlıkla tetiklerdi.
 */
export function zarfKarariVer(mesaj: unknown): ZarfKarari {
  // id'siz mesajlar (notification) ve yanıtlar dokunulmadan geçer.
  if (!isJSONRPCRequest(mesaj)) return { tur: "gec" };

  const sonuc = classifyInboundRequest({ httpMethod: "POST", body: mesaj });

  // "modern" → zarf geçerli, SDK servis etsin.
  // "reject" → SDK zaten doğru kodu üretiyor (bozuk zarf -32602, sürüm -32022).
  if (sonuc.kind !== "legacy") return { tur: "gec" };

  // Zarfsız initialize: tanımı gereği 2025 el sıkışması.
  if (sonuc.reason === "initialize") return { tur: "eski-el-sikismasi" };

  // stdio'da geriye kalan tek olasılık "no-claim"dir; diğer legacy sebepleri
  // (batch/response/http-method/notification) bu katmana ulaşamaz.
  if (sonuc.reason !== "no-claim") return { tur: "gec" };

  const missing = eksikZarfAnahtarlari(mesaj);
  return {
    tur: "reddet",
    hata: {
      code: -32602,
      message:
        `Invalid params: 2026-07-28 isteği zorunlu _meta zarfını taşımıyor — eksik anahtar(lar): ${missing.join(", ")}. ` +
        `Bu bir "metot yok" hatası DEĞİLDİR: ${String((mesaj as { method?: unknown }).method)} bu sunucuda vardır, eksik olan istektir. ` +
        `-32601 döndürseydik, geriye dönük uyumluluk sondası bu v2 sunucuyu v1 sanardı.`,
      data: { envelope: { missing } },
    },
  };
}

export interface MetaGuardSecenekleri {
  /** Reddedilen isteği bildirmek için (stderr'e log). */
  onReject?: (metot: string, id: unknown, hata: ZarfHatasi) => void;
  /** Eski era'ya sabitlendiğimizde bir kez çağrılır (stderr'e log). */
  onLegacyPin?: (metot: string) => void;
  /** Hata yanıtı gönderilemezse. */
  onSendError?: (err: unknown) => void;
}

/**
 * Koruyucuyu bir transport'a takar. **`serveStdio(...)` ÇAĞRILDIKTAN SONRA**
 * çağrılmalıdır: serveStdio `transport.onmessage`'i KENDİ kuyruğuyla
 * DEĞİŞTİRİR — daha önce takarsak üzerimize yazar ve koruyucu hiç çalışmaz.
 * (serveStdio atamayı senkron yapar; dönüşünden hemen sonra takmak güvenlidir.)
 *
 * Koruyucu, `serveStdio`'nun era sabitlemesini AYNADAN izler: bir kez gerçek
 * bir 2025 el sıkışması geçtiyse tamamen sessizleşir, çünkü o bağlantıda
 * `_meta` beklemek yanlış olurdu.
 */
export function metaKoruyucusuTak(
  transport: KorunabilirTransport,
  secenekler: MetaGuardSecenekleri = {},
): void {
  const sdkOnMessage = transport.onmessage;
  if (typeof sdkOnMessage !== "function") {
    throw new Error("metaKoruyucusuTak: transport.onmessage yok — serveStdio()'dan SONRA çağrılmalı.");
  }

  let eskiEra = false;

  transport.onmessage = ((mesaj: unknown, ek?: unknown) => {
    if (eskiEra) {
      sdkOnMessage(mesaj as never, ek as never);
      return;
    }

    const karar = zarfKarariVer(mesaj);

    if (karar.tur === "eski-el-sikismasi") {
      eskiEra = true;
      secenekler.onLegacyPin?.(String((mesaj as { method?: unknown }).method));
      sdkOnMessage(mesaj as never, ek as never);
      return;
    }

    if (karar.tur === "gec") {
      sdkOnMessage(mesaj as never, ek as never);
      return;
    }

    const m = mesaj as Record<string, unknown>;
    secenekler.onReject?.(String(m["method"]), m["id"], karar.hata);
    // Eksik zarflı istek serveStdio'ya HİÇ ulaşmaz — ulaşsaydı bağlantıyı
    // v1'e sabitler ve -32601 üretirdi.
    void Promise.resolve(
      transport.send({ jsonrpc: "2.0", id: m["id"], error: karar.hata } as never),
    ).catch((err) => secenekler.onSendError?.(err));
  }) as KorunabilirTransport["onmessage"];
}
