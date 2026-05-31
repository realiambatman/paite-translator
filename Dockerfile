# Build React frontend
FROM node:22-alpine AS frontend-build
WORKDIR /app/frontend

ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_TRANSLATIONS_COLLECTION=translations
ARG VITE_FIREBASE_GOOGLE_QUOTA_COLLECTION=google_translate_quota
ARG BUILD_ID=dev

ENV VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_STORAGE_BUCKET=$VITE_FIREBASE_STORAGE_BUCKET \
    VITE_FIREBASE_MESSAGING_SENDER_ID=$VITE_FIREBASE_MESSAGING_SENDER_ID \
    VITE_FIREBASE_APP_ID=$VITE_FIREBASE_APP_ID \
    VITE_FIREBASE_TRANSLATIONS_COLLECTION=$VITE_FIREBASE_TRANSLATIONS_COLLECTION \
    VITE_FIREBASE_GOOGLE_QUOTA_COLLECTION=$VITE_FIREBASE_GOOGLE_QUOTA_COLLECTION \
    VITE_BUILD_ID=$BUILD_ID

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# Python inference server
FROM python:3.11-slim AS runtime

ARG BUILD_ID=dev
ARG INFERENCE_BACKEND=ctranslate2
ARG MODEL_REPO=sensix-zo/nllb-paite-600m-v15
ARG CT2_MODEL_REPO=sensix-zo/nllb-paite-600m-v15-ct2
ARG HF_TOKEN=

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    STATIC_DIR=/app/static \
    BUILD_ID=$BUILD_ID \
    INFERENCE_BACKEND=$INFERENCE_BACKEND \
    MODEL_REPO=$MODEL_REPO \
    CT2_MODEL_REPO=$CT2_MODEL_REPO \
    HF_HOME=/app/.cache/huggingface \
    HF_TOKEN=$HF_TOKEN

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

# Bake models into the image so cold starts only load into memory, not re-download.
# Use a script file — Coolify injects ARG lines into heredocs and breaks inline Python.
COPY backend/download_models.py ./backend/download_models.py
RUN python backend/download_models.py

# Runtime only — model is baked above; block HF network lookups on container start.
ENV HF_HUB_OFFLINE=1 \
    CT2_INTER_THREADS=2

COPY backend/ ./backend/
COPY --from=frontend-build /app/frontend/dist ./static

WORKDIR /app/backend

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/ready', timeout=4)" || exit 1

CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}"]
