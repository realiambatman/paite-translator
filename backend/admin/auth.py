"""Shared-password auth for the admin panel.

Set ADMIN_PASSWORD on the server. The admin page sends it as
`Authorization: Bearer <password>` on every request.
"""

from __future__ import annotations

import os
import secrets

from fastapi import Header, HTTPException


def admin_password() -> str:
    return os.environ.get("ADMIN_PASSWORD", "").strip()


def is_configured() -> bool:
    return bool(admin_password())


def require_admin(authorization: str | None = Header(default=None)) -> None:
    expected = admin_password()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="Admin panel is not configured. Set ADMIN_PASSWORD on the server.",
        )

    supplied = ""
    if authorization and authorization.lower().startswith("bearer "):
        supplied = authorization[7:].strip()

    if not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="Wrong admin password.")
