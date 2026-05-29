import os
import threading
from datetime import date, datetime, timedelta, timezone

_lock = threading.Lock()
_day: date | None = None
_chars_used = 0


def _parse_limit() -> int | None:
    raw = os.environ.get("GOOGLE_DAILY_CHAR_LIMIT", "").strip().lower()
    if not raw or raw in ("0", "unlimited", "none", "off", "false"):
        return None
    return max(1, int(raw))


def _today() -> date:
    return datetime.now(timezone.utc).date()


def _reset_if_new_day() -> None:
    global _day, _chars_used
    today = _today()
    if _day != today:
        _day = today
        _chars_used = 0


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


def record_usage(chars: int) -> None:
    limit = _parse_limit()
    if limit is None or chars <= 0:
        return

    with _lock:
        _reset_if_new_day()
        global _chars_used
        _chars_used = min(limit, _chars_used + chars)


def quota_info() -> dict:
    limit = _parse_limit()
    with _lock:
        _reset_if_new_day()
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
    }
