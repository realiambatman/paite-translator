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
from lang_detect import (
    LANG_SCRIPTS,
    SCRIPT_LABELS,
    SCRIPT_TO_LANGS,
    check_ocr_latin_garbage,
)
from languages import language_label
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

MAX_FILE_BYTES = int(os.environ.get("MAX_FILE_BYTES", str(10 * 1024 * 1024)))
MIN_PDF_TEXT_CHARS = int(os.environ.get("MIN_PDF_TEXT_CHARS", "32"))
PDF_OCR_DPI = int(os.environ.get("PDF_OCR_DPI", "200"))
TESSERACT_PSM = os.environ.get("TESSERACT_PSM", "11")
OCR_MIN_LINE_QUALITY = float(os.environ.get("OCR_MIN_LINE_QUALITY", "0.45"))
MIN_EXTRACTED_CHARS = int(os.environ.get("MIN_EXTRACTED_CHARS", "4"))
MIN_EXTRACTED_WORDS = int(os.environ.get("MIN_EXTRACTED_WORDS", "1"))
MIN_MEANINGFUL_RATIO = float(os.environ.get("MIN_MEANINGFUL_RATIO", "0.5"))
MIN_AVG_LINE_QUALITY = float(os.environ.get("MIN_AVG_LINE_QUALITY", "0.52"))
OCR_PROBE_MAX_DIM = int(os.environ.get("OCR_PROBE_MAX_DIM", "900"))
OCR_PROBE_MIN_CONF = int(os.environ.get("OCR_PROBE_MIN_CONF", "45"))
OCR_PROBE_MIN_WORDS = int(os.environ.get("OCR_PROBE_MIN_WORDS", "2"))
OCR_PROBE_MIN_WORD_LEN = int(os.environ.get("OCR_PROBE_MIN_WORD_LEN", "2"))
OCR_PROBE_MIN_LONG_WORDS = int(os.environ.get("OCR_PROBE_MIN_LONG_WORDS", "1"))
OCR_PROBE_MIN_TOTAL_CONF = int(os.environ.get("OCR_PROBE_MIN_TOTAL_CONF", "100"))
OCR_NOISE_SHORT_WORD_RATIO = float(os.environ.get("OCR_NOISE_SHORT_WORD_RATIO", "0.65"))
OCR_NOISE_MIN_REAL_WORDS = int(os.environ.get("OCR_NOISE_MIN_REAL_WORDS", "2"))
OCR_PROBE_MIN_MATCH_SCORE = float(os.environ.get("OCR_PROBE_MIN_MATCH_SCORE", "80"))
OCR_PROBE_LANG_MARGIN = float(os.environ.get("OCR_PROBE_LANG_MARGIN", "1.4"))
PROBE_TESSERACT_LANGS = ("eng", "hin", "ben", "mya")

TESSERACT_PRIMARY_SCRIPT = {
    "eng": "latin",
    "hin": "devanagari",
    "ben": "bengali",
    "mya": "myanmar",
    "rus": "cyrillic",
    "chi_sim": "han",
}

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


def _word_has_letters(word: str) -> bool:
    return any(unicodedata.category(char).startswith("L") for char in word)


def _word_has_vowel(word: str) -> bool:
    return bool(re.search(r"[aeiouAEIOU]", word))


def _real_word_count(text: str) -> int:
    return sum(
        1
        for word in re.findall(r"\b[^\W_]+\b", text, flags=re.UNICODE)
        if len(word) >= 4 and _word_has_letters(word) and _word_has_vowel(word)
    )


def _looks_like_ocr_noise(text: str) -> bool:
    words = re.findall(r"\b[^\W_]+\b", text, flags=re.UNICODE)
    if len(words) < 2:
        return True

    short_words = sum(1 for word in words if len(word) <= 3)
    if short_words / len(words) >= OCR_NOISE_SHORT_WORD_RATIO:
        return True

    if _real_word_count(text) < OCR_NOISE_MIN_REAL_WORDS:
        return True

    avg_len = sum(len(word) for word in words) / len(words)
    if avg_len < 3.8 and _real_word_count(text) < 3:
        return True

    return False


def _no_text_in_image_error() -> ValueError:
    return ValueError(
        "This image does not appear to contain readable text. "
        "Use a clear photo of printed text, or crop tightly around the words."
    )


