"""Admin panel endpoints (all under /api/admin)."""

from __future__ import annotations

import csv
import io
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from object_storage import (
    is_configured as storage_configured,
    key_from_url,
    presigned_url,
)

import glossary as glossary_module

from . import firestore_client as fs
from .auth import is_configured as auth_configured, require_admin

CORRECTIONS_COLLECTION = (
    os.environ.get("VITE_FIREBASE_CORRECTIONS_COLLECTION", "corrections").strip()
    or "corrections"
)
CORRECTION_STATUSES = ("pending", "accepted", "rejected")

router = APIRouter(prefix="/api/admin", tags=["admin"])

IMAGE_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic")
PRESIGN_TTL_SECONDS = 3600
MAX_PAGE = 200
MAX_EXPORT = 5000

_presign_cache: dict[str, tuple[float, str]] = {}
_presign_lock = threading.Lock()


def _cached_presign(key: str) -> str | None:
    now = time.time()
    with _presign_lock:
        hit = _presign_cache.get(key)
        if hit and hit[0] > now + 60:
            return hit[1]
    url = presigned_url(key, PRESIGN_TTL_SECONDS)
    if url:
        with _presign_lock:
            _presign_cache[key] = (now + PRESIGN_TTL_SECONDS, url)
    return url


def _is_image(filename: str | None, url: str | None) -> bool:
    for candidate in (filename, url):
        if not candidate:
            continue
        lowered = candidate.split("?", 1)[0].lower()
        if lowered.endswith(IMAGE_EXTENSIONS):
            return True
    return False


def _to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def _serialize(doc) -> dict:
    data = doc.to_dict() or {}
    storage_url = data.get("storage_url") or None
    filename = data.get("filename") or None
    source = data.get("source") or "text"

    view_url = storage_url
    storage_key = None
    if storage_url:
        storage_key = key_from_url(storage_url)
        if storage_key:
            view_url = _cached_presign(storage_key) or storage_url

    src_text = data.get("src_text") or ""
    tgt_text = data.get("tgt_text") or ""

    return {
        "id": doc.id,
        "created_at": _to_iso(data.get("created_at")),
        "src_lang": data.get("src_lang"),
        "tgt_lang": data.get("tgt_lang"),
        "src_text": src_text,
        "tgt_text": tgt_text,
        "src_chars": len(src_text),
        "tgt_chars": len(tgt_text),
        "route": data.get("route"),
        "pivot_english": data.get("pivot_english"),
        "source": source,
        "filename": filename,
        "storage_url": storage_url,
        "storage_key": storage_key,
        "file_url": view_url,
        "is_image": bool(storage_url) and _is_image(filename, storage_url),
        "alternatives": [a for a in (data.get("alternatives") or []) if isinstance(a, str)][:5],
        "llm_review": _llm_review(data.get("llm_review")),
        "llm_reviews": [
            r for r in (_llm_review(v) for v in (data.get("llm_reviews") or {}).values()) if r
        ],
    }


def _llm_review(value) -> dict | None:
    if not isinstance(value, dict):
        return None
    return {
        "verdict": value.get("verdict"),
        "confidence": value.get("confidence"),
        "note": value.get("note"),
        "provider": value.get("provider"),
        "model": value.get("model"),
        "reviewer": value.get("reviewer") or f"{value.get('provider')}/{value.get('model')}",
        "version": int(value.get("version") or 1),
        "at": _to_iso(value.get("at")),
    }


def _firestore_or_503():
    try:
        return fs.translations_ref()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _count(query) -> int | None:
    try:
        result = query.count().get()
        return int(result[0][0].value)
    except Exception as exc:  # aggregation unsupported or permission issue
        print(f"Admin count failed: {exc}", flush=True)
        return None


@router.get("/status")
def admin_status():
    """Unauthenticated: lets the admin page explain what is missing."""
    return {
        "auth_configured": auth_configured(),
        "firestore_configured": fs.is_configured(),
        "firestore_error": fs.last_error(),
        "storage_configured": storage_configured(),
        "collection": fs.TRANSLATIONS_COLLECTION,
        "build": os.environ.get("BUILD_ID", "dev"),
    }


