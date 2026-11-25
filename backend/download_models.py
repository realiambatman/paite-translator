"""Pre-download inference models during Docker build."""

import os
import shutil
from pathlib import Path

import nltk
from huggingface_hub import hf_hub_download, snapshot_download

MODEL_PATH_FILE = Path(os.environ.get("MODEL_PATH_FILE", "/app/.model_path"))

backend = os.environ.get("INFERENCE_BACKEND", "ctranslate2").lower()
token = os.environ.get("HF_TOKEN") or None

nltk.download("punkt", quiet=True)
nltk.download("punkt_tab", quiet=True)

if backend == "ctranslate2":
    model_path = snapshot_download(repo_id=os.environ["CT2_MODEL_REPO"], token=token)
else:
    model_path = snapshot_download(repo_id=os.environ["MODEL_REPO"], token=token)
    spm_path = hf_hub_download(
        repo_id="facebook/nllb-200-distilled-600M",
        filename="sentencepiece.bpe.model",
        token=token,
    )
    shutil.copy(spm_path, os.path.join(model_path, "sentencepiece.bpe.model"))

MODEL_PATH_FILE.write_text(model_path, encoding="utf-8")
print(f"Model download complete ({backend}): {model_path}")

# Our own model for English and the Zo languages (zo_model.py)
ZO_MODEL_PATH_FILE = Path(os.environ.get("ZO_MODEL_PATH_FILE", "/app/.zo_model_path"))
zo_repo = os.environ.get("ZO_MODEL_REPO", "sensix-zo/zo-translate-small")
try:
    zo_path = snapshot_download(repo_id=zo_repo, token=token)
    ZO_MODEL_PATH_FILE.write_text(zo_path, encoding="utf-8")
    print(f"Zo model download complete: {zo_path}")
except Exception as exc:  # the site still builds; the model then downloads when the app starts
    print(f"Zo model not downloaded during the build ({type(exc).__name__}); it will load at startup.")

# The same model converted to CTranslate2 int8, which zo_model.py prefers (the PyTorch copy above is the fallback)
ZO_CT2_PATH_FILE = Path(os.environ.get("ZO_CT2_PATH_FILE", "/app/.zo_ct2_path"))
zo_ct2_repo = os.environ.get("ZO_CT2_MODEL_REPO", "sensix-zo/zo-translate-small-ct2")
try:
    zo_ct2_path = snapshot_download(repo_id=zo_ct2_repo, token=token)
    ZO_CT2_PATH_FILE.write_text(zo_ct2_path, encoding="utf-8")
    print(f"Zo CTranslate2 model download complete: {zo_ct2_path}")
except Exception as exc:  # the site still builds; the app then uses the PyTorch copy
    print(f"Zo CTranslate2 model not downloaded during the build ({type(exc).__name__}); "
          "the PyTorch copy will be used.")
