"""Terminal chatbot: Anthropic tool loop + Turkce sistem promptu.

ANTHROPIC_API_KEY gerekir. SADECE MCP sunucusunu Claude Code / Claude Desktop'a
takacaksaniz GEREKMEZ — o durumda LLM'i host uygulama saglar.

Model: claude-opus-5. Bu modelde dusunme (thinking) VARSAYILAN OLARAK ACIKTIR
ve max_tokens dusunme + cevap metnini BIRLIKTE sinirlar; bu yuzden max_tokens
comert tutulur. temperature/top_p/top_k bu modelde KABUL EDILMEZ (400 doner).
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

from .config import Config, load_config
from .tools import TOOLS, Runtime, call_tool

log = logging.getLogger(__name__)

MAX_TOKENS = 16000
MAX_TOOL_ROUNDS = 12

SYSTEM_PROMPT = """\
Sen Xurrent (ITSM) icin calisan bir zaman girisi asistanisin. Kullaniciyla
TURKCE konusursun. Gorevin: kisinin acik taleplerini/gorevlerini listelemek,
sure uzerinde muzakere etmek ve zaman girislerini Xurrent'a kaydetmek. Ayrica
gunun takvimini okuyup her toplantiyi zaman girisine cevirmek.

DEGISMEZ KURALLAR

1. ID URETME. Tum id degerleri opak string'lerdir (Xurrent GraphQL global node
   ID). ASLA uretmez, tahmin etmez, hatirlamaya calismazsin. Her id mutlaka bir
   tool ciktisindan gelmek zorundadir. Elinde id yoksa once ilgili okuma
   tool'unu cagirirsin.

2. BIRIM DAKIKADIR. Xurrent TimeEntry.timeSpent alani dakikadir; saat veya
   saniye ASLA kullanilmaz. Kullanici "2 saat" derse 120'ye cevirir ve
   cevirdigini SOYLERSIN. "09:00-11:00" girdisi startedAt=09:00 + minutes=120
   olarak ayristirilir — Xurrent'ta bitis saati alani YOKTUR.

3. YAZMADAN ONCE BAGLAM. Herhangi bir zaman girisi yazmadan once
   xurrent_get_time_tracking_context calistirmak ZORUNLUDUR. timeIncrement
   bilinmeden timeSpent secilemez; kati olmayan bir deger sunucu tarafindan
   REDDEDILIR. Sonucu oturum boyunca hatirlarsin.

4. ONCE PLAN, SONRA YAZMA. Yazma tool'larini once dryRun=true ile calistirir,
   planlanan mutation'lari ve uyarilari kullaniciya OZETLER, onay aldiktan
   sonra dryRun=false ile tekrar cagirirsin. Onay almadan asla yazmazsin.

5. YUVARLAMAYI SOYLE. Bir sure timeIncrement'in kati degilse yuvarlarsin ama
   yuvarladigini ACIKCA soylersin. Sessizce yuvarlamak yasaktir.

6. BULK ATOMIK DEGILDIR. Toplu yazmada kismi basari normaldir. Sonucu satir
   satir raporlar, kacinin yazildigini ve kacinin basarisiz oldugunu acikca
   belirtirsin. Onayi N kez degil, OZET uzerinden BIR kez alirsin.

7. STRATEJIYI ACIKLA. Gecmis tarihli bir giris istendiginde secilen backdate
   stratejisinin neyi feda ettigini soylersin:
     two_step   -> her seyi korur ama ATOMIK DEGILDIR (2 istek)
     link_first -> tek istek, atomik; ama tarih HER ZAMAN bugun olur
     date_first -> tarih dogru; ama kayit ticket'a BAGLANMAZ
   Hicbiri "dogru cevap" degildir; raporlama ihtiyaci belirler.

8. BELIRSIZLIKTE SOR. plan_time_entries_from_calendar bir oneri uretir ve
   needsUserDecision=true dondugunde TAHMIN ETMEZSIN — kullaniciya sorarsin.

9. HATALARI SAKLAMA. errors dizisi bos degilse islem BASARISIZ olmustur.
   Bunu yumusatmadan, Turkce ve anlasilir sekilde soylersin.

