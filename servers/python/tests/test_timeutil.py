"""timeutil.py — saat dilimi ve ISO8601 yardimcilari.

★ BU DOSYANIN VARLIK SEBEBI, BU REPODA YASANMIS BIR HATADIR.

Yerel saat 00:00-03:00 arasindayken UTC tarihi BIR GUN GERIDEDIR. UTC'den
turetilen bir "dun", sunucunun gozunde T-2 olur ve XURRENT_MAX_BACKDATE_DAYS=1
yuzunden HAKLI OLARAK reddedilir. Sonuc: her gece uc saat kirmiziya donen,
gunduz yesil olan bir test suiti — ve saatlerce "sunucu bozuk" sanilmasi.
(bkz. commit "Fix timezone-dependent flake in the fake-Xurrent scenario runner")

Bu yuzden buradaki testlerin hicbiri gercek saati OKUMAZ; hepsi acikca verilen
bir referans tarihe gore kurulur.
"""

from __future__ import annotations

from datetime import date, timedelta
from zoneinfo import ZoneInfo

import pytest

from xurrent_mcp.timeutil import (
    iso,
    iso_date,
    local_datetime,
    materialize,
    minutes_between,
    parse_graph_datetime,
    parse_iso,
    tz_offset_string,
    zone,
)

UTC = ZoneInfo("UTC")
ISTANBUL = "Europe/Istanbul"
BERLIN = "Europe/Berlin"


# ── ★ gece yarisi ile 03:00 arasi: UTC tarihi bir gun geride ────────────────


def test_yerel_gece_yarisi_ile_uc_arasinda_UTC_TARIHI_BIR_GUN_GERIDEDIR():
    """Hatanin cekirdegi. Ayni AN'in iki farkli takvim gunu vardir."""
    an = materialize(0, "01:00", ISTANBUL, base=date(2026, 8, 3))

    assert an.date() == date(2026, 8, 3)  # yerel gun
    assert an.astimezone(UTC).date() == date(2026, 8, 2)  # UTC gunu — BIR GERI


def test_UTC_den_turetilen_dun_gece_yarisindan_sonra_IKI_gun_geriye_kayar():
    """Testi gecenin uc saatinde kirmizi yapan tam olarak bu hesaptir.

    Sunucu bugunu XURRENT_TIMEZONE'da hesaplar; olcen taraf UTC'den turetirse
    istenen T-1, sunucunun gozunde T-2 olur ve max_backdate_days=1 ile reddedilir.
    """
    an = materialize(0, "01:00", ISTANBUL, base=date(2026, 8, 3))

    dogru_dun = an.date() - timedelta(days=1)
    utc_den_turetilen_dun = an.astimezone(UTC).date() - timedelta(days=1)

    assert iso_date(dogru_dun) == "2026-08-02"
    assert iso_date(utc_den_turetilen_dun) == "2026-08-01"
    assert (dogru_dun - utc_den_turetilen_dun).days == 1  # tam bir gunluk kayma


def test_ogleden_sonraki_bir_anda_yerel_ve_UTC_gunleri_AYNIDIR():
    """Hata gun boyunca gorunmez; yalnizca gecenin ilk saatlerinde ortaya cikar —
    bu yuzden 'bende calisiyor' der ve CI'da gecerdi."""
    an = materialize(0, "14:00", ISTANBUL, base=date(2026, 8, 3))
    assert an.date() == an.astimezone(UTC).date()


# ── goreli tarih materyalizasyonu ───────────────────────────────────────────


@pytest.mark.parametrize(
    ("gun_farki", "beklenen"),
    [
        (0, "2026-08-03T09:00:00+03:00"),
        (-1, "2026-08-02T09:00:00+03:00"),
        (-3, "2026-07-31T09:00:00+03:00"),
    ],
)
def test_materialize_dayOffset_i_yerel_saatle_birlestirir(gun_farki, beklenen):
    """fixtures sozlesmesi: instant = zonedDateTime(today + dayOffset, startLocal, tz)."""
    an = materialize(gun_farki, "09:00", ISTANBUL, base=date(2026, 8, 3))
    assert an.isoformat() == beklenen


def test_materialize_ay_sinirini_dogru_asar():
    an = materialize(-1, "09:00", ISTANBUL, base=date(2026, 3, 1))
    assert an.isoformat() == "2026-02-28T09:00:00+03:00"


def test_local_datetime_saat_dilimini_GOMER():
    """Ciplak (offsetsiz) bir instant sessizce yanlis gunu getirir."""
    an = local_datetime(date(2026, 8, 3), "00:00", ISTANBUL)

    assert an.tzinfo is not None
    assert an.utcoffset() == timedelta(hours=3)


def test_local_datetime_dakikasiz_saati_kabul_eder():
    assert local_datetime(date(2026, 8, 3), "9", ISTANBUL).hour == 9


# ── DST: offset gune baglidir ───────────────────────────────────────────────


def test_tz_offset_string_ayni_bolgede_yaz_ve_kis_FARKLI_doner():
    """Sabit '+03:00' yazmak yaz saati uygulayan bolgelerde YANLIS instant uretir."""
    assert tz_offset_string(date(2026, 7, 1), BERLIN) == "+02:00"
    assert tz_offset_string(date(2026, 1, 15), BERLIN) == "+01:00"


