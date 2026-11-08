import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extractFile,
  fetchAlternatives,
  fetchStatus,
  FILE_ACCEPT,
  type LangCode,
  type Language,
  type LanguageCheck,
  type ModelStatus,
  simplifyEnglish,
  translateTextStream,
} from "./services/api";
import {
  analyzeInput,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_TOKENS,
} from "./utils/textLimits";
import { saveTranslationLog } from "./services/translationLog";
import { saveFeedback } from "./services/corrections";
import {
  clearHistory,
  loadHistory,
  pushHistory,
  type HistoryItem,
} from "./services/history";
import { FeedbackPanel, type LastResult } from "./components/FeedbackPanel";
import { PivotEditor } from "./components/PivotEditor";
import { RecentHistory } from "./components/RecentHistory";
import { fetchGoogleQuota, incrementGoogleQuota } from "./services/googleQuota";
import { FALLBACK_LANGUAGES } from "./languages";
import { LanguageSelect } from "./components/LanguageSelect";
import { CameraCapture } from "./components/CameraCapture";
import { ImageCropModal } from "./components/ImageCropModal";
import { UploadFileModal } from "./components/UploadFileModal";
import { isImageFile, isSupportedUploadFile } from "./utils/cropImage";

const HF_LANGS = new Set<LangCode>(["eng_Latn", "pai_Latn"]);
const ENGLISH: LangCode = "eng_Latn";
const PAITE: LangCode = "pai_Latn";
// Alternatives are only fetched for short single-sentence English<->Paite inputs.
const ALTERNATIVES_MAX_CHARS = 220;

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
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>(() => loadHistory());
  const [isSimplifying, setIsSimplifying] = useState(false);
  const [simplifyBackup, setSimplifyBackup] = useState<string | null>(null);
  const [firestoreCharsUsed, setFirestoreCharsUsed] = useState<number | null>(
    null,
  );
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

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
    if (!error) return;
    errorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [error]);

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
    setLastResult(null);
    setAlternatives([]);

    try {
      const result = await translateTextStream(
        text,
        src,
        tgt,
        ({ translation }) => setOutputText(translation),
        controller.signal,
      );
      if (result.translation) {
        const summary: LastResult = {
          srcText: text,
          srcLang: src,
          tgtLang: tgt,
          translation: result.translation,
          route: result.route ?? null,
          pivotEnglish: result.pivotEnglish ?? null,
          translationId: null,
        };
        setLastResult(summary);
        setHistory((prev) =>
          pushHistory(
            { srcLang: src, tgtLang: tgt, srcText: text, tgtText: result.translation },
            prev,
          ),
        );

        const wantsAlternatives =
          (status?.decoding?.alternatives ?? false) &&
          result.route === "hf" &&
          !text.includes("\n") &&
          text.trim().length <= ALTERNATIVES_MAX_CHARS;
        const alternativesPromise: Promise<string[]> = wantsAlternatives
          ? fetchAlternatives(text, src, tgt, controller.signal).catch(() => [])
          : Promise.resolve([]);
        void alternativesPromise.then((alts) => {
          if (!controller.signal.aborted) setAlternatives(alts);
        });

        void (async () => {
          if (result.googleCharsUsed && result.googleCharsUsed > 0) {
            await incrementGoogleQuota(result.googleCharsUsed);
            await refreshQuota();
          }
          // Give the beam alternatives a few seconds so they are logged too.
          const alts = await Promise.race([
            alternativesPromise,
            new Promise<string[]>((resolve) => window.setTimeout(() => resolve([]), 5000)),
          ]);
          const id = await saveTranslationLog({
            srcLang: src,
            tgtLang: tgt,
            srcText: text,
            tgtText: result.translation,
            route: result.route,
            pivotEnglish: result.pivotEnglish,
            storageUrl: lastExtractMeta?.storageUrl,
            source: lastExtractMeta?.source,
            filename: lastExtractMeta?.filename,
            alternatives: alts,
          });
          if (id) {
            setLastResult((prev) =>
              prev && prev.translation === result.translation
                ? { ...prev, translationId: id }
                : prev,
            );
          }
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

  const handlePivotRetranslate = (english: string) => {
    if (!lastResult || !english.trim()) return;
    const edited = english.trim() !== (lastResult.pivotEnglish ?? "").trim();
    if (edited && lastResult.route === "from_paite" && lastResult.srcLang === PAITE) {
      // The user fixed the model's Paite→English step: that is a correction
      // for the core model, worth keeping even though the final target differs.
      void saveFeedback({
        translationId: lastResult.translationId,
        srcLang: PAITE,
        tgtLang: ENGLISH,
        srcText: lastResult.srcText,
        modelText: lastResult.pivotEnglish ?? "",
        correctedText: english,
        comment: "Edited English pivot before re-translating",
        route: lastResult.route,
      });
    }
    void runTranslation(english, ENGLISH, lastResult.tgtLang);
  };

  const handlePickAlternative = (alt: string) => {
    setOutputText(alt);
  };

  const handleHistoryPick = (item: HistoryItem) => {
    setInputText(item.srcText);
    setSrcLang(item.srcLang);
    setTgtLang(item.tgtLang);
    setOutputText(item.tgtText);
    setLastResult(null);
    setAlternatives([]);
    setError(null);
  };

  const handleSimplify = async () => {
    if (!inputText.trim() || isSimplifying) return;
    setIsSimplifying(true);
    setError(null);
    try {
      const simplified = await simplifyEnglish(inputText);
      if (simplified.trim() && simplified.trim() !== inputText.trim()) {
        setSimplifyBackup(inputText);
        setInputText(simplified);
        setFileStatus("English simplified for the Paite model. Review it, then click Translate.");
      } else {
        setFileStatus("Text is already simple enough.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not simplify text.");
    } finally {
      setIsSimplifying(false);
    }
  };

  const handleUndoSimplify = () => {
    if (simplifyBackup == null) return;
    setInputText(simplifyBackup);
    setSimplifyBackup(null);
    setFileStatus(null);
  };

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
      source === "camera" ? "Reading camera capture…" : `Reading ${file.name}…`,
    );

    try {
      const extracted = await extractFile(
        file,
        srcLang,
        source,
        controller.signal,
      );
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
        setError(
          "Extracted text is too long — delete some before translating.",
        );
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
  const canUploadFile = !isTranslating && !isExtracting && modelReady;

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

  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (!outputText) return;
    try {
      await navigator.clipboard.writeText(outputText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked — nothing else to do.
    }
  };

  const handleClear = () => {
    abortRef.current?.abort();
    setInputText("");
    setOutputText("");
    setLastResult(null);
    setAlternatives([]);
    setError(null);
    setFileStatus(null);
    setLanguageWarning(null);
    setLastExtractMeta(null);
    setSimplifyBackup(null);
  };

  const busy = isTranslating || isExtracting;
  // Only speak up when something is wrong or not ready yet.
  const modelState: { label: string; tone: string } | null = status?.error
    ? { label: "The translation model failed to load. Try again in a minute.", tone: "text-zomi-red-dark" }
    : status && !modelReady
      ? { label: "Starting up the Paite model, this takes a moment after idle periods…", tone: "text-zomi-muted" }
      : null;

  const barColor = inputAnalysis.overLimit
    ? "bg-zomi-red"
    : inputAnalysis.charRatio >= 0.85
      ? "bg-zomi-gold"
      : "bg-zomi-red/70";

  return (
    <div className="min-h-screen bg-zomi-cream text-zomi-ink">
      <div className="mx-auto max-w-6xl px-4 pb-10 pt-4 md:px-8 md:pt-6">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2 pb-3">
          <div className="min-w-0">
            <h1 className="font-serif text-[1.9rem] font-bold leading-none tracking-tight text-zomi-ink md:text-[2.4rem]">
              Zomi Translator
            </h1>
            <p className="mt-1.5 max-w-xl text-sm leading-snug text-zomi-muted">
              English ↔ Paite, with Mizo, Meitei, Burmese, Hindi and more
              languages of the Northeast and beyond.
            </p>
          </div>
          {modelState && (
            <p role="status" aria-live="polite" className={`text-sm ${modelState.tone}`}>
              {modelState.label}
            </p>
          )}
        </header>

        <div className="zomi-puan h-[14px] rounded-sm" aria-hidden />

        <div className="mt-5 overflow-hidden rounded-2xl border border-stone-300/60 bg-zomi-paper shadow-[0_1px_0_rgb(28_25_23/0.04),0_12px_32px_-16px_rgb(28_25_23/0.18)]">
          <div className="flex flex-col gap-2 border-b border-stone-300/50 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3 sm:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <LanguageSelect
                value={srcLang}
                onChange={setSrcLang}
                languages={availableLanguages}
                disabled={busy}
              />
              <button
                type="button"
                onClick={handleSwap}
                disabled={busy}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-zomi-red transition hover:bg-white disabled:opacity-50"
                aria-label="Swap languages"
                title="Swap languages"
              >
                <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 7h12m0 0-3-3m3 3-3 3M17 13H5m0 0 3 3m-3-3 3-3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <LanguageSelect
                value={tgtLang}
                onChange={setTgtLang}
                languages={availableLanguages}
                disabled={busy}
              />
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <button
                type="button"
                onClick={() => setUploadOpen(true)}
                disabled={!canUploadFile}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-zomi-ink transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4 text-zomi-muted" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5M4 13v2a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Upload
              </button>
              <button
                type="button"
                onClick={() => setCameraOpen(true)}
                disabled={!canUploadFile}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-zomi-ink transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4 text-zomi-muted" fill="none" stroke="currentColor" strokeWidth="1.7">
                  <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h2l1-1.5h5l1 1.5h2A1.5 1.5 0 0 1 17 7.5v7A1.5 1.5 0 0 1 15.5 16h-11A1.5 1.5 0 0 1 3 14.5z" strokeLinejoin="round" />
                  <circle cx="10" cy="11" r="2.5" />
                </svg>
                Camera
              </button>
              {status?.simplify_available && srcLang === ENGLISH && (
                <button
                  type="button"
                  onClick={handleSimplify}
                  disabled={!inputText.trim() || isSimplifying || busy}
                  title="Rewrite long or idiomatic English into short plain sentences the Paite model handles better"
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-zomi-ink transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <svg viewBox="0 0 20 20" className="h-4 w-4 text-zomi-gold" fill="none" stroke="currentColor" strokeWidth="1.7">
                    <path d="M10 3v3m0 8v3m7-7h-3M6 10H3m11.5-4.5-2 2m-5 5-2 2m9 0-2-2m-5-5-2-2" strokeLinecap="round" />
                  </svg>
                  {isSimplifying ? "Simplifying…" : "Simplify English"}
                </button>
              )}
            </div>
          </div>

          {error && (
            <div
              ref={errorRef}
              role="alert"
              className="border-b border-zomi-red/20 bg-zomi-red/5 px-4 py-3 text-sm text-zomi-red-dark"
            >
              {error}
            </div>
          )}

          {fileStatus && (
            <p className="border-b border-stone-300/50 bg-white/50 px-4 py-2 text-xs text-zomi-muted">
              {fileStatus}
              {simplifyBackup != null && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={handleUndoSimplify}
                    className="text-zomi-red hover:underline"
                  >
                    Undo
                  </button>
                </>
              )}
            </p>
          )}

          {languageWarning && (
            <div className="border-b border-amber-200/70 bg-amber-50/80 px-4 py-3 text-xs text-amber-900">
              <p className="font-medium">{languageWarning.message}</p>
              <p className="mt-1">
                Switch the source language or edit the text, then translate.
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
                  Keep {langLabel(languages, srcLang)}
                </button>
              </div>
            </div>
          )}

          {googleQuotaExceeded && (
            <p className="border-b border-amber-200/70 bg-amber-50/80 px-4 py-2 text-xs text-amber-900">
              Google Translate daily limit reached (
              {googleCharsUsed.toLocaleString()} /{" "}
              {googleDailyLimit?.toLocaleString()} characters). Only English ↔
              Paite until midnight UTC.
            </p>
          )}

          {googleRequired && !googleEnabled && !googleQuotaExceeded && (
            <p className="border-b border-amber-200/70 bg-amber-50/80 px-4 py-2 text-xs text-amber-900">
              This pair uses Google Translate through English. Set{" "}
              <code className="rounded bg-white/80 px-1">
                GOOGLE_TRANSLATE_API_KEY
              </code>{" "}
              on the server.
            </p>
          )}

          <div className="grid md:grid-cols-2">
            <section className="flex min-h-[320px] flex-col md:min-h-[440px] md:border-r md:border-stone-300/50">
              <div className="flex items-center justify-between gap-2 px-4 pt-3 text-xs text-zomi-muted">
                <span>{langLabel(languages, srcLang)}</span>
                {inputText && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className="rounded-full px-2 py-0.5 text-zomi-muted transition hover:bg-white hover:text-zomi-red"
                  >
                    Clear
                  </button>
                )}
              </div>
              <textarea
                value={inputText}
                onChange={(e) => {
                  setInputText(e.target.value);
                  if (simplifyBackup != null) setSimplifyBackup(null);
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    if (canTranslate) handleTranslate();
                  }
                }}
                placeholder="Type, paste, or upload a photo of text…"
                disabled={busy}
                aria-label={`Text in ${langLabel(languages, srcLang)}`}
                className="min-h-[220px] flex-1 resize-none border-0 bg-transparent px-4 py-2 text-[17px] leading-relaxed text-zomi-ink outline-none placeholder:text-stone-400 disabled:opacity-70 md:min-h-[320px]"
              />
              <div className="flex items-end justify-between gap-3 border-t border-stone-300/40 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 text-xs">
                    <span
                      className={
                        inputAnalysis.overLimit
                          ? "font-medium text-zomi-red-dark"
                          : "text-zomi-muted"
                      }
                    >
                      {inputAnalysis.chars === 0
                        ? "Ctrl+Enter to translate"
                        : inputAnalysis.overLimit
                          ? inputAnalysis.message
                          : null}
                    </span>
                    <span className="tabular-nums text-zomi-muted">
                      {inputAnalysis.chars.toLocaleString()} /{" "}
                      {maxChars.toLocaleString()}
                    </span>
                  </div>
                  <div
                    className="h-1 overflow-hidden rounded-full bg-stone-300/50"
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
                <button
                  type="button"
                  onClick={handleTranslate}
                  disabled={!canTranslate}
                  className="inline-flex shrink-0 items-center gap-2 rounded-full bg-zomi-red px-5 py-2.5 text-sm font-semibold text-white shadow-[0_6px_16px_-6px_rgb(190_0_0/0.6)] transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:bg-stone-300 disabled:shadow-none"
                >
                  {isTranslating && (
                    <span
                      className="stream-spinner inline-block h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white"
                      aria-hidden
                    />
                  )}
                  {isTranslating
                    ? "Translating…"
                    : isExtracting
                      ? "Reading…"
                      : "Translate"}
                </button>
              </div>
            </section>

            <section className="flex min-h-[320px] flex-col border-t border-stone-300/50 bg-white/40 md:min-h-[440px] md:border-t-0">
              <div className="flex items-center justify-between gap-2 px-4 pt-3 text-xs text-zomi-red-dark">
                <span>{langLabel(languages, tgtLang)}</span>
                {outputText && !isTranslating && (
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="rounded-full px-2 py-0.5 text-zomi-muted transition hover:bg-white hover:text-zomi-red"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                )}
              </div>
              <div
                ref={outputRef}
                className="min-h-[220px] flex-1 overflow-y-auto px-4 py-2 md:min-h-[320px]"
              >
                {outputText ? (
                  <p className="whitespace-pre-wrap font-serif text-[19px] leading-[1.7] text-zomi-ink">
                    {outputText}
                    {isTranslating && (
                      <span
                        className="stream-cursor ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-px bg-zomi-red align-middle"
                        aria-hidden
                      />
                    )}
                  </p>
                ) : isTranslating ? (
                  <div className="space-y-3 pt-1">
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
                  <p className="pt-1 font-serif text-lg italic text-stone-400">
                    {langLabel(languages, tgtLang)} appears here.
                  </p>
                )}
              </div>
              {lastResult && outputText && !isTranslating && (
                <FeedbackPanel
                  key={`${lastResult.srcText}::${lastResult.translation}`}
                  result={lastResult}
                  outputText={outputText}
                  alternatives={alternatives}
                  tgtLabel={langLabel(languages, lastResult.tgtLang)}
                  onPickAlternative={handlePickAlternative}
                />
              )}
            </section>
          </div>

          {lastResult?.pivotEnglish && !isTranslating && (
            <PivotEditor
              key={lastResult.pivotEnglish}
              pivot={lastResult.pivotEnglish}
              route={lastResult.route}
              tgtLabel={langLabel(languages, lastResult.tgtLang)}
              disabled={busy}
              onRetranslate={handlePivotRetranslate}
            />
          )}
        </div>

        <p className="mt-2 px-1 text-xs text-zomi-muted">
          Uploads and camera photos only extract the text. Edit it, then
          translate. Up to {maxChars.toLocaleString()} characters at a time.
        </p>

        <section className="mt-6 flex flex-wrap items-center gap-2">
          <span className="text-sm text-zomi-muted">Try:</span>
          {visibleExamples.map((example, index) => (
            <button
              key={index}
              type="button"
              onClick={() => handleExample(example)}
              disabled={busy || !modelReady}
              className="max-w-full truncate rounded-full border border-stone-300/60 bg-white/60 px-3.5 py-1.5 text-sm text-zomi-ink transition hover:border-zomi-red/40 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {example.text}
            </button>
          ))}
        </section>

        <RecentHistory
          items={history}
          langLabel={(code) => langLabel(languages, code)}
          disabled={busy}
          onPick={handleHistoryPick}
          onClear={() => setHistory(clearHistory())}
        />

        <section className="mt-10 grid gap-6 border-t border-stone-300/50 pt-6 md:grid-cols-[1fr_2fr]">
          <h2 className="font-serif text-xl font-semibold leading-tight text-zomi-ink">
            Built for Paite, the most widely spoken Zomi language.
          </h2>
          <div className="space-y-3 text-sm leading-relaxed text-zomi-muted">
            <p>
              Paite is spoken across Manipur, Mizoram, Assam and the Zomi
              diaspora. English ↔ Paite runs on a model trained specifically
              for the language. Other pairs pass through English using Google
              Translate, and you can edit that English step when the meaning
              drifts.
            </p>
            <p>
              Every thumbs up, thumbs down and suggested fix goes back into
              training the next version, so the translator improves with the
              community that uses it.
            </p>
          </div>
        </section>

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-stone-300/50 pt-4 text-xs text-zomi-muted">
          <span>
            Model by{" "}
            <a
              href="https://huggingface.co/sensix-zo"
              target="_blank"
              rel="noreferrer"
              className="text-zomi-red hover:underline"
            >
              sensix-zo
            </a>{" "}
            on Hugging Face.
          </span>
          <span>Free to use. Longer texts need more server than we have yet.</span>
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
            <p className="font-medium text-zomi-ink">Drop to read the text</p>
            <p className="mt-1 text-xs text-zomi-muted">
              .txt, .pdf, .docx, or an image
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
