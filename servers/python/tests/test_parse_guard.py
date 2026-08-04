"""Bozuk JSON koruyucusunun testleri (TypeScript'teki parse-guard.test.mjs'in esi).

Bu koruyucu bir SPEC IHLALINI kapatmak icin var (JSON-RPC MUST: -32700).
Sessizce bozulursa ihlal geri gelir ve KIMSE FARK ETMEZ — cunku ihlalin
belirtisi "hicbir sey olmamasi"dir: istemci bekler, yanit gelmez, hata da yoktur.
Testleri o yuzden var.

conftest.py'nin "I/O YOK" kurali burada da gecerlidir: `ParseKoruyucu` saf bir
durum makinesidir; async katman ise bellek-ici bir uretecle, gercek stdin'e
DOKUNMADAN kosulur.
"""

from __future__ import annotations

import json

import anyio
import pytest

from xurrent_mcp.mcp.parse_guard import (
    PARSE_HATA_MESAJI,
    ParseKoruyucu,
    id_kurtar,
    korumali_satirlar,
)

KESILMIS = '{"jsonrpc":"2.0","id":991,"method":"tools/list","params":'


def suz(parcalar: list[str]) -> tuple[list[str], list[dict]]:
    """Parcalari koruyucudan gecirir; (gecen satirlar, uretilen hatalar) doner."""
    koruyucu = ParseKoruyucu()
    olaylar = []
    for parca in parcalar:
        olaylar += koruyucu.besle(parca)
    olaylar += koruyucu.bitir()
    gecenler = [d for tur, d in olaylar if tur == "satir"]
    hatalar = [d for tur, d in olaylar if tur == "hata"]
    return gecenler, hatalar


def test_gecerli_satir_degistirilmeden_gecer():
    mesaj = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    gecenler, hatalar = suz([mesaj + "\n"])
    assert gecenler == [mesaj]
    assert hatalar == [], "gecerli satir icin hata uretilmemeli"


def test_bozuk_satir_dusurulur_ve_yerine_32700_yazilir():
    gecenler, hatalar = suz([KESILMIS + "\n"])
    assert gecenler == [], "bozuk satir SDK'ya ulasmamali"
    assert len(hatalar) == 1
    assert hatalar[0]["error"]["code"] == -32700
    assert hatalar[0]["jsonrpc"] == "2.0"
    assert hatalar[0]["error"]["message"] == PARSE_HATA_MESAJI


def test_kesilmis_mesajdan_id_kurtarilir():
    """★ Spec `null`a izin verir ama istemci istegini eslestirebilsin diye
    gercek id cok daha faydalidir."""
    _, hatalar = suz([KESILMIS + "\n"])
    assert hatalar[0]["id"] == 991, "id kurtarilabiliyorken null donmek ise yaramaz"


def test_id_hic_yoksa_none_doner():
    _, hatalar = suz(["bu hic JSON degil\n"])
    assert hatalar[0]["id"] is None, "spec ayristirma hatasinda null'a izin verir"


def test_string_id_de_kurtarilir():
    _, hatalar = suz(['{"id":"abc-7","method":\n'])
    assert hatalar[0]["id"] == "abc-7"


def test_iki_parcaya_bolunmus_gecerli_mesaj_bozuk_sayilmaz():
    """★ Gercek trafikte bir mesaj birden cok okumaya bolunur. Tamponu yanlis
    yonetmek, calisan bir sunucuyu her buyuk istekte kiran bir hata olurdu."""
    mesaj = json.dumps({"jsonrpc": "2.0", "id": 5, "method": "tools/call"})
    orta = len(mesaj) // 2
    gecenler, hatalar = suz([mesaj[:orta], mesaj[orta:] + "\n"])
    assert gecenler == [mesaj]
    assert hatalar == []


def test_bozuk_satir_sonraki_gecerli_satiri_zehirlemez():
    """★ Kurtarmadan sonra akis DEVAM etmeli; tek bozuk satir oturumu oldurmez."""
    iyi = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    gecenler, hatalar = suz(["{bozuk\n", iyi + "\n"])
    assert gecenler == [iyi]
    assert len(hatalar) == 1


