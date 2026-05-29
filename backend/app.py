import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from translation import TranslationEngine

engine = TranslationEngine()

CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")
STATIC_DIR = os.environ.get("STATIC_DIR")


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        engine.load()
    except Exception as exc:
        engine.error = str(exc)
        print(f"Failed to load model: {exc}")
    yield


app = FastAPI(title="Paite Translator API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS if CORS_ORIGINS != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TranslateRequest(BaseModel):
    text: str = Field(default="", max_length=50000)
    src_lang: str = "eng_Latn"
    tgt_lang: str = "pai_Latn"


class TranslateResponse(BaseModel):
    translation: str
    src_lang: str
    tgt_lang: str


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/status")
def status():
    return engine.status()


@app.post("/api/translate", response_model=TranslateResponse)
def translate(body: TranslateRequest):
    if not engine.ready:
        detail = engine.error or "Model is still loading. Please try again shortly."
        raise HTTPException(status_code=503, detail=detail)

    try:
        result = engine.translate(body.text, body.src_lang, body.tgt_lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return TranslateResponse(
        translation=result,
        src_lang=body.src_lang,
        tgt_lang=body.tgt_lang,
    )


@app.post("/api/translate/stream")
def translate_stream(body: TranslateRequest):
    if not engine.ready:
        detail = engine.error or "Model is still loading. Please try again shortly."
        raise HTTPException(status_code=503, detail=detail)

    def event_stream():
        partial = ""
        try:
            for partial in engine.translate_stream(body.text, body.src_lang, body.tgt_lang):
                payload = json.dumps(
                    {"translation": partial, "done": False},
                    ensure_ascii=False,
                )
                yield f"data: {payload}\n\n"
            final = json.dumps({"translation": partial, "done": True}, ensure_ascii=False)
            yield f"data: {final}\n\n"
        except ValueError as exc:
            payload = json.dumps({"error": str(exc), "done": True}, ensure_ascii=False)
            yield f"data: {payload}\n\n"
        except Exception as exc:
            payload = json.dumps({"error": str(exc), "done": True}, ensure_ascii=False)
            yield f"data: {payload}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if STATIC_DIR and os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
