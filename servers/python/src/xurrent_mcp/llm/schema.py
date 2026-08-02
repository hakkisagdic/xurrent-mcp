"""MCP inputSchema -> Gemini functionDeclarations sema cevirisi.

★ BU MODULUN VARLIK SEBEBI (dersin ana kaniti)

MCP tool sozlesmesi TAM JSON Schema 2020-12'dir. 2026-07-28 revizyonu bunu
bilerek gevsetti: sunucu istedigi kadar zengin bir sema beyan edebilir.
Gemini `functionDeclarations.parameters` ise OpenAPI semasinin dar bir ALT
KUMESINI kabul eder. Yani ayni sozlesme iki farkli "tool-calling lehcesine"
konusulmak zorundadir ve arada bir CEVIRICI vardir.

Gemini'nin kabul ettigi anahtarlar:
    type (string|number|integer|boolean|array|object), properties, required,
    description, enum, items

Ozel kural — DOLAR ISARETI YOK:
    $defs -> defs   ve   $ref -> ref
    `ref` yalnizca `defs`in DOGRUDAN cocugunu gosterebilir; dis referans YOK.
    `defs` yalnizca KOK seviyede durabilir.
    Azami ic ice derinlik 32; `defs` icinde oz-referans derinligi 2.
    Kaynak: ai.google.dev — Schema referansi ve function calling dokumani.

TASARIM KARARI: ceviri SAF bir fonksiyondur. Girdi bir dict, cikti bir
`SchemaTranslation` degeridir; global durum yok, log yok, I/O yok. Loglama
cagiran katmanin isidir (agent.py stderr'e basar). Boylece birim testi
yazilabilir ve `tests/test_schema.py` sozlesmedeki 8 tool'u tek tek dogrular.

NE ATTIGIMIZI KAYDEDERIZ. Sessizce dusen bir `pattern` veya `maxLength`,
model tarafindan bilinmeyen bir kisittir; "neden 81 karakterlik description
gonderdi" sorusunun cevabi budur. Atilan her anahtar yolu, degeri ve gerekcesi
ile kayda gecer.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

# Gemini semasinda ic ice derinlik siniri. Asilirsa API semayi REDDEDER.
MAX_DEPTH = 32

# Gemini functionDeclarations'in DOGRUDAN kabul ettigi anahtarlar.
# (minimum/maximum Gemini Schema tipinde mevcuttur ama biz bilincli olarak
#  dar kumede kaliyoruz: uc dil de AYNI alt kumeyi konusmali ki sozlesme
#  testi dil degistirince kaymasin.)
SUPPORTED_KEYWORDS: frozenset[str] = frozenset(
    {"type", "properties", "required", "description", "enum", "items"}
)

# Dolar isaretsiz yazilan iki ozel anahtar.
DOLLAR_REWRITES: Mapping[str, str] = {"$defs": "defs", "$ref": "ref"}

# JSON Schema tip adlari. Gemini kucuk harfli bu adlari kabul eder
# (REST orneklerinde "type": "string" boyle gecer); "null" bir tip DEGILDIR,
# Gemini'de karsiligi yoktur.
JSON_TYPES: frozenset[str] = frozenset(
    {"string", "number", "integer", "boolean", "array", "object"}
)


@dataclass(frozen=True)
class DroppedKeyword:
    """Ceviride dusurulen tek bir anahtar kelime."""

    path: str          # "#/properties/minutes" gibi, insan-okunur
    keyword: str       # "maxLength"
    value: Any         # 80
    reason: str        # Turkce gerekce

    def __str__(self) -> str:  # ders ciktisinda okunur olsun
        return f"{self.path}.{self.keyword} = {self.value!r} ({self.reason})"


@dataclass(frozen=True)
class SchemaTranslation:
    """Ceviri sonucu: sema + NE ATILDIGI + eklenen notlar."""

    schema: dict[str, Any]
    dropped: tuple[DroppedKeyword, ...] = ()
    notes: tuple[str, ...] = ()

    @property
    def dropped_keywords(self) -> tuple[str, ...]:
        """Atilan anahtar kelimelerin tekillestirilmis, sirali listesi."""
        return tuple(sorted({d.keyword for d in self.dropped}))

    @property
    def is_empty_object(self) -> bool:
        """Parametresiz tool mu? (Gemini'de `parameters` HIC gonderilmemeli.)"""
        return self.schema.get("type") == "object" and not self.schema.get("properties")


class _ToolLike(Protocol):
    """ToolSpec'e bagimli olmamak icin duck-typing sozlesmesi."""

    name: str
    description: str
    input_schema: dict[str, Any]


# ── ic yardimcilar ──────────────────────────────────────────────────────────


class _Walker:
    """Tek gecislik ceviri yuruyusu. Ornek disari SIZMAZ; saf fonksiyon sarmali."""

    def __init__(self) -> None:
        self.dropped: list[DroppedKeyword] = []
        self.notes: list[str] = []

    def drop(self, path: str, keyword: str, value: Any, reason: str) -> None:
        self.dropped.append(DroppedKeyword(path, keyword, value, reason))

    def note(self, text: str) -> None:
        if text not in self.notes:
            self.notes.append(text)

    # ── tip normalizasyonu ──
    def _type(self, raw: Any, path: str) -> str | None:
        """JSON Schema `type` -> Gemini tipi.

        NEDEN ayri: sozlesmede `["string", "null"]` gibi BIRLESIK tipler var.
        Gemini'de tip birlesimi YOKTUR; ilk gecerli tipi aliriz ve neyi
        kaybettigimizi kayda geceriz. Sessizce ilkini almak, "neden null
        gonderemiyorum" sorusunu saatlerce gizler.
        """
        if isinstance(raw, str):
            if raw in JSON_TYPES:
                return raw
            if raw == "null":
                self.drop(path, "type", raw, "Gemini'de 'null' tipi yoktur")
                return None
            self.drop(path, "type", raw, "bilinmeyen JSON Schema tipi")
            return None

        if isinstance(raw, list):
            usable = [t for t in raw if isinstance(t, str) and t in JSON_TYPES]
            if not usable:
                self.drop(path, "type", raw, "birlesik tipte kullanilabilir tip yok")
                return None
            if len(usable) > 1 or len(usable) != len(raw):
                self.drop(
                    path,
                    "type",
                    raw,
                    f"tip birlesimi desteklenmiyor; '{usable[0]}' secildi",
                )
            return usable[0]

        self.drop(path, "type", raw, "type ne string ne liste")
        return None

    # ── ref normalizasyonu ──
    def _ref(self, raw: Any, path: str) -> str | None:
        """`$ref` -> `ref`. Yalnizca `defs`in DOGRUDAN cocugu hedeflenebilir.

        `#/$defs/Person` -> `#/defs/Person`. Dis referans (http://..., baska
        dosya) ve `#/properties/...` gibi derin yollar REDDEDILIR — Gemini
        bunlari cozemez ve tum semayi reddeder.
        """
        if not isinstance(raw, str):
            self.drop(path, "$ref", raw, "ref degeri string degil")
            return None
        for prefix in ("#/$defs/", "#/defs/"):
            if raw.startswith(prefix):
                name = raw[len(prefix) :]
                if not name or "/" in name:
                    self.drop(path, "$ref", raw, "defs'in DOGRUDAN cocugu degil")
                    return None
                return f"#/defs/{name}"
        self.drop(path, "$ref", raw, "dis/derin referans — Gemini yalnizca #/defs/<ad> kabul eder")
        return None

    # ── asil yuruyus ──
    def walk(self, node: Any, path: str, depth: int, *, at_root: bool) -> dict[str, Any]:
        if not isinstance(node, dict):
            self.drop(path, "(dugum)", node, "sema dugumu bir nesne degil")
            return {}

        if depth > MAX_DEPTH:
            self.drop(path, "(derinlik)", None, f"azami ic ice derinlik {MAX_DEPTH} asildi")
            self.note(f"{path}: derinlik siniri asildi, alt agac kesildi")
            return {}

        out: dict[str, Any] = {}
        default_value: Any = _MISSING

        for key, value in node.items():
            # --- dolar isaretli iki ozel anahtar ---
            if key in ("$ref", "ref"):
                ref = self._ref(value, path)
                if ref is not None:
                    out["ref"] = ref
                    self.note("$ref -> ref (dolar isareti kaldirildi)")
                continue

            if key in ("$defs", "defs"):
                # `defs` YALNIZCA kokte durabilir. Derinde gorulen bir $defs
                # Gemini tarafindan cozulemez; sessizce birakmak yerine atariz.
                if not at_root:
                    self.drop(path, key, "(...)", "defs yalnizca KOK seviyede olabilir")
                    continue
                if not isinstance(value, dict):
                    self.drop(path, key, value, "defs bir nesne olmali")
                    continue
                defs: dict[str, Any] = {}
                for def_name, def_schema in value.items():
                    defs[def_name] = self.walk(
                        def_schema, f"{path}/defs/{def_name}", depth + 1, at_root=False
                    )
                if defs:
                    out["defs"] = defs
                    self.note("$defs -> defs (dolar isareti kaldirildi)")
                continue

            # --- desteklenen anahtarlar ---
            if key == "type":
                t = self._type(value, path)
                if t is not None:
                    out["type"] = t
                continue

            if key == "properties":
                if not isinstance(value, dict):
                    self.drop(path, key, value, "properties bir nesne olmali")
                    continue
                props: dict[str, Any] = {}
                for prop_name, prop_schema in value.items():
                    props[prop_name] = self.walk(
                        prop_schema, f"{path}/properties/{prop_name}", depth + 1, at_root=False
                    )
                out["properties"] = props
                continue

            if key == "items":
                out["items"] = self.walk(value, f"{path}/items", depth + 1, at_root=False)
                continue

            if key == "required":
                if isinstance(value, list) and all(isinstance(v, str) for v in value):
                    out["required"] = list(value)
                else:
                    self.drop(path, key, value, "required string listesi olmali")
                continue

            if key == "description":
                if isinstance(value, str):
                    out["description"] = value
                else:
                    self.drop(path, key, value, "description string olmali")
                continue

            if key == "enum":
                # Gemini'de enum STRING tipiyle anlamlidir. Sayisal enum'lari
                # metne cevirmek yerine dusururuz — sessiz tip degisimi
                # modelin yanlis deger uretmesine yol acar.
                if isinstance(value, list) and value and all(isinstance(v, str) for v in value):
                    out["enum"] = list(value)
                else:
                    self.drop(path, key, value, "Gemini enum'u yalnizca string degerlerle destekler")
                continue

            # --- desteklenmeyen her sey ---
            if key == "default":
                # Kaybolmasin: asagida description'a metin olarak eklenecek.
                default_value = value
                self.drop(path, key, value, "desteklenmiyor — description'a metin olarak tasindi")
                continue

            self.drop(path, key, value, "Gemini functionDeclarations bu anahtari kabul etmez")

        # --- ceviri sonrasi duzeltmeler ---

        # (1) enum var ama type yok: sozlesmede `{"enum": [...]}` bicimi bol.
        #     Gemini enum'u type olmadan degerlendiremez; STRING'e sabitleriz.
        if "enum" in out and "type" not in out:
            out["type"] = "string"
            self.note("enum var ama type yoktu -> type='string' eklendi (Gemini enum'u tipsiz kabul etmez)")

        # (2) default degeri description'a tasi. Modelin "bos birakirsam ne olur"
        #     bilgisini kaybetmemesi icin TEK yol bu — sema alani yok.
        if default_value is not _MISSING:
            hint = f"Varsayilan: {_render(default_value)}."
            existing = out.get("description")
            if existing:
                # Noktalama yoksa ekleriz; "…veya '$me' Varsayilan: '$me'." gibi
                # iki cumlenin birbirine yapismasi metni okunmaz yapiyor.
                sep = "" if existing.rstrip().endswith((".", "!", "?", ":")) else "."
                out["description"] = f"{existing.rstrip()}{sep} {hint}"
            else:
                out["description"] = hint

        return out


_MISSING = object()


def _render(value: Any) -> str:
    """default degerini description icine gomulecek kisa metne cevirir."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return "null"
    if isinstance(value, str):
        return f"'{value}'"
    if isinstance(value, (list, tuple)):
        return "[" + ", ".join(_render(v) for v in value) + "]"
    return str(value)


# ── genel API ───────────────────────────────────────────────────────────────


def translate_schema(schema: Any) -> SchemaTranslation:
    """MCP inputSchema'sini Gemini'nin kabul ettigi semaya cevirir.

    SAF fonksiyondur: girdiyi DEGISTIRMEZ, hicbir yere yazmaz.
    """
    walker = _Walker()
    converted = walker.walk(schema, "#", 0, at_root=True)
    # Gemini `parameters` icin kok tipin object olmasini bekler; sozlesmede
    # her zaman oyle ama savunmaci davraniyoruz.
    if converted and "type" not in converted:
        converted["type"] = "object"
        walker.note("kok tip belirtilmemisti -> type='object' eklendi")
    return SchemaTranslation(
        schema=converted,
        dropped=tuple(walker.dropped),
        notes=tuple(walker.notes),
    )


def build_function_declarations(
    specs: Iterable[_ToolLike],
    *,
    describe: Any = None,
) -> tuple[list[dict[str, Any]], dict[str, SchemaTranslation]]:
    """Tool sozlesmesini Gemini `functionDeclarations` dizisine cevirir.

    `describe` verilirse tool aciklamasini uretmek icin cagrilir (ornegin
    ogretici notlari ekleyen bir fonksiyon). Verilmezse spec.description
    oldugu gibi kullanilir.

    Doner: (functionDeclarations, tool_adi -> ceviri raporu)
    """
    declarations: list[dict[str, Any]] = []
    reports: dict[str, SchemaTranslation] = {}

    for spec in specs:
        translation = translate_schema(spec.input_schema)
        reports[spec.name] = translation

        declaration: dict[str, Any] = {
            "name": spec.name,
            "description": describe(spec) if describe else spec.description,
        }
        # Parametresiz tool'da `parameters` HIC gonderilmez. Bos bir
        # {"type":"object","properties":{}} gondermek bazi surumlerde
        # "INVALID_ARGUMENT" verir; alani yok saymak her surumde calisir.
        if not translation.is_empty_object:
            declaration["parameters"] = translation.schema
        declarations.append(declaration)

    return declarations, reports


def format_translation_report(reports: Mapping[str, SchemaTranslation]) -> str:
    """stderr'e basilacak Turkce ozet. Bu bir DERS ARTIFAKTIDIR.

    "Ayni sozlesme, iki farkli tool-calling lehcesi" tezinin kanitidir:
    MCP tarafinda beyan edilen kisitlarin hangileri Gemini'ye GECEMEDI.
    """
    lines: list[str] = []
    total = 0
    histogram: dict[str, int] = {}

    for name in sorted(reports):
        translation = reports[name]
        total += len(translation.dropped)
        for d in translation.dropped:
            histogram[d.keyword] = histogram.get(d.keyword, 0) + 1
        if translation.dropped:
            keywords = ", ".join(translation.dropped_keywords)
            lines.append(f"  {name}: {len(translation.dropped)} anahtar atildi -> {keywords}")
        else:
            lines.append(f"  {name}: atilan anahtar yok")

    header = (
        f"Sema cevirisi (MCP JSON Schema 2020-12 -> Gemini OpenAPI alt kumesi): "
        f"{len(reports)} tool, {total} anahtar atildi."
    )
    footer = ""
    if histogram:
        parts = ", ".join(f"{k}x{v}" for k, v in sorted(histogram.items(), key=lambda kv: (-kv[1], kv[0])))
        footer = f"  Toplam dagilim: {parts}"

    all_notes: list[str] = []
    for name in sorted(reports):
        for note in reports[name].notes:
            if note not in all_notes:
                all_notes.append(note)

    out = [header, *lines]
    if footer:
        out.append(footer)
    if all_notes:
        out.append("  Ceviri notlari:")
        out.extend(f"    - {n}" for n in all_notes)
    return "\n".join(out)


def dropped_rows(reports: Mapping[str, SchemaTranslation]) -> Sequence[tuple[str, str, str, Any]]:
    """(tool, yol, anahtar, deger) satirlari — testlerin ve raporlarin okudugu duz hal."""
    rows: list[tuple[str, str, str, Any]] = []
    for name in sorted(reports):
        for d in reports[name].dropped:
            rows.append((name, d.path, d.keyword, d.value))
    return rows


__all__ = [
    "DroppedKeyword",
    "MAX_DEPTH",
    "SUPPORTED_KEYWORDS",
    "SchemaTranslation",
    "build_function_declarations",
    "dropped_rows",
    "format_translation_report",
    "translate_schema",
]
