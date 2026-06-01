import os
import re
import shutil
import threading
import time
from pathlib import Path

import nltk
import torch
from huggingface_hub import hf_hub_download, snapshot_download
from google_quota import quota_exceeded, quota_info
from google_translate import is_configured as google_configured, is_available as google_available, translate as google_translate_text
from languages import (
    ENGLISH,
    PAITE,
    LANGUAGES,
    google_code,
    languages_for_api,
    resolve_route,
    uses_google,
)
from limits import enforce_input_limits, limits_info
from ct2_inference import CT2_MODEL_REPO, load_ct2, translate_batch_ct2
from copy_through_fallback import ENABLED as COPY_THROUGH_FALLBACK_ENABLED, try_chunk_fallback
from transformers import AutoModelForSeq2SeqLM, BitsAndBytesConfig, NllbTokenizer

MODEL_REPO = os.environ.get("MODEL_REPO", "sensix-zo/nllb-paite-600m-v15")
INFERENCE_BACKEND = os.environ.get("INFERENCE_BACKEND", "pytorch").lower()
BASE_NLLB_REPO = "facebook/nllb-200-distilled-600M"
HF_TOKEN = os.environ.get("HF_TOKEN")
CPU_BATCH_SIZE = int(os.environ.get("CPU_BATCH_SIZE", "1"))
GPU_BATCH_SIZE = int(os.environ.get("GPU_BATCH_SIZE", "8"))
KEEP_WARM_INTERVAL_SEC = int(os.environ.get("KEEP_WARM_INTERVAL_SEC", "300"))
SENTENCE_GROUP_SIZE = max(1, int(os.environ.get("SENTENCE_GROUP_SIZE", "1")))

ZOMI_NUMBERS = {
    "Khat": "1",
    "Nih": "2",
    "Thum": "3",
    "Li": "4",
    "Nga": "5",
    "Guk": "6",
    "Sagih": "7",
    "Giat": "8",
    "Kua": "9",
    "Sawm": "10",
}


def _ensure_nltk():
    try:
        nltk.data.find("tokenizers/punkt")
        nltk.data.find("tokenizers/punkt_tab")
    except LookupError:
        nltk.download("punkt", quiet=True)
        nltk.download("punkt_tab", quiet=True)


def _detect_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def fix_bullet_points(translated_text: str) -> str:
    for word, digit in ZOMI_NUMBERS.items():
        pattern = re.compile(rf"^{word}\.\s", re.MULTILINE)
        translated_text = pattern.sub(f"{digit}. ", translated_text)
    return translated_text


TIMESTAMP_LINE = re.compile(
    r"^(\s*)(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s+(.*)$",
)
LEADING_TIMESTAMP_JUNK = re.compile(
    r"^(\s*)((?:Dak|dak|DAK)\s+)?(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*",
)


def fix_timestamps(source_text: str, translated_text: str) -> str:
    """Restore subtitle-style timestamps from the source on each translated line."""
    if not source_text.strip() or not translated_text.strip():
        return translated_text

    src_lines = source_text.split("\n")
    tgt_lines = translated_text.split("\n")
    fixed_lines: list[str] = []

    for index, src_line in enumerate(src_lines):
        tgt_line = tgt_lines[index] if index < len(tgt_lines) else ""
        src_match = TIMESTAMP_LINE.match(src_line)

        if not src_match or not src_line.strip():
            fixed_lines.append(tgt_line)
            continue

        indent, timestamp, _ = src_match.groups()
        body = LEADING_TIMESTAMP_JUNK.sub(r"\1", tgt_line, count=1)
        body = re.sub(
            r"^(\s*)(\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)\s*",
            r"\1",
            body,
            count=1,
        )
        body = body.lstrip()
        fixed_lines.append(f"{indent}{timestamp} {body}" if body else f"{indent}{timestamp}")

    if len(tgt_lines) > len(src_lines):
        fixed_lines.extend(tgt_lines[len(src_lines) :])

    return "\n".join(fixed_lines)


def fix_paite_formatting(source_text: str, translated_text: str) -> str:
    translated_text = fix_bullet_points(translated_text)
    return fix_timestamps(source_text, translated_text)


def _ends_sentence(text: str) -> bool:
    stripped = text.rstrip()
    if not stripped:
        return False
    while stripped and stripped[-1] in "\"'”’)]}":
        stripped = stripped[:-1].rstrip()
    return bool(stripped) and stripped[-1] in ".!?"


