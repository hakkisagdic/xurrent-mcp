"""Eksik `_meta` zarfi koruyucusunun testleri (uyum maddeleri Y2b ve Y3b).

BU TESTLER NEDEN VAR: her iki davranisin da belirtisi INCEDIR.

  * Y2b bozulunca sunucu yine CALISIR — sadece uyumluluk sondasina "ben 2026
    oncesiyim" der ve istemci sessizce v1'e duser. Hicbir sey patlamaz; tool'lar
    calisir; yalnizca yeni protokol HIC KONUSULMAZ.
  * Y3b bozulunca tek basina gonderilen istek DOGRU islenir; hata ancak ONUNDE
    bozuk zarfli bir istek varsa gorunur. Yani "elle denedim, calisiyor" demek
    bu regresyonu KACIRIR.

Ikisi de sessizce geri gelebilecek turden hatalardir; test yoksa fark edilmezler.

conftest.py'nin "I/O YOK" kurali burada da gecerlidir: `zarf_hatasi_bul` saf bir
fonksiyondur, `_stdio_denetleyici` ise sunucu ayaga kaldirilmadan, yalnizca
`get_request_handler` yuzeyini taklit eden bir sahte nesneyle kosulur.
"""

from __future__ import annotations

import json

import pytest

from xurrent_mcp.config import MCP_PROTOCOL_V1, MCP_PROTOCOL_V2
from xurrent_mcp.mcp.envelope_guard import (
    MODERN_ONLY_METHODS,
    korunan_metotlar,
    zarf_denetleyici,
    zarf_hatasi_bul,
)
from xurrent_mcp.mcp.parse_guard import ParseKoruyucu
from xurrent_mcp.server import _stdio_denetleyici

DISCOVER = "server/discover"
KORUNAN = frozenset({DISCOVER})

META_VERSION = "io.modelcontextprotocol/protocolVersion"
META_CAPS = "io.modelcontextprotocol/clientCapabilities"
META_INFO = "io.modelcontextprotocol/clientInfo"

# ★ Spec bu kodu "bu sunucu 2026 oncesi" sinyali olarak tanimlar; bu yuzden
#   "istegin bozuk" demek icin KULLANILAMAZ.
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
UNSUPPORTED_PROTOCOL_VERSION = -32022


def tam_meta(surum: str = "2026-07-28") -> dict:
    return {
        META_VERSION: surum,
        META_CAPS: {"elicitation": {}},
        META_INFO: {"name": "test", "version": "1.0.0"},
    }


def istek(metot: str = DISCOVER, params: dict | None = None, id_degeri: object = 1) -> dict:
    mesaj: dict = {"jsonrpc": "2.0", "id": id_degeri, "method": metot}
    if params is not None:
        mesaj["params"] = params
    return mesaj


# ── Y2b: eksik zarfin kodu -32601 OLMAMALI ──────────────────────────────────


def test_meta_siz_discover_reddedilir_ama_32601_ile_DEGIL():
    """★ Maddenin tam kendisi: red SART, ama '-32601 = metot yok' DEGIL.

    Ikisini ayni kodla dondurmek 'bu sunucu 2026 oncesi' ile 'senin istegin
    bozuk'u AYIRT EDILEMEZ yapar; sonda v2 konusan sunucuyu v1 sanar.
    """
    govde = zarf_hatasi_bul(istek(params={}), KORUNAN)
    assert govde is not None, "eksik zarf REDDEDILMELI (Y2)"
    assert govde["error"]["code"] != METHOD_NOT_FOUND
    assert govde["error"]["code"] == INVALID_PARAMS


def test_hata_mesaji_HANGI_meta_anahtarinin_eksik_oldugunu_soyler():
    """Kod tek basina yetmez: mesaj eksigi ADIYLA soylemelidir."""
    govde = zarf_hatasi_bul(istek(params={}), KORUNAN)
    assert META_VERSION in govde["error"]["message"]
    assert META_CAPS in govde["error"]["message"]


def test_params_hic_yoksa_da_ayni_sekilde_reddedilir():
    govde = zarf_hatasi_bul(istek(params=None), KORUNAN)
    assert govde is not None
    assert govde["error"]["code"] == INVALID_PARAMS


def test_protocolVersion_eksikse_reddedilir_ve_ADIYLA_anilir():
    meta = tam_meta()
    del meta[META_VERSION]
    govde = zarf_hatasi_bul(istek(params={"_meta": meta}), KORUNAN)
    assert govde is not None, "protocolVersion MUST'tur — reddedilmeli (Y3a)"
    assert govde["error"]["code"] == INVALID_PARAMS
    assert META_VERSION in govde["error"]["message"]


