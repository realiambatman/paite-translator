"""Rewrite English into short, plain sentences before the Paite model sees it."""

from __future__ import annotations

import llm_provider

SYSTEM = (
    "You rewrite English text so a small machine-translation model can translate "
    "it accurately into a low-resource language. Rules: keep every fact and name; "
    "split long sentences into short ones (max ~15 words); replace idioms, slang "
    "and figurative phrases with their literal meaning; prefer common everyday "
    "words; keep the original line breaks and paragraph structure; keep lists and "
    "timestamps as they are. Output only the rewritten text, nothing else."
)


def is_available() -> bool:
    return llm_provider.is_available()


def simplify_english(text: str) -> str:
    text = text.strip()
    if not text:
        return ""
    result = llm_provider.complete(SYSTEM, text, max_tokens=2000)
    return result.strip() or text
