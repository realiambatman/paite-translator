import { useEffect, useState } from "react";
import { fetchZoStatus, translateZo, type ZoResult, type ZoStatus } from "../services/api";
import { saveTranslationLog } from "../services/translationLog";
import { FeedbackPanel } from "./FeedbackPanel";

// How Zo-tab translations are marked in the translation log and the admin panel.
export const ZO_ROUTE = "own-125m";

// Our own model for English and the Zo languages. It is a test model: good from English, weak between two
// Zo languages (too few such pairs to learn from). The visitor picks the language the text is in and one
// language to translate into, as on the Paite tab. Zo to Zo can be tried and carries a short note.
// The server also checks the text itself, in case the source was left on English.
export function ZoTranslator() {
  const [status, setStatus] = useState<ZoStatus | null>(null);
  const [text, setText] = useState("");
  const [source, setSource] = useState("en");
  const [target, setTarget] = useState("pck");
  const [results, setResults] = useState<ZoResult[]>([]);
  const [logIds, setLogIds] = useState<Record<string, string | null>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});   // a candidate the visitor chose instead
  const [lastSource, setLastSource] = useState("");
  const [lastSourceLang, setLastSourceLang] = useState("en");
  const [seconds, setSeconds] = useState<number | null>(null);
  const [notEnglish, setNotEnglish] = useState(false);   // source was English, but the text was not
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const s = await fetchZoStatus();
        if (stop) return;
        setStatus((prev) => {
          if (!prev && s.languages.some((l) => l.code === s.default_target)) setTarget(s.default_target);
          return s;
        });
        if (!s.ready && !s.error) setTimeout(load, 5000);
      } catch {
        if (!stop) setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      stop = true;
    };
  }, []);

  const languages = status?.languages ?? [];
  const label = (code: string) => {
    const l = languages.find((x) => x.code === code);
    return l ? l.label + (l.little_data ? " (little data, unreliable)" : "") : code;
  };
  const fromEnglish = source === "en";
  const short = (code: string) => label(code).split(" (")[0];

  // The language the text is in is never an answer: picking it as the source moves the answer elsewhere.
  const changeSource = (code: string) => {
    setSource(code);
    if (code !== "en") setTarget("en");                       // from a Zo language, English is what works
    else if (target === "en") setTarget(status?.default_target ?? "pck");
  };

  const run = async () => {
    if (!text.trim() || busy || target === source) return;
    setBusy(true);
    setError(null);
    try {
      const r = await translateZo(text, source, [target]);
      setResults(r.results);
      setNotEnglish(fromEnglish && r.source_english === false);
      setSeconds(r.seconds);
      setLastSource(text);
      setLastSourceLang(source);
      setLogIds({});
      setPicked({});
      // each language is logged on its own, so it can be rated and corrected on its own in the admin panel
      const ids = await Promise.all(
        r.results.map((res) =>
          saveTranslationLog({
            srcLang: source,
            tgtLang: res.code,
            srcText: text.slice(0, 1000),
            tgtText: res.translation.slice(0, 1500),
            route: ZO_ROUTE,
            source: "text",
            alternatives: res.alternatives ?? [],
          }),
        ),
      );
      setLogIds(Object.fromEntries(r.results.map((res, i) => [res.code, ids[i]])));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Translation failed. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const ready = !!status?.ready;
  const stateLine = !status
    ? "Checking the model…"
    : status.error
      ? "The Zo model could not be loaded on the server."
      : !ready
        ? "Loading the model…"
        : `${languages.length} languages`;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-stone-300/60 bg-zomi-paper shadow-[0_1px_0_rgb(28_25_23/0.04),0_12px_32px_-16px_rgb(28_25_23/0.18)]">
      <div className="flex flex-col gap-3 border-b border-stone-300/50 px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-zomi-muted">Source</p>
          <span className="relative inline-flex min-w-0 items-center">
            <select
              value={source}
              onChange={(e) => changeSource(e.target.value)}
              disabled={!ready || busy}
              aria-label="The language your text is in"
              className="cursor-pointer appearance-none rounded-xl border border-transparent bg-transparent py-1.5 pl-1 pr-8 font-serif text-lg font-semibold text-zomi-ink outline-none transition hover:bg-white/70 disabled:opacity-60"
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 text-zomi-muted">▾</span>
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-zomi-muted">Translate into</p>
          <span className="relative inline-flex min-w-0 items-center">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={!ready || busy}
              aria-label="The language to translate into"
              className="cursor-pointer appearance-none rounded-xl border border-transparent bg-transparent py-1.5 pl-1 pr-8 font-serif text-lg font-semibold text-zomi-ink outline-none transition hover:bg-white/70 disabled:opacity-60"
            >
              {languages
                .filter((l) => l.code !== source)
                .map((l) => (
                  <option key={l.code} value={l.code}>
                    {label(l.code)}
                  </option>
                ))}
            </select>
            <span className="pointer-events-none absolute right-2 text-zomi-muted">▾</span>
          </span>
        </div>
      </div>

      {error && (
        <div role="alert" className="border-b border-zomi-red/20 bg-zomi-red/5 px-4 py-3 text-sm text-zomi-red-dark">
          {error}
        </div>
      )}

      <div className="grid md:grid-cols-2">
        <div className="border-b border-stone-300/50 md:border-b-0 md:border-r">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void run();
            }}
            placeholder={
              fromEnglish ? "Type English text here." : `Type ${short(source)} text here.`
            }
            className="block min-h-[220px] w-full resize-y bg-transparent px-4 py-3 text-[1.05rem] leading-relaxed text-zomi-ink outline-none placeholder:text-zomi-muted/70"
          />
          <div className="flex items-center justify-between gap-2 px-4 pb-3">
            <span className="text-xs text-zomi-muted">{stateLine}</span>
            <button
              type="button"
              onClick={() => void run()}
              disabled={!ready || busy || !text.trim() || target === source}
              className="rounded-full bg-zomi-red px-5 py-2 text-sm font-semibold text-white transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Translating…" : "Translate"}
            </button>
          </div>
        </div>
        <div className="min-h-[220px] space-y-4 px-4 py-3">
          {results.length === 0 ? (
            <p className="text-sm text-zomi-muted">
              {busy ? "Translating…" : "The translation appears here."}
            </p>
          ) : (
            <>
              {notEnglish && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-stone-700">
                  This does not look like English, so it was translated into English. Set Source to your language
                  to try another.
                </p>
              )}
              {results.map((r) => (
              <div key={r.code}>
                <p className="text-xs font-semibold uppercase tracking-wide text-zomi-muted">{label(r.code)}</p>
                <p className="whitespace-pre-wrap text-[1.05rem] leading-relaxed text-zomi-ink">{picked[r.code] ?? r.translation}</p>
                <FeedbackPanel
                  key={`${lastSource}::${r.code}::${r.translation}`}
                  result={{
                    srcText: lastSource,
                    srcLang: lastSourceLang,
                    tgtLang: r.code,
                    translation: r.translation,
                    route: ZO_ROUTE,
                    pivotEnglish: null,
                    translationId: logIds[r.code] ?? null,
                  }}
                  outputText={picked[r.code] ?? r.translation}
                  alternatives={r.alternatives ?? []}
                  tgtLabel={label(r.code).split(" (")[0]}
                  onPickAlternative={(alt) => setPicked((cur) => ({ ...cur, [r.code]: alt }))}
                />
              </div>
              ))}
            </>
          )}
          {seconds != null && results.length > 0 && (
            <p className="text-xs text-zomi-muted">{seconds.toFixed(1)} s</p>
          )}
        </div>
      </div>
    </div>
  );
}
