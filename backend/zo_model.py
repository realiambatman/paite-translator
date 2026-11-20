"""Our own translation model for English and the Zo languages (sensix-zo/zo-translate-own-125m).

A 125M encoder-decoder trained from scratch with its own vocabulary. It reads any of its languages as input
(no source language is needed); a tag in front of the text, <2pck>, <2lus>, ..., chooses the language it
writes. Each line is split into sentences and translated sentence by sentence, so a paragraph is not
half translated and line breaks are kept.
"""

import json
import os
import re
import threading
import time
from pathlib import Path

ZO_MODEL_REPO = os.environ.get("ZO_MODEL_REPO", "sensix-zo/zo-translate-own-125m")
ZO_MODEL_PATH_FILE = Path(os.environ.get("ZO_MODEL_PATH_FILE", "/app/.zo_model_path"))
HF_TOKEN = os.environ.get("HF_TOKEN") or None
BATCH = int(os.environ.get("ZO_BATCH_SIZE", "16"))
BEAMS = int(os.environ.get("ZO_NUM_BEAMS", "4"))
MAX_EXTRA = int(os.environ.get("ZO_MAX_LANGUAGES", "12"))   # one request translates into at most this many

NAMES = {
    "en": "English", "pck": "Paite", "lus": "Mizo", "ctd": "Tedim", "hmr": "Hmar", "tcz": "Thadou",
    "vap": "Vaiphei", "zom": "Zou", "smt": "Simte", "gnb": "Gangte", "cnh": "Hakha", "cfm": "Falam",
    "csy": "Siyin", "cnk": "Khumi", "bgr": "Bawm", "hlt": "Matu", "mrh": "Mara", "zyp": "Zyphe", "dao": "Daai",
    "lmk": "Lamkang", "cnw": "Ngawn", "czt": "Zotung", "biu": "Biate", "kmm": "Kom", "aim": "Aimol",
    "hi": "Hindi", "hi_Latn": "Hindi (Latin letters)", "my": "Burmese", "my_Latn": "Burmese (Latin letters)",
    "mni": "Meitei (Bengali script)", "mni_Mtei": "Meitei (Meitei Mayek)", "mni_Latn": "Meitei (Latin letters)",
}
# Languages with very few sentence pairs in training: output in them is a rough guess.
LITTLE_DATA = {"kmm", "aim", "biu", "lmk", "cnw", "czt", "dao", "zyp"}
ORDER = ["en", "pck", "lus", "ctd", "hmr", "tcz", "vap", "zom", "smt", "gnb", "cnh", "cfm", "csy"]
DEFAULT_TARGET = "pck"
DEFAULT_EXTRA = ["smt", "hmr", "vap", "gnb", "tcz", "lus", "zom", "ctd"]


def _split_sentences(line: str) -> list[str]:
    try:
        import nltk
        return [s for s in nltk.sent_tokenize(line) if s.strip()]
    except Exception:
        return [s for s in re.split(r"(?<=[.!?])\s+", line) if s.strip()]


class ZoModel:
    def __init__(self):
        self.tok = None
        self.model = None
        self.codes: list[str] = []
        self.error: str | None = None
        self.lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.model is not None

    def _path(self) -> str:
        if ZO_MODEL_PATH_FILE.exists():   # downloaded while the image was built
            p = ZO_MODEL_PATH_FILE.read_text(encoding="utf-8").strip()
            if p and Path(p).exists():
                return p
        from huggingface_hub import snapshot_download
        return snapshot_download(repo_id=ZO_MODEL_REPO, token=HF_TOKEN)

    def load(self) -> None:
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        path = self._path()
        tok = AutoTokenizer.from_pretrained(path)
        model = AutoModelForSeq2SeqLM.from_pretrained(path).eval()
        added = json.loads(tok.backend_tokenizer.to_str())["added_tokens"]
        tags = {t["content"][2:-1] for t in added if t["content"].startswith("<2") and t["content"].endswith(">")}
        self.codes = [c for c in ORDER if c in tags] + sorted(c for c in tags if c not in ORDER)
        torch.set_grad_enabled(False)
        self.tok, self.model = tok, model

    def languages(self) -> list[dict]:
        return [{"code": c, "label": NAMES.get(c, c), "little_data": c in LITTLE_DATA} for c in self.codes]

    def translate(self, text: str, code: str) -> str:
        import torch
        if code not in self.codes:
            raise ValueError(f"Unknown language: {code}")
        lines = text.split("\n")
        pieces = [(i, s) for i, l in enumerate(lines) if l.strip() for s in _split_sentences(l.strip())]
        done: dict[int, list[str]] = {}
        with self.lock, torch.no_grad():
            for start in range(0, len(pieces), BATCH):
                chunk = pieces[start:start + BATCH]
                enc = self.tok([f"<2{code}> {s}" for _, s in chunk], return_tensors="pt", padding=True,
                               truncation=True, max_length=256)
                gen = self.model.generate(**enc, num_beams=BEAMS, no_repeat_ngram_size=4, max_new_tokens=256)
                for (i, _), t in zip(chunk, self.tok.batch_decode(gen, skip_special_tokens=True)):
                    done.setdefault(i, []).append(t.strip())
        out = list(lines)
        for i, parts in done.items():
            lead = lines[i][:len(lines[i]) - len(lines[i].lstrip())]
            out[i] = lead + " ".join(parts)
        return "\n".join(out)

    def translate_many(self, text: str, target: str, extra: list[str]) -> dict:
        wanted = [target] + [c for c in extra if c != target]
        wanted = wanted[:MAX_EXTRA]
        t0, results = time.time(), []
        for c in wanted:
            results.append({"code": c, "label": NAMES.get(c, c), "translation": self.translate(text, c)})
        return {"results": results, "seconds": round(time.time() - t0, 2)}


zo = ZoModel()


def load_in_background() -> None:
    """Loads after the main model, without holding up the app's start."""
    def run():
        try:
            zo.load()
            print(f"Zo model ready: {len(zo.codes)} languages", flush=True)
        except Exception as exc:  # the rest of the site keeps working without it
            zo.error = str(exc)
            print(f"Zo model failed to load: {exc}", flush=True)
    threading.Thread(target=run, daemon=True).start()
