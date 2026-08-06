"""HTTP yuzeyi birim testleri — yol tablosu + MCP_API_KEY kapisi (mcp/http.py).

CALISTIRMA: uv run pytest tests/test_http_gate.py -q

Kurallar conftest.py'dekiyle ayni: I/O YOK — ASGI cagrilari bellek icidir
(uvicorn ayaga KALKMAZ), kapi ara katmani sahte scope/receive/send ile surulur.
Tam HTTP el sikismasi dumani merkezi olarak ayrica kosulur (senaryo koşucusu
degil; bkz. WP6 raporu) — buradaki iddialar SAF tablo/karsilastirma/kapidir.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from xurrent_mcp.config import MCP_PROTOCOL_V1, MCP_PROTOCOL_V2  # noqa: E402
from xurrent_mcp.mcp.http import (  # noqa: E402
    ApiKeyKapisi,
    api_key_dogru,
    build_http_app,
    dinleme_adresi,
    izinli_hostlar,
    izinli_originler,
    yol_tablosu,
)

# ══════════════════════════════════ 1. yol tablosu


def test_tek_era_2026_mcp_yolunda_stateless_v2() -> None:
    assert yol_tablosu(MCP_PROTOCOL_V2) == [("/mcp", "v2")]


def test_tek_era_2025_mcp_yolunda_sessionful_v1() -> None:
    assert yol_tablosu(MCP_PROTOCOL_V1) == [("/mcp", "v1")]


def test_both_uc_yol_ve_mcp_v2_nin_takma_adi() -> None:
    """/mcp/v1 sessionful, /mcp/v2 stateless, /mcp = v2 (guncel spec varsayilan)."""
    assert yol_tablosu("both") == [
        ("/mcp/v1", "v1"),
        ("/mcp/v2", "v2"),
        ("/mcp", "v2"),
    ]


# ══════════════════════════════════ 2. API anahtari karsilastirmasi


def test_dogru_anahtar_kabul_edilir() -> None:
    assert api_key_dogru("deneme", "deneme") is True


def test_yanlis_anahtar_reddedilir() -> None:
    assert api_key_dogru("deneme", "yanlis") is False
    assert api_key_dogru("deneme", "denem") is False
    assert api_key_dogru("deneme", "deneme ") is False


def test_baslik_yoksa_reddedilir() -> None:
    assert api_key_dogru("deneme", None) is False


def test_bos_beklenen_anahtar_hicbir_seyi_acmaz() -> None:
    """Kapi bos anahtarla KURULMAZ; yine de 'bos == bos gecer' sessiz hatasina
    yer birakmiyoruz — bos beklenen deger her girdiyi reddeder."""
    assert api_key_dogru("", "") is False
    assert api_key_dogru("", "deneme") is False
    assert api_key_dogru("", None) is False


def test_karsilastirma_sabit_zamanli_hmac_iledir() -> None:
    """Politika denetimi: '==' zamanlama sizdirir; hmac.compare_digest sart.
    Kaynak kodda compare_digest cagrisinin varligini dogruluyoruz — davranis
    testi zamanlamayi olcemez, en durust kanit budur."""
    import inspect

    kaynak = inspect.getsource(api_key_dogru)
    assert "hmac.compare_digest" in kaynak
    assert " == " not in kaynak.split('"""')[-1]  # govdede duz karsilastirma yok


# ══════════════════════════════════ 3. bind adresi


def test_anahtar_boske_yalnizca_loopback() -> None:
    assert dinleme_adresi("") == "127.0.0.1"


def test_anahtar_doluyken_disa_acilir() -> None:
    assert dinleme_adresi("deneme") == "0.0.0.0"


# ══════════════════════════════════ 4. kapi ara katmani (ASGI, bellek ici)


class _IcUygulama:
    """Kapinin ARKASINDAKI uygulamayi temsil eder; cagrildigini kaydeder."""

    def __init__(self) -> None:
        self.cagrildi = False

    async def __call__(self, scope, receive, send) -> None:
        self.cagrildi = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def _kapiyi_sur(app, path: str, headers: list[tuple[bytes, bytes]]):
    """Kapiyi sahte ASGI mesajlariyla surer; (status, govde) doner."""

    async def _run():
        mesajlar: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(mesaj):
            mesajlar.append(mesaj)

        scope = {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": headers,
            "query_string": b"",
        }
        await app(scope, receive, send)
        return mesajlar

    mesajlar = asyncio.run(_run())
    status = next(m["status"] for m in mesajlar if m["type"] == "http.response.start")
    govde = b"".join(m.get("body", b"") for m in mesajlar if m["type"] == "http.response.body")
    return status, govde


def test_kapi_anahtarsiz_mcp_istegini_401_ile_keser() -> None:
    ic = _IcUygulama()
    kapi = ApiKeyKapisi(ic, "deneme")
    status, govde = _kapiyi_sur(kapi, "/mcp/v1", headers=[])
    assert status == 401
    assert ic.cagrildi is False  # istek ic uygulamaya ULASMADI
    hata = json.loads(govde.decode("utf-8"))
    assert "X-MCP-Api-Key" in hata["errors"][0]["message"]  # kisa Turkce govde


