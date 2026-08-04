"""MCP sunucusu kurulumu (mcp 2.0.0 — HER IKI protokol revizyonu).

mcp 2.0.0'in API'si 1.x'ten FARKLIDIR:
  * Dusuk seviye `Server` artik dekorator yerine CONSTRUCTOR tabanli handler
    kaydi kullanir: Server(name, on_list_tools=..., on_call_tool=...).
  * `mcp.types` -> ayri `mcp_types` paketinden gelir; alan adlari snake_case
    (input_schema, output_schema, is_error, structured_content) ama wire'da
    camelCase'e serilestirilir. (Bu isimler EZBERDEN DEGIL, site-packages'taki
    mcp_types/_types.py'den dogrulandi.)
  * FastMCP'nin adi `MCPServer` olmustur (mcp.server.mcpserver).

BURADA NEDEN MCPServer (eski FastMCP) DEGIL de dusuk seviye Server:
MCPServer, inputSchema'yi fonksiyon imzasindan URETIR. Bizim sozlesmemiz
contract/tools.json'da BIREBIR tanimli (default'lar, enum'lar, pattern'ler,
additionalProperties:false). Sema uretimine birakmak sozlesme testini kirar.
Dusuk seviye Server bize hem inputSchema'yi hem outputSchema'yi ELLE verme
imkani sagliyor.

CIFT PROTOKOL:
mcp 2.0.0 tek surecte hem `initialize` el sikismasini (2025-11-25) hem
`server/discover` sondasini (2026-07-28) konusur — ELLE ADAPTOR YAZMAYA GEREK
YOKTUR. Bizim isimiz, gelen istegin hangi revizyonda oldugunu okuyup onayi
DOGRU KABUKLA kurmak. Secim `ctx.protocol_version` ile YAPILIR:

    ctx.protocol_version == "2026-07-28"  -> mcp/v2.py (InputRequiredResult, MRTR)
    aksi halde                            -> mcp/v1.py (elicitation/create)

MCP_PROTOCOL degiskeni ise hangi revizyonun ADVERTISE edildigini secer:
    2026-07-28 (varsayilan) -> server/discover acik; iki yol da calisir
    2025-11-25              -> server/discover KAPALI (-32601); client initialize'a duser
    both                    -> yalnizca HTTP; stdio'da GECERSIZ (tek surec tek yol)

stdio modunda stdout SADECE JSON-RPC icindir -> tum loglar stderr'e.
"""

from __future__ import annotations

import logging
from typing import Any

import mcp_types as types
from mcp.server.lowlevel.server import Server, ServerRequestContext
from mcp.shared.exceptions import MCPError
from mcp_types import METHOD_NOT_FOUND
from mcp_types.version import MODERN_PROTOCOL_VERSIONS

from .config import MCP_PROTOCOL_V1, Config, load_config
from .core.confirm import StateSigner
from .mcp import common, envelope_guard, v1, v2
from .mcp.parse_guard import korumali_stdio_server
from .tools import Runtime

log = logging.getLogger(__name__)

SERVER_NAME = "xurrent-mcp"
SERVER_VERSION = "1.0.0"

INSTRUCTIONS = (
    "Xurrent (ITSM) icin zaman girisi ve takvim tool'lari. Kurallar: "
    "(1) Tum id degerleri opak string'lerdir ve ASLA uretilmez/tahmin edilmez — "
    "her id bir tool ciktisindan gelmek zorundadir. "
    "(2) Sure birimi DAKIKA'dir; kullanici '2 saat' derse 120'ye cevrilir ve "
    "cevrildigi soylenir. "
    "(3) Yazmadan once xurrent_get_time_tracking_context CALISTIRILMALIDIR — "
    "timeIncrement bilinmeden timeSpent secilemez. "
    "(4) Yazma tool'lari once dryRun=true ile calistirilip plan kullaniciya "
    "gosterilmelidir."
)


def build_server(config: Config | None = None) -> tuple[Server, Runtime]:
    """MCP Server ornegini ve paylasilan Runtime'i kurar."""
    runtime = Runtime.create(config)
    cfg = runtime.config

    # requestState imzalayicisi SUNUCU OMRU boyunca yasar: nonce seti burada
    # tutulur ve tek kullanimi zorlar.
    signer = StateSigner.create(cfg.state_secret, cfg.state_ttl_seconds)

    async def on_list_tools(
        ctx: ServerRequestContext[Any], params: types.PaginatedRequestParams | None
    ) -> types.ListToolsResult:
        # ttlMs + cacheScope her iki revizyonda da set edilir; 2025-11-25
        # wire'inda SDK bu alanlari zaten eleyerek gonderir.
        return common.list_tools_result()

    async def on_call_tool(
        ctx: ServerRequestContext[Any], params: types.CallToolRequestParams
    ) -> types.CallToolResult | types.InputRequiredResult:
        # ISTE CIFT KABUK. Ustundeki tek satir, breaking change'in bize
        # toplam maliyetidir.
        if ctx.protocol_version in MODERN_PROTOCOL_VERSIONS:
            return await v2.call_tool(runtime, signer, ctx, params)
        return await v1.call_tool(runtime, ctx, params)

    server = Server(
        SERVER_NAME,
        version=SERVER_VERSION,
        title="Xurrent MCP (Python)",
        instructions=INSTRUCTIONS,
        on_list_tools=on_list_tools,
        on_call_tool=on_call_tool,
    )

    if cfg.mcp_protocol == MCP_PROTOCOL_V1:
        _disable_discover(server)

    log.info(
        "MCP_PROTOCOL=%s • kesif=%s • onay=%s",
        cfg.mcp_protocol,
        "kapali" if cfg.mcp_protocol == MCP_PROTOCOL_V1 else "server/discover acik",
        "MRTR + elicitation",
    )
    return server, runtime