def test_bos_satirlar_sessizce_atlanir():
    gecenler, hatalar = suz(["\n", "   \n"])
    assert gecenler == []
    assert hatalar == [], "bos satir bozuk JSON DEGILDIR"


def test_akis_kapanirken_tamponda_kalan_bozuk_parca_da_32700_uretir():
    gecenler, hatalar = suz(['{"id":3,"method":"x"'])  # sonda \n YOK
    assert gecenler == []
    assert len(hatalar) == 1
    assert hatalar[0]["id"] == 3


def test_akis_kapanirken_tamponda_kalan_gecerli_parca_gecer():
    mesaj = json.dumps({"jsonrpc": "2.0", "id": 4, "method": "tools/list"})
    gecenler, hatalar = suz([mesaj])  # sonda \n YOK
    assert gecenler == [mesaj]
    assert hatalar == []


@pytest.mark.parametrize(
    "govde, beklenen",
    [
        ('{"id":-4,', -4),
        ('{ "id" : 12 ,', 12),
        ('{"id":"a\\"b",', 'a\\"b'),
        ('{"method":"x"', None),
    ],
)
def test_id_kurtar_kenar_durumlari(govde, beklenen):
    assert id_kurtar(govde) == beklenen


# ── async katman: KorumaliStdin'in besledigi ureteç ──────────────────────────
# Gercek stdin YOK; kaynak bellek-ici bir async ureteçtir. Amac, saf durum
# makinesinin dogru kablolandigini gostermek: gecerli satirlar SDK'ya, hatalar
# yazicilara gider.


def _kos(parcalar: list[str]) -> tuple[list[str], list[dict]]:
    gecenler: list[str] = []
    hatalar: list[dict] = []

    async def kaynak():
        for parca in parcalar:
            yield parca

    async def hata_yaz(govde):
        hatalar.append(govde)

    async def main():
        async for satir in korumali_satirlar(kaynak(), hata_yaz):
            gecenler.append(satir)

    anyio.run(main)
    return gecenler, hatalar


def test_async_katman_gecerli_satiri_satir_sonuyla_birlikte_iletir():
    mesaj = json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/list"})
    gecenler, hatalar = _kos([mesaj + "\n"])
    assert gecenler == [mesaj + "\n"], "SDK satir tabanli okur; satir sonu SART"
    assert hatalar == []


def test_async_katman_bozugu_yazara_yollar_iyiyi_gecirir():
    iyi = json.dumps({"jsonrpc": "2.0", "id": 8, "method": "tools/list"})
    gecenler, hatalar = _kos([KESILMIS + "\n", iyi + "\n"])
    assert gecenler == [iyi + "\n"]
    assert [h["error"]["code"] for h in hatalar] == [-32700]
    assert hatalar[0]["id"] == 991


def test_son_satirin_hatasi_akis_bitmeden_YAZILMIS_olur():
    """★ Kapanis yarisi: SON satir bozuksa hatasi tel'e YETISMELIDIR.

    Bu bir "ates et ve unut" regresyonunun testidir. Gonderim ayri bir goreve
    devredilirse (`start_soon`) sunlar sirayla olur: `bitir()` hatayi uretir,
    stdin biter, `server.run` doner, stdout yazicisi kapanir — ve devredilen
    gonderim o ana yetisemez. Sonuc: akisin SON satirinda ihlal geri gelir,
    uzerine hicbir test kirmizi olmaz. Burada `hata_yaz` bilerek birden cok kez
    kontrolu birakir; ureteç yine de tamamlanmadan once onu bitirmis olmalidir.
    """
    yazilanlar: list[dict] = []
    bitis_anindaki_sayi: list[int] = []

    async def kaynak():
        yield '{"id":9,"method":"x"'  # sonda \n YOK -> hata `bitir()`de dogar

    async def hata_yaz(govde):
        for _ in range(3):
            await anyio.sleep(0)  # devredilmis olsaydi burada geri kalirdi
        yazilanlar.append(govde)

    async def main():
        async for _ in korumali_satirlar(kaynak(), hata_yaz):
            pass
        bitis_anindaki_sayi.append(len(yazilanlar))

    anyio.run(main)
    assert bitis_anindaki_sayi == [1], "ureteç, hata yazilmadan BITMEMELI"
    assert yazilanlar[0]["id"] == 9
