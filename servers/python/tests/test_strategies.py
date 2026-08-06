"""xurrent/strategies.py — uc backdate stratejisinin birim testleri.

Bu dosya dersin kalbini kilitler: bir Request/Task'a zaman yazmanin iki yolu
vardir ve ikisi de tek basina yetersizdir. Uc strateji bu catali uc farkli
sekilde cozer; hicbiri "dogru cevap" degildir.

Sihirbaz bu davranisi yalnizca DOLAYLI olarak dogruluyordu: bir kenar durum
bozuldugunda uctan uca akis genelde yine geciyor, hata uretimde goruluyordu.
Buradaki iddialar dogrudan build_plan() uzerinedir.
"""

from __future__ import annotations

import json

import pytest
from conftest import SABIT_BUGUN, SABIT_DUN

from xurrent_mcp.timeutil import iso_date
from xurrent_mcp.xurrent.strategies import STEP1_ENTRY_ID_PLACEHOLDER, build_plan
from xurrent_mcp.xurrent.validate import TimeEntryRequest

BEN = "TW9jay9QZXJzb24vMQ"
TALEP_ID = "TW9jay9SZXF1ZXN0LzcwMjQ4"
ALLOC_ID = "TW9jay9UaW1lQWxsb2NhdGlvbi8x"


def _istek(**kw) -> TimeEntryRequest:
    varsayilan: dict = {
        "targetType": "request",
        "targetId": TALEP_ID,
        "minutes": 120,
        "date": iso_date(SABIT_DUN),  # T-1: backdate senaryosunun ta kendisi
        "startedAt": f"{iso_date(SABIT_DUN)}T14:00:00+03:00",
        "description": "Index calismasi",
    }
    varsayilan.update(kw)
    return TimeEntryRequest(**varsayilan)


def _plan(yapilandirma, zaman_baglami, **kw):
    return build_plan(
        _istek(**kw),
        zaman_baglami(),
        yapilandirma(),
        authenticated_person_id=BEN,
        target_label="#70248 Masraf beyanı ekranı çok yavaş açılıyor",
    )


# ── two_step ────────────────────────────────────────────────────────────────


def test_two_step_iki_mutation_planlar_once_parent_sonra_time_entry_update(
    yapilandirma, zaman_baglami
):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step")

    assert plan.strategy == "two_step"
    assert len(plan.planned) == 2
    assert [adim.path for adim in plan.planned] == ["requestUpdate", "timeEntryUpdate"]


def test_two_step_adimlari_bir_bolu_iki_ve_iki_bolu_iki_olarak_etiketler(
    yapilandirma, zaman_baglami
):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step")

    assert [adim.stepLabel for adim in plan.planned] == ["1/2", "2/2"]
    assert [adim.index for adim in plan.planned] == [0, 1]


def test_two_step_ikinci_adimda_assignment_alani_GONDERMEZ(yapilandirma, zaman_baglami):
    """Stratejinin calismasinin TEK sebebi budur.

    TimeEntryUpdateInput'ta assignment alani YOKTUR; bir alan semada yoksa
    guncellenemez, dolayisiyla mevcut degeri korunur. 2. adima yanlislikla bir
    baglanti alani eklemek ticket bagini bozar ve bunu HICBIR uctan uca test
    yakalamaz — kayit yine olusur, sadece yanlis yere baglanir.
    """
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step")
    duzeltme = plan.planned[1].input

    yasakli = {"assignment", "assignmentId", "requestId", "taskId", "projectTaskId", "problemId"}
    assert yasakli.isdisjoint(duzeltme.keys())
    # Deger olarak da sizmasin: hedef id'nin kendisi 2. adimda gecmemeli.
    assert TALEP_ID not in json.dumps(duzeltme)


def test_two_step_ikinci_adim_id_yerine_calisma_zamani_yer_tutucusu_koyar(
    yapilandirma, zaman_baglami
):
    """requestUpdate payload'i Request doner, olusan TimeEntry'yi DEGIL.

    Bu yuzden 2. adimin id'si plan aninda BILINEMEZ; calisma aninda cozulur.
    """
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step")
    assert plan.planned[1].input["id"] == STEP1_ENTRY_ID_PLACEHOLDER


def test_two_step_tarihi_ve_baslangic_anini_ikinci_adimda_duzeltir(yapilandirma, zaman_baglami):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step")
    duzeltme = plan.planned[1].input

    assert duzeltme["date"] == iso_date(SABIT_DUN)
    assert duzeltme["startedAt"] == f"{iso_date(SABIT_DUN)}T14:00:00+03:00"
    # Tarih 1. adimda YOKTUR: orada gunu sunucu atar.
    assert "date" not in plan.planned[0].input


