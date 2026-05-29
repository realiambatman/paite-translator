import os
import threading
from datetime import date, datetime, timedelta, timezone

from firestore_admin import get_db, is_configured as firestore_configured

_lock = threading.Lock()
_day: date | None = None
_chars_used = 0
_loaded_from_firestore = False

QUOTA_COLLECTION = os.environ.get(
    "FIREBASE_GOOGLE_QUOTA_COLLECTION", "google_translate_quota"
)


def _parse_limit() -> int | None:
    raw = os.environ.get("GOOGLE_DAILY_CHAR_LIMIT", "").strip().lower()
    if not raw or raw in ("0", "unlimited", "none", "off", "false"):
        return None
    return max(1, int(raw))


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _day_key(day: date) -> str:
    return day.isoformat()


def _quota_doc_ref(db, day: date):
    return db.collection(QUOTA_COLLECTION).document(_day_key(day))


def _load_from_firestore(day: date) -> int:
    db = get_db()
    if db is None:
        return 0

    snap = _quota_doc_ref(db, day).get()
    if not snap.exists:
        return 0
    data = snap.to_dict() or {}
    return int(data.get("chars_used") or 0)


def _save_to_firestore(day: date, chars_used: int) -> None:
    db = get_db()
    if db is None:
        return

    from firebase_admin import firestore

    _quota_doc_ref(db, day).set(
        {
            "date": _day_key(day),
            "chars_used": chars_used,
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


def _ensure_day_loaded() -> None:
    global _day, _chars_used, _loaded_from_firestore

    today = _today()
    if _day == today and _loaded_from_firestore:
        return

    _day = today
    _chars_used = _load_from_firestore(today) if firestore_configured() else 0
    _loaded_from_firestore = True


def _reset_if_new_day() -> None:
    global _day, _chars_used, _loaded_from_firestore
    today = _today()
    if _day != today:
        _day = today
        _chars_used = _load_from_firestore(today) if firestore_configured() else 0
        _loaded_from_firestore = True


def daily_char_limit() -> int | None:
    return _parse_limit()


def daily_chars_used() -> int:
    with _lock:
        _reset_if_new_day()
        return _chars_used


def quota_exceeded() -> bool:
    limit = _parse_limit()
    if limit is None:
        return False
    with _lock:
        _reset_if_new_day()
        return _chars_used >= limit


def check_can_translate(text: str) -> None:
    limit = _parse_limit()
    if limit is None:
        return

    needed = len(text)
    with _lock:
        _reset_if_new_day()
        if _chars_used + needed > limit:
            remaining = max(0, limit - _chars_used)
            raise RuntimeError(
                f"Google Translate daily limit reached ({limit} characters). "
                f"Remaining today: {remaining}. English ↔ Paite still works."
            )


def record_usage(text: str) -> None:
    limit = _parse_limit()
    if limit is None:
        return

    chars = len(text)
    with _lock:
        _reset_if_new_day()
        global _chars_used
        _chars_used = min(limit, _chars_used + chars)
        if firestore_configured():
            _save_to_firestore(_day or _today(), _chars_used)


def quota_info() -> dict:
    limit = _parse_limit()
    with _lock:
        _ensure_day_loaded()
        used = _chars_used
    exceeded = limit is not None and used >= limit
    tomorrow = _today() + timedelta(days=1)
    resets_at = datetime.combine(
        tomorrow, datetime.min.time(), tzinfo=timezone.utc
    ).isoformat()

    return {
        "daily_char_limit": limit,
        "daily_chars_used": used,
        "daily_chars_remaining": None if limit is None else max(0, limit - used),
        "quota_exceeded": exceeded,
        "resets_at_utc": resets_at,
        "persisted": firestore_configured(),
    }
