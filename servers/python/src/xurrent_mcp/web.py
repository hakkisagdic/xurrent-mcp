"""Web arayuzu: statik clients/web + POST /api/chat.

clients/web klasoru UC BACKEND TARAFINDAN DA servis edilir — ayni arayuz,
uc farkli sunucu. Bu da "MCP bir protokoldur, dil bir detaydir" tezinin
bir baska kanitidir.

NEDEN starlette: mcp paketi zaten starlette + uvicorn bagimliligi getiriyor;
ek bir web cercevesi eklemeye gerek yok.
"""

from __future__ import annotations

import logging
from typing import Any

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .config import Config, load_config
from .tools import TOOLS, Runtime, call_tool

log = logging.getLogger(__name__)

FALLBACK_PAGE = """
<!doctype html><html lang="tr"><head><meta charset="utf-8">
<title>xurrent-mcp — Python</title>
<style>
 body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:52rem;margin:4rem auto;
      padding:0 1.5rem;line-height:1.6;color:#1c1917}
 code{background:#f5f5f4;padding:.15rem .4rem;border-radius:.25rem}
 .warn{background:#fef3c7;border-left:4px solid #f59e0b;padding:1rem;border-radius:.25rem}
</style></head><body>
<h1>xurrent-mcp — Python backend calisiyor</h1>
<div class="warn">
<p><strong>Ortak web arayuzu bulunamadi.</strong> <code>clients/web/</code> klasoru
henuz olusturulmamis. Backend yine de hazir:</p>
<ul>
  <li><code>POST /api/chat</code> — <code>{"message":"..."}</code></li>
  <li><code>GET /api/tools</code> — tool envanteri</li>
  <li><code>GET /api/config</code> — arayuz rozet verisi (mod, model, hasApiKey)</li>
  <li><code>GET /api/health</code> — mod ve yapilandirma ozeti</li>
</ul>
</div>
</body></html>
"""


def build_app(config: Config | None = None) -> Starlette:
    cfg = config or load_config()
    runtime = Runtime.create(cfg)
    agent_holder: dict[str, Any] = {}

    async def health(_request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "ok": True,
                "language": "python",
                "mode": runtime.adapter.mode,
                "backdateStrategy": cfg.backdate_strategy,
                "calendarProvider": cfg.calendar_provider,
                "timeZone": cfg.timezone,
                "chatAvailable": bool(cfg.gemini_api_key),
                "toolCount": len(TOOLS),
            }
        )

    async def config_endpoint(_request: Request) -> JSONResponse:
        """clients/web/API.md §1 — arayuzun acilista okudugu rozet verisi.

        ★ SIR SIZMAZ: yalnizca `hasApiKey: boolean` doner. Anahtarin kendisi,
          Xurrent token'i ve takvim kimlik bilgileri hicbir uca cikmaz.
        """
        return JSONResponse(
            {
                "mode": runtime.adapter.mode,
                "strategy": cfg.backdate_strategy,
                "calendarProvider": cfg.calendar_provider,
                "model": cfg.gemini_model,
                "hasApiKey": bool(cfg.gemini_api_key),
                "language": "python",
                "dryRunForced": cfg.dry_run,
                "timeZone": cfg.timezone,
                "maxBackdateDays": cfg.max_backdate_days,
                "toolCount": len(TOOLS),
            }
        )

    async def list_tools(_request: Request) -> JSONResponse:
        return JSONResponse(
            {
                "tools": [
                    {
                        "name": spec.name,
                        "kind": spec.kind,
                        "description": spec.description,
                        "inputSchema": spec.input_schema,
                        "annotations": spec.annotations,
                    }
                    for spec in TOOLS
                ]
            }
        )

    async def call_tool_endpoint(request: Request) -> JSONResponse:
        body = await request.json()
        name = body.get("name")
        args = body.get("arguments") or {}
        try:
            return JSONResponse({"ok": True, "result": call_tool(runtime, name, args)})
        except Exception as exc:  # noqa: BLE001
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=400)

    async def chat(request: Request) -> JSONResponse:
        if not cfg.gemini_api_key:
            return JSONResponse(
                {
                    "ok": False,
                    "error": (
                        "GEMINI_API_KEY tanimli degil. Web sohbeti icin gereklidir. "
                        "Tool'lari LLM'siz denemek icin POST /api/tool kullanin."
                    ),
                },
                status_code=400,
            )
        body = await request.json()
        message = str(body.get("message", "")).strip()
        if not message:
            return JSONResponse({"ok": False, "error": "message bos olamaz."}, status_code=400)

        if "agent" not in agent_holder:
            from .agent import XurrentAgent

            agent_holder["agent"] = XurrentAgent(cfg)

        calls: list[dict[str, Any]] = []
        try:
            answer = agent_holder["agent"].ask(
                message,
                on_tool=lambda name, args: calls.append({"name": name, "arguments": args}),
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("Sohbet basarisiz")
            return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)

        return JSONResponse({"ok": True, "reply": answer, "toolCalls": calls})

    async def fallback_index(_request: Request) -> HTMLResponse:
        return HTMLResponse(FALLBACK_PAGE)

    routes: list[Any] = [
        Route("/api/config", config_endpoint, methods=["GET"]),
        Route("/api/health", health, methods=["GET"]),
        Route("/api/tools", list_tools, methods=["GET"]),
        Route("/api/tool", call_tool_endpoint, methods=["POST"]),
        Route("/api/chat", chat, methods=["POST"]),
    ]

    if cfg.web_client_dir.is_dir():
        # Ortak statik arayuz — uc backend de AYNI klasoru servis eder.
        routes.append(Mount("/", app=StaticFiles(directory=str(cfg.web_client_dir), html=True)))
    else:
        routes.append(Route("/", fallback_index, methods=["GET"]))

    return Starlette(routes=routes)


def run_web(config: Config | None = None, port: int | None = None) -> None:
    import uvicorn

    cfg = config or load_config()
    listen_port = port or cfg.web_port
    print(f"Web arayuzu: http://localhost:{listen_port}")
    if not cfg.web_client_dir.is_dir():
        print(f"  (not: {cfg.web_client_dir} bulunamadi — yedek sayfa servis ediliyor)")
    uvicorn.run(build_app(cfg), host="127.0.0.1", port=listen_port, log_level="warning")