def test_kapi_yanlis_anahtari_da_401_ile_keser() -> None:
    ic = _IcUygulama()
    kapi = ApiKeyKapisi(ic, "deneme")
    status, _ = _kapiyi_sur(kapi, "/mcp/v2", headers=[(b"x-mcp-api-key", b"yanlis")])
    assert status == 401 and ic.cagrildi is False


def test_kapi_dogru_anahtari_gecirir() -> None:
    ic = _IcUygulama()
    kapi = ApiKeyKapisi(ic, "deneme")
    status, govde = _kapiyi_sur(kapi, "/mcp", headers=[(b"x-mcp-api-key", b"deneme")])
    assert status == 200 and govde == b"ok"
    assert ic.cagrildi is True


def test_kapi_buyuk_harfli_basligi_da_taniyor() -> None:
    """HTTP basliklari buyuk-kucuk harf duyarsizdir; ASGI kucuk harf garanti
    eder ama spec disi bir varyant sessizce 401 uretmemeli."""
    ic = _IcUygulama()
    kapi = ApiKeyKapisi(ic, "deneme")
    status, _ = _kapiyi_sur(kapi, "/mcp", headers=[(b"X-MCP-Api-Key", b"deneme")])
    assert status == 200 and ic.cagrildi is True


def test_kapi_mcp_disi_yollari_suzmez() -> None:
    """Kapi /mcp* yollarini korur; baska yollar (ornegin web chat saglik ucu)
    bu katmandan etkilenmez."""
    ic = _IcUygulama()
    kapi = ApiKeyKapisi(ic, "deneme")
    status, _ = _kapiyi_sur(kapi, "/saglik", headers=[])
    assert status == 200 and ic.cagrildi is True


# ══════════════════════════════════ 5. uygulama kurulumu (yol tablosu -> rotalar)


def _sahte_fabrika(kayit: list[str]):
    class _SahteSunucu:
        """StreamableHTTPSessionManager yalnizca referans tutar; kurulum
        testinde gercek Server gerekmez (uvicorn/lifespan CALISTIRILMAZ)."""

    def fabrika(protocol: str):
        kayit.append(protocol)
        return _SahteSunucu()

    return fabrika


def test_build_http_app_both_rotalari_tabloyla_ayni(yapilandirma) -> None:
    kayit: list[str] = []
    cfg = yapilandirma(mcp_protocol="both")
    app, host = build_http_app(cfg, _sahte_fabrika(kayit))
    # Era basina TEK sunucu kuruldu (v1, v2) — /mcp takma adi v2'yi PAYLASIR.
    assert kayit == [MCP_PROTOCOL_V1, MCP_PROTOCOL_V2]
    assert [r.path for r in app.routes] == ["/healthz", "/mcp/v1", "/mcp/v2", "/mcp"]
    assert host == "127.0.0.1"  # anahtar bos -> loopback


def test_build_http_app_tek_era_tek_mcp_rotasi(yapilandirma) -> None:
    kayit: list[str] = []
    cfg = yapilandirma(mcp_protocol=MCP_PROTOCOL_V2)
    app, _ = build_http_app(cfg, _sahte_fabrika(kayit))
    assert kayit == [MCP_PROTOCOL_V2]
    assert [r.path for r in app.routes] == ["/healthz", "/mcp"]


def test_build_http_app_anahtar_doluysa_kapiyla_sarilir(yapilandirma) -> None:
    cfg = yapilandirma(mcp_protocol="both", mcp_api_key="deneme")
    app, host = build_http_app(cfg, _sahte_fabrika([]))
    assert isinstance(app, ApiKeyKapisi)
    assert host == "0.0.0.0"


def _mcp_yoneticileri(app):
    """Yol -> StreamableHTTPSessionManager haritasi (/healthz'in yoneticisi YOK).
    Anahtar doluyken uygulama ApiKeyKapisi ile sarilidir — once acilir."""
    ic = app.app if isinstance(app, ApiKeyKapisi) else app
    return {
        r.path: r.app.session_manager
        for r in ic.routes
        if r.path.startswith("/mcp")
    }


def test_build_http_app_stateless_durusu_eraya_gore(yapilandirma) -> None:
    """Oturum durusu sozlesmenin parcasi: v1 sessionful, v2 stateless.
    SDK'ya giden bayragi dogrudan dogruluyoruz."""
    cfg = yapilandirma(mcp_protocol="both")
    app, _ = build_http_app(cfg, _sahte_fabrika([]))
    yonetici_by_yol = _mcp_yoneticileri(app)
    assert yonetici_by_yol["/mcp/v1"].stateless is False
    assert yonetici_by_yol["/mcp/v2"].stateless is True
    # /mcp takma adi v2 yoneticisinin AYNISIDIR (ayri sunucu degil).
    assert yonetici_by_yol["/mcp"] is yonetici_by_yol["/mcp/v2"]


# ══════════════════════════════════ 6. Host suzgeci — uc durus (DNS rebinding)


