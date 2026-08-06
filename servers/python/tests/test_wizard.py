"""timesheet_wizard birim testleri — contract/wizard.md'nin calisan kaniti.

conftest kurallari gecerli: ag yok, zaman SABIT_BUGUN'e cakili, test adi = iddia.
Adim etiketleri senaryo koducusuyla (senaryolar.mjs, h) birebir ayni:
start -> pick_work -> duration -> detail -> strategy -> write(done).
"""

from __future__ import annotations

import base64
import hashlib
import hmac as hmac_mod
import json
import sys
import time
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from conftest import SABIT_DUN  # noqa: E402

from xurrent_mcp.core.wizard import (  # noqa: E402
    plan_fingerprint,
    sign_state,
    sure_ayristir,
    timesheet_wizard,
    verify_state,
)
from xurrent_mcp.tools.runtime import Runtime  # noqa: E402
from xurrent_mcp.xurrent.mock import MockXurrentAdapter  # noqa: E402

SIR = "test-wizard-sirri-0123456789abcdef"
ME = "TW9jay9QZXJzb24vMQ"


@pytest.fixture
def rt(yapilandirma) -> Runtime:
    cfg = yapilandirma(state_secret=SIR)
    return Runtime(config=cfg, adapter=MockXurrentAdapter(cfg))


def _cagir(rt: Runtime, utterance: str = "", state: str | None = None) -> dict:
    args: dict = {"utterance": utterance}
    if state is not None:
        args["sessionState"] = state
    return timesheet_wizard(rt, args)


def _payload(token: str) -> dict:
    govde = token.split(".")[0]
    return json.loads(base64.urlsafe_b64decode(govde + "=" * (-len(govde) % 4)))


def _yeniden_imzala(payload: dict) -> str:
    return sign_state(SIR.encode("utf-8"), payload)


# ── mutlu yol ───────────────────────────────────────────────────────────────


def test_mutlu_yol_adim_dizisi_ve_yazma(rt) -> None:
    """start -> pick_work -> duration -> detail -> strategy -> write(done)."""
    r1 = _cagir(rt)
    assert r1["step"] == "start" and r1["done"] is False
    assert r1["errors"] == []
    assert "timeIncrement 30" in r1["reply"]  # baglam SOYLENIR
    secenekler = r1["nextQuestion"]["choices"]
    assert secenekler[-1]["id"] == "takvim"
    assert len(secenekler) == 7  # 3 request + 3 task + takvim
    assert isinstance(r1["sessionState"], str)

    r2 = _cagir(rt, "1", r1["sessionState"])
    assert r2["step"] == "pick_work"
    assert "#70248" in r2["reply"]

    r3 = _cagir(rt, "2 saat", r2["sessionState"])
    assert r3["step"] == "duration"
    assert "120" in r3["reply"]  # cevirim ACIKCA soylenir

    r4 = _cagir(rt, "dün 14:00 VPN bakımı", r3["sessionState"])
    assert r4["step"] == "detail"
    assert len(r4["nextQuestion"]["choices"]) == 3  # uc strateji

    r5 = _cagir(rt, "two_step", r4["sessionState"])
    assert r5["step"] == "strategy"
    assert "PLAN" in r5["reply"] and "dryRun" in r5["reply"]
    assert [c["id"] for c in r5["nextQuestion"]["choices"]] == ["evet", "hayır"]

    r6 = _cagir(rt, "evet", r5["sessionState"])
    assert r6["step"] == "write" and r6["done"] is True
    assert r6["sessionState"] is None and r6["nextQuestion"] is None
    assert r6["errors"] == []
    sonuc = r6["writeResult"]
    assert sonuc is not None and sonuc["dryRun"] is False
    assert sonuc["strategy"] == "two_step"
    assert sonuc["timeEntry"]["date"] == SABIT_DUN.isoformat()  # 2. adim tarihi duzeltti
    assert sonuc["timeEntry"]["timeSpent"] == 120
    assert "Geri-okuma" in r6["reply"]  # yazma raporuna guvenilmez, kayit okunur


