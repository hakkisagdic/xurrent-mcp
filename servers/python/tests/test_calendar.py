"""calendar/ — normalizasyon, atlama kurallari, dedup, clip ve toplamlar.

Ham veriyi cekmek kolaydir; ANLAMLI veriye cevirmek asil istir. "Her bir
toplantiyi zaman girisine cevir" cumlesi masumca durur: takvimde dogum gunu
var, ogle arasi var, reddedilen bir retro var, iki toplanti cakisiyor ve biri
45 dakika olup hesap 30'un katlarini kabul ediyor.

Ag YOKTUR: Google ve Graph saglayicilarinin yalnizca ALAN ESLEME fonksiyonlari
cagrilir (saf donusum), HTTP yapan fetch() degil.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import pytest
from conftest import TZ

from xurrent_mcp.calendar import read_day
from xurrent_mcp.calendar.google import GoogleCalendarProvider
from xurrent_mcp.calendar.graph import GraphCalendarProvider
from xurrent_mcp.calendar.types import FetchOptions, RawEvent, build_window, normalize
from xurrent_mcp.timeutil import local_datetime, merge_intervals, round_to_increment

GUN = date(2026, 8, 3)


def _pencere(gun: date = GUN, tz: str = TZ) -> FetchOptions:
    baslangic, bitis = build_window(gun, tz)
    return FetchOptions(day=gun, time_zone=tz, window_start=baslangic, window_end=bitis)


def _etkinlik(**kw) -> RawEvent:
    varsayilan: dict = {
        "id": "evt-1",
        "ical_uid": "uid-1@ornek.com",
        "title": "Toplantı",
        "start": local_datetime(GUN, "10:00", TZ),
        "end": local_datetime(GUN, "11:00", TZ),
    }
    varsayilan.update(kw)
    return RawEvent(**varsayilan)


def _normalize(etkinlikler, **kw):
    return normalize(etkinlikler, _pencere(), "mock", **kw)


# ── pencere: offset GOMULU olmali ───────────────────────────────────────────


def test_pencere_yerel_gece_yarisindan_yerel_gece_yarisina_kurulur():
    """Ciplak timestamp gondermek sessizce YANLIS GUNU getirir."""
    baslangic, bitis = build_window(GUN, TZ)

    assert baslangic.isoformat() == "2026-08-03T00:00:00+03:00"
    assert bitis.isoformat() == "2026-08-04T00:00:00+03:00"


# ── atlama kurallari: her biri farkli bir ders ──────────────────────────────


@pytest.mark.parametrize(
    ("alan", "beklenen_gerekce_parcasi"),
    [
        ("is_cancelled", "Iptal edilmis"),
        ("is_all_day", "Tum gun"),
        ("declined", "Reddedilen"),
        ("free", "Mesgul olmayan"),
    ],
)
def test_elenen_etkinlik_skipped_ve_TURKCE_gerekce_tasir(alan, beklenen_gerekce_parcasi):
    gun = _normalize([_etkinlik(**{alan: True})])
    toplanti = gun.meetings[0]

    assert toplanti.skipped is True
    assert beklenen_gerekce_parcasi in toplanti.skipReason


def test_elenen_etkinlik_listeden_SILINMEZ_sadece_isaretlenir():
    """Kullanici 'takvimimde 8 sey vardi, neden 5?' diye sorabilmeli."""
    gun = _normalize([_etkinlik(free=True), _etkinlik(id="evt-2", ical_uid="uid-2")])

    assert len(gun.meetings) == 2
    assert gun.totals.rawCount == 2
    assert gun.totals.count == 1
    assert gun.totals.filteredOut == 1


@pytest.mark.parametrize(
    ("alan", "bayrak"),
    [
        ("is_all_day", "include_all_day"),
        ("declined", "include_declined"),
        ("free", "include_free"),
    ],
)
def test_include_bayragi_ilgili_atlama_kuralini_kapatir(alan, bayrak):
    gun = _normalize([_etkinlik(**{alan: True})], **{bayrak: True})
    assert gun.meetings[0].skipped is False


def test_iptal_edilmis_etkinlik_HICBIR_bayrakla_geri_getirilemez():
    """Iptal edilmis toplanti takvimde durur ama CALISILMAMISTIR."""
    gun = _normalize(
        [_etkinlik(is_cancelled=True)],
        include_all_day=True,
        include_declined=True,
        include_free=True,
    )
    assert gun.meetings[0].skipped is True


def test_iptal_kurali_diger_bayraklardan_ONCE_bakilir():
    """Hem iptal hem reddedilmis bir etkinligin gerekcesi belirsiz kalmamali."""
    gun = _normalize([_etkinlik(is_cancelled=True, declined=True, free=True)])
    assert "Iptal edilmis" in gun.meetings[0].skipReason


def test_tum_gun_etkinliginin_suresi_instantlardan_HESAPLANMAZ():
    """Her iki API de exclusive end date kullanir; sure raporlamak yaniltici olur."""
    gun = _normalize(
        [
            _etkinlik(
                is_all_day=True,
                start=local_datetime(GUN, "00:00", TZ),
                end=local_datetime(GUN + timedelta(days=1), "00:00", TZ),
            )
        ],
        include_all_day=True,
    )
    assert gun.meetings[0].minutes == 0


# ── clip: filtre bir OVERLAP filtresidir ────────────────────────────────────


def test_gece_yarisini_asan_toplanti_pencerenin_basina_CLIP_edilir():
    """Dun 23:00'te baslayip bugun 01:00'de biten toplanti da doner."""
    gun = _normalize(
        [
            _etkinlik(
                start=local_datetime(GUN - timedelta(days=1), "23:00", TZ),
                end=local_datetime(GUN, "01:00", TZ),
            )
        ]
    )
    toplanti = gun.meetings[0]

    assert toplanti.start == "2026-08-03T00:00:00+03:00"
    assert toplanti.minutes == 60  # 120 degil: yalnizca bu gune duseni sayilir


def test_gece_yarisini_asan_toplanti_pencerenin_sonuna_CLIP_edilir():
    gun = _normalize(
        [
            _etkinlik(
                start=local_datetime(GUN, "23:00", TZ),
                end=local_datetime(GUN + timedelta(days=1), "01:00", TZ),
            )
        ]
    )
    toplanti = gun.meetings[0]

    assert toplanti.end == "2026-08-04T00:00:00+03:00"
    assert toplanti.minutes == 60


# ── dedup: iCalUID TEK BASINA yetmez ────────────────────────────────────────


def test_ayni_uid_ve_ayni_baslangic_TEK_kayit_sayilir():
    """Graph'te ayni occurrence iki farkli sayfada gelebilir."""
    gun = _normalize([_etkinlik(id="a"), _etkinlik(id="b")])

    assert gun.totals.rawCount == 1
    assert gun.totals.count == 1


