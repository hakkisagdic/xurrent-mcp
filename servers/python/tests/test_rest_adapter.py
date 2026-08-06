"""REST v1 adaptoru birim testleri — "transport bir adaptor detayidir" kaniti.

CALISTIRMA: uv run pytest tests/test_rest_adapter.py -q

Kurallar conftest.py'dekiyle ayni: I/O YOK (httpx.MockTransport bellek icidir),
zaman sabitlenir, test adi = iddia.

Kapsanan iddialar:
  1. Uc nokta / parametre eslemesi: whoami IKI istek (/me + /account),
     people?primary_email, requests?member, tasks?assignee,
     time_entries?person&date_from&date_to&sourceID.
  2. snake_case -> ic sozlesme (camelCase) normalizasyonu: kisi, is ogesi,
     baglam (time_increment -> timeIncrement, *_effort_class -> defaults) ve
     TimeEntryRecord.
  3. 422 -> errors[] normalizasyonu: is kurali reddi exception DEGILDIR ve
     ASLA retry edilmez (GraphQL "200 + payload.errors" dersinin ikizi).
  4. Operasyon siniflari (reliability.md §2) REST'te de AYNIDIR:
     POST /time_entries guarded_create, PATCH /time_entries idempotent_update,
     PATCH /requests|tasks no_retry.
  5. Dedup geri-okumasi GET /time_entries?sourceID= uzerinden calisir.
  6. two_step'in REST karsiligi: parent PATCH + bugunun en yeni kaydi +
     PATCH /time_entries/:id.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import pytest

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from xurrent_mcp.config import Config  # noqa: E402
from xurrent_mcp.xurrent import build_adapter  # noqa: E402
from xurrent_mcp.xurrent.rest import RestXurrentAdapter  # noqa: E402
from xurrent_mcp.xurrent.retry import (  # noqa: E402
    XurrentRestValidationError,
    classify,
)

from conftest import SABIT_BUGUN  # noqa: E402


def _rest_adapter(yapilandirma, handler, **cfg_kw) -> RestXurrentAdapter:
    cfg = yapilandirma(
        mode="live",
        api="rest",
        token="test-token",
        account="ornek-bt",
        min_request_gap_ms=0,
        retry_base_ms=0,
        retry_cap_ms=0,
        **cfg_kw,
    )
    adapter = RestXurrentAdapter(cfg)
    # Ag YOK: MockTransport istekleri bellekte cevaplar.
    adapter._client = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="https://sahte.local/v1"
    )
    return adapter


def _retry_satirlari(capsys: pytest.CaptureFixture) -> list[str]:
    return [l for l in capsys.readouterr().err.splitlines() if l.startswith("[retry]")]


_ME_REST = {
    "id": "P1",
    "name": "Ayse Yilmaz",
    "primary_email": "ayse@ornek.com",
    "job_title": "BT Uzmani",
    "time_zone": "Europe/Istanbul",
    "disabled": False,
    "organization": {"id": "ORG1", "name": "Ornek BT"},
}

_ENTRY_REST = {
    "id": "TE1",
    "date": "2026-08-03",
    "started_at": "2026-08-03T09:00:00+03:00",
    "time_spent": 30,
    "description": "test kalemi",
    "correction": False,
    "source": "xurrent-mcp",
    "sourceID": "xmcp-abc123",
    "person": {"id": "P1", "name": "Ayse Yilmaz"},
    "effort_class": {"id": "EC1", "name": "Standart"},
    "time_allocation": {"id": "TA1", "name": "Ic toplantilar"},
    "assignment": None,
}


# ══════════════════════════════════ 1. adapter fabrikasi + yapilandirma


def test_fabrika_live_rest_kombinasyonunda_rest_adapter_secer(yapilandirma) -> None:
    cfg = yapilandirma(mode="live", api="rest", token="t", account="a")
    assert isinstance(build_adapter(cfg), RestXurrentAdapter)


def test_fabrika_mock_modda_apiyi_yok_sayar(yapilandirma) -> None:
    from xurrent_mcp.xurrent.mock import MockXurrentAdapter

    cfg = yapilandirma(mode="mock", api="rest")
    assert isinstance(build_adapter(cfg), MockXurrentAdapter)


def test_gecersiz_xurrent_api_sessizce_dusmez_net_hata_verir(monkeypatch) -> None:
    """XURRENT_API=rets yazan biri REST konustugunu SANMASIN (MCP_PROTOCOL kurali)."""
    import xurrent_mcp.config as config_mod

    monkeypatch.setattr(config_mod, "_load_dotenv_if_present", lambda: None)
    monkeypatch.setenv("MCP_PROTOCOL", "2026-07-28")
    monkeypatch.setenv("XURRENT_API", "rets")
    with pytest.raises(ValueError, match="XURRENT_API"):
        config_mod.load_config()


def test_rest_url_sondaki_bolu_kirpilir(monkeypatch) -> None:
    import xurrent_mcp.config as config_mod

    monkeypatch.setattr(config_mod, "_load_dotenv_if_present", lambda: None)
    monkeypatch.setenv("MCP_PROTOCOL", "2026-07-28")
    monkeypatch.setenv("XURRENT_API", "rest")
    monkeypatch.setenv("XURRENT_REST_URL", "http://127.0.0.1:4000/v1/")
    cfg = config_mod.load_config()
    assert cfg.api == "rest"
    assert cfg.rest_url == "http://127.0.0.1:4000/v1"


def test_config_varsayilanlari_graphql_ve_resmi_rest_tabani() -> None:
    cfg = Config()
    assert cfg.api == "graphql"
    assert cfg.rest_url == "https://api.xurrent.com/v1"
    assert cfg.mcp_api_key == ""


# ══════════════════════════════════ 2. whoami — iki istekli akis


def test_whoami_iki_istek_gonderir_once_me_sonra_account(yapilandirma) -> None:
    """GraphQL 1 sorguda dondurur; REST'te /me + /account AYRI isteklerdir.
    Bu fark dersin kendisidir (docs/16) — adaptor ikisini de gondermek zorunda."""
    yollar: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        yollar.append(request.url.path)
        if request.url.path.endswith("/me"):
            return httpx.Response(200, json=_ME_REST)
        return httpx.Response(
            200,
            json={"id": "ornek-bt", "name": "Ornek A.S.", "directory": False},
            headers={"x-ratelimit-limit": "20", "x-ratelimit-remaining": "18"},
        )

    adapter = _rest_adapter(yapilandirma, handler)
    person, account, rate = adapter.whoami()
    assert yollar == ["/v1/me", "/v1/account"]
    # snake_case -> camelCase normalizasyonu
    assert person.primaryEmail == "ayse@ornek.com"
    assert person.jobTitle == "BT Uzmani"
    assert person.timeZone == "Europe/Istanbul"
    assert account.id == "ornek-bt" and account.directory is False
    # x-ratelimit-* basliklari GraphQL yolundaki gibi yakalanir
    assert rate is not None and rate.limit == 20 and rate.remaining == 18


def test_resolve_person_id_me_degerini_gercek_id_ye_cozer(yapilandirma) -> None:
    """REST sorgularina '$me' GONDERILMEZ; once /me ile gercek id alinir."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/me"):
            return httpx.Response(200, json=_ME_REST)
        return httpx.Response(200, json={"id": "ornek-bt"})

    adapter = _rest_adapter(yapilandirma, handler)
    assert adapter.resolve_person_id("$me") == "P1"
    assert adapter.resolve_person_id("P42") == "P42"


