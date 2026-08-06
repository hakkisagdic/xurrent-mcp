"""Guvenilirlik katmani birim testleri — contract/reliability.md'nin kaniti.

CALISTIRMA: uv run pytest tests/test_reliability.py -q

Kurallar conftest.py'dekiyle ayni: I/O YOK (httpx.MockTransport bellek icidir,
aga cikmaz), zaman enjekte edilir (retry beklemeleri sleep=noop ile veya
base/cap=0 ile sifirlanir), test adi = iddia.

Kapsanan iddialar:
  1. Hata SINIFLANDIRMASI (§1): 429 / 5xx / ag / GraphQL / 4xx ayrimi.
  2. Operasyon SINIFLARI (§2): parent update belirsiz hatada ASLA retry
     edilmez; 429 HER sinifta retry edilir; guarded_create once dedup okur.
  3. Bekleme (§3): tam jitter tavani + Retry-After'in EN AZ garantisi.
  4. Iz bicimi (§6): [retry] ve [dedup] satirlari BIREBIR sozlesme bicimidir.
  5. Yazma oncesi dedup (§5): tekil + bulk, mock adapter uzerinden.
  6. Sema guncellemeleri: WriteResult.deduped, bulk status enum'u ve
     summary.deduped sozlesmeyle ayni.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from xurrent_mcp.core.schemas import (  # noqa: E402
    CREATE_TIME_ENTRIES_BULK_OUTPUT,
    CREATE_TIME_ENTRY_OUTPUT,
)
from xurrent_mcp.tools.runtime import Runtime  # noqa: E402
from xurrent_mcp.tools.write_tools import (  # noqa: E402
    xurrent_create_time_entries_bulk,
    xurrent_create_time_entry,
)
from xurrent_mcp.xurrent.mock import MockXurrentAdapter  # noqa: E402
from xurrent_mcp.xurrent.retry import (  # noqa: E402
    OP_CLASS_BY_PATH,
    FullJitterWait,
    XurrentGraphQLError,
    XurrentHttpError,
    XurrentTransportError,
    classify,
    execute_with_retry,
)

REPO_KOKU = Path(__file__).resolve().parents[3]
CONTRACT = json.loads((REPO_KOKU / "contract" / "tools.json").read_text(encoding="utf-8"))

_NOOP_SLEEP = lambda _s: None  # noqa: E731 — testler GERCEKTEN beklemez


def _retry_satirlari(capsys: pytest.CaptureFixture) -> list[str]:
    return [l for l in capsys.readouterr().err.splitlines() if l.startswith("[retry]")]


# ═══════════════════════════════════════════════ 1. hata siniflandirmasi (§1)


def test_429_kesin_islenmedi_sinifidir() -> None:
    assert classify(XurrentHttpError("x", status=429, retry_after=1.0)) == "429"


def test_5xx_belirsiz_sinifidir() -> None:
    assert classify(XurrentHttpError("x", status=500)) == "5xx"
    assert classify(XurrentHttpError("x", status=503)) == "5xx"


def test_ag_hatasi_belirsiz_sinifidir() -> None:
    assert classify(XurrentTransportError("baglanti koptu")) == "network"


def test_429_haric_4xx_asla_retry_edilmez() -> None:
    # kesin-reddedildi: sunucu istegi ANLADI ve reddetti. Tekrar = ayni red.
    assert classify(XurrentHttpError("x", status=400)) is None
    assert classify(XurrentHttpError("x", status=401)) is None
    assert classify(XurrentHttpError("x", status=422)) is None


def test_graphql_top_level_hata_asla_retry_edilmez() -> None:
    assert classify(XurrentGraphQLError("GraphQL hatasi: sema")) is None


def test_operasyon_sinifi_haritasi_sozlesmeyle_ayni() -> None:
    """reliability.md §2 — path -> sinif eslemesi birebir."""
    assert OP_CLASS_BY_PATH == {
        "timeEntryCreate": "guarded_create",
        "timeEntryUpdate": "idempotent_update",
        "requestUpdate": "no_retry",
        "taskUpdate": "no_retry",
        "projectTaskUpdate": "no_retry",
        "problemUpdate": "no_retry",
    }


# ═══════════════════════════════════════════════ 2. operasyon siniflari (§2)


def _fail_n_then(n: int, exc: Exception, result: object = "ok"):
    """Ilk n cagrida exc firlatan, sonra result donen sayacli fonksiyon."""
    state = {"calls": 0}

    def fn():
        state["calls"] += 1
        if state["calls"] <= n:
            raise exc
        return result

    return fn, state


def test_429_her_sinifta_retry_edilir_parent_update_dahil(capsys) -> None:
    """429 kesin-islenmedi'dir: rate limiter mutation'i CALISTIRMADAN kesti.
    no_retry sinifinda bile tekrar guvenlidir — cift sayim OLUSAMAZ."""
    fn, state = _fail_n_then(1, XurrentHttpError("429", status=429))
    sonuc = execute_with_retry(
        fn, op="requestUpdate", op_class="no_retry",
        max_attempts=5, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
    )
    assert sonuc == "ok"
    assert state["calls"] == 2
    izler = _retry_satirlari(capsys)
    assert len(izler) == 1 and "reason=429" in izler[0]


def test_parent_update_5xx_de_retry_edilmez(capsys) -> None:
    """Dersin kalbi: timeSpent ARTIMLIDIR. Belirsiz hatada kor tekrar = cift
    sayim. no_retry sinifi 5xx'te TEK deneme yapar ve hatayi yukari verir."""
    fn, state = _fail_n_then(99, XurrentHttpError("500", status=500))
    with pytest.raises(XurrentHttpError):
        execute_with_retry(
            fn, op="requestUpdate", op_class="no_retry",
            max_attempts=5, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
        )
    assert state["calls"] == 1  # ikinci deneme YOK
    assert _retry_satirlari(capsys) == []