def _line_body(line: str) -> tuple[str | None, str | None, str | None, str]:
    """Return (indent, timestamp, body) for timestamp lines, else plain body."""
    match = TIMESTAMP_LINE.match(line)
    if match:
        indent, timestamp, body = match.groups()
        return indent, timestamp, body, "timestamp"
    return None, None, line.strip(), "plain"


def _is_structured_line(body: str) -> bool:
    """Lines that should stay separate (forms, headers, bullets), not merged."""
    stripped = body.strip()
    if not stripped:
        return True

    if re.match(r"^[\u2022\u25cf\u25cb\u25aa\-*●○▪]\s", stripped) or re.match(
        r"^\d+\.\s", stripped
    ):
        return True

    if re.match(r"^[^:\n]{1,80}:", stripped):
        return True

    letters = [char for char in stripped if char.isalpha()]
    if (
        letters
        and len(stripped) < 80
        and sum(1 for char in letters if char.isupper()) / len(letters) >= 0.85
    ):
        return True

    return False


def _has_wrapped_prose_run(bodies: list[str]) -> bool:
    """True when 2+ consecutive lines look like one sentence split across lines."""
    run = 0
    for body in bodies:
        if _is_structured_line(body):
            run = 0
            continue
        if _ends_sentence(body):
            run = 0
            continue
        run += 1
        if run >= 2:
            return True
    return False


def _is_multiline_sentence_document(text: str) -> bool:
    lines = [line for line in text.split("\n") if line.strip()]
    if len(lines) < 2:
        return False

    timestamp_lines = sum(1 for line in lines if TIMESTAMP_LINE.match(line))
    if timestamp_lines >= 2:
        return True

    bodies = [_line_body(line)[2] or "" for line in lines]
    structured_ratio = sum(1 for body in bodies if _is_structured_line(body)) / len(
        bodies
    )
    if structured_ratio >= 0.35:
        return False

    return _has_wrapped_prose_run(bodies)


def _redistribute_by_word_counts(source_fragments: list[str], translated: str) -> list[str]:
    if len(source_fragments) == 1:
        return [translated.strip()]

    src_counts = [max(len(fragment.split()), 1 if fragment.strip() else 0) for fragment in source_fragments]
    tgt_words = translated.split()
    if not tgt_words:
        return [""] * len(source_fragments)

    total_src = sum(src_counts)
    if total_src == 0:
        return [translated.strip()] + [""] * (len(source_fragments) - 1)

    result: list[str] = []
    word_idx = 0
    remaining_lines = len(source_fragments)

    for index, count in enumerate(src_counts):
        remaining_lines -= 1
        if index == len(source_fragments) - 1:
            chunk = tgt_words[word_idx:]
        else:
            take = round((count / total_src) * len(tgt_words))
            take = max(take, 1 if count > 0 else 0)
            reserve = max(remaining_lines, 0)
            take = min(take, max(len(tgt_words) - word_idx - reserve, 0))
            chunk = tgt_words[word_idx : word_idx + take]
            word_idx += take
        result.append(" ".join(chunk).strip())

    return result


def _split_multiline_document(text: str) -> tuple[list[str], list[int], dict]:
    raw_lines = text.split("\n")
    units: list[str] = []
    unit_line_counts: list[int] = []
    groups: list[dict] = []

    current_indices: list[int] = []
    current_fragments: list[str] = []
    current_meta: list[tuple[str | None, str | None]] = []

    def flush_group() -> None:
        nonlocal current_indices, current_fragments, current_meta
        if not current_fragments:
            return

        merged = " ".join(
            fragment.strip() for fragment in current_fragments if fragment.strip()
        )
        if not merged:
            current_indices = []
            current_fragments = []
            current_meta = []
            return

        groups.append(
            {
                "kind": "merged",
                "unit_index": len(units),
                "line_indices": current_indices.copy(),
                "fragments": current_fragments.copy(),
                "meta": current_meta.copy(),
            }
        )
        units.append(merged)
        unit_line_counts.append(len(current_indices))
        current_indices = []
        current_fragments = []
        current_meta = []

    def flush_single_line(
        line_index: int,
        body: str,
        meta: tuple[str | None, str | None],
    ) -> None:
        groups.append(
            {
                "kind": "merged",
                "unit_index": len(units),
                "line_indices": [line_index],
                "fragments": [body],
                "meta": [meta],
            }
        )
        units.append(body.strip())
        unit_line_counts.append(1)

    for line_index, line in enumerate(raw_lines):
        if not line.strip():
            flush_group()
            continue

        indent, timestamp, body, _kind = _line_body(line)
        body = body or ""

        if _is_structured_line(body) and not timestamp:
            flush_group()
            flush_single_line(line_index, body, (indent, timestamp))
            continue

        current_indices.append(line_index)
        current_fragments.append(body)
        current_meta.append((indent, timestamp))

        if _ends_sentence(body) or _ends_sentence(" ".join(current_fragments)):
            flush_group()

    flush_group()

    layout = {
        "line_count": len(raw_lines),
        "groups": groups,
    }
    return units, unit_line_counts, layout


