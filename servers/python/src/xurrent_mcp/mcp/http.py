"""HTTP yuzeyi uyumlastirmasi — yol tablosu, oturum durusu, API anahtari kapisi.

★ YOL TABLOSU (uc dilde ayni sozlesme; bkz. contract/protocol.md + .env.example §2):

    MCP_PROTOCOL=2026-07-28  ->  /mcp            (STATELESS — session yok)
    MCP_PROTOCOL=2025-11-25  ->  /mcp            (SESSIONFUL — initialize
                                                  el sikismasi Mcp-Session-Id uretir)
    MCP_PROTOCOL=both        ->  /mcp/v1         (2025-11-25, SESSIONFUL)
                                 /mcp/v2         (2026-07-28, STATELESS)
                                 /mcp            (v2'nin takma adi)

Oturum durusu SOZLESMENIN PARCASIDIR: 2025-11-25 baglantiyi el sikismasiyla
kurar ve oturum kimligi tasir; 2026-07-28 her istegi kendi zarfiyla tasir ve
oturum diye bir sey YOKTUR. "both" stdio'da GECERSIZDIR (tek boru tek protokol);
HTTP'de her istek ayri baglantidir, iki era yan yana yasayabilir.

★ MCP_API_KEY KAPISI (.env.example §8):

    BOS  -> sunucu YALNIZCA loopback'e (127.0.0.1) baglanir — mevcut durus.
    DOLU -> 0.0.0.0'a baglanir VE her /mcp* istegi X-MCP-Api-Key basligini bu
            degerle birebir tasimak zorundadir; aksi halde 401. Karsilastirma
            SABIT-ZAMANLIDIR (hmac.compare_digest) — '==' karakter karakter
            erken cikar ve zamanlama olcumuyle anahtar sizdirir.

Bu kapi MCP sunucusunun KENDISINI korur; Xurrent kimligi (XURRENT_TOKEN)
sunucuda kalir, dis istemci onu asla gormez. Web chat portu (WEB_PORT) bu
dosyanin kapsami DISINDADIR ve davranisi degismez.
"""

from __future__ import annotations

import contextlib
import hmac
import logging
from collections.abc import AsyncIterator, Callable
from typing import Any

from mcp.server.lowlevel.server import Server
from mcp.server.streamable_http_manager import (
    StreamableHTTPASGIApp,
    StreamableHTTPSessionManager,
)
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.types import Receive, Scope, Send

from ..config import MCP_PROTOCOL_V1, MCP_PROTOCOL_V2, Config, McpProtocol

log = logging.getLogger(__name__)

# Era etiketleri: v1 = 2025-11-25 (sessionful), v2 = 2026-07-28 (stateless).
ERA_V1 = "v1"
ERA_V2 = "v2"
PROTOCOL_BY_ERA: dict[str, str] = {ERA_V1: MCP_PROTOCOL_V1, ERA_V2: MCP_PROTOCOL_V2}
API_KEY_HEADER = "x-mcp-api-key"


def yol_tablosu(protocol: McpProtocol) -> list[tuple[str, str]]:
    """MCP_PROTOCOL -> [(yol, era)] listesi. Tek gercek kaynak BURASIDIR.

    Siralama onemlidir: "both"ta /mcp/v1 ve /mcp/v2 spesifik yollar, /mcp ise
    v2'nin takma adidir — guncel protokolu varsayilan yapmak bilinçli karardir
    (yeni istemci ek yapilandirmasiz dogru kapiya duser).
    """
    if protocol == "both":
        return [("/mcp/v1", ERA_V1), ("/mcp/v2", ERA_V2), ("/mcp", ERA_V2)]
    if protocol == MCP_PROTOCOL_V1:
        return [("/mcp", ERA_V1)]
    return [("/mcp", ERA_V2)]


def api_key_dogru(beklenen: str, gelen: str | None) -> bool:
    """X-MCP-Api-Key karsilastirmasi — SABIT ZAMANLI.

    NEDEN hmac.compare_digest: duz '==' ilk farkli karakterde durur; yanit
    suresini olcen bir saldirgan anahtari karakter karakter tahmin edebilir.
    compare_digest her cagrida ayni surede calisir.

    beklenen BOSSA kapi kapalidir ve bu fonksiyon HIC cagrilmamalidir; yine de
    False doneriz — "bos anahtar her seyi acar" sessiz hatasina yer yok.
    """
    if not beklenen or gelen is None:
        return False
    return hmac.compare_digest(beklenen.encode("utf-8"), gelen.encode("utf-8"))


def dinleme_adresi(mcp_api_key: str) -> str:
    """Bind adresi anahtarin varligina baglidir (.env.example §8).

    Anahtarsiz 0.0.0.0'a baglanmak, korumasiz bir MCP sunucusunu aga acmak
    demektir — bu yuzden anahtar BOSKEN loopback zorunludur.
    """
    return "0.0.0.0" if mcp_api_key else "127.0.0.1"