@router.get("/me", dependencies=[Depends(require_admin)])
def admin_me():
    return {"ok": True}


@router.get("/stats", dependencies=[Depends(require_admin)])
def admin_stats():
    ref = _firestore_or_503()
    from google.cloud.firestore_v1 import FieldFilter

    now = datetime.now(timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = day_start - timedelta(days=6)
    month_start = day_start - timedelta(days=29)

    def since(ts: datetime) -> int | None:
        return _count(ref.where(filter=FieldFilter("created_at", ">=", ts)))

    def by_source(value: str) -> int | None:
        return _count(ref.where(filter=FieldFilter("source", "==", value)))

    corrections = fs.get_client().collection(CORRECTIONS_COLLECTION)

    def corrections_where(field: str, value) -> int | None:
        return _count(corrections.where(filter=FieldFilter(field, "==", value)))

    return {
        "total": _count(ref),
        "today": since(day_start),
        "last_7_days": since(week_start),
        "last_30_days": since(month_start),
        "by_source": {
            "upload": by_source("upload"),
            "camera": by_source("camera"),
        },
        "corrections": {
            "pending": _count(
                corrections.where(filter=FieldFilter("kind", "==", "correction")).where(
                    filter=FieldFilter("status", "==", "pending")
                )
            ),
            "accepted": _count(
                corrections.where(filter=FieldFilter("kind", "==", "correction")).where(
                    filter=FieldFilter("status", "==", "accepted")
                )
            ),
            "thumbs_up": corrections_where("rating", "up"),
            "thumbs_down": corrections_where("rating", "down"),
        },
        "generated_at": now.isoformat(),
    }


@router.get("/translations", dependencies=[Depends(require_admin)])
def admin_translations(
    limit: int = Query(default=50, ge=1, le=MAX_PAGE),
    cursor: str | None = Query(default=None, description="id of the last item seen"),
    order: str = Query(default="created_at", pattern="^(created_at|id)$"),
):
    ref = _firestore_or_503()
    from google.cloud import firestore

    if order == "created_at":
        query = ref.order_by("created_at", direction=firestore.Query.DESCENDING)
    else:
        query = ref.order_by("__name__", direction=firestore.Query.DESCENDING)

    if cursor:
        snapshot = ref.document(cursor).get()
        if not snapshot.exists:
            raise HTTPException(status_code=400, detail="Unknown cursor.")
        query = query.start_after(snapshot)

    try:
        docs = list(query.limit(limit + 1).stream())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Firestore read failed: {exc}") from exc

    has_more = len(docs) > limit
    docs = docs[:limit]
    items = [_serialize(doc) for doc in docs]

    return {
        "items": items,
        "next_cursor": docs[-1].id if has_more and docs else None,
        "has_more": has_more,
    }


@router.get("/translations/{doc_id}", dependencies=[Depends(require_admin)])
def admin_translation(doc_id: str):
    ref = _firestore_or_503()
    snapshot = ref.document(doc_id).get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="Translation not found.")
    return _serialize(snapshot)


@router.get("/export.csv", dependencies=[Depends(require_admin)])
def admin_export_csv(limit: int = Query(default=MAX_EXPORT, ge=1, le=MAX_EXPORT)):
    ref = _firestore_or_503()
    from google.cloud import firestore

    query = ref.order_by("created_at", direction=firestore.Query.DESCENDING).limit(limit)

    columns = [
        "id",
        "created_at",
        "source",
        "src_lang",
        "tgt_lang",
        "src_text",
        "tgt_text",
        "pivot_english",
        "route",
        "filename",
        "storage_url",
    ]

    def rows():
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        for doc in query.stream():
            writer.writerow(_serialize(doc))
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    return StreamingResponse(
        rows(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="translations-{stamp}.csv"'
        },
    )


# ---------------------------------------------------------------------------
# Corrections: user-submitted fixes and ratings (browser writes, admin reviews)
# ---------------------------------------------------------------------------


