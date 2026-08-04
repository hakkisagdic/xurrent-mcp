"""BOZUK JSON KORUYUCUSU — stdin ile SDK arasina girer.

SORUN: JSON-RPC 2.0, ayristirilamayan bir govdeye `-32700 Parse error` donmeyi
ZORUNLU kilar. mcp 2.0.0'in stdio transport'u bozuk satiri SESSIZCE yutuyor:
istemci yanit bekler, hic gelmez, cagri suresiz asili kalir. Sessiz yutma, acik
hatadan KOTUDUR — istemci neyin yanlis oldugunu asla ogrenemez.

KANIT (ezberden degil, site-packages'tan okundu —
mcp/server/stdio.py · `stdin_reader`):

    try:
        message = types.jsonrpc_message_adapter.validate_json(line, by_name=False)
    except Exception as exc:
        await read_stream_writer.send(exc)   # <- hata AKISA konuluyor
        continue

Yani SDK hatayi atmiyor, read stream'e bir `Exception` OGESI olarak koyuyor.
Onu okuyan taraf ise (mcp/shared/jsonrpc_dispatcher.py · `_route_item`):

    if isinstance(item, Exception):
        if self.on_stream_exception is None:
            logger.debug("transport yielded exception: %r", item)
            return          # <- SESSIZCE DUSURULUYOR

`on_stream_exception` yalnizca CLIENT tarafinda baglaniyor (mcp/client/session.py);
sunucu tarafinda hicbir yerde set edilmiyor. Sonuc: bozuk satir loglanip atiliyor,
tel'e tek bir bayt bile cikmiyor.

NEDEN "SDK boyle yapiyor" bir mazeret DEGIL: C# SDK'si ayni senaryoda `-32700`
donduruyor (scripts/mcp-uyum.mjs · madde J5), TypeScript de bu ihlali ayni
desenle kapatti (servers/typescript/src/mcp/parse-guard.ts). Davranis protokolun
degil, implementasyonun bir eksigi.

COZUM: satirlari SDK'ya ULASMADAN once dogrula. Ayristirilabilenler dokunulmadan
gecer; ayristirilamayanlar dusurulur ve yerine spec'in istedigi hata yazilir.
SDK'nin icine girmiyoruz, ONUNE geciyoruz — TypeScript'teki `Transform`'un
Python karsiligi budur.

ARAYA NEREDEN GIRIYORUZ: `stdio_server(stdin=...)` parametresi. SDK'nin
`stdin_reader`'i verilen nesneden SADECE `async for line in stdin` yapiyor;
baska hicbir metodunu cagirmiyor. Dolayisiyla "satir ureten bir async iterable"
vermek yetiyor (bkz. `KorumaliStdin`).

TEK YAZAR KURALI: uretilen -32700 yaniti stdout'a ELLE yazilmaz. SDK'nin kendi
`stdout_writer`'ina, yani `write_stream`'e gonderilir. Boylece stdout'un tek bir
yazari kalir; iki yazar ayni boruda cerceveleri birbirine karistirirdi.

NE'DEN VAZGECTIK (durustce): stdin'i acikca verdigimiz icin SDK'nin fd 0
"claim" mekanizmasi (fd 0 -> /dev/null yonlendirmesi) devre disi kalir. O
mekanizma, handler kodunun veya bir alt surecin protokol baytlarini calmasini
engellemek icindir; bu sunucuda hicbir handler stdin okumaz ve alt surec
baslatilmaz. ONEMLI OLAN fd 1 claim'i (stray `print()` telin uzerine dusmesin —
madde J7) OLDUGU GIBI KORUNUR, cunku `stdout` parametresini SDK'ya birakiyoruz.
"""

from __future__ import annotations

import io
import json
import logging
import re
import sys
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from typing import Any, Literal

import anyio
import mcp_types as types
from mcp.server.stdio import stdio_server
from mcp.shared.message import SessionMessage

log = logging.getLogger(__name__)

PARSE_HATA_MESAJI = "Parse error: gövde geçerli JSON değil."

#: Koruyucunun urettigi olaylar. Sira KORUNUR: bozuk bir satirin hatasi, ondan
#: sonra gelen gecerli satirin ONUNDE kalir.
#:   ("satir", str)  -> SDK'ya iletilecek ham satir (satir sonu HARIC)
#:   ("hata",  dict) -> tel'e yazilacak JSON-RPC hata govdesi
Olay = tuple[Literal["satir", "hata"], Any]

