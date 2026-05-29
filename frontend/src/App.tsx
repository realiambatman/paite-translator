import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchStatus,
  type LangCode,
  type ModelStatus,
  translateTextStream,
} from "./services/api";

const LANGUAGES: { code: LangCode; label: string }[] = [
  { code: "eng_Latn", label: "English" },
  { code: "pai_Latn", label: "Paite" },
];

const EXAMPLES: { text: string; src: LangCode; tgt: LangCode }[] = [
  {
    text: "Hello, how are you today? I hope you are doing well.",
    src: "eng_Latn",
    tgt: "pai_Latn",
  },
  {
    text: "The Zomi people have a rich cultural heritage and a strong tradition of oral folklore.",
    src: "eng_Latn",
    tgt: "pai_Latn",
  },
  {
    text: "Here are the main points:\n1. Introduction and identity.\n2. Language and culture.\n3. Religion.\n4. Modern Context and Diaspora.",
    src: "eng_Latn",
    tgt: "pai_Latn",
  },
];

function langLabel(code: LangCode) {
  return LANGUAGES.find((l) => l.code === code)?.label ?? code;
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
    refreshStatus();
    const timer = window.setInterval(refreshStatus, 5000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    if (isTranslating && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [outputText, isTranslating]);

  const runTranslation = async (
    text: string,
    src: LangCode,
    tgt: LangCode,
  ) => {
    if (!text.trim()) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsTranslating(true);
    setError(null);
    setOutputText("");

    try {
      await translateTextStream(
        text,
        src,
        tgt,
        ({ translation }) => setOutputText(translation),
        controller.signal,
      );
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100">
      <div className="mx-auto max-w-6xl px-4 py-8 md:py-12">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 md:text-4xl">
            Zomi Paite Translator
          </h1>
          <p className="mt-1 text-lg font-medium text-slate-700">
            English ↔ Paite (Zomi Language)
          </p>
          <p className="mt-2 max-w-2xl mx-auto text-slate-600">
            Translate English and Paite for the Zomi community. Long documents,
            sermons, and notes keep their original formatting.
          </p>

          <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 shadow-sm">
            {modelReady ? (
              <>
                <span>Model ready</span>
                <span className="text-slate-300">·</span>
                <span>{status?.device}</span>
                <span className="text-slate-300">·</span>
                <span>{status?.quantization}</span>
              </>
            ) : (
              <span>Loading model from Hugging Face…</span>
            )}
          </div>
        </header>

        <div className="mb-4 flex flex-wrap items-end justify-center gap-3">
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Source
            <select
              value={srcLang}
              onChange={(e) => setSrcLang(e.target.value as LangCode)}
              disabled={isTranslating}
              className="min-w-[140px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 disabled:opacity-60"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={handleSwap}
            disabled={isTranslating}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
            aria-label="Swap languages"
          >
            ⇄ Swap
          </button>

          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Target
            <select
              value={tgtLang}
              onChange={(e) => setTgtLang(e.target.value as LangCode)}
              disabled={isTranslating}
              className="min-w-[140px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 disabled:opacity-60"
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <section className="flex min-h-[360px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-medium text-slate-600">
              Input ({langLabel(srcLang)})
            </div>
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Enter text or paste a document here…"
              disabled={isTranslating}
              className="min-h-[280px] flex-1 resize-none border-0 bg-transparent px-4 py-3 text-base leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 disabled:opacity-70"
            />
            <div className="border-t border-slate-100 px-4 py-3">
              <button
                type="button"
                onClick={handleTranslate}
                disabled={!inputText.trim() || isTranslating || !modelReady}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isTranslating && (
                  <span
                    className="stream-spinner inline-block h-4 w-4 rounded-full border-2 border-white/30 border-t-white"
                    aria-hidden
                  />
                )}
                {isTranslating ? "Translating…" : "Translate"}
              </button>
            </div>
          </section>

          <section className="flex min-h-[360px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-medium text-slate-600">
              Translation ({langLabel(tgtLang)})
            </div>

            <div
              ref={outputRef}
              className="min-h-[280px] flex-1 overflow-y-auto px-4 py-3"
            >
              {outputText ? (
                <p className="whitespace-pre-wrap text-base leading-relaxed text-slate-900">
                  {outputText}
                  {isTranslating && (
                    <span
                      className="stream-cursor ml-0.5 inline-block h-[1.1em] w-0.5 translate-y-px bg-indigo-500 align-middle"
                      aria-hidden
                    />
                  )}
                </p>
              ) : isTranslating ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm text-slate-500">
                    <span
                      className="stream-spinner inline-block h-4 w-4 rounded-full border-2 border-slate-200 border-t-indigo-500"
                      aria-hidden
                    />
                    Translating…
                  </div>
                  <div className="space-y-2 animate-pulse">
                    <div className="h-3 w-full rounded bg-slate-100" />
                    <div className="h-3 w-11/12 rounded bg-slate-100" />
                    <div className="h-3 w-4/5 rounded bg-slate-100" />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-slate-400">
                  Translation will appear here.
                </p>
              )}
            </div>
          </section>
        </div>

        {error && (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </p>
        )}

        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold text-slate-800">
            Try an example
          </h2>
          <div className="grid gap-3 md:grid-cols-3">
            {EXAMPLES.map((example, index) => (
              <button
                key={index}
                type="button"
                onClick={() => handleExample(example)}
                disabled={isTranslating || !modelReady}
                className="rounded-xl border border-slate-200 bg-white p-4 text-left text-sm text-slate-700 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="line-clamp-4">{example.text}</span>
              </button>
            ))}
          </div>
        </section>

        <footer className="mt-10 space-y-2 text-center text-xs text-slate-400">
          <p>
            Paite is a Zomi language. This tool helps Zomi speakers, learners,
            and diaspora communities translate between English and Paite.
          </p>
          <p>
            Powered by{" "}
            <a
              href="https://huggingface.co/sensix-zo/nllb-paite-600m-v15"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-600 hover:underline"
            >
              sensix-zo/nllb-paite-600m-v15
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