def test_clientCapabilities_eksikse_reddedilir():
    meta = tam_meta()
    del meta[META_CAPS]
    govde = zarf_hatasi_bul(istek(params={"_meta": meta}), KORUNAN)
    assert govde is not None, "clientCapabilities MUST'tur (Y15a)"
    assert META_CAPS in govde["error"]["message"]


def test_yanit_govdesi_istegin_id_sini_TASIR():
    """Istemci yanitini eslestiremezse hata pratikte 'sessizlik' olur."""
    govde = zarf_hatasi_bul(istek(params={}, id_degeri="abc-7"), KORUNAN)
    assert govde["id"] == "abc-7"
    assert govde["jsonrpc"] == "2.0"


def test_desteklenmeyen_surum_spec_kodunu_ve_data_sini_aynen_aktarir():
    """-32022 SDK'nin merdiveninden gelir; koruyucu onu YENIDEN YAZMAZ (Y14b)."""
    govde = zarf_hatasi_bul(istek(params={"_meta": tam_meta("1999-01-01")}), KORUNAN)
    assert govde["error"]["code"] == UNSUPPORTED_PROTOCOL_VERSION
    assert govde["error"]["data"]["requested"] == "1999-01-01"


def test_data_yoksa_govdeye_HIC_konmaz():
    """`"data": null` tel'e gereksiz alan dusururdu (SDK exclude_unset ile yazar)."""
    govde = zarf_hatasi_bul(istek(params={}), KORUNAN)
    assert "data" not in govde["error"]


# ── Y3b: clientInfo SHOULD'dur, MUST DEGIL ──────────────────────────────────


def test_clientInfo_YOKSA_istek_gecer():
    """★ Spec: 'Clients SHOULD identify themselves on each request.'

    SHOULD'u MUST gibi zorlamak spec'ten KATI davranmaktir ve clientInfo
    gondermeyen mesru bir istemciyi kirar.
    """
    meta = tam_meta()
    del meta[META_INFO]
    assert zarf_hatasi_bul(istek(params={"_meta": meta}), KORUNAN) is None


def test_tam_zarf_dokunulmadan_gecer():
    assert zarf_hatasi_bul(istek(params={"_meta": tam_meta()}), KORUNAN) is None


# ── Kapsam: koruyucu YANLIS trafige dokunmamali ─────────────────────────────


def test_meta_siz_tools_list_e_DOKUNULMAZ():
    """★ En tehlikeli regresyon: bunu reddetmek sunucuyu v1 istemcilere KAPATIR.

    `tools/list` her iki revizyonda da vardir; v1'de `_meta` TASIMAZ. Koruyucu
    yalnizca 'yalnizca-modern' metotlara bakar.
    """
    assert zarf_hatasi_bul(istek("tools/list", params={}), KORUNAN) is None
    assert zarf_hatasi_bul(istek("tools/call", params={"name": "x"}), KORUNAN) is None
    assert zarf_hatasi_bul(istek("initialize", params={}), KORUNAN) is None


def test_notification_a_ASLA_yanit_uretilmez():
    """id'siz istege yanit YASAKTIR (uyum maddesi J6)."""
    assert zarf_hatasi_bul({"jsonrpc": "2.0", "method": DISCOVER, "params": {}}, KORUNAN) is None
    assert (
        zarf_hatasi_bul({"jsonrpc": "2.0", "id": None, "method": DISCOVER, "params": {}}, KORUNAN)
        is None
    )


@pytest.mark.parametrize(
    "mesaj",
    [
        {"jsonrpc": "2.0", "id": 1, "result": {}},  # yanit — method yok
        {"jsonrpc": "2.0", "id": 1, "method": 42},  # method string degil
        [1, 2, 3],  # batch/dizi
        "duz metin",
        None,
    ],
)
def test_istek_olmayan_cerceveler_gecer(mesaj):
    assert zarf_hatasi_bul(mesaj, KORUNAN) is None


# ── Korunacak metot kumesi ──────────────────────────────────────────────────


def test_modern_only_kumesi_SDK_haritasindan_turetilir():
    """Elle yazilmis bir liste SDK guncellendiginde sessizce yanlislasirdi."""
    assert DISCOVER in MODERN_ONLY_METHODS
    for iki_erada_da_olan in ("tools/list", "tools/call", "prompts/list"):
        assert iki_erada_da_olan not in MODERN_ONLY_METHODS