# `"id": 991` veya `"id": "abc-7"`. Kacisli tirnaklar ("\"") govdeyi erken
# bitirmesin diye string dalinda `(?:[^"\\]|\\.)*` kullanilir.
_ID_DESENI = re.compile(r'"id"\s*:\s*(?:(-?\d+)|"((?:[^"\\]|\\.)*)")')


def id_kurtar(satir: str) -> str | int | None:
    """Bozuk govdeden `id`'yi kurtarmayi dener.

    NEDEN ugrasiyoruz: spec, ayristirma hatasinda `id: null` donmeye izin verir,
    ama istemcinin istegini eslestirebilmesi icin gercek id cok daha faydalidir.
    Kesilmis bir mesajda (`{"jsonrpc":"2.0","id":991,"method":...`) id genellikle
    saglamdir — govde sonradan kopmustur. C# SDK'si da bunu yapiyor.

    Kurtarilamiyorsa None doner; bu da spec'e uygundur (tel'de `null`).
    """
    eslesme = _ID_DESENI.search(satir)
    if eslesme is None:
        return None
    if eslesme.group(1) is not None:
        return int(eslesme.group(1))
    return eslesme.group(2)


def hata_govdesi(id_degeri: str | int | None) -> dict:
    """Spec'in istedigi `-32700` yanitinin govdesi."""
    return {
        "jsonrpc": "2.0",
        "id": id_degeri,
        "error": {"code": types.PARSE_ERROR, "message": PARSE_HATA_MESAJI},
    }


class ParseKoruyucu:
    """Saf (senkron) durum makinesi: parca girer, olay listesi cikar.

    Satir tabanli calisir cunku stdio transport'u da satir tabanlidir: her
    JSON-RPC mesaji tek satirdir. Tamamlanmamis son parca tamponda BEKLETILIR —
    bir mesajin iki okumaya bolunmesi normaldir ve onu bozuk saymak gercek
    trafigi kirardi.

    I/O yapmaz, async degildir, global durum tutmaz. Bu yuzden birim testi
    dogrudan buraya yazilir (tests/test_parse_guard.py).
    """

    def __init__(self) -> None:
        self._tampon = ""

    def besle(self, parca: str) -> list[Olay]:
        """Yeni bir parca isler; TAMAMLANMIS satirlarin olaylarini doner."""
        self._tampon += parca
        olaylar: list[Olay] = []
        while True:
            kesme = self._tampon.find("\n")
            if kesme < 0:
                break
            ham = self._tampon[:kesme]
            self._tampon = self._tampon[kesme + 1 :]
            self._satir_isle(ham, olaylar)
        return olaylar

    def bitir(self) -> list[Olay]:
        """Akis kapanirken tamponda kalani isler.

        Sonda satir sonu yoksa o parca da bir mesaj OLAMAZ; ya gecerli tek bir
        JSON'dur ya da bozuktur. Sessizce atmak, ihlalin ta kendisidir.
        """
        kalan, self._tampon = self._tampon, ""
        olaylar: list[Olay] = []
        if kalan.strip():
            self._satir_isle(kalan, olaylar)
        return olaylar

    def _satir_isle(self, ham: str, olaylar: list[Olay]) -> None:
        satir = ham.strip()
        if not satir:
            # Bos satir transport'ta anlamsizdir; bozuk JSON DEGILDIR.
            return
        try:
            json.loads(satir)
        except ValueError:
            olaylar.append(("hata", hata_govdesi(id_kurtar(satir))))
            return
        # Gecerli: DEGISTIRILMEDEN gecer. (Gecerli JSON olup gecerli bir
        # JSON-RPC mesaji OLMAYAN govdeler -32600'un konusudur, -32700'un
        # degil; onlari bilerek SDK'ya birakiyoruz.)
        olaylar.append(("satir", ham))


