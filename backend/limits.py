import os
import re

MAX_TRANSLATION_TOKENS = int(os.environ.get("MAX_TRANSLATION_TOKENS", "200"))


def max_chars_for_tokens(tokens: int) -> int:
    return tokens * 4


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

    tokens = estimate_tokens(stripped)
    if tokens > MAX_TRANSLATION_TOKENS:
        max_chars = max_chars_for_tokens(MAX_TRANSLATION_TOKENS)
        raise ValueError(
            f"Text is too long (maximum about {max_chars} characters). "
            "Please shorten your text."
        )


def limits_info() -> dict:
    return {
        "max_tokens": MAX_TRANSLATION_TOKENS,
        "max_chars": max_chars_for_tokens(MAX_TRANSLATION_TOKENS),
        "single_sentence_only": False,
    }
