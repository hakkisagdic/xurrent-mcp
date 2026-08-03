"""xurrent/validate.py — yazmadan ONCE calisan on kontrollerin birim testleri.

Bu kontrollerin varlik sebebi: Xurrent'ta dogrulama hatalari HTTP 200 ile,
top-level `errors` OLMADAN, `payload.errors` dolu ve `timeEntry: null` olarak
doner. `if res.ok: return "kaydedildi"` yazan her entegrasyon hic olusmamis
kayitlari "basarili" diye raporlar. On kontrol, dogrulanabilir kisitlari
sunucuya SORMADAN uygular.

Bir kural sessizce kaybolursa sihirbaz genelde yine gecer — o yuzden her kural
burada tek tek kilitlenir.
"""

from __future__ import annotations

import pytest
from conftest import SABIT_BUGUN, SABIT_DUN

from xurrent_mcp.timeutil import iso_date
from xurrent_mcp.xurrent.validate import (
    DESCRIPTION_MAX_LENGTH,
    TimeEntryRequest,
    deterministic_source_id,
    precheck,
)

BEN = "TW9jay9QZXJzb24vMQ"
ALLOC_ID = "TW9jay9UaW1lQWxsb2NhdGlvbi8x"


def _istek(**kw) -> TimeEntryRequest:
    varsayilan: dict = {
        "targetType": "request",
        "targetId": "TW9jay9SZXF1ZXN0LzcwMjQ4",
        "minutes": 60,
    }
    varsayilan.update(kw)
    return TimeEntryRequest(**varsayilan)


def _kontrol(yapilandirma, zaman_baglami, *, ctx=None, cfg=None, **kw):
    ekstra = {
        anahtar: kw.pop(anahtar)
        for anahtar in ("minutes_already_logged", "allocation_description_required")
        if anahtar in kw
    }
    return precheck(
        _istek(**kw),
        ctx or zaman_baglami(),
        cfg or yapilandirma(),
        authenticated_person_id=BEN,
        **ekstra,
    )


def _yollar(sonuc) -> list[list[str] | None]:
    return [hata.path for hata in sonuc.errors]


# ── timeIncrement: hem MINIMUM hem ADIM ─────────────────────────────────────


@pytest.mark.parametrize("dakika", [45, 7, 90 + 1, 29])
def test_timeIncrement_kati_olmayan_sure_REDDEDILIR(yapilandirma, zaman_baglami, dakika):
    """Entegrasyonlardaki en yaygin SESSIZ hata budur.

    Sunucu HTTP 200 doner, payload.errors dolu gelir, bot 'kaydettim' der ve
    kullanici bunu ayin sonunda timesheet'i imzalarken fark eder.
    """
    sonuc = _kontrol(yapilandirma, zaman_baglami, minutes=dakika)

    assert not sonuc.ok
    assert ["minutes"] in _yollar(sonuc)


def test_timeIncrement_hatasi_izinli_en_yakin_iki_degeri_soyler(yapilandirma, zaman_baglami):
    """Hata mesaji ne yapilacagini soylemezse kullanici tahmine zorlanir."""
    sonuc = _kontrol(yapilandirma, zaman_baglami, minutes=45)

    mesaj = sonuc.errors[0].message
    assert "30" in mesaj and "60" in mesaj


@pytest.mark.parametrize("dakika", [30, 60, 90, 120])
def test_timeIncrement_kati_olan_sure_GECER(yapilandirma, zaman_baglami, dakika):
    assert _kontrol(yapilandirma, zaman_baglami, minutes=dakika).ok


def test_varsayilan_altmis_dakikalik_hesapta_yarim_saat_yazilamaz(yapilandirma, zaman_baglami):
    """Xurrent varsayilani 60'tir: 'yarim saat calistim' cumlesi YAZILAMAZ."""
    sonuc = _kontrol(
        yapilandirma, zaman_baglami, ctx=zaman_baglami(timeIncrement=60), minutes=30
    )
    assert not sonuc.ok