def test_query_ag_hatasinda_retry_edilir(capsys) -> None:
    fn, state = _fail_n_then(2, XurrentTransportError("baglanti koptu"))
    assert execute_with_retry(
        fn, op="query", op_class="query",
        max_attempts=5, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
    ) == "ok"
    assert state["calls"] == 3
    assert all("reason=network" in l for l in _retry_satirlari(capsys))


def test_idempotent_update_5xx_te_retry_edilir() -> None:
    """timeEntryUpdate mutlak SET'tir — tekrari zararsizdir."""
    fn, state = _fail_n_then(1, XurrentHttpError("502", status=502))
    assert execute_with_retry(
        fn, op="timeEntryUpdate", op_class="idempotent_update",
        max_attempts=5, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
    ) == "ok"
    assert state["calls"] == 2


def test_attempts_1_retry_i_tamamen_kapatir() -> None:
    fn, state = _fail_n_then(99, XurrentHttpError("429", status=429))
    with pytest.raises(XurrentHttpError):
        execute_with_retry(
            fn, op="query", op_class="query",
            max_attempts=1, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
        )
    assert state["calls"] == 1


def test_guarded_create_belirsiz_hatada_once_dedup_okur_hit_ise_retry_yok() -> None:
    """Kor retry cift kayit yazabilir. Geri-okuma 'yazilmis' derse mevcut
    kayit BASARI olarak doner ve ikinci mutation HIC gonderilmez."""
    fn, state = _fail_n_then(99, XurrentHttpError("500", status=500))
    bulundu = {"timeEntry": {"id": "TE-var"}}
    sonuc = execute_with_retry(
        fn, op="timeEntryCreate", op_class="guarded_create",
        max_attempts=5, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
        on_uncertain=lambda: bulundu,
    )
    assert sonuc is bulundu
    assert state["calls"] == 1  # mutation yalnizca 1 kez denendi


def test_guarded_create_dedup_miss_ise_retry_surer() -> None:
    fn, state = _fail_n_then(99, XurrentHttpError("500", status=500))
    okuma = {"calls": 0}

    def _miss():
        okuma["calls"] += 1
        return None

    with pytest.raises(XurrentHttpError):
        execute_with_retry(
            fn, op="timeEntryCreate", op_class="guarded_create",
            max_attempts=3, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
            on_uncertain=_miss,
        )
    assert state["calls"] == 3
    # HER belirsiz hatadan sonra soruldu — son denemeden sonra da.
    assert okuma["calls"] == 3


# ═══════════════════════════════════════════════ 3. bekleme politikasi (§3)


def _sahte_state(attempt: int, exc: Exception) -> SimpleNamespace:
    return SimpleNamespace(
        attempt_number=attempt,
        outcome=SimpleNamespace(exception=lambda: exc),
    )


def test_retry_after_beklemenin_en_az_garantisidir() -> None:
    """Sunucu 'Retry-After: 7' diyorsa jitter ne cekerse ceksin bekleme
    7 saniyeden KISA olamaz — erken donmek ayni 429'u yemektir."""
    bekle = FullJitterWait(base_ms=1, cap_ms=2)  # jitter tavani ~2 ms
    exc = XurrentHttpError("429", status=429, retry_after=7.0)
    for k in (1, 2, 3):
        assert bekle(_sahte_state(k, exc)) >= 7.0


