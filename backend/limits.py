import os
import re

import nltk

MAX_TRANSLATION_TOKENS = int(os.environ.get("MAX_TRANSLATION_TOKENS", "100"))


def _ensure_nltk():
    try:
        nltk.data.find("tokenizers/punkt")
        nltk.data.find("tokenizers/punkt_tab")
    except LookupError:
        nltk.download("punkt", quiet=True)
        nltk.download("punkt_tab", quiet=True)


def count_words(text: str) -> int:
    return len(re.findall(r"\S+", text.strip()))


def estimate_tokens(text: str) -> int:
    stripped = text.strip()
    if not stripped:
        return 0
    return max(count_words(stripped), (len(stripped) + 3) // 4)


def enforce_input_limits(text: str) -> None:
    stripped = text.strip()
    if not stripped:
        return

    if "\n" in stripped:
        raise ValueError(
            "Only one sentence is allowed. Remove line breaks and try again."
        )

    _ensure_nltk()
    sentences = nltk.sent_tokenize(stripped)
    if len(sentences) > 1:
        raise ValueError(
            "Only one sentence at a time is supported to reduce server load."
        )

    tokens = estimate_tokens(stripped)
    if tokens > MAX_TRANSLATION_TOKENS:
        raise ValueError(
            f"Text is about {tokens} tokens (maximum {MAX_TRANSLATION_TOKENS}). "
            "Please shorten your sentence."
        )


def limits_info() -> dict:
    return {
        "max_tokens": MAX_TRANSLATION_TOKENS,
        "single_sentence_only": True,
    }