def test_izinli_olmayan_timeIncrement_hata_degil_UYARI_uretir(yapilandirma, zaman_baglami):
    """Hesabin ayari bizim isimiz degil; sunucu reddedebilir, biz haber veririz."""
    sonuc = _kontrol(
        yapilandirma, zaman_baglami, ctx=zaman_baglami(timeIncrement=7), minutes=7
    )
    assert sonuc.ok
    assert any("izinli degerler" in u for u in sonuc.warnings)


# ── sure isareti ────────────────────────────────────────────────────────────


def test_sifir_dakika_REDDEDILIR(yapilandirma, zaman_baglami):
    sonuc = _kontrol(yapilandirma, zaman_baglami, minutes=0)
    assert not sonuc.ok
    assert "0 olamaz" in sonuc.errors[0].message


def test_negatif_sure_correction_olmadan_REDDEDILIR(yapilandirma, zaman_baglami):
    """Xurrent'ta duzeltme mekanizmasi negatif timeSpent'tir ve correction=true ister."""
    sonuc = _kontrol(yapilandirma, zaman_baglami, minutes=-30)

    assert not sonuc.ok
    assert any("correction" in hata.message for hata in sonuc.errors)


def test_negatif_sure_correction_ile_GECER(yapilandirma, zaman_baglami):
    assert _kontrol(yapilandirma, zaman_baglami, minutes=-30, correction=True).ok


def test_negatif_sure_de_timeIncrement_katina_uymak_ZORUNDA(yapilandirma, zaman_baglami):
    """Mutlak deger uzerinden bakilir; duzeltme kaydi kurali atlamaz."""
    sonuc = _kontrol(yapilandirma, zaman_baglami, minutes=-45, correction=True)
    assert not sonuc.ok


# ── tarih penceresi ─────────────────────────────────────────────────────────


def test_bugun_GECER(yapilandirma, zaman_baglami):
    assert _kontrol(yapilandirma, zaman_baglami, date=iso_date(SABIT_BUGUN)).ok


def test_dun_max_backdate_bir_gunken_GECER(yapilandirma, zaman_baglami):
    assert _kontrol(yapilandirma, zaman_baglami, date=iso_date(SABIT_DUN)).ok


def test_iki_gun_once_max_backdate_bir_gunken_REDDEDILIR(yapilandirma, zaman_baglami):
    """Erken reddetme ilkesi: dogrulanabilir bir kisiti sunucuya SORMA, kendin uygula.

    'Bu hesapta en fazla 1 gun geriye yazilabilir' cevabi, bir GraphQL hata
    mesajindan cok daha faydalidir.
    """
    sonuc = _kontrol(yapilandirma, zaman_baglami, date="2026-08-01")

    assert not sonuc.ok
    assert ["date"] in _yollar(sonuc)
    assert "2026-08-02" in sonuc.errors[0].message  # en eski girilebilir tarih


def test_max_backdate_gunu_arttirilinca_eski_tarih_GECER(yapilandirma, zaman_baglami):
    sonuc = _kontrol(
        yapilandirma, zaman_baglami, cfg=yapilandirma(max_backdate_days=7), date="2026-08-01"
    )
    assert sonuc.ok


def test_max_backdate_sifirken_dun_bile_REDDEDILIR(yapilandirma, zaman_baglami):
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        cfg=yapilandirma(max_backdate_days=0),
        date=iso_date(SABIT_DUN),
    )
    assert not sonuc.ok


def test_gelecek_tarih_REDDEDILIR(yapilandirma, zaman_baglami):
    sonuc = _kontrol(yapilandirma, zaman_baglami, date="2026-08-04")
    assert not sonuc.ok
    assert "Gelecek" in sonuc.errors[0].message


@pytest.mark.parametrize("bozuk", ["03.08.2026", "2026/08/03", "3 Ağustos 2026", "20260803"])
def test_yyyy_aa_gg_disindaki_tarih_bicimi_REDDEDILIR(yapilandirma, zaman_baglami, bozuk):
    sonuc = _kontrol(yapilandirma, zaman_baglami, date=bozuk)
    assert not sonuc.ok
    assert ["date"] in _yollar(sonuc)


