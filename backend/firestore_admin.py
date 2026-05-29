import json
import os

_app = None
_db = None


def is_configured() -> bool:
    if os.environ.get("FIREBASE_CREDENTIALS_PATH", "").strip():
        return True
    if os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip():
        return True
    return bool(
        os.environ.get("FIREBASE_CLIENT_EMAIL", "").strip()
        and os.environ.get("FIREBASE_PRIVATE_KEY", "").strip()
        and os.environ.get("FIREBASE_PROJECT_ID", "").strip()
    )


def get_db():
    global _app, _db

    if _db is not None:
        return _db
    if not is_configured():
        return None

    import firebase_admin
    from firebase_admin import credentials, firestore

    if not firebase_admin._apps:
        cred_path = os.environ.get("FIREBASE_CREDENTIALS_PATH", "").strip()
        if cred_path:
            cred = credentials.Certificate(cred_path)
        else:
            raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "").strip()
            if raw:
                cred = credentials.Certificate(json.loads(raw))
            else:
                project_id = os.environ.get("FIREBASE_PROJECT_ID", "").strip()
                client_email = os.environ.get("FIREBASE_CLIENT_EMAIL", "").strip()
                private_key = (
                    os.environ.get("FIREBASE_PRIVATE_KEY", "").replace("\\n", "\n").strip()
                )
                cred = credentials.Certificate(
                    {
                        "type": "service_account",
                        "project_id": project_id,
                        "private_key": private_key,
                        "client_email": client_email,
                        "token_uri": "https://oauth2.googleapis.com/token",
                    }
                )

        project_id = os.environ.get("FIREBASE_PROJECT_ID") or cred.project_id
        _app = firebase_admin.initialize_app(cred, {"projectId": project_id})

    _db = firestore.client()
    return _db
