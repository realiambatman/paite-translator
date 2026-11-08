"""AI review of past translations.

Runs in a background thread: pulls translations newest-first, asks the
configured LLM (Claude / GPT / Gemini) to judge each one, and files any
suggested fix as a *pending* correction for the admin to accept or reject.
The original translation is never modified; the translation doc only gets an
`llm_review` stamp so the same entry is not reviewed twice.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

import llm_provider
from languages import LANGUAGES

from . import firestore_client as fs
from .router import CORRECTIONS_COLLECTION  # noqa: E402  (shared collection name)

BATCH_SIZE = 8

SYSTEM = """You are a careful bilingual reviewer for a machine-translation service that
translates between English, Paite (a Zomi language of Manipur/Mizoram, also called
Paite/Tedim-Chin family), and other languages such as Mizo, Hindi, Burmese and Meitei.

You receive a JSON list of translations. For each item decide:
- "ok": the translation is acceptable.
- "fix": the translation is clearly wrong or garbled AND you are confident of a better
  translation. Provide the full corrected target text.
- "unsure": the translation may be wrong but you cannot confidently fix it (for example
  you do not know the target language well). Do NOT invent a correction.

Common failure modes to catch: the output copies the source text unchanged, repeats
the same words in a loop, drops a whole sentence or clause, mistranslates numbers,
names or dates, or is in the wrong language entirely. An English pivot may be given
for languages routed through English; if the pivot itself is wrong, say so in the note.

