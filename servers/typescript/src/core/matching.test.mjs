/**
 * ★ TOPLANTI → TICKET EŞLEŞTİRMESİNİN BİRİM TESTİ.
 *
 * NE KANITLIYOR: Üç eşleşme yolu (kesin / bulanık / hiçbiri) ve dördüncü durum
 * (belirsiz) ölçülebiliyor; en önemlisi bot BELİRSİZLİKTE TAHMİN ETMİYOR.
 *
 * Bu mantık runPlanFromCalendar'ın içindeyken yalnızca takvim + açık iş listesi
 * + ağ üçlüsüyle birlikte çalışabiliyordu; matchMeetingToWork olarak ayrıldıktan
 * sonra tamamen SAF: girdi iki dizi, çıktı bir karar.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { matchMeetingToWork, normalizeTokens, similarity } from "../../dist/core/toolimpl.js";
import { makeWorkItem, openWorkItems } from "../_testkit.mjs";

const FALLBACK = {
  targetType: "time_allocation",
  targetId: "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
  targetLabel: "İç toplantılar",
};

const ISLER = openWorkItems();

// ─────────────────────────────────────────────────────────────────────────────
// YOL 1 — başlıkta ticket numarası → KESİN eşleşme
// ─────────────────────────────────────────────────────────────────────────────

test("★ başlıkta ticket numarası varsa kesin eşleşme ve matchConfidence tam 1.0 olur", () => {
  const r = matchMeetingToWork("REQ-70248 performans incelemesi", ISLER, FALLBACK);
  assert.equal(r.kind, "exact");
  assert.equal(r.matchConfidence, 1);
  assert.equal(r.needsUserDecision, false);
  assert.equal(r.targetId, "TW9jay9SZXF1ZXN0LzcwMjQ4");
  assert.equal(r.targetType, "request");
});

test("★ numara eşleşmesi metin benzerliğini EZER (başlık konuyla ilgisiz olsa bile)", () => {
  // #70248'in konusu "Masraf beyanı ekranı çok yavaş açılıyor" — başlıkla hiç
  // örtüşmüyor. Yine de numara kesin sinyaldir.
  const r = matchMeetingToWork("70248 hakkında kısa görüşme", ISLER, FALLBACK);
  assert.equal(r.kind, "exact");
  assert.ok(r.targetLabel.startsWith("#70248"));
});

test("kesin eşleşmenin gerekçesi numarayı AÇIKÇA söyler", () => {
  const r = matchMeetingToWork("REQ-70248 performans incelemesi", ISLER, FALLBACK);
  assert.ok(r.matchReason.includes("70248") && r.matchReason.includes("kesin eşleşme"));
});

test("Task numarası da kesin eşleşir (yalnızca Request değil)", () => {
  const r = matchMeetingToWork("4419 log incelemesi", ISLER, FALLBACK);
  assert.equal(r.kind, "exact");
  assert.equal(r.targetType, "task");
});

test("4 haneden kısa / 6 haneden uzun sayı kesin eşleşme TETİKLEMEZ", () => {
  const isler = [makeWorkItem("123", "Kısa numaralı kayıt"), makeWorkItem("1234567", "Uzun numaralı kayıt")];
  assert.notEqual(matchMeetingToWork("123 toplantısı", isler, FALLBACK).kind, "exact");
  assert.notEqual(matchMeetingToWork("1234567 toplantısı", isler, FALLBACK).kind, "exact");
});

test("başlıktaki sayı hiçbir açık işe ait değilse kesin eşleşme OLMAZ", () => {
  const r = matchMeetingToWork("99999 numaralı toplantı", ISLER, FALLBACK);
  assert.notEqual(r.kind, "exact");
});

// ─────────────────────────────────────────────────────────────────────────────
// YOL 2 — metin benzerliği → BULANIK eşleşme
// ─────────────────────────────────────────────────────────────────────────────

test("★ metin benzerliği bulanık eşleşme üretir; güven 1.0 DEĞİLDİR", () => {
  const r = matchMeetingToWork("Onboarding otomasyonu tasarım toplantısı", ISLER, FALLBACK);
  assert.equal(r.kind, "fuzzy");
  assert.equal(r.targetId, "TW9jay9SZXF1ZXN0LzcwMzE1");
  assert.ok(r.matchConfidence > 0 && r.matchConfidence < 1, `güven: ${r.matchConfidence}`);
  assert.equal(r.needsUserDecision, false);
  assert.ok(r.matchReason.includes("BULANIK"), "bulanık olduğu kullanıcıya söylenmeli");
});

test("bulanık eşleşme ambiguityWarning ÜRETMEZ", () => {
  const r = matchMeetingToWork("Onboarding otomasyonu tasarım toplantısı", ISLER, FALLBACK);
  assert.equal(r.ambiguityWarning, null);
});

test("Türkçe ek farkı eşleşmeyi bozmaz ('analiz' ~ 'analizi')", () => {
  const isler = [makeWorkItem("70999", "VPN concentrator log analizi")];
  const r = matchMeetingToWork("VPN concentrator log analiz", isler, FALLBACK);
  assert.equal(r.kind, "fuzzy");
});

// ─────────────────────────────────────────────────────────────────────────────
// YOL 3 — iki aday yakın → KULLANICI KARAR VERSİN
// ─────────────────────────────────────────────────────────────────────────────

test("★ iki aday benzer skorda ise needsUserDecision=true — bot ASLA tahmin etmez", () => {
  const r = matchMeetingToWork("VPN kopma sorunu kök neden analizi", ISLER, FALLBACK);
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.needsUserDecision, true);
});

test("belirsizlikte HER İKİ adayın adı ve skoru uyarıya yazılır", () => {
  const r = matchMeetingToWork("VPN kopma sorunu kök neden analizi", ISLER, FALLBACK);
  assert.ok(typeof r.ambiguityWarning === "string" && r.ambiguityWarning.length > 0);
  assert.ok(r.ambiguityWarning.includes("VPN concentrator loglarını analiz et"));
  assert.ok(r.ambiguityWarning.includes("VPN bağlantısı gün içinde sürekli kopuyor"));
  assert.ok(r.ambiguityWarning.includes("kullanıcıya SORMALI"));
});

test("belirsizlikte yine de EN YÜKSEK skorlu aday önerilir (öneri var, karar yok)", () => {
  const r = matchMeetingToWork("VPN kopma sorunu kök neden analizi", ISLER, FALLBACK);
  assert.ok(r.targetId !== null, "öneri boş bırakılmaz");
  assert.ok(r.matchReason.includes("karar kullanıcıya ait"));
});

test("skor farkı belirsizlik bandından (0.15) BÜYÜKSE karar kullanıcıya bırakılmaz", () => {
  const isler = [
    makeWorkItem("70801", "Onboarding otomasyonu tasarım kararları listesi"),
    makeWorkItem("70802", "Yazıcı sürücüsü"),
  ];
  const r = matchMeetingToWork("Onboarding otomasyonu tasarım", isler, FALLBACK);
  assert.equal(r.kind, "fuzzy");
  assert.equal(r.needsUserDecision, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// YOL 4 — hiçbiri → varsayılan TimeAllocation
// ─────────────────────────────────────────────────────────────────────────────

test("★ hiçbir işle eşleşmeyen toplantı needsUserDecision=true + varsayılan TimeAllocation önerir", () => {
  const r = matchMeetingToWork("Günlük standup", ISLER, FALLBACK);
  assert.equal(r.kind, "none");
  assert.equal(r.needsUserDecision, true);
  assert.equal(r.matchConfidence, 0);
  assert.equal(r.targetType, "time_allocation");
  assert.equal(r.targetId, FALLBACK.targetId);
  assert.equal(r.targetLabel, FALLBACK.targetLabel);
});

test("eşleşmeyen toplantının gerekçesi 'TAHMİN değil, güvenli varsayılan' der", () => {
  const r = matchMeetingToWork("Günlük standup", ISLER, FALLBACK);
  assert.ok(r.matchReason.includes("TAHMİN değil"));
});

test("açık iş listesi BOŞ ise her toplantı varsayılana düşer", () => {
  const r = matchMeetingToWork("REQ-70248 performans incelemesi", [], FALLBACK);
  assert.equal(r.kind, "none");
  assert.equal(r.targetId, FALLBACK.targetId);
});

test("zayıf benzerlik (eşik 0.30 altı) eşleşme SAYILMAZ", () => {
  const isler = [makeWorkItem("70900", "Sunucu disk genişletme talebi kapsam çalışması ekip planı")];
  const r = matchMeetingToWork("Kahve molası", isler, FALLBACK);
  assert.equal(r.kind, "none");
});

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizasyon ve benzerlik — eşleşmenin altındaki iki saf fonksiyon
// ─────────────────────────────────────────────────────────────────────────────

test("normalizeTokens Türkçe'ye duyarlı küçültme yapar (I → ı, İ → i)", () => {
  assert.deepEqual(normalizeTokens("İNDEKS ÇALIŞMASI"), ["indeks", "çalışması"]);
});

test("normalizeTokens noktalama ve 3 karakterden kısa kelimeleri atar", () => {
  assert.deepEqual(normalizeTokens("1:1 — Mehmet Kaya!"), ["mehmet", "kaya"]);
});

test("normalizeTokens durak kelimeleri (ile, için, ve) atar", () => {
  assert.deepEqual(normalizeTokens("VPN ile bağlantı için toplantı"), ["vpn", "bağlantı", "toplantı"]);
});

test("similarity aynı token kümesinde 1.0 döner", () => {
  assert.equal(similarity(["vpn", "analiz"], ["vpn", "analiz"]), 1);
});

test("similarity boş kümede 0 döner (sıfıra bölme yok)", () => {
  assert.equal(similarity([], ["vpn"]), 0);
  assert.equal(similarity(["vpn"], []), 0);
});

test("similarity simetriktir", () => {
  const a = normalizeTokens("VPN bağlantısı sürekli kopuyor");
  const b = normalizeTokens("VPN kopma sorunu analizi");
  assert.equal(similarity(a, b), similarity(b, a));
});

test("★ kısa kelimeler gevşek eşleşmez ('gün' ile 'günlük' aynı sayılmaz)", () => {
  // Gevşetilseydi her toplantı her ticket'a benzerdi.
  assert.equal(similarity(["gün"], ["günlük"]), 0);
});

test("eşleştirici SAF: girdi dizilerini mutasyona uğratmaz ve tekrarlanabilir", () => {
  const isler = openWorkItems();
  const once = JSON.stringify(isler);
  const a = matchMeetingToWork("VPN kopma sorunu kök neden analizi", isler, FALLBACK);
  const b = matchMeetingToWork("VPN kopma sorunu kök neden analizi", isler, FALLBACK);
  assert.equal(JSON.stringify(isler), once, "açık iş listesi DEĞİŞMEMELİ");
  assert.deepEqual(a, b);
});
