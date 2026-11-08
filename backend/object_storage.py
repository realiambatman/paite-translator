"""MinIO / S3-compatible object storage for uploaded files and camera captures."""

from __future__ import annotations

import mimetypes
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

STORAGE_PREFIX = os.environ.get("AWS_STORAGE_PREFIX", "paite-translator/uploads").strip("/")


@dataclass(frozen=True)
class StoredObject:
    key: str
    url: str
    bucket: str


def is_configured() -> bool:
    return bool(
        os.environ.get("AWS_ACCESS_KEY_ID")
        and os.environ.get("AWS_SECRET_ACCESS_KEY")
        and os.environ.get("AWS_BUCKET")
        and (
            os.environ.get("AWS_ENDPOINT")
            or os.environ.get("AWS_URL")
        )
    )


def _use_path_style() -> bool:
    return os.environ.get("AWS_USE_PATH_STYLE_ENDPOINT", "true").strip().lower() in (
        "1",
        "true",
        "yes",
    )


def _client():
    config = (
        Config(s3={"addressing_style": "path"}) if _use_path_style() else None
    )
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("AWS_ENDPOINT"),
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        region_name=os.environ.get("AWS_DEFAULT_REGION", "us-east-1"),
        config=config,
    )


def _safe_filename(filename: str) -> str:
    base = os.path.basename(filename).strip() or "upload"
    cleaned = re.sub(r"[^\w.\-]+", "_", base, flags=re.UNICODE)
    return cleaned[:120] or "upload"


def _guess_content_type(filename: str) -> str:
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def _public_url(key: str) -> str:
    base = os.environ.get("AWS_URL", "").rstrip("/")
    if base:
        return f"{base}/{key.lstrip('/')}"

    endpoint = os.environ.get("AWS_ENDPOINT", "").rstrip("/")
    bucket = os.environ["AWS_BUCKET"]
    if _use_path_style():
        return f"{endpoint}/{bucket}/{key.lstrip('/')}"
    return f"{endpoint}/{key.lstrip('/')}"


def upload_bytes(
    content: bytes,
    filename: str,
    *,
    content_type: str | None = None,
    source: str = "upload",
) -> StoredObject | None:
    if not is_configured():
        return None

    bucket = os.environ["AWS_BUCKET"]
    now = datetime.now(timezone.utc)
    safe_name = _safe_filename(filename)
    source_part = "camera" if source == "camera" else "files"
    key = (
        f"{STORAGE_PREFIX}/{source_part}/{now:%Y/%m}/"
        f"{uuid.uuid4().hex}-{safe_name}"
    )
    mime = content_type or _guess_content_type(filename)

    try:
        client = _client()
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=content,
            ContentType=mime,
            Metadata={
                "original_filename": safe_name,
                "source": source_part,
            },
        )
    except (BotoCoreError, ClientError) as exc:
        print(f"Object storage upload failed: {exc}", flush=True)
        return None

    return StoredObject(key=key, url=_public_url(key), bucket=bucket)


def key_from_url(url: str) -> str | None:
    """Recover the object key from a public URL produced by _public_url()."""
    if not url or not is_configured():
        return None

    candidates: list[str] = []
    base = os.environ.get("AWS_URL", "").rstrip("/")
    if base:
        candidates.append(base + "/")
    endpoint = os.environ.get("AWS_ENDPOINT", "").rstrip("/")
    bucket = os.environ.get("AWS_BUCKET", "")
    if endpoint and bucket:
        candidates.append(f"{endpoint}/{bucket}/")
    if endpoint:
        candidates.append(endpoint + "/")

    for prefix in candidates:
        if url.startswith(prefix):
            key = url[len(prefix):].split("?", 1)[0]
            return key or None

    # Fallback: locate the configured storage prefix anywhere in the URL.
    marker = f"/{STORAGE_PREFIX}/"
    idx = url.find(marker)
    if idx >= 0:
        return url[idx + 1 :].split("?", 1)[0]
    return None


def presigned_url(key: str, expires_seconds: int = 3600) -> str | None:
    """Short-lived GET link so the admin panel can show private objects."""
    if not is_configured() or not key:
        return None
    try:
        return _client().generate_presigned_url(
            "get_object",
            Params={"Bucket": os.environ["AWS_BUCKET"], "Key": key},
            ExpiresIn=expires_seconds,
        )
    except (BotoCoreError, ClientError, KeyError) as exc:
        print(f"Presign failed for {key}: {exc}", flush=True)
        return None
