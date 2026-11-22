"""Is the text typed on the Zo tab English?

Our own model translates well from English and poorly between two Zo languages, so text that is not English
is translated into English only (see /api/zo/translate). The check needs no model and no outside service:
it counts words that only English uses against words that only the Zo languages use. The two lists are made
from our own corpora by scripts/build_source_check_words.py.
"""
from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"
WORD = re.compile(r"[a-zâêîôûṭ']+")
OTHER_SCRIPT = re.compile(r"[ऀ-ॿঀ-৿က-႟ꯀ-꯿Ѐ-ӿ一-鿿]")
# Typed alone these are English, though "hi" and "no" are also Zo words inside a sentence.
SHORT_ENGLISH = {"hi", "hello", "hey", "ok", "okay", "bye", "yes", "no", "thanks", "thank", "you", "good", "morning",
                 "evening", "night"}


@lru_cache(maxsize=1)
def _lists() -> tuple[frozenset[str], frozenset[str]]:
    def read(name: str) -> frozenset[str]:
        try:
            return frozenset(w for w in (DATA / name).read_text(encoding="utf-8").split("\n") if w)
        except OSError:   # without the lists every text counts as English: the tab works as it did before
            return frozenset()
    return read("english_only_words.txt"), read("zo_only_words.txt")


def is_english(text: str) -> bool:
    """False only when the text clearly is not English: another script, or more Zo-only than English-only words."""
    letters = len(re.findall(r"[A-Za-z]", text))
    if len(OTHER_SCRIPT.findall(text)) > letters:
        return False
    words = [w.strip("'") for w in WORD.findall(text.lower())]
    words = [w for w in words if w]
    if not words:
        return True
    if len(words) <= 3 and all(w in SHORT_ENGLISH for w in words):
        return True
    english, zo = _lists()
    n_en = sum(w in english for w in words)
    n_zo = sum(w in zo for w in words)
    return n_zo == 0 or n_zo <= n_en
