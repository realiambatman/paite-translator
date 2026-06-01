import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extractFile,
  fetchStatus,
  FILE_ACCEPT,
  type LangCode,
  type Language,
  type LanguageCheck,
  type ModelStatus,
  translateTextStream,
} from "./services/api";
import {
  analyzeInput,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_TOKENS,
} from "./utils/textLimits";
import { saveTranslationLog } from "./services/translationLog";
import { fetchGoogleQuota, incrementGoogleQuota } from "./services/googleQuota";
import { FALLBACK_LANGUAGES } from "./languages";
import { LanguageSelect } from "./components/LanguageSelect";
import { CameraCapture } from "./components/CameraCapture";
import { ImageCropModal } from "./components/ImageCropModal";
import { UploadFileModal } from "./components/UploadFileModal";
import { isImageFile, isSupportedUploadFile } from "./utils/cropImage";

const HF_LANGS = new Set<LangCode>(["eng_Latn", "pai_Latn"]);

const EXAMPLES: { text: string; src: LangCode; tgt: LangCode }[] = [
  {
    text: "Hello, how are you today?",
    src: "eng_Latn",
    tgt: "pai_Latn",
  },
  {
    text: "नमस्ते, आप कैसे हैं?",
    src: "hin_Deva",
    tgt: "pai_Latn",
  },
  {
    text: "Chibai, i dam em?",
    src: "lus_Latn",
    tgt: "pai_Latn",
  },
];

function needsGoogleRoute(src: LangCode, tgt: LangCode): boolean {
  if (src === tgt) return false;
  return !(HF_LANGS.has(src) && HF_LANGS.has(tgt));
}

function langLabel(languages: Language[], code: LangCode) {
  return languages.find((lang) => lang.code === code)?.label ?? code;
}

