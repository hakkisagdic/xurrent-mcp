"""Terminal chatbot: Gemini tool loop + Turkce sistem promptu.

GEMINI_API_KEY gerekir. SADECE MCP sunucusunu Claude Code / Claude Desktop'a
takacaksaniz GEREKMEZ — o durumda LLM'i host uygulama saglar.

TEK SAGLAYICI: Gemini. Model varsayilani `gemini-3.6-flash` (bkz. config.py).
GEMINI_BASE_URL ile sahte sunucuya yonlendirilebilir; boylece tool dongusu,
sema cevirisi ve id eslesmesi API anahtarsiz test edilir.

★ Gemini'nin Anthropic'ten AYRILDIGI dort nokta — kod bu dortluye gore yazildi:
  1. Sistem mesaji `contents` icine KONMAZ, ayri `systemInstruction` alanina konur.
     Gemini'de "system" diye bir rol YOKTUR.
  2. Rol eslemesi: assistant -> "model", user -> "user".
  3. Tool sonucu KULLANICI rolunde, `functionResponse` parcasi olarak doner ve
     `id` alani modelin `functionCall.id`'si ile AYNI olmak zorundadir.
  4. Tool semasi tam JSON Schema DEGIL, OpenAPI'nin dar bir alt kumesidir —
     arada llm/schema.py cevirisi vardir ve NE ATTIGINI stderr'e yazar.
"""

from __future__ import annotations

import json
import logging
import sys
from collections.abc import Callable
from typing import Any

from .config import Config, load_config
from .llm.gemini import (
    GeminiClient,
    GeminiError,
    function_response,
    function_responses_turn,
    model_parts,
    user_text,
)
from .llm.schema import build_function_declarations, format_translation_report
from .tools import TOOLS, Runtime, ToolSpec, call_tool

log = logging.getLogger(__name__)

MAX_OUTPUT_TOKENS = 8192
MAX_TOOL_ROUNDS = 12
# Tool secimi belirleyici olsun: ayni istek ayni tool'u cagirsin. Ders
# demosunda "bende baska calisti" durumunu ortadan kaldirir.
TEMPERATURE = 0.2

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

10. VARSAYILANLAR ACIKLAMADADIR. Bazi parametrelerin varsayilan degeri sema
    yerine aciklama metninde yazar ("Varsayilan: '$me'."). Sebep: Gemini tool
    semasi `default` anahtarini kabul etmez. Bir alani bos birakabilirsin,
    sunucu varsayilani uygular.