def test_anahtar_boske_rebinding_korumasi_ACIK_ve_localhost(yapilandirma) -> None:
    """Loopback modunun kati durusu DEGISMEDI: koruma acik, yalnizca localhost."""
    cfg = yapilandirma(mcp_protocol=MCP_PROTOCOL_V2)
    app, _ = build_http_app(cfg, _sahte_fabrika([]))
    guvenlik = _mcp_yoneticileri(app)["/mcp"].security_settings
    assert guvenlik.enable_dns_rebinding_protection is True
    assert "localhost:*" in guvenlik.allowed_hosts


def test_anahtar_doluyken_host_suzgeci_ACIKCA_kapali(yapilandirma) -> None:
    """Acik modda kapi API anahtaridir; Host suzgeci konteynerler arasi cagriyi
    421 ile keserdi. Kapatma SDK varsayilanina birakilmaz, ACIKCA yazilir."""
    cfg = yapilandirma(mcp_protocol=MCP_PROTOCOL_V2, mcp_api_key="deneme")
    app, _ = build_http_app(cfg, _sahte_fabrika([]))
    guvenlik = _mcp_yoneticileri(app)["/mcp"].security_settings
    assert guvenlik is not None  # None -> SDK geriye-uyum varsayilanina yaslanmak olurdu
    assert guvenlik.enable_dns_rebinding_protection is False


def test_allowed_hosts_verilirse_acik_modda_da_suzgec_ACIK(yapilandirma) -> None:
    """Derinlemesine savunma: anahtar + MCP_ALLOWED_HOSTS -> yalnizca liste gecer."""
    cfg = yapilandirma(
        mcp_protocol="both",
        mcp_api_key="deneme",
        mcp_allowed_hosts=("only.example",),
    )
    app, _ = build_http_app(cfg, _sahte_fabrika([]))
    for yonetici in _mcp_yoneticileri(app).values():
        guvenlik = yonetici.security_settings
        assert guvenlik.enable_dns_rebinding_protection is True
        assert "only.example" in guvenlik.allowed_hosts
        assert "only.example:*" in guvenlik.allowed_hosts
        assert "localhost:*" not in guvenlik.allowed_hosts  # liste NEYSE odur


def test_izinli_hostlar_ciplak_girdiyi_portlu_varyantla_acar() -> None:
    assert izinli_hostlar(["only.example"]) == ["only.example", "only.example:*"]


def test_izinli_hostlar_acik_portlu_girdiyi_OLDUGU_GIBI_birakir() -> None:
    """Kullanici portu acikca yazdiysa yalnizca o port gecerlidir."""
    assert izinli_hostlar(["only.example:9000"]) == ["only.example:9000"]


def test_izinli_originler_http_ve_https_varyantlarini_uretir() -> None:
    assert izinli_originler(["only.example"]) == [
        "http://only.example",
        "https://only.example",
        "http://only.example:*",
        "https://only.example:*",
    ]


# ══════════════════════════════════ 7. /healthz — kapisiz saglik ucu


def _healthz_cagir(app):
    """GET /healthz'i bellek ici ASGI ile surer; (status, json_govde) doner."""

    async def _run():
        mesajlar: list[dict] = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(mesaj):
            mesajlar.append(mesaj)

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/healthz",
            "headers": [(b"host", b"evil.example")],  # Host suzgecine TABI DEGIL
            "query_string": b"",
        }
        await app(scope, receive, send)
        return mesajlar

    mesajlar = asyncio.run(_run())
    status = next(m["status"] for m in mesajlar if m["type"] == "http.response.start")
    govde = b"".join(m.get("body", b"") for m in mesajlar if m["type"] == "http.response.body")
    return status, json.loads(govde.decode("utf-8"))


@pytest.mark.parametrize("protokol", [MCP_PROTOCOL_V2, MCP_PROTOCOL_V1, "both"])
def test_healthz_her_protokol_modunda_200_ve_kucuk_govde(yapilandirma, protokol) -> None:
    """Orkestrator sondasi MCP konusamaz: /healthz protokol modundan bagimsiz
    calisir ve yalnizca status + protokol doner."""
    cfg = yapilandirma(mcp_protocol=protokol)
    app, _ = build_http_app(cfg, _sahte_fabrika([]))
    status, govde = _healthz_cagir(app)
    assert status == 200
    assert govde == {"status": "ok", "protocol": protokol}


def test_healthz_api_anahtari_ISTEMEZ_ve_sir_sizdirmaz(yapilandirma) -> None:
    """Kapi yalnizca /mcp* yollarini korur; saglik sondasina anahtar dagitmak
    gerekmez. Govde anahtari/sirri ICERMEZ."""
    cfg = yapilandirma(
        mcp_protocol=MCP_PROTOCOL_V2, mcp_api_key="cok-gizli", state_secret="sir"
    )
    app, _ = build_http_app(cfg, _sahte_fabrika([]))
    assert isinstance(app, ApiKeyKapisi)  # kapi kurulu ama /healthz'e dokunmuyor
    status, govde = _healthz_cagir(app)
    assert status == 200
    assert govde == {"status": "ok", "protocol": MCP_PROTOCOL_V2}
    assert "cok-gizli" not in json.dumps(govde) and "sir" not in json.dumps(govde)