def _format_multiline_output_line(
    source_line: str,
    translated_body: str,
    meta: tuple[str | None, str | None],
) -> str:
    indent, timestamp = meta
    if timestamp:
        prefix = f"{indent or ''}{timestamp}"
        return f"{prefix} {translated_body}".rstrip() if translated_body else prefix

    match = TIMESTAMP_LINE.match(source_line)
    if match:
        line_indent, line_timestamp, _ = match.groups()
        prefix = f"{line_indent}{line_timestamp}"
        return f"{prefix} {translated_body}".rstrip() if translated_body else prefix

    if translated_body:
        return translated_body
    return source_line.strip()


def _reconstruct_multiline_document(
    source_text: str,
    layout: dict,
    translated_units: list[str],
) -> str:
    raw_lines = source_text.split("\n")
    output = list(raw_lines)

    for group in layout["groups"]:
        unit_index = group["unit_index"]
        translated = translated_units[unit_index] if unit_index < len(translated_units) else ""

        if group["kind"] == "plain":
            output[group["line_index"]] = translated
            continue

        redistributed = _redistribute_by_word_counts(group["fragments"], translated)
        for line_index, fragment, meta in zip(
            group["line_indices"],
            redistributed,
            group["meta"],
            strict=False,
        ):
            output[line_index] = _format_multiline_output_line(
                raw_lines[line_index],
                fragment,
                meta,
            )

    return "\n".join(output)