# ══════════════════════════════════ 3. okuma uc noktalari — parametre eslemesi


def test_find_person_primary_email_parametresiyle_sorgular(yapilandirma) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/people"
        assert request.url.params["primary_email"] == "ayse@ornek.com"
        return httpx.Response(200, json=[_ME_REST])

    adapter = _rest_adapter(yapilandirma, handler)
    kisiler = adapter.find_person("ayse@ornek.com")
    assert len(kisiler) == 1 and kisiler[0].id == "P1"


def test_acik_isler_request_member_task_assignee_parametresi(yapilandirma) -> None:
    """TUZAK GraphQL'dekiyle ayni: Request'te 'member', Task'ta 'assignee'.
    Karistirmak SESSIZ bos sonuc uretir — parametre adi birebir dogrulanir."""
    gorulen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/requests":
            gorulen["requests"] = request.url.params["member"]
            return httpx.Response(200, json=[{
                "id": "R1", "subject": "VPN", "status": "in_progress",
                "next_target_at": "2026-08-04T17:00:00+03:00",
                "updated_at": "2026-08-03T12:00:00+03:00",
                "team": {"name": "BT"}, "member": {"id": "P1", "name": "Ayse"},
                "time_spent": 60, "source_display_id": "70248",
            }])
        gorulen["tasks"] = request.url.params["assignee"]
        return httpx.Response(200, json=[{
            "id": "T1", "subject": "Yama", "status": "assigned",
            "completion_target_at": "2026-08-05T17:00:00+03:00",
            "updated_at": "2026-08-03T12:00:00+03:00",
            "team": {"name": "BT"}, "member": {"id": "P1", "name": "Ayse"},
            "workflow": {"id": "W1", "subject": "Donanim yenileme"},
            "time_spent": 0, "source_display_id": "4388",
        }])

    adapter = _rest_adapter(yapilandirma, handler)
    reqs = adapter.list_open_requests("P1", 25, None, "all")
    tasks = adapter.list_open_tasks("P1", 25, None, "all")
    assert gorulen == {"requests": "P1", "tasks": "P1"}
    assert reqs.totalCount == 1 and tasks.totalCount == 1
    # snake_case -> WorkItem normalizasyonu
    r = reqs.nodes[0]
    assert r.displayId == "70248"  # source_display_id
    assert r.targetAt == "2026-08-04T17:00:00+03:00"  # next_target_at
    assert r.team == "BT" and r.member == "Ayse"
    t = tasks.nodes[0]
    assert t.displayId == "4388"
    assert t.targetAt == "2026-08-05T17:00:00+03:00"  # completion_target_at
    assert t.parentLabel == "Donanim yenileme"  # workflow.subject


