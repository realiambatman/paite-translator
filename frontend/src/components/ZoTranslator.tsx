import { useEffect, useMemo, useRef, useState } from "react";
import { fetchZoStatus, translateZo, type ZoResult, type ZoStatus } from "../services/api";
import { saveTranslationLog } from "../services/translationLog";
import { FeedbackPanel } from "./FeedbackPanel";

// How Zo-tab translations are marked in the translation log and the admin panel.
export const ZO_ROUTE = "own-125m";

// Our own model for English and the Zo languages. The input language is detected by the model itself,
// so only the language(s) to translate to are chosen.
export function ZoTranslator() {
  const [status, setStatus] = useState<ZoStatus | null>(null);
  const [text, setText] = useState("");
  const [target, setTarget] = useState("pck");
  const [extra, setExtra] = useState<string[]>([]);
  const [results, setResults] = useState<ZoResult[]>([]);
  const [logIds, setLogIds] = useState<Record<string, string | null>>({});
  const [lastSource, setLastSource] = useState("");
  const [seconds, setSeconds] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExtra, setShowExtra] = useState(false);
  const extraRef = useRef<HTMLDivElement>(null);

  useEffect(() => {   // the language list closes when you click anywhere else
    if (!showExtra) return;
    const close = (e: MouseEvent) => {
      if (extraRef.current && !extraRef.current.contains(e.target as Node)) setShowExtra(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showExtra]);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const s = await fetchZoStatus();
        if (stop) return;
        setStatus((prev) => {
          if (!prev) {   // first answer: take the defaults the server suggests
            setTarget(s.default_target);
            setExtra(s.default_extra.filter((c) => s.languages.some((l) => l.code === c)));
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
  const extraChosen = useMemo(() => extra.filter((c) => c !== target), [extra, target]);

  const toggle = (code: string) =>
    setExtra((cur) => (cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code]));

  const run = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await translateZo(text, target, extraChosen);
      setResults(r.results);
      setSeconds(r.seconds);
      setLastSource(text);
      setLogIds({});
      // each language is logged on its own, so it can be rated and corrected on its own in the admin panel
      const ids = await Promise.all(
        r.results.map((res) =>
          saveTranslationLog({
            srcLang: "auto",
            tgtLang: res.code,
            srcText: text.slice(0, 1000),
            tgtText: res.translation.slice(0, 1500),
            route: ZO_ROUTE,
            source: "text",
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
      : ready
        ? `${languages.length} languages`
        : "Loading the model…";

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-stone-300/60 bg-zomi-paper shadow-[0_1px_0_rgb(28_25_23/0.04),0_12px_32px_-16px_rgb(28_25_23/0.18)]">
      <div ref={extraRef} className="relative flex flex-col gap-3 border-b border-stone-300/50 px-4 py-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-zomi-muted">Translate to</p>
          <span className="relative inline-flex min-w-0 items-center">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={!ready || busy}
              className="cursor-pointer appearance-none rounded-xl border border-transparent bg-transparent py-1.5 pl-1 pr-8 font-serif text-lg font-semibold text-zomi-ink outline-none transition hover:bg-white/70 disabled:opacity-60"
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {label(l.code)}
                </option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-2 text-zomi-muted">▾</span>
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-zomi-muted">Also translate into</p>
          <button
            type="button"
            onClick={() => setShowExtra((v) => !v)}
            disabled={!ready}
            aria-expanded={showExtra}
            className="flex max-w-[22rem] items-center gap-2 rounded-xl py-1.5 pl-1 pr-2 text-left text-sm text-zomi-ink transition hover:bg-white/70 disabled:opacity-50"
          >
            <span className="truncate">
              {extraChosen.length ? extraChosen.map((c) => label(c).split(" (")[0]).join(", ") : "None"}
            </span>
            <span className="shrink-0 text-zomi-muted">▾</span>
          </button>
          {showExtra && (
            <div className="absolute inset-x-3 top-full z-20 mt-1 grid grid-cols-2 gap-x-2 rounded-xl border border-stone-300/70 bg-white p-2 shadow-lg sm:grid-cols-3 lg:grid-cols-5">
              {languages
                .filter((l) => l.code !== target)
                .map((l) => (
                  <label key={l.code} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-zomi-paper">
                    <input
                      type="checkbox"
                      checked={extra.includes(l.code)}
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
        {showExtra && languages.some((l) => l.little_data) && (
          <p className="sr-only">Languages marked with a star had very little training data.</p>
        )}
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
            placeholder="Type in English or any Zo language. The language is detected automatically."
            className="block min-h-[220px] w-full resize-y bg-transparent px-4 py-3 text-[1.05rem] leading-relaxed text-zomi-ink outline-none placeholder:text-zomi-muted/70"
          />
          <div className="flex items-center justify-between gap-2 px-4 pb-3">
            <span className="text-xs text-zomi-muted">{stateLine}</span>
            <button
              type="button"
              onClick={() => void run()}
              disabled={!ready || busy || !text.trim()}
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
            results.map((r) => (
              <div key={r.code}>
                <p className="text-xs font-semibold uppercase tracking-wide text-zomi-muted">{label(r.code)}</p>
                <p className="whitespace-pre-wrap text-[1.05rem] leading-relaxed text-zomi-ink">{r.translation}</p>
                <FeedbackPanel
                  key={`${lastSource}::${r.code}::${r.translation}`}
                  result={{
                    srcText: lastSource,
                    srcLang: "auto",
                    tgtLang: r.code,
                    translation: r.translation,
                    route: ZO_ROUTE,
                    pivotEnglish: null,
                    translationId: logIds[r.code] ?? null,
                  }}
                  outputText={r.translation}
                  alternatives={[]}
                  tgtLabel={label(r.code).split(" (")[0]}
                  onPickAlternative={() => {}}
                />
              </div>
            ))
          )}
          {seconds != null && results.length > 0 && (
            <p className="text-xs text-zomi-muted">{seconds.toFixed(1)} s</p>
          )}
        </div>
      </div>
    </div>
  );
}
