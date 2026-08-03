"""core/confirm.py — onay formu + `requestState` imzalama/dogrulama (v2 MRTR).

NEDEN IMZA GEREKIYOR: MRTR'de `requestState` CLIENT UZERINDEN gecer ve spec onu
acikca "saldirgan kontrolundeki girdi" sayar. Bizim blob'umuz sunu tasir:
"kullanici X, Request #70248'e 120 dakika yazmayi onayladi." Imzasiz birakilirsa
client bunu degistirip BASKA ticket'a BASKA sure yazdirabilir.

Bu dosya dort savunmanin her birini AYRI AYRI kirmayi dener:
  principal   -> baska kullanicinin onayini calip kendine kullanma
  exp         -> eski onayi aylar sonra tekrar oynatma
  fingerprint -> "60 dakika" onayini alip "600 dakika" cagrisina ilistirme
  nonce       -> ayni onayi iki kez kullanma

Zaman burada da ENJEKTE EDILIR: time.sleep() ile TTL beklemek testi yavas VE
kirilgan yapardi.
"""

from __future__ import annotations

import base64
import json
import time

import pytest

from xurrent_mcp.core import confirm as onay_modulu
from xurrent_mcp.core.confirm import (
    CONFIRM_FIELD,
    CONFIRM_KEY,
    StateError,
    StateSigner,
    build_prompt,
    fingerprint,
)

PRINCIPAL = "ayse.demir@ornek.com"
METOD = "tools/call"
ARGUMANLAR = {
    "targetType": "request",
    "targetId": "TW9jay9SZXF1ZXN0LzcwMjQ4",
    "minutes": 60,
    "dryRun": False,
}


@pytest.fixture
def imzalayici() -> StateSigner:
    """Sabit anahtar: test kosulari arasinda tekrar uretilebilir olmasi icin."""
    return StateSigner.create("test-anahtari", ttl_seconds=300)


def _token_uret(imzalayici: StateSigner, **kw) -> str:
    return imzalayici.issue(
        principal=kw.get("principal", PRINCIPAL),
        method=kw.get("method", METOD),
        arguments=kw.get("arguments", ARGUMANLAR),
    )


def _dogrula(imzalayici: StateSigner, token: str, **kw):
    return imzalayici.verify(
        token,
        principal=kw.get("principal", PRINCIPAL),
        method=kw.get("method", METOD),
        arguments=kw.get("arguments", ARGUMANLAR),
    )


