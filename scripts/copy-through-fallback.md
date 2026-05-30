# Copy-through chunk fallback (temporary)

This document describes the temporary workaround for English-to-Paite translations
where the model returns text that is nearly identical to the English input instead
of producing Paite output.

Remove this workaround once a newer Paite model (for example the 3.3B checkpoint)
handles long or marketing-style English sentences without copy-through.

## Problem it solves

On the 600M CTranslate2 model, some English sentences—especially long marketing or
exam-prep lines—are sent to the decoder as a single unit. The model sometimes fails
by outputting almost the same English sentence instead of translating.

Shorter fragments of the same sentence often translate correctly when entered
manually. This fallback automates that idea only when copy-through is detected.

Example failure (before fallback):

- Input: `Empowering your exam journey with expert-crafted test series...`
- Output: `Empowering your exam journey with expert-crafted test series...` (unchanged)

Example after fallback:

- Output: Paite text built from translated clauses joined together (may still
  contain some English loanwords; that is acceptable).

Sentences with repeated proper nouns (for example "Zomi" three times) may copy-through
as a whole and also copy-through on medium-sized chunks. The resilient sub-split
handles that by translating smaller word groups when a chunk still matches English.

## When it runs

The fallback is **not** applied to every translation. All of the following must
be true:

1. `COPY_THROUGH_CHUNK_FALLBACK` is enabled (default: on).
2. Target language is **Paite** (`pai_Latn`).
3. The first decode output is **copy-through**: normalized source and output are
   at least 80% similar by character sequence (`COPY_THROUGH_RATIO`, default `0.80`).
4. The sentence can be split into **more than one** clause/chunk.
5. The joined chunk translation is **not** still copy-through.

If clause-level translation still copy-throughs (for example repeated proper nouns
like "Zomi" in one chunk), the fallback **sub-splits** that clause into smaller
word groups (default 4 words) and retries before giving up.

If any check fails after all strategies, the original first-pass output is returned unchanged.

## What it does not affect

- **Normal translations** where the model already produces real Paite output.
  Similarity to English is too low, so the fallback never runs.
- **Mixed output** (Paite plus English technical terms). That is not treated as
  copy-through.
- **Google Translate routes** (Mizo to Hindi, etc.). Google is not chunked.
- **Paite to English** (`from_paite` route).

Mixed Paite/English output from successful decodes is intentionally left alone.

## Routes where it can apply

The fallback lives in the Hugging Face / CTranslate2 path when the **target is
Paite**:

| Route | Google step | HF step | Fallback on HF? |
|-------|-------------|---------|-----------------|
| English to Paite | — | English to Paite | Yes |
| Mizo/Hindi/... to Paite | Source to English | English to Paite | Yes (on Google English only) |
| Paite to English | — | Paite to English | No |
| Paite to other (via English) | English to target | Paite to English | No |

For pivot routes (for example Mizo to Paite), Google produces English first;
the fallback only compares and splits that **English pivot text** if the Paite
model copy-throughs it. This is a safety net and triggers less often than direct
English to Paite because Google output is usually cleaner.

## How it works (step by step)

1. Translate the sentence once with the normal batch/beam settings.
2. Compare source and output with `difflib.SequenceMatcher` on normalized text
   (lowercase, collapsed whitespace).
3. If similarity is below the threshold, return the first output. Done.
4. If copy-through is detected, try up to three split strategies in order:
   - Delimiter-based clauses (comma, ` and `, ` with `, ` for `, etc.)
   - Fixed word chunks of `COPY_THROUGH_MAX_CLAUSE_WORDS` (default 8)
   - Fixed word chunks of `COPY_THROUGH_AGGRESSIVE_WORDS` (default 4)
5. Translate each clause. If a single clause still copy-throughs, sub-split it
   into smaller word groups and retry (up to 2 levels deep).
6. Join clause translations with spaces.
7. If the joined text is still copy-through for the full source sentence, try the
   next split strategy.
8. If a strategy succeeds, server logs: `Copy-through chunk fallback applied`.

## Files involved

| File | Role |
|------|------|
| `backend/copy_through_fallback.py` | Detection, splitting, retry logic (delete this file to remove the feature) |
| `backend/translation.py` | Calls `try_chunk_fallback` from `_translate_one_sentence` |
| `.env.example` | Documents environment variables |

Integration points in `translation.py`:

- `_translate_one_sentence()` — runs first pass, then optional fallback.
- `_translate_sentences()` — routes Paite-target HF work through
  `_translate_one_sentence` when fallback is enabled (one sentence at a time).
- `_translate_hf()` and `_translate_stream_hf()` — use `_translate_sentences` /
  `_translate_one_sentence`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `COPY_THROUGH_CHUNK_FALLBACK` | `1` | Set to `0`, `false`, `off`, or `no` to disable without deleting code |
| `COPY_THROUGH_RATIO` | `0.80` | Similarity threshold (0–1). Higher = stricter copy-through detection |
| `COPY_THROUGH_MAX_CLAUSE_WORDS` | `8` | Word-chunk size when the sentence has no comma/conjunction split points |
| `COPY_THROUGH_AGGRESSIVE_WORDS` | `4` | Smaller word chunks for sub-splitting clauses that still copy-through |

## Trade-offs

- **Context:** Clause splitting loses cross-clause context within one sentence.
  Output may read slightly stitched compared to a perfect full-sentence translation.
- **Speed:** When enabled, English-to-Paite HF translations run one sentence at a
  time instead of batching, and copy-through cases run multiple decode passes.
- **Quality ceiling:** If the model cannot translate a clause at all, the fallback
  gives up and returns the original copy-through output.

These trade-offs are acceptable as a temporary measure until the model improves.

## Disable without removing code

In Coolify (or `.env`):

```env
COPY_THROUGH_CHUNK_FALLBACK=0
```

Redeploy. No chunk splitting will run; behavior reverts to single-pass translation
(batching restored for Paite HF routes).

## Remove completely (after model upgrade)

When the Paite model handles full sentences reliably:

### 1. Delete the module

```text
backend/copy_through_fallback.py
```

### 2. Edit `backend/translation.py`

Remove:

- `from copy_through_fallback import ...`
- `_translate_one_sentence()` method
- Copy-through branches inside `_translate_sentences()`; restore direct
  `_translate_batch()` for all HF sentences
- In `_translate_stream_hf()`, restore batched `_translate_batch()` loop instead
  of per-sentence `_translate_one_sentence()`

After removal, `_translate_hf` should call `_translate_batch(all_sentences, ...)`
directly again, as it did before this workaround.

### 3. Clean up config

Remove the `COPY_THROUGH_*` comments from `.env.example`.

### 4. Delete this document

```text
scripts/copy-through-fallback.md
```

### 5. Deploy and verify

Test the previously failing sentence (exam journey line) with the new model. If
full-sentence Paite output is stable, the workaround is no longer needed.

## Verification

With fallback enabled, check server logs after translating a known copy-through
sentence. You should see:

```text
Copy-through chunk fallback applied
```

For normal short sentences (for example `Hello, how are you?`), that line should
**not** appear and output should match pre-fallback behavior.

Check `/api/status` is unrelated to this feature; it does not expose fallback
state.

## Related training note

Copy-through on long English is a model/decoding limitation on the 600M checkpoint,
not an application bug. A larger or better-trained model (for example 3.3B at
higher step counts) may make this fallback unnecessary while still allowing
English loanwords in technical text, which is normal for Paite.