def _serialize_correction(doc) -> dict:
    data = doc.to_dict() or {}
    return {
        "id": doc.id,
        "created_at": _to_iso(data.get("created_at")),
        "reviewed_at": _to_iso(data.get("reviewed_at")),
        "kind": data.get("kind") or ("correction" if data.get("corrected_text") else "rating"),
        "status": data.get("status") or "pending",
        "rating": data.get("rating"),
        "translation_id": data.get("translation_id"),
        "src_lang": data.get("src_lang"),
        "tgt_lang": data.get("tgt_lang"),
        "src_text": data.get("src_text") or "",
        "model_text": data.get("model_text") or "",
        "corrected_text": data.get("corrected_text"),
        "comment": data.get("comment"),
        "route": data.get("route"),
        "pivot_english": data.get("pivot_english"),
        "origin": data.get("origin") or "user",
        "reviewer": data.get("reviewer"),
        "confidence": data.get("confidence"),
        "version": int(data.get("version") or 1),
    }


def _corrections_ref():
    try:
        return fs.get_client().collection(CORRECTIONS_COLLECTION)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/corrections", dependencies=[Depends(require_admin)])
def admin_corrections(
    status: str = Query(default="all"),
    kind: str = Query(default="all", pattern="^(all|correction|rating)$"),
    limit: int = Query(default=500, ge=1, le=2000),
):
    """Review queue. Filters are equality-only so no composite index is needed;
    sorting happens here because the queue is small."""
    ref = _corrections_ref()
    from google.cloud.firestore_v1 import FieldFilter

    query = ref
    if kind != "all":
        query = query.where(filter=FieldFilter("kind", "==", kind))
    if status != "all":
        if status not in CORRECTION_STATUSES:
            raise HTTPException(status_code=400, detail="Unknown status.")
        query = query.where(filter=FieldFilter("status", "==", status))

    try:
        docs = list(query.limit(limit).stream())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Firestore read failed: {exc}") from exc

    items = [_serialize_correction(doc) for doc in docs]
    items.sort(key=lambda item: item["created_at"] or "", reverse=True)
    return {"items": items, "count": len(items), "truncated": len(docs) >= limit}


class CorrectionReview(BaseModel):
    status: str = Field(pattern="^(pending|accepted|rejected)$")
    corrected_text: str | None = Field(default=None, max_length=3000)


@router.patch("/corrections/{doc_id}", dependencies=[Depends(require_admin)])
def admin_review_correction(doc_id: str, body: CorrectionReview):
    ref = _corrections_ref()
    from google.cloud import firestore

    snapshot = ref.document(doc_id).get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="Correction not found.")

    update: dict = {
        "status": body.status,
        "reviewed_at": firestore.SERVER_TIMESTAMP,
    }
    if body.corrected_text is not None:
        update["corrected_text"] = body.corrected_text.strip()
    ref.document(doc_id).update(update)
    return _serialize_correction(ref.document(doc_id).get())


@router.delete("/corrections/{doc_id}", dependencies=[Depends(require_admin)])
def admin_delete_correction(doc_id: str):
    ref = _corrections_ref()
    ref.document(doc_id).delete()
    return {"ok": True}


@router.get("/corrections/export.csv", dependencies=[Depends(require_admin)])
def admin_export_corrections(
    status: str = Query(default="accepted", pattern="^(accepted|pending|rejected|all)$"),
):
    """Training pairs: source sentence and the human-corrected target."""
    ref = _corrections_ref()
    from google.cloud.firestore_v1 import FieldFilter

    query = ref.where(filter=FieldFilter("kind", "==", "correction"))
    if status != "all":
        query = query.where(filter=FieldFilter("status", "==", status))

    columns = [
        "id",
        "created_at",
        "status",
        "src_lang",
        "tgt_lang",
        "src_text",
        "corrected_text",
        "model_text",
        "pivot_english",
        "route",
        "comment",
        "translation_id",
    ]

    def rows():
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
        for doc in query.stream():
            writer.writerow(_serialize_correction(doc))
            yield buffer.getvalue()
            buffer.seek(0)
            buffer.truncate(0)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
    return StreamingResponse(
        rows(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="corrections-{status}-{stamp}.csv"'
        },
    )


