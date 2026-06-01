"""Extract plain text from uploaded files (PDF, DOCX, images, plain text)."""

from __future__ import annotations

import io
import os
import re
import unicodedata
from dataclasses import dataclass

import fitz
import pytesseract
from docx import Document
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", str(10 * 1024 * 1024)))
MIN_PDF_TEXT_CHARS = int(os.environ.get("MIN_PDF_TEXT_CHARS", "32"))
PDF_OCR_DPI = int(os.environ.get("PDF_OCR_DPI", "200"))
TESSERACT_PSM = os.environ.get("TESSERACT_PSM", "11")
OCR_MIN_LINE_QUALITY = float(os.environ.get("OCR_MIN_LINE_QUALITY", "0.45"))

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

GARBAGE_CHARS = "©®™°|`~^\\<>{}[]"


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


def _is_meaningful_char(char: str) -> bool:
    if char.isspace():
        return True
    category = unicodedata.category(char)
    if category.startswith(("L", "N")):
        return True
    return char in ".,!?;:'\"()-/"


def _line_quality(line: str) -> float:
    stripped = line.strip()
    if len(stripped) < 2:
        return 0.0
    meaningful = sum(1 for char in stripped if _is_meaningful_char(char))
    return meaningful / len(stripped)


def _clean_ocr_line(line: str) -> str:
    line = unicodedata.normalize("NFKC", line)
    for char in GARBAGE_CHARS:
        line = line.replace(char, "")
    line = re.sub(r"[—–\-]{2,}", " ", line)
    line = re.sub(r"\s*\.{3,}\s*", " ", line)
    line = re.sub(r"^\s*[\d\W_]{1,3}\s+(?=[A-Za-z])", "", line)
    line = re.sub(r"\s+", " ", line).strip(" .-|_")
    return line.strip()


def clean_ocr_text(text: str) -> str:
    lines: list[str] = []
    for raw_line in text.splitlines():
        cleaned = _clean_ocr_line(raw_line)
        if not cleaned:
            continue
        if _line_quality(cleaned) < OCR_MIN_LINE_QUALITY:
            continue
        if len(cleaned) == 1 and not cleaned.isalnum():
            continue
        lines.append(cleaned)
    return "\n".join(lines)


def _preprocess_for_ocr(image: Image.Image) -> Image.Image:
    gray = ImageOps.grayscale(image)
    gray = ImageOps.autocontrast(gray, cutoff=2)
    gray = ImageEnhance.Contrast(gray).enhance(1.4)
    gray = gray.filter(ImageFilter.SHARPEN)

    min_dim = min(gray.size)
    if min_dim < 1400:
        scale = 1400 / min_dim
        gray = gray.resize(
            (int(gray.width * scale), int(gray.height * scale)),
            Image.Resampling.LANCZOS,
        )

    return gray


def _tesseract_config(psm: str | None = None) -> str:
    mode = psm or TESSERACT_PSM
    return f"--oem 3 --psm {mode} -c preserve_interword_spaces=1"


def _ocr_image(image: Image.Image, src_lang: str) -> str:
    lang = _tesseract_lang(src_lang)
    prepared = _preprocess_for_ocr(image)
    configs = [_tesseract_config("11"), _tesseract_config("6")]

    best = ""
    best_score = 0.0
    for config in configs:
        try:
            raw = pytesseract.image_to_string(prepared, lang=lang, config=config)
        except pytesseract.TesseractError:
            if lang == "eng":
                raise
            raw = pytesseract.image_to_string(prepared, lang="eng", config=config)
        cleaned = clean_ocr_text(raw)
        score = sum(_line_quality(line) for line in cleaned.splitlines())
        if score > best_score:
            best_score = score
            best = cleaned

    return best


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
        raise ValueError(
            "No readable text found in this file. OCR works best on clear printed text."
        )

    return ExtractResult(text=normalized, method=method, filename=filename)
