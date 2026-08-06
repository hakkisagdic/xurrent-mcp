// -----------------------------------------------------------------------------
// clients/cli/lib/tui.mjs — xmcp chat'in Ink arayüzü
//
// İNCE HOST İLKESİ: bu dosyada SIFIR iş mantığı vardır. Sohbetin beyni sunucudaki
// timesheet_wizard durum makinesidir (contract/wizard.md); buradaki tek görev
// reply + nextQuestion'ı göstermek ve cevabı utterance + sessionState olarak
// AYNEN geri göndermek. Aynı döngünün düz-metin hâli xmcp.mjs:chatPlain'dedir —
// TUI yalnızca sunumdur, sözleşme değişmez.
//
// NEDEN JSX YOK: derleme adımı istemiyoruz — node bu dosyayı doğrudan çalıştırır.
// React.createElement (aşağıda `h`) aynı ağacı üretir; Ink için fark yoktur.
// Geçmiş turlar <Static> ile terminalin doğal kaydırma geçmişine akıtılır:
// transcript, terminalin scrollback'i kadar uzundur.
// -----------------------------------------------------------------------------

import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, Static, useApp, useInput } from "ink";
import { extractStructured } from "./rpc.mjs";
import { writeResultLines } from "./format.mjs";

const h = React.createElement;

const KIND_COLOR = { bot: "cyan", user: "green", info: undefined, err: "red" };