class _SahteSunucu:
    """`Server`in yalnizca ihtiyac duyulan yuzeyi — sunucu ayaga kaldirilmaz."""

    def __init__(self, kayitli: set[str]) -> None:
        self._kayitli = kayitli

    def get_request_handler(self, metot: str):
        return object() if metot in self._kayitli else None


def test_servis_EDILMEYEN_modern_metot_korunmaz():
    """★ -32601 ancak metot VARKEN yalan olur.

    `subscriptions/listen` de yalnizca-modern bir metottur ama bu sunucu onu
    servis etmez; oradaki 'metot yok' DOGRUDUR ve maskelenmemelidir.
    """
    metotlar = korunan_metotlar(_SahteSunucu({DISCOVER}))
    assert metotlar == {DISCOVER}
    assert "subscriptions/listen" not in metotlar


def test_korunacak_metot_yoksa_denetleyici_uretilmez():
    assert zarf_denetleyici(frozenset()) is None


# ── server.py kablolamasi ───────────────────────────────────────────────────


def test_v1_modunda_koruyucu_TAKILMAZ(yapilandirma):
    """★ MCP_PROTOCOL=2025-11-25 iken sunucu v1-only oldugunu IDDIA eder.

    O modda `server/discover` sondasina -32601 vermek DOGRUDUR; -32602 dondurmek
    2026 zarfini anladigimizi ele verir ve pazarlik dersini yalancilastirirdi.
    """
    cfg = yapilandirma(mcp_protocol=MCP_PROTOCOL_V1)
    assert _stdio_denetleyici(cfg, _SahteSunucu({DISCOVER})) is None


def test_v2_modunda_koruyucu_TAKILIR(yapilandirma):
    cfg = yapilandirma(mcp_protocol=MCP_PROTOCOL_V2)
    denetle = _stdio_denetleyici(cfg, _SahteSunucu({DISCOVER}))
    assert denetle is not None
    assert denetle(istek(params={}))["error"]["code"] == INVALID_PARAMS


# ── parse_guard ile birlesik davranis ───────────────────────────────────────


def _suz(satirlar: list[str], denetle) -> tuple[list[str], list[dict]]:
    koruyucu = ParseKoruyucu(denetle)
    olaylar = []
    for satir in satirlar:
        olaylar += koruyucu.besle(satir)
    olaylar += koruyucu.bitir()
    return (
        [d for tur, d in olaylar if tur == "satir"],
        [d for tur, d in olaylar if tur == "hata"],
    )


def test_bozuk_zarfli_cerceve_SDKya_HIC_ULASMAZ():
    """★ Y3b'yi duzelten sey tam olarak budur, ve tesadufi DEGILDIR.

    SDK'nin stdio era secimi ILK ISTEGE bakar (runner.py `serve_dual_era_loop`)
    ve `_meta`'da `protocolVersion` yoksa baglantiyi 2025'e KILITLER. Bozuk
    cerceve SDK'ya ulasmazsa erayi de secemez — ondan sonraki KUSURSUZ 2026
    istegi normal islenir. Cerceve gecerse, sonraki her istek -32600 alir.
    """
    denetle = zarf_denetleyici(KORUNAN)
    meta = tam_meta()
    del meta[META_VERSION]
    bozuk = json.dumps(istek(params={"_meta": meta}))
    saglam = json.dumps(istek(params={"_meta": tam_meta()}, id_degeri=2))

    gecenler, hatalar = _suz([bozuk + "\n", saglam + "\n"], denetle)

    assert gecenler == [saglam], "bozuk zarf SDK'ya gecmemeli, saglam olan gecmeli"
    assert [h["error"]["code"] for h in hatalar] == [INVALID_PARAMS]
    assert hatalar[0]["id"] == 1


def test_denetleyici_bozuk_JSONun_onune_gecmez():
    """Ayristirilamayan satir -32700'un konusudur; denetleyici onu HIC gormez."""
    gorulenler: list[object] = []

    def denetle(mesaj):
        gorulenler.append(mesaj)
        return None

    gecenler, hatalar = _suz(['{"id":9,"method":"x"' + "\n"], denetle)
    assert gecenler == []
    assert hatalar[0]["error"]["code"] == -32700
    assert gorulenler == [], "ayristirilamayan satir denetleyiciye ulasmamali"


def test_denetleyicisiz_koruyucu_eski_davranisini_korur():
    """Varsayilan (denetleyicisiz) kullanim J5 disinda HICBIR SEYI degistirmez."""
    mesaj = json.dumps(istek(params={}))
    gecenler, hatalar = _suz([mesaj + "\n"], None)
    assert gecenler == [mesaj]
    assert hatalar == []
