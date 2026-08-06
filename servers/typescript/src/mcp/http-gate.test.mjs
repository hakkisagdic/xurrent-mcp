/**
 * HTTP yüzeyi kapısının testi (WP6): API anahtarı karşılaştırıcısı + yol tablosu
 * + bağlanma duruşu. Saf fonksiyonlar http-gate.ts'te yaşar; http.ts (giriş
 * betiği) buradan HİÇ import edilmez — import etmek sunucuyu başlatırdı.
 *
 * Tam HTTP el sıkışma smoke'u merkezî olarak ayrıca koşulur; buradaki testler
 * kapının KARAR tablosunu sabitler.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { apiKeyOk, bindHost, resolvePathTarget } from "../../dist/mcp/http-gate.js";

// ── apiKeyOk ─────────────────────────────────────────────────────────────────

test("apiKeyOk: MCP_API_KEY boşsa kapı YOK — başlık ne olursa olsun geçer", () => {
  assert.equal(apiKeyOk("", undefined), true);
  assert.equal(apiKeyOk("", "her-sey"), true);
});

test("apiKeyOk: doğru anahtar geçer; yanlış/eksik/boş 401'e düşer", () => {
  assert.equal(apiKeyOk("deneme", "deneme"), true);
  assert.equal(apiKeyOk("deneme", "yanlis"), false);
  assert.equal(apiKeyOk("deneme", undefined), false);
  assert.equal(apiKeyOk("deneme", ""), false);
  // Uzunluk farkı da sabit-zamanlı yolda reddedilir (hash'ler karşılaştırılır).
  assert.equal(apiKeyOk("deneme", "deneme-ama-uzun"), false);
  assert.equal(apiKeyOk("deneme", "den"), false);
});

test("apiKeyOk: Node çok değerli başlığı dizi verirse İLK değer esas alınır", () => {
  assert.equal(apiKeyOk("deneme", ["deneme", "yanlis"]), true);
  assert.equal(apiKeyOk("deneme", ["yanlis", "deneme"]), false);
  assert.equal(apiKeyOk("deneme", []), false);
});

// ── resolvePathTarget: WP6 yol tablosu ───────────────────────────────────────

test("yol tablosu: tek era 2026-07-28 → /mcp ve /mcp/v2 v2'dir, /mcp/v1 404", () => {
  assert.equal(resolvePathTarget("/mcp", "2026-07-28"), "v2");
  assert.equal(resolvePathTarget("/mcp/v2", "2026-07-28"), "v2");
  assert.equal(resolvePathTarget("/mcp/v1", "2026-07-28"), null);
});

test("yol tablosu: tek era 2025-11-25 → /mcp ve /mcp/v1 v1'dir, /mcp/v2 404", () => {
  assert.equal(resolvePathTarget("/mcp", "2025-11-25"), "v1");
  assert.equal(resolvePathTarget("/mcp/v1", "2025-11-25"), "v1");
  assert.equal(resolvePathTarget("/mcp/v2", "2025-11-25"), null);
});

test("★ yol tablosu: both → v1 + v2 ayrı yollarda, /mcp v2'nin TAKMA ADIDIR (güncel spec kazanır)", () => {
  assert.equal(resolvePathTarget("/mcp/v1", "both"), "v1");
  assert.equal(resolvePathTarget("/mcp/v2", "both"), "v2");
  assert.equal(resolvePathTarget("/mcp", "both"), "v2");
});

test("yol tablosu: bilinmeyen yollar her modda 404", () => {
  for (const proto of ["2026-07-28", "2025-11-25", "both"]) {
    assert.equal(resolvePathTarget("/", proto), null);
    assert.equal(resolvePathTarget("/mcp/v3", proto), null);
    assert.equal(resolvePathTarget("/health", proto), null);
  }
});

// ── bindHost ─────────────────────────────────────────────────────────────────

test("bindHost: anahtar boş → yalnız loopback; dolu → 0.0.0.0 (kapı devrede)", () => {
  assert.equal(bindHost(""), "127.0.0.1");
  assert.equal(bindHost("deneme"), "0.0.0.0");
});
