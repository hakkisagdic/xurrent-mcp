"""EKSIK `_meta` ZARFI KORUYUCUSU — stdio'da SDK'nin era secimini duzeltir.

SORUN IKI YUZLUDUR; ikisinin de KOKENI ayni tek satirdir.

────────────────────────────────────────────────────────────────────────────
Y2b — `_meta`'siz `server/discover` -32601 doner
────────────────────────────────────────────────────────────────────────────
Spec, stdio'da `server/discover`'i GERIYE DONUK UYUMLULUK SONDASI olarak
onerir ve -32601'i "bu sunucu 2026 oncesi" sinyali sayar. Ayni kodu "senin
istegin bozuk" icin de dondurursek iki durum AYIRT EDILEMEZ hale gelir: sonda,
v2 konusan bir sunucuyu v1 sanar. Bu tuzak contract/protocol.md'de anlatilir ve
bu repodaki sihirbaz GERCEKTEN bu hataya dustu (clients/wizard/wizard.mjs
icindeki "sunucu suclu degildi" notu tam olarak bunun kaydidir).

────────────────────────────────────────────────────────────────────────────
Y3b — `clientInfo`'suz istek reddediliyor "gibi" gorunur
────────────────────────────────────────────────────────────────────────────
Tek basina gonderildiginde `clientInfo`'suz istek ZATEN duzgun islenir (SDK
onu dogru sekilde optional tutar). Ama ONUNDE bozuk zarfli BIR istek varsa
istek reddedilir — cunku o bozuk istek baglantinin ERASINI kilitlemistir.

────────────────────────────────────────────────────────────────────────────
KOK NEDEN (ezberden degil, site-packages'tan okundu)
────────────────────────────────────────────────────────────────────────────
mcp/server/runner.py · `serve_dual_era_loop`:

    opens_modern = (
        opening is not None and opening.method != "initialize"
        and _has_modern_envelope(opening.params)
    )

ve mcp/server/runner.py · `_has_modern_envelope`:

    meta = params.get("_meta")
    return isinstance(meta, Mapping) and PROTOCOL_VERSION_META_KEY in meta

Yani baglantinin protokol ERASI ILK ISTEKLE, ve YALNIZCA `protocolVersion`
anahtarinin VARLIGINA bakilarak kilitlenir. Sonuclari:

  * `_meta` HIC yoksa -> era LEGACY kilitlenir. Legacy'de `server/discover`
    diye bir metot YOKTUR (mcp_types/methods.py · CLIENT_REQUESTS haritasinda
    ("server/discover","2026-07-28") var, 2025 satirlari yok), bu yuzden
    mcp/server/runner.py `-32601 Method not found` uretir. -> Y2b.
  * `protocolVersion` eksikse yine LEGACY kilitlenir; ARDINDAN gelen KUSURSUZ
    bir 2026 istegi `-32600 "this connection serves the handshake protocol
    era"` ile reddedilir. -> Y3b.

Dikkat: SDK'nin KENDI dogrulama merdiveni (mcp/shared/inbound.py ·
`classify_inbound_request`) her iki durumu da DOGRU kodluyor: eksik zarf
`-32602 INVALID_PARAMS`, eksik `clientInfo` ise HIC HATA DEGIL

    client_info: Any = meta.get(CLIENT_INFO_META_KEY)   # yoksa None, red yok

Merdiven yanlis degil; ona VARILAMIYOR. HTTP yolunda varilir
(mcp/server/_streamable_http_modern.py `classify_inbound_request`i dogrudan
cagirir) — bu yuzden `--http` zaten dogru davranir. Kirik olan YALNIZCA stdio
era secimidir.

────────────────────────────────────────────────────────────────────────────
COZUM — parse_guard.py ile AYNI KALIP: SDK ile dovusme, ONUNE gec
────────────────────────────────────────────────────────────────────────────
    stdin -> [parse_guard: SATIR duzeyi, -32700]
          -> [BU KORUYUCU: COZULMUS MESAJ duzeyi, -32602]
          -> SDK

★ KRITIK TASARIM KARARI: dogrulamayi KENDIMIZ YAZMIYORUZ. SDK'nin modern
  yolda kullandigi FONKSIYONUN TA KENDISINI (`classify_inbound_request`)
  cagirir ve verdigi kod/mesaj/data'yi OLDUGU GIBI aktaririz. Sonuc: bizim
  GECIRDIGIMIZ her mesaji SDK da gecirir, REDDETTIGIMIZ her mesaji SDK da
  reddederdi — yalnizca yanlis kodla, ya da hic ulasamayacagi bir era'da.
  Calisan trafigi bozma riski YOKTUR (TypeScript'teki params-guard.ts ayni
  gerekceyle SDK'nin kendi zod semalarini cagiriyor).

★ IKINCI ETKI, KAZA DEGIL: bozuk cerceve SDK'ya HIC ulasmadigi icin ERAYI
  KILITLEYEMEZ. "Hicbir era'nin gecerli istegi olmayan bir cerceve, era'yi
  SECEMEZ" — Y3b'yi duzelten sey budur. Bu ayni zamanda gercek bir hatadir:
  tek bir yanlis zarf, baglantinin geri kalanini kalici olarak 2025'e
  dusuruyordu.

────────────────────────────────────────────────────────────────────────────
KAPSAM BILEREK DAR: yalnizca "YALNIZCA MODERN" metotlar
────────────────────────────────────────────────────────────────────────────
Her istegi denetleseydik, `_meta` tasimayan MESRU bir v1 `tools/list`'ini
reddederdik — sunucuyu v1 istemcilere kapatirdik. O yuzden koruyucu SADECE
her iki sarti birden saglayan metotlara bakar:

  1. metot YALNIZCA 2026-07-28'de vardir (mcp_types.methods.CLIENT_REQUESTS
     haritasindan TURETILIR, elle yazilmaz), VE
  2. bu sunucu o metodu GERCEKTEN servis eder.

(2) sarti onemlidir: `subscriptions/listen` de yalnizca-modern bir metottur
ama biz onu servis ETMIYORUZ. Onun -32601'i DOGRUDUR ve maskelenmemelidir;
-32601 ancak metot VARKEN yalan olur.

MCP_PROTOCOL=2025-11-25 iken koruyucu HIC TAKILMAZ (bkz. server.py). Sebep:
o modda sunucu v1-only oldugunu IDDIA eder ve `server/discover` sondasina
v1-only bir sunucu gibi -32601 vermelidir. Orada -32602 dondurmek, 2026 zarfini
anladigimizi ele verir ve pazarlik dersini yalancilastirirdi.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from mcp.shared.inbound import InboundLadderRejection, classify_inbound_request
from mcp_types.methods import CLIENT_REQUESTS
from mcp_types.version import MODERN_PROTOCOL_VERSIONS

log = logging.getLogger(__name__)

#: Denetleyici imzasi: cozulmus mesaj -> tel'e yazilacak hata govdesi | None.
Denetleyici = Callable[[Any], "dict | None"]

_MODERN = frozenset(MODERN_PROTOCOL_VERSIONS)

#: 2026-07-28'de VAR, hicbir 2025 revizyonunda YOK olan istek metotlari.
#:
#: SDK'nin (metot, surum) -> model haritasindan TURETILIR; elle yazilmis bir
#: liste, SDK guncellendiginde sessizce yanlislasirdi. Bugun {"server/discover",
#: "subscriptions/listen"} verir.
MODERN_ONLY_METHODS: frozenset[str] = frozenset(
    metot for metot, surum in CLIENT_REQUESTS if surum in _MODERN
) - frozenset(metot for metot, surum in CLIENT_REQUESTS if surum not in _MODERN)


def korunan_metotlar(server: Any) -> frozenset[str]:
    """`MODERN_ONLY_METHODS` icinden BU sunucunun gercekten servis ettikleri.

    Servis edilmeyen bir metodun -32601'i dogrudur; onu -32602'ye cevirmek
    "metot yok" gercegini gizlerdi. `get_request_handler` mcp 2.0.0'in public
    API'sidir (mcp/server/lowlevel/server.py).
    """
    return frozenset(m for m in MODERN_ONLY_METHODS if server.get_request_handler(m) is not None)


def zarf_hatasi_bul(mesaj: Any, metotlar: frozenset[str]) -> dict | None:
    """Modern-zarf ihlali varsa JSON-RPC hata govdesi, yoksa None doner.

    UC SEYE DOKUNMAZ (hepsi bilincli):
      * yanitlar (`method` yok)          -> koruyucunun isi degil
      * notification'lar (`id` yok/null) -> id'siz istege YANIT YASAKTIR (J6)
      * listede olmayan metotlar         -> karari SDK verir (v1 trafigi buradan gecer)
    """
    if not isinstance(mesaj, dict):
        return None
    metot = mesaj.get("method")
    if not isinstance(metot, str) or metot not in metotlar:
        return None
    if mesaj.get("id") is None:
        return None

    karar = classify_inbound_request({"method": metot, "params": mesaj.get("params")})
    if not isinstance(karar, InboundLadderRejection):
        return None

    hata: dict[str, Any] = {"code": karar.code, "message": karar.message}
    # `data` yalnizca DOLUYSA yazilir: SDK stdout'a `exclude_unset=True` ile
    # serilestirir, biz de tel'e gereksiz bir `"data": null` dusurmeyiz.
    if karar.data is not None:
        hata["data"] = karar.data
    return {"jsonrpc": "2.0", "id": mesaj["id"], "error": hata}


def zarf_denetleyici(metotlar: frozenset[str]) -> Denetleyici | None:
    """parse_guard'a verilecek denetleyiciyi uretir; korunacak metot yoksa None."""
    if not metotlar:
        return None

    def denetle(mesaj: Any) -> dict | None:
        govde = zarf_hatasi_bul(mesaj, metotlar)
        if govde is not None:
            log.warning(
                "eksik/bozuk 2026-07-28 zarfı: %s isteği düşürüldü, %s döndürüldü — %s",
                mesaj.get("method"),
                govde["error"]["code"],
                govde["error"]["message"],
            )
        return govde

    return denetle


__all__ = [
    "MODERN_ONLY_METHODS",
    "Denetleyici",
    "korunan_metotlar",
    "zarf_denetleyici",
    "zarf_hatasi_bul",
]
