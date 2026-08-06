"""fixtures/state-vektorleri.json — capraz-dil durum imzasi vektorleri.

NEDEN VAR: paralel konteyner olcumu, TS'in urettigi requestState'in ayni sirri
tasiyan bir C# replikasinda COZULEMEDIGINI gosterdi — her dil kendi zarfini
uydurmustu. Bu dosya, uc dilin de AYNI sabit {secret, payloadJson, token}
uclerini birebir uretip dogruladigini kanitlar. Vektor token'i degisirse bu
test KIRILMALIDIR — kirilmamasi, tasinabilirligin hic sinanmadigi anlamina
gelirdi.

KRITIK KURAL: imza HAM payload byte'lari uzerindedir; testler payloadJson
DIZGESINI yeniden serilestirmeden, oldugu gibi imzalar. json.dumps ile yeniden
uretmek anahtar sirasina bagimlilik sokar — sira kanonik DEGILDIR.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from xurrent_mcp.core.confirm import (  # noqa: E402
    StateError,
    decode_state,
    encode_state,
)
from xurrent_mcp.core.wizard import verify_state  # noqa: E402

_VEKTOR_DOSYASI = (
    Path(__file__).resolve().parents[3] / "fixtures" / "state-vektorleri.json"
)


def _vektorler() -> list[dict]:
    return json.loads(_VEKTOR_DOSYASI.read_text(encoding="utf-8"))["vektorler"]


def _kimlikler() -> list[str]:
    return [v["aciklama"].split(" — ")[0] for v in _vektorler()]


@pytest.mark.parametrize("vektor", _vektorler(), ids=_kimlikler())
def test_kodlama_vektor_tokenini_BIREBIR_uretir(vektor: dict) -> None:
    """(a) Verilen payloadJson + secret -> TAM OLARAK beklenen token."""
    secret = vektor["secret"].encode("utf-8")
    assert encode_state(secret, vektor["payloadJson"]) == vektor["token"]


@pytest.mark.parametrize("vektor", _vektorler(), ids=_kimlikler())
def test_dogrulama_vektor_tokenindan_payloadi_geri_verir(vektor: dict) -> None:
    """(b) Beklenen token dogrulanir ve payload AYNEN geri cikar.

    decode_state ham byte dondurur; once byte esitligi (zarf kaybi yok),
    sonra JSON esitligi (anlam kaybi yok) iddia edilir.
    """
    secret = vektor["secret"].encode("utf-8")
    ham = decode_state(secret, vektor["token"])
    assert ham == vektor["payloadJson"].encode("utf-8")
    assert json.loads(ham) == json.loads(vektor["payloadJson"])


def test_wizard_vektoru_wizard_dogrulayicisindan_da_gecer() -> None:
    """Zarf testi yetmez: wizard vektoru wizard'in KENDI verify_state'inden de
    gecmeli (v/kind/exp/step alan denetimleri dahil). Baska dilin urettigi
    sessionState'in Python'da devralinabildiginin davranissal kanitidir."""
    vektor = next(v for v in _vektorler() if '"kind":"wizard"' in v["payloadJson"])
    payload = verify_state(vektor["secret"].encode("utf-8"), vektor["token"])
    assert payload == json.loads(vektor["payloadJson"])
    assert payload["step"] == "duration"


@pytest.mark.parametrize("vektor", _vektorler(), ids=_kimlikler())
def test_yanlis_sirla_vektor_tokeni_REDDEDILIR(vektor: dict) -> None:
    """Negatif kontrol: vektorler 'her sirla gecer' bir zarfi kanitlamasin."""
    with pytest.raises(StateError, match="IMZASI GECERSIZ"):
        decode_state(b"baska-bir-sir", vektor["token"])
