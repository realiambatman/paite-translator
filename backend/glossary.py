"""Glossary overrides: admin-managed find/replace rules applied to model output.

Rules live in the Firestore `glossary` collection (read via the admin service
account) so they can be edited from the admin panel without a redeploy:

    {
      "tgt_lang": "pai_Latn",          # output language the rule applies to
      "src_lang": "eng_Latn" | null,   # optional: only for this source language
      "find": "Lord",                  # whole word/phrase, case-insensitive
      "replace": "Topa",
      "enabled": true,
      "note": "church term"
    }
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass

GLOSSARY_COLLECTION = os.environ.get("FIREBASE_GLOSSARY_COLLECTION", "glossary").strip() or "glossary"
GLOSSARY_TTL_SECONDS = int(os.environ.get("GLOSSARY_TTL_SECONDS", "60"))


@dataclass(frozen=True)
class Rule:
    id: str
    tgt_lang: str
    src_lang: str | None
    find: str
    replace: str
    enabled: bool = True
    note: str | None = None

    @property
    def pattern(self) -> re.Pattern[str]:
        return _compile(self.find)


_compiled: dict[str, re.Pattern[str]] = {}


def _compile(find: str) -> re.Pattern[str]:
    pattern = _compiled.get(find)
    if pattern is None:
        escaped = re.escape(find.strip())
        # Word boundaries only where the term starts/ends with a word char.
        prefix = r"(?<!\w)" if find[:1].isalnum() else ""
        suffix = r"(?!\w)" if find[-1:].isalnum() else ""
        pattern = re.compile(prefix + escaped + suffix, re.IGNORECASE)
        _compiled[find] = pattern
    return pattern


_lock = threading.Lock()
_rules: list[Rule] = []
_loaded_at = 0.0
_available: bool | None = None


def _firestore_rules() -> list[Rule]:
    from admin import firestore_client as fs

    if not fs.is_configured():
        return []
    docs = fs.get_client().collection(GLOSSARY_COLLECTION).stream()
    rules: list[Rule] = []
    for doc in docs:
        data = doc.to_dict() or {}
        find = str(data.get("find") or "").strip()
        replace = str(data.get("replace") or "")
        tgt_lang = str(data.get("tgt_lang") or "").strip()
        if not find or not tgt_lang:
            continue
        rules.append(
            Rule(
                id=doc.id,
                tgt_lang=tgt_lang,
                src_lang=(str(data["src_lang"]).strip() or None) if data.get("src_lang") else None,
                find=find,
                replace=replace,
                enabled=bool(data.get("enabled", True)),
                note=data.get("note"),
            )
        )
    # Longer terms first so "Lord God" wins over "Lord".
    rules.sort(key=lambda r: len(r.find), reverse=True)
    return rules


def is_available() -> bool:
    try:
        from admin import firestore_client as fs

        return fs.is_configured()
    except Exception:
        return False


def rules(force: bool = False) -> list[Rule]:
    """Cached rules; failures keep the previous set so translation never breaks."""
    global _rules, _loaded_at
    now = time.time()
    if not force and _rules is not None and now - _loaded_at < GLOSSARY_TTL_SECONDS and _loaded_at:
        return _rules
    with _lock:
        if not force and _loaded_at and now - _loaded_at < GLOSSARY_TTL_SECONDS:
            return _rules
        try:
            _rules = _firestore_rules()
        except Exception as exc:
            print(f"Glossary load failed (keeping {len(_rules)} cached rules): {exc}", flush=True)
        _loaded_at = time.time()
        return _rules


def invalidate() -> None:
    global _loaded_at
    _loaded_at = 0.0


def _match_case(source: str, replacement: str) -> str:
    if source.isupper() and len(source) > 1:
        return replacement.upper()
    if source[:1].isupper():
        return replacement[:1].upper() + replacement[1:]
    return replacement


def apply(text: str, src_lang: str, tgt_lang: str) -> str:
    if not text:
        return text
    active = [
        r
        for r in rules()
        if r.enabled and r.tgt_lang == tgt_lang and (r.src_lang is None or r.src_lang == src_lang)
    ]
    for rule in active:
        text = rule.pattern.sub(lambda m, rule=rule: _match_case(m.group(0), rule.replace), text)
    return text
