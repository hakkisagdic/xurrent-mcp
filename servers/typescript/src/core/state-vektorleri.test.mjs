/**
 * ★ ÇAPRAZ-DİL TAŞINABİLİRLİK KANITI — fixtures/state-vektorleri.json.
 *
 * NE KANITLIYOR: Paralel konteyner ölçümü, TS'in ürettiği requestState'in AYNI
 * sırrı taşıyan C# replikasında doğrulanAMAdığını buldu — üç dil aynı zarfı
 * kendi üslubuyla yazmıştı. Bu test, zarfı SABİT vektörlerle çivileyerek o hata
 * sınıfını kapatır: üç dil de aynı {secret, payloadJson} çiftinden BYTE BYTE
 * aynı token'ı üretmek ve o token'ı doğrulamak zorundadır.
 *
 * KRİTİK KURAL: payloadJson dizgesi OLDUĞU GİBİ imzalanır — yeniden
 * serileştirme YOK, çünkü anahtar sırası kanonik değildir. Testin encode ayağı
 * bu yüzden vektördeki dizgeyi verir, kendi JSON'unu üretmez.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { encodeSignedState, decodeSignedState } from "../../dist/core/confirm.js";
import { verifyWizardState } from "../../dist/core/wizard-state.js";
import { fixture } from "../_testkit.mjs";

const VEKTORLER = fixture("state-vektorleri.json").vektorler;

test("vektör dosyası en az bir vektör taşır (boş dosya sessizce 'hepsi geçti' demesin)", () => {
  assert.ok(Array.isArray(VEKTORLER) && VEKTORLER.length > 0);
});

for (const v of VEKTORLER) {
  test(`★ encode: ${v.aciklama} → token BYTE BYTE eşleşir`, () => {
    const uretilen = encodeSignedState(Buffer.from(v.secret, "utf8"), v.payloadJson);
    assert.equal(uretilen, v.token);
  });

  test(`★ verify: ${v.aciklama} → imza geçer ve payloadJson AYNEN geri çıkar`, () => {
    const r = decodeSignedState(Buffer.from(v.secret, "utf8"), v.token);
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    assert.equal(r.payloadJson, v.payloadJson);
  });

  test(`negatif: ${v.aciklama} → imzası kurcalanan token REDDEDİLİR`, () => {
    // İmza bölümünün ORTASINDAKİ haneyi değiştir: base64url'de son hanenin
    // bazı bitleri dolgu olduğundan orada değişiklik etkisiz kalabilirdi.
    const dot = v.token.lastIndexOf(".");
    const imza = v.token.slice(dot + 1);
    const i = Math.floor(imza.length / 2);
    const yeni = imza[i] === "A" ? "B" : "A";
    const bozuk = v.token.slice(0, dot + 1) + imza.slice(0, i) + yeni + imza.slice(i + 1);
    assert.notEqual(bozuk, v.token, "kurcalama etkisiz kaldı — test hatası");
    const r = decodeSignedState(Buffer.from(v.secret, "utf8"), bozuk);
    assert.equal(r.ok, false);
  });
}

test("wizard vektörü ÜRETİM doğrulama yolundan da geçer (verifyWizardState)", () => {
  // Zarf testi yetmez: üretim kodu payload'ı ayrıca şekil/exp süzgecinden
  // geçirir. Başka dilin ürettiği (vektördeki) token'ın buradan da geçmesi,
  // çok replikalı karma-dil dağıtımın çalıştığının kanıtıdır.
  const v = VEKTORLER.find((x) => JSON.parse(x.payloadJson).kind === "wizard");
  assert.ok(v, "wizard vektörü bulunamadı");
  const r = verifyWizardState({ stateSecret: v.secret, wizardTtlSeconds: 1800 }, v.token);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.equal(r.payload.step, JSON.parse(v.payloadJson).step);
});
