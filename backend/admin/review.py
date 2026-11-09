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
PAGE_SIZE = 200
MAX_LIMIT = 50000

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
    @staticmethod
    def resolve_reviewers(reviewers: list[str] | None) -> list[llm_provider.LLMConfig]:
        configs: list[llm_provider.LLMConfig] = []
        for item in reviewers or []:
            provider, _, model = item.partition("/")
            configs.append(llm_provider.config_for(provider.strip(), model.strip() or None))
        if not configs:
            active = llm_provider.active_config()
            if active is None:
                raise RuntimeError("No LLM provider configured. Add an API key first.")
            configs = [active]
        return configs

    @staticmethod
    def candidates(limit: int, tgt_lang: str | None) -> list[dict]:
        """The translations a run would look at, newest first."""
        from google.cloud import firestore
        from google.cloud.firestore_v1 import FieldFilter

        translations = fs.get_client().collection(fs.TRANSLATIONS_COLLECTION)
        base = translations.order_by("created_at", direction=firestore.Query.DESCENDING)
        if tgt_lang:
            base = translations.where(filter=FieldFilter("tgt_lang", "==", tgt_lang))
        out: list[dict] = []
        seen = 0
        last = None
        while seen < limit:
            page = base.limit(min(PAGE_SIZE * 2, limit - seen))
            if last is not None:
                page = page.start_after(last)
            docs = list(page.stream())
            if not docs:
                break
            last = docs[-1]
            for doc in docs:
                seen += 1
                data = doc.to_dict() or {}
                if (data.get("src_text") or "").strip() and (data.get("tgt_text") or "").strip():
                    # Keep only what precheck needs; full text of thousands of rows is wasteful.
                    out.append(
                        {
                            "id": doc.id,
                            "llm_review": data.get("llm_review"),
                            "llm_reviews": data.get("llm_reviews"),
                        }
                    )
        return out

    def precheck(self, *, limit: int, tgt_lang: str | None, reviewers: list[str] | None) -> dict:
        """How many of the candidate entries each model has already reviewed."""
        configs = self.resolve_reviewers(reviewers)
        items = self.candidates(limit, tgt_lang)
        per_reviewer = {}
        for config in configs:
            rid = llm_provider.reviewer_id(config)
            already = sum(1 for item in items if previous_review(item, config))
            per_reviewer[rid] = {"already_reviewed": already, "candidates": len(items)}
        return {"candidates": len(items), "reviewers": per_reviewer}

    def start(
        self,
        *,
        limit: int,
        skip_reviewed: bool = True,
        tgt_lang: str | None,
        reviewers: list[str] | None = None,
        on_existing: str = "skip",
    ) -> dict:
        """Start a review. `reviewers` are "provider/model" ids; each model
        reviews the same batch of translations in turn, so one translation can
        collect suggestions from several AIs."""
        if self.running:
            raise RuntimeError("A review is already running.")
        if on_existing not in ("skip", "replace", "keep"):
            raise RuntimeError("on_existing must be skip, replace or keep.")
        if not skip_reviewed and on_existing == "skip":
            on_existing = "keep"

        configs = self.resolve_reviewers(reviewers)

        with self._lock:
            self.state = {
                "status": "running",
                "started_at": datetime.now(timezone.utc).isoformat(),
                "finished_at": None,
                "reviewers": [llm_provider.reviewer_id(c) for c in configs],
                "current_reviewer": llm_provider.reviewer_id(configs[0]),
                "provider": configs[0].provider,
                "model": configs[0].model,
                "limit": limit,
                "on_existing": on_existing,
                "models_total": len(configs),
                "model_index": 0,
                "model_done": 0,
                "scan_total": None,
                "scanned": 0,
                "failed": 0,
                "replaced": 0,
                "reviewed": 0,
                "ok": 0,
                "fix": 0,
                "unsure": 0,
                "skipped": 0,
                "errors": [],
                "cancel": False,
            }
        self._thread = threading.Thread(
            target=self._run_all,
            args=(configs, limit, on_existing, tgt_lang),
            daemon=True,
            name="llm-review",
        )
        self._thread.start()
        return self.snapshot()

    def _run_all(self, configs, limit, on_existing, tgt_lang) -> None:
        for index, config in enumerate(configs):
            if self.snapshot().get("cancel"):
                break
            self._update(
                current_reviewer=llm_provider.reviewer_id(config),
                provider=config.provider,
                model=config.model,
                model_index=index,
                model_done=0,
                scanned=0,
            )
            self._run(config, limit, on_existing, tgt_lang)
            if self.snapshot()["status"] == "failed":
                return
        self._update(
            status="cancelled" if self.snapshot().get("cancel") else "done",
            finished_at=datetime.now(timezone.utc).isoformat(),
        )

    def cancel(self) -> None:
        self._update(cancel=True)

    # ----------------------------------------------------------------- worker
    def _run(self, config: llm_provider.LLMConfig, limit: int, on_existing: str, tgt_lang: str | None) -> None:
        """Look at the newest `limit` translations and review the ones this model
        should see. Reads Firestore in pages so a run lasting hours never holds
        one query stream open."""
        try:
            from google.cloud import firestore
            from google.cloud.firestore_v1 import FieldFilter

            db = fs.get_client()
            translations = db.collection(fs.TRANSLATIONS_COLLECTION)
            corrections = db.collection(CORRECTIONS_COLLECTION)

            base = translations.order_by("created_at", direction=firestore.Query.DESCENDING)
            if tgt_lang:
                base = translations.where(filter=FieldFilter("tgt_lang", "==", tgt_lang))

            skip_reviewed = on_existing == "skip"
            batch: list[dict] = []
            scanned = 0
            last = None

            def done(n: int) -> None:
                self._update(model_done=self.snapshot().get("model_done", 0) + n)

            while scanned < limit and not self.snapshot().get("cancel"):
                page = base.limit(min(PAGE_SIZE, limit - scanned))
                if last is not None:
                    page = page.start_after(last)
                docs = list(page.stream())
                if not docs:
                    break
                last = docs[-1]

                for doc in docs:
                    if self.snapshot().get("cancel"):
                        break
                    data = doc.to_dict() or {}
                    scanned += 1
                    self._update(scanned=scanned)
                    previous = previous_review(data, config)
                    if previous and skip_reviewed:
                        self._update(skipped=self.snapshot()["skipped"] + 1)
                        done(1)
                        continue
                    if previous:
                        data["_previous_version"] = int(previous.get("version") or 1)
                        data["_replace"] = on_existing == "replace"
                    if not (data.get("src_text") or "").strip() or not (data.get("tgt_text") or "").strip():
                        self._update(skipped=self.snapshot()["skipped"] + 1)
                        done(1)
                        continue
                    batch.append({"id": doc.id, **data})
                    if len(batch) >= BATCH_SIZE:
                        self._review_batch(config, batch, translations, corrections)
                        done(len(batch))
                        batch = []

            if batch and not self.snapshot().get("cancel"):
                self._review_batch(config, batch, translations, corrections)
                done(len(batch))
            # Fewer entries exist than were asked for: the run is still complete.
            if not self.snapshot().get("cancel"):
                self._update(scan_total=scanned)
        except Exception as exc:  # keep the job state informative
            errors = self.snapshot().get("errors", [])
            self._update(
                status="failed",
                finished_at=datetime.now(timezone.utc).isoformat(),
                errors=[*errors, str(exc)][-20:],
            )

    def _review_batch(self, config, batch: list[dict], translations, corrections) -> None:
        try:
            by_id = ask_model(config, batch)
        except Exception as exc:
            snap = self.snapshot()
            self._update(
                errors=[*snap.get("errors", []), f"batch of {len(batch)} failed: {exc}"][-20:],
                failed=snap.get("failed", 0) + len(batch),
            )
            # Back off a little so a rate limit or outage does not burn the whole run.
            time.sleep(min(30.0, 2.0 * (1 + snap.get("failed", 0) // BATCH_SIZE)))
            return

        for item in batch:
            result = record_verdict(
                config,
                item,
                by_id.get(item["id"]) or {},
                translations,
                corrections,
                replace=bool(item.get("_replace")),
                previous_version=int(item.get("_previous_version") or 0),
            )
            for err in result.get("errors", []):
                errors = self.snapshot().get("errors", [])
                self._update(errors=[*errors, err][-20:])
            if result.get("replaced"):
                self._update(replaced=self.snapshot().get("replaced", 0) + result["replaced"])
            snap = self.snapshot()
            kind = result["verdict"]
            self._update(reviewed=snap["reviewed"] + 1, **{kind: snap[kind] + 1})

        time.sleep(0.2)  # be gentle with provider rate limits


job = ReviewJob()



# --------------------------------------------------------------------------- shared helpers


def previous_review(data: dict, config: llm_provider.LLMConfig) -> dict | None:
    """This model's earlier review of a translation, if any. Entries reviewed
    before per-model tracking only carry the single legacy `llm_review` stamp."""
    reviewer = llm_provider.reviewer_id(config)
    reviews = data.get("llm_reviews") or {}
    found = reviews.get(llm_provider.reviewer_key(reviewer))
    if found:
        return found
    legacy = data.get("llm_review")
    if isinstance(legacy, dict):
        legacy_id = legacy.get("reviewer") or f"{legacy.get('provider')}/{legacy.get('model')}"
        if legacy_id == reviewer:
            return legacy
    return None


def ask_model(config: llm_provider.LLMConfig, batch: list[dict]) -> dict[str, dict]:
    """Send a batch of translations to the model; returns verdicts keyed by id."""
    import json

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

    user = "Review these translations:\n\n" + json.dumps(items, ensure_ascii=False, indent=1)
    reply = llm_provider.complete(SYSTEM, user, max_tokens=6000, config=config)
    verdicts = llm_provider.extract_json(reply)
    if not isinstance(verdicts, list):
        raise llm_provider.LLMError("Model reply was not a JSON array.")
    return {str(v.get("id")): v for v in verdicts if isinstance(v, dict)}


def delete_previous(corrections, translation_id: str, reviewer: str) -> int:
    """Remove this model's earlier suggestions for one translation (replace mode)."""
    from google.cloud.firestore_v1 import FieldFilter

    old = (
        corrections.where(filter=FieldFilter("translation_id", "==", translation_id))
        .where(filter=FieldFilter("reviewer", "==", reviewer))
        .stream()
    )
    removed = 0
    for doc in old:
        doc.reference.delete()
        removed += 1
    return removed


def record_verdict(
    config: llm_provider.LLMConfig,
    item: dict,
    verdict: dict,
    translations,
    corrections,
    *,
    replace: bool = False,
    previous_version: int = 0,
) -> dict:
    """Normalise one verdict, file a pending correction if it is a fix, and stamp
    the translation. Returns a summary the caller can report."""
    from google.cloud import firestore

    reviewer = llm_provider.reviewer_id(config)
    key = llm_provider.reviewer_key(reviewer)
    errors: list[str] = []
    replaced = 0

    version = 1 if replace else previous_version + 1
    if replace:
        try:
            replaced = delete_previous(corrections, item["id"], reviewer)
        except Exception as exc:
            errors.append(f"could not replace old suggestion for {item['id']}: {exc}")

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

    correction_id = None
    if kind == "fix":
        _, ref = corrections.add(
            {
                "kind": "correction",
                "status": "pending",
                "origin": "llm",
                "reviewer": reviewer,
                "confidence": confidence,
                "translation_id": item["id"],
                "src_lang": item.get("src_lang"),
                "tgt_lang": item.get("tgt_lang"),
                "src_text": item.get("src_text") or "",
                "model_text": item.get("tgt_text") or "",
                "corrected_text": corrected[:1500],
                "comment": note or None,
                "version": version,
                "route": item.get("route"),
                "pivot_english": item.get("pivot_english"),
                "rating": None,
                "created_at": firestore.SERVER_TIMESTAMP,
            }
        )
        correction_id = ref.id

    review = {
        "at": firestore.SERVER_TIMESTAMP,
        "provider": config.provider,
        "model": config.model,
        "reviewer": reviewer,
        "verdict": kind,
        "confidence": confidence,
        "note": note,
        "version": version,
    }
    per_model = {key: review}
    # Carry an old single-stamp review into the per-model map before `llm_review`
    # is overwritten, so that model still knows it has seen this entry.
    legacy = item.get("llm_review")
    if isinstance(legacy, dict):
        legacy_id = legacy.get("reviewer") or f"{legacy.get('provider')}/{legacy.get('model')}"
        legacy_key = llm_provider.reviewer_key(legacy_id)
        if legacy_key != key and legacy_key not in (item.get("llm_reviews") or {}):
            per_model[legacy_key] = {**legacy, "reviewer": legacy_id}
    try:
        translations.document(item["id"]).set(
            {"llm_review": review, "llm_reviews": per_model},
            merge=True,
        )
    except Exception as exc:
        errors.append(f"stamp failed for {item['id']}: {exc}")

    return {
        "verdict": kind,
        "confidence": confidence,
        "note": note,
        "corrected": corrected if kind == "fix" else None,
        "correction_id": correction_id,
        "version": version,
        "reviewer": reviewer,
        "replaced": replaced,
        "errors": errors,
    }


def review_one(doc_id: str, reviewer: str | None, on_existing: str = "keep") -> dict:
    """Review a single translation right now (used by the per-row button)."""
    configs = ReviewJob.resolve_reviewers([reviewer] if reviewer else None)
    config = configs[0]
    db = fs.get_client()
    translations = db.collection(fs.TRANSLATIONS_COLLECTION)
    corrections = db.collection(CORRECTIONS_COLLECTION)

    snapshot = translations.document(doc_id).get()
    if not snapshot.exists:
        raise LookupError("Translation not found.")
    item = {"id": doc_id, **(snapshot.to_dict() or {})}
    if not (item.get("src_text") or "").strip() or not (item.get("tgt_text") or "").strip():
        raise ValueError("This entry has no text to review.")

    previous = previous_review(item, config)
    if previous and on_existing == "skip":
        return {"skipped": True, "reviewer": llm_provider.reviewer_id(config), "previous": previous}

    by_id = ask_model(config, [item])
    return record_verdict(
        config,
        item,
        by_id.get(doc_id) or {},
        translations,
        corrections,
        replace=bool(previous) and on_existing == "replace",
        previous_version=int(previous.get("version") or 1) if previous else 0,
    )