def _count_words(text: str) -> int:
    return len(
        [
            word
            for word in re.findall(r"\b[^\W_]+\b", text, flags=re.UNICODE)
            if len(word) >= 2
        ]
    )


def _meaningful_ratio(text: str) -> float:
    if not text:
        return 0.0
    meaningful = sum(1 for char in text if _is_meaningful_char(char))
    return meaningful / len(text)


def _validate_extracted_text(text: str, *, from_ocr: bool) -> str:
    normalized = _normalize_text(text)
    if len(normalized) < MIN_EXTRACTED_CHARS:
        raise ValueError(
            "No readable text found in this file. "
            "Try a document with text or a clear photo of printed words."
        )

    if _count_words(normalized) < MIN_EXTRACTED_WORDS:
        raise ValueError(
            "No readable text found in this file. "
            "Try a document with text or a clear photo of printed words."
        )

    if _meaningful_ratio(normalized) < MIN_MEANINGFUL_RATIO:
        raise ValueError(
            "No readable text found in this file. "
            "Try a document with text or a clear photo of printed words."
        )

    if from_ocr:
        if _looks_like_ocr_noise(normalized):
            raise _no_text_in_image_error()

        lines = [line for line in normalized.splitlines() if line.strip()]
        if not lines:
            raise ValueError(
                "No readable text found in this file. "
                "OCR works best on clear printed text."
            )
        avg_quality = sum(_line_quality(line) for line in lines) / len(lines)
        if avg_quality < MIN_AVG_LINE_QUALITY:
            raise ValueError(
                "No readable text found in this file. "
                "OCR works best on clear printed text."
            )
        letter_words = sum(
            1
            for word in re.findall(r"\b[^\W_]+\b", normalized, flags=re.UNICODE)
            if _word_has_letters(word)
        )
        if letter_words < MIN_EXTRACTED_WORDS:
            raise ValueError(
                "No readable text found in this file. "
                "OCR works best on clear printed text."
            )

    return normalized


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


def _downscale_for_probe(image: Image.Image, max_dim: int = OCR_PROBE_MAX_DIM) -> Image.Image:
    width, height = image.size
    longest = max(width, height)
    if longest <= max_dim:
        return image
    scale = max_dim / longest
    return image.resize(
        (int(width * scale), int(height * scale)),
        Image.Resampling.LANCZOS,
    )


def _preprocess_for_probe(image: Image.Image) -> Image.Image:
    gray = ImageOps.grayscale(image)
    return ImageOps.autocontrast(gray, cutoff=2)


def _word_script_weight(word: str, tess_lang: str) -> float:
    latin = len(re.findall(r"[A-Za-z]", word))
    deva = len(re.findall(r"[\u0900-\u097F]", word))
    beng = len(re.findall(r"[\u0980-\u09FF]", word))
    myan = len(re.findall(r"[\u1000-\u109F]", word))

    if tess_lang == "eng":
        if deva or beng or myan:
            return 0.05
        return 1.0 if latin else 0.0
    if tess_lang == "hin":
        return 2.5 if deva else (0.15 if latin else 0.0)
    if tess_lang == "ben":
        return 2.5 if beng else (0.15 if latin else 0.0)
    if tess_lang == "mya":
        return 2.5 if myan else 0.1
    return 1.0 if latin else 0.0


def _probe_ocr_lang_score(prepared: Image.Image, tess_lang: str) -> float:
    config = _tesseract_config("11")
    try:
        data = pytesseract.image_to_data(
            prepared,
            lang=tess_lang,
            config=config,
            output_type=pytesseract.Output.DICT,
        )
    except pytesseract.TesseractError:
        return 0.0

    score = 0.0
    for index, word in enumerate(data["text"]):
        cleaned = word.strip()
        if len(cleaned) < OCR_PROBE_MIN_WORD_LEN:
            continue
        try:
            confidence = int(float(data["conf"][index]))
        except (TypeError, ValueError):
            continue
        if confidence < OCR_PROBE_MIN_CONF:
            continue

        script_weight = _word_script_weight(cleaned, tess_lang)
        if script_weight <= 0:
            continue
        score += confidence * script_weight

    return score


