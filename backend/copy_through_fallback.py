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
AGGRESSIVE_MAX_WORDS = int(os.environ.get("COPY_THROUGH_AGGRESSIVE_WORDS", "4"))
MAX_RESPLIT_DEPTH = 2

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


def split_word_chunks(text: str, max_words: int) -> list[str]:
    text = text.strip()
    words = text.split()
    if not words:
        return []
    if len(words) <= max_words:
        return [text]
    return [
        " ".join(words[index : index + max_words])
        for index in range(0, len(words), max_words)
    ]


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

    return split_word_chunks(text, MAX_CLAUSE_WORDS)


def _join_parts(parts: list[str]) -> str:
    return " ".join(part.strip() for part in parts if part.strip())


def _translate_clause_resilient(
    clause: str,
    translate_one: Callable[[str], str],
    depth: int = 0,
) -> str:
    output = translate_one(clause)
    if not is_copy_through(clause, output) or len(clause.split()) <= 1:
        return output
    if depth >= MAX_RESPLIT_DEPTH:
        return output

    chunk_size = AGGRESSIVE_MAX_WORDS if depth else max(AGGRESSIVE_MAX_WORDS, MAX_CLAUSE_WORDS // 2)
    subclauses = split_word_chunks(clause, chunk_size)
    if len(subclauses) <= 1:
        return output

    suboutputs = [
        _translate_clause_resilient(subclause, translate_one, depth + 1)
        for subclause in subclauses
    ]
    joined = _join_parts(suboutputs)
    if not joined or is_copy_through(clause, joined):
        return output
    return joined


def _attempt_chunk_strategy(
    source: str,
    clauses: list[str],
    translate_one: Callable[[str], str],
) -> str | None:
    if len(clauses) <= 1:
        return None

    translated = [_translate_clause_resilient(clause, translate_one) for clause in clauses]
    joined = _join_parts(translated)
    if not joined or is_copy_through(source, joined):
        return None
    return joined


def try_chunk_fallback(
    source: str,
    initial_output: str,
    translate_one: Callable[[str], str],
) -> str | None:
    if not ENABLED or not is_copy_through(source, initial_output):
        return None

    strategies = [
        split_clauses(source),
        split_word_chunks(source, MAX_CLAUSE_WORDS),
        split_word_chunks(source, AGGRESSIVE_MAX_WORDS),
    ]

    for clauses in strategies:
        result = _attempt_chunk_strategy(source, clauses, translate_one)
        if result:
            print("Copy-through chunk fallback applied")
            return result

    return None