def test_baglam_uc_ayri_get_ile_kurulur_ve_snake_case_normallesir(yapilandirma) -> None:
    """GraphQL tek sorgu; REST'te /timesheet_settings + /effort_classes +
    /time_allocations UC istektir. disabled eleme CLIENT tarafinda kalir."""
    yollar: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        yollar.append(request.url.path)
        if request.url.path == "/v1/timesheet_settings":
            return httpx.Response(200, json=[{
                "id": "TS1", "name": "Varsayilan", "unit": "hours_and_minutes",
                "workday": 480, "workweek": 2400,
                "time_increment": 30, "percentage_increment": None,
                "allow_workday_overtime": False, "allow_workweek_overtime": True,
                "allocation_time_tracking": True, "assignment_time_tracking": True,
                "require_note": False, "require_time_entry_description": False,
                "request_effort_class": {"id": "EC1", "name": "Standart"},
                "task_effort_class": {"id": "EC2", "name": "Mesai disi"},
                "project_task_effort_class": {"id": "EC1", "name": "Standart"},
                "problem_effort_class": {"id": "EC1", "name": "Standart"},
                "time_allocation_effort_class": {"id": "EC1", "name": "Standart"},
            }])
        if request.url.path == "/v1/effort_classes":
            return httpx.Response(200, json=[
                {"id": "EC1", "name": "Standart", "position": 1,
                 "cost_multiplier": 1.0, "disabled": False},
                {"id": "EC2", "name": "Mesai disi", "position": 2,
                 "cost_multiplier": 1.5, "disabled": False},
                {"id": "EC9", "name": "Eski", "position": 9,
                 "cost_multiplier": 1.0, "disabled": True},
            ])
        return httpx.Response(200, json=[
            {"id": "TA1", "name": "Ic toplantilar", "group": "Genel",
             "description_required": False},
            {"id": "TA2", "name": "Egitim", "group": "Genel",
             "description_required": True},
        ])

    adapter = _rest_adapter(yapilandirma, handler)
    ctx = adapter.time_tracking_context("P1")
    assert yollar == ["/v1/timesheet_settings", "/v1/effort_classes", "/v1/time_allocations"]
    assert ctx.timeIncrement == 30  # time_increment
    assert ctx.allowWorkdayOvertime is False  # allow_workday_overtime
    # disabled olan CLIENT tarafinda elendi: 3 kayittan 2'si kaldi
    assert [e.id for e in ctx.effortClasses] == ["EC1", "EC2"]
    assert ctx.effortClasses[0].costMultiplier == 1.0  # cost_multiplier
    assert ctx.defaults.requestEffortClassId == "EC1"  # request_effort_class.id
    assert ctx.defaults.taskEffortClassId == "EC2"
    assert ctx.timeAllocations[1].descriptionRequired is True  # description_required
    # Cache: ikinci cagri YENI istek uretmez
    adapter.time_tracking_context("P1")
    assert len(yollar) == 3


