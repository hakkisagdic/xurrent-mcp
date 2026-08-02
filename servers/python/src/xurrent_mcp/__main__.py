"""CLI giris noktasi.

    xurrent-mcp             -> stdio MCP sunucusu (VARSAYILAN)
    xurrent-mcp --http      -> Streamable HTTP MCP sunucusu
    xurrent-mcp --chat      -> terminal chatbot (ANTHROPIC_API_KEY gerekir)
    xurrent-mcp --web       -> web arayuzu (ANTHROPIC_API_KEY gerekir)
    xurrent-mcp --wizard    -> sihirbaz (ders modu, API key gerekmez)

KRITIK: stdio modunda stdout SADECE JSON-RPC icindir. Tek bir print() bile
protokolu bozar. Bu yuzden logging her zaman stderr'e kurulur.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys


def _setup_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        # stdout SADECE JSON-RPC tasir -> tum loglar stderr'e.
        stream=sys.stderr,
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="xurrent-mcp",
        description="Xurrent (ITSM) MCP sunucusu ve chatbot — Python implementasyonu.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--stdio", action="store_true", help="stdio MCP sunucusu (varsayilan)")
    mode.add_argument("--http", action="store_true", help="Streamable HTTP MCP sunucusu")
    mode.add_argument("--chat", action="store_true", help="Terminal chatbot")
    mode.add_argument("--web", action="store_true", help="Web arayuzu")
    mode.add_argument("--wizard", action="store_true", help="Sihirbaz (ders modu)")
    parser.add_argument("--port", type=int, default=None, help="HTTP/web portu")
    parser.add_argument("-v", "--verbose", action="store_true", help="Ayrintili log")

    args = parser.parse_args(argv)
    _setup_logging(args.verbose)

    from .config import load_config

    try:
        config = load_config()
    except ValueError as exc:
        # Yapilandirma hatasi ham traceback olarak degil, okunabilir TURKCE
        # mesaj olarak cikar — ve stdout'a DEGIL stderr'e.
        print(f"Yapilandirma hatasi: {exc}", file=sys.stderr)
        return 1

    if args.wizard:
        from .wizard import run_wizard

        outcome = run_wizard(config)
        return 0 if outcome.ok else 1

    if args.chat:
        from .agent import run_chat

        run_chat(config)
        return 0

    if args.web:
        from .web import run_web

        run_web(config, args.port)
        return 0

    if args.http:
        from .server import run_http

        asyncio.run(run_http(config, args.port))
        return 0

    # Varsayilan: stdio.
    from .server import run_stdio

    asyncio.run(run_stdio(config))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
