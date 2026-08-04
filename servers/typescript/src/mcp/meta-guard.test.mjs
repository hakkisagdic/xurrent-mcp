/**
 * `_meta` zarfı koruyucusunun testleri.
 *
 * NEDEN TEST ŞART: bu koruyucunun bozulması ÇÖKME ÜRETMEZ. Belirtisi yalnızca
 * "hata kodu -32602 yerine -32601" olur — sunucu çalışmaya devam eder, tek fark
 * geriye dönük uyumluluk sondasının v2 sunucuyu v1 sanmasıdır. Böyle bir
 * gerileme testsiz SESSİZCE geri gelir. Testler tam olarak o sayıya bakar.
 *
 * Kapsanan uyum maddeleri: Y2 / Y2b / Y3a / Y3b, ayrıca kırılmaması gereken
 * Y14b (-32022) ve Y15 (-32602 bozuk zarf) ile J2 / J6.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  classifyInboundRequest,
} from "@modelcontextprotocol/server";
import {
  ZORUNLU_ZARF_ANAHTARLARI,
  eksikZarfAnahtarlari,
  metaKoruyucusuTak,
  zarfKarariVer,
} from "../../dist/mcp/meta-guard.js";

const V2 = "2026-07-28";

function tamZarf(fazlalik = {}) {
  return {
    [PROTOCOL_VERSION_META_KEY]: V2,
    [CLIENT_CAPABILITIES_META_KEY]: { elicitation: {} },
    [CLIENT_INFO_META_KEY]: { name: "uyum-testi", version: "1.0.0" },
    ...fazlalik,
  };
}

function istek(method, params, id = 1) {
  return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

/** serveStdio() sonrası bir transport'u taklit eder: onmessage doludur, send toplar. */
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

// ── saf karar fonksiyonu ────────────────────────────────────────────────────

test("★ _meta'sız server/discover -32602 ile reddedilir — -32601 SPEC TUZAĞIDIR", () => {
  const karar = zarfKarariVer(istek("server/discover", {}));
  assert.equal(karar.tur, "reddet");
  assert.equal(
    karar.hata.code,
    -32602,
    "-32601 spec'te 'bu sunucu 2026 öncesi' sinyalidir; uyumluluk sondası v2 sunucuyu v1 sanar",
  );
});

test("★ mesaj HANGİ zarf anahtarının eksik olduğunu söyler", () => {
  const hicMeta = zarfKarariVer(istek("server/discover", {}));
  assert.deepEqual(hicMeta.hata.data.envelope.missing, ["_meta"]);
  assert.match(hicMeta.hata.message, /^Invalid params: /, "kanonik önek korunmalı");
  assert.match(hicMeta.hata.message, /_meta/);

  const zarf = tamZarf();
  delete zarf[PROTOCOL_VERSION_META_KEY];
  const surumsuz = zarfKarariVer(istek("server/discover", { _meta: zarf }));
  assert.equal(surumsuz.tur, "reddet");
  assert.deepEqual(surumsuz.hata.data.envelope.missing, [PROTOCOL_VERSION_META_KEY]);
  assert.match(surumsuz.hata.message, /io\.modelcontextprotocol\/protocolVersion/);
});

test('★ mesaj "metot yok DEĞİL" dediğini açıkça yazar', () => {
  const karar = zarfKarariVer(istek("server/discover", {}));
  assert.match(karar.hata.message, /server\/discover/, "hangi metot olduğu geçmeli");
  assert.match(karar.hata.message, /-32601/, "tuzağın adı mesajda geçmeli");
});

test("★ _meta.clientInfo YOKSA istek DOKUNULMADAN geçer (spec'te SHOULD — madde Y3b)", () => {
  const zarf = tamZarf();
  delete zarf[CLIENT_INFO_META_KEY];
  const karar = zarfKarariVer(istek("server/discover", { _meta: zarf }));
  assert.deepEqual(karar, { tur: "gec" }, "clientInfo'yu ZORUNLU kılmak spec'ten katı davranmaktır");
});

test("★ clientInfo ZORUNLU anahtarlar listesinde DEĞİLDİR", () => {
  assert.ok(!ZORUNLU_ZARF_ANAHTARLARI.includes(CLIENT_INFO_META_KEY));
  assert.deepEqual([...ZORUNLU_ZARF_ANAHTARLARI], [PROTOCOL_VERSION_META_KEY, CLIENT_CAPABILITIES_META_KEY]);
});