def test_list_time_entries_parametre_eslemesi_ve_kayit_normalizasyonu(
    yapilandirma,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/time_entries"
        p = request.url.params
        assert p["person"] == "P1"
        assert p["date_from"] == "2026-08-01"
        assert p["date_to"] == "2026-08-03"
        assert p["sourceID"] == "xmcp-abc123"
        kayit = dict(_ENTRY_REST)
        kayit["assignment"] = {"type": "Request", "id": "R1"}
        return httpx.Response(200, json=[kayit])

    adapter = _rest_adapter(yapilandirma, handler)
    rows = adapter.list_time_entries("P1", "2026-08-01", "2026-08-03", "xmcp-abc123", 25)
    assert len(rows) == 1
    r = rows[0]
    # TimeEntryRecord: camelCase ic sozlesme
    assert r["startedAt"] == "2026-08-03T09:00:00+03:00"  # started_at
    assert r["timeSpent"] == 30  # time_spent
    assert r["sourceID"] == "xmcp-abc123"  # istisna: oldugu gibi
    assert r["effortClass"] == {"id": "EC1", "name": "Standart"}  # effort_class
    assert r["assignment"] == {"type": "Request", "id": "R1", "displayId": None}


def test_dedup_geri_okumasi_sourceID_parametresiyle_sorgular(yapilandirma) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/time_entries"
        assert request.url.params["sourceID"] == "xmcp-abc123"
        return httpx.Response(200, json=[_ENTRY_REST])

    adapter = _rest_adapter(yapilandirma, handler)
    bulunan = adapter.find_time_entry_by_source_id("xmcp-abc123")
    assert bulunan is not None and bulunan["id"] == "TE1"
    assert adapter.find_time_entry_by_source_id("") is None  # istek YOK


# ══════════════════════════════════ 4. yazma — govde eslemesi + 201


def test_create_snake_case_govde_gonderir_201_bekler(yapilandirma) -> None:
    """TimeEntryCreateInput (camelCase) -> POST /time_entries (snake_case).
    sourceID ISTISNADIR ve oldugu gibi gider; clientMutationId GraphQL'e
    ozgudur, REST govdesine SIZMAZ."""
    gorulen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            gorulen.update(json.loads(request.content.decode("utf-8")))
            return httpx.Response(201, json=_ENTRY_REST)
        return httpx.Response(200, json=[])  # yazma-oncesi dedup okumasi

    adapter = _rest_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "timeEntryCreate",
        "input": {
            "timeSpent": 30,
            "date": "2026-08-03",
            "startedAt": "2026-08-03T09:00:00+03:00",
            "timeAllocationId": "TA1",
            "effortClassId": "EC1",
            "description": "test kalemi",
            "source": "xurrent-mcp",
            "sourceID": "xmcp-abc123",
            "clientMutationId": "xmcp-abc123",
        },
    })
    assert gorulen == {
        "time_spent": 30,
        "date": "2026-08-03",
        "started_at": "2026-08-03T09:00:00+03:00",
        "time_allocation_id": "TA1",
        "effort_class_id": "EC1",
        "description": "test kalemi",
        "source": "xurrent-mcp",
        "sourceID": "xmcp-abc123",
    }
    assert sonuc["errors"] == []
    assert sonuc["timeEntry"]["id"] == "TE1"
    assert sonuc["timeEntry"]["timeSpent"] == 30  # normalize edildi


