"""Pre-download inference models during Docker build."""

import os
import shutil

import nltk
from huggingface_hub import hf_hub_download, snapshot_download

backend = os.environ.get("INFERENCE_BACKEND", "ctranslate2").lower()
token = os.environ.get("HF_TOKEN") or None

nltk.download("punkt", quiet=True)
nltk.download("punkt_tab", quiet=True)

if backend == "ctranslate2":
    snapshot_download(repo_id=os.environ["CT2_MODEL_REPO"], token=token)
else:
    local_repo_path = snapshot_download(repo_id=os.environ["MODEL_REPO"], token=token)
    spm_path = hf_hub_download(
        repo_id="facebook/nllb-200-distilled-600M",
        filename="sentencepiece.bpe.model",
        token=token,
    )
    shutil.copy(spm_path, os.path.join(local_repo_path, "sentencepiece.bpe.model"))

print(f"Model download complete ({backend}).")
