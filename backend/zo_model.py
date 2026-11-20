"""Our own translation model for English and the Zo languages (sensix-zo/zo-translate-own-125m).

A 125M encoder-decoder trained from scratch with its own vocabulary. It reads any of its languages as input
(no source language is needed); a tag in front of the text, <2pck>, <2lus>, ..., chooses the language it
writes. Each line is split into sentences and translated sentence by sentence, so a paragraph is not
half translated and line breaks are kept.

It runs through CTranslate2 (int8, a few times faster on CPU) from sensix-zo/zo-translate-own-125m-ct2,
and falls back to the PyTorch model when that copy is missing or does not load (or ZO_BACKEND=pytorch).
"""

import json
import os
import re
import threading
import time
from pathlib import Path

ZO_MODEL_REPO = os.environ.get("ZO_MODEL_REPO", "sensix-zo/zo-translate-own-125m")
ZO_MODEL_PATH_FILE = Path(os.environ.get("ZO_MODEL_PATH_FILE", "/app/.zo_model_path"))
ZO_CT2_MODEL_REPO = os.environ.get("ZO_CT2_MODEL_REPO", "sensix-zo/zo-translate-own-125m-ct2")
ZO_CT2_PATH_FILE = Path(os.environ.get("ZO_CT2_PATH_FILE", "/app/.zo_ct2_path"))
ZO_BACKEND = os.environ.get("ZO_BACKEND", "ctranslate2").lower()   # "pytorch" skips CTranslate2
CT2_COMPUTE_TYPE = os.environ.get("ZO_CT2_COMPUTE_TYPE", "int8")
CT2_THREADS = int(os.environ.get("ZO_CT2_THREADS", "0")) or max(1, min(4, os.cpu_count() or 1))
CT2_PATIENCE = float(os.environ.get("ZO_CT2_PATIENCE", "2"))   # 2 = same beams as transformers
HF_TOKEN = os.environ.get("HF_TOKEN") or None
BATCH = int(os.environ.get("ZO_BATCH_SIZE", "16"))
BEAMS = int(os.environ.get("ZO_NUM_BEAMS", "4"))
MAX_EXTRA = int(os.environ.get("ZO_MAX_LANGUAGES", "12"))   # one request translates into at most this many
CANDIDATES = int(os.environ.get("ZO_CANDIDATES", "3"))      # translations offered for the main language (best + others)

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
DEFAULT_EXTRA = ["lus", "ctd"]   # Mizo and Tedim; visitors tick more under "Also translate into"


def _split_sentences(line: str) -> list[str]:
    try:
        import nltk
        return [s for s in nltk.sent_tokenize(line) if s.strip()]
    except Exception:
        return [s for s in re.split(r"(?<=[.!?])\s+", line) if s.strip()]


