"""Light input normalisation so inference text matches typical training data.

Keeps line breaks (document structure matters downstream) but unifies the
Unicode form, quotes, dashes and whitespace that OCR, phones and copy-paste
produce in many variants.
"""

from __future__ import annotations

import re
import unicodedata

_QUOTES = {
    "‘": "'",
    "’": "'",
    "‚": "'",
    "‛": "'",
    "′": "'",
    "“": '"',
    "”": '"',
    "„": '"',
    "‟": '"',
    "″": '"',
    "«": '"',
    "»": '"',
}
_DASHES = {
    "‐": "-",
    "‑": "-",
    "‒": "-",
    "–": "-",
    "—": " - ",
    "―": " - ",
    "−": "-",
}
_INVISIBLE = re.compile(r"[​‌‍⁠﻿­]")
_SPACES = re.compile(r"[ \t  -   　]+")
_ELLIPSIS = "…"

_TRANSLATE_TABLE = str.maketrans({**_QUOTES, **_DASHES})


def normalize_input(text: str) -> str:
    if not text:
        return text
    text = unicodedata.normalize("NFC", text)
    text = _INVISIBLE.sub("", text)
    text = text.replace(_ELLIPSIS, "...")
    text = text.translate(_TRANSLATE_TABLE)
    lines = []
    for line in text.split("\n"):
        line = _SPACES.sub(" ", line).strip()
        # Tidy space before punctuation that OCR often inserts: "word ." -> "word."
        line = re.sub(r"\s+([,.;:!?])", r"\1", line)
        lines.append(line)
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()