def test_ayni_uid_farkli_baslangic_AYRI_kayit_sayilir():
    """★ Google'da iCalUID SERI BOYUNCA AYNIDIR.

    Anahtar yalnizca uid olsaydi, ayni serinin gun icindeki ikinci occurrence'i
    yutulurdu — sessiz veri kaybi. Anahtara start instant'i bu yuzden dahildir.
    """
    gun = _normalize(
        [
            _etkinlik(id="a"),
            _etkinlik(
                id="b",
                start=local_datetime(GUN, "14:00", TZ),
                end=local_datetime(GUN, "15:00", TZ),
            ),
        ]
    )

    assert gun.totals.rawCount == 2
    assert gun.totals.count == 2
    assert gun.totals.busyMinutes == 120


def test_dedup_anahtari_uid_ve_baslangictan_olusur():
    gun = _normalize([_etkinlik()])
    assert gun.meetings[0].uid == "uid-1@ornek.com|2026-08-03T10:00:00+03:00"


# ── busyMinutes: cakismalar BIR KEZ ─────────────────────────────────────────


def test_cakisan_iki_toplanti_busyMinutes_te_BIR_KEZ_sayilir():
    gun = _normalize(
        [
            _etkinlik(id="a", ical_uid="uid-a"),  # 10:00-11:00
            _etkinlik(
                id="b",
                ical_uid="uid-b",
                start=local_datetime(GUN, "10:30", TZ),
                end=local_datetime(GUN, "11:30", TZ),
            ),
        ]
    )

    assert gun.totals.busyMinutes == 90  # 10:00-11:30
    assert gun.totals.naiveSumMinutes == 120  # naif toplam cakismayi iki kez sayar


def test_naif_toplam_ve_busyMinutes_IKISI_DE_raporlanir():
    """Farki gormek dersin bir parcasidir; birini gizlemek soruyu yok eder."""
    gun = _normalize([_etkinlik()])
    assert gun.totals.busyMinutes == gun.totals.naiveSumMinutes == 60