test("★ ZORUNLU anahtar listemiz SDK'nın kendi 'missing' raporuyla AYNI (sürüklenme koruması)", () => {
  // SDK zorunlu kümeyi HTTP tarafında `data.envelope.missing` olarak raporlar.
  // Sentetik bir modern header vererek o dalı tetikleyip listemizle karşılaştırırız;
  // SDK zorunluları değiştirirse mesajımız sessizce yanlışlaşmasın diye.
  const sdkRaporu = classifyInboundRequest({
    httpMethod: "POST",
    protocolVersionHeader: V2,
    body: istek("server/discover", { _meta: {} }),
  });
  assert.equal(sdkRaporu.kind, "reject");
  assert.deepEqual(sdkRaporu.data.envelope.missing, [...ZORUNLU_ZARF_ANAHTARLARI]);
  assert.deepEqual(eksikZarfAnahtarlari(istek("server/discover", { _meta: {} })), [...ZORUNLU_ZARF_ANAHTARLARI]);
});

test("zarf VAR ama bozuk → koruyucu DOKUNMAZ, kararı SDK verir (madde Y15)", () => {
  const zarf = tamZarf();
  delete zarf[CLIENT_CAPABILITIES_META_KEY];
  assert.deepEqual(zarfKarariVer(istek("server/discover", { _meta: zarf })), { tur: "gec" });
});

test("desteklenmeyen protokol sürümü → koruyucu DOKUNMAZ (SDK -32022 döndürür, madde Y14b)", () => {
  const zarf = tamZarf({ [PROTOCOL_VERSION_META_KEY]: "1999-01-01" });
  assert.deepEqual(zarfKarariVer(istek("server/discover", { _meta: zarf })), { tur: "gec" });
});

test("★ zarfsız initialize GERÇEK 2025 el sıkışmasıdır — reddedilmez", () => {
  const karar = zarfKarariVer(
    istek("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "eski-client", version: "1.0.0" },
    }),
  );
  assert.deepEqual(karar, { tur: "eski-el-sikismasi" });
});

test("★ id'siz istek (notification) ASLA yanıt üretmez — J6'yı kırardı", () => {
  assert.deepEqual(zarfKarariVer({ jsonrpc: "2.0", method: "notifications/initialized" }), { tur: "gec" });
  assert.deepEqual(zarfKarariVer({ jsonrpc: "2.0", method: "server/discover", params: {} }), { tur: "gec" });
});

test("yanıt mesajlarına ve çöp değerlere dokunulmaz", () => {
  assert.deepEqual(zarfKarariVer({ jsonrpc: "2.0", id: 4, result: {} }), { tur: "gec" });
  assert.deepEqual(zarfKarariVer(null), { tur: "gec" });
  assert.deepEqual(zarfKarariVer([1, 2, 3]), { tur: "gec" });
  assert.deepEqual(zarfKarariVer("merhaba"), { tur: "gec" });
});

test("tam zarflı tools/call dokunulmadan geçer", () => {
  const m = istek("tools/call", { name: "xurrent_whoami", arguments: {}, _meta: tamZarf() });
  assert.deepEqual(zarfKarariVer(m), { tur: "gec" });
});

// ── transport'a takılmış hâli ───────────────────────────────────────────────

test("★ zarfsız istek SDK'ya HİÇ ulaşmaz, yerine -32602 yazılır", () => {
  const { transport, sdkyaGidenler, gonderilenler } = sahteTransport();
  metaKoruyucusuTak(transport);
  transport.onmessage(istek("server/discover", {}));

  assert.equal(sdkyaGidenler.length, 0, "ulaşsaydı serveStdio bağlantıyı v1'e sabitler ve -32601 dönerdi");
  assert.equal(gonderilenler.length, 1);
  assert.equal(gonderilenler[0].jsonrpc, "2.0");
  assert.equal(gonderilenler[0].error.code, -32602);
});

test("★ yanıtın id'si isteğinkiyle AYNI ve AYNI TİPTE (J2 bozulmamalı)", () => {
  const { transport, gonderilenler } = sahteTransport();
  metaKoruyucusuTak(transport);
  transport.onmessage(istek("server/discover", {}, "uyum-string-id"));
  assert.equal(gonderilenler[0].id, "uyum-string-id");
  assert.equal(typeof gonderilenler[0].id, "string", "string id sayıya dönüşmemeli");
});

