import os
import re
import shutil
from pathlib import Path

import nltk
import torch
from huggingface_hub import hf_hub_download, snapshot_download
from transformers import AutoModelForSeq2SeqLM, BitsAndBytesConfig, NllbTokenizer

MODEL_REPO = os.environ.get("MODEL_REPO", "sensix-zo/nllb-paite-600m-v15")
BASE_NLLB_REPO = "facebook/nllb-200-distilled-600M"
HF_TOKEN = os.environ.get("HF_TOKEN")

LANGUAGES = {
    "eng_Latn": "English",
    "pai_Latn": "Paite",
}

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
        self.device = _detect_device()
        self.quantization = "none"
        self.tokenizer: NllbTokenizer | None = None
        self.model: AutoModelForSeq2SeqLM | None = None
        self.ready = False
        self.error: str | None = None

    def load(self):
        _ensure_nltk()
        print(f"Loading model to {self.device}...")

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
            "model_repo": MODEL_REPO,
            "languages": [{"code": code, "label": label} for code, label in LANGUAGES.items()],
            "error": self.error,
        }

    def _translate_batch(
        self,
        sentences: list[str],
        src_lang: str,
        tgt_lang: str,
        batch_size: int = 8,
    ) -> list[str]:
        assert self.tokenizer is not None and self.model is not None

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
                "num_beams": 5,
                "do_sample": False,
            }

            with torch.no_grad():
                generated = self.model.generate(**inputs, **gen_kwargs)
                translated.extend(
                    self.tokenizer.batch_decode(generated, skip_special_tokens=True)
                )

        return translated

    def translate(self, text: str, src_lang: str, tgt_lang: str) -> str:
        if not self.ready or self.tokenizer is None or self.model is None:
            raise RuntimeError("Model is not loaded yet")

        if not text or not text.strip():
            return ""

        if src_lang == tgt_lang:
            return text

        if src_lang not in LANGUAGES or tgt_lang not in LANGUAGES:
            raise ValueError(f"Unsupported language pair: {src_lang} -> {tgt_lang}")

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

        translated_sentences = (
            self._translate_batch(all_sentences, src_lang, tgt_lang) if all_sentences else []
        )

        final_output: list[str] = []
        sent_idx = 0
        for count in para_structures:
            if count == 0:
                final_output.append("")
            else:
                para_sents = translated_sentences[sent_idx : sent_idx + count]
                final_output.append(" ".join(para_sents))
                sent_idx += count

        result = "\n".join(final_output)

        if tgt_lang == "pai_Latn":
            result = fix_bullet_points(result)

        return result