def test_parent_update_patch_requests_yoluna_gider(yapilandirma) -> None:
    """Yol B'nin REST karsiligi: PATCH /requests/:id. Yanit PARENT'tir,
    olusan TimeEntry DEGIL — two_step 2. adimi kaydi ayrica bulmak zorunda."""
    gorulen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PATCH"
        assert request.url.path == "/v1/requests/R1"
        gorulen.update(json.loads(request.content.decode("utf-8")))
        return httpx.Response(200, json={
            "id": "R1", "subject": "VPN", "status": "in_progress",
            "time_spent": 90, "source_display_id": "70248",
        })

    adapter = _rest_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "requestUpdate",
        "input": {
            "id": "R1",
            "timeSpent": 30,
            "timeSpentEffortClassId": "EC1",
            "timeEntryDescription": "VPN bakim",
            "clientMutationId": "xmcp-abc123",
        },
    })
    assert gorulen == {
        "time_spent": 30,
        "time_spent_effort_class_id": "EC1",
        "time_entry_description": "VPN bakim",
    }
    assert sonuc["errors"] == []
    assert sonuc["timeEntry"] is None  # parent doner, entry DEGIL
    assert sonuc["parent"]["id"] == "R1"


def test_time_entry_update_patch_ve_govde_eslemesi(yapilandirma) -> None:
    """two_step 2. adim: PATCH /time_entries/:id. Govdede assignment YOKTUR —
    ticket bagi bozulAMAZ; date/started_at/person_id snake_case gider."""
    gorulen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "PATCH"
        assert request.url.path == "/v1/time_entries/TE1"
        gorulen.update(json.loads(request.content.decode("utf-8")))
        kayit = dict(_ENTRY_REST)
        kayit["date"] = "2026-08-02"
        return httpx.Response(200, json=kayit)

    adapter = _rest_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "timeEntryUpdate",
        "input": {
            "id": "TE1",
            "date": "2026-08-02",
            "startedAt": "2026-08-02T14:00:00+03:00",
            "personId": "P2",
            "clientMutationId": "xurrent-mcp:fix",
        },
    })
    assert gorulen == {
        "date": "2026-08-02",
        "started_at": "2026-08-02T14:00:00+03:00",
        "person_id": "P2",
    }
    assert sonuc["errors"] == []
    assert sonuc["timeEntry"]["date"] == "2026-08-02"


