#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

start_backend() {
  cd "$ROOT/backend"
  if [ ! -d ".venv" ]; then
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
  fi
  export STATIC_DIR="${STATIC_DIR:-}"
  .venv/bin/uvicorn app:app --reload --host 0.0.0.0 --port 8000
}

start_frontend() {
  cd "$ROOT/frontend"
  npm install
  npm run dev
}

case "${1:-}" in
  backend) start_backend ;;
  frontend) start_frontend ;;
  *)
    echo "Usage: ./dev.sh [backend|frontend]"
    echo "Run backend and frontend in separate terminals."
    exit 1
    ;;
esac