def _govdeyi_degistir(token: str, **degisiklikler) -> str:
    """Imzayi OLDUGU GIBI birakip govdeyi kurcalar — klasik saldiri."""
    govde_ham, imza = token.split(".")
    dolgu = "=" * (-len(govde_ham) % 4)
    govde = json.loads(base64.urlsafe_b64decode(govde_ham + dolgu))
    govde.update(degisiklikler)
    yeni = json.dumps(govde, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    kodlu = base64.urlsafe_b64encode(yeni.encode()).decode().rstrip("=")
    return f"{kodlu}.{imza}"


# ── mutlu yol ───────────────────────────────────────────────────────────────


def test_imzalanan_state_ayni_cagri_icin_dogrulanir(imzalayici):
    yuk = _dogrula(imzalayici, _token_uret(imzalayici))

    assert yuk["principal"] == PRINCIPAL
    assert yuk["method"] == METOD
    assert yuk["fingerprint"] == fingerprint(METOD, ARGUMANLAR)


def test_uretilen_state_govde_nokta_imza_bicimindedir(imzalayici):
    assert _token_uret(imzalayici).count(".") == 1


def test_her_uretim_FARKLI_nonce_tasir(imzalayici):
    """Iki es zamanli onay birbirinin nonce'unu tuketmemeli."""
    assert _token_uret(imzalayici) != _token_uret(imzalayici)


# ── imza bozulursa RED ──────────────────────────────────────────────────────


def test_govde_kurcalanirsa_REDDEDILIR(imzalayici):
    """'60 dakika' onayini alip baska bir principal'a mal etme denemesi."""
    token = _govdeyi_degistir(_token_uret(imzalayici), principal="saldirgan@ornek.com")

    with pytest.raises(StateError, match="IMZASI GECERSIZ"):
        _dogrula(imzalayici, token, principal="saldirgan@ornek.com")


def test_imza_kismi_degistirilirse_REDDEDILIR(imzalayici):
    govde, imza = _token_uret(imzalayici).split(".")
    bozuk_imza = ("A" if imza[0] != "A" else "B") + imza[1:]

    with pytest.raises(StateError, match="IMZASI GECERSIZ"):
        _dogrula(imzalayici, f"{govde}.{bozuk_imza}")


def test_baska_anahtarla_imzalanan_state_REDDEDILIR(imzalayici):
    """Sunucu yeniden baslayinca (rastgele anahtar) eski onaylar gecersiz olur —
    bu KASITLI bir davranistir."""
    yabanci = StateSigner.create("baska-anahtar", ttl_seconds=300)

    with pytest.raises(StateError, match="IMZASI GECERSIZ"):
        _dogrula(imzalayici, _token_uret(yabanci))


@pytest.mark.parametrize(
    "bozuk", ["", "govdesiz", "a.b.c", "....", "gecersiz-base64!.imza"]
)
def test_bicimi_bozuk_state_REDDEDILIR(imzalayici, bozuk):
    with pytest.raises(StateError):
        _dogrula(imzalayici, bozuk)


def test_govdesi_json_olmayan_state_REDDEDILIR():
    """Imza dogru olsa bile govde JSON degilse yazma yapilmaz."""
    imzalayici = StateSigner.create("test-anahtari")
    import hashlib
    import hmac

    govde = b"bu json degil"
    imza = hmac.new(imzalayici.secret, govde, hashlib.sha256).digest()
    token = (
        base64.urlsafe_b64encode(govde).decode().rstrip("=")
        + "."
        + base64.urlsafe_b64encode(imza).decode().rstrip("=")
    )

    with pytest.raises(StateError, match="JSON degil"):
        imzalayici.verify(token, principal=PRINCIPAL, method=METOD, arguments=ARGUMANLAR)


# ── arguman parmak izi degisirse RED ────────────────────────────────────────


def test_argumanlar_degisirse_REDDEDILIR(imzalayici):
    """★ '60 dakika' onayini alip '600 dakika' cagrisina ilistirme denemesi."""
    token = _token_uret(imzalayici)
    saldiri = {**ARGUMANLAR, "minutes": 600}

    with pytest.raises(StateError, match="parmak izi uyusmuyor"):
        _dogrula(imzalayici, token, arguments=saldiri)


def test_hedef_ticket_degisirse_REDDEDILIR(imzalayici):
    token = _token_uret(imzalayici)
    saldiri = {**ARGUMANLAR, "targetId": "TW9jay9SZXF1ZXN0LzcwMzAx"}

    with pytest.raises(StateError, match="parmak izi uyusmuyor"):
        _dogrula(imzalayici, token, arguments=saldiri)


def test_metod_degisirse_REDDEDILIR(imzalayici):
    token = _token_uret(imzalayici)

    with pytest.raises(StateError):
        _dogrula(imzalayici, token, method="tools/list")


def test_arguman_eklenirse_de_REDDEDILIR(imzalayici):
    """Onaylanan islem ile yapilmak istenen islem AYNI DEGIL."""
    token = _token_uret(imzalayici)

    with pytest.raises(StateError, match="parmak izi uyusmuyor"):
        _dogrula(imzalayici, token, arguments={**ARGUMANLAR, "note": "eklendi"})


def test_parmak_izi_anahtar_SIRASINDAN_etkilenmez():
    """sort_keys=True olmasaydi gecerli bir onay bosuna reddedilirdi."""
    assert fingerprint(METOD, {"a": 1, "b": 2}) == fingerprint(METOD, {"b": 2, "a": 1})


def test_parmak_izi_bos_arguman_ile_None_i_ayni_sayar():
    assert fingerprint(METOD, None) == fingerprint(METOD, {})


def test_argumanlari_ayni_sirasi_farkli_cagri_DOGRULANIR(imzalayici):
    """Client argumanlari yeniden seri hale getirirse onay bosuna dusmemeli."""
    token = _token_uret(imzalayici)
    ters = dict(reversed(list(ARGUMANLAR.items())))

    assert _dogrula(imzalayici, token, arguments=ters)


# ── TTL gecerse RED ─────────────────────────────────────────────────────────


def test_suresi_dolan_state_REDDEDILIR(imzalayici, monkeypatch):
    """Zaman ENJEKTE edilir: time.sleep ile beklemek testi yavas ve kirilgan yapardi."""
    token = _token_uret(imzalayici)
    simdi = time.time()
    monkeypatch.setattr(onay_modulu.time, "time", lambda: simdi + 301)

    with pytest.raises(StateError, match="suresi doldu"):
        _dogrula(imzalayici, token)


def test_ttl_icindeki_state_hala_gecerlidir(imzalayici, monkeypatch):
    token = _token_uret(imzalayici)
    simdi = time.time()
    monkeypatch.setattr(onay_modulu.time, "time", lambda: simdi + 299)

    assert _dogrula(imzalayici, token)


def test_ttl_en_az_bir_saniye_olarak_kisitlanir():
    """ttl=0 verilirse her onay dogar dogmaz olurdu."""
    assert StateSigner.create("k", ttl_seconds=0).ttl_seconds == 1
    assert StateSigner.create("k", ttl_seconds=-5).ttl_seconds == 1


# ── nonce: tek kullanim ─────────────────────────────────────────────────────


def test_ayni_state_IKINCI_kez_kullanilamaz(imzalayici):
    """★ Spec'in uyarisi: imza+TTL replay penceresini daraltir ama tek kullanimi
    TEK BASINA garanti etmez. Onu sunucu tarafinda zorlamak gerekir."""
    token = _token_uret(imzalayici)
    _dogrula(imzalayici, token)  # 1. kullanim: gecer

    with pytest.raises(StateError, match="DAHA ONCE kullanilmis"):
        _dogrula(imzalayici, token)


def test_nonce_seti_imzalayiciya_OZELDIR(imzalayici):
    """Nonce surec ici tutulur; coklu surec dagitiminda paylasimli store gerekir.
    Bu test o sinirin FARKINDA oldugumuzu belgeler."""
    token = _token_uret(imzalayici)
    _dogrula(imzalayici, token)

    ikizi = StateSigner.create("test-anahtari", ttl_seconds=300)
    assert _dogrula(ikizi, token)  # ayni anahtar, BASKA surec -> nonce'u bilmiyor


def test_govdeden_nonce_silinirse_REDDEDILIR():
    """Nonce'suz bir govde uretip imzalamak da yolu acmamali."""
    imzalayici = StateSigner.create("test-anahtari")
    import hashlib
    import hmac

    govde_sozlugu = {
        "v": 1,
        "principal": PRINCIPAL,
        "method": METOD,
        "fingerprint": fingerprint(METOD, ARGUMANLAR),
        "nonce": "",
        "iat": int(time.time()),
        "exp": int(time.time()) + 300,
    }
    govde = json.dumps(
        govde_sozlugu, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ).encode()
    imza = hmac.new(imzalayici.secret, govde, hashlib.sha256).digest()
    token = (
        base64.urlsafe_b64encode(govde).decode().rstrip("=")
        + "."
        + base64.urlsafe_b64encode(imza).decode().rstrip("=")
    )

    with pytest.raises(StateError, match="DAHA ONCE kullanilmis"):
        imzalayici.verify(token, principal=PRINCIPAL, method=METOD, arguments=ARGUMANLAR)


# ── principal ───────────────────────────────────────────────────────────────


def test_baska_principal_ile_dogrulama_REDDEDILIR(imzalayici):
    """Baska kullanicinin onayini calip kendine kullanma denemesi."""
    token = _token_uret(imzalayici)

    with pytest.raises(StateError, match="BASKA bir kullaniciya ait"):
        _dogrula(imzalayici, token, principal="baskasi@ornek.com")


def test_principal_kontrolu_TTL_den_sonra_calisir(imzalayici, monkeypatch):
    """Hem suresi dolmus hem baska kullaniciya ait bir token icin mesaj TTL demeli;
    kullaniciya once cozulebilir sorunu soylemek daha faydalidir."""
    token = _token_uret(imzalayici)
    simdi = time.time()
    monkeypatch.setattr(onay_modulu.time, "time", lambda: simdi + 999)

    with pytest.raises(StateError, match="suresi doldu"):
        _dogrula(imzalayici, token, principal="baskasi@ornek.com")


# ── onay formu ──────────────────────────────────────────────────────────────


def test_onay_formu_TEK_boolean_alandan_olusur():
    """Onay bir VERI TOPLAMA degil, bir SINIRDIR. Sorulan tek sey: 'yazayim mi?'"""
    form = build_prompt("xurrent_create_time_entry", "60 dakika yazılacak. Onaylıyor musunuz?", {})

    sema = form.requested_schema
    assert sema["type"] == "object"
    assert sema["required"] == [CONFIRM_FIELD]
    assert list(sema["properties"]) == [CONFIRM_FIELD]
    assert sema["properties"][CONFIRM_FIELD]["type"] == "boolean"


def test_onay_formu_mesaji_alan_aciklamasina_da_kopyalanir():
    """Formu ham gosteren bir client'ta soru gorunmez kalmasin."""
    mesaj = "120 dakikalık zaman girişi yazılacak. Onaylıyor musunuz?"
    form = build_prompt("xurrent_create_time_entry", mesaj, {"minutes": 120})

    assert form.message == mesaj
    assert form.requested_schema["properties"][CONFIRM_FIELD]["description"] == mesaj


def test_onay_formu_yapisal_ozeti_oldugu_gibi_tasir():
    ozet = {"tool": "xurrent_create_time_entry", "minutes": 120, "mode": "mock"}
    form = build_prompt("xurrent_create_time_entry", "?", ozet)

    assert form.summary == ozet
    assert form.tool_name == "xurrent_create_time_entry"


def test_onay_anahtari_sabittir():
    """Client cevabi AYNI anahtarla geri getirir; degismesi protokolu kirar."""
    assert CONFIRM_KEY == "zaman-girisi-onayi"
    assert CONFIRM_FIELD == "onay"
