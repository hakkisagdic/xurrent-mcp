#!/usr/bin/env node
/**
 * probe:protocols — AYNI tool'u iki protokol revizyonu altında çalıştırıp
 * structuredContent'lerin BİREBİR aynı olduğunu kanıtlar.
 *
 * Sihirbazın 13. adımı bunun tek bir tool için yapılan hâlidir; bu script
 * tabloyu sekiz tool'a genişletir. Hiçbir şey taklit edilmez: her satır için
 * gerçek bir MCP client + gerçek bir MCP server çifti kurulur — bkz.
 * src/mcp/protocols.ts.
 *
 * Kullanım:  npm run build && npm run probe:protocols
 */

import { loadConfig } from "../dist/config.js";
import { createToolContext } from "../dist/core/context.js";
import { createXurrentAdapter } from "../dist/xurrent/index.js";
import { AVAILABLE_PROTOCOLS, runUnderProtocol } from "../dist/mcp/protocols.js";

const cfg = loadConfig();
// Onay bu senaryoda sorulmaz (hepsi okuma veya dryRun) — yine de bir fonksiyon şart.
const ctx = createToolContext(cfg, createXurrentAdapter(cfg), async () => ({ action: "accept" }));

const CASES = [
  ["xurrent_whoami", {}],
  ["xurrent_find_person", { email: "ayse.demir@ornek.com" }],
  ["xurrent_list_open_work", { personId: "$me" }],
  ["xurrent_get_time_tracking_context", { personId: "$me" }],
  ["calendar_list_today", { provider: "mock" }],
  ["plan_time_entries_from_calendar", { personId: "$me" }],
  [
    "xurrent_create_time_entry",
    {
      targetType: "request",
      targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4",
      minutes: 60,
      description: "Protokol karsilastirma",
      dryRun: true,
    },
  ],
  [
    "xurrent_create_time_entries_bulk",
    {
      entries: [
        { targetType: "request", targetId: "TW9jay9SZXF1ZXN0LzcwMjQ4", minutes: 60 },
        { targetType: "request", targetId: "TW9jay9SZXF1ZXN0LzcwMzAx", minutes: 30 },
      ],
      dryRun: true,
    },
  ],
];

console.log(`Kurulu protokol adaptörleri: ${AVAILABLE_PROTOCOLS.join(", ")}\n`);

let allSame = true;
for (const [tool, args] of CASES) {
  const outputs = [];
  for (const protocol of AVAILABLE_PROTOCOLS) {
    outputs.push(JSON.stringify(await runUnderProtocol(ctx, protocol, tool, args)));
  }
  const same = outputs.every((o) => o === outputs[0]);
  allSame &&= same;
  console.log(`${same ? "BİREBİR AYNI" : "FARKLI      "}  ${tool}  (${outputs[0].length} karakter)`);
  if (!same) {
    console.log(`  ${AVAILABLE_PROTOCOLS[0]}: ${outputs[0].slice(0, 400)}`);
    console.log(`  ${AVAILABLE_PROTOCOLS[1]}: ${outputs[1].slice(0, 400)}`);
  }
}

console.log(
  "\n" +
    (allSame
      ? "SONUÇ: Sekiz tool'un tamamı iki protokolde AYNI structuredContent'i üretti.\n" +
        "       Değişen tek şey onayın sorulma biçimiydi — sözleşme bozulmadı."
      : "SONUÇ: AYRIŞMA VAR — protokol kabuğu iş mantığına sızmış demektir."),
);
process.exit(allSame ? 0 : 1);