def test_elenen_toplantilar_busyMinutes_e_KATILMAZ():
    gun = _normalize(
        [
            _etkinlik(id="a", ical_uid="uid-a"),
            _etkinlik(
                id="b",
                ical_uid="uid-b",
                free=True,
                start=local_datetime(GUN, "12:00", TZ),
                end=local_datetime(GUN, "13:00", TZ),
            ),
        ]
    )
    assert gun.totals.busyMinutes == 60


# ── merge_intervals: busyMinutes'in motoru ──────────────────────────────────


def _aralik(bas: str, bit: str) -> tuple[datetime, datetime]:
    return local_datetime(GUN, bas, TZ), local_datetime(GUN, bit, TZ)


def test_merge_intervals_bos_listede_sifir_doner():
    assert merge_intervals([]) == 0


def test_merge_intervals_ayrik_araliklari_toplar():
    assert merge_intervals([_aralik("09:00", "10:00"), _aralik("11:00", "12:00")]) == 120


def test_merge_intervals_ucuca_ekli_araliklari_birlestirir():
    assert merge_intervals([_aralik("09:00", "10:00"), _aralik("10:00", "11:00")]) == 120


def test_merge_intervals_tamamen_icerilen_araligi_iki_kez_saymaz():
    assert merge_intervals([_aralik("09:00", "12:00"), _aralik("10:00", "11:00")]) == 180


def test_merge_intervals_siralanmamis_girdiyi_de_dogru_hesaplar():
    assert merge_intervals([_aralik("11:00", "12:00"), _aralik("09:00", "10:30")]) == 150


# ★ BULGU VE DUZELTMESI (tarihce — silmeyin):
# Bu test yazildiginda KIRMIZIYDI. minutes_between() Python'un "ayni tzinfo
# NESNESI tasiniyorsa cikarma DUVAR SAATI uzerinden yapilir" kuralina takiliyordu;
# zone() ZoneInfo'yu onbellekten dondurdugu icin ayni bolgedeki her instant ayni
# nesneyi tasir, yani tuzak her zaman kuruluydu. Berlin 2026-03-29 01:00->04:00
# gercekte 120 dakika, kod 180 donuyordu. TypeScript mutlak instant farki aldigi
# icin 120 veriyordu; yani busyMinutes yilda IKI GUN diller arasinda ayrisiyordu.
# Varsayilan Europe/Istanbul 2016'dan beri DST uygulamadigi icin uretimde
# gorunmemisti. Duzeltme: timeutil.minutes_between iki tarafi UTC'ye cevirip cikarir.
def test_dst_gecisini_asan_aralik_GERCEK_gecen_sureyi_verir():
    """Ilkbaharda saat ileri alinan gun 23 saattir; 01:00-04:00 arasi 2 saattir."""
    dst_gunu = date(2026, 3, 29)  # Avrupa'da yaz saatine gecis
    bas = local_datetime(dst_gunu, "01:00", "Europe/Berlin")
    bit = local_datetime(dst_gunu, "04:00", "Europe/Berlin")

    assert merge_intervals([(bas, bit)]) == 120


# ── yuvarlama: timeIncrement katina ─────────────────────────────────────────


@pytest.mark.parametrize(
    ("mod", "beklenen"),
    [("nearest", 60), ("up", 60), ("down", 30)],
)
def test_kirk_bes_dakika_otuzun_katina_moda_gore_yuvarlanir(mod, beklenen):
    """nearest BERABERLIKTE YUKARI yuvarlar.

    Calisilan zamani eksik raporlamak fazla raporlamaktan daha zararlidir:
    kullanici fazlayi fark eder, eksigi fark etmez.
    """
    assert round_to_increment(45, 30, mod) == beklenen


@pytest.mark.parametrize("mod", ["nearest", "up", "down"])
def test_tam_kat_olan_sure_hicbir_modda_degismez(mod):
    assert round_to_increment(90, 30, mod) == 90


@pytest.mark.parametrize("mod", ["nearest", "up", "down"])
def test_incrementten_kucuk_sure_incremente_YUKSELTILIR(mod):
    """timeIncrement hem MINIMUM hem ADIM'dir: 0 dakika yazilamaz."""
    assert round_to_increment(7, 30, mod) == 30


def test_yuvarlama_yariyi_yukari_alir_bankers_rounding_kullanmaz():
    """75/30 = 2.5 -> 3 adim = 90. Python'un round()'u 2 verirdi (60)."""
    assert round_to_increment(75, 30, "nearest") == 90


