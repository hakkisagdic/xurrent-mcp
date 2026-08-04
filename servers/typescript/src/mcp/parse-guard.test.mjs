/**
 * Bozuk JSON koruyucusunun testleri.
 *
 * Bu koruyucu bir SPEC İHLALİNİ kapatmak için var (JSON-RPC MUST: -32700).
 * Sessizce bozulursa ihlal geri gelir ve kimse fark etmez — çünkü ihlalin
 * belirtisi "hiçbir şey olmaması"dır. Testleri o yüzden var.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createParseGuard, idKurtar } from "../../dist/mcp/parse-guard.js";

/** Yazılanları toplayan sahte çıkış. */
function yakalayici() {
  const yazilanlar = [];
  const akis = new Writable({
    write(parca, _k, devam) { yazilanlar.push(parca.toString()); devam(); },
  });
  return { akis, yazilanlar };
}

/** Koruyucudan geçen satırları ve üretilen hataları toplar. */
async function suz(girdiler) {
  const { akis, yazilanlar } = yakalayici();
  const guard = createParseGuard({ cikis: akis });
  const gecenler = [];
  guard.on("data", (d) => gecenler.push(d.toString()));

  for (const g of girdiler) guard.write(g);
  guard.end();
  await new Promise((r) => guard.on("end", r));

  return {
    gecenler: gecenler.join("").split("\n").filter(Boolean),
    hatalar: yazilanlar.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
  };
}

test("geçerli JSON satırı DEĞİŞTİRİLMEDEN geçer", async () => {
  const mesaj = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const { gecenler, hatalar } = await suz([mesaj + "\n"]);
  assert.deepEqual(gecenler, [mesaj]);
  assert.equal(hatalar.length, 0, "geçerli satır için hata üretilmemeli");
});

test("bozuk satır DÜŞÜRÜLÜR ve yerine -32700 yazılır", async () => {
  const { gecenler, hatalar } = await suz(['{"jsonrpc":"2.0","id":991,"method":"tools/list","params":\n']);
  assert.equal(gecenler.length, 0, "bozuk satır SDK'ya ulaşmamalı");
  assert.equal(hatalar.length, 1);
  assert.equal(hatalar[0].error.code, -32700);
  assert.equal(hatalar[0].jsonrpc, "2.0");
});

test("★ kesilmiş mesajdan id KURTARILIR — istemci isteğini eşleştirebilsin", async () => {
  const { hatalar } = await suz(['{"jsonrpc":"2.0","id":991,"method":"tools/list","params":\n']);
  assert.equal(hatalar[0].id, 991, "id kurtarılabiliyorken null dönmek işe yaramaz");
});

test("id hiç yoksa null döner — spec buna izin verir", async () => {
  const { hatalar } = await suz(["bu hiç JSON değil\n"]);
  assert.equal(hatalar[0].id, null);
});

test("string id de kurtarılır", async () => {
  const { hatalar } = await suz(['{"id":"abc-7","method":\n']);
  assert.equal(hatalar[0].id, "abc-7");
});

test("★ iki data olayına BÖLÜNMÜŞ geçerli mesaj bozuk sayılmaz", async () => {
  // Gerçek trafikte bir mesaj birden çok chunk'a bölünür. Tamponu yanlış
  // yönetmek, çalışan bir sunucuyu her büyük istekte kıracak bir hata olurdu.
  const mesaj = JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/call" });
  const orta = Math.floor(mesaj.length / 2);
  const { gecenler, hatalar } = await suz([mesaj.slice(0, orta), mesaj.slice(orta) + "\n"]);
  assert.deepEqual(gecenler, [mesaj]);
  assert.equal(hatalar.length, 0);
});

test("bozuk satır SONRAKİ geçerli satırı etkilemez", async () => {
  const iyi = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const { gecenler, hatalar } = await suz(["{bozuk\n", iyi + "\n"]);
  assert.deepEqual(gecenler, [iyi], "kurtarma sonrası akış devam etmeli");
  assert.equal(hatalar.length, 1);
});

test("boş satırlar sessizce atlanır, hata üretmez", async () => {
  const { gecenler, hatalar } = await suz(["\n", "   \n"]);
  assert.equal(gecenler.length, 0);
  assert.equal(hatalar.length, 0, "boş satır bozuk JSON değildir");
});

test("akış kapanırken tamponda kalan bozuk parça da -32700 üretir", async () => {
  const { hatalar } = await suz(['{"id":3,"method":"x"']); // sonda \n YOK
  assert.equal(hatalar.length, 1);
  assert.equal(hatalar[0].id, 3);
});

test("idKurtar negatif sayıyı da okur", () => {
  assert.equal(idKurtar('{"id":-4,'), -4);
});