Reply with ONLY a JSON array, one object per input item, in the same order:
[{"id": "...", "verdict": "ok" | "fix" | "unsure", "corrected": "..." or null,
  "confidence": 0.0-1.0, "note": "short reason"}]"""


def _lang_label(code: str | None) -> str:
    if not code:
        return "unknown"
    meta = LANGUAGES.get(code) or {}
    return f"{meta.get('label', code)} ({code})"


class ReviewJob:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self.state: dict = {"status": "idle"}

    # ----------------------------------------------------------------- status
    def snapshot(self) -> dict:
        with self._lock:
            return dict(self.state)

    def _update(self, **fields) -> None:
        with self._lock:
            self.state.update(fields)

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ----------------------------------------------------------------- control
    def start(self, *, limit: int, skip_reviewed: bool, tgt_lang: str | None) -> dict:
        if self.running:
            raise RuntimeError("A review is already running.")
        config = llm_provider.active_config()
        if config is None:
            raise RuntimeError("No LLM provider configured. Add an API key first.")

        with self._lock:
            self.state = {
                "status": "running",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
                "provider": config.provider,
                "model": config.model,
                "limit": limit,
                "scanned": 0,
                "reviewed": 0,
                "ok": 0,
                "fix": 0,
                "unsure": 0,
                "skipped": 0,
                "errors": [],
                "cancel": False,
            }
        self._thread = threading.Thread(
            target=self._run,
            args=(config, limit, skip_reviewed, tgt_lang),
            daemon=True,
            name="llm-review",
        )
        self._thread.start()
        return self.snapshot()

    def cancel(self) -> None:
        self._update(cancel=True)

    # ----------------------------------------------------------------- worker
    def _run(self, config: llm_provider.LLMConfig, limit: int, skip_reviewed: bool, tgt_lang: str | None) -> None:
        try:
            from google.cloud import firestore
            from google.cloud.firestore_v1 import FieldFilter

            db = fs.get_client()
            translations = db.collection(fs.TRANSLATIONS_COLLECTION)
            corrections = db.collection(CORRECTIONS_COLLECTION)

            query = translations.order_by("created_at", direction=firestore.Query.DESCENDING)
            if tgt_lang:
                query = translations.where(filter=FieldFilter("tgt_lang", "==", tgt_lang))

            batch: list[dict] = []
            fetched = 0
            # Over-fetch so skipped (already reviewed) items still let us reach `limit`.
            for doc in query.limit(limit * 3 if skip_reviewed else limit).stream():
                if self.snapshot().get("cancel"):
                    break
                if self.snapshot()["reviewed"] + len(batch) >= limit:
                    break
                data = doc.to_dict() or {}
                fetched += 1
                self._update(scanned=fetched)
                if skip_reviewed and data.get("llm_review"):
                    self._update(skipped=self.snapshot()["skipped"] + 1)
                    continue
                if not (data.get("src_text") or "").strip() or not (data.get("tgt_text") or "").strip():
                    self._update(skipped=self.snapshot()["skipped"] + 1)
                    continue
                batch.append({"id": doc.id, **data})
                if len(batch) >= BATCH_SIZE:
                    self._review_batch(config, batch, translations, corrections)
                    batch = []
            if batch and not self.snapshot().get("cancel"):
                self._review_batch(config, batch, translations, corrections)

            self._update(
                status="cancelled" if self.snapshot().get("cancel") else "done",
                finished_at=datetime.now(timezone.utc).isoformat(),
            )
        except Exception as exc:  # keep the job state informative
            errors = self.snapshot().get("errors", [])
            self._update(
                status="failed",
                finished_at=datetime.now(timezone.utc).isoformat(),
                errors=[*errors, str(exc)][-20:],
            )

    def _review_batch(self, config, batch: list[dict], translations, corrections) -> None:
        from google.cloud import firestore

        items = []
        for item in batch:
            entry = {
                "id": item["id"],
                "source_language": _lang_label(item.get("src_lang")),
                "target_language": _lang_label(item.get("tgt_lang")),
                "source_text": (item.get("src_text") or "")[:1500],
                "translation": (item.get("tgt_text") or "")[:2000],
            }
            if item.get("pivot_english"):
                entry["english_pivot"] = item["pivot_english"][:1500]
            items.append(entry)

        import json

        user = "Review these translations:\n\n" + json.dumps(items, ensure_ascii=False, indent=1)

        try:
            reply = llm_provider.complete(SYSTEM, user, max_tokens=6000, config=config)
            verdicts = llm_provider.extract_json(reply)
            if not isinstance(verdicts, list):
                raise llm_provider.LLMError("Model reply was not a JSON array.")
        except Exception as exc:
            errors = self.snapshot().get("errors", [])
            self._update(errors=[*errors, f"batch failed: {exc}"][-20:])
            return

        by_id = {str(v.get("id")): v for v in verdicts if isinstance(v, dict)}
        stamp = {
            "at": firestore.SERVER_TIMESTAMP,
            "provider": config.provider,
            "model": config.model,
        }

        for item in batch:
            verdict = by_id.get(item["id"]) or {}
            kind = str(verdict.get("verdict") or "unsure").lower()
            if kind not in ("ok", "fix", "unsure"):
                kind = "unsure"
            corrected = (verdict.get("corrected") or "").strip() if kind == "fix" else ""
            if kind == "fix" and (not corrected or corrected == (item.get("tgt_text") or "").strip()):
                kind = "unsure"

            try:
                confidence = float(verdict.get("confidence") or 0)
            except (TypeError, ValueError):
                confidence = 0.0
            note = str(verdict.get("note") or "")[:500]

            if kind == "fix":
                corrections.add(
                    {
                        "kind": "correction",
                        "status": "pending",
                        "origin": "llm",
                        "reviewer": f"{config.provider}/{config.model}",
                        "confidence": confidence,
                        "translation_id": item["id"],
                        "src_lang": item.get("src_lang"),
                        "tgt_lang": item.get("tgt_lang"),
                        "src_text": item.get("src_text") or "",
                        "model_text": item.get("tgt_text") or "",
                        "corrected_text": corrected[:1500],
                        "comment": note or None,
                        "route": item.get("route"),
                        "pivot_english": item.get("pivot_english"),
                        "rating": None,
                        "created_at": firestore.SERVER_TIMESTAMP,
                    }
                )

            try:
                translations.document(item["id"]).update(
                    {"llm_review": {**stamp, "verdict": kind, "confidence": confidence, "note": note}}
                )
            except Exception as exc:
                errors = self.snapshot().get("errors", [])
                self._update(errors=[*errors, f"stamp failed for {item['id']}: {exc}"][-20:])

            snap = self.snapshot()
            self._update(reviewed=snap["reviewed"] + 1, **{kind: snap[kind] + 1})

        time.sleep(0.2)  # be gentle with provider rate limits


job = ReviewJob()