def test_find_latest_time_entry_id_bugunun_kayitlarini_sorar(yapilandirma) -> None:
    """two_step 2. adiminin REST dayanagi: GET /time_entries?person&date=bugun,
    en yeni kayit ILK siradadir."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/time_entries"
        assert request.url.params["person"] == "P1"
        assert request.url.params["date"] == SABIT_BUGUN.isoformat()
        return httpx.Response(200, json=[{"id": "TE-yeni"}, {"id": "TE-eski"}])

    adapter = _rest_adapter(yapilandirma, handler)
    assert adapter.find_latest_time_entry_id("P1") == "TE-yeni"


# ══════════════════════════════════ 5. 422 — is kurali reddi


def test_422_siniflandirmasi_kesin_reddedildi_retry_yok() -> None:
    assert classify(XurrentRestValidationError("x", errors=[])) is None


def test_422_errors_dizisine_normallesir_exception_degil_retry_yok(
    yapilandirma, capsys
) -> None:
    """GraphQL'de is kurali reddi '200 + payload.errors'tur; REST'te ayni red
    'HTTP 422 + errors govdesi'dir. Adaptor ikisini AYNI errors[] sekline
    indirger: exception yok, retry yok, bulk akisi surebilir."""
    sayac = {"post": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            sayac["post"] += 1
            return httpx.Response(422, json={"errors": [{
                "message": "timeSpent (45) timeIncrement degerinin (30) kati degil.",
                "attribute": "time_spent",
            }]})
        return httpx.Response(200, json=[])

    adapter = _rest_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "timeEntryCreate",
        "input": {"timeSpent": 45, "sourceID": "xmcp-kirk5"},
    })
    assert sayac["post"] == 1  # kesin-reddedildi: TEK deneme
    assert sonuc["timeEntry"] is None
    assert sonuc["errors"] == [{
        "message": "timeSpent (45) timeIncrement degerinin (30) kati degil.",
        "path": ["time_spent"],
    }]
    assert _retry_satirlari(capsys) == []


def test_422_parent_update_te_de_ayni_sekilde_normallesir(yapilandirma) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"errors": [{
            "message": "Gunluk toplam workday sinirini asiyor.",
            "attribute": "time_spent",
        }]})

    adapter = _rest_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "requestUpdate", "input": {"id": "R1", "timeSpent": 480},
    })
    assert sonuc["errors"][0]["path"] == ["time_spent"]
    assert "workday" in sonuc["errors"][0]["message"]


# ══════════════════════════════════ 6. operasyon siniflari REST'te


def test_query_429_retry_ile_toparlar(yapilandirma, capsys) -> None:
    sayac = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sayac["n"] += 1
        if sayac["n"] == 1:
            return httpx.Response(
                429, json={"errors": [{"message": "rate limit"}]},
                headers={"retry-after": "0"},
            )
        return httpx.Response(200, json=[_ME_REST])

    adapter = _rest_adapter(yapilandirma, handler)
    kisiler = adapter.find_person("ayse@ornek.com")
    assert sayac["n"] == 2 and len(kisiler) == 1
    izler = _retry_satirlari(capsys)
    assert len(izler) == 1 and "reason=429" in izler[0] and "op=query" in izler[0]


def test_guarded_create_5xx_te_once_dedup_okur_hit_ise_retry_yok(
    yapilandirma, capsys
) -> None:
    """POST /time_entries = guarded_create. 5xx sonrasi sourceID geri-okumasi
    kaydi bulursa mutation TEKRARLANMAZ; mevcut kayit deduped=True ile doner."""
    sayac = {"post": 0, "get": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            sayac["post"] += 1
            return httpx.Response(500, json={"errors": [{"message": "kaos"}]})
        sayac["get"] += 1
        assert request.url.params["sourceID"] == "xmcp-abc123"
        return httpx.Response(200, json=[_ENTRY_REST])

    adapter = _rest_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "timeEntryCreate",
        "input": {"timeSpent": 30, "sourceID": "xmcp-abc123"},
    })
    assert sayac["post"] == 1  # kor retry YOK
    assert sonuc["errors"] == []
    assert sonuc["timeEntry"]["id"] == "TE1"
    assert sonuc.get("deduped") is True
    err = capsys.readouterr().err
    assert "[dedup] op=timeEntryCreate sourceID=xmcp-abc123 hit=true" in err


def test_parent_update_5xx_te_asla_retry_edilmez_belirsizligi_soyler(
    yapilandirma, capsys
) -> None:
    """PATCH /requests/:id = no_retry: time_spent ARTIMLIDIR, belirsiz hatada
    tekrar cift sayar. Hata metni GraphQL yolundakiyle AYNI derstir."""
    sayac = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sayac["n"] += 1
        return httpx.Response(500, json={"errors": [{"message": "kaos"}]})

    adapter = _rest_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "requestUpdate", "input": {"id": "R1", "timeSpent": 30},
    })
    assert sayac["n"] == 1
    mesaj = sonuc["errors"][0]["message"]
    assert "YAZILMIS DA OLABILIR" in mesaj
    assert "kontrol edin" in mesaj
    assert _retry_satirlari(capsys) == []


def test_time_entry_update_5xx_te_retry_edilir(yapilandirma, capsys) -> None:
    """PATCH /time_entries/:id = idempotent_update: mutlak SET, tekrar zararsiz."""
    sayac = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sayac["n"] += 1
        if sayac["n"] == 1:
            return httpx.Response(502, json={"errors": [{"message": "kaos"}]})
        return httpx.Response(200, json=_ENTRY_REST)

    adapter = _rest_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "timeEntryUpdate", "input": {"id": "TE1", "date": "2026-08-02"},
    })
    assert sayac["n"] == 2
    assert sonuc["errors"] == []
    izler = _retry_satirlari(capsys)
    assert len(izler) == 1 and "op=timeEntryUpdate" in izler[0] and "reason=5xx" in izler[0]


def test_transport_hatasi_exception_olarak_sizmaz_errors_olur(yapilandirma) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("baglanti koptu")

    adapter = _rest_adapter(yapilandirma, handler, retry_max_attempts=1)
    sonuc = adapter.run_mutation({
        "path": "timeEntryUpdate", "input": {"id": "TE1", "date": "2026-08-02"},
    })
    assert sonuc["timeEntry"] is None
    assert "timeEntryUpdate basarisiz" in sonuc["errors"][0]["message"]
