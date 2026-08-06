"""xurrent_list_time_entries birim testleri — geri-okumanin resmi gozu.

conftest kurallari gecerli: I/O yok (mock adapter fixture JSON okur, ag yok),
zaman SABIT_BUGUN'e cakili, test adi = iddia.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from conftest import SABIT_BUGUN, SABIT_DUN  # noqa: E402

from xurrent_mcp.tools.read_tools import xurrent_list_time_entries  # noqa: E402
from xurrent_mcp.tools.runtime import Runtime  # noqa: E402
from xurrent_mcp.tools.write_tools import xurrent_create_time_entry  # noqa: E402
from xurrent_mcp.xurrent.mock import MockXurrentAdapter  # noqa: E402

ME = "TW9jay9QZXJzb24vMQ"


@pytest.fixture
def mock_rt(yapilandirma) -> Runtime:
    cfg = yapilandirma(confirm_policy="open")
    return Runtime(config=cfg, adapter=MockXurrentAdapter(cfg))


# ── mock filtreleri ─────────────────────────────────────────────────────────


def test_varsayilan_cagri_me_kayitlarini_ve_toplami_doner(mock_rt) -> None:
    sonuc = xurrent_list_time_entries(mock_rt, {})
    assert sonuc["accountId"]
    assert len(sonuc["timeEntries"]) == 5  # fixtures/time-entries.json
    assert sonuc["totalMinutes"] == 60 + 30 + 45 + 30 + 240
    # Her kayit contract $defs/TimeEntryRecord zorunlulariyla gelir.
    for kayit in sonuc["timeEntries"]:
        assert kayit["id"] and kayit["date"] and isinstance(kayit["timeSpent"], int)
        assert kayit["person"]["id"] == ME


def test_tarih_araligi_iki_ucu_da_dahil_suzer(mock_rt) -> None:
    dun = SABIT_DUN.isoformat()
    sonuc = xurrent_list_time_entries(mock_rt, {"dateFrom": dun, "dateTo": dun})
    # dayOffset=-1 olan iki fixture kaydi: 30 + 45 dakika.
    assert len(sonuc["timeEntries"]) == 2
    assert sonuc["totalMinutes"] == 75


def test_baska_kisi_icin_bos_liste_doner(mock_rt) -> None:
    sonuc = xurrent_list_time_entries(mock_rt, {"personId": "TW9jay9QZXJzb24vOTk"})
    assert sonuc["timeEntries"] == []
    assert sonuc["totalMinutes"] == 0


def test_first_donen_kayit_sayisini_sinirlar(mock_rt) -> None:
    sonuc = xurrent_list_time_entries(mock_rt, {"first": 2})
    assert len(sonuc["timeEntries"]) == 2


def test_assignment_display_id_fixture_dan_cozulur(mock_rt) -> None:
    """Yol B kaydinin assignment'i UI numarasini (displayId) tasir."""
    sonuc = xurrent_list_time_entries(mock_rt, {})
    ilk = next(e for e in sonuc["timeEntries"] if e["id"] == "TW9jay9UaW1lRW50cnkvMQ")
    assert ilk["assignment"] == {
        "type": "Request",
        "id": "TW9jay9SZXF1ZXN0LzcwMjQ4",
        "displayId": "70248",
    }
    assert ilk["sourceID"] is None  # fixture kayitlari idempotency anahtari tasimaz


def test_source_id_nokta_aramasi_yazilan_kaydi_bulur(mock_rt) -> None:
    """Dedup geri-okumasinin genel hali: yaz -> sourceID ile GERI OKU."""
    yazma = xurrent_create_time_entry(
        mock_rt,
        {
            "targetType": "time_allocation",
            "targetId": "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
            "minutes": 30,
            "description": "geri-okuma testi",
            "dryRun": False,
        },
    )
    assert yazma["errors"] == []
    source_id = yazma["planned"][0]["input"]["sourceID"]
    assert source_id

    sonuc = xurrent_list_time_entries(mock_rt, {"sourceId": source_id})
    assert len(sonuc["timeEntries"]) == 1
    assert sonuc["timeEntries"][0]["id"] == yazma["timeEntry"]["id"]
    assert sonuc["timeEntries"][0]["sourceID"] == source_id
    assert sonuc["totalMinutes"] == 30

    # Bilinmeyen anahtar bos doner — "yazilmamis" cevabinin kendisi.
    bos = xurrent_list_time_entries(mock_rt, {"sourceId": "xmcp-yok-boyle-bir-sey"})
    assert bos["timeEntries"] == []


# ── canli sorgu sekli ───────────────────────────────────────────────────────


def test_canli_sorgu_degisken_adlari_sahte_sunucuyla_birebir(yapilandirma, monkeypatch) -> None:
    """TEK timeEntries sorgusu; degiskenler personId/dateFrom/dateTo/sourceID.

    tools/fake-xurrent/server.mjs bu adlari DOGRUDAN okur — bir ad kayarsa
    filtre sessizce yok sayilir. Sinif 'query'dir (retry serbest).
    """
    from xurrent_mcp.xurrent.live import LiveXurrentAdapter

    cfg = yapilandirma(mode="live", token="test-token", account="ornek-bt")
    adapter = LiveXurrentAdapter(cfg)

    goruldu: dict = {}

    def sahte_execute(document, variables=None, *, op_class="query", op_label="query", on_uncertain=None):
        goruldu.update(document=document, variables=variables, op_class=op_class)
        return {
            "timeEntries": {
                "nodes": [
                    {
                        "id": "T1",
                        "date": "2026-08-02",
                        "startedAt": None,
                        "timeSpent": 60,
                        "description": "x",
                        "correction": False,
                        "source": "xurrent-mcp",
                        "sourceID": "xmcp-abc",
                        "person": {"id": ME, "name": "Deniz"},
                        "effortClass": {"id": "E1", "name": "Standart"},
                        "assignment": {"__typename": "Request", "id": "R1", "requestId": "70248"},
                    }
                ]
            }
        }

    monkeypatch.setattr(adapter, "execute", sahte_execute)
    kayitlar = adapter.list_time_entries(ME, "2026-08-01", "2026-08-03", "xmcp-abc", 25)

    assert set(goruldu["variables"]) == {"personId", "dateFrom", "dateTo", "sourceID", "first"}
    assert goruldu["variables"]["personId"] == ME
    assert goruldu["variables"]["sourceID"] == "xmcp-abc"
    assert goruldu["op_class"] == "query"
    assert "timeEntries(" in goruldu["document"]

    # Node -> TimeEntryRecord eslemesi (assignment displayId dahil).
    assert kayitlar[0]["assignment"] == {"type": "Request", "id": "R1", "displayId": "70248"}
    assert kayitlar[0]["person"] == {"id": ME, "name": "Deniz"}
    assert kayitlar[0]["timeSpent"] == 60


def test_bugun_sabitse_fixture_tarihleri_bugune_gore_acilir(mock_rt) -> None:
    """dayOffset göreli sözleşmesi: -1 = SABIT_DUN (conftest zamani cakar)."""
    from datetime import timedelta

    sonuc = xurrent_list_time_entries(mock_rt, {})
    tarihler = {e["id"]: e["date"] for e in sonuc["timeEntries"]}
    assert tarihler["TW9jay9UaW1lRW50cnkvMg"] == SABIT_DUN.isoformat()
    assert tarihler["TW9jay9UaW1lRW50cnkvMQ"] == (SABIT_BUGUN - timedelta(days=3)).isoformat()