def test_two_step_ikinci_adim_aciklamayi_da_tasir(yapilandirma, zaman_baglami):
    """REST Yol B'de time_entry_description parametresi YOKTUR
    (developer.xurrent.com/v1/requests) — 1. adim aciklamayi ancak note'a
    dusurebilir. Kalici kaydin dogru bitmesi 2. adimin description'i
    duzeltmesine baglidir; GraphQL'de ayni deger yeniden yazilir (zararsiz)."""
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step")
    assert plan.planned[1].input["description"] == "Index calismasi"


def test_two_step_aciklama_yoksa_ikinci_adima_description_koymaz(
    yapilandirma, zaman_baglami
):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step", description=None)
    assert "description" not in plan.planned[1].input


def test_two_step_atomik_olmadigini_uyari_olarak_soyler(yapilandirma, zaman_baglami):
    """Kismi basari GERCEK bir risktir ve saklanmaz."""
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step")
    assert any("ATOMIK DEGILDIR" in u for u in plan.warnings)


def test_two_step_personId_me_ise_ikinci_adima_personId_koymaz(yapilandirma, zaman_baglami):
    """'$me' bir DEGER degil, bir yer tutucudur; API'ye oldugu gibi gidemez."""
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step", personId="$me")
    assert "personId" not in plan.planned[1].input


def test_two_step_baskasi_adina_yazmada_personId_ikinci_adima_gider(yapilandirma, zaman_baglami):
    """personId Yol B'de YOK SAYILIR; tasinabilecegi tek yer 2. adimdir."""
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="two_step", personId="BASKA-KISI")
    assert plan.planned[1].input["personId"] == "BASKA-KISI"
    assert "personId" not in plan.planned[0].input


# ── link_first ──────────────────────────────────────────────────────────────


def test_link_first_tek_mutation_planlar_ve_adim_etiketi_kullanmaz(yapilandirma, zaman_baglami):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="link_first")

    assert plan.strategy == "link_first"
    assert len(plan.planned) == 1
    assert plan.planned[0].path == "requestUpdate"
    assert plan.planned[0].stepLabel is None


def test_link_first_gecmis_tarih_istenince_KARSILANAMADI_uyarisi_uretir(
    yapilandirma, zaman_baglami
):
    """Uyarinin dili KASITLI olarak serttir.

    "Yaklasik olarak yazildi" gibi yumusatici bir ifade, kullanicinin yanlis
    bir varsayimla devam etmesine yol acar.
    """
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="link_first")

    uyari = next(u for u in plan.warnings if "KARSILANAMADI" in u)
    assert iso_date(SABIT_DUN) in uyari  # istenen tarih
    assert iso_date(SABIT_BUGUN) in uyari  # sunucunun atayacagi tarih


def test_link_first_bugun_istenince_tarih_uyarisi_URETMEZ(yapilandirma, zaman_baglami):
    """Ayni gun girisinde link_first hicbir sey kaybetmez; bos yere korkutmamali."""
    plan = _plan(
        yapilandirma,
        zaman_baglami,
        backdateStrategy="link_first",
        date=iso_date(SABIT_BUGUN),
        startedAt=None,
    )
    assert not any("KARSILANAMADI" in u for u in plan.warnings)


def test_link_first_tarih_bos_birakilinca_da_uyari_uretmez(yapilandirma, zaman_baglami):
    """date=None -> bugun demektir; backdate YOKTUR."""
    plan = _plan(
        yapilandirma, zaman_baglami, backdateStrategy="link_first", date=None, startedAt=None
    )
    assert not any("KARSILANAMADI" in u for u in plan.warnings)


def test_link_first_startedAt_in_kaybolacagini_soyler(yapilandirma, zaman_baglami):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="link_first")
    assert any("startedAt" in u and "KAYDEDILMEZ" in u for u in plan.warnings)


def test_link_first_baskasi_adina_yazmanin_YOK_SAYILACAGINI_soyler(yapilandirma, zaman_baglami):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="link_first", personId="BASKA-KISI")
    assert any("YOK SAYILIR" in u for u in plan.warnings)


def test_link_first_kendi_adina_yazmada_personId_uyarisi_uretmez(yapilandirma, zaman_baglami):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="link_first", personId=BEN)
    assert not any("personId YOK SAYILIR" in u for u in plan.warnings)


# ── date_first ──────────────────────────────────────────────────────────────