Kisa, net ve somut konus. Yaptigin her tool cagrisini ve neden yaptigini tek
cumleyle belirt.
"""


def _anthropic_tools() -> list[dict[str, Any]]:
    """MCP tool sozlesmesini Anthropic tool tanimlarina cevirir.

    Ayni sozlesme iki farkli protokole servis edilir: MCP'de `inputSchema`,
    Anthropic API'sinde `input_schema`. Icerik BIREBIR aynidir.
    """
    out: list[dict[str, Any]] = []
    for spec in TOOLS:
        description = spec.description
        if spec.teaching_notes:
            notes = "\n".join(f"- {n}" for n in spec.teaching_notes)
            description = f"{description}\n\nDIKKAT EDILECEKLER:\n{notes}"
        out.append(
            {
                "name": spec.name,
                "description": description,
                "input_schema": spec.input_schema,
            }
        )
    return out


class XurrentAgent:
    """Anthropic Messages API uzerinde calisan tool loop."""

    def __init__(self, config: Config | None = None) -> None:
        self.config = config or load_config()
        if not self.config.anthropic_api_key:
            raise RuntimeError(
                "ANTHROPIC_API_KEY tanimli degil. Chatbot icin gereklidir. "
                "Sadece MCP sunucusu kullanacaksaniz gerekmez — LLM'i host uygulama saglar."
            )
        import anthropic

        self.client = anthropic.Anthropic(api_key=self.config.anthropic_api_key)
        self.runtime = Runtime.create(self.config)
        self.tools = _anthropic_tools()
        self.messages: list[dict[str, Any]] = []

    def ask(self, user_text: str, *, on_tool: Any = None) -> str:
        """Bir kullanici mesajini isler; gerekli tool'lari cagirir ve cevabi doner."""
        self.messages.append({"role": "user", "content": user_text})

        for _ in range(MAX_TOOL_ROUNDS):
            response = self.client.messages.create(
                model=self.config.anthropic_model,
                max_tokens=MAX_TOKENS,
                system=SYSTEM_PROMPT,
                tools=self.tools,
                messages=self.messages,
            )

            # Guvenlik siniflandiricisi istegi reddedebilir: HTTP 200 + refusal.
            # content'e dokunmadan ONCE stop_reason kontrol edilir.
            if response.stop_reason == "refusal":
                self.messages.append({"role": "assistant", "content": response.content})
                return "Model bu istegi guvenlik gerekcesiyle reddetti."

            # Assistant turu (tool_use bloklari dahil) gecmise EKLENIR.
            self.messages.append({"role": "assistant", "content": response.content})

            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if not tool_uses:
                return "\n".join(b.text for b in response.content if b.type == "text").strip()

            # Paralel tool cagrilari TEK bir user mesajinda geri doner.
            results: list[dict[str, Any]] = []
            for block in tool_uses:
                if on_tool:
                    on_tool(block.name, block.input)
                try:
                    payload = call_tool(self.runtime, block.name, dict(block.input or {}))
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": json.dumps(payload, ensure_ascii=False),
                        }
                    )
                except Exception as exc:  # noqa: BLE001
                    results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": block.id,
                            "content": f"Tool hatasi: {exc}",
                            "is_error": True,
                        }
                    )
            self.messages.append({"role": "user", "content": results})

        return (
            "Tool dongusu ust sinira ulasti. Istegi daha kucuk adimlara bolerek "
            "tekrar deneyin."
        )


def run_chat(config: Config | None = None) -> None:
    """Terminal sohbet dongusu."""
    agent = XurrentAgent(config)
    print("Xurrent zaman girisi asistani (Python). Cikmak icin: /cik veya Ctrl-D")
    print(f"Mod: {agent.runtime.adapter.mode}  •  Model: {agent.config.anthropic_model}\n")

    while True:
        try:
            line = input("sen > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not line:
            continue
        if line in ("/cik", "/quit", "/exit"):
            return

        def show(name: str, args: dict[str, Any]) -> None:
            print(f"  \033[2m-> {name}({json.dumps(args, ensure_ascii=False)})\033[0m",
                  file=sys.stderr)

        try:
            answer = agent.ask(line, on_tool=show)
        except Exception as exc:  # noqa: BLE001
            print(f"\nHata: {exc}\n")
            continue
        print(f"\nbot > {answer}\n")
