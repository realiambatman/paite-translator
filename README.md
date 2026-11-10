# Zomi Translator

A web translator for Paite, the most widely spoken Zomi language, with a
built-in loop for collecting corrections and improving the model over time.

English ↔ Paite runs on a fine-tuned NLLB-200 model served from this app.
Other languages (Mizo, Meitei, Burmese, Hindi, Assamese, Bengali, Bodo, Khasi,
Kokborok and more) are bridged through English with Google Translate.

Live at [translate.sensix.in](https://translate.sensix.in/).

## What it does

**For visitors**

- Translate typed text, uploaded files (`.txt`, `.pdf`, `.docx`) and photos of
  text taken with the camera or uploaded as images (OCR with Tesseract).
- See other candidate translations from the model's beam search and pick a
  better one.
- Rate a translation or suggest a fix. Suggestions are stored for review and
  never change the live output.
- Edit the English bridge step when translating to or from a language that goes
  through Google, then re-run only the second half.
- Optionally simplify long or idiomatic English before translating, which helps
  a small model considerably. Shown only when an AI provider key is configured.

**For the maintainer** (`/admin`, password-protected)

- **Translations**: every logged translation with dates, the uploaded image or
  file behind it, the model's other candidates, and all feedback on that entry.
- **Corrections**: suggestions from visitors and from AI reviewers, grouped per
  translation. Mark each as "use for training" or not, edit before accepting,
  and export the accepted pairs as CSV, JSON or JSONL.
- **Glossary**: find-and-replace rules applied to model output, for names and
  fixed terms the model keeps getting wrong. Takes effect within a minute.
- **AI review**: have Claude, GPT or Gemini review past translations in bulk or
  one row at a time. Confident fixes become pending suggestions. Several models
  can review the same entries for a second opinion.

## How it works

One container serves everything. The Dockerfile builds the React frontend, then
copies the static files into the Python image, and FastAPI serves both the API
(`/api/*`) and the site from port 8000.

```
Browser ──► FastAPI (backend/app.py)
              ├─ /api/translate*      NLLB via CTranslate2  (English ↔ Paite)
              │                       Google Translate      (everything else)
              ├─ /api/extract         PDF / DOCX / OCR text extraction
              ├─ /api/admin/*         admin panel API (service account → Firestore)
              └─ /*                   built frontend (SPA, /admin included)

Browser ──► Firestore   write-only: translation log, feedback, daily Google quota
Server  ──► S3 / MinIO  uploaded files and camera photos
```

How a language pair is routed:

| Pair | Route |
| --- | --- |
| English ↔ Paite | Paite model directly |
| Other → Paite | Google to English, then the Paite model |
| Paite → Other | Paite model to English, then Google |
| Other ↔ Other | Google only |

Before translation, input is normalised (quotes, dashes, invisible characters,
OCR spacing) and split into sentences. After translation, glossary rules are
applied. A temporary fallback retries in smaller chunks when the model copies
English through unchanged; see
[scripts/copy-through-fallback.md](scripts/copy-through-fallback.md).

## Repository layout

```
backend/
  app.py                 FastAPI app and public API routes
  translation.py         translation engine, sentence splitting, routing
  ct2_inference.py       CTranslate2 inference (beams, n-best alternatives)
  file_extract.py        text extraction from PDF, DOCX and images (OCR)
  lang_detect.py         warns when extracted text does not match the source language
  google_translate.py    Google Cloud Translation client
  google_quota.py        app-side daily character cap for Google
  glossary.py            glossary rules loaded from Firestore, applied to output
  text_normalize.py      input normalisation
  llm_provider.py        Claude / OpenAI / Gemini completion for admin tooling
  simplify.py            "Simplify English" rewrite
  object_storage.py      S3-compatible uploads and presigned links
  admin/                 admin API: auth, Firestore access, review job, routes
frontend/
  src/App.tsx            the translator page
  src/components/        feedback panel, pivot editor, camera, crop, upload
  src/services/          API client, Firestore logging, feedback, history
  src/admin/             the admin panel (lazy-loaded at /admin)
firestore.rules          Firestore security rules
scripts/                 model conversion notebook and notes
Dockerfile               two-stage build: frontend, then Python runtime
docker-compose.yml       run the container locally
dev.sh                   run backend or frontend in development
```

## Running locally

Requirements: Python 3.11, Node 22, and Tesseract with the `eng`, `hin`, `ben`
and `mya` language packs if you want OCR.

Copy the environment template and fill in what you need. The Firebase values
are optional for local work; without them nothing is logged.

```bash
cp .env.example .env
```

Start the backend. The first run creates a virtualenv, installs dependencies
and downloads the model, which takes a while.

```bash
./dev.sh backend
```

In a second terminal, start the frontend. It proxies `/api` to the backend.

```bash
./dev.sh frontend
```

The site is at `http://localhost:5173` and the admin panel at
`http://localhost:5173/admin`.

To run the production image instead:

```bash
docker compose up --build
```

## Configuration

All settings are environment variables. [.env.example](.env.example) documents
every one; these are the ones that matter most.

| Variable | Purpose |
| --- | --- |
| `CT2_MODEL_REPO`, `MODEL_REPO` | Hugging Face repos for the CTranslate2 and PyTorch models |
| `INFERENCE_BACKEND` | `ctranslate2` (default in Docker) or `pytorch` |
| `NUM_BEAMS`, `CPU_NUM_BEAMS` | Beam width. More beams improve quality and cost speed |
| `REPETITION_PENALTY`, `NO_REPEAT_NGRAM_SIZE` | Stop the model repeating itself |
| `MAX_TRANSLATION_TOKENS` | Input limit, about 4 characters per token |
| `GOOGLE_TRANSLATE_API_KEY` | Enables every non-Paite language |
| `GOOGLE_DAILY_CHAR_LIMIT` | App-side daily cap on Google usage |
| `VITE_FIREBASE_*` | Firebase web config, baked into the frontend at build time |
| `AWS_*` | S3 or MinIO bucket for uploaded files and photos |
| `ADMIN_PASSWORD` | Password for `/admin`. Leave empty to disable the panel |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Service-account key so the server can read Firestore |
| `BUILD_ID` | Set per deploy so browsers pick up the new frontend |

AI provider keys for review and Simplify English are entered in the admin
panel and stored in Firestore. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
`GEMINI_API_KEY` work as environment fallbacks.

## Firestore

The browser can only create documents; it cannot read, update or delete them.
The server reads through a service account, which bypasses the rules.

| Collection | Written by | Contents |
| --- | --- | --- |
| `translations` | browser | source, output, route, English pivot, file link, beam alternatives |
| `corrections` | browser, admin, AI review | ratings and suggested fixes with a training decision |
| `glossary` | admin | find-and-replace rules per output language |
| `admin_settings` | admin | AI provider choice and keys |
| `google_translate_quota` | browser | characters sent to Google per day |

Publish [firestore.rules](firestore.rules) whenever it changes, either by
pasting it into Firebase Console → Firestore → Rules, or with the Firebase CLI.

## Setting up the admin panel

1. Set `ADMIN_PASSWORD`.
2. Create a service-account key: Google Cloud Console → IAM & Admin → Service
   accounts → `firebase-adminsdk` → Keys → Add key → JSON. If key creation is
   blocked, turn off the organisation policy
   `iam.disableServiceAccountKeyCreation` for the project first.
3. Put the key in `FIREBASE_SERVICE_ACCOUNT_JSON` as a single line. This
   collapses the downloaded file and copies it to the clipboard on macOS:

   ```bash
   python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))), end="")' key.json | pbcopy
   ```

4. Deploy, open `/admin`, and sign in.

Never commit the key file. `.gitignore` excludes the usual file names.

## Deployment

The app is deployed as a single Docker service (Coolify in production).

- Pass the `VITE_FIREBASE_*` values and `BUILD_ID` as build arguments, since
  the frontend is compiled during the image build.
- The model is downloaded and baked into the image at build time. Do not set
  `HF_HUB_OFFLINE` yourself; the Dockerfile sets it after the download.
- The health check calls `/api/ready`, which reports ready once the model is
  loaded.
- A bulk AI review runs inside the server process. A redeploy stops it; start
  it again and choose Skip to continue where it left off.

## Improving the model

The correction loop exists to produce training data.

1. Visitors rate translations and suggest fixes. AI review adds suggestions for
   past entries, and you can promote one of the model's own beam candidates.
2. In the admin panel, mark the good ones "use for training".
3. Export the accepted pairs from the Corrections tab. JSONL is the easiest
   format for training scripts.
4. Fine-tune NLLB on the new pairs, convert the result with
   [scripts/convert_nllb_to_ct2_colab.ipynb](scripts/convert_nllb_to_ct2_colab.ipynb),
   upload it to Hugging Face, and point `CT2_MODEL_REPO` at it.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | model state, languages, limits, feature flags |
| `GET` | `/api/ready` | readiness probe |
| `POST` | `/api/translate/stream` | translate text, streamed sentence by sentence |
| `POST` | `/api/translate` | translate text, single response |
| `POST` | `/api/translate/alternatives` | other beam candidates for a short sentence |
| `POST` | `/api/extract` | extract text from a file or image |
| `POST` | `/api/simplify` | rewrite English into short plain sentences |
| `*` | `/api/admin/*` | admin panel API, requires the admin password |

## Credits

Model by [sensix-zo](https://huggingface.co/sensix-zo) on Hugging Face, built
on Meta's NLLB-200.