def _check_image_language_for_ocr(image: Image.Image, src_lang: str) -> None:
    expected_scripts = LANG_SCRIPTS.get(src_lang, {"latin"})
    expected_tess = _tesseract_lang(src_lang)
    prepared = _preprocess_for_probe(_downscale_for_probe(image))

    scores = {
        lang: _probe_ocr_lang_score(prepared, lang) for lang in PROBE_TESSERACT_LANGS
    }
    ranked = sorted(
        ((lang, score) for lang, score in scores.items() if score > 0),
        key=lambda item: item[1],
        reverse=True,
    )
    if not ranked:
        return

    best_lang, best_score = ranked[0]
    expected_score = scores.get(expected_tess, 0.0)
    best_script = TESSERACT_PRIMARY_SCRIPT.get(best_lang, "latin")

    if best_script in expected_scripts:
        return

    if best_score < OCR_PROBE_MIN_MATCH_SCORE:
        return

    margin = best_score / max(expected_score, 1.0)
    if margin < OCR_PROBE_LANG_MARGIN:
        return

    src_label = language_label(src_lang)
    script_label = SCRIPT_LABELS.get(best_script, best_script)
    suggestion_codes = [
        code for code in SCRIPT_TO_LANGS.get(best_script, []) if code != src_lang
    ]
    if suggestion_codes:
        names = ", ".join(language_label(code) for code in suggestion_codes[:3])
        message = (
            f"This image looks like {script_label} text ({names}), "
            f"not {src_label}. Select the matching source language and try again."
        )
    else:
        message = (
            f"This image looks like {script_label} text, "
            f"not {src_label}. Select the matching source language and try again."
        )
    raise ValueError(message)


def _image_likely_has_text(image: Image.Image, src_lang: str) -> bool:
    preview = _preprocess_for_probe(_downscale_for_probe(image))
    lang = _tesseract_lang(src_lang)
    config = _tesseract_config("11")

    try:
        data = pytesseract.image_to_data(
            preview,
            lang=lang,
            config=config,
            output_type=pytesseract.Output.DICT,
        )
    except pytesseract.TesseractError:
        if lang == "eng":
            return False
        try:
            data = pytesseract.image_to_data(
                preview,
                lang="eng",
                config=config,
                output_type=pytesseract.Output.DICT,
            )
        except pytesseract.TesseractError:
            return False

    confident_words = 0
    long_words = 0
    total_conf = 0
    for index, word in enumerate(data["text"]):
        cleaned = word.strip()
        if len(cleaned) < OCR_PROBE_MIN_WORD_LEN:
            continue
        if not _word_has_letters(cleaned):
            continue
        try:
            confidence = int(float(data["conf"][index]))
        except (TypeError, ValueError):
            continue
        if confidence < OCR_PROBE_MIN_CONF:
            continue
        confident_words += 1
        total_conf += confidence
        if len(cleaned) >= 4:
            long_words += 1

    return (
        confident_words >= OCR_PROBE_MIN_WORDS
        and long_words >= OCR_PROBE_MIN_LONG_WORDS
        and total_conf >= OCR_PROBE_MIN_TOTAL_CONF
    )


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


def _run_ocr_on_image(image: Image.Image, src_lang: str) -> str:
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


def _ocr_image(image: Image.Image, src_lang: str) -> str:
    if not _image_likely_has_text(image, src_lang):
        raise _no_text_in_image_error()
    _check_image_language_for_ocr(image, src_lang)
    result = _run_ocr_on_image(image, src_lang)
    if not result.strip() or _looks_like_ocr_noise(result):
        raise _no_text_in_image_error()
    return result


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
        if not _image_likely_has_text(image, src_lang):
            continue
        try:
            _check_image_language_for_ocr(image, src_lang)
        except ValueError:
            continue
        page_text = _run_ocr_on_image(image, src_lang)
        if not page_text.strip():
            continue
        page_texts.append(page_text)
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

    from_ocr = method in ("ocr", "pdf_ocr")
    validated = _validate_extracted_text(text, from_ocr=from_ocr)

    if from_ocr:
        garbage = check_ocr_latin_garbage(validated, src_lang)
        if garbage and garbage.message:
            raise ValueError(garbage.message)

    return ExtractResult(text=validated, method=method, filename=filename)
