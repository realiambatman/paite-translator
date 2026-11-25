import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from admin.router import router as admin_router
from file_extract import extract_text, supported_filename
from lang_detect import language_check_payload
from object_storage import is_configured as storage_configured, upload_bytes
from simplify import is_available as simplify_available, simplify_english
from static_files import SpaStaticFiles
from limits import MAX_TRANSLATION_TOKENS, max_chars_for_tokens
from translation import TranslationEngine
from source_check import is_english
from zo_model import DEFAULT_EXTRA as ZO_DEFAULT_EXTRA, DEFAULT_TARGET as ZO_DEFAULT_TARGET, load_in_background as zo_load, zo

engine = TranslationEngine()

BUILD_ID = os.environ.get("BUILD_ID", "dev")

CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "*").split(",")
STATIC_DIR = os.environ.get("STATIC_DIR")


@asynccontextmanager
async def lifespan(_: FastAPI):
    print("Starting model load (uvicorn will accept requests after this)...", flush=True)
    try:
        engine.load()
    except Exception as exc:
        engine.error = str(exc)
        print(f"Failed to load model: {exc}", flush=True)
    else:
        print("API ready to serve.", flush=True)
    zo_load()   # our own Zo-languages model, loaded alongside without delaying the site
    yield


app = FastAPI(title="Paite Translator API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS if CORS_ORIGINS != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(admin_router)


class TranslateRequest(BaseModel):
    text: str = Field(default="", max_length=max_chars_for_tokens(MAX_TRANSLATION_TOKENS))
    src_lang: str = "eng_Latn"
    tgt_lang: str = "pai_Latn"


class TranslateResponse(BaseModel):
    translation: str
    src_lang: str
    tgt_lang: str


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/ready")
def ready():
    if not engine.ready:
        detail = engine.error or "Model is still loading."
        raise HTTPException(status_code=503, detail=detail)
    return {"ready": True, "device": engine.device}


@app.get("/api/version")
def version():
    return {"build": BUILD_ID}


@app.get("/api/status")
def status():
    payload = engine.status()
    payload["object_storage_configured"] = storage_configured()
    payload["simplify_available"] = simplify_available()
    return payload


class AlternativesResponse(BaseModel):
    alternatives: list[str]


@app.post("/api/translate/alternatives", response_model=AlternativesResponse)
def translate_alternatives(body: TranslateRequest):
    """N-best candidates for short single-sentence English<->Paite inputs."""
    if not engine.ready:
        raise HTTPException(status_code=503, detail="Model is still loading.")
    try:
        return AlternativesResponse(
            alternatives=engine.alternatives(body.text, body.src_lang, body.tgt_lang)
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


class SimplifyRequest(BaseModel):
    text: str = Field(default="", max_length=max_chars_for_tokens(MAX_TRANSLATION_TOKENS) * 2)


class SimplifyResponse(BaseModel):
    text: str


class ZoTranslateRequest(BaseModel):
    text: str = Field(default="", max_length=max_chars_for_tokens(MAX_TRANSLATION_TOKENS))
    source: str = "en"            # the language the visitor says the text is in
    target: str = ZO_DEFAULT_TARGET
    extra: list[str] = Field(default_factory=list)


@app.get("/api/zo/status")
def zo_status():
    """Our own model for English and the Zo languages: whether it is ready, and its languages."""
    return {"ready": zo.ready, "error": zo.error, "languages": zo.languages(),
            "default_target": ZO_DEFAULT_TARGET, "default_extra": ZO_DEFAULT_EXTRA}


@app.post("/api/zo/translate")
def zo_translate(body: ZoTranslateRequest):
    if not zo.ready:
        raise HTTPException(status_code=503, detail=zo.error or "The Zo model is still loading. Please try again shortly.")
    if not body.text.strip():
        return {"results": [], "seconds": 0}
    # The language the visitor says the text is in is never an answer. From a Zo language any other language
    # may be tried (the page marks Zo to Zo as in progress). When the source says English but the text itself
    # clearly is not, the answer is English only, and the page says so.
    # The model is told the language of the text (its source tag): the one the visitor chose, except when the
    # text contradicts it (source English, text not English), where no source is given.
    english = is_english(body.text)
    only_english = body.source == "en" and not english
    if only_english:
        wanted = ["en"]
    else:
        wanted = [c for c in dict.fromkeys([body.target, *body.extra]) if c != body.source]
        if not wanted:
            raise HTTPException(status_code=400, detail="Choose a language to translate into.")
    try:
        out = zo.translate_many(body.text, wanted[0], wanted[1:], None if only_english else body.source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    out["english_only"] = only_english
    out["source_english"] = english
    return out


@app.post("/api/simplify", response_model=SimplifyResponse)
def simplify(body: SimplifyRequest):
    if not simplify_available():
        raise HTTPException(status_code=503, detail="Simplify is not configured on the server.")
    try:
        return SimplifyResponse(text=simplify_english(body.text))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/translate", response_model=TranslateResponse)
def translate(body: TranslateRequest):
    if not engine.ready:
        detail = engine.error or "Model is still loading. Please try again shortly."
        raise HTTPException(status_code=503, detail=detail)

    try:
        result = engine.translate(body.text, body.src_lang, body.tgt_lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
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
        current = 0
        total = 0
        pivot_english = None
        route = None
        google_chars_used = 0
        try:
            for chunk in engine.translate_stream(body.text, body.src_lang, body.tgt_lang):
                partial = chunk["translation"]
                current = chunk["current"]
                total = chunk["total"]
                if chunk.get("route") is not None:
                    route = chunk["route"]
                if chunk.get("pivot_english") is not None:
                    pivot_english = chunk["pivot_english"]
                if chunk.get("google_chars_used") is not None:
                    google_chars_used = chunk["google_chars_used"]
                payload = json.dumps(
                    {
                        "translation": partial,
                        "current": current,
                        "total": total,
                        "done": False,
                    },
                    ensure_ascii=False,
                )
                yield f"data: {payload}\n\n"
            final = json.dumps(
                {
                    "translation": partial,
                    "current": current,
                    "total": total,
                    "route": route,
                    "pivot_english": pivot_english,
                    "google_chars_used": google_chars_used,
                    "done": True,
                },
                ensure_ascii=False,
            )
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


def _storage_payload(stored) -> dict:
    if stored is None:
        return {}
    return {
        "storage_key": stored.key,
        "storage_url": stored.url,
        "storage_bucket": stored.bucket,
    }


def _file_translation_stream(
    text: str,
    extracted,
    src_lang: str,
    tgt_lang: str,
    stored,
    source: str,
):
    partial = ""
    current = 0
    total = 0
    pivot_english = None
    route = None
    google_chars_used = 0
    storage = _storage_payload(stored)

    extracted_payload = json.dumps(
        {
            "extracted_text": text,
            "extraction_method": extracted.method,
            "filename": extracted.filename,
            "source": source,
            **storage,
            "done": False,
        },
        ensure_ascii=False,
    )
    yield f"data: {extracted_payload}\n\n"

    for chunk in engine.translate_stream(text, src_lang, tgt_lang):
        partial = chunk["translation"]
        current = chunk["current"]
        total = chunk["total"]
        if chunk.get("route") is not None:
            route = chunk["route"]
        if chunk.get("pivot_english") is not None:
            pivot_english = chunk["pivot_english"]
        if chunk.get("google_chars_used") is not None:
            google_chars_used = chunk["google_chars_used"]
        payload = json.dumps(
            {
                "translation": partial,
                "current": current,
                "total": total,
                "done": False,
            },
            ensure_ascii=False,
        )
        yield f"data: {payload}\n\n"

    final = json.dumps(
        {
            "translation": partial,
            "current": current,
            "total": total,
            "route": route,
            "pivot_english": pivot_english,
            "google_chars_used": google_chars_used,
            "extracted_text": text,
            "extraction_method": extracted.method,
            "filename": extracted.filename,
            "source": source,
            **storage,
            "done": True,
        },
        ensure_ascii=False,
    )
    yield f"data: {final}\n\n"


@app.post("/api/extract")
async def extract_file(
    file: UploadFile = File(...),
    src_lang: str = Form("eng_Latn"),
    source: str = Form("upload"),
):
    filename = file.filename or "upload"
    if not supported_filename(filename):
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Upload .txt, .pdf, .docx, or an image.",
        )

    content = await file.read()
    upload_source = "camera" if source == "camera" else "upload"

    try:
        extracted = extract_text(content, filename, src_lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read file: {exc}",
        ) from exc

    stored = upload_bytes(
        content,
        filename,
        content_type=file.content_type,
        source=upload_source,
    )

    return {
        "text": extracted.text,
        "method": extracted.method,
        "filename": extracted.filename,
        "source": upload_source,
        "language_check": language_check_payload(extracted.text, src_lang),
        **_storage_payload(stored),
    }


@app.post("/api/translate/file")
async def translate_file(
    file: UploadFile = File(...),
    src_lang: str = Form("eng_Latn"),
    tgt_lang: str = Form("pai_Latn"),
    source: str = Form("upload"),
):
    if not engine.ready:
        detail = engine.error or "Model is still loading. Please try again shortly."
        raise HTTPException(status_code=503, detail=detail)

    filename = file.filename or "upload"
    if not supported_filename(filename):
        raise HTTPException(
            status_code=400,
            detail="Unsupported file type. Upload .txt, .pdf, .docx, or an image.",
        )

    content = await file.read()
    upload_source = "camera" if source == "camera" else "upload"
    stored = upload_bytes(
        content,
        filename,
        content_type=file.content_type,
        source=upload_source,
    )

    try:
        extracted = extract_text(content, filename, src_lang)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Could not read file: {exc}",
        ) from exc

    text = extracted.text

    def event_stream():
        try:
            yield from _file_translation_stream(
                text,
                extracted,
                src_lang,
                tgt_lang,
                stored,
                upload_source,
            )
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
    app.mount("/", SpaStaticFiles(directory=STATIC_DIR, html=True), name="static")