# ---------------------------------------------------------------------------
# AI provider settings (Claude / GPT / Gemini) and AI review of past entries
# ---------------------------------------------------------------------------

import llm_provider  # noqa: E402


class LLMSettingsIn(BaseModel):
    provider: str | None = None
    model: str | None = None
    api_keys: dict[str, str] | None = None


@router.get("/llm", dependencies=[Depends(require_admin)])
def admin_llm_settings():
    try:
        return llm_provider.public_settings()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.put("/llm", dependencies=[Depends(require_admin)])
def admin_update_llm(body: LLMSettingsIn):
    try:
        llm_provider.save_settings(
            provider=body.provider, model=body.model, api_keys=body.api_keys
        )
        return llm_provider.public_settings()
    except llm_provider.LLMError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/llm/key/{provider}", dependencies=[Depends(require_admin)])
def admin_llm_key(provider: str):
    """Reveal the saved key for a provider so the admin can copy it back out."""
    if provider not in llm_provider.PROVIDERS:
        raise HTTPException(status_code=404, detail="Unknown provider.")
    key = llm_provider.key_for(provider)
    if not key:
        raise HTTPException(status_code=404, detail="No key saved for this provider.")
    stored = (llm_provider.load_settings().get("api_keys") or {}).get(provider)
    return {"provider": provider, "api_key": key, "source": "admin" if stored else "env"}


