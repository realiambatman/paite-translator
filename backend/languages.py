"""Language registry: Paite via HF NLLB, everything else via Google Translate."""

ENGLISH = "eng_Latn"
PAITE = "pai_Latn"

COMMON_LANGUAGE_ORDER = [
    ENGLISH,
    PAITE,
    "lus_Latn",
    "mni_Beng",
    "mya_Mymr",
    "hin_Deva",
]

LANGUAGES: dict[str, dict] = {
    ENGLISH: {"label": "English", "google": "en", "provider": "hf", "common": True},
    PAITE: {"label": "Paite", "google": None, "provider": "hf", "common": True},
    "lus_Latn": {"label": "Mizo", "google": "lus", "provider": "google", "common": True},
    "mni_Beng": {
        "label": "Meitei",
        "google": "mni-Mtei",
        "provider": "google",
        "common": True,
    },
    "mya_Mymr": {"label": "Burmese", "google": "my", "provider": "google", "common": True},
    "hin_Deva": {"label": "Hindi", "google": "hi", "provider": "google", "common": True},
    "asm_Beng": {"label": "Assamese", "google": "as", "provider": "google", "common": False},
    "ben_Beng": {"label": "Bengali", "google": "bn", "provider": "google", "common": False},
    "brx_Deva": {"label": "Bodo", "google": "brx", "provider": "google", "common": False},
    "zho_Hans": {"label": "Chinese", "google": "zh-CN", "provider": "google", "common": False},
    "fra_Latn": {"label": "French", "google": "fr", "provider": "google", "common": False},
    "ind_Latn": {"label": "Indonesian", "google": "id", "provider": "google", "common": False},
    "kha_Latn": {"label": "Khasi", "google": "kha", "provider": "google", "common": False},
    "trp_Latn": {"label": "Kokborok", "google": "trp", "provider": "google", "common": False},
    "rus_Cyrl": {"label": "Russian", "google": "ru", "provider": "google", "common": False},
    "spa_Latn": {"label": "Spanish", "google": "es", "provider": "google", "common": False},
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


def _language_entry(code: str, meta: dict) -> dict:
    return {
        "code": code,
        "label": meta["label"],
        "provider": meta["provider"],
        "common": bool(meta.get("common")),
    }


def languages_for_api() -> list[dict]:
    common = [
        _language_entry(code, LANGUAGES[code]) for code in COMMON_LANGUAGE_ORDER
    ]
    others = sorted(
        [
            _language_entry(code, meta)
            for code, meta in LANGUAGES.items()
            if not meta.get("common")
        ],
        key=lambda entry: entry["label"].lower(),
    )
    return common + others


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
