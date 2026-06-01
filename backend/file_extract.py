"""Extract plain text from uploaded files (PDF, DOCX, images, plain text)."""

from __future__ import annotations

import io
import os
import re
from dataclasses import dataclass

import fitz
import pytesseract
from docx import Document
from PIL import Image

MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", str(10 * 1024 * 1024)))
MIN_PDF_TEXT_CHARS = int(os.environ.get("MIN_PDF_TEXT_CHARS", "32"))
PDF_OCR_DPI = int(os.environ.get("PDF_OCR_DPI", "200"))

SUPPORTED_EXTENSIONS = {
    ".txt",
    ".pdf",
    ".docx",
    ".jpg",
    ".jpeg",
    ".png",
    ".webp",
    ".gif",
    ".bmp",
}

TESSERACT_LANG: dict[str, str] = {
    "eng_Latn": "eng",
    "pai_Latn": "eng",
    "lus_Latn": "eng",
    "spa_Latn": "eng",
    "fra_Latn": "eng",
    "ind_Latn": "eng",
    "hin_Deva": "hin",
    "mni_Beng": "ben",
    "asm_Beng": "ben",
    "ben_Beng": "ben",
    "mya_Mymr": "mya",
    "brx_Deva": "hin",
    "kha_Latn": "eng",
    "trp_Latn": "eng",
    "rus_Cyrl": "rus",
    "zho_Hans": "chi_sim",
}


@dataclass(frozen=True)
class ExtractResult:
    text: str
    method: str
    filename: str


def supported_filename(filename: str) -> bool:
    ext = os.path.splitext(filename.lower())[1]
    return ext in SUPPORTED_EXTENSIONS


def _normalize_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _tesseract_lang(src_lang: str) -> str:
    return TESSERACT_LANG.get(src_lang, "eng")


def _ocr_image(image: Image.Image, src_lang: str) -> str:
    lang = _tesseract_lang(src_lang)
    try:
        return pytesseract.image_to_string(image, lang=lang)
    except pytesseract.TesseractError:
        if lang != "eng":
            return pytesseract.image_to_string(image, lang="eng")
        raise


def _extract_txt(content: bytes) -> str:
    for encoding in ("utf-8", "utf-16", "latin-1"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _extract_docx(content: bytes) -> str:
    document = Document(io.BytesIO(content))
    paragraphs = [paragraph.text.strip() for paragraph in document.paragraphs]
    return "\n\n".join(part for part in paragraphs if part)


def _extract_image(content: bytes, src_lang: str) -> str:
    image = Image.open(io.BytesIO(content))
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    return _ocr_image(image, src_lang)


def _extract_pdf(content: bytes, src_lang: str) -> tuple[str, str]:
    document = fitz.open(stream=content, filetype="pdf")
    page_texts: list[str] = []
    ocr_pages = 0

    for page in document:
        text = page.get_text().strip()
        if len(text) >= MIN_PDF_TEXT_CHARS:
            page_texts.append(text)
            continue

        pixmap = page.get_pixmap(dpi=PDF_OCR_DPI)
        image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
        page_texts.append(_ocr_image(image, src_lang))
        ocr_pages += 1

    document.close()
    combined = "\n\n".join(part for part in page_texts if part.strip())
    if not combined.strip():
        raise ValueError("No readable text found in this PDF.")

    method = "pdf_ocr" if ocr_pages == len(page_texts) else "pdf_text"
    if ocr_pages and ocr_pages < len(page_texts):
        method = "pdf_mixed"
    return combined, method


def extract_text(content: bytes, filename: str, src_lang: str) -> ExtractResult:
    if len(content) > MAX_FILE_BYTES:
        max_mb = MAX_FILE_BYTES / (1024 * 1024)
        raise ValueError(f"File is too large (maximum {max_mb:.0f} MB).")

    if not supported_filename(filename):
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise ValueError(f"Unsupported file type. Supported: {supported}")

    ext = os.path.splitext(filename.lower())[1]

    if ext == ".txt":
        text = _extract_txt(content)
        method = "plain_text"
    elif ext == ".docx":
        text = _extract_docx(content)
        method = "docx"
    elif ext == ".pdf":
        text, method = _extract_pdf(content, src_lang)
    else:
        text = _extract_image(content, src_lang)
        method = "ocr"

    normalized = _normalize_text(text)
    if not normalized:
        raise ValueError("No readable text found in this file.")

    return ExtractResult(text=normalized, method=method, filename=filename)