@router.post("/llm/test", dependencies=[Depends(require_admin)])
def admin_test_llm(body: dict = Body(default={})):
    """Round-trip a tiny prompt with the given (or active) provider/key."""
    provider = (body.get("provider") or "").strip() or None
    model = (body.get("model") or "").strip() or None
    api_key = (body.get("api_key") or "").strip() or None
    try:
        if provider:
            config = llm_provider.LLMConfig(
                provider=provider,
                model=model or llm_provider.PROVIDERS[provider]["default_model"],
                api_key=api_key or llm_provider.key_for(provider),
            )
            if not config.api_key:
                raise llm_provider.LLMError("No API key for this provider yet.")
        else:
            config = llm_provider.active_config()
            if config is None:
                raise llm_provider.LLMError("No provider configured.")
        started = time.time()
        reply = llm_provider.complete(
            "Reply with the single word OK.", "Ping", max_tokens=20, config=config, timeout=30
        )
        return {
            "ok": True,
            "provider": config.provider,
            "model": config.model,
            "reply": reply[:100],
            "ms": int((time.time() - started) * 1000),
        }
    except (llm_provider.LLMError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class ReviewRunIn(BaseModel):
    limit: int = Field(default=50, ge=1, le=1000)
    skip_reviewed: bool = True
    tgt_lang: str | None = None
    reviewers: list[str] = Field(default_factory=list, max_length=6)
    # What to do when a model has already reviewed an entry:
    # skip it, replace its old suggestion, or keep both (new one becomes v2, v3, ...).
    on_existing: str = Field(default="skip", pattern="^(skip|replace|keep)$")


@router.post("/review/precheck", dependencies=[Depends(require_admin)])
def admin_review_precheck(body: ReviewRunIn):
    from .review import job

    _firestore_or_503()
    try:
        return job.precheck(limit=body.limit, tgt_lang=body.tgt_lang, reviewers=body.reviewers)
    except llm_provider.LLMError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/review/status", dependencies=[Depends(require_admin)])
def admin_review_status():
    from .review import job

    return job.snapshot()


@router.post("/review/run", dependencies=[Depends(require_admin)])
def admin_review_run(body: ReviewRunIn):
    from .review import job

    _firestore_or_503()
    try:
        return job.start(
            limit=body.limit,
            skip_reviewed=body.skip_reviewed,
            tgt_lang=body.tgt_lang,
            reviewers=body.reviewers,
            on_existing=body.on_existing,
        )
    except llm_provider.LLMError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/review/cancel", dependencies=[Depends(require_admin)])
def admin_review_cancel():
    from .review import job

    job.cancel()
    return job.snapshot()


# ---------------------------------------------------------------------------
# Glossary: find/replace rules applied to model output (see glossary.py)
# ---------------------------------------------------------------------------


class GlossaryRuleIn(BaseModel):
    tgt_lang: str = Field(min_length=3, max_length=16)
    src_lang: str | None = Field(default=None, max_length=16)
    find: str = Field(min_length=1, max_length=200)
    replace: str = Field(max_length=400)
    enabled: bool = True
    note: str | None = Field(default=None, max_length=300)


def _glossary_ref():
    try:
        return fs.get_client().collection(glossary_module.GLOSSARY_COLLECTION)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


def _serialize_rule(doc) -> dict:
    data = doc.to_dict() or {}
    return {
        "id": doc.id,
        "tgt_lang": data.get("tgt_lang"),
        "src_lang": data.get("src_lang") or None,
        "find": data.get("find") or "",
        "replace": data.get("replace") or "",
        "enabled": bool(data.get("enabled", True)),
        "note": data.get("note"),
        "created_at": _to_iso(data.get("created_at")),
        "updated_at": _to_iso(data.get("updated_at")),
    }


@router.get("/glossary", dependencies=[Depends(require_admin)])
def admin_glossary():
    ref = _glossary_ref()
    try:
        docs = list(ref.limit(2000).stream())
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Firestore read failed: {exc}") from exc
    items = [_serialize_rule(doc) for doc in docs]
    items.sort(key=lambda r: ((r["tgt_lang"] or ""), (r["find"] or "").lower()))
    return {"items": items}


@router.post("/glossary", dependencies=[Depends(require_admin)])
def admin_add_rule(body: GlossaryRuleIn):
    ref = _glossary_ref()
    from google.cloud import firestore

    payload = {
        **body.model_dump(),
        "find": body.find.strip(),
        "src_lang": (body.src_lang or "").strip() or None,
        "created_at": firestore.SERVER_TIMESTAMP,
        "updated_at": firestore.SERVER_TIMESTAMP,
    }
    _, doc_ref = ref.add(payload)
    glossary_module.invalidate()
    return _serialize_rule(doc_ref.get())


@router.patch("/glossary/{doc_id}", dependencies=[Depends(require_admin)])
def admin_update_rule(doc_id: str, body: dict = Body(...)):
    ref = _glossary_ref()
    from google.cloud import firestore

    allowed = {"tgt_lang", "src_lang", "find", "replace", "enabled", "note"}
    update = {k: v for k, v in body.items() if k in allowed}
    if "find" in update:
        update["find"] = str(update["find"]).strip()
        if not update["find"]:
            raise HTTPException(status_code=400, detail="find cannot be empty.")
    if "src_lang" in update:
        update["src_lang"] = (str(update["src_lang"] or "")).strip() or None
    if not update:
        raise HTTPException(status_code=400, detail="Nothing to update.")
    update["updated_at"] = firestore.SERVER_TIMESTAMP

    doc = ref.document(doc_id)
    if not doc.get().exists:
        raise HTTPException(status_code=404, detail="Rule not found.")
    doc.update(update)
    glossary_module.invalidate()
    return _serialize_rule(doc.get())


@router.delete("/glossary/{doc_id}", dependencies=[Depends(require_admin)])
def admin_delete_rule(doc_id: str):
    ref = _glossary_ref()
    ref.document(doc_id).delete()
    glossary_module.invalidate()
    return {"ok": True}


@router.post("/glossary/preview", dependencies=[Depends(require_admin)])
def admin_glossary_preview(body: dict = Body(...)):
    """Apply the current rules to sample text without translating."""
    text = str(body.get("text") or "")
    src_lang = str(body.get("src_lang") or "eng_Latn")
    tgt_lang = str(body.get("tgt_lang") or "pai_Latn")
    glossary_module.invalidate()
    return {"text": glossary_module.apply(text, src_lang, tgt_lang)}