def test_istanbul_2016_dan_beri_DST_uygulamaz():
    """Varsayilan saat diliminin DST'siz olmasi, DST hatalarini GIZLER —
    bu testin varlik sebebi o gizlemeyi belgelemektir."""
    assert tz_offset_string(date(2026, 1, 15), ISTANBUL) == "+03:00"
    assert tz_offset_string(date(2026, 7, 1), ISTANBUL) == "+03:00"


def test_dst_gecis_gunundeki_yerel_saat_dogru_offseti_alir():
    """29 Mart 2026: Avrupa'da yaz saatine gecis. 00:00 hala +01:00, 04:00 artik +02:00."""
    dst_gunu = date(2026, 3, 29)

    assert local_datetime(dst_gunu, "00:00", BERLIN).utcoffset() == timedelta(hours=1)
    assert local_datetime(dst_gunu, "04:00", BERLIN).utcoffset() == timedelta(hours=2)


# ── ISO8601 uretimi ve okunmasi ─────────────────────────────────────────────


def test_iso_her_zaman_offset_tasir():
    metin = iso(local_datetime(date(2026, 8, 3), "14:00", ISTANBUL))

    assert metin == "2026-08-03T14:00:00+03:00"
    assert metin[-6] in "+-"


def test_iso_saniye_hassasiyetinde_yazar():
    """Mikrosaniye tasimak ciktilari deterministik olmaktan cikarir."""
    an = local_datetime(date(2026, 8, 3), "14:00", ISTANBUL).replace(microsecond=123456)
    assert iso(an) == "2026-08-03T14:00:00+03:00"


def test_iso_date_yyyy_aa_gg_uretir():
    assert iso_date(date(2026, 8, 3)) == "2026-08-03"


@pytest.mark.parametrize(
    ("metin", "beklenen_utc_saat"),
    [
        ("2026-08-03T14:00:00+03:00", 11),
        ("2026-08-03T11:00:00Z", 11),
        ("2026-08-03T06:00:00-05:00", 11),
    ],
)
def test_parse_iso_offsetli_ve_Z_sonekli_degerleri_ayni_ana_cozer(metin, beklenen_utc_saat):
    assert parse_iso(metin).astimezone(UTC).hour == beklenen_utc_saat


def test_parse_iso_bastaki_ve_sondaki_bosluklari_yok_sayar():
    assert parse_iso("  2026-08-03T14:00:00+03:00 \n").hour == 14


# ── Graph dateTime tuzagi ───────────────────────────────────────────────────


def test_parse_graph_datetime_offsetsiz_yedi_kesirli_haneyi_UTC_kabul_eder():
    """★ Graph'in dateTime alani OFFSET TASIMAZ ve 7 kesirli hane icerir.

    Dogrudan datetime.fromisoformat'a vermek sunucunun local time'i sanilmasina
    ve yanlis instant'a yol acar. Prefer: outlook.timezone GONDERMEDIGIMIZ icin
    Graph UTC doner.
    """
    an = parse_graph_datetime("2026-08-03T09:00:00.0000000")

    assert an.astimezone(UTC).isoformat() == "2026-08-03T09:00:00+00:00"


def test_parse_graph_datetime_verilen_saat_dilimine_cevirir():
    an = parse_graph_datetime("2026-08-03T09:00:00.0000000", ISTANBUL)
    assert an.isoformat() == "2026-08-03T12:00:00+03:00"


def test_parse_graph_datetime_offsetli_degeri_OLDUGU_GIBI_birakir():
    an = parse_graph_datetime("2026-08-03T09:00:00+03:00")
    assert an.isoformat() == "2026-08-03T09:00:00+03:00"


def test_parse_graph_datetime_Z_sonekli_degeri_UTC_okur():
    an = parse_graph_datetime("2026-08-03T09:00:00Z")
    assert an.utcoffset() == timedelta(0)


def test_parse_graph_datetime_kesirli_hane_yoksa_da_calisir():
    an = parse_graph_datetime("2026-08-03T09:00:00")
    assert an.astimezone(UTC).isoformat() == "2026-08-03T09:00:00+00:00"


# ── sure hesabi ─────────────────────────────────────────────────────────────


def test_minutes_between_dakika_doner():
    bas = local_datetime(date(2026, 8, 3), "09:00", ISTANBUL)
    bit = local_datetime(date(2026, 8, 3), "10:30", ISTANBUL)

    assert minutes_between(bas, bit) == 90


def test_minutes_between_ters_araligi_SIFIRA_kirpar():
    """Negatif sure raporlamak yerine 0 doner; kaynak veri bozuksa da cikti anlamli kalir."""
    bas = local_datetime(date(2026, 8, 3), "10:00", ISTANBUL)
    bit = local_datetime(date(2026, 8, 3), "09:00", ISTANBUL)

    assert minutes_between(bas, bit) == 0


def test_minutes_between_saniyeleri_asagi_yuvarlar():
    bas = local_datetime(date(2026, 8, 3), "09:00", ISTANBUL)
    bit = bas + timedelta(minutes=59, seconds=59)

    assert minutes_between(bas, bit) == 59


# ── zone() ──────────────────────────────────────────────────────────────────


def test_zone_gecerli_IANA_adini_cozer():
    assert zone(ISTANBUL).key == ISTANBUL


def test_zone_gecersiz_ada_karsi_UTC_ye_duser():
    """Sessizce YANLIS GUN getirmektense UTC'ye dusmek yeglenir.

    ('eu' bolgesi tuzaginin saat dilimi karsiligi: var olmayan bir ad
    programi durdurmamali ama sonucu da uydurmamalidir.)
    """
    assert zone("Mars/Olympus").key == "UTC"
    assert zone("").key == "UTC"