def test_date_first_hedefi_varsayilan_time_allocation_a_cevirir(yapilandirma, zaman_baglami):
    """timeEntryCreate bir ticket KABUL ETMEZ; hedef kovaya cevrilir."""
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="date_first")

    assert plan.strategy == "date_first"
    assert len(plan.planned) == 1
    assert plan.planned[0].path == "timeEntryCreate"
    assert plan.planned[0].input["timeAllocationId"] == ALLOC_ID
    assert TALEP_ID not in json.dumps(plan.planned[0].input)


def test_date_first_kaydin_ticketa_BAGLANMAYACAGINI_soyler(yapilandirma, zaman_baglami):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="date_first")
    assert any("BAGLANMAYACAK" in u for u in plan.warnings)
    assert any("BAGLANMAZ" in u for u in plan.planned[0].warnings)


def test_date_first_tarihi_ve_baslangic_anini_tam_korur(yapilandirma, zaman_baglami):
    girdi = _plan(yapilandirma, zaman_baglami, backdateStrategy="date_first").planned[0].input

    assert girdi["date"] == iso_date(SABIT_DUN)
    assert girdi["startedAt"] == f"{iso_date(SABIT_DUN)}T14:00:00+03:00"


def test_date_first_allocation_tanimli_degilse_env_uyarisi_uretir(yapilandirma, zaman_baglami):
    """DEFAULT_TIME_ALLOCATION_ID de yoksa, hesaptaki ilk allocation'a duser."""
    plan = build_plan(
        _istek(backdateStrategy="date_first"),
        zaman_baglami(timeAllocations=[]),
        yapilandirma(default_time_allocation_id=""),
        authenticated_person_id=BEN,
    )
    assert any("DEFAULT_TIME_ALLOCATION_ID" in u for u in plan.warnings)
    assert plan.planned[0].input["timeAllocationId"] == ""


def test_date_first_env_bos_ise_hesaptaki_ilk_allocationa_duser(yapilandirma, zaman_baglami):
    plan = build_plan(
        _istek(backdateStrategy="date_first"),
        zaman_baglami(),
        yapilandirma(default_time_allocation_id=""),
        authenticated_person_id=BEN,
    )
    assert plan.planned[0].input["timeAllocationId"] == ALLOC_ID


# ── hedef turleri ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("hedef_tur", "beklenen_path"),
    [
        ("request", "requestUpdate"),
        ("task", "taskUpdate"),
        ("project_task", "projectTaskUpdate"),
        ("problem", "problemUpdate"),
    ],
)
def test_yol_b_her_hedef_turunu_kendi_parent_mutationina_esler(
    yapilandirma, zaman_baglami, hedef_tur, beklenen_path
):
    plan = _plan(
        yapilandirma, zaman_baglami, backdateStrategy="two_step", targetType=hedef_tur
    )
    assert plan.planned[0].path == beklenen_path


def test_time_allocation_hedefi_strateji_ne_olursa_olsun_yol_a_kullanir(
    yapilandirma, zaman_baglami
):
    """Hedef bir TimeAllocation ise Yol A ZATEN tek secenektir.

    Kullanici two_step istese bile plan date_first'e duser — ve bunun sebebi
    ciktida yazili olur.
    """
    plan = _plan(
        yapilandirma,
        zaman_baglami,
        backdateStrategy="two_step",
        targetType="time_allocation",
        targetId=ALLOC_ID,
    )

    assert plan.strategy == "date_first"
    assert len(plan.planned) == 1
    assert plan.planned[0].path == "timeEntryCreate"
    assert plan.planned[0].input["timeAllocationId"] == ALLOC_ID
    assert any("tek secenektir" in u for u in plan.warnings)


@pytest.mark.parametrize(
    ("hedef_tur", "beklenen_effort_class"),
    [
        ("request", "TW9jay9FZmZvcnRDbGFzcy8x"),
        ("task", "TW9jay9FZmZvcnRDbGFzcy8y"),
    ],
)
def test_effort_class_hedef_turune_gore_varsayilandan_secilir(
    yapilandirma, zaman_baglami, hedef_tur, beklenen_effort_class
):
    """costMultiplier faturalamayi dogrudan etkiler; yanlis varsayilan sessizce pahalidir."""
    plan = _plan(
        yapilandirma, zaman_baglami, backdateStrategy="link_first", targetType=hedef_tur
    )
    assert plan.planned[0].input["timeSpentEffortClassId"] == beklenen_effort_class