# ── startedAt ───────────────────────────────────────────────────────────────


def test_offsetsiz_startedAt_REDDEDILIR(yapilandirma, zaman_baglami):
    """Ciplak timestamp sessizce yanlis gunu getirir — takvim entegrasyonlarinin
    en sik hatasi."""
    sonuc = _kontrol(yapilandirma, zaman_baglami, startedAt="2026-08-03T14:00:00")

    assert not sonuc.ok
    assert ["startedAt"] in _yollar(sonuc)


@pytest.mark.parametrize(
    "an", ["2026-08-03T14:00:00+03:00", "2026-08-03T11:00:00Z", "2026-08-03T06:00:00-05:00"]
)
def test_offsetli_startedAt_GECER(yapilandirma, zaman_baglami, an):
    assert _kontrol(yapilandirma, zaman_baglami, startedAt=an).ok


def test_startedAt_verilince_gunu_degistirmedigi_UYARILIR(yapilandirma, zaman_baglami):
    """Gunu belirleyen YALNIZCA date'tir; startedAt sadece metadata."""
    sonuc = _kontrol(yapilandirma, zaman_baglami, startedAt="2026-08-03T14:00:00+03:00")
    assert any("DEGISTIRMEZ" in u for u in sonuc.warnings)


# ── description / note ──────────────────────────────────────────────────────


def test_seksen_karakteri_asan_aciklama_REDDEDILIR(yapilandirma, zaman_baglami):
    sonuc = _kontrol(yapilandirma, zaman_baglami, description="x" * (DESCRIPTION_MAX_LENGTH + 1))

    assert not sonuc.ok
    assert ["description"] in _yollar(sonuc)
    assert "81" in sonuc.errors[0].message  # verilen uzunluk sayiyla soylenir


def test_tam_seksen_karakterlik_aciklama_GECER(yapilandirma, zaman_baglami):
    assert _kontrol(yapilandirma, zaman_baglami, description="x" * DESCRIPTION_MAX_LENGTH).ok


def test_hesap_aciklama_zorunlu_tutuyorsa_aciklamasiz_yazma_REDDEDILIR(
    yapilandirma, zaman_baglami
):
    sonuc = _kontrol(
        yapilandirma, zaman_baglami, ctx=zaman_baglami(requireTimeEntryDescription=True)
    )
    assert not sonuc.ok
    assert ["description"] in _yollar(sonuc)


def test_descriptionRequired_allocationda_aciklamasiz_yazma_REDDEDILIR(
    yapilandirma, zaman_baglami
):
    """fixtures/time-allocations.json'daki 'Egitim ve gelisim' tam olarak bunu ogretir."""
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        targetType="time_allocation",
        targetId="TW9jay9UaW1lQWxsb2NhdGlvbi8y",
        allocation_description_required=True,
    )

    assert not sonuc.ok
    assert any("descriptionRequired" in hata.message for hata in sonuc.errors)


def test_descriptionRequired_allocationda_aciklama_verilince_GECER(yapilandirma, zaman_baglami):
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        targetType="time_allocation",
        targetId="TW9jay9UaW1lQWxsb2NhdGlvbi8y",
        description="Egitim notu",
        allocation_description_required=True,
    )
    assert sonuc.ok


def test_hesap_not_zorunlu_tutuyorsa_ticket_hedefinde_notsuz_yazma_REDDEDILIR(
    yapilandirma, zaman_baglami
):
    sonuc = _kontrol(yapilandirma, zaman_baglami, ctx=zaman_baglami(requireNote=True))
    assert not sonuc.ok
    assert ["note"] in _yollar(sonuc)


def test_not_zorunlulugu_time_allocation_hedefinde_ARANMAZ(yapilandirma, zaman_baglami):
    """note yalnizca Yol B'de anlamlidir; TimeAllocation hedefinde yeri yoktur."""
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        ctx=zaman_baglami(requireNote=True),
        targetType="time_allocation",
        targetId=ALLOC_ID,
    )
    assert sonuc.ok