Kisa, net ve somut konus. Yaptigin her tool cagrisini ve neden yaptigini tek
cumleyle belirt.
"""


def _describe(spec: ToolSpec) -> str:
    """Tool aciklamasi + ogretici notlar.

    LLM'in tool'u DOGRU kullanmasinin tek kaynagi bu metindir; sozlesmedeki
    teachingNotes buraya katilir cunku Gemini semasinda onlari tasiyacak bir
    alan yoktur.
    """
    if not spec.teaching_notes:
        return spec.description
    notes = "\n".join(f"- {n}" for n in spec.teaching_notes)
    return f"{spec.description}\n\nDIKKAT EDILECEKLER:\n{notes}"


# LLM saglayicisina CEVRILMEYEN tool'lar (contract/wizard.md §1).
#
# timesheet_wizard'in kendisi bir chatbot'tur: Gemini'ye tool olarak verilirse
# model "kullaniciyla konusmak" icin onu cagirir, wizard soru doner, model onu
# tekrar cagirir — chatbot'un kendi kendini cagirma dongusu. Dongu, tool'u
# functionDeclarations listesine HIC koymayarak yapisal olarak kapatilir;
# wire-denetimi (tools/fake-gemini) bunu telin uzerinde dogrular.
LLM_EXCLUDED_TOOLS = frozenset({"timesheet_wizard"})


def gemini_tools(
    specs: list[ToolSpec] | None = None, *, report_to: Any = None
) -> list[dict[str, Any]]:
    """MCP tool sozlesmesini Gemini `tools` blokuna cevirir.

    Ayni sozlesme iki farkli lehcede konusulur: MCP'de `inputSchema` (tam JSON
    Schema 2020-12), Gemini'de `functionDeclarations[].parameters` (OpenAPI alt
    kumesi). Ceviri llm/schema.py'de yapilir ve ATTIGI HER ANAHTARI kaydeder.

    Rapor stderr'e basilir — stdout SADECE JSON-RPC icindir.
    """
    pool = [s for s in (specs or TOOLS) if s.name not in LLM_EXCLUDED_TOOLS]
    declarations, reports = build_function_declarations(pool, describe=_describe)
    stream = report_to if report_to is not None else sys.stderr
    print(format_translation_report(reports), file=stream)
    return [{"functionDeclarations": declarations}]


class XurrentAgent:
    """Gemini generateContent uzerinde calisan tool loop."""

    def __init__(self, config: Config | None = None) -> None:
        self.config = config or load_config()
        if not self.config.gemini_api_key:
            raise RuntimeError(
                "GEMINI_API_KEY tanimli degil. Chatbot icin gereklidir. "
                "Sadece MCP sunucusu kullanacaksaniz gerekmez — LLM'i host uygulama saglar."
            )
        self.client = GeminiClient(
            api_key=self.config.gemini_api_key,
            model=self.config.gemini_model,
            base_url=self.config.gemini_base_url,
        )
        self.runtime = Runtime.create(self.config)
        self.tools = gemini_tools()
        # Gemini'nin `contents` dizisi. Sistem promptu BURAYA GIRMEZ.
        self.contents: list[dict[str, Any]] = []

    # ── tool calistirma ──

    def _run_call(
        self, call: dict[str, Any], on_tool: Callable[[str, dict[str, Any]], None] | None
    ) -> dict[str, Any]:
        """Tek bir functionCall'i calistirip functionResponse parcasi doner."""
        name = str(call.get("name") or "")
        args = call.get("args") or {}
        if not isinstance(args, dict):
            args = {}
        if on_tool:
            on_tool(name, args)
        try:
            payload = call_tool(self.runtime, name, dict(args))
        except Exception as exc:  # noqa: BLE001
            # Hata da OBJE olarak doner; model bunu okuyup kullaniciya anlatabilsin.
            return function_response(call, {"error": f"Tool hatasi: {exc}"})
        return function_response(call, payload)

    # ── genel API ──

    def ask(
        self,
        user_message: str,
        *,
        on_tool: Callable[[str, dict[str, Any]], None] | None = None,
    ) -> str:
        """Bir kullanici mesajini isler; gerekli tool'lari cagirir ve cevabi doner."""
        self.contents.append(user_text(user_message))
        answer_chunks: list[str] = []

        for _ in range(MAX_TOOL_ROUNDS):
            response = self.client.generate(
                contents=self.contents,
                tools=self.tools,
                system_instruction=SYSTEM_PROMPT,
                generation_config={
                    "temperature": TEMPERATURE,
                    "maxOutputTokens": MAX_OUTPUT_TOKENS,
                },
            )

            # Modelin urettigi parts AYNEN gecmise girer. functionCall.id
            # dahil hicbir sey yeniden uretilmez — id eslesmesi buna baglidir.
            self.contents.append(model_parts(response.parts))

            warning = response.finish_warning
            calls = response.function_calls

            if not calls:
                text = response.text
                if warning:
                    text = f"{text}\n\n[uyari] {warning}".strip()
                answer_chunks.append(text)
                return "\n\n".join(c for c in answer_chunks if c).strip()

            # Model tool cagirdi ama arada metin de uretmis olabilir; kaybolmasin.
            if response.text:
                answer_chunks.append(response.text)

            # Paralel cagrilar TEK bir user turunda geri doner.
            parts = [self._run_call(call, on_tool) for call in calls]
            self.contents.append(function_responses_turn(parts))

        return (
            "Tool dongusu ust sinira ulasti. Istegi daha kucuk adimlara bolerek "
            "tekrar deneyin."
        )

    def close(self) -> None:
        self.client.close()


def run_chat(config: Config | None = None) -> None:
    """Terminal sohbet dongusu."""
    agent = XurrentAgent(config)
    print("Xurrent zaman girisi asistani (Python). Cikmak icin: /cik veya Ctrl-D")
    print(f"Mod: {agent.runtime.adapter.mode}  •  Model: {agent.config.gemini_model}\n")

    while True:
        try:
            line = input("sen > ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            agent.close()
            return
        if not line:
            continue
        if line in ("/cik", "/quit", "/exit"):
            agent.close()
            return

        def show(name: str, args: dict[str, Any]) -> None:
            print(f"  \033[2m-> {name}({json.dumps(args, ensure_ascii=False)})\033[0m",
                  file=sys.stderr)

        try:
            answer = agent.ask(line, on_tool=show)
        except GeminiError as exc:
            print(f"\nGemini hatasi: {exc}\n")
            continue
        except Exception as exc:  # noqa: BLE001
            print(f"\nHata: {exc}\n")
            continue
        print(f"\nbot > {answer}\n")
