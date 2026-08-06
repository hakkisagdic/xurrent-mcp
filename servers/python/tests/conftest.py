"""Cekirdek is mantigi birim testlerinin ortak zemini.

BU DOSYA UC KURALI ZORLAR — tests/ altindaki her dosya icin gecerlidir:

1. I/O YOK. Ag yok, sunucu ayaga kalkmiyor, MCP oturumu yok. Test edilen sey
   saf fonksiyondur. Fixture JSON'u OKUMAK serbesttir; uc dilin ortak veri
   kaynagi odur ve okunmadan "225 vs 255" dersi dogrulanamaz.

2. ZAMAN ENJEKTE EDILIR. "Bugun" gercek saatten OKUNMAZ. Asagidaki
   `zaman_sabitle` fixture'i AUTOUSE'dur ve today_in'i her modulde
   SABIT_BUGUN'e cakar.

   ★ NEDEN: bu repoda tam olarak bu yuzden gece kirilan bir test yasandi
   (bkz. commit "Fix timezone-dependent flake in the fake-Xurrent scenario
   runner"). Yerel 00:00-03:00 arasinda UTC tarihi BIR GUN GERIDEDIR; UTC'den
   turetilen T-1, sunucunun gozunde T-2 olur ve XURRENT_MAX_BACKDATE_DAYS=1
   yuzunden HAKLI OLARAK reddedilir. Sonuc: gecenin uc saatinde kirmiziya
   donen, gunduz yesil olan bir test. Testin kendisi gunun saatine bagli
   olmamalidir — o yuzden burada sabitleniyor.

3. TEST ADI = IDDIA. "test1" degil, "two_step ikinci adimda assignment
   gondermez". Ad, dogrulanan kurali soylemelidir.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import pytest

# `uv run pytest` paketi kurulu calistirir; `python -m pytest` icin src yolu
# eklenir. Kurulu ise bu satir zararsizdir.
_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from xurrent_mcp.config import Config  # noqa: E402
from xurrent_mcp.models import (  # noqa: E402
    EffortClass,
    TimeAllocation,
    TimeTrackingContext,
    TimeTrackingDefaults,
    WorkItem,
)
from xurrent_mcp.timeutil import materialize  # noqa: E402

REPO_KOKU = Path(__file__).resolve().parents[3]
FIXTURES = REPO_KOKU / "fixtures"

# Testlerin "bugun"u. Gercek takvimle iliskisi YOKTUR ve olmamalidir.
SABIT_BUGUN = date(2026, 8, 3)
SABIT_DUN = date(2026, 8, 2)
TZ = "Europe/Istanbul"

# today_in'i `from ..timeutil import today_in` ile ICE AKTARAN her modul.
# Kaynak fonksiyonu yamalamak yetmez: her modul kendi referansini tutar.
# Liste bir modul eklendiginde/silindiginde bilerek KIRILSIN diye acikca yazildi
# (monkeypatch raising=True).
_TODAY_IN_KULLANANLAR = (
    "xurrent_mcp.xurrent.validate",
    "xurrent_mcp.xurrent.strategies",
    "xurrent_mcp.xurrent.mock",
    # REST adaptoru two_step 2. adiminda "bugun"un kayitlarini sorgular
    # (find_latest_time_entry_id) — tarih testte sabitlenmek zorundadir.
    "xurrent_mcp.xurrent.rest",
    "xurrent_mcp.calendar",
    "xurrent_mcp.tools.calendar_tools",
    "xurrent_mcp.tools.write_tools",
    "xurrent_mcp.core.wizard",
)


@pytest.fixture(autouse=True)
def zaman_sabitle(monkeypatch: pytest.MonkeyPatch) -> date:
    """Tum testlerde "bugun" = SABIT_BUGUN. AUTOUSE — unutulamaz.

    Ayrica mock takvim saglayicisinin goreli tarih materyalizasyonunu da ayni
    ana cakar; aksi halde fixture'daki dayOffset gercek bugune gore acilir ve
    pencere ile kesismez.
    """
    import importlib

    for modul_adi in _TODAY_IN_KULLANANLAR:
        modul = importlib.import_module(modul_adi)
        monkeypatch.setattr(modul, "today_in", lambda _tz: SABIT_BUGUN, raising=True)

    mock_modul = importlib.import_module("xurrent_mcp.calendar.mock")
    monkeypatch.setattr(
        mock_modul,
        "materialize",
        lambda gun_farki, hhmm, tz, base=None: materialize(
            gun_farki, hhmm, tz, base=base or SABIT_BUGUN
        ),
        raising=True,
    )
    return SABIT_BUGUN


@pytest.fixture
def yapilandirma():
    """Config uretici. Ortam degiskeni OKUNMAZ — load_config() cagrilmaz."""

    def olustur(**kw) -> Config:
        varsayilan: dict = {
            "timezone": TZ,
            "max_backdate_days": 1,
            "source": "xurrent-mcp",
            "default_time_allocation_id": "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
            "fixtures_dir": FIXTURES,
        }
        varsayilan.update(kw)
        return Config(**varsayilan)

    return olustur


@pytest.fixture
def zaman_baglami():
    """TimeTrackingContext uretici — fixtures/timesheet-settings.json ile ayni.

    timeIncrement=30 KASITLIDIR: 45 dakikalik toplanti oldugu gibi yazilamaz.
    """

    def olustur(**kw) -> TimeTrackingContext:
        varsayilan: dict = {
            "timeIncrement": 30,
            "effortClasses": [
                EffortClass(id="TW9jay9FZmZvcnRDbGFzcy8x", name="Standart", costMultiplier=1.0),
                EffortClass(id="TW9jay9FZmZvcnRDbGFzcy8y", name="Mesai disi", costMultiplier=1.5),
            ],
            "defaults": TimeTrackingDefaults(
                requestEffortClassId="TW9jay9FZmZvcnRDbGFzcy8x",
                taskEffortClassId="TW9jay9FZmZvcnRDbGFzcy8y",
                projectTaskEffortClassId="TW9jay9FZmZvcnRDbGFzcy8x",
                problemEffortClassId="TW9jay9FZmZvcnRDbGFzcy8x",
                timeAllocationEffortClassId="TW9jay9FZmZvcnRDbGFzcy8x",
            ),
            "unit": "hours_and_minutes",
            "workday": 480,
            "workweek": 2400,
            "allowWorkdayOvertime": False,
            "allowWorkweekOvertime": True,
            "allocationTimeTracking": True,
            "assignmentTimeTracking": True,
            "requireNote": False,
            "requireTimeEntryDescription": False,
            "timeAllocations": [
                TimeAllocation(id="TW9jay9UaW1lQWxsb2NhdGlvbi8x", name="İç toplantılar"),
                TimeAllocation(
                    id="TW9jay9UaW1lQWxsb2NhdGlvbi8y",
                    name="Eğitim ve gelişim",
                    descriptionRequired=True,
                ),
            ],
        }
        varsayilan.update(kw)
        return TimeTrackingContext(**varsayilan)

    return olustur


@pytest.fixture(scope="session")
def acik_isler() -> list[WorkItem]:
    """fixtures/requests.json + tasks.json -> ACIK is ogeleri.

    Eslestirme testlerinin uc dilin ortak verisiyle kosmasi icin fixture'dan
    okunur; ayri bir "test verisi" uydurmak dersi ikiye bolerdi.
    """
    kapali = {"completed", "closed", "cancelled"}
    ogeler: list[WorkItem] = []

    talepler = json.loads((FIXTURES / "requests.json").read_text(encoding="utf-8"))["requests"]
    for r in talepler:
        if r["status"] in kapali:
            continue
        ogeler.append(
            WorkItem(
                kind="request",
                id=r["id"],
                displayId=str(r["requestId"]),
                subject=r["subject"],
                status=r["status"],
            )
        )

    gorevler = json.loads((FIXTURES / "tasks.json").read_text(encoding="utf-8"))["tasks"]
    for t in gorevler:
        if t["status"] in kapali:
            continue
        ogeler.append(
            WorkItem(
                kind="task",
                id=t["id"],
                displayId=str(t["taskId"]),
                subject=t["subject"],
                status=t["status"],
            )
        )
    return ogeler