async def korumali_satirlar(
    kaynak: AsyncIterable[str],
    hata_yaz: Callable[[dict], Awaitable[None]],
) -> AsyncIterator[str]:
    """Ham parcalari suzer: gecerli satirlari verir, bozuklari `hata_yaz`a yollar."""
    koruyucu = ParseKoruyucu()
    async for parca in kaynak:
        for tur, deger in koruyucu.besle(parca):
            if tur == "hata":
                await hata_yaz(deger)
            else:
                yield deger + "\n"
    for tur, deger in koruyucu.bitir():
        if tur == "hata":
            await hata_yaz(deger)
        else:
            yield deger + "\n"


class KorumaliStdin:
    """`stdio_server(stdin=...)`a verilen sarmalayici.

    SDK bu nesneden SADECE `async for line in stdin` yapar; bu yuzden tek
    gereken `__aiter__`tir. Gercek stdin'i sarip suzulmus satirlari uretiriz.
    """

    def __init__(
        self,
        kaynak: AsyncIterable[str],
        hata_yaz: Callable[[dict], Awaitable[None]],
    ) -> None:
        self._kaynak = kaynak
        self._hata_yaz = hata_yaz

    def __aiter__(self) -> AsyncIterator[str]:
        return korumali_satirlar(self._kaynak, self._hata_yaz)


class _SahipsizMetin(io.TextIOWrapper):
    """Kapanirken altindaki buffer'i KAPATMAYAN metin katmani.

    Buffer bizim degil: `sys.stdin.buffer`i cop toplama sirasinda kapatmak
    surecin geri kalaninda stdin'i yok eder (SDK ayni onlemi aliyor — bkz.
    mcp/server/stdio.py · `_UnownedTextWrapper`, issue #1933).
    """

    def close(self) -> None:
        with suppress(ValueError):
            self.detach()


def _utf8_stdin() -> Any:
    """stdin'i UTF-8 metin olarak, satir satir okunabilir bicimde acar.

    Platformun varsayilan kodlamasina GUVENILMEZ; SDK da ayni sebeple yeniden
    sarar. `errors="replace"`: bozuk bayt sureci dusurmesin, bozuk SATIR olsun —
    zaten -32700 ile cevaplanacak.
    """
    return anyio.wrap_file(_SahipsizMetin(sys.stdin.buffer, encoding="utf-8", errors="replace"))


def _hata_mesaji(govde: dict) -> SessionMessage:
    """Koruyucunun urettigi sozlugu SDK'nin yazabilecegi mesaja cevirir."""
    return SessionMessage(
        types.JSONRPCError(
            jsonrpc="2.0",
            id=govde["id"],
            error=types.ErrorData(
                code=govde["error"]["code"], message=govde["error"]["message"]
            ),
        )
    )


@asynccontextmanager
async def korumali_stdio_server():
    """`stdio_server` ile ayni sozu verir, ustune J5'i (-32700) tutar.

    Kullanim `stdio_server` ile birebir aynidir:

        async with korumali_stdio_server() as (read_stream, write_stream):
            await server.run(read_stream, write_stream, ...)
    """
    # `write_stream` ancak `stdio_server` acildiktan SONRA var olur, oysa suzme
    # teorik olarak ondan once baslayabilir. `hazir` bu yarisi kapatir.
    hazir = anyio.Event()
    kutu: dict[str, Any] = {}

    async def hata_yaz(govde: dict) -> None:
        await hazir.wait()
        log.warning("bozuk JSON satırı düşürüldü, -32700 döndürüldü (id=%r)", govde["id"])
        # ★ GONDERIM BURADA, SUZME GOREVININ ICINDE BEKLENIR — ayri bir "pompa"
        #   gorevine devredilmez. Sebep bir kapanis yarisidir: akisin SON satiri
        #   bozuksa, `bitir()` hatayi uretir, hemen ardindan stdin biter,
        #   `server.run` doner ve stdout yazicisi kapanir. Devredilen gonderim o
        #   ana yetisemez ve SON hata TELE HIC CIKMAZ — yani tam da kapattigimiz
        #   ihlal, akisin son satirinda geri gelir. Burada beklendiginde gonderim
        #   stdin bitmeden TAMAMLANMIS olur.
        with suppress(anyio.ClosedResourceError, anyio.BrokenResourceError):
            await kutu["yazici"].send(_hata_mesaji(govde))

    stdin = KorumaliStdin(_utf8_stdin(), hata_yaz)

    async with stdio_server(stdin=stdin) as (read_stream, write_stream):
        kutu["yazici"] = write_stream
        hazir.set()
        yield read_stream, write_stream
