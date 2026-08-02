"""LLM saglayici katmani.

TEK SAGLAYICI: Gemini. Sunucunun geri kalani bu paketin disina bagimli
degildir — `agent.py` yalnizca `gemini.py` ve `schema.py` konusur, tool
uygulamalari LLM'den HIC haberdar degildir.

    gemini.py  -> `generateContent` wire formati (httpx, SDK yok)
    schema.py  -> MCP JSON Schema 2020-12 -> Gemini OpenAPI alt kumesi cevirisi
"""

from __future__ import annotations

from .gemini import (
    DEFAULT_BASE_URL,
    GeminiClient,
    GeminiError,
    GeminiResponse,
    function_response,
    function_responses_turn,
    model_parts,
    user_text,
)
from .schema import (
    SchemaTranslation,
    build_function_declarations,
    format_translation_report,
    translate_schema,
)

__all__ = [
    "DEFAULT_BASE_URL",
    "GeminiClient",
    "GeminiError",
    "GeminiResponse",
    "SchemaTranslation",
    "build_function_declarations",
    "format_translation_report",
    "function_response",
    "function_responses_turn",
    "model_parts",
    "translate_schema",
    "user_text",
]