def test_gecersiz_increment_degeri_sureyi_degistirmez():
    assert round_to_increment(45, 0) == 45


# ── Google alan eslemesi (saf donusum, ag yok) ──────────────────────────────


def _google(yapilandirma, ogen: dict) -> RawEvent:
    return GoogleCalendarProvider(yapilandirma())._to_raw_event(ogen, TZ)


def test_google_transparency_alani_YOKSA_opaque_varsayilir(yapilandirma):
    """★ TUZAK: transparency varsayilani 'opaque' iken cevapta HIC CIKMAZ.

    `item.get("transparency") == "transparent"` yazan bir kod dogru calisir ama
    `item["transparency"]` beklemek KeyError verir; asil tuzak tersidir —
    alanin yoklugunu 'mesgul degil' saymak butun gunu eler.
    """
    olay = _google(
        yapilandirma,
        {
            "id": "g1",
            "summary": "Toplantı",
            "start": {"dateTime": "2026-08-03T10:00:00+03:00"},
            "end": {"dateTime": "2026-08-03T11:00:00+03:00"},
        },
    )
    assert olay.free is False


def test_google_transparency_transparent_ise_mesgul_degildir(yapilandirma):
    olay = _google(
        yapilandirma,
        {
            "id": "g1",
            "summary": "Öğle arası",
            "transparency": "transparent",
            "start": {"dateTime": "2026-08-03T12:30:00+03:00"},
            "end": {"dateTime": "2026-08-03T13:30:00+03:00"},
        },
    )
    assert olay.free is True


def test_google_kendi_katilim_durumu_declined_ise_reddedilmis_sayilir(yapilandirma):
    """Reddedilen toplanti sunucu tarafinda FILTRELENMEZ; elemek client'in isidir."""
    olay = _google(
        yapilandirma,
        {
            "id": "g1",
            "summary": "Ekip retro",
            "start": {"dateTime": "2026-08-03T16:30:00+03:00"},
            "end": {"dateTime": "2026-08-03T17:00:00+03:00"},
            "attendees": [
                {"email": "baskasi@ornek.com", "responseStatus": "declined"},
                {"email": "ben@ornek.com", "self": True, "responseStatus": "accepted"},
            ],
        },
    )
    # BASKASININ reddi bizi ilgilendirmez: yalnizca self=true olan bakilir.
    assert olay.declined is False


def test_google_all_day_etkinligi_tarih_alanindan_tanir(yapilandirma):
    olay = _google(
        yapilandirma,
        {
            "id": "g1",
            "summary": "Doğum günü",
            "start": {"date": "2026-08-03"},
            "end": {"date": "2026-08-04"},
        },
    )

    assert olay.is_all_day is True
    assert olay.start.isoformat() == "2026-08-03T00:00:00+03:00"


def test_google_iCalUID_yoksa_id_e_duser(yapilandirma):
    olay = _google(
        yapilandirma,
        {
            "id": "g1",
            "summary": "Toplantı",
            "start": {"dateTime": "2026-08-03T10:00:00+03:00"},
            "end": {"dateTime": "2026-08-03T11:00:00+03:00"},
        },
    )
    assert olay.ical_uid == "g1"


# ── Graph alan eslemesi (saf donusum, ag yok) ───────────────────────────────


def _graph(yapilandirma, ogen: dict) -> RawEvent:
    return GraphCalendarProvider(yapilandirma())._to_raw_event(ogen, TZ)


def test_graph_offsetsiz_yedi_kesirli_haneli_dateTime_i_dogru_ana_cevirir(yapilandirma):
    """★ Graph'in dateTime alani OFFSET TASIMAZ ve 7 kesirli hane icerir.

    Dogrudan parse edilirse sunucunun local time'i sanilir -> yanlis instant.
    Prefer: outlook.timezone GONDERMEDIGIMIZ icin deger UTC'dir.
    """
    olay = _graph(
        yapilandirma,
        {
            "id": "m1",
            "iCalUId": "uid-m1",
            "subject": "Toplantı",
            "start": {"dateTime": "2026-08-03T09:00:00.0000000", "timeZone": "UTC"},
            "end": {"dateTime": "2026-08-03T10:00:00.0000000", "timeZone": "UTC"},
        },
    )

    assert olay.start.isoformat() == "2026-08-03T09:00:00+00:00"
    assert (olay.end - olay.start).total_seconds() == 3600