export default function App() {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [inputText, setInputText] = useState("");
  const [outputText, setOutputText] = useState("");
  const [srcLang, setSrcLang] = useState<LangCode>("eng_Latn");
  const [tgtLang, setTgtLang] = useState<LangCode>("pai_Latn");
  const [isTranslating, setIsTranslating] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [fileStatus, setFileStatus] = useState<string | null>(null);
  const [languageWarning, setLanguageWarning] = useState<LanguageCheck | null>(
    null,
  );
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [cropSource, setCropSource] = useState<"upload" | "camera">("upload");
  const [lastExtractMeta, setLastExtractMeta] = useState<{
    storageUrl?: string;
    source?: string;
    filename?: string;
  } | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [firestoreCharsUsed, setFirestoreCharsUsed] = useState<number | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const languages = status?.languages ?? FALLBACK_LANGUAGES;
  const maxTokens = status?.limits?.max_tokens ?? DEFAULT_MAX_TOKENS;
  const maxChars = status?.limits?.max_chars ?? DEFAULT_MAX_CHARS;
  const googleDailyLimit = status?.google_quota?.daily_char_limit ?? null;
  const googleCharsUsed = Math.max(
    firestoreCharsUsed ?? 0,
    status?.google_quota?.daily_chars_used ?? 0,
  );
  const googleQuotaExceeded =
    googleDailyLimit != null && googleCharsUsed >= googleDailyLimit;
  const googleConfigured = status?.google_translate_configured ?? false;
  const googleEnabled = googleConfigured && !googleQuotaExceeded;
  const googleRequired = needsGoogleRoute(srcLang, tgtLang);

  const availableLanguages = useMemo(
    () =>
      googleQuotaExceeded
        ? languages.filter((lang) => lang.provider === "hf")
        : languages,
    [languages, googleQuotaExceeded],
  );

  const visibleExamples = useMemo(
    () =>
      googleQuotaExceeded
        ? EXAMPLES.filter((ex) => !needsGoogleRoute(ex.src, ex.tgt))
        : EXAMPLES,
    [googleQuotaExceeded],
  );

  const inputAnalysis = useMemo(
    () => analyzeInput(inputText, maxTokens, maxChars),
    [inputText, maxTokens, maxChars],
  );

  const refreshQuota = useCallback(async () => {
    const stored = await fetchGoogleQuota();
    if (stored) setFirestoreCharsUsed(stored.chars_used);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchStatus();
      setStatus(next);
      if (next.error) setError(next.error);
    } catch {
      setStatus(null);
    }
    await refreshQuota();
  }, [refreshQuota]);

  useEffect(() => {
    if (!googleQuotaExceeded) return;
    if (!HF_LANGS.has(srcLang)) setSrcLang("eng_Latn");
    if (!HF_LANGS.has(tgtLang)) setTgtLang("pai_Latn");
  }, [googleQuotaExceeded, srcLang, tgtLang]);

  useEffect(() => {
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 5000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    const wakeServer = () => {
      if (document.visibilityState === "visible") {
        void refreshStatus();
      }
    };
    document.addEventListener("visibilitychange", wakeServer);
    return () => document.removeEventListener("visibilitychange", wakeServer);
  }, [refreshStatus]);

  useEffect(() => {
    if (isTranslating && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputText, isTranslating]);

  const runTranslation = async (text: string, src: LangCode, tgt: LangCode) => {
    if (!text.trim() || !analyzeInput(text, maxTokens).valid) return;
    if (needsGoogleRoute(src, tgt) && !googleEnabled) {
      setError(
        googleQuotaExceeded
          ? "Limit reached. English ↔ Paite still works until midnight UTC."
          : googleConfigured
            ? "Translate is unavailable for this language pair right now."
            : "This language pair needs G Translate. Add G_TRANSLATE_API_KEY on the server.",
      );
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsTranslating(true);
    setError(null);
    setOutputText("");

    try {
      const result = await translateTextStream(
        text,
        src,
        tgt,
        ({ translation }) => setOutputText(translation),
        controller.signal,
      );
      if (result.translation) {
        void (async () => {
          if (result.googleCharsUsed && result.googleCharsUsed > 0) {
            await incrementGoogleQuota(result.googleCharsUsed);
            await refreshQuota();
          }
          await saveTranslationLog({
            srcLang: src,
            tgtLang: tgt,
            srcText: text,
            tgtText: result.translation,
            route: result.route,
            pivotEnglish: result.pivotEnglish,
            storageUrl: lastExtractMeta?.storageUrl,
            source: lastExtractMeta?.source,
            filename: lastExtractMeta?.filename,
          });
        })();
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Translation failed.");
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsTranslating(false);
    }
  };

  const handleTranslate = () => runTranslation(inputText, srcLang, tgtLang);

  const handleSwap = () => {
    setSrcLang(tgtLang);
    setTgtLang(srcLang);
    setInputText(outputText);
    setOutputText(inputText);
  };

  const handleExample = (example: (typeof EXAMPLES)[number]) => {
    setInputText(example.text);
    setSrcLang(example.src);
    setTgtLang(example.tgt);
    runTranslation(example.text, example.src, example.tgt);
  };

  const extractFileContent = async (
    file: File,
    source: "upload" | "camera" = "upload",
  ) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsExtracting(true);
    setError(null);
    setLanguageWarning(null);
    setLastExtractMeta(null);
    setInputText("");
    setOutputText("");
    setFileStatus(
      source === "camera"
        ? "Reading camera capture…"
        : `Reading ${file.name}…`,
    );

    try {
      const extracted = await extractFile(file, srcLang, source, controller.signal);
      setInputText(extracted.text);
      setLastExtractMeta({
        storageUrl: extracted.storage_url,
        source: extracted.source,
        filename: extracted.filename,
      });

      const methodLabel =
        source === "camera"
          ? "camera capture"
          : extracted.method === "ocr"
            ? "scanned image"
            : extracted.method === "pdf_ocr"
              ? "scanned PDF"
              : extracted.method === "pdf_mixed"
                ? "PDF with OCR"
                : extracted.method === "docx"
                  ? "document"
                  : "file";
      const storedLabel = extracted.storage_url ? " · saved to storage" : "";
      setFileStatus(
        `Text extracted from ${extracted.filename} (${methodLabel})${storedLabel}. Edit if needed, then click Translate.`,
      );

      if (
        extracted.language_check &&
        !extracted.language_check.matches_source
      ) {
        setLanguageWarning(extracted.language_check);
      }

      if (!extracted.text.trim()) {
        setError("No readable text found in this file.");
      } else if (!analyzeInput(extracted.text, maxTokens).valid) {
        setError("Extracted text is too long — delete some before translating.");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Could not read file.");
      setFileStatus(null);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsExtracting(false);
    }
  };

  const handleIncomingFile = (
    file: File,
    source: "upload" | "camera" = "upload",
  ) => {
    if (isImageFile(file)) {
      setCropSource(source);
      setCropFile(file);
      return;
    }
    void extractFileContent(file, source);
  };
  const handleIncomingFileRef = useRef(handleIncomingFile);
  handleIncomingFileRef.current = handleIncomingFile;

  const handleUploadFile = (file: File) => {
    handleIncomingFile(file, "upload");
  };

  const handleCameraCapture = (file: File) => {
    handleIncomingFile(file, "camera");
  };

  const handleCropConfirm = (file: File) => {
    void extractFileContent(file, cropSource);
  };

  const handleUseSuggestedLanguage = (code: LangCode) => {
    setSrcLang(code);
    setLanguageWarning(null);
  };

  const handleDismissLanguageWarning = () => {
    setLanguageWarning(null);
  };

  const modelReady = status?.ready ?? false;
  const canTranslate =
    inputAnalysis.valid &&
    !isTranslating &&
    !isExtracting &&
    modelReady &&
    (!googleRequired || googleEnabled);
  const canUploadFile =
    !isTranslating && !isExtracting && modelReady;

  useEffect(() => {
    const hasFiles = (transfer: DataTransfer) =>
      [...transfer.types].includes("Files");

    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      if (!hasFiles(event.dataTransfer!)) return;
      dragDepthRef.current += 1;
      setIsDragging(true);
    };

    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragging(false);
      }
    };

    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
    };

    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragDepthRef.current = 0;
      setIsDragging(false);

      if (!canUploadFile) return;

      const file = event.dataTransfer?.files?.[0];
      if (!file) return;

      if (!isSupportedUploadFile(file)) {
        setError("Unsupported file. Use .txt, .pdf, .docx, or an image.");
        return;
      }

      handleIncomingFileRef.current(file, "upload");
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [canUploadFile]);

  const barColor = inputAnalysis.overLimit
    ? "bg-zomi-red"
    : inputAnalysis.charRatio >= 0.85
      ? "bg-zomi-gold"
      : "bg-zomi-red/70";

  return (
    <div className="relative min-h-screen overflow-hidden bg-zomi-cream text-zomi-ink">
      <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full bg-zomi-gold/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -left-32 h-96 w-96 rounded-full bg-zomi-red/10 blur-3xl" />
      <div className="zomi-pattern pointer-events-none absolute inset-0 opacity-60" />
      <div className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 select-none font-serif text-[clamp(6rem,18vw,14rem)] font-bold leading-none tracking-tighter text-zomi-ink/[0.03]">
        ZOMI
      </div>

      <div className="relative mx-auto max-w-7xl px-4 py-5 md:px-8 md:py-8">
        <header className="mb-5 border-b border-stone-300/40 pb-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zomi-gold">
              Zomi Language · Paite
            </p>
            <h1 className="font-serif text-2xl font-bold tracking-tight text-zomi-ink md:text-3xl">
              Zomi Translator
            </h1>
            <p className="mt-1 max-w-lg text-sm text-zomi-muted">
              Free Zomi translator for Paite — English ↔ Paite plus Mizo,
              Meitei, Burmese, Hindi, and more regional and world languages.
            </p>
          </div>
        </header>

        <div className="overflow-hidden rounded-2xl border border-stone-300/50 bg-zomi-paper/80 shadow-[0_8px_30px_rgb(28_25_23/0.06)] backdrop-blur-sm">
          <div className="zomi-stripe h-1" />

          <div className="flex flex-wrap items-center gap-2 border-b border-stone-300/40 px-4 py-3">
            <LanguageSelect
              value={srcLang}
              onChange={setSrcLang}
              languages={availableLanguages}
              disabled={isTranslating || isExtracting}
            />

            <button
              type="button"
              onClick={handleSwap}
              disabled={isTranslating || isExtracting}
              className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm text-zomi-red transition hover:border-zomi-red/30 hover:bg-white disabled:opacity-60"
              aria-label="Swap languages"
            >
              ⇄
            </button>

            <LanguageSelect
              value={tgtLang}
              onChange={setTgtLang}
              languages={availableLanguages}
              disabled={isTranslating || isExtracting}
            />

            <button
              type="button"
              onClick={() => setUploadOpen(true)}
              disabled={!canUploadFile}
              className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm text-zomi-ink transition hover:border-zomi-red/30 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Upload file
            </button>

            <button
              type="button"
              onClick={() => setCameraOpen(true)}
              disabled={!canUploadFile}
              className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm text-zomi-ink transition hover:border-zomi-red/30 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Camera
            </button>

            <button
              type="button"
              onClick={handleTranslate}
              disabled={!canTranslate}
              className="ml-auto inline-flex items-center gap-2 rounded-full bg-zomi-red px-5 py-1.5 text-sm font-semibold text-white transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {isTranslating && (
                <span
                  className="stream-spinner inline-block h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white"
                  aria-hidden
                />
              )}
              {isTranslating ? "Translating…" : isExtracting ? "Reading…" : "Translate"}
            </button>
          </div>

          <p className="border-b border-stone-300/30 px-4 py-1.5 text-[10px] text-zomi-muted/80">
            Upload or camera extracts text only — edit, then click Translate.
            PDFs: delete unwanted parts in the box first.
          </p>

          {fileStatus && (
            <p className="border-b border-stone-300/40 bg-zomi-paper/60 px-4 py-2 text-xs text-zomi-muted">
              {fileStatus}
            </p>
          )}

          {languageWarning && (
            <div className="border-b border-amber-200/60 bg-amber-50/80 px-4 py-3 text-xs text-amber-900">
              <p className="font-medium">{languageWarning.message}</p>
              <p className="mt-1">
                Switch source language or edit the text, then click Translate.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {languageWarning.suggested_languages.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => handleUseSuggestedLanguage(lang.code)}
                    className="rounded-full bg-zomi-red px-3 py-1 text-xs font-semibold text-white transition hover:bg-zomi-red-dark"
                  >
                    Use {lang.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={handleDismissLanguageWarning}
                  className="rounded-full border border-amber-300/80 bg-white px-3 py-1 text-xs text-amber-950 transition hover:bg-amber-50"
                >
                  Got it
                </button>
              </div>
            </div>
          )}

          {googleQuotaExceeded && (
            <p className="border-b border-amber-200/60 bg-amber-50/80 px-4 py-2 text-xs text-amber-900">
              Google Translate daily limit reached (
              {googleCharsUsed.toLocaleString()} /{" "}
              {googleDailyLimit?.toLocaleString()} characters). Only English ↔
              Paite until midnight UTC.
            </p>
          )}

          {googleRequired && !googleEnabled && !googleQuotaExceeded && (
            <p className="border-b border-amber-200/60 bg-amber-50/80 px-4 py-2 text-xs text-amber-900">
              This pair uses Google Translate through English. Set{" "}
              <code className="rounded bg-white/80 px-1">
                GOOGLE_TRANSLATE_API_KEY
              </code>{" "}
              on the server.
            </p>
          )}

          <div className="grid md:grid-cols-2 md:divide-x md:divide-stone-300/40">
            <section className="flex min-h-[340px] flex-col md:min-h-[420px]">
              <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zomi-muted">
                {langLabel(languages, srcLang)}
              </div>
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="Enter text to translate…"
                disabled={isTranslating || isExtracting}
                className="min-h-[280px] flex-1 resize-none border-0 bg-transparent px-4 pb-2 text-base leading-relaxed text-zomi-ink outline-none placeholder:text-stone-400 disabled:opacity-70 md:min-h-[360px]"
              />
              <div className="border-t border-stone-300/30 px-4 py-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span
                    className={
                      inputAnalysis.overLimit
                        ? "font-medium text-zomi-red-dark"
                        : "text-zomi-muted"
                    }
                  >
                    {inputAnalysis.message}
                  </span>
                  <span className="tabular-nums text-zomi-muted">
                    {inputAnalysis.chars.toLocaleString()}/
                    {maxChars.toLocaleString()} characters
                  </span>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-stone-200/80"
                  role="progressbar"
                  aria-valuenow={Math.round(inputAnalysis.charRatio * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Character usage"
                >
                  <div
                    className={`h-full rounded-full transition-all duration-200 ${barColor}`}
                    style={{
                      width: `${Math.min(inputAnalysis.charRatio * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>
            </section>

            <section className="flex min-h-[340px] flex-col border-t border-stone-300/40 md:min-h-[420px] md:border-t-0">
              <div className="px-4 py-2 text-xs font-semibold uppercase tracking-wider text-zomi-red-dark">
                {langLabel(languages, tgtLang)}
              </div>
              <div
                ref={outputRef}
                className="min-h-[280px] flex-1 overflow-y-auto px-4 pb-4 md:min-h-[360px]"
              >
                {outputText ? (
                  <p className="whitespace-pre-wrap font-serif text-base leading-relaxed text-zomi-ink">
                    {outputText}
                    {isTranslating && (
                      <span
                        className="stream-cursor ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-px bg-zomi-red align-middle"
                        aria-hidden
                      />
                    )}
                  </p>
                ) : isTranslating ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-zomi-muted">
                      <span
                        className="stream-spinner inline-block h-4 w-4 rounded-full border-2 border-stone-300 border-t-zomi-red"
                        aria-hidden
                      />
                      Translating…
                    </div>
                    <div className="space-y-2 animate-pulse">
                      <div className="h-3 w-full rounded bg-stone-300/40" />
                      <div className="h-3 w-11/12 rounded bg-stone-300/40" />
                      <div className="h-3 w-4/5 rounded bg-stone-300/40" />
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-stone-400">
                    Translation appears here
                  </p>
                )}
              </div>
            </section>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-xl border border-zomi-red/20 bg-zomi-red/5 px-4 py-3 text-sm text-zomi-red-dark">
            {error}
          </p>
        )}

        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zomi-muted">
            Try an example
          </h2>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {visibleExamples.map((example, index) => (
              <button
                key={index}
                type="button"
                onClick={() => handleExample(example)}
                disabled={isTranslating || isExtracting || !modelReady}
                className="min-w-[220px] max-w-xs shrink-0 rounded-xl border border-stone-300/50 bg-zomi-paper/60 p-3 text-left text-sm text-zomi-ink transition hover:border-zomi-red/30 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="line-clamp-3">{example.text}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="mt-8 rounded-xl border border-stone-300/40 bg-zomi-paper/40 px-4 py-4 text-sm text-zomi-muted">
          <h2 className="mb-2 font-serif text-base font-semibold text-zomi-ink">
            About this Zomi translator
          </h2>
          <p>
            This free Zomi translator helps you translate between English and
            Paite, the most widely used Zomi language. Paite is spoken across
            Manipur, Mizoram, Assam, and the Zomi diaspora worldwide. Use this
            Zomi language translator and Paite translator for everyday phrases,
            learning, and connecting with Zomi-speaking communities.
          </p>
        </section>

        <footer className="mt-8 border-t border-stone-300/40 pt-4 text-center text-xs text-zomi-muted">
          <p>
            Up to {maxChars.toLocaleString()} characters per request — server
            hardware costs money, so longer text isn&apos;t supported yet.
          </p>
          <p className="mt-1">
            Paite is a Zomi language — built for speakers, learners, and
            diaspora communities.
          </p>
          <p className="mt-1">
            Built by{" "}
            <a
              href="https://huggingface.co/sensix-zo"
              target="_blank"
              rel="noreferrer"
              className="text-zomi-red hover:underline"
            >
              sensix-zo
            </a>{" "}
            on Hugging Face
          </p>
        </footer>
      </div>

      <UploadFileModal
        open={uploadOpen}
        accept={FILE_ACCEPT}
        onClose={() => setUploadOpen(false)}
        onFile={handleUploadFile}
      />

      <CameraCapture
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={handleCameraCapture}
      />

      <ImageCropModal
        open={cropFile != null}
        file={cropFile}
        onClose={() => setCropFile(null)}
        onConfirm={handleCropConfirm}
      />

      {isDragging && canUploadFile && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-zomi-red/10 backdrop-blur-[1px]">
          <div className="rounded-2xl border-2 border-dashed border-zomi-red bg-white/95 px-8 py-6 text-center shadow-lg">
            <p className="font-medium text-zomi-ink">Drop file to extract text</p>
            <p className="mt-1 text-xs text-zomi-muted">
              .txt, .pdf, .docx, or image
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
