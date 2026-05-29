"""CTranslate2 inference path for NLLB (faster CPU inference)."""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import ctranslate2
from huggingface_hub import snapshot_download
from transformers import NllbTokenizer

if TYPE_CHECKING:
    from translation import TranslationEngine

CT2_MODEL_REPO = os.environ.get(
    "CT2_MODEL_REPO", "sensix-zo/nllb-paite-600m-v15-ct2"
)
HF_TOKEN = os.environ.get("HF_TOKEN")
CT2_COMPUTE_TYPE = os.environ.get("CT2_COMPUTE_TYPE", "int8")
CT2_INTER_THREADS = int(os.environ.get("CT2_INTER_THREADS", "4"))
CT2_INTRA_THREADS = int(os.environ.get("CT2_INTRA_THREADS", "1"))


def ct2_device() -> str:
    if os.environ.get("CT2_DEVICE"):
        return os.environ["CT2_DEVICE"]
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
    except ImportError:
        pass
    return "cpu"


def load_ct2(engine: TranslationEngine) -> None:
    model_path = snapshot_download(repo_id=CT2_MODEL_REPO, token=HF_TOKEN)
    device = ct2_device()
    compute_type = CT2_COMPUTE_TYPE
    if device == "cpu" and compute_type == "default":
        compute_type = "int8"

    engine.ct2_translator = ctranslate2.Translator(
        model_path,
        device=device,
        compute_type=compute_type,
        inter_threads=CT2_INTER_THREADS,
        intra_threads=CT2_INTRA_THREADS,
    )
    engine.tokenizer = NllbTokenizer.from_pretrained(model_path)
    engine.device = device
    engine.quantization = f"CTranslate2 {compute_type}"
    engine.inference_backend = "ctranslate2"
    engine.model_repo = CT2_MODEL_REPO
    engine.model = None
    engine.ready = True
    print(f"CTranslate2 model ready on {device} ({engine.quantization})")


def translate_batch_ct2(
    engine: TranslationEngine,
    sentences: list[str],
    src_lang: str,
    tgt_lang: str,
    batch_size: int,
    num_beams: int,
) -> list[str]:
    assert engine.tokenizer is not None and engine.ct2_translator is not None

    translated: list[str] = []
    target_prefix = [tgt_lang]

    for i in range(0, len(sentences), batch_size):
        batch = sentences[i : i + batch_size]
        sources: list[list[str]] = []
        max_input_len = 0

        for sentence in batch:
            engine.tokenizer.src_lang = src_lang
            token_ids = engine.tokenizer.encode(sentence, truncation=True, max_length=512)
            max_input_len = max(max_input_len, len(token_ids))
            sources.append(engine.tokenizer.convert_ids_to_tokens(token_ids))

        max_decoding_length = int(50 + 2.5 * max_input_len)
        results = engine.ct2_translator.translate_batch(
            sources,
            target_prefix=[target_prefix] * len(sources),
            beam_size=num_beams,
            max_decoding_length=max_decoding_length,
        )

        for result in results:
            tokens = result.hypotheses[0][1:]
            translated.append(
                engine.tokenizer.decode(
                    engine.tokenizer.convert_tokens_to_ids(tokens),
                    skip_special_tokens=True,
                )
            )

    return translated