def test_tam_jitter_tavana_saygilidir() -> None:
    """bekleme_k = rastgele(0, min(CAP, BASE·2^(k-1))) — CAP asilamaz."""
    bekle = FullJitterWait(base_ms=500, cap_ms=8000)
    exc = XurrentHttpError("500", status=500)  # Retry-After yok
    for k in (1, 5, 10):
        w = bekle(_sahte_state(k, exc))
        assert 0.0 <= w <= 8.0
    # k=2'de tavan henuz CAP degil BASE·2'dir (1000 ms).
    assert all(bekle(_sahte_state(2, exc)) <= 1.0 for _ in range(20))


# ═══════════════════════════════════════════════ 4. iz bicimi (§6)


def test_retry_izi_bicimi_birebir_sozlesmedeki_gibi(capsys) -> None:
    """[retry] op=<path|query> attempt=<k>/<max> reason=<...> waitMs=<tamsayi>
    Senaryo koşucusu bu satirlari SAYARAK dogrular; bicim pazarlik konusu degil."""
    fn, _ = _fail_n_then(1, XurrentHttpError("429", status=429))
    execute_with_retry(
        fn, op="timeEntryCreate", op_class="guarded_create",
        max_attempts=5, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
    )
    izler = _retry_satirlari(capsys)
    assert len(izler) == 1
    assert re.fullmatch(
        r"\[retry\] op=timeEntryCreate attempt=1/5 reason=429 waitMs=\d+", izler[0]
    )


def test_retry_izinde_attempt_basarisiz_olan_denemedir(capsys) -> None:
    fn, _ = _fail_n_then(2, XurrentHttpError("500", status=500))
    execute_with_retry(
        fn, op="query", op_class="query",
        max_attempts=4, base_ms=0, cap_ms=0, sleep=_NOOP_SLEEP,
    )
    izler = _retry_satirlari(capsys)
    assert [re.search(r"attempt=(\d)/4", l).group(1) for l in izler] == ["1", "2"]
    assert all("reason=5xx" in l for l in izler)


# ═══════════════════════════════════ 5. live adapter — transport + run_mutation


def _live_adapter(yapilandirma, handler, **cfg_kw):
    from xurrent_mcp.xurrent.live import LiveXurrentAdapter

    cfg = yapilandirma(
        mode="live", token="test-token", account="ornek-bt",
        min_request_gap_ms=0, retry_base_ms=0, retry_cap_ms=0, **cfg_kw,
    )
    adapter = LiveXurrentAdapter(cfg)
    # Ag YOK: MockTransport istekleri bellekte cevaplar.
    adapter._client = httpx.Client(
        transport=httpx.MockTransport(handler), base_url="https://sahte.local"
    )
    return adapter


def test_transport_429_retry_after_basligini_tasir(yapilandirma) -> None:
    """Eski kod TUM >=400'leri tek tip hataya indirgiyordu; politika status ve
    Retry-After gormeden karar veremezdi. Yeni tip ikisini de tasir."""
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429, json={"errors": [{"message": "rate limit"}]},
            headers={"retry-after": "3"},
        )

    adapter = _live_adapter(yapilandirma, handler, retry_max_attempts=1)
    with pytest.raises(XurrentHttpError) as info:
        adapter.execute("query Q { me { id } }")
    assert info.value.status == 429
    assert info.value.retry_after == 3.0


def test_query_429_sonrasi_retry_ile_basarir(yapilandirma, capsys) -> None:
    sayac = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sayac["n"] += 1
        if sayac["n"] == 1:
            return httpx.Response(429, json={"errors": [{"message": "kaos"}]})
        return httpx.Response(200, json={"data": {"me": {"id": "P1"}}})

    adapter = _live_adapter(yapilandirma, handler)
    data = adapter.execute("query Q { me { id } }")
    assert data == {"me": {"id": "P1"}}
    assert sayac["n"] == 2
    izler = _retry_satirlari(capsys)
    assert len(izler) == 1 and izler[0].startswith("[retry] op=query attempt=1/5 reason=429")


def test_graphql_top_level_hata_retry_edilmeden_firlatilir(yapilandirma) -> None:
    sayac = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sayac["n"] += 1
        return httpx.Response(200, json={"errors": [{"message": "sema hatasi"}]})

    adapter = _live_adapter(yapilandirma, handler)
    with pytest.raises(XurrentGraphQLError):
        adapter.execute("query Q { bilinmeyen }")
    assert sayac["n"] == 1