def _disable_discover(server: Server) -> None:
    """MCP_PROTOCOL=2025-11-25 iken `server/discover`i kapatir.

    NEDEN: sondanin ANLAMLI olmasi icin. Sihirbaz once server/discover gonderir;
    'method not found' alirsa v1'e duser. Sunucu v1-only oldugunu iddia ediyorsa
    o sondaya v1-only bir sunucu gibi cevap VERMELIDIR — aksi halde pazarlik
    ders sirasinda yalan soyler.
    """

    async def refuse(ctx: ServerRequestContext[Any], params: types.RequestParams | None) -> Any:
        raise MCPError(
            code=METHOD_NOT_FOUND,
            message=(
                "server/discover desteklenmiyor: bu surec MCP_PROTOCOL=2025-11-25 ile "
                "baslatildi. initialize el sikismasini kullanin."
            ),
        )

    server.add_request_handler("server/discover", types.RequestParams, refuse)


def _reject_both_on_stdio(cfg: Config) -> None:
    """MCP_PROTOCOL=both stdio'da GECERSIZDIR.

    Sebep tasarimsaldir: stdio'da baglantinin ERASI ILK ISTEKLE KILITLENIR
    (mcp 2.0.0 `serve_dual_era_loop`). Tek bir borudan tek bir protokol akar;
    'both' orada karsiligi olmayan bir sozdur. HTTP'de ise her istek ayri bir
    baglantidir, dolayisiyla iki era ayni uc noktada yan yana yasayabilir.

    Sessizce birini secmek yerine net hata veriyoruz: yanlis protokol
    konustugunu SANAN bir kullanici saatlerce yanlis yerde hata arar.
    """
    if cfg.mcp_protocol == "both":
        raise SystemExit(
            "MCP_PROTOCOL=both stdio transport'ta GECERSIZDIR: stdio'da baglantinin "
            "protokol erasi ILK ISTEKLE kilitlenir, tek surec tek protokol konusur. "
            "Ya HTTP kullanin (xurrent-mcp --http — /mcp uc noktasi her iki erayi da "
            "kabul eder) ya da MCP_PROTOCOL degerini '2026-07-28' veya '2025-11-25' yapin."
        )


def _stdio_denetleyici(cfg: Config, server: Server) -> envelope_guard.Denetleyici | None:
    """stdio icin `_meta` zarf denetleyicisi — v1 modunda BILEREK None.

    MCP_PROTOCOL=2025-11-25 iken sunucu v1-only oldugunu IDDIA eder ve
    `server/discover` sondasina v1-only bir sunucu gibi -32601 vermelidir
    (`_disable_discover`). Orada zarfi denetleyip -32602 dondurmek, 2026 zarfini
    anladigimizi ele verir ve pazarlik dersini yalancilastirirdi.
    """
    if cfg.mcp_protocol == MCP_PROTOCOL_V1:
        return None
    return envelope_guard.zarf_denetleyici(envelope_guard.korunan_metotlar(server))


async def run_stdio(config: Config | None = None) -> None:
    """stdio transport. stdout SADECE JSON-RPC tasir; loglar stderr'dedir.

    `stdio_server` DEGIL `korumali_stdio_server`: koruyucu stdin ile SDK arasina
    girer ve IKI ihlali birden kapatir:

      * J5  — SDK ayristirilamayan satiri SESSIZCE yutuyor, oysa JSON-RPC 2.0
              `-32700` donmeyi ZORUNLU kilar (mcp/parse_guard.py).
      * Y2b/Y3b — SDK'nin stdio era secimi eksik `_meta` zarfini "2025 trafigi"
              sanip baglantiyi legacy'e kilitliyor; sonucta `server/discover`
              `-32601` (= "bu sunucu 2026 oncesi") aliyor ve ondan sonraki
              KUSURSUZ 2026 istekleri de reddediliyor (mcp/envelope_guard.py).

    HTTP yolunda ikisi de gerekmez: `_streamable_http_modern.py` her istegi
    dogrudan `classify_inbound_request`ten gecirir ve cerceveleme HTTP'nindir.
    """
    cfg = config or load_config()
    _reject_both_on_stdio(cfg)
    server, _ = build_server(cfg)
    async with korumali_stdio_server(_stdio_denetleyici(cfg, server)) as (
        read_stream,
        write_stream,
    ):
        await server.run(read_stream, write_stream, server.create_initialization_options())


async def run_http(config: Config | None = None, port: int | None = None) -> None:
    """Streamable HTTP transport (MCP_HTTP_PORT)."""
    import uvicorn

    server, runtime = build_server(config)
    app = server.streamable_http_app()
    listen_port = port or runtime.config.mcp_http_port
    log.info("MCP Streamable HTTP: http://127.0.0.1:%s/mcp", listen_port)
    uvicorn_config = uvicorn.Config(app, host="127.0.0.1", port=listen_port, log_level="warning")
    await uvicorn.Server(uvicorn_config).serve()