def test_session_state_round_trip_ve_payload_alanlari(rt) -> None:
    r1 = _cagir(rt)
    r2 = _cagir(rt, "1", r1["sessionState"])
    dogrulanan = verify_state(SIR.encode("utf-8"), r2["sessionState"])
    assert dogrulanan["v"] == 1 and dogrulanan["kind"] == "wizard"
    assert dogrulanan["step"] == "pick_work"
    data = dogrulanan["data"]
    assert data["targetType"] == "request"
    assert data["targetId"] == "TW9jay9SZXF1ZXN0LzcwMjQ4"
    assert data["personId"] == ME

    r3 = _cagir(rt, "2 saat", r2["sessionState"])
    assert verify_state(SIR.encode("utf-8"), r3["sessionState"])["data"]["minutes"] == 120


def test_baska_dilin_urettigi_bicimdeki_state_kabul_edilir(rt) -> None:
    """HMAC ham payload byte'lari uzerindedir — kanonikleştirme YOK.

    Baska bir dilin (farkli anahtar sirasi, bosluklu JSON) urettigi state ayni
    sirla dogrulanir; capraz-dil devrin birim test karsiligi budur.
    """
    govde = (
        '{"kind": "wizard", "v": 1, "exp": %d, "step": "pick_work", '
        '"data": {"personId": "%s", "targetType": "request", '
        '"targetId": "TW9jay9SZXF1ZXN0LzcwMjQ4", "targetLabel": "#70248 test"}}'
        % (int(time.time()) + 600, ME)
    ).encode("utf-8")
    imza = hmac_mod.new(SIR.encode("utf-8"), govde, hashlib.sha256).digest()
    b64 = lambda b: base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")  # noqa: E731
    token = f"{b64(govde)}.{b64(imza)}"

    sonuc = _cagir(rt, "2 saat", token)
    assert sonuc["step"] == "duration"  # start'a DUSMEDI
    assert "120" in sonuc["reply"]


# ── ayristirma kurallari (§3) ───────────────────────────────────────────────


def test_bir_bucuk_saat_doksan_dakikadir(rt) -> None:
    assert sure_ayristir("1,5 saat") == (90, True)
    assert sure_ayristir("1.5 saat") == (90, True)
    assert sure_ayristir("2 saat") == (120, True)
    assert sure_ayristir("90") == (90, False)
    assert sure_ayristir("45 dk") == (45, False)
    assert sure_ayristir("saat yok") is None

    r1 = _cagir(rt)
    r2 = _cagir(rt, "1", r1["sessionState"])
    r3 = _cagir(rt, "1,5 saat", r2["sessionState"])
    assert r3["step"] == "duration"
    assert "90" in r3["reply"]


def test_turkce_katlama_buyuk_i_ile_evet_kabul_edilir(rt) -> None:
    """'EVET' → İ/I katlamasiyla 'evet'; 'İPTAL' → 'iptal'."""
    r1 = _cagir(rt)
    r2 = _cagir(rt, "1", r1["sessionState"])
    r3 = _cagir(rt, "2 saat", r2["sessionState"])
    r4 = _cagir(rt, "bugün 30 dakikalık kontrol", r3["sessionState"])
    r5 = _cagir(rt, "link_first", r4["sessionState"])
    son = _cagir(rt, "EVET", r5["sessionState"])
    assert son["step"] == "write" and son["done"] is True


def test_hayir_yazmayi_iptal_eder(rt) -> None:
    r1 = _cagir(rt)
    r2 = _cagir(rt, "1", r1["sessionState"])
    r3 = _cagir(rt, "60", r2["sessionState"])
    r4 = _cagir(rt, "bugün", r3["sessionState"])
    r5 = _cagir(rt, "2", r4["sessionState"])  # link_first (1-bazli sira)
    son = _cagir(rt, "hayır", r5["sessionState"])
    assert son["done"] is True and son["step"] == "done"
    assert son["writeResult"] is None
    assert "yazılmadı" in son["reply"] or "gönderilmedi" in son["reply"]


# ── saglamlik ───────────────────────────────────────────────────────────────


def test_anlasilmayan_cevap_adimi_ilerletmez(rt) -> None:
    """Hatali cevap: adim DEGISMEZ, ayni nextQuestion aynen doner (§2)."""
    r1 = _cagir(rt)
    r2 = _cagir(rt, "1", r1["sessionState"])
    saçma = _cagir(rt, "asdfgh qwerty", r2["sessionState"])
    assert saçma["step"] == "pick_work"  # ilerlemedi
    assert saçma["nextQuestion"]["prompt"] == r2["nextQuestion"]["prompt"]
    assert saçma["done"] is False
    # Ayni state ile dogru cevap hala calisiyor.
    devam = _cagir(rt, "90", saçma["sessionState"])
    assert devam["step"] == "duration"