# ── iki yolun acik/kapali olmasi ────────────────────────────────────────────


def test_allocationTimeTracking_kapaliyken_yol_a_REDDEDILIR(yapilandirma, zaman_baglami):
    """allocationTimeTracking=false ⇒ date_first stratejisi CALISAMAZ."""
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        ctx=zaman_baglami(allocationTimeTracking=False),
        targetType="time_allocation",
        targetId=ALLOC_ID,
    )
    assert not sonuc.ok
    assert ["targetType"] in _yollar(sonuc)


def test_assignmentTimeTracking_kapaliyken_yol_b_REDDEDILIR(yapilandirma, zaman_baglami):
    """assignmentTimeTracking=false ⇒ link_first ve two_step CALISAMAZ."""
    sonuc = _kontrol(
        yapilandirma, zaman_baglami, ctx=zaman_baglami(assignmentTimeTracking=False)
    )
    assert not sonuc.ok
    assert any("two_step" in hata.message for hata in sonuc.errors)


# ── gunluk mesai tavani ─────────────────────────────────────────────────────


def test_fazla_mesai_kapaliyken_gunluk_tavani_asan_yazma_REDDEDILIR(yapilandirma, zaman_baglami):
    sonuc = _kontrol(
        yapilandirma, zaman_baglami, minutes=300, minutes_already_logged=240
    )

    assert not sonuc.ok
    mesaj = sonuc.errors[0].message
    assert "540" in mesaj and "480" in mesaj  # toplam ve tavan sayiyla soylenir


def test_gunluk_tavana_tam_oturan_yazma_GECER(yapilandirma, zaman_baglami):
    """480 = tavan; asilmadigi surece gecer (sinir dahil)."""
    assert _kontrol(
        yapilandirma, zaman_baglami, minutes=240, minutes_already_logged=240
    ).ok


def test_fazla_mesai_acikken_tavan_asilabilir(yapilandirma, zaman_baglami):
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        ctx=zaman_baglami(allowWorkdayOvertime=True),
        minutes=300,
        minutes_already_logged=240,
    )
    assert sonuc.ok


def test_duzeltme_kaydi_gunluk_tavan_kontrolunu_tetiklemez(yapilandirma, zaman_baglami):
    """Negatif sure toplami DUSURUR; tavana takilmasi anlamsiz olurdu."""
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        minutes=-60,
        correction=True,
        minutes_already_logged=480,
    )
    assert sonuc.ok


# ── baskasi adina yazma: UYARI, hata degil ──────────────────────────────────


def test_baskasi_adina_yazma_HATA_DEGIL_uyari_uretir(yapilandirma, zaman_baglami):
    """Yetki sunucunun isidir. Burada reddetmek mesru bir senaryoyu (manager,
    substitute, Account Administrator) imkansiz kilardi."""
    sonuc = _kontrol(yapilandirma, zaman_baglami, personId="TW9jay9QZXJzb24vOTk")

    assert sonuc.ok
    assert any("yetkisi gerekir" in u for u in sonuc.warnings)


@pytest.mark.parametrize("kisi", ["$me", BEN])
def test_kendi_adina_yazmada_yetki_uyarisi_uretilmez(yapilandirma, zaman_baglami, kisi):
    sonuc = _kontrol(yapilandirma, zaman_baglami, personId=kisi)
    assert not any("yetkisi gerekir" in u for u in sonuc.warnings)


# ── effort class ────────────────────────────────────────────────────────────


def test_aktif_listede_olmayan_effort_class_REDDEDILIR(yapilandirma, zaman_baglami):
    """EffortClassFilter'da 'disabled' filtresi YOKTUR; eleme client tarafindadir.
    Kullanim disi bir tarifeyi kabul etmek mali sonuc dogurur."""
    sonuc = _kontrol(yapilandirma, zaman_baglami, effortClassId="TW9jay9FZmZvcnRDbGFzcy85OQ")

    assert not sonuc.ok
    assert ["effortClassId"] in _yollar(sonuc)
    assert "costMultiplier" in sonuc.errors[0].message


