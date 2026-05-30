import os
import re
import shutil
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
from transformers import AutoModelForSeq2SeqLM, BitsAndBytesConfig, NllbTokenizer

MODEL_REPO = os.environ.get("MODEL_REPO", "sensix-zo/nllb-paite-600m-v15")
INFERENCE_BACKEND = os.environ.get("INFERENCE_BACKEND", "pytorch").lower()
BASE_NLLB_REPO = "facebook/nllb-200-distilled-600M"
HF_TOKEN = os.environ.get("HF_TOKEN")
CPU_BATCH_SIZE = int(os.environ.get("CPU_BATCH_SIZE", "1"))
GPU_BATCH_SIZE = int(os.environ.get("GPU_BATCH_SIZE", "8"))

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
        _ensure_nltk()
        if self.inference_backend == "ctranslate2":
            print(f"Loading CTranslate2 model from {CT2_MODEL_REPO}...")
            load_ct2(self)
        else:
            self._load_pytorch()
        self._warmup()

    def _warmup(self):
        """Run a tiny translation so the first user request is not cold."""
        if not self.ready:
            return
        try:
            self.translate("Hello.", ENGLISH, PAITE)
            print("Model warmup complete.")
        except Exception as exc:
            print(f"Model warmup skipped: {exc}")

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
    def _split_document(text: str) -> tuple[list[str], list[int]]:
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

        return all_sentences, para_structures

    @staticmethod
    def _reconstruct(
        para_structures: list[int],
        translated_sentences: list[str],
    ) -> str:
        final_output: list[str] = []
        sent_idx = 0
        for count in para_structures:
            if count == 0:
                final_output.append("")
            else:
                para_sents = translated_sentences[sent_idx : sent_idx + count]
                final_output.append(" ".join(para_sents))
                sent_idx += count
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

    def _translate_hf(self, text: str, src_lang: str, tgt_lang: str) -> str:
        all_sentences, para_structures = self._split_document(text)
        translated_sentences = (
            self._translate_batch(all_sentences, src_lang, tgt_lang) if all_sentences else []
        )
        result = self._reconstruct(para_structures, translated_sentences)
        if tgt_lang == PAITE:
            result = fix_bullet_points(result)
        return result

    def _translate_stream_hf(self, text: str, src_lang: str, tgt_lang: str):
        all_sentences, para_structures = self._split_document(text)
        total = len(all_sentences)
        if not all_sentences:
            yield {"translation": "", "current": 0, "total": 0}
            return

        translated_sentences: list[str] = []
        batch_size = self._batch_size()

        for i in range(0, len(all_sentences), batch_size):
            batch = all_sentences[i : i + batch_size]
            translated_sentences.extend(
                self._translate_batch(batch, src_lang, tgt_lang, batch_size)
            )
            partial = self._reconstruct(para_structures, translated_sentences)
            if tgt_lang == PAITE:
                partial = fix_bullet_points(partial)
            yield {
                "translation": partial,
                "current": len(translated_sentences),
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
            result = self._translate_hf(english, ENGLISH, PAITE)
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
            for chunk in self._translate_stream_hf(pivot_english, ENGLISH, PAITE):
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