function ChatApp({ client, serverLabel, report }) {
  const [entries, setEntries] = useState([]);
  const [question, setQuestion] = useState(null);
  const [step, setStep] = useState("start");
  const [busy, setBusy] = useState(true);
  const [input, setInput] = useState("");
  const [sel, setSel] = useState(0);
  const [done, setDone] = useState(false);
  const stateRef = useRef(null); // imzalı sessionState — opak, AYNEN geri gider
  const keyRef = useRef(0);
  const { exit } = useApp();

  const push = useCallback((kind, text) => {
    const key = `e${keyRef.current++}`;
    setEntries((es) => [...es, { key, kind, text }]);
  }, []);

  const handle = useCallback(
    (data) => {
      push("bot", `[${data.step}] ${data.reply ?? ""}`);
      for (const e of data.errors ?? []) push("err", `hata: ${e?.message ?? JSON.stringify(e)}`);
      setStep(data.step);
      if (data.done) {
        if (data.writeResult) {
          push("info", "── Yazma sonucu ──");
          for (const ln of writeResultLines(data.writeResult)) push("info", "  " + ln);
        }
        setDone(true);
        setQuestion(null);
        const bad = (data.writeResult?.errors ?? []).length > 0;
        report(bad ? 1 : 0);
        // Son kareyi çizmeye fırsat tanı, sonra kapan.
        setTimeout(() => exit(), 80);
        return;
      }
      stateRef.current = data.sessionState ?? null;
      setQuestion(data.nextQuestion ?? null);
      setSel(0);
      setInput("");
    },
    [push, report, exit],
  );

  const send = useCallback(
    async (utterance) => {
      setBusy(true);
      try {
        const params = utterance == null ? {} : { utterance, sessionState: stateRef.current };
        const result = await client.callTool("timesheet_wizard", params);
        const { data } = extractStructured(result);
        if (!data) {
          push("err", "wizard yanıtı ayrıştırılamadı (structuredContent yok).");
          report(1);
          setTimeout(() => exit(), 80);
          return;
        }
        handle(data);
      } catch (e) {
        push("err", String(e?.message ?? e));
        report(1);
        setTimeout(() => exit(), 80);
      } finally {
        setBusy(false);
      }
    },
    [client, handle, push, report, exit],
  );

  // İlk çağrı: boş input — sunucu selamlar ve ilk soruyu döner.
  useEffect(() => {
    send(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = useCallback(
    (text) => {
      push("user", `› ${text}`);
      send(text);
    },
    [push, send],
  );

  useInput((ch, key) => {
    if (busy || done) return;
    const choices = question?.choices ?? [];
    // Yazılmış serbest metin her zaman kazanır; girdi boşsa seçili choice gider.
    const submitCurrent = (extra = "") => {
      const typed = (input + extra).trim();
      setInput("");
      if (typed) return submit(typed);
      if (choices.length) return submit(choices[sel]?.id ?? String(sel + 1));
    };
    if (key.return) return submitCurrent();
    if (key.upArrow && choices.length) return setSel((s) => (s - 1 + choices.length) % choices.length);
    if (key.downArrow && choices.length) return setSel((s) => (s + 1) % choices.length);
    if (key.backspace || key.delete) return setInput((s) => s.slice(0, -1));
    if (ch && !key.ctrl && !key.meta && !key.escape) {
      // ★ Girdi ÖBEK hâlinde gelebilir (yapıştırma, pty): Ink key.return'ü yalnız
      //   tek başına gelen \r için işaretler. Öbeğin içindeki ilk \r/\n'e kadar
      //   olan kısım yazılır, orada GÖNDERİLİR — aksi hâlde \r buffer'a gömülür.
      const nl = ch.search(/[\r\n]/);
      if (nl >= 0) return submitCurrent(ch.slice(0, nl));
      const printable = ch.replace(/[\x00-\x1f\x7f]/g, "");
      if (!printable) return;
      // Rakamla hızlı seçim: girdi boşken 1-9 imleci taşır (Enter gönderir).
      if (choices.length && input === "" && /^[1-9]$/.test(printable)) {
        const idx = Number(printable) - 1;
        if (idx < choices.length) return setSel(idx);
      }
      setInput((s) => s + printable);
    }
  });

  const children = [];
  children.push(
    h(Static, { key: "transcript", items: entries }, (item) =>
      h(Text, { key: item.key, color: KIND_COLOR[item.kind], wrap: "wrap" }, item.text),
    ),
  );
  if (busy && !done) {
    children.push(h(Text, { key: "busy", color: "gray" }, "… sunucu yanıtlıyor"));
  }
  if (!busy && question) {
    const qChildren = [h(Text, { key: "q", bold: true, color: "yellow", wrap: "wrap" }, question.prompt)];
    for (const [i, choice] of (question.choices ?? []).entries()) {
      qChildren.push(
        h(
          Text,
          { key: `c${i}`, color: i === sel ? "cyan" : undefined, wrap: "wrap" },
          `${i === sel ? "❯" : " "} ${i + 1}) ${choice.label}${choice.detail ? ` — ${choice.detail}` : ""}`,
        ),
      );
    }
    qChildren.push(
      h(
        Text,
        { key: "in" },
        h(Text, { color: "green" }, "› "),
        input,
        h(Text, { color: "gray" }, "▌"),
      ),
    );
    children.push(h(Box, { key: "question", flexDirection: "column", marginTop: 1 }, ...qChildren));
  }
  children.push(
    h(
      Box,
      { key: "footer", marginTop: 1 },
      h(
        Text,
        { color: "gray", dimColor: true, wrap: "truncate" },
        `adım ${step} · sunucu ${serverLabel} · era ${client.protocolVersion} · ↑↓ seç · Enter gönder · Ctrl+C çık`,
      ),
    ),
  );
  return h(Box, { flexDirection: "column" }, ...children);
}

/**
 * Ink sohbetini çalıştırır; süreç çıkış kodunu döner.
 * done=true'ya ulaşmadan kapanan sohbet (Ctrl+C, hata) 1 döner.
 */
export async function runChatTui({ client, serverLabel }) {
  let code = null;
  const app = render(h(ChatApp, { client, serverLabel, report: (c) => (code = c) }), {
    exitOnCtrlC: true,
  });
  await app.waitUntilExit();
  return code ?? 1; // rapor edilmediyse sohbet yarım kaldı demektir
}
