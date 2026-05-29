import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchStatus,
  type LangCode,
  type Language,
  type ModelStatus,
  translateTextStream,
} from "./services/api";
import { analyzeInput, DEFAULT_MAX_TOKENS } from "./utils/textLimits";
import { saveTranslationLog } from "./services/translationLog";

const HF_LANGS = new Set<LangCode>(["eng_Latn", "pai_Latn"]);

const FALLBACK_LANGUAGES: Language[] = [
  { code: "eng_Latn", label: "English", provider: "hf" },
  { code: "pai_Latn", label: "Paite", provider: "hf" },
  { code: "lus_Latn", label: "Mizo", provider: "google" },
  { code: "mni_Beng", label: "Meitei", provider: "google" },
  { code: "mya_Mymr", label: "Burmese", provider: "google" },
  { code: "hin_Deva", label: "Hindi", provider: "google" },
];

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
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const languages = status?.languages ?? FALLBACK_LANGUAGES;
  const maxTokens = status?.limits?.max_tokens ?? DEFAULT_MAX_TOKENS;
  const googleQuota = status?.google_quota;
  const googleQuotaExceeded = googleQuota?.quota_exceeded ?? false;
  const googleConfigured = status?.google_translate_configured ?? false;
  const googleEnabled = status?.google_translate_enabled ?? false;
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
        ? EXAMPLES.filter(
            (ex) => !needsGoogleRoute(ex.src, ex.tgt),
          )
        : EXAMPLES,
    [googleQuotaExceeded],
  );

  const inputAnalysis = useMemo(
    () => analyzeInput(inputText, maxTokens),
    [inputText, maxTokens],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchStatus();
      setStatus(next);
      if (next.error) setError(next.error);
    } catch {
      setStatus(null);
    }
  }, []);

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
    if (isTranslating && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputText, isTranslating]);

  const runTranslation = async (text: string, src: LangCode, tgt: LangCode) => {
    if (!text.trim() || !analyzeInput(text, maxTokens).valid) return;
    if (needsGoogleRoute(src, tgt) && !googleEnabled) {
      setError(
        googleQuotaExceeded
          ? "Google Translate daily limit reached. English ↔ Paite still works until midnight UTC."
          : googleConfigured
            ? "Google Translate is unavailable for this language pair right now."
            : "This language pair needs Google Translate. Add GOOGLE_TRANSLATE_API_KEY on the server.",
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
        void saveTranslationLog({
          srcLang: src,
          tgtLang: tgt,
          srcText: text,
          tgtText: result.translation,
          route: result.route,
          pivotEnglish: result.pivotEnglish,
        });
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

  const modelReady = status?.ready ?? false;
  const canTranslate =
    inputAnalysis.valid &&
    !isTranslating &&
    modelReady &&
    (!googleRequired || googleEnabled);
  const barColor =
    inputAnalysis.overTokens || inputAnalysis.multiSentence
      ? "bg-zomi-red"
      : inputAnalysis.tokenRatio >= 0.85
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
        <header className="mb-5 flex flex-col gap-3 border-b border-stone-300/40 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-zomi-gold">
              Paite · Zomi Language
            </p>
            <h1 className="font-serif text-2xl font-bold tracking-tight text-zomi-ink md:text-3xl">
              Zomi Paite Translator
            </h1>
            <p className="mt-1 max-w-lg text-sm text-zomi-muted">
              Translate Paite with English, Mizo, Meitei, Burmese, and Hindi
              for the Zomi community.
            </p>
          </div>
          <p className="text-xs text-zomi-muted sm:text-right">
            {modelReady ? (
              <>Model ready · {status?.device}</>
            ) : (
              "Loading model from Hugging Face…"
            )}
          </p>
        </header>

        <div className="overflow-hidden rounded-2xl border border-stone-300/50 bg-zomi-paper/80 shadow-[0_8px_30px_rgb(28_25_23/0.06)] backdrop-blur-sm">
          <div className="zomi-stripe h-1" />

          <div className="flex flex-wrap items-center gap-2 border-b border-stone-300/40 px-4 py-3">
            <select
              value={srcLang}
              onChange={(e) => setSrcLang(e.target.value as LangCode)}
              disabled={isTranslating}
              className="rounded-lg border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm font-medium text-zomi-ink outline-none focus:border-zomi-red/50 disabled:opacity-60"
            >
              {availableLanguages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={handleSwap}
              disabled={isTranslating}
              className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm text-zomi-red transition hover:border-zomi-red/30 hover:bg-white disabled:opacity-60"
              aria-label="Swap languages"
            >
              ⇄
            </button>

            <select
              value={tgtLang}
              onChange={(e) => setTgtLang(e.target.value as LangCode)}
              disabled={isTranslating}
              className="rounded-lg border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm font-medium text-zomi-ink outline-none focus:border-zomi-red/50 disabled:opacity-60"
            >
              {availableLanguages.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>

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
              {isTranslating ? "Translating…" : "Translate"}
            </button>
          </div>

          {googleQuotaExceeded && (
            <p className="border-b border-amber-200/60 bg-amber-50/80 px-4 py-2 text-xs text-amber-900">
              Google Translate daily limit reached (
              {googleQuota?.daily_chars_used?.toLocaleString()} /{" "}
              {googleQuota?.daily_char_limit?.toLocaleString()} characters). Only
              English ↔ Paite until midnight UTC.
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
                placeholder="Enter one sentence to translate…"
                disabled={isTranslating}
                className="min-h-[280px] flex-1 resize-none border-0 bg-transparent px-4 pb-2 text-base leading-relaxed text-zomi-ink outline-none placeholder:text-stone-400 disabled:opacity-70 md:min-h-[360px]"
              />
              <div className="border-t border-stone-300/30 px-4 py-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span
                    className={
                      inputAnalysis.overTokens || inputAnalysis.multiSentence
                        ? "font-medium text-zomi-red-dark"
                        : "text-zomi-muted"
                    }
                  >
                    {inputAnalysis.message}
                  </span>
                  <span className="tabular-nums text-zomi-muted">
                    {inputAnalysis.words}{" "}
                    {inputAnalysis.words === 1 ? "word" : "words"} · ~
                    {inputAnalysis.tokens}/{maxTokens} tokens
                  </span>
                </div>
                <div
                  className="h-1.5 overflow-hidden rounded-full bg-stone-200/80"
                  role="progressbar"
                  aria-valuenow={Math.round(inputAnalysis.tokenRatio * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Estimated token usage"
                >
                  <div
                    className={`h-full rounded-full transition-all duration-200 ${barColor}`}
                    style={{
                      width: `${Math.min(inputAnalysis.tokenRatio * 100, 100)}%`,
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
                disabled={isTranslating || !modelReady}
                className="min-w-[220px] max-w-xs shrink-0 rounded-xl border border-stone-300/50 bg-zomi-paper/60 p-3 text-left text-sm text-zomi-ink transition hover:border-zomi-red/30 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="line-clamp-3">{example.text}</span>
              </button>
            ))}
          </div>
        </section>

        <footer className="mt-8 border-t border-stone-300/40 pt-4 text-center text-xs text-zomi-muted">
          <p>
            One sentence per request · up to {maxTokens} tokens — server
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
    </div>
  );
}
