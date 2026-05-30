"""
TEMPORARY workaround — remove this module when the Paite model handles long
English sentences without copying the source verbatim.

When a Paite translation is nearly identical to the English input, re-translate
by splitting the sentence into smaller clauses and joining the results.
"""

from __future__ import annotations

import os
import re
from difflib import SequenceMatcher
from typing import Callable

ENABLED = os.environ.get("COPY_THROUGH_CHUNK_FALLBACK", "1").strip().lower() not in (
    "0",
    "false",
    "off",
    "no",
)
COPY_THROUGH_RATIO = float(os.environ.get("COPY_THROUGH_RATIO", "0.80"))
MAX_CLAUSE_WORDS = int(os.environ.get("COPY_THROUGH_MAX_CLAUSE_WORDS", "8"))

_SPLIT_PATTERNS = (
    r"\s*,\s*",
    r"\s*;\s*",
    r"\s+\band\b\s+",
    r"\s+\bwith\b\s+",
    r"\s+\bfor\b\s+",
)


def _normalize(text: str) -> str:
    return " ".join(text.split()).lower()


def is_copy_through(source: str, translation: str) -> bool:
    src = _normalize(source)
    out = _normalize(translation)
    if not src or not out:
        return False
    return SequenceMatcher(None, src, out).ratio() >= COPY_THROUGH_RATIO


def split_clauses(text: str) -> list[str]:
    """Break a sentence into smaller spans for a second translation attempt."""
    text = text.strip()
    if not text:
        return []

    for pattern in _SPLIT_PATTERNS:
        parts = [part.strip() for part in re.split(pattern, text, flags=re.I) if part.strip()]
        if len(parts) > 1:
            chunks: list[str] = []
            for part in parts:
                chunks.extend(split_clauses(part))
            return chunks

    words = text.split()
    if len(words) <= MAX_CLAUSE_WORDS:
        return [text]

    return [
        " ".join(words[index : index + MAX_CLAUSE_WORDS])
        for index in range(0, len(words), MAX_CLAUSE_WORDS)
    ]


def try_chunk_fallback(
    source: str,
    initial_output: str,
    translate_one: Callable[[str], str],
) -> str | None:
    if not ENABLED or not is_copy_through(source, initial_output):
        return None

    clauses = split_clauses(source)
    if len(clauses) <= 1:
        return None

    translated = [translate_one(clause) for clause in clauses]
    joined = " ".join(part.strip() for part in translated if part.strip())
    if not joined or is_copy_through(source, joined):
        return None

    print("Copy-through chunk fallback applied")
    return joined
