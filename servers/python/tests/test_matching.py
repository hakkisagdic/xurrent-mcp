"""tools/matching.py — toplanti basligi -> acik is eslestirme heuristigi.

KURAL: heuristik BASIT ve ACIKLANABILIR tutulur, cunku eslestirme ASLA %100
dogru olamaz. Uc yol vardir:
  1. Baslikta ticket numarasi -> KESIN eslesme (confidence 1.0)
  2. Metin benzerligi         -> BULANIK eslesme
  3. Hicbiri / BIRDEN FAZLA aday -> needsUserDecision=true

En onemli iddia sonuncusudur: belirsizlikte bot TAHMIN ETMEZ, SORAR. Bir
"iyilestirme" bunu sessizce en yuksek skora dusurebilir ve uctan uca akis yine
gecer — o yuzden burada kilitlenir.

Is ogeleri fixtures/requests.json + tasks.json'dan gelir (conftest: acik_isler);
ayri bir test verisi uydurmak dersi ikiye bolerdi.
"""

from __future__ import annotations

import pytest

from xurrent_mcp.models import WorkItem
from xurrent_mcp.tools.matching import (
    FUZZY_THRESHOLD,
    dice_similarity,
    match_meeting,
    normalize_text,
)


# ── Yol 1: baslikta ticket numarasi -> KESIN ────────────────────────────────


@pytest.mark.parametrize(
    "baslik",
    [
        "REQ-70248 performans incelemesi",
        "#70248 performans incelemesi",
        "70248 performans incelemesi",
        "req 70248 inceleme",
        "Toplantı — TALEP 70248",
    ],
)
def test_baslikta_ticket_numarasi_gecince_KESIN_eslesme_kurulur(acik_isler, baslik):
    eslesme = match_meeting(baslik, acik_isler)

    assert eslesme.item is not None
    assert eslesme.item.displayId == "70248"
    assert eslesme.confidence == 1.0
    assert eslesme.needs_decision is False


def test_kesin_eslesmenin_gerekcesi_hangi_numaradan_geldigini_soyler(acik_isler):
    eslesme = match_meeting("REQ-70248 performans incelemesi", acik_isler)
    assert "70248" in eslesme.reason
    assert "KESIN" in eslesme.reason


def test_gorev_numarasi_da_kesin_eslesme_kurar(acik_isler):
    eslesme = match_meeting("TASK 4419 log analizi", acik_isler)

    assert eslesme.item is not None
    assert eslesme.item.kind == "task"
    assert eslesme.item.displayId == "4419"
    assert eslesme.confidence == 1.0


def test_ticket_numarasi_metin_benzerliginden_ONCE_bakilir(acik_isler):
    """Baslik hem numara hem de baska bir kaydin metnini tasisa bile numara kazanir."""
    eslesme = match_meeting("VPN kopma sorunu — REQ-70248 kapsaminda", acik_isler)

    assert eslesme.item.displayId == "70248"
    assert eslesme.confidence == 1.0


def test_uc_haneden_kisa_sayilar_ticket_numarasi_SAYILMAZ(acik_isler):
    """'1:1 — Mehmet Kaya' bir ticket referansi degildir."""
    eslesme = match_meeting("1:1 — Mehmet Kaya", acik_isler)
    assert eslesme.confidence != 1.0


def test_listede_olmayan_numara_kesin_eslesme_uretmez(acik_isler):
    eslesme = match_meeting("REQ-99999 bilinmeyen", acik_isler)
    assert eslesme.confidence != 1.0


# ── Yol 2: metin benzerligi -> BULANIK ──────────────────────────────────────


def test_tek_aday_metin_benzerligi_kurunca_BULANIK_eslesme_doner(acik_isler):
    """fixtures/calendar.json evt-006 tam bu senaryo icin var."""
    eslesme = match_meeting("Onboarding otomasyonu tasarım toplantısı", acik_isler)

    assert eslesme.item is not None
    assert eslesme.item.displayId == "70315"
    assert 0 < eslesme.confidence < 1.0
    assert eslesme.needs_decision is False
    assert "BULANIK" in eslesme.reason


def test_turkce_ekler_kok_uzerinden_eslesir(acik_isler):
    """'analiz' ~ 'analizi', 'otomasyon' ~ 'otomasyonu' — ilk 4 harf ortak kurali."""
    assert dice_similarity(["otomasyon"], ["otomasyonu"]) == 1.0
    assert dice_similarity(["analiz"], ["analizi"]) == 1.0