def test_increment_kati_olmayan_sure_sessizce_yuvarlanmaz(rt) -> None:
    r1 = _cagir(rt)
    r2 = _cagir(rt, "1", r1["sessionState"])
    kirkbes = _cagir(rt, "45", r2["sessionState"])  # timeIncrement=30
    assert kirkbes["step"] == "pick_work"  # ilerlemedi — SORDU
    assert "30" in kirkbes["reply"] and "60" in kirkbes["reply"]


def test_kurcalanmis_state_acik_mesajla_bastan_baslatir(rt) -> None:
    r1 = _cagir(rt)
    token = r1["sessionState"]
    govde, imza = token.split(".")
    # Payload'da tek karakteri degistir — imza HAM byte'lar uzerinde oldugundan
    # dogrulama daha parse etmeden kirilir.
    bozuk_govde = ("A" if govde[10] != "A" else "B").join([govde[:10], govde[11:]])
    bozuk = f"{bozuk_govde}.{imza}"

    sonuc = _cagir(rt, "1", bozuk)
    assert sonuc["step"] == "start"  # sessiz sifirlama YOK, ACIK yeniden baslama
    assert "BAŞTAN" in sonuc["reply"]
    assert "İMZASI GEÇERSİZ" in sonuc["reply"] or "IMZASI GECERSIZ" in sonuc["reply"]


def test_suresi_dolmus_state_nazikce_bastan_baslatir(rt) -> None:
    payload = {
        "v": 1,
        "kind": "wizard",
        "step": "pick_work",
        "exp": int(time.time()) - 5,
        "data": {"personId": ME, "targetType": "request", "targetId": "TW9jay9SZXF1ZXN0LzcwMjQ4"},
    }
    sonuc = _cagir(rt, "2 saat", _yeniden_imzala(payload))
    assert sonuc["step"] == "start"
    assert "süresi dolmuş" in sonuc["reply"] or "BAŞTAN" in sonuc["reply"]
    assert sonuc["errors"] == []  # yeniden baslama bir HATA degildir


def test_fingerprint_uyusmazsa_yazma_reddedilir(rt) -> None:
    """State imzasi gecerli ama data onaylanandan farkli -> yazma YOK."""
    r1 = _cagir(rt)
    r2 = _cagir(rt, "1", r1["sessionState"])
    r3 = _cagir(rt, "2 saat", r2["sessionState"])
    r4 = _cagir(rt, "dün 14:00 VPN bakımı", r3["sessionState"])
    r5 = _cagir(rt, "two_step", r4["sessionState"])

    payload = _payload(r5["sessionState"])
    assert payload["data"]["plannedFingerprint"]
    payload["data"]["minutes"] = 60  # onaylanan 120 idi — kurcala, GECERLI imzayla
    sahte = _yeniden_imzala(payload)

    sonuc = _cagir(rt, "evet", sahte)
    assert sonuc["done"] is True
    assert sonuc["writeResult"] is None  # yazma GERCEKLESMEDI
    assert sonuc["errors"] and "plannedFingerprint" in sonuc["errors"][0]["message"]
    assert "REDDEDİLDİ" in sonuc["reply"]


def test_fingerprint_dogru_plani_kilitler(rt) -> None:
    """Ayni planned dizisi ayni parmak izini uretir (deterministik)."""
    planned = [{"path": "timeEntryCreate", "input": {"timeSpent": 30}, "warnings": []}]
    assert plan_fingerprint(planned) == plan_fingerprint(json.loads(json.dumps(planned)))
    assert plan_fingerprint(planned) != plan_fingerprint(
        [{"path": "timeEntryCreate", "input": {"timeSpent": 60}, "warnings": []}]
    )


# ── takvim kolu ─────────────────────────────────────────────────────────────


def test_takvim_kelimesi_takvim_planina_gecirir(rt) -> None:
    r1 = _cagir(rt)
    plan = _cagir(rt, "takvimden al", r1["sessionState"])
    assert plan["step"] in ("calendar_plan",)
    if plan["done"]:
        return  # mock takvimde yazilabilir oneri cikmadiysa akis nazikce biter
    assert plan["nextQuestion"] is not None
    # eleme cevabi listede kalan kalemleri gosterir ya da evet bulk onayina gecer
    devam = _cagir(rt, "evet", plan["sessionState"])
    assert devam["step"] in ("calendar_confirm", "calendar_plan")
