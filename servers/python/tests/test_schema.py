"""llm/schema.py birim testleri — MCP JSON Schema 2020-12 -> Gemini alt kumesi.

CALISTIRMA (iki yol da desteklenir):
    uv run pytest tests/test_schema.py -q
    uv run python tests/test_schema.py        # pytest yoksa duz assert kosucusu

Testin ISI: sozlesmedeki 8 tool'un HEPSININ cevrilebildigini ve NE ATILDIGININ
listelenebildigini kanitlamak. Bu bir ders artifaktidir: "ayni sozlesme, iki
farkli tool-calling lehcesi" tezinin olculebilir kaniti.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

# `uv run python tests/test_schema.py` ile dogrudan calistirildiginda paket
# kurulu olmayabilir; src'i yola ekleriz. Kurulu ise bu satir zararsizdir.
_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from xurrent_mcp.llm.schema import (  # noqa: E402
    MAX_DEPTH,
    SUPPORTED_KEYWORDS,
    build_function_declarations,
    dropped_rows,
    format_translation_report,
    translate_schema,
)
from xurrent_mcp.tools import TOOLS  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT = REPO_ROOT / "contract" / "tools.json"


def _contract_tools() -> list[dict]:
    return json.loads(CONTRACT.read_text(encoding="utf-8"))["tools"]


# ── 1. Sozlesmedeki 8 tool'un hepsi cevrilebilmeli ──────────────────────────


def test_contract_has_eight_tools() -> None:
    assert len(_contract_tools()) == 8
    assert len(TOOLS) == 8


def test_every_contract_tool_translates() -> None:
    """contract/tools.json'daki her input semasi hatasiz cevrilir."""
    for tool in _contract_tools():
        translation = translate_schema(tool["input"])
        # Kok her zaman object olmali.
        assert translation.schema.get("type") == "object", tool["name"]
        # Ceviri sonrasi HICBIR desteklenmeyen anahtar kalmamali.
        _assert_only_supported(translation.schema, tool["name"])


def test_every_server_tool_translates() -> None:
    """Sunucunun kendi TOOLS kaydi da ayni sekilde cevrilir (sapma testi)."""
    declarations, reports = build_function_declarations(TOOLS)
    assert len(declarations) == 8
    assert set(reports) == {spec.name for spec in TOOLS}
    for decl in declarations:
        assert decl["name"]
        assert decl["description"]
        if "parameters" in decl:
            _assert_only_supported(decl["parameters"], decl["name"])


def _assert_only_supported(node: object, where: str) -> None:
    """Cevrilmis agacta yalnizca izinli anahtarlar bulunabilir."""
    allowed = set(SUPPORTED_KEYWORDS) | {"defs", "ref"}
    if isinstance(node, dict):
        for key, value in node.items():
            assert key in allowed, f"{where}: desteklenmeyen anahtar cevirde kaldi -> {key}"
            if key == "properties":
                for child in value.values():
                    _assert_only_supported(child, where)
            elif key == "defs":
                for child in value.values():
                    _assert_only_supported(child, where)
            elif key == "items":
                _assert_only_supported(value, where)


# ── 2. Atilan anahtarlar listelenebilmeli ───────────────────────────────────


def test_dropped_keywords_are_recorded() -> None:
    """Sozlesmedeki bilinen kisitlar ATILIR ve KAYDA GECER."""
    _, reports = build_function_declarations(TOOLS)
    rows = dropped_rows(reports)
    dropped_keywords = {keyword for _, _, keyword, _ in rows}

    # Bu alanlar sozlesmede kesin var; ceviride kesin dusmeli.
    for expected in ("additionalProperties", "default", "pattern", "maxLength",
                     "minimum", "maximum", "minItems", "maxItems"):
        assert expected in dropped_keywords, f"'{expected}' atilanlar arasinda yok"

    # Her atilan satir bir gerekce tasimali (bos gerekce = sessiz kayip).
    for name, translation in reports.items():
        for d in translation.dropped:
            assert d.reason, f"{name}: {d.keyword} icin gerekce yok"
            assert d.path.startswith("#"), f"{name}: yol '#' ile baslamali"


def test_report_is_printable() -> None:
    _, reports = build_function_declarations(TOOLS)
    text = format_translation_report(reports)
    assert "Sema cevirisi" in text
    for spec in TOOLS:
        assert spec.name in text


# ── 3. default -> description tasimasi ──────────────────────────────────────


def test_default_moves_into_description() -> None:
    """`default` kaybolmaz; description'a metin olarak eklenir."""
    out = translate_schema(
        {
            "type": "object",
            "properties": {
                "personId": {"type": "string", "default": "$me", "description": "Person node ID"},
                "first": {"type": "integer", "default": 25},
            },
        }
    ).schema
    assert out["properties"]["personId"]["description"] == "Person node ID. Varsayilan: '$me'."
    assert out["properties"]["first"]["description"] == "Varsayilan: 25."
    assert "default" not in out["properties"]["personId"]