def test_guarded_create_dedup_hit_mevcut_kaydi_basari_olarak_doner(
    yapilandirma, capsys
) -> None:
    """5xx sonrasi geri-okuma kaydi bulursa: mutation TEKRARLANMAZ, mevcut
    kayit doner ve [dedup] hit=true izi yazilir."""
    sayac = {"create": 0, "query": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        if "timeEntryCreate" in body["query"]:
            sayac["create"] += 1
            return httpx.Response(500, json={"errors": [{"message": "kaos"}]})
        sayac["query"] += 1
        assert body["variables"] == {"sourceID": "xmcp-abc123"}
        return httpx.Response(200, json={"data": {"timeEntries": {"nodes": [
            {"id": "TE-var", "timeSpent": 30, "sourceID": "xmcp-abc123"}
        ]}}})

    adapter = _live_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "timeEntryCreate",
        "input": {"timeSpent": 30, "sourceID": "xmcp-abc123"},
    })
    assert sonuc["errors"] == []
    assert sonuc["timeEntry"]["id"] == "TE-var"
    assert sonuc.get("deduped") is True
    assert sayac["create"] == 1  # kor retry YOK
    err = capsys.readouterr().err
    assert "[dedup] op=timeEntryCreate sourceID=xmcp-abc123 hit=true" in err


def test_parent_update_5xx_hatasi_kullaniciya_belirsizligi_soyler(
    yapilandirma, capsys
) -> None:
    """no_retry sinifinin hata metni 'kayit yazilmis da olabilir' demek ve
    kullaniciyi ticket'i kontrol etmeye yonlendirmek ZORUNDADIR."""
    sayac = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        sayac["n"] += 1
        return httpx.Response(500, json={"errors": [{"message": "kaos"}]})

    adapter = _live_adapter(yapilandirma, handler)
    sonuc = adapter.run_mutation({
        "path": "requestUpdate",
        "input": {"id": "REQ1", "timeSpent": 30},
    })
    assert sayac["n"] == 1  # belirsiz hatada parent update TEKRARLANMADI
    assert sonuc["timeEntry"] is None
    mesaj = sonuc["errors"][0]["message"]
    assert "YAZILMIS DA OLABILIR" in mesaj
    assert "kontrol edin" in mesaj
    assert _retry_satirlari(capsys) == []


# ═══════════════════════════════════ 6. yazma oncesi dedup (§5) — mock adapter


@pytest.fixture
def mock_rt(yapilandirma) -> Runtime:
    # confirm_policy="open": onay kanali olmayan dogrudan cagrida politika
    # kolu susar; dedup testinin konusu onay degil.
    cfg = yapilandirma(confirm_policy="open")
    return Runtime(config=cfg, adapter=MockXurrentAdapter(cfg))


_ALLOC_ARGS = {
    "targetType": "time_allocation",
    "targetId": "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
    "minutes": 30,
    "description": "dedup birim testi",
    "dryRun": False,
}


def test_ayni_yazma_ikinci_kez_deduped_doner(mock_rt, capsys) -> None:
    ilk = xurrent_create_time_entry(mock_rt, dict(_ALLOC_ARGS))
    assert ilk["errors"] == [] and ilk["deduped"] is False
    ilk_id = ilk["timeEntry"]["id"]

    ikinci = xurrent_create_time_entry(mock_rt, dict(_ALLOC_ARGS))
    assert ikinci["errors"] == []
    assert ikinci["deduped"] is True
    assert ikinci["timeEntry"]["id"] == ilk_id  # MEVCUT kayit dondu
    assert any("dedup" in w for w in ikinci["warnings"])

    err = capsys.readouterr().err
    assert "[dedup] op=timeEntryCreate sourceID=" in err
    assert "hit=false" in err and "hit=true" in err


def test_dedup_izi_bicimi_birebir(mock_rt, capsys) -> None:
    xurrent_create_time_entry(mock_rt, dict(_ALLOC_ARGS))
    satirlar = [l for l in capsys.readouterr().err.splitlines() if l.startswith("[dedup]")]
    assert len(satirlar) == 1
    assert re.fullmatch(
        r"\[dedup\] op=timeEntryCreate sourceID=\S+ hit=false", satirlar[0]
    )