def test_ilk_dort_harfi_ortak_olmayan_tokenlar_eslesmez():
    assert dice_similarity(["masraf"], ["mesgul"]) == 0.0


# ── Yol 3: BELIRSIZLIK -> kullanici karari ──────────────────────────────────


def test_esik_ustunde_birden_fazla_aday_varsa_KULLANICI_KARARI_istenir(acik_isler):
    """★ Bot tahmin etmemelidir.

    'VPN kopma sorunu kok neden analizi' hem Talep #70301 hem Gorev #4419 ile
    benzerlik kurar. En yuksek skoru secip devam etmek YANLIS ticket'a saat
    yazmaktir ve kullanici bunu ay sonunda fark eder.
    """
    eslesme = match_meeting("VPN kopma sorunu kök neden analizi", acik_isler)

    assert eslesme.needs_decision is True
    assert eslesme.item is not None  # en iyi aday yine de ONERI olarak sunulur
    assert "Belirsizlik" in eslesme.reason


def test_belirsizlik_gerekcesi_adaylari_kullaniciya_LISTELER(acik_isler):
    """Kullanici secim yapabilmek icin adaylari gormek zorundadir."""
    eslesme = match_meeting("VPN kopma sorunu kök neden analizi", acik_isler)

    assert "#4419" in eslesme.reason
    assert "#70301" in eslesme.reason


def test_hicbir_aday_yoksa_KULLANICI_KARARI_istenir(acik_isler):
    """'Gunluk standup' hangi ticket'a yazilacak? Bilinemez — SORULMALI."""
    eslesme = match_meeting("Günlük standup", acik_isler)

    assert eslesme.item is None
    assert eslesme.confidence == 0.0
    assert eslesme.needs_decision is True


def test_bos_is_listesinde_kullanici_karari_istenir():
    eslesme = match_meeting("REQ-70248 performans incelemesi", [])

    assert eslesme.item is None
    assert eslesme.needs_decision is True


# ── metin normalizasyonu ────────────────────────────────────────────────────


def test_normalize_text_stopwordleri_eler():
    assert "ile" not in normalize_text("VPN tedarikçisi ile teknik görüşme")
    assert "için" not in normalize_text("Yeni çalışanlar için AD hesabı")


def test_normalize_text_uc_harften_kisa_tokenlari_eler():
    assert normalize_text("AD hesabı aç") == ["hesabı"]


def test_normalize_text_noktalama_atar_ama_turkce_harfleri_KORUR():
    assert normalize_text("Onboarding — otomasyonu, tasarım!") == [
        "onboarding",
        "otomasyonu",
        "tasarım",
    ]


def test_normalize_text_buyuk_I_yi_turkce_kurala_gore_kucultur():
    """Python'un lower()'i 'I' -> 'i' yapar; Turkce'de dogrusu 'ı'dir.
    'İNDEX' ile 'index' esleşmeli, 'IŞIK' ile 'isik' ESLESMEMELI."""
    assert normalize_text("İNDEX") == ["index"]
    assert normalize_text("IŞIK") == ["ışık"]


# ── Dice katsayisi ──────────────────────────────────────────────────────────


def test_dice_bos_listede_sifir_doner():
    assert dice_similarity([], ["abc"]) == 0.0
    assert dice_similarity(["abc"], []) == 0.0


def test_dice_ayni_listede_bir_doner():
    assert dice_similarity(["vpnn", "kopma"], ["vpnn", "kopma"]) == 1.0


def test_dice_simetriktir():
    sol = normalize_text("VPN bağlantısı gün içinde sürekli kopuyor")
    sag = normalize_text("VPN kopma sorunu kök neden analizi")
    assert dice_similarity(sol, sag) == dice_similarity(sag, sol)


def test_dice_bir_tokeni_iki_kez_saymaz():
    """Ayni hedef token'a iki kaynak token eslesemez (used seti)."""
    assert dice_similarity(["analiz", "analizi"], ["analiz"]) == pytest.approx(2 / 3)


def test_esik_altindaki_benzerlik_aday_bile_sayilmaz():
    """FUZZY_THRESHOLD altinda kalan hicbir kayit onerilmez."""
    isler = [
        WorkItem(
            kind="request",
            id="R1",
            displayId="1",
            subject="Yazıcı sürücüsü",
            status="assigned",
        )
    ]
    eslesme = match_meeting("Bahçe sulama planlaması", isler)

    assert eslesme.item is None
    assert FUZZY_THRESHOLD > 0
