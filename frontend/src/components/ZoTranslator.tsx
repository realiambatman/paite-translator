import { useEffect, useMemo, useRef, useState } from "react";
import { fetchZoStatus, translateZo, type ZoResult, type ZoStatus } from "../services/api";
import { saveTranslationLog } from "../services/translationLog";
import { FeedbackPanel } from "./FeedbackPanel";

// How Zo-tab translations are marked in the translation log and the admin panel.
export const ZO_ROUTE = "own-125m";

// Our own model for English and the Zo languages. It is a test model: good from English, weak between two
// Zo languages (too few such pairs to learn from). The visitor says which language the text is in. From a Zo
// language English is the reliable answer; another Zo language can be tried and is marked as in progress.
// The server also checks the text itself, in case the source was left on English.
export function ZoTranslator() {
  const [status, setStatus] = useState<ZoStatus | null>(null);
  const [text, setText] = useState("");
  const [source, setSource] = useState("en");
  const [targets, setTargets] = useState<string[]>([]);
  const [results, setResults] = useState<ZoResult[]>([]);
  const [logIds, setLogIds] = useState<Record<string, string | null>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});   // a candidate the visitor chose instead
  const [lastSource, setLastSource] = useState("");
  const [lastSourceLang, setLastSourceLang] = useState("en");
  const [seconds, setSeconds] = useState<number | null>(null);
  const [notEnglish, setNotEnglish] = useState(false);   // source was English, but the text was not
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showTargets, setShowTargets] = useState(false);
  const targetsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {   // the language list closes when you click anywhere else
    if (!showTargets) return;
    const close = (e: MouseEvent) => {
      if (targetsRef.current && !targetsRef.current.contains(e.target as Node)) setShowTargets(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showTargets]);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const s = await fetchZoStatus();
        if (stop) return;
        setStatus((prev) => {
          if (!prev) {   // first answer: one language is chosen to begin with, the rest is the visitor's choice
            setTargets([s.default_target, ...s.default_extra].filter((c) => s.languages.some((l) => l.code === c)));
          }
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
  // The language the text is in is never an answer.
  const chosen = useMemo(() => targets.filter((c) => c !== source), [source, targets]);
  const short = (code: string) => label(code).split(" (")[0];

  const changeSource = (code: string) => {
    setSource(code);
    // from a Zo language English is the answer that works: it is ticked, and the rest stays as chosen
    if (code !== "en") setTargets((cur) => (cur.includes("en") ? cur : ["en", ...cur]));
  };

  const toggle = (code: string) =>
    setTargets((cur) => (cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]));

  const run = async () => {
    if (!text.trim() || busy || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await translateZo(text, source, chosen);
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
        : chosen.length === 0
          ? "Choose a language to translate into."
          : `${languages.length} languages`;

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-stone-300/60 bg-zomi-paper shadow-[0_1px_0_rgb(28_25_23/0.04),0_12px_32px_-16px_rgb(28_25_23/0.18)]">
      <div ref={targetsRef} className="relative flex flex-col gap-3 border-b border-stone-300/50 px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
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
          <button
            type="button"
            onClick={() => setShowTargets((v) => !v)}
            disabled={!ready}
            aria-expanded={showTargets}
            className="flex max-w-[22rem] items-center gap-2 rounded-xl py-1.5 pl-1 pr-2 text-left text-sm text-zomi-ink transition hover:bg-white/70 disabled:opacity-50"
          >
            <span className="truncate">
              {chosen.length ? chosen.map((c) => label(c).split(" (")[0]).join(", ") : "Choose languages"}
            </span>
            <span className="shrink-0 text-zomi-muted">▾</span>
          </button>
          {showTargets && (
            <div className="absolute inset-x-3 top-full z-20 mt-1 grid grid-cols-2 gap-x-2 rounded-xl border border-stone-300/70 bg-white p-2 shadow-lg sm:grid-cols-3 lg:grid-cols-5">
              {!fromEnglish && (
                <p className="col-span-full px-2 pb-1 text-xs text-zomi-muted">
                  From {short(source)}, English is the reliable choice. You can try another Zo language, but Zo to Zo
                  is still in progress and often wrong.
                </p>
              )}
              {languages
                .filter((l) => l.code !== source)
                .map((l) => (
                  <label key={l.code} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-zomi-paper">
                    <input
                      type="checkbox"
                      checked={targets.includes(l.code)}
                      onChange={() => toggle(l.code)}
                      className="accent-zomi-red"
                    />
                    <span className={`truncate ${l.little_data ? "text-zomi-muted" : "text-zomi-ink"}`} title={label(l.code)}>
                      {l.label}{l.little_data ? " *" : ""}
                    </span>
                  </label>
                ))}
              {languages.some((l) => l.little_data) && (
                <p className="col-span-full px-2 pt-1 text-xs text-zomi-muted">* very little training data: output is a rough guess</p>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="border-b border-stone-300/50 bg-amber-50/70 px-4 py-2 text-sm leading-snug text-stone-700">
        <span className="font-semibold">Test model.</span> It works best from English. Translating from one Zo
        language to another is still in progress and often wrong, because the model has too little data for it.
        It is not perfect in every language yet.
      </p>

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
              disabled={!ready || busy || !text.trim() || chosen.length === 0}
              className="rounded-full bg-zomi-red px-5 py-2 text-sm font-semibold text-white transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Translating…" : "Translate"}
            </button>
          </div>
        </div>
        <div className="min-h-[220px] space-y-4 px-4 py-3">
          {results.length === 0 ? (
            <p className="text-sm text-zomi-muted">
              {busy ? "Translating…" : "The translation appears here, in each chosen language."}
            </p>
          ) : (
            <>
              {notEnglish && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-stone-700">
                  Your text does not look like English, so it was translated into English only. To try another
                  language, choose the language of your text under Source.
                </p>
              )}
              {results.map((r) => (
              <div key={r.code}>
                <p className="text-xs font-semibold uppercase tracking-wide text-zomi-muted">
                  {label(r.code)}
                  {lastSourceLang !== "en" && r.code !== "en" && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-normal normal-case tracking-normal text-stone-700">
                      Zo to Zo: in progress, may be wrong
                    </span>
                  )}
                </p>
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