test("★ 2025 el sıkışmasından SONRA koruyucu SESSİZLEŞİR — eski client kırılmaz", () => {
  const { transport, sdkyaGidenler, gonderilenler } = sahteTransport();
  metaKoruyucusuTak(transport);

  const init = istek("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "eski-client", version: "1.0.0" },
  });
  const list = istek("tools/list", {}, 2);
  transport.onmessage(init);
  transport.onmessage(list); // zarfsız — ama bağlantı artık 2025 era'sında

  assert.deepEqual(sdkyaGidenler, [init, list], "el sıkışmadan sonra _meta beklemek YANLIŞ olurdu");
  assert.equal(gonderilenler.length, 0);
});

test("★ el sıkışma OLMADAN gelen zarfsız tools/list reddedilir", () => {
  // Bu, sessiz v1'e düşmenin ta kendisidir: 2025 client'ı ÖNCE initialize
  // göndermek ZORUNDADIR, dolayısıyla bu istek eksik bir v2 isteğidir.
  const { transport, sdkyaGidenler, gonderilenler } = sahteTransport();
  metaKoruyucusuTak(transport);
  transport.onmessage(istek("tools/list", {}, 7));
  assert.equal(sdkyaGidenler.length, 0);
  assert.equal(gonderilenler[0].error.code, -32602);
});

test("★ reddedilen istek SONRAKİ geçerli isteği zehirlemez (era bulaşması yok — madde Y3b)", () => {
  const { transport, sdkyaGidenler, gonderilenler } = sahteTransport();
  metaKoruyucusuTak(transport);

  const zarf = tamZarf();
  delete zarf[PROTOCOL_VERSION_META_KEY];
  transport.onmessage(istek("server/discover", { _meta: zarf }, 1)); // reddedilir

  const clientInfosuz = tamZarf();
  delete clientInfosuz[CLIENT_INFO_META_KEY];
  const ikinci = istek("server/discover", { _meta: clientInfosuz }, 2);
  transport.onmessage(ikinci);

  assert.deepEqual(sdkyaGidenler, [ikinci], "ilk red bağlantıyı v1'e sabitlememeli");
  assert.equal(gonderilenler.length, 1);
});

test("ikinci argüman (extra) SDK'ya olduğu gibi iletilir", () => {
  const gorulen = [];
  const transport = {
    onmessage: (mesaj, ek) => gorulen.push([mesaj, ek]),
    send: async () => {},
  };
  metaKoruyucusuTak(transport);
  const ek = { classification: { era: "modern", revision: V2 } };
  const m = istek("server/discover", { _meta: tamZarf() });
  transport.onmessage(m, ek);
  assert.equal(gorulen[0][1], ek, "extra kaybolursa sınıflandırma bilgisi düşer");
});

test("onReject geri çağrısı metot, id ve detayla çağrılır", () => {
  const { transport } = sahteTransport();
  const kayitlar = [];
  metaKoruyucusuTak(transport, { onReject: (metot, id, hata) => kayitlar.push([metot, id, hata.code]) });
  transport.onmessage(istek("server/discover", {}, 42));
  assert.deepEqual(kayitlar, [["server/discover", 42, -32602]]);
});

test("onLegacyPin geri çağrısı el sıkışmada BİR KEZ çağrılır", () => {
  const { transport } = sahteTransport();
  const kayitlar = [];
  metaKoruyucusuTak(transport, { onLegacyPin: (metot) => kayitlar.push(metot) });
  const init = istek("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "eski-client", version: "1.0.0" },
  });
  transport.onmessage(init);
  transport.onmessage(istek("tools/list", {}, 2));
  assert.deepEqual(kayitlar, ["initialize"]);
});

test("serveStdio'dan ÖNCE takmak HATA verir — sessizce etkisiz kalmaz", () => {
  // serveStdio onmessage'i KENDİ kuyruğuyla EZER. Erken takarsak koruyucu hiç
  // çalışmaz ve ihlal geri gelir; bunu çalışma anında sessizce kaybetmiyoruz.
  assert.throws(() => metaKoruyucusuTak({ send: async () => {} }), /serveStdio/);
});