def test_graph_showAs_free_mesgul_degildir(yapilandirma):
    olay = _graph(
        yapilandirma,
        {
            "id": "m1",
            "subject": "Öğle arası",
            "showAs": "free",
            "start": {"dateTime": "2026-08-03T12:30:00.0000000"},
            "end": {"dateTime": "2026-08-03T13:30:00.0000000"},
        },
    )
    assert olay.free is True


@pytest.mark.parametrize("show_as", ["busy", "oof", "workingElsewhere", "tentative"])
def test_graph_free_disindaki_showAs_degerleri_MESGUL_sayilir(yapilandirma, show_as):
    """'oof' ve 'workingElsewhere' calisilmadigi anlamina GELMEZ."""
    olay = _graph(
        yapilandirma,
        {
            "id": "m1",
            "subject": "Toplantı",
            "showAs": show_as,
            "start": {"dateTime": "2026-08-03T10:00:00.0000000"},
            "end": {"dateTime": "2026-08-03T11:00:00.0000000"},
        },
    )
    assert olay.free is False


def test_graph_responseStatus_declined_ise_reddedilmis_sayilir(yapilandirma):
    olay = _graph(
        yapilandirma,
        {
            "id": "m1",
            "subject": "Ekip retro",
            "responseStatus": {"response": "declined"},
            "start": {"dateTime": "2026-08-03T16:30:00.0000000"},
            "end": {"dateTime": "2026-08-03T17:00:00.0000000"},
        },
    )
    assert olay.declined is True


def test_graph_all_day_etkinliginin_bitisi_baslangica_esitse_bir_gune_tamamlanir(yapilandirma):
    olay = _graph(
        yapilandirma,
        {
            "id": "m1",
            "subject": "Doğum günü",
            "isAllDay": True,
            "start": {"dateTime": "2026-08-03T00:00:00.0000000"},
            "end": {"dateTime": "2026-08-03T00:00:00.0000000"},
        },
    )
    assert (olay.end - olay.start) == timedelta(days=1)


# ── fixture uzerinden uctan uca normalizasyon (I/O yok, ag yok) ─────────────


def test_mock_fixture_bugun_icin_bes_gercek_toplanti_ve_iki_yuz_yirmi_bes_dakika_verir(
    yapilandirma,
):
    """fixtures/calendar.json'un _expectedTotals blogu ile BIREBIR ayni sayilar.

    255 (naif) vs 225 (dogru): fark tam 30 dakikadir cunku 10:00-11:00 ile
    10:30-11:30 cakisir. Uc dilin de ayni sayiyi uretmesi bu repodaki ana tezdir.
    """
    gun = read_day(yapilandirma(), provider="mock", day=GUN, time_zone=TZ)

    assert gun.provider == "mock"
    assert gun.totals.rawCount == 8
    assert gun.totals.count == 5
    assert gun.totals.filteredOut == 3
    assert gun.totals.naiveSumMinutes == 255
    assert gun.totals.busyMinutes == 225


def test_mock_fixture_dun_icin_iki_toplanti_ve_yuz_seksen_dakika_verir(yapilandirma):
    """T-1 penceresi: backdating senaryosunun malzemesi."""
    gun = read_day(
        yapilandirma(), provider="mock", day=GUN - timedelta(days=1), time_zone=TZ
    )

    assert gun.totals.rawCount == 2
    assert gun.totals.count == 2
    assert gun.totals.busyMinutes == 180


def test_mock_fixture_elenen_uc_etkinligin_gerekceleri_FARKLIDIR(yapilandirma):
    """Uc eleme kasitlidir ve her biri farkli bir kural ogretir."""
    gun = read_day(yapilandirma(), provider="mock", day=GUN, time_zone=TZ)

    gerekceler = {t.title: t.skipReason for t in gun.meetings if t.skipped}
    assert len(gerekceler) == 3
    assert len(set(gerekceler.values())) == 3


def test_mock_fixture_kirk_bes_dakikalik_toplantiyi_oldugu_gibi_doner(yapilandirma):
    """Yuvarlama takvim katmaninda YAPILMAZ; plan katmaninda yapilir ve uyarilir."""
    gun = read_day(yapilandirma(), provider="mock", day=GUN, time_zone=TZ)

    vpn = next(t for t in gun.meetings if t.title.startswith("VPN kopma"))
    assert vpn.minutes == 45
