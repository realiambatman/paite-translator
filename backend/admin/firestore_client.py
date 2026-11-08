"""Server-side Firestore access for the admin panel.

Firestore security rules deny reads from the browser (translations are
write-only for visitors), so the admin panel reads through the backend using
a Firebase service account, which bypasses the rules.

Credentials (first one found wins):
  FIREBASE_SERVICE_ACCOUNT_JSON   inline JSON: a service-account key, OR the
                                  "authorized_user" JSON that
                                  `gcloud auth application-default login` writes
                                  (for projects where key creation is blocked)
  FIREBASE_SERVICE_ACCOUNT_FILE   path to either kind of file
  GOOGLE_APPLICATION_CREDENTIALS  standard Google env var (path)

With user credentials the project id cannot be read from the file, so set
FIREBASE_PROJECT_ID (or rely on VITE_FIREBASE_PROJECT_ID, which is already set).
"""

from __future__ import annotations

import json
import os
import threading
from typing import Any

SCOPES = [
    "https://www.googleapis.com/auth/datastore",
    "https://www.googleapis.com/auth/cloud-platform",
]

_lock = threading.Lock()
_client: Any = None
_error: str | None = None

TRANSLATIONS_COLLECTION = os.environ.get(
    "VITE_FIREBASE_TRANSLATIONS_COLLECTION", "translations"
).strip() or "translations"


def _credential_source() -> tuple[str, str] | None:
    inline = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
    if inline:
        return ("json", inline)
    for var in ("FIREBASE_SERVICE_ACCOUNT_FILE", "GOOGLE_APPLICATION_CREDENTIALS"):
        path = os.environ.get(var, "").strip()
        if path:
            return ("file", path)
    return None


def is_configured() -> bool:
    return _credential_source() is not None


def last_error() -> str | None:
    return _error


def get_client():
    """Return a cached google.cloud.firestore.Client, or raise RuntimeError."""
    global _client, _error
    if _client is not None:
        return _client

    with _lock:
        if _client is not None:
            return _client

        source = _credential_source()
        if source is None:
            _error = (
                "Firestore admin credentials missing. Set FIREBASE_SERVICE_ACCOUNT_JSON "
                "or FIREBASE_SERVICE_ACCOUNT_FILE on the server."
            )
            raise RuntimeError(_error)

        try:
            import google.auth
            from google.cloud import firestore
        except ImportError as exc:  # pragma: no cover - dependency missing
            _error = f"google-cloud-firestore is not installed: {exc}"
            raise RuntimeError(_error) from exc

        kind, value = source
        try:
            if kind == "json":
                info = json.loads(value)
            else:
                with open(value, encoding="utf-8") as fh:
                    info = json.load(fh)
            # Handles both "service_account" and "authorized_user" JSON.
            creds, project_id = google.auth.load_credentials_from_dict(info, scopes=SCOPES)
            project_id = project_id or info.get("project_id") or info.get("quota_project_id")
        except Exception as exc:
            _error = f"Could not load Firebase credentials: {exc}"
            raise RuntimeError(_error) from exc

        project_id = (
            os.environ.get("FIREBASE_PROJECT_ID", "").strip()
            or os.environ.get("VITE_FIREBASE_PROJECT_ID", "").strip()
            or project_id
        )
        if not project_id:
            _error = (
                "Firebase project id missing. Set FIREBASE_PROJECT_ID (needed when "
                "using gcloud user credentials instead of a service-account key)."
            )
            raise RuntimeError(_error)

        _client = firestore.Client(project=project_id, credentials=creds)
        _error = None
        return _client


def translations_ref():
    return get_client().collection(TRANSLATIONS_COLLECTION)
