/**
 * Geçersiz params koruyucusunun testleri.
 *
 * parse-guard.test.mjs ile aynı gerekçe: bu koruyucu bir SPEC İHLALİNİ kapatıyor
 * (JSON-RPC MUST: -32602). Sessizce bozulursa ihlal geri gelir ve kimse fark
 * etmez — çünkü ihlalin belirtisi "yanlış bir sayı" olmasıdır, çökme değil.
 * Testler tam olarak o sayıya bakar.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { paramsHatasiBul, parametreKoruyucusuTak, V1_ISTEK_SEMALARI } from "../../dist/mcp/params-guard.js";

/** connect() sonrası bir transport'u taklit eder: onmessage doludur, send toplar. */
function sahteTransport() {
  const sdkyaGidenler = [];
  const gonderilenler = [];
  const transport = {
    onmessage: (mesaj) => sdkyaGidenler.push(mesaj),
    send: async (mesaj) => {
      gonderilenler.push(mesaj);
    },
  };
  return { transport, sdkyaGidenler, gonderilenler };
}

const GECERLI_CALL = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "xurrent_whoami", arguments: {} },
};
const NAMESIZ_CALL = { jsonrpc: "2.0", id: 42, method: "tools/call", params: { arguments: {} } };

// ── saf karar fonksiyonu ────────────────────────────────────────────────────

test("★ tools/call name YOKken -32602 üretilir (uyum maddesi J4)", () => {
  const hata = paramsHatasiBul(NAMESIZ_CALL, V1_ISTEK_SEMALARI);
  assert.ok(hata, "eksik `name` yakalanmalı");
  assert.equal(hata.code, -32602, "-32603 (Internal error) SPEC İHLALİDİR");
});

test("★ hata mesajı HANGİ ALANIN hatalı olduğunu söyler", () => {
  // C# SDK'sı burada yalnızca "An error occurred." diyor; o kötü örneği
  // tekrarlamadığımızın testi budur.
  const hata = paramsHatasiBul(NAMESIZ_CALL, V1_ISTEK_SEMALARI);
  assert.match(hata.message, /^Invalid params: /, "kanonik önek korunmalı");
  assert.match(hata.message, /params\.name/, "eksik alanın adı mesajda geçmeli");
  assert.equal(hata.data.issues[0].path, "params.name");
});

test("geçerli tools/call hiç hata üretmez", () => {
  assert.equal(paramsHatasiBul(GECERLI_CALL, V1_ISTEK_SEMALARI), null);
});

test("geçerli tools/list (params'sız) hata üretmez", () => {
  assert.equal(paramsHatasiBul({ jsonrpc: "2.0", id: 2, method: "tools/list" }, V1_ISTEK_SEMALARI), null);
});

test("★ id'siz istek (notification) ASLA yanıt üretmez — J6'yı kırardı", () => {
  const bildirim = { jsonrpc: "2.0", method: "tools/call", params: { arguments: {} } };
  assert.equal(paramsHatasiBul(bildirim, V1_ISTEK_SEMALARI), null);
});

test("listede olmayan metoda dokunulmaz — -32601 kararı SDK'nındır", () => {
  const istek = { jsonrpc: "2.0", id: 3, method: "uyum/bilinmeyen-metot", params: {} };
  assert.equal(paramsHatasiBul(istek, V1_ISTEK_SEMALARI), null);
});

test("yanıt mesajlarına (method yok) dokunulmaz", () => {
  assert.equal(paramsHatasiBul({ jsonrpc: "2.0", id: 4, result: {} }, V1_ISTEK_SEMALARI), null);
  assert.equal(paramsHatasiBul(null, V1_ISTEK_SEMALARI), null);
  assert.equal(paramsHatasiBul([1, 2, 3], V1_ISTEK_SEMALARI), null);
});

test("params.name yanlış TİPTE olduğunda da -32602", () => {
  const istek = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: 7 } };
  const hata = paramsHatasiBul(istek, V1_ISTEK_SEMALARI);
  assert.equal(hata.code, -32602);
});

// ── transport'a takılmış hâli ───────────────────────────────────────────────

test("★ geçersiz istek SDK'ya HİÇ ulaşmaz, yerine -32602 yazılır", () => {
  const { transport, sdkyaGidenler, gonderilenler } = sahteTransport();
  parametreKoruyucusuTak(transport);
  transport.onmessage(NAMESIZ_CALL);

  assert.equal(sdkyaGidenler.length, 0, "SDK'ya ulaşsaydı -32603 üretirdi");
  assert.equal(gonderilenler.length, 1);
  assert.equal(gonderilenler[0].error.code, -32602);
  assert.equal(gonderilenler[0].jsonrpc, "2.0");
});

test("★ yanıtın id'si isteğinkiyle AYNI ve AYNI TİPTE (J2 bozulmamalı)", () => {
  const { transport, gonderilenler } = sahteTransport();
  parametreKoruyucusuTak(transport);
  transport.onmessage({ ...NAMESIZ_CALL, id: "uyum-string-id" });
  assert.equal(gonderilenler[0].id, "uyum-string-id");
  assert.equal(typeof gonderilenler[0].id, "string", "string id sayıya dönüşmemeli");
});

test("★ geçerli istek DEĞİŞTİRİLMEDEN SDK'ya geçer", () => {
  const { transport, sdkyaGidenler, gonderilenler } = sahteTransport();
  parametreKoruyucusuTak(transport);
  transport.onmessage(GECERLI_CALL);
  assert.deepEqual(sdkyaGidenler, [GECERLI_CALL]);
  assert.equal(gonderilenler.length, 0, "geçerli istek için hata yazılmamalı");
});

test("★ geçersiz istek SONRAKİ geçerli isteği zehirlemez", () => {
  const { transport, sdkyaGidenler, gonderilenler } = sahteTransport();
  parametreKoruyucusuTak(transport);
  transport.onmessage(NAMESIZ_CALL);
  transport.onmessage(GECERLI_CALL);
  assert.deepEqual(sdkyaGidenler, [GECERLI_CALL], "red sonrası akış devam etmeli");
  assert.equal(gonderilenler.length, 1);
});

test("ikinci argüman (extra) SDK'ya olduğu gibi iletilir", () => {
  const gorulen = [];
  const transport = {
    onmessage: (mesaj, ek) => gorulen.push([mesaj, ek]),
    send: async () => {},
  };
  parametreKoruyucusuTak(transport);
  const ek = { authInfo: { sub: "kullanici" } };
  transport.onmessage(GECERLI_CALL, ek);
  assert.equal(gorulen[0][1], ek, "extra kaybolursa authInfo/requestInfo düşer");
});

test("onReject geri çağrısı metot, id ve detayla çağrılır", () => {
  const { transport } = sahteTransport();
  const kayitlar = [];
  parametreKoruyucusuTak(transport, { onReject: (metot, id, hata) => kayitlar.push([metot, id, hata.code]) });
  transport.onmessage(NAMESIZ_CALL);
  assert.deepEqual(kayitlar, [["tools/call", 42, -32602]]);
});

test("connect'ten ÖNCE takmak HATA verir — sessizce etkisiz kalmaz", () => {
  // Protocol.connect onmessage'i EZER. Erken takarsak koruyucu hiç çalışmaz ve
  // ihlal geri gelir; bunu çalışma anında sessizce kaybetmek yerine patlatıyoruz.
  assert.throws(() => parametreKoruyucusuTak({ send: async () => {} }), /connect/);
});
