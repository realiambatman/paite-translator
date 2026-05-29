"""Language registry: Paite via HF NLLB, everything else via Google Translate."""

ENGLISH = "eng_Latn"
PAITE = "pai_Latn"

LANGUAGES: dict[str, dict] = {
    ENGLISH: {"label": "English", "google": "en", "provider": "hf"},
    PAITE: {"label": "Paite", "google": None, "provider": "hf"},
    "lus_Latn": {"label": "Mizo", "google": "lus", "provider": "google"},
    "mni_Beng": {"label": "Meitei", "google": "mni", "provider": "google"},
    "mya_Mymr": {"label": "Burmese", "google": "my", "provider": "google"},
    "hin_Deva": {"label": "Hindi", "google": "hi", "provider": "google"},
}

HF_LANGUAGES = {ENGLISH, PAITE}


def language_codes() -> list[str]:
    return list(LANGUAGES.keys())


def language_label(code: str) -> str:
    entry = LANGUAGES.get(code)
    return entry["label"] if entry else code


def google_code(code: str) -> str | None:
    entry = LANGUAGES.get(code)
    if not entry:
        return None
    return entry.get("google")


def languages_for_api() -> list[dict]:
    return [
        {
            "code": code,
            "label": meta["label"],
            "provider": meta["provider"],
        }
        for code, meta in LANGUAGES.items()
    ]


def uses_google(src: str, tgt: str) -> bool:
    if src == tgt:
        return False
    if src in HF_LANGUAGES and tgt in HF_LANGUAGES:
        return False
    return True


def resolve_route(src: str, tgt: str) -> str:
    """Returns: identity | hf | google | to_paite | from_paite"""
    if src == tgt:
        return "identity"
    if {src, tgt} == HF_LANGUAGES:
        return "hf"
    if tgt == PAITE:
        return "to_paite"
    if src == PAITE:
        return "from_paite"
    return "google"