class ApiKeyKapisi:
    """ASGI ara katmani: her /mcp* istegi icin X-MCP-Api-Key zorunlu.

    NEDEN ASGI seviyesinde: kapi TUM /mcp yollarini (v1/v2/takma ad) tek yerde
    korur; her route'a ayri kontrol koymak birini unutmaya davetiyedir.
    lifespan/websocket mesajlarina DOKUNMAZ — yalnizca HTTP kapsami suzulur.
    """

    def __init__(self, app: Any, api_key: str) -> None:
        self.app = app
        self.api_key = api_key

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") == "http" and str(scope.get("path", "")).startswith("/mcp"):
            gelen: str | None = None
            for anahtar, deger in scope.get("headers") or []:
                # ASGI basliklari kucuk harfli byte'lardir; yine de lower()
                # cagiriyoruz — spec disi bir sunucu varyanti sessizce 401
                # uretmesin.
                if anahtar.lower() == API_KEY_HEADER.encode("ascii"):
                    gelen = deger.decode("latin-1")
                    break
            if not api_key_dogru(self.api_key, gelen):
                yanit = JSONResponse(
                    {
                        "errors": [
                            {
                                "message": (
                                    "Yetkisiz: X-MCP-Api-Key basligi eksik veya hatali. "
                                    "MCP_API_KEY ile korunan bir HTTP yuzeyine baglaniyorsunuz."
                                )
                            }
                        ]
                    },
                    status_code=401,
                )
                await yanit(scope, receive, send)
                return
        await self.app(scope, receive, send)


def build_http_app(
    cfg: Config, server_factory: Callable[[str], Server]
) -> tuple[Any, str]:
    """Streamable HTTP ASGI uygulamasini yol tablosuna gore kurar.

    server_factory(protocol) -> o eranin durusuyla kurulmus Server dondurur
    (v1 orneginde server/discover kapalidir). NEDEN parametre: bu modul
    server.py'yi import EDEMEZ — server.py bu paketi import ediyor; fabrika
    enjeksiyonu donguyu kirar ve birimi test edilebilir kilar.

    Donus: (asgi_app, bind_adresi).
    """
    tablo = yol_tablosu(cfg.mcp_protocol)

    # Anahtar BOSKEN SDK'nin loopback varsayilanini koruyoruz: DNS rebinding
    # korumasi + localhost Host/Origin suzgeci. Anahtar DOLUYKEN sunucu bilerek
    # dis istemcilere aciliyor — Host suzgeci kaldirilir, kapi API anahtaridir.
    guvenlik: TransportSecuritySettings | None = None
    if not cfg.mcp_api_key:
        guvenlik = TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=["127.0.0.1:*", "localhost:*", "[::1]:*"],
            allowed_origins=["http://127.0.0.1:*", "http://localhost:*", "http://[::1]:*"],
        )

    # Era basina TEK session manager: v1 sessionful (initialize Mcp-Session-Id
    # uretir), v2 stateless (SDK'ya stateless=True gecilir — session header'i
    # ne uretilir ne beklenir). /mcp takma adi v2'nin manager'ini PAYLASIR.
    yoneticiler: dict[str, StreamableHTTPSessionManager] = {}
    for _, era in tablo:
        if era in yoneticiler:
            continue
        server = server_factory(PROTOCOL_BY_ERA[era])
        yoneticiler[era] = StreamableHTTPSessionManager(
            app=server,
            stateless=(era == ERA_V2),
            security_settings=guvenlik,
        )

    rotalar = [
        Route(yol, endpoint=StreamableHTTPASGIApp(yoneticiler[era]))
        for yol, era in tablo
    ]

    @contextlib.asynccontextmanager
    async def yasam_dongusu(_app: Starlette) -> AsyncIterator[None]:
        # Her manager'in run() baglami sunucu omru boyunca acik kalmalidir;
        # AsyncExitStack ikisini de (both modunda) tek yasam dongusune baglar.
        async with contextlib.AsyncExitStack() as yigin:
            for yonetici in yoneticiler.values():
                await yigin.enter_async_context(yonetici.run())
            yield

    app: Any = Starlette(routes=rotalar, lifespan=yasam_dongusu)
    if cfg.mcp_api_key:
        app = ApiKeyKapisi(app, cfg.mcp_api_key)
    return app, dinleme_adresi(cfg.mcp_api_key)


__all__ = [
    "API_KEY_HEADER",
    "ApiKeyKapisi",
    "ERA_V1",
    "ERA_V2",
    "PROTOCOL_BY_ERA",
    "api_key_dogru",
    "build_http_app",
    "dinleme_adresi",
    "yol_tablosu",
]