class TranslationEngine:
    def __init__(self):
        self.inference_backend = INFERENCE_BACKEND
        self.device = _detect_device()
        self.quantization = "none"
        self.model_repo = CT2_MODEL_REPO if self.inference_backend == "ctranslate2" else MODEL_REPO
        self.tokenizer: NllbTokenizer | None = None
        self.model: AutoModelForSeq2SeqLM | None = None
        self.ct2_translator = None
        self.ready = False
        self.error: str | None = None

    def load(self):
        print("TranslationEngine.load() starting...", flush=True)
        _ensure_nltk()
        if self.inference_backend == "ctranslate2":
            print(f"Loading CTranslate2 model from {CT2_MODEL_REPO}...", flush=True)
            load_ct2(self)
        else:
            self._load_pytorch()
        print("Model load finished; starting background tasks.", flush=True)
        self._start_keep_warm()
        if os.environ.get("WARMUP_ON_START", "1").strip().lower() not in ("0", "false", "off", "no"):
            threading.Thread(
                target=self._warmup,
                daemon=True,
                name="model-warmup",
            ).start()

    def _warmup(self):
        """Run a tiny translation so the first user request is not cold."""
        if not self.ready:
            return
        try:
            self.translate("Hello.", ENGLISH, PAITE)
            print("Model warmup complete.")
        except Exception as exc:
            print(f"Model warmup skipped: {exc}")

    def _start_keep_warm(self):
        """Periodically run inference so model pages stay in RAM after idle."""
        if KEEP_WARM_INTERVAL_SEC <= 0:
            return

        def loop():
            while True:
                time.sleep(KEEP_WARM_INTERVAL_SEC)
                if not self.ready:
                    continue
                try:
                    self.translate("Hello.", ENGLISH, PAITE)
                    print("Keep-warm ping complete.")
                except Exception as exc:
                    print(f"Keep-warm skipped: {exc}")

        threading.Thread(
            target=loop,
            daemon=True,
            name="model-keep-warm",
        ).start()

    def _load_pytorch(self):
        print(f"Loading PyTorch model to {self.device}...")
        self.inference_backend = "pytorch"
        self.model_repo = MODEL_REPO

        local_repo_path = snapshot_download(repo_id=MODEL_REPO, token=HF_TOKEN)

        spm_path = hf_hub_download(
            repo_id=BASE_NLLB_REPO,
            filename="sentencepiece.bpe.model",
            token=HF_TOKEN,
        )
        shutil.copy(spm_path, os.path.join(local_repo_path, "sentencepiece.bpe.model"))

        self.tokenizer = NllbTokenizer.from_pretrained(local_repo_path)

        if self.device == "cuda":
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_compute_dtype=torch.float16,
                bnb_4bit_use_double_quant=True,
                bnb_4bit_quant_type="nf4",
            )
            self.model = AutoModelForSeq2SeqLM.from_pretrained(
                local_repo_path,
                quantization_config=bnb_config,
                device_map="auto",
            )
            self.quantization = "4-bit (bitsandbytes NF4)"
        elif self.device == "mps":
            self.model = AutoModelForSeq2SeqLM.from_pretrained(
                local_repo_path,
                torch_dtype=torch.float16,
            ).to(self.device)
            self.quantization = "float16"
        else:
            self.model = AutoModelForSeq2SeqLM.from_pretrained(local_repo_path).to(self.device)
            self.quantization = "float32 (CPU — 4-bit requires CUDA GPU)"

        self.model.eval()
        self.ready = True
        print(f"Model ready on {self.device} ({self.quantization})")

    def status(self) -> dict:
        return {
            "ready": self.ready,
            "device": self.device,
            "quantization": self.quantization,
            "inference_backend": self.inference_backend,
            "model_repo": self.model_repo,
            "languages": languages_for_api(),
            "google_translate_enabled": google_available(),
            "google_translate_configured": google_configured(),
            "google_quota": quota_info(),
            "error": self.error,
            "limits": limits_info(),
        }

    def _num_beams(self) -> int:
        if os.environ.get("NUM_BEAMS"):
            return max(1, int(os.environ["NUM_BEAMS"]))
        if self.inference_backend == "ctranslate2":
            return 1 if self.device == "cpu" else 4
        return 5 if self.device == "cuda" else 1

    def _batch_size(self) -> int:
        return GPU_BATCH_SIZE if self.device == "cuda" else CPU_BATCH_SIZE

    @staticmethod
    def _split_document(text: str) -> tuple[list[str], list[int], dict | None]:
        if _is_multiline_sentence_document(text):
            return _split_multiline_document(text)

        paragraphs = text.split("\n")
        all_sentences: list[str] = []
        para_structures: list[int] = []

        for paragraph in paragraphs:
            if not paragraph.strip():
                para_structures.append(0)
            else:
                sentences = nltk.sent_tokenize(paragraph)
                all_sentences.extend(sentences)
                para_structures.append(len(sentences))

        return all_sentences, para_structures, None

    @staticmethod
    def _group_document_sentences(
        all_sentences: list[str],
        para_structures: list[int],
        group_size: int,
    ) -> list[tuple[str, int]]:
        """Join consecutive sentences into translation units (text, source sentence count)."""
        groups: list[tuple[str, int]] = []
        sent_idx = 0
        for count in para_structures:
            if count == 0:
                continue
            para_sents = all_sentences[sent_idx : sent_idx + count]
            for i in range(0, len(para_sents), group_size):
                chunk = para_sents[i : i + group_size]
                groups.append((" ".join(chunk), len(chunk)))
            sent_idx += count
        return groups

    @staticmethod
    def _reconstruct_from_groups(
        para_structures: list[int],
        translated_groups: list[str],
        group_size: int,
    ) -> str:
        final_output: list[str] = []
        group_idx = 0
        for count in para_structures:
            if count == 0:
                final_output.append("")
            else:
                num_groups = (count + group_size - 1) // group_size
                para_groups = translated_groups[group_idx : group_idx + num_groups]
                final_output.append(" ".join(para_groups))
                group_idx += num_groups
        return "\n".join(final_output)

    def _model_ready(self) -> bool:
        return self.model is not None or self.ct2_translator is not None

    def _translate_batch(
        self,
        sentences: list[str],
        src_lang: str,
        tgt_lang: str,
        batch_size: int | None = None,
    ) -> list[str]:
        assert self.tokenizer is not None and self._model_ready()

        batch_size = batch_size or self._batch_size()
        num_beams = self._num_beams()

        if self.inference_backend == "ctranslate2":
            return translate_batch_ct2(
                self, sentences, src_lang, tgt_lang, batch_size, num_beams
            )

        assert self.model is not None
        translated: list[str] = []
        self.tokenizer.src_lang = src_lang

        for i in range(0, len(sentences), batch_size):
            batch = sentences[i : i + batch_size]
            inputs = self.tokenizer(
                batch,
                return_tensors="pt",
                padding=True,
                truncation=True,
                max_length=512,
            )

            if self.device != "cuda":
                inputs = inputs.to(self.device)

            max_len = inputs.input_ids.shape[1]
            dynamic_max_tokens = int(50 + 2.5 * max_len)

            gen_kwargs = {
                "forced_bos_token_id": self.tokenizer.convert_tokens_to_ids(tgt_lang),
                "max_new_tokens": dynamic_max_tokens,
                "num_beams": num_beams,
                "do_sample": False,
            }

            with torch.no_grad():
                generated = self.model.generate(**inputs, **gen_kwargs)
                translated.extend(
                    self.tokenizer.batch_decode(generated, skip_special_tokens=True)
                )

        return translated

    def _translate_one_unit(
        self,
        unit: str,
        src_lang: str,
        tgt_lang: str,
    ) -> str:
        output = self._translate_batch([unit], src_lang, tgt_lang)[0]
        if not COPY_THROUGH_FALLBACK_ENABLED or tgt_lang != PAITE:
            return output

        fallback = try_chunk_fallback(
            unit,
            output,
            lambda clause: self._translate_batch([clause], src_lang, tgt_lang)[0],
        )
        return fallback if fallback else output

    def _translate_units(
        self,
        units: list[str],
        src_lang: str,
        tgt_lang: str,
    ) -> list[str]:
        if not units:
            return []

        batch_size = self._batch_size()
        if COPY_THROUGH_FALLBACK_ENABLED and tgt_lang == PAITE:
            return [
                self._translate_one_unit(unit, src_lang, tgt_lang) for unit in units
            ]

        return self._translate_batch(units, src_lang, tgt_lang, batch_size)

    def _validate_request(self, text: str, src_lang: str, tgt_lang: str) -> None:
        if not self.ready or self.tokenizer is None or not self._model_ready():
            raise RuntimeError("Model is not loaded yet")
        if src_lang not in LANGUAGES or tgt_lang not in LANGUAGES:
            raise ValueError(f"Unsupported language pair: {src_lang} -> {tgt_lang}")
        if not text or not text.strip():
            return
        if src_lang == tgt_lang:
            return
        if uses_google(src_lang, tgt_lang) and not google_configured():
            raise RuntimeError(
                "This language pair uses Google Translate, but GOOGLE_TRANSLATE_API_KEY is not set."
            )
        if uses_google(src_lang, tgt_lang) and quota_exceeded():
            raise RuntimeError(
                "Google Translate daily character limit reached. English ↔ Paite still works."
            )
        enforce_input_limits(text)

    def _translate_google(self, text: str, src_lang: str, tgt_lang: str) -> str:
        src_code = google_code(src_lang)
        tgt_code = google_code(tgt_lang)
        if not src_code or not tgt_code:
            raise ValueError(f"Google Translate does not support: {src_lang} -> {tgt_lang}")
        return google_translate_text(text, src_code, tgt_code)

    def _translate_hf(
        self,
        text: str,
        src_lang: str,
        tgt_lang: str,
        timestamp_source: str | None = None,
    ) -> str:
        ts_source = timestamp_source if timestamp_source is not None else text
        all_sentences, line_counts, multiline_layout = self._split_document(text)
        if not all_sentences:
            return ""

        if multiline_layout:
            translated_units = self._translate_units(all_sentences, src_lang, tgt_lang)
            result = _reconstruct_multiline_document(text, multiline_layout, translated_units)
        else:
            groups = self._group_document_sentences(
                all_sentences, line_counts, SENTENCE_GROUP_SIZE
            )
            unit_texts = [unit for unit, _ in groups]
            translated_groups = self._translate_units(unit_texts, src_lang, tgt_lang)
            result = self._reconstruct_from_groups(
                line_counts, translated_groups, SENTENCE_GROUP_SIZE
            )
        if tgt_lang == PAITE:
            result = fix_paite_formatting(ts_source, result)
        return result

    def _translate_stream_hf(
        self,
        text: str,
        src_lang: str,
        tgt_lang: str,
        timestamp_source: str | None = None,
    ):
        ts_source = timestamp_source if timestamp_source is not None else text
        all_sentences, line_counts, multiline_layout = self._split_document(text)
        total = sum(line_counts) if multiline_layout else len(all_sentences)
        if not all_sentences:
            yield {"translation": "", "current": 0, "total": 0}
            return

        if multiline_layout:
            translated_units: list[str] = []
            lines_done = 0

            for unit_text, unit_line_count in zip(all_sentences, line_counts, strict=False):
                translated_units.append(
                    self._translate_one_unit(unit_text, src_lang, tgt_lang)
                )
                lines_done += unit_line_count
                partial = _reconstruct_multiline_document(
                    text, multiline_layout, translated_units
                )
                if tgt_lang == PAITE:
                    partial = fix_paite_formatting(ts_source, partial)
                yield {
                    "translation": partial,
                    "current": lines_done,
                    "total": total,
                }
            return

        groups = self._group_document_sentences(
            all_sentences, line_counts, SENTENCE_GROUP_SIZE
        )
        translated_groups: list[str] = []
        sentences_done = 0

        for unit_text, sentence_count in groups:
            translated_groups.append(
                self._translate_one_unit(unit_text, src_lang, tgt_lang)
            )
            sentences_done += sentence_count
            partial = self._reconstruct_from_groups(
                line_counts, translated_groups, SENTENCE_GROUP_SIZE
            )
            if tgt_lang == PAITE:
                partial = fix_paite_formatting(ts_source, partial)
            yield {
                "translation": partial,
                "current": sentences_done,
                "total": total,
            }

    def _execute_translation(
        self, text: str, src_lang: str, tgt_lang: str
    ) -> tuple[str, str | None, str]:
        route = resolve_route(src_lang, tgt_lang)

        if route == "hf":
            return self._translate_hf(text, src_lang, tgt_lang), None, route
        if route == "google":
            return self._translate_google(text, src_lang, tgt_lang), None, route
        if route == "to_paite":
            english = self._translate_google(text, src_lang, ENGLISH)
            result = self._translate_hf(english, ENGLISH, PAITE, timestamp_source=text)
            return result, english, route
        if route == "from_paite":
            english = self._translate_hf(text, PAITE, ENGLISH)
            result = self._translate_google(english, ENGLISH, tgt_lang)
            return result, english, route

        raise ValueError(f"Unsupported language pair: {src_lang} -> {tgt_lang}")

    def translate(self, text: str, src_lang: str, tgt_lang: str) -> str:
        self._validate_request(text, src_lang, tgt_lang)

        if not text or not text.strip():
            return ""
        if src_lang == tgt_lang:
            return text

        result, _, _ = self._execute_translation(text, src_lang, tgt_lang)
        return result

    def _google_chars_used(
        self, route: str, text: str, pivot_english: str | None
    ) -> int:
        if route == "google" or route == "to_paite":
            return len(text)
        if route == "from_paite":
            return len(pivot_english or "")
        return 0

    def _with_meta(
        self,
        chunk: dict,
        route: str,
        pivot_english: str | None,
        text: str,
    ) -> dict:
        return {
            **chunk,
            "route": route,
            "pivot_english": pivot_english,
            "google_chars_used": self._google_chars_used(route, text, pivot_english),
        }

    def translate_stream(self, text: str, src_lang: str, tgt_lang: str):
        """Yield partial translations with progress for streaming UI."""
        self._validate_request(text, src_lang, tgt_lang)

        if not text or not text.strip():
            yield {"translation": "", "current": 0, "total": 0}
            return
        if src_lang == tgt_lang:
            yield {"translation": text, "current": 1, "total": 1}
            return

        route = resolve_route(src_lang, tgt_lang)

        if route == "hf":
            for chunk in self._translate_stream_hf(text, src_lang, tgt_lang):
                if chunk["current"] == chunk["total"] and chunk["total"] > 0:
                    yield self._with_meta(chunk, route, None, text)
                else:
                    yield chunk
        elif route == "google":
            final_result = self._translate_google(text, src_lang, tgt_lang)
            yield self._with_meta(
                {"translation": final_result, "current": 1, "total": 1},
                route,
                None,
                text,
            )
        elif route == "to_paite":
            pivot_english = self._translate_google(text, src_lang, ENGLISH)
            for chunk in self._translate_stream_hf(
                pivot_english, ENGLISH, PAITE, timestamp_source=text
            ):
                if chunk["current"] == chunk["total"] and chunk["total"] > 0:
                    yield self._with_meta(chunk, route, pivot_english, text)
                else:
                    yield chunk
        elif route == "from_paite":
            pivot_english = self._translate_hf(text, PAITE, ENGLISH)
            final_result = self._translate_google(pivot_english, ENGLISH, tgt_lang)
            yield self._with_meta(
                {"translation": final_result, "current": 1, "total": 1},
                route,
                pivot_english,
                text,
            )
        else:
            raise ValueError(f"Unsupported language pair: {src_lang} -> {tgt_lang}")
