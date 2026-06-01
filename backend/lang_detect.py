"""Detect likely document language and compare with the selected source language."""

from __future__ import annotations

import re
from dataclasses import dataclass

from languages import LANGUAGES, language_label

SCRIPT_PATTERNS: dict[str, str] = {
    "devanagari": r"[\u0900-\u097F]",
    "bengali": r"[\u0980-\u09FF]",
    "myanmar": r"[\u1000-\u109F]",
    "cyrillic": r"[\u0400-\u04FF]",
    "han": r"[\u4E00-\u9FFF]",
    "latin": r"[A-Za-z]",
}

LANG_SCRIPTS: dict[str, set[str]] = {
    "eng_Latn": {"latin"},
    "pai_Latn": {"latin"},
    "lus_Latn": {"latin"},
    "spa_Latn": {"latin"},
    "fra_Latn": {"latin"},
    "ind_Latn": {"latin"},
    "kha_Latn": {"latin"},
    "trp_Latn": {"latin"},
    "hin_Deva": {"devanagari", "latin"},
    "brx_Deva": {"devanagari", "latin"},
    "mni_Beng": {"bengali", "latin"},
    "asm_Beng": {"bengali", "latin"},
    "ben_Beng": {"bengali", "latin"},
    "mya_Mymr": {"myanmar", "latin"},
    "rus_Cyrl": {"cyrillic", "latin"},
    "zho_Hans": {"han", "latin"},
}

SCRIPT_TO_LANGS: dict[str, list[str]] = {
    "latin": ["eng_Latn", "pai_Latn", "lus_Latn"],
    "devanagari": ["hin_Deva", "brx_Deva"],
    "bengali": ["ben_Beng", "asm_Beng", "mni_Beng"],
    "myanmar": ["mya_Mymr"],
    "cyrillic": ["rus_Cyrl"],
    "han": ["zho_Hans"],
}

SCRIPT_LABELS = {
    "latin": "Latin",
    "devanagari": "Devanagari (Hindi/Bodo)",
    "bengali": "Bengali (Bengali/Assamese/Meitei)",
    "myanmar": "Myanmar (Burmese)",
    "cyrillic": "Cyrillic (Russian)",
    "han": "Chinese",
}

# Latin languages that OCR/detection often confuse — do not warn within this set.
LATIN_COMPATIBLE = {
    "eng_Latn",
    "pai_Latn",
    "lus_Latn",
    "kha_Latn",
    "trp_Latn",
}

LANGDETECT_TO_CODE = {
    "en": "eng_Latn",
    "hi": "hin_Deva",
    "bn": "ben_Beng",
    "my": "mya_Mymr",
    "ru": "rus_Cyrl",
    "zh-cn": "zho_Hans",
    "zh-tw": "zho_Hans",
    "fr": "fra_Latn",
    "es": "spa_Latn",
    "id": "ind_Latn",
}


@dataclass(frozen=True)
class LanguageCheck:
    matches_source: bool
    detected_script: str | None
    message: str | None
    suggested_languages: list[dict[str, str]]


def _script_scores(text: str) -> dict[str, int]:
    scores = {name: len(re.findall(pattern, text)) for name, pattern in SCRIPT_PATTERNS.items()}
    return {name: count for name, count in scores.items() if count > 0}


def _dominant_script(scores: dict[str, int]) -> tuple[str | None, float]:
    if not scores:
        return None, 0.0
    total = sum(scores.values())
    script = max(scores, key=scores.get)
    return script, scores[script] / total


def _suggested_for_script(script: str, src_lang: str) -> list[dict[str, str]]:
    codes = SCRIPT_TO_LANGS.get(script, [])
    suggestions: list[dict[str, str]] = []
    for code in codes:
        if code == src_lang:
            continue
        suggestions.append({"code": code, "label": language_label(code)})
    return suggestions


def _langdetect_guess(text: str) -> str | None:
    try:
        from langdetect import DetectorFactory, detect

        DetectorFactory.seed = 0
        detected = detect(text[:2000]).lower()
    except Exception:
        return None
    return LANGDETECT_TO_CODE.get(detected)


def check_language_match(text: str, src_lang: str) -> LanguageCheck:
    stripped = text.strip()
    if len(stripped) < 12:
        return LanguageCheck(True, None, None, [])

    if src_lang not in LANGUAGES:
        return LanguageCheck(True, None, None, [])

    scores = _script_scores(stripped)
    dominant_script, dominant_ratio = _dominant_script(scores)
    expected_scripts = LANG_SCRIPTS.get(src_lang, {"latin"})
    src_label = language_label(src_lang)

    if (
        dominant_script
        and dominant_script not in expected_scripts
        and dominant_ratio >= 0.2
    ):
        suggestions = _suggested_for_script(dominant_script, src_lang)
        script_label = SCRIPT_LABELS.get(dominant_script, dominant_script)
        if suggestions:
            names = ", ".join(item["label"] for item in suggestions[:3])
            message = (
                f"This looks like {script_label} text ({names}), "
                f"but {src_label} is selected as the source language."
            )
        else:
            message = (
                f"This looks like {script_label} text, "
                f"but {src_label} is selected as the source language."
            )
        return LanguageCheck(
            matches_source=False,
            detected_script=dominant_script,
            message=message,
            suggested_languages=suggestions,
        )

    if dominant_script == "latin" or not dominant_script:
        guessed = _langdetect_guess(stripped)
        if (
            guessed
            and guessed != src_lang
            and not (
                guessed in LATIN_COMPATIBLE and src_lang in LATIN_COMPATIBLE
            )
        ):
            guessed_label = language_label(guessed)
            return LanguageCheck(
                matches_source=False,
                detected_script="latin",
                message=(
                    f"This looks like {guessed_label}, "
                    f"but {src_label} is selected as the source language."
                ),
                suggested_languages=[
                    {"code": guessed, "label": guessed_label},
                ],
            )

    return LanguageCheck(
        matches_source=True,
        detected_script=dominant_script,
        message=None,
        suggested_languages=[],
    )


def language_check_payload(text: str, src_lang: str) -> dict:
    result = check_language_match(text, src_lang)
    return {
        "matches_source": result.matches_source,
        "detected_script": result.detected_script,
        "message": result.message,
        "suggested_languages": result.suggested_languages,
    }