def test_aktif_listedeki_effort_class_GECER(yapilandirma, zaman_baglami):
    assert _kontrol(yapilandirma, zaman_baglami, effortClassId="TW9jay9FZmZvcnRDbGFzcy8y").ok


# ── yalnizca Yol A'da anlamli alanlar ───────────────────────────────────────


def test_yol_a_ya_ozel_alanlar_ticket_hedefinde_YOK_SAYILDIGI_UYARILIR(
    yapilandirma, zaman_baglami
):
    sonuc = _kontrol(
        yapilandirma, zaman_baglami, customerId="C1", serviceId="S1", teamId="T1"
    )

    assert sonuc.ok
    uyari = next(u for u in sonuc.warnings if "YOK SAYILIR" in u)
    assert "customerId" in uyari and "serviceId" in uyari and "teamId" in uyari


def test_note_time_allocation_hedefinde_YOK_SAYILDIGI_UYARILIR(yapilandirma, zaman_baglami):
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        targetType="time_allocation",
        targetId=ALLOC_ID,
        note="serbest metin",
    )
    assert any("note yalnizca Yol B" in u for u in sonuc.warnings)


# ── birden fazla hata birikir ───────────────────────────────────────────────


def test_birden_fazla_kural_ihlali_TEK_seferde_raporlanir(yapilandirma, zaman_baglami):
    """Kullaniciyi hata hata gezdirmek yerine hepsi bir kerede verilir."""
    sonuc = _kontrol(
        yapilandirma,
        zaman_baglami,
        minutes=45,
        date="2026-08-01",
        description="x" * 100,
        startedAt="2026-08-01T09:00:00",
    )

    yollar = _yollar(sonuc)
    assert ["minutes"] in yollar
    assert ["date"] in yollar
    assert ["description"] in yollar
    assert ["startedAt"] in yollar


# ── idempotency anahtari ────────────────────────────────────────────────────


def test_ayni_istek_ayni_sourceId_uretir(yapilandirma):
    """Yarim kalan bir bulk tekrar kosuldugunda ayni satir IKINCI KEZ yazilmasin."""
    cfg = yapilandirma()
    istek = _istek(date="2026-08-02", startedAt="2026-08-02T14:00:00+03:00", description="a")

    assert deterministic_source_id(istek, cfg) == deterministic_source_id(istek, cfg)


@pytest.mark.parametrize(
    "fark",
    [
        {"minutes": 90},
        {"date": "2026-08-03"},
        {"targetId": "BASKA"},
        {"description": "farkli"},
        {"personId": "BASKA-KISI"},
    ],
)
def test_farkli_istek_farkli_sourceId_uretir(yapilandirma, fark):
    cfg = yapilandirma()
    temel_alanlar = {"date": "2026-08-02", "description": "a"}
    temel = _istek(**temel_alanlar)
    degisik = _istek(**{**temel_alanlar, **fark})

    assert deterministic_source_id(temel, cfg) != deterministic_source_id(degisik, cfg)


def test_sourceId_yapilandirilan_source_onekini_tasir(yapilandirma):
    cfg = yapilandirma(source="ders-demo")
    assert deterministic_source_id(_istek(), cfg).startswith("ders-demo:")


# ── girdi cevrimi ───────────────────────────────────────────────────────────


def test_from_dict_dakikayi_tamsayiya_cevirir_ve_varsayilanlari_doldurur():
    istek = TimeEntryRequest.from_dict(
        {"targetType": "task", "targetId": "T1", "minutes": "120"}
    )

    assert istek.minutes == 120
    assert istek.correction is False
    assert istek.dryRun is False
    assert istek.date is None


def test_is_allocation_yalnizca_time_allocation_hedefinde_dogrudur():
    assert TimeEntryRequest(targetType="time_allocation", targetId="A", minutes=60).is_allocation
    assert not TimeEntryRequest(targetType="request", targetId="R", minutes=60).is_allocation
