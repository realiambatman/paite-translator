import json
import os
import urllib.error
import urllib.parse
import urllib.request

from google_quota import check_can_translate, quota_exceeded, record_usage

GOOGLE_TRANSLATE_API_KEY = os.environ.get("GOOGLE_TRANSLATE_API_KEY", "")
GOOGLE_TRANSLATE_URL = "https://translation.googleapis.com/language/translate/v2"


def is_configured() -> bool:
    return bool(GOOGLE_TRANSLATE_API_KEY.strip())


def is_available() -> bool:
    return is_configured() and not quota_exceeded()


def translate(text: str, source: str, target: str) -> str:
    api_key = GOOGLE_TRANSLATE_API_KEY.strip()
    if not api_key:
        raise RuntimeError(
            "Google Translate is not configured. Set GOOGLE_TRANSLATE_API_KEY on the server."
        )

    check_can_translate(text)

    params = urllib.parse.urlencode(
        {
            "q": text,
            "source": source,
            "target": target,
            "format": "text",
            "key": api_key,
        }
    )
    request = urllib.request.Request(
        f"{GOOGLE_TRANSLATE_URL}?{params}",
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("error", {}).get("message", body)
        except json.JSONDecodeError:
            detail = body or str(exc)
        raise RuntimeError(f"Google Translate failed: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Google Translate request failed: {exc.reason}") from exc

    translations = payload.get("data", {}).get("translations", [])
    if not translations:
        raise RuntimeError("Google Translate returned an empty response.")

    record_usage(len(text))
    return translations[0]["translatedText"]