def test_acikca_verilen_effort_class_varsayilani_ezer(yapilandirma, zaman_baglami):
    plan = _plan(
        yapilandirma,
        zaman_baglami,
        backdateStrategy="link_first",
        effortClassId="TW9jay9FZmZvcnRDbGFzcy8y",
    )
    assert plan.planned[0].input["timeSpentEffortClassId"] == "TW9jay9FZmZvcnRDbGFzcy8y"


# ── ortak alanlar ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("strateji", ["two_step", "link_first", "date_first"])
def test_her_strateji_kendi_adini_ve_aciklamasini_doner(yapilandirma, zaman_baglami, strateji):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy=strateji)
    assert plan.strategy == strateji
    assert len(plan.explanation) > 40  # aciklama bos birakilamaz, derste okunur


def test_yol_b_timeSpent_in_ARTIMLI_oldugunu_adim_uyarisinda_soyler(
    yapilandirma, zaman_baglami
):
    """'Toplami 90 yap' demek 'uzerine 90 ekle' demektir — cift sayma hatasinin kaynagi."""
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="link_first")
    assert any("ARTIMLI" in u for u in plan.planned[0].warnings)


def test_sourceID_yalnizca_yol_a_da_bulunur(yapilandirma, zaman_baglami):
    """Idempotency anahtari YALNIZCA TimeEntryCreateInput'ta vardir.

    Yol B kabul etmez; bu yuzden Yol B mutation'lari otomatik retry EDILMEZ.
    """
    yol_a = _plan(yapilandirma, zaman_baglami, backdateStrategy="date_first").planned[0].input
    yol_b = _plan(yapilandirma, zaman_baglami, backdateStrategy="link_first").planned[0].input

    assert "sourceID" in yol_a
    assert "sourceID" not in yol_b


def test_verilen_sourceId_deterministik_uretimin_yerine_gecer(yapilandirma, zaman_baglami):
    plan = _plan(
        yapilandirma, zaman_baglami, backdateStrategy="date_first", sourceId="elle-verilen-anahtar"
    )
    assert plan.planned[0].input["sourceID"] == "elle-verilen-anahtar"


@pytest.mark.parametrize("strateji", ["two_step", "link_first", "date_first"])
def test_dakika_degeri_hicbir_stratejide_donusturulmez(yapilandirma, zaman_baglami, strateji):
    """Birim DAKIKA'dir. Saat/saniye/ondalik saate cevrilmesi sessiz veri bozulmasidir."""
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy=strateji, minutes=90)
    assert plan.planned[0].input["timeSpent"] == 90


def test_aciklama_seksen_karakterde_kirpilir(yapilandirma, zaman_baglami):
    """description REST'te maks. 80 karakter. On kontrol zaten reddeder; plan
    yine de kirpar — iki katmanli savunma."""
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy="date_first", description="x" * 200)
    assert len(plan.planned[0].input["description"]) == 80


def test_yapilandirmadaki_strateji_arguman_verilmediginde_kullanilir(yapilandirma, zaman_baglami):
    plan = build_plan(
        _istek(backdateStrategy=None),
        zaman_baglami(),
        yapilandirma(backdate_strategy="link_first"),
        authenticated_person_id=BEN,
    )
    assert plan.strategy == "link_first"


def test_argumandaki_strateji_yapilandirmayi_ezer(yapilandirma, zaman_baglami):
    plan = build_plan(
        _istek(backdateStrategy="date_first"),
        zaman_baglami(),
        yapilandirma(backdate_strategy="link_first"),
        authenticated_person_id=BEN,
    )
    assert plan.strategy == "date_first"


# ★ BULGU VE DUZELTMESI (tarihce — silmeyin):
# Bu test yazildiginda KIRMIZIYDI. Tek adimli planlarda (link_first, date_first)
# index hic set edilmiyor, JSON'a "index": null dusuyordu. contract/tools.json
# PlannedMutation.index'i {"type": "integer"} olarak tanimlar; TypeScript 0 yazar,
# C#'ta alan non-nullable. Python TEK AYKIRIYDI ve uc dilin ayni ciktiyi uretmesi
# bu repodaki ana tezdir. verify-contract.mjs bu alani kontrol etmedigi icin ihlal
# gorunmuyordu — sozlesmeyi dogrulamak, sozlesmenin HER alanini dogrulamak degilmis.
# Duzeltme: models.PlannedMutation.index varsayilani 0.
@pytest.mark.parametrize("strateji", ["link_first", "date_first"])
def test_tek_adimli_planda_index_sozlesmedeki_gibi_tamsayidir(
    yapilandirma, zaman_baglami, strateji
):
    plan = _plan(yapilandirma, zaman_baglami, backdateStrategy=strateji)
    assert plan.planned[0].index == 0
