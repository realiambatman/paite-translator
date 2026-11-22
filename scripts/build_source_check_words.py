"""Word lists for backend/source_check.py: is the text typed on the Zo tab English or not?

    python3 scripts/build_source_check_words.py "<zo corpus project folder>"

Reads, from the Zo corpus project:
  training_data/zomi_trainer/base_cpt_en.jsonl   English text (Simple Wikipedia + TinyStories)
  corpus/<language>/wordlist.tsv                  word counts of every Zo language
and writes two plain lists, most frequent first:
  backend/data/english_only_words.txt   common English words that Zo text hardly ever uses
  backend/data/zo_only_words.txt        common Zo words that English text hardly ever uses
Words both sides use ("a", "in", "an", "hi", "he", "i") are in neither list, so they decide nothing.
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

SRC = Path(sys.argv[1])
OUT = Path(__file__).resolve().parents[1] / "backend" / "data"
WORD = re.compile(r"[a-zâêîôûṭ']+")
KEEP = 30000

en = Counter()
for line in open(SRC / "training_data" / "zomi_trainer" / "base_cpt_en.jsonl", encoding="utf-8"):
    en.update(w.strip("'") for w in WORD.findall(json.loads(line)["text"].lower()))
en.pop("", None)

zo = Counter()
for p in sorted((SRC / "corpus").glob("*/wordlist.tsv")):
    if p.parent.name.startswith("_"):
        continue
    for i, line in enumerate(open(p, encoding="utf-8")):
        if i == 0:
            continue
        w, c = line.rstrip("\n").split("\t")
        zo[w.lower().strip("'")] += int(c)

n_en, n_zo = sum(en.values()), sum(zo.values())
english_only = [w for w, c in en.most_common() if c >= 30 and len(w) >= 2
                and (zo.get(w, 0) / n_zo) < 0.3 * (c / n_en)][:KEEP]
zo_only = [w for w, c in zo.most_common() if c >= 150 and len(w) >= 2
           and (en.get(w, 0) / n_en) < 0.02 * (c / n_zo)][:KEEP]
OUT.mkdir(exist_ok=True)
(OUT / "english_only_words.txt").write_text("\n".join(english_only) + "\n", encoding="utf-8")
(OUT / "zo_only_words.txt").write_text("\n".join(zo_only) + "\n", encoding="utf-8")
print("english-only", len(english_only), english_only[:25])
print("zo-only", len(zo_only), zo_only[:25])
for w in ("the", "house", "spoon", "a", "in", "hi", "he", "i", "school", "ka", "leh", "chanchin", "ahi", "to", "no", "me"):
    print(f"  {w:10s} english-only={w in set(english_only)}  zo-only={w in set(zo_only)}  en={en.get(w, 0)} zo={zo.get(w, 0)}")