def test_two_step_plani_dedup_almaz(mock_rt, capsys) -> None:
    """Asimetri DERSIN KENDISIDIR: sourceID yalnizca Yol A'da yazilabilir.
    two_step'in ilk adimi parent update'tir -> dedup korumasi YOKTUR ve ayni
    komut iki kez calistirilirsa IKI kayit olusur."""
    args = {
        "targetType": "request",
        "targetId": "TW9jay9SZXF1ZXN0LzcwMjQ4",
        "minutes": 30,
        "description": "two step dedup yok",
        "backdateStrategy": "two_step",
        "date": "2026-08-02",  # SABIT_DUN — two_step'i tetikleyen T-1
        "dryRun": False,
    }
    ilk = xurrent_create_time_entry(mock_rt, dict(args))
    ikinci = xurrent_create_time_entry(mock_rt, dict(args))
    assert ilk["errors"] == [] and ikinci["errors"] == []
    assert ikinci["deduped"] is False
    assert ikinci["timeEntry"]["id"] != ilk["timeEntry"]["id"]  # cift kayit!
    assert "[dedup]" not in capsys.readouterr().err


def test_bulk_tekrar_calistirma_eksigi_tamamlar_cifti_onler(mock_rt) -> None:
    """reliability.md §5 — bulk atomik degildir; kurtarma yolu 'ayni komutu
    tekrar calistir'dir ve guvenligi dedup'a dayanir."""
    entries = [
        {**_ALLOC_ARGS, "description": f"bulk kalem {i}"} for i in range(1, 4)
    ]
    for e in entries:
        e.pop("dryRun")

    r1 = xurrent_create_time_entries_bulk(
        mock_rt, {"entries": entries, "dryRun": False, "stopOnError": False}
    )
    assert r1["summary"]["created"] == 3
    assert r1["summary"]["deduped"] == 0  # alan 0 iken de MEVCUT
    assert r1["summary"]["totalMinutes"] == 90

    r2 = xurrent_create_time_entries_bulk(
        mock_rt, {"entries": entries, "dryRun": False, "stopOnError": False}
    )
    assert r2["summary"]["created"] == 0
    assert r2["summary"]["deduped"] == 3
    assert [row["status"] for row in r2["results"]] == ["deduped"] * 3
    assert all(row["timeEntryId"] for row in r2["results"])
    # Bu calistirmada YAZILAN dakika yoktur.
    assert r2["summary"]["totalMinutes"] == 0


def test_mock_adapter_source_id_geri_okumasi(mock_rt) -> None:
    adapter = mock_rt.adapter
    assert adapter.find_time_entry_by_source_id("olmayan-sid") is None
    sonuc = xurrent_create_time_entry(mock_rt, dict(_ALLOC_ARGS))
    sid = sonuc["planned"][0]["input"]["sourceID"]
    bulunan = adapter.find_time_entry_by_source_id(sid)
    assert bulunan is not None and bulunan["id"] == sonuc["timeEntry"]["id"]


# ═══════════════════════════════════════════════ 7. sema guncellemeleri


def test_write_result_semasinda_deduped_var() -> None:
    ozellik = CREATE_TIME_ENTRY_OUTPUT["properties"]["deduped"]
    assert ozellik["type"] == "boolean"
    # Opsiyoneldir: required listesine GIRMEZ.
    assert "deduped" not in CREATE_TIME_ENTRY_OUTPUT["required"]


def test_bulk_semasinda_deduped_status_ve_sayac_var() -> None:
    results = CREATE_TIME_ENTRIES_BULK_OUTPUT["properties"]["results"]["items"]
    assert results["properties"]["status"]["enum"] == [
        "created", "failed", "skipped", "deduped",
    ]
    summary = CREATE_TIME_ENTRIES_BULK_OUTPUT["properties"]["summary"]
    assert summary["properties"]["deduped"]["type"] == "integer"
    assert "deduped" not in summary["required"]


def test_semalar_sozlesmeyle_alan_alan_ayni() -> None:
    """contract/tools.json'daki WriteResult ve bulk ciktisiyla alan pariteleri.
    Sozlesme dogrulayicisi (verify-contract.mjs) cozulmus semalari DIFF'ler;
    burada ayni karsilastirmanin birim-test hali tutulur."""
    write_result = CONTRACT["$defs"]["WriteResult"]
    assert set(write_result["properties"]) == set(CREATE_TIME_ENTRY_OUTPUT["properties"])

    bulk = next(t for t in CONTRACT["tools"] if t["name"] == "xurrent_create_time_entries_bulk")
    contract_summary = bulk["output"]["properties"]["summary"]
    local_summary = CREATE_TIME_ENTRIES_BULK_OUTPUT["properties"]["summary"]
    assert set(contract_summary["properties"]) == set(local_summary["properties"])
    assert contract_summary["required"] == local_summary["required"]

    contract_status = bulk["output"]["properties"]["results"]["items"]["properties"]["status"]
    local_status = CREATE_TIME_ENTRIES_BULK_OUTPUT["properties"]["results"]["items"][
        "properties"
    ]["status"]
    assert contract_status["enum"] == local_status["enum"]