class ZoModel:
    def __init__(self):
        self.tok = None
        self.model = None        # PyTorch model (fallback)
        self.translator = None   # CTranslate2 translator
        self.backend: str | None = None
        self.codes: list[str] = []
        self.error: str | None = None
        self.lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.model is not None or self.translator is not None

    @staticmethod
    def _resolve(path_file: Path, repo: str) -> str:
        if path_file.exists():   # downloaded while the image was built
            p = path_file.read_text(encoding="utf-8").strip()
            if p and Path(p).exists():
                return p
        from huggingface_hub import snapshot_download
        return snapshot_download(repo_id=repo, token=HF_TOKEN)

    def _path(self) -> str:
        return self._resolve(ZO_MODEL_PATH_FILE, ZO_MODEL_REPO)

    def _set_codes(self, tok) -> None:
        added = json.loads(tok.backend_tokenizer.to_str())["added_tokens"]
        tags = {t["content"][2:-1] for t in added if t["content"].startswith("<2") and t["content"].endswith(">")}
        self.codes = [c for c in ORDER if c in tags] + sorted(c for c in tags if c not in ORDER)

    def _load_ct2(self) -> None:
        import ctranslate2
        from transformers import AutoTokenizer
        path = self._resolve(ZO_CT2_PATH_FILE, ZO_CT2_MODEL_REPO)
        tok = AutoTokenizer.from_pretrained(path)   # the CT2 folder carries tokenizer.json
        translator = ctranslate2.Translator(path, device="cpu", compute_type=CT2_COMPUTE_TYPE,
                                            inter_threads=1, intra_threads=CT2_THREADS)
        self._set_codes(tok)
        self.tok, self.translator = tok, translator
        self.backend = f"ctranslate2 {CT2_COMPUTE_TYPE}, {CT2_THREADS} threads"

    def _load_torch(self) -> None:
        import torch
        from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
        path = self._path()
        tok = AutoTokenizer.from_pretrained(path)
        model = AutoModelForSeq2SeqLM.from_pretrained(path).eval()
        self._set_codes(tok)
        torch.set_grad_enabled(False)
        self.tok, self.model = tok, model
        self.backend = "pytorch"

    def load(self) -> None:
        if ZO_BACKEND != "pytorch":
            try:
                self._load_ct2()
                return
            except Exception as exc:   # missing repo, no ctranslate2, bad files: use the PyTorch model
                print(f"Zo model: CTranslate2 copy not loaded ({type(exc).__name__}: {exc}); "
                      "using PyTorch.", flush=True)
        self._load_torch()

    def _generate(self, sources: list[str], n: int = 1) -> list[list[str]]:
        """Translates already tagged sentences ("<2pck> ..."); one call is at most BATCH sentences.
        For each sentence: its n best translations from the beam search, best first."""
        n = max(1, min(n, BEAMS))
        if self.translator is not None:
            ids = self.tok(sources, truncation=True, max_length=256)["input_ids"]   # ends with </s>, as in training
            res = self.translator.translate_batch(
                [self.tok.convert_ids_to_tokens(x) for x in ids], beam_size=BEAMS, patience=CT2_PATIENCE,
                no_repeat_ngram_size=4, max_decoding_length=256, max_batch_size=BATCH, num_hypotheses=n)
            return [[self.tok.decode(self.tok.convert_tokens_to_ids(h), skip_special_tokens=True) for h in r.hypotheses]
                    for r in res]
        import torch
        with torch.no_grad():
            enc = self.tok(sources, return_tensors="pt", padding=True, truncation=True, max_length=256)
            gen = self.model.generate(**enc, num_beams=BEAMS, no_repeat_ngram_size=4, max_new_tokens=256,
                                      num_return_sequences=n)
        flat = self.tok.batch_decode(gen, skip_special_tokens=True)
        return [flat[i * n:(i + 1) * n] for i in range(len(sources))]

    def languages(self) -> list[dict]:
        return [{"code": c, "label": NAMES.get(c, c), "little_data": c in LITTLE_DATA} for c in self.codes]

    def translate(self, text: str, code: str, n: int = 1) -> list[str]:
        """The translation of text, then up to n-1 other candidates (the k-th candidate of every sentence)."""
        if code not in self.codes:
            raise ValueError(f"Unknown language: {code}")
        lines = text.split("\n")
        pieces = [(i, s) for i, l in enumerate(lines) if l.strip() for s in _split_sentences(l.strip())]
        done: dict[int, list[list[str]]] = {}
        with self.lock:
            for start in range(0, len(pieces), BATCH):
                chunk = pieces[start:start + BATCH]
                for (i, _), hyps in zip(chunk, self._generate([f"<2{code}> {s}" for _, s in chunk], n)):
                    done.setdefault(i, []).append([h.strip() for h in hyps])
        versions = []
        for k in range(max(1, n)):
            out = list(lines)
            for i, sents in done.items():
                lead = lines[i][:len(lines[i]) - len(lines[i].lstrip())]
                out[i] = lead + " ".join(h[min(k, len(h) - 1)] for h in sents)
            versions.append("\n".join(out))
        seen, unique = set(), []
        for v in versions:   # the same text twice is not another candidate
            if v not in seen:
                seen.add(v)
                unique.append(v)
        return unique

    def translate_many(self, text: str, target: str, extra: list[str]) -> dict:
        wanted = [target] + [c for c in extra if c != target]
        wanted = wanted[:MAX_EXTRA]
        t0, results = time.time(), []
        for c in wanted:   # other candidates only for the main language: the extra languages stay quick
            versions = self.translate(text, c, CANDIDATES if c == target else 1)
            results.append({"code": c, "label": NAMES.get(c, c), "translation": versions[0],
                            "alternatives": versions[1:]})
        return {"results": results, "seconds": round(time.time() - t0, 2)}


zo = ZoModel()


def load_in_background() -> None:
    """Loads after the main model, without holding up the app's start."""
    def run():
        try:
            zo.load()
            print(f"Zo model ready: {len(zo.codes)} languages ({zo.backend})", flush=True)
        except Exception as exc:  # the rest of the site keeps working without it
            zo.error = str(exc)
            print(f"Zo model failed to load: {exc}", flush=True)
    threading.Thread(target=run, daemon=True).start()
