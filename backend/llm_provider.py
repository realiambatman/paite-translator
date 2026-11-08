"""Provider-agnostic text completion for admin tooling (AI review, Simplify English).

The admin panel stores the active provider, model and API keys in the
Firestore document `admin_settings/llm` (readable only through the service
account). Environment variables act as fallbacks:

    ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, LLM_PROVIDER, LLM_MODEL
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass

import httpx

SETTINGS_COLLECTION = "admin_settings"
SETTINGS_DOC = "llm"

PROVIDERS: dict[str, dict] = {
    "anthropic": {
        "label": "Claude (Anthropic)",
        "default_model": "claude-opus-5-5",
        "models": ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-8"],
        "env_key": "ANTHROPIC_API_KEY",
    },
    "openai": {
        "label": "GPT (OpenAI)",
        "default_model": "gpt-5",
        "models": ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-4.1", "gpt-4o"],
        "env_key": "OPENAI_API_KEY",
    },
    "gemini": {
        "label": "Gemini (Google)",
        "default_model": "gemini-2.5-pro",
        "models": ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"],
        "env_key": "GEMINI_API_KEY",
    },
}

_SETTINGS_TTL = 30.0
_lock = threading.Lock()
_cached: dict | None = None
_cached_at = 0.0


@dataclass(frozen=True)
class LLMConfig:
    provider: str
    model: str
    api_key: str

    @property
    def label(self) -> str:
        return PROVIDERS[self.provider]["label"]


class LLMError(RuntimeError):
    pass


def reviewer_id(config: "LLMConfig") -> str:
    """Human-readable reviewer name, e.g. "anthropic/claude-opus-5-5"."""
    return f"{config.provider}/{config.model}"


def reviewer_key(reviewer: str) -> str:
    """Firestore-safe map key for a reviewer id (no dots or slashes)."""
    return reviewer.replace("/", "__").replace(".", "_")


def config_for(provider: str, model: str | None = None) -> "LLMConfig":
    if provider not in PROVIDERS:
        raise LLMError(f"Unknown provider: {provider}")
    api_key = key_for(provider)
    if not api_key:
        raise LLMError(f"No API key saved for {PROVIDERS[provider]['label']}.")
    return LLMConfig(
        provider=provider,
        model=(model or "").strip() or PROVIDERS[provider]["default_model"],
        api_key=api_key,
    )


# --------------------------------------------------------------------------- settings


def _settings_doc():
    from admin import firestore_client as fs

    if not fs.is_configured():
        return None
    return fs.get_client().collection(SETTINGS_COLLECTION).document(SETTINGS_DOC)


def load_settings(force: bool = False) -> dict:
    """Raw stored settings: {provider, model, api_keys: {provider: key}}."""
    global _cached, _cached_at
    now = time.time()
    if not force and _cached is not None and now - _cached_at < _SETTINGS_TTL:
        return _cached
    with _lock:
        data: dict = {}
        try:
            doc = _settings_doc()
            if doc is not None:
                snapshot = doc.get()
                if snapshot.exists:
                    data = snapshot.to_dict() or {}
        except Exception as exc:
            print(f"LLM settings load failed: {exc}", flush=True)
            if _cached is not None:
                return _cached
        _cached = data
        _cached_at = time.time()
        return data


def save_settings(
    *,
    provider: str | None = None,
    model: str | None = None,
    api_keys: dict[str, str] | None = None,
) -> dict:
    doc = _settings_doc()
    if doc is None:
        raise LLMError("Firestore admin credentials are not configured.")
    from google.cloud import firestore

    current = load_settings(force=True)
    update: dict = {"updated_at": firestore.SERVER_TIMESTAMP}
    if provider is not None:
        if provider not in PROVIDERS:
            raise LLMError(f"Unknown provider: {provider}")
        update["provider"] = provider
    if model is not None:
        update["model"] = model.strip()
    if api_keys:
        merged = dict(current.get("api_keys") or {})
        for name, key in api_keys.items():
            if name not in PROVIDERS:
                continue
            key = (key or "").strip()
            if key:
                merged[name] = key
            else:
                merged.pop(name, None)
        update["api_keys"] = merged
    doc.set(update, merge=True)
    return load_settings(force=True)


def _env_key(provider: str) -> str:
    return os.environ.get(PROVIDERS[provider]["env_key"], "").strip()


def key_for(provider: str, settings: dict | None = None) -> str:
    settings = settings if settings is not None else load_settings()
    stored = (settings.get("api_keys") or {}).get(provider, "")
    return (stored or "").strip() or _env_key(provider)


def active_config(settings: dict | None = None) -> LLMConfig | None:
    settings = settings if settings is not None else load_settings()
    provider = (settings.get("provider") or os.environ.get("LLM_PROVIDER") or "").strip()
    if provider not in PROVIDERS:
        # Pick the first provider that has a key anywhere.
        provider = next((p for p in PROVIDERS if key_for(p, settings)), "")
        if not provider:
            return None
    api_key = key_for(provider, settings)
    if not api_key:
        return None
    model = (
        (settings.get("model") or "").strip()
        or os.environ.get("LLM_MODEL", "").strip()
        or PROVIDERS[provider]["default_model"]
    )
    return LLMConfig(provider=provider, model=model, api_key=api_key)


def is_available() -> bool:
    try:
        return active_config() is not None
    except Exception:
        return False


def public_settings() -> dict:
    """Settings safe to return to the admin UI (keys masked)."""
    settings = load_settings(force=True)
    config = active_config(settings)
    keys = {}
    for name in PROVIDERS:
        stored = (settings.get("api_keys") or {}).get(name, "")
        env = _env_key(name)
        value = stored or env
        keys[name] = {
            "configured": bool(value),
            "source": "admin" if stored else ("env" if env else None),
            "hint": f"…{value[-4:]}" if value else None,
        }
    return {
        "provider": config.provider if config else (settings.get("provider") or None),
        "model": config.model if config else (settings.get("model") or None),
        "providers": {
            name: {
                "label": meta["label"],
                "default_model": meta["default_model"],
                "models": meta["models"],
            }
            for name, meta in PROVIDERS.items()
        },
        "keys": keys,
        "available": config is not None,
    }


# --------------------------------------------------------------------------- completion


def complete(
    system: str,
    user: str,
    *,
    max_tokens: int = 4000,
    config: LLMConfig | None = None,
    timeout: float = 120.0,
) -> str:
    config = config or active_config()
    if config is None:
        raise LLMError("No LLM provider configured. Add an API key in the admin panel.")
    if config.provider == "anthropic":
        return _complete_anthropic(config, system, user, max_tokens, timeout)
    if config.provider == "openai":
        return _complete_openai(config, system, user, max_tokens, timeout)
    if config.provider == "gemini":
        return _complete_gemini(config, system, user, max_tokens, timeout)
    raise LLMError(f"Unknown provider: {config.provider}")


def _complete_anthropic(config: LLMConfig, system: str, user: str, max_tokens: int, timeout: float) -> str:
    import anthropic

    client = anthropic.Anthropic(api_key=config.api_key, timeout=timeout, max_retries=2)
    try:
        response = client.messages.create(
            model=config.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": "medium"},
            # Server-side fallback: if a safety classifier declines, the API
            # re-runs the request on a fallback model inside the same call.
            extra_headers={"anthropic-beta": "server-side-fallback-2026-07-01"},
            extra_body={"fallbacks": "default"},
        )
    except anthropic.AuthenticationError as exc:
        raise LLMError("Anthropic rejected the API key.") from exc
    except anthropic.NotFoundError as exc:
        raise LLMError(f"Anthropic model not found: {config.model}") from exc
    except anthropic.RateLimitError as exc:
        raise LLMError("Anthropic rate limit hit. Try again shortly.") from exc
    except anthropic.APIStatusError as exc:
        raise LLMError(f"Anthropic error {exc.status_code}: {exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise LLMError("Could not reach Anthropic.") from exc

    if response.stop_reason == "refusal":
        raise LLMError("Anthropic declined this request.")
    return "".join(block.text for block in response.content if block.type == "text").strip()


def _complete_openai(config: LLMConfig, system: str, user: str, max_tokens: int, timeout: float) -> str:
    payload = {
        "model": config.model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_completion_tokens": max_tokens,
    }
    try:
        response = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {config.api_key}"},
            json=payload,
            timeout=timeout,
        )
    except httpx.HTTPError as exc:
        raise LLMError(f"Could not reach OpenAI: {exc}") from exc
    if response.status_code == 401:
        raise LLMError("OpenAI rejected the API key.")
    if response.status_code >= 400:
        raise LLMError(f"OpenAI error {response.status_code}: {response.text[:300]}")
    data = response.json()
    try:
        return (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError) as exc:
        raise LLMError("Unexpected OpenAI response shape.") from exc


def _complete_gemini(config: LLMConfig, system: str, user: str, max_tokens: int, timeout: float) -> str:
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{config.model}:generateContent"
    )
    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {"maxOutputTokens": max_tokens},
    }
    try:
        response = httpx.post(
            url,
            headers={"x-goog-api-key": config.api_key},
            json=payload,
            timeout=timeout,
        )
    except httpx.HTTPError as exc:
        raise LLMError(f"Could not reach Gemini: {exc}") from exc
    if response.status_code in (401, 403):
        raise LLMError("Gemini rejected the API key.")
    if response.status_code >= 400:
        raise LLMError(f"Gemini error {response.status_code}: {response.text[:300]}")
    data = response.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
        return "".join(part.get("text", "") for part in parts).strip()
    except (KeyError, IndexError) as exc:
        raise LLMError("Unexpected Gemini response shape.") from exc


def extract_json(text: str):
    """Pull the first JSON object/array out of a model reply (tolerates fences)."""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start = min([i for i in (text.find("["), text.find("{")) if i >= 0], default=-1)
    if start < 0:
        raise LLMError("Model reply contained no JSON.")
    depth = 0
    in_string = False
    escape = False
    for idx in range(start, len(text)):
        ch = text[idx]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
            if depth == 0:
                return json.loads(text[start : idx + 1])
    raise LLMError("Model reply had unbalanced JSON.")