def test_boolean_and_list_defaults_render() -> None:
    out = translate_schema(
        {
            "type": "object",
            "properties": {
                "dryRun": {"type": "boolean", "default": False},
                "include": {"type": "array", "default": ["requests", "tasks"]},
            },
        }
    ).schema
    assert out["properties"]["dryRun"]["description"] == "Varsayilan: false."
    assert out["properties"]["include"]["description"] == "Varsayilan: ['requests', 'tasks']."


# ── 4. enum tipsiz gelirse string'e sabitlenir ──────────────────────────────


def test_bare_enum_gets_string_type() -> None:
    """Sozlesmede `{"enum": [...]}` bicimi var; Gemini tipsiz enum kabul etmez."""
    out = translate_schema({"type": "object", "properties": {"view": {"enum": ["all", "current_account"]}}}).schema
    view = out["properties"]["view"]
    assert view["type"] == "string"
    assert view["enum"] == ["all", "current_account"]


def test_non_string_enum_is_dropped() -> None:
    """Sayisal enum sessizce string'e cevrilmez — dusurulur ve kaydedilir."""
    t = translate_schema({"type": "object", "properties": {"n": {"type": "integer", "enum": [5, 10]}}})
    assert "enum" not in t.schema["properties"]["n"]
    assert any(d.keyword == "enum" for d in t.dropped)


# ── 5. $defs / $ref -> defs / ref ───────────────────────────────────────────


def test_dollar_defs_and_ref_are_rewritten() -> None:
    t = translate_schema(
        {
            "type": "object",
            "$defs": {"Person": {"type": "object", "properties": {"id": {"type": "string"}}}},
            "properties": {"who": {"$ref": "#/$defs/Person"}},
        }
    )
    assert "defs" in t.schema and "$defs" not in t.schema
    assert t.schema["defs"]["Person"]["type"] == "object"
    assert t.schema["properties"]["who"] == {"ref": "#/defs/Person"}


def test_external_or_deep_ref_is_dropped() -> None:
    """Dis referans ve derin yol REDDEDILIR — Gemini cozemez, tum semayi reddeder."""
    for bad in ("https://example.com/schema.json", "#/properties/foo", "#/$defs/A/B"):
        t = translate_schema({"type": "object", "properties": {"x": {"$ref": bad}}})
        assert t.schema["properties"]["x"] == {}, bad
        assert any(d.keyword == "$ref" for d in t.dropped), bad


def test_defs_outside_root_is_dropped() -> None:
    """`defs` yalnizca KOK seviyede olabilir."""
    t = translate_schema(
        {"type": "object", "properties": {"x": {"type": "object", "$defs": {"A": {"type": "string"}}}}}
    )
    assert "defs" not in t.schema["properties"]["x"]
    assert any(d.keyword == "$defs" for d in t.dropped)


# ── 6. tip birlesimi ve derinlik ────────────────────────────────────────────


def test_union_type_picks_first_and_records() -> None:
    t = translate_schema({"type": "object", "properties": {"n": {"type": ["string", "null"]}}})
    assert t.schema["properties"]["n"]["type"] == "string"
    assert any(d.keyword == "type" for d in t.dropped)


def test_depth_limit_is_enforced() -> None:
    """MAX_DEPTH asilirsa alt agac kesilir ve kayda gecer."""
    node: dict = {"type": "string"}
    for _ in range(MAX_DEPTH + 4):
        node = {"type": "object", "properties": {"n": node}}
    t = translate_schema(node)
    assert any(d.keyword == "(derinlik)" for d in t.dropped)


# ── 7. parametresiz tool ────────────────────────────────────────────────────


def test_empty_object_tool_omits_parameters() -> None:
    """xurrent_whoami parametresizdir; `parameters` HIC gonderilmemeli."""
    declarations, _ = build_function_declarations(TOOLS)
    whoami = next(d for d in declarations if d["name"] == "xurrent_whoami")
    assert "parameters" not in whoami

    with_args = next(d for d in declarations if d["name"] == "xurrent_create_time_entry")
    assert with_args["parameters"]["type"] == "object"
    assert "minutes" in with_args["parameters"]["properties"]
    assert with_args["parameters"]["required"] == ["targetType", "targetId", "minutes"]


# ── 8. saflik: girdi DEGISTIRILMEZ ──────────────────────────────────────────


def test_translation_does_not_mutate_input() -> None:
    original = {
        "type": "object",
        "additionalProperties": False,
        "properties": {"a": {"type": "string", "default": "x", "maxLength": 3}},
    }
    snapshot = json.dumps(original, sort_keys=True)
    translate_schema(original)
    assert json.dumps(original, sort_keys=True) == snapshot


# ── duz kosucu (pytest olmadan da calisir) ──────────────────────────────────


def _main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {name}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"HATA {name}: {type(exc).__name__}: {exc}")
        else:
            print(f"ok   {name}")

    print(f"\n{len(tests) - failed} gecti, {failed} basarisiz")

    # Ders artifakti: ceviri raporunu da bas.
    _, reports = build_function_declarations(TOOLS)
    print()
    print(format_translation_report(reports))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_main())
