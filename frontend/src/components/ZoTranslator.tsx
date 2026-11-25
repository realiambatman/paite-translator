import { useEffect, useState } from "react";
import { LanguagePicker, type PickerOption } from "./LanguagePicker";
import { fetchZoStatus, translateZo, type ZoResult, type ZoStatus } from "../services/api";
import { saveTranslationLog } from "../services/translationLog";
import { FeedbackPanel } from "./FeedbackPanel";

// How Zo-tab translations are marked in the translation log and the admin panel.
export const ZO_ROUTE = "own-125m";

// Our own model for English and the Zo languages (the "small" model). The visitor picks the language the
// text is in and one language to translate into, as on the Paite tab; the two can be swapped.
// The server also checks the text itself, in case the source was left on English.
const MAIN = new Set(["en", "pck", "lus", "ctd", "hmr", "tcz", "vap", "zom", "smt", "gnb", "cnh", "cfm", "csy"]);
const NEIGHBOURS = /^(hi|my|mni)(_|$)/;

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
  // The picker's list: the languages with the most data first, then Hindi, Burmese and Meitei, then the rest.
  const options: PickerOption[] = languages.map((l) => ({
    code: l.code,
    label: l.label,
    note: l.little_data ? "little data" : undefined,
    group: MAIN.has(l.code) ? "Main languages" : NEIGHBOURS.test(l.code) ? "Hindi, Burmese, Meitei" : "More Zo languages",
  }));
  const rank = (g?: string) => (g === "Main languages" ? 0 : g === "More Zo languages" ? 1 : 2);
  options.sort((a, b) => rank(a.group) - rank(b.group));
  const fromEnglish = source === "en";
  const short = (code: string) => label(code).split(" (")[0];

  // The language the text is in is never an answer: picking it as the source moves the answer elsewhere.
  const changeSource = (code: string) => {
    setSource(code);
    if (target === code) setTarget(code === "en" ? (status?.default_target ?? "pck") : "en");
  };

  // Swap the two languages; the translation that was shown becomes the text to translate back.
  const swap = () => {
    if (busy) return;
    const shown = results.find((r) => r.code === target);
    const back = shown ? (picked[target] ?? shown.translation) : "";
    setSource(target);
    setTarget(source);
    if (back) setText(back);
    setResults([]);
    setLogIds({});
    setPicked({});
    setNotEnglish(false);
    setSeconds(null);
    setError(null);
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
          <LanguagePicker
            value={source}
            onChange={changeSource}
            options={options}
            disabled={!ready || busy}
            ariaLabel="The language your text is in"
          />
        </div>
        <button
          type="button"
          onClick={swap}
          disabled={!ready || busy}
          className="grid h-9 w-9 shrink-0 place-items-center self-start rounded-full text-zomi-red transition hover:bg-white disabled:opacity-50 sm:self-end"
          aria-label="Swap languages"
          title="Swap languages"
        >
          <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 7h12m0 0-3-3m3 3-3 3M17 13H5m0 0 3 3m-3-3 3-3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-zomi-muted">Translate into</p>
          <LanguagePicker
            value={target}
            onChange={setTarget}
            options={options.filter((o) => o.code !== source)}
            disabled={!ready || busy}
            ariaLabel="The language to translate into"
            align="right"
          />
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
