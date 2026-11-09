import { useCallback, useEffect, useState } from "react";
import type { Language } from "../../services/api";
import {
  cancelReview,
  fetchLlmKey,
  fetchLlmSettings,
  precheckReview,
  startReview,
  testLlm,
  updateLlmSettings,
  type LlmSettings,
  type OnExisting,
  type ReviewPrecheck,
  type ReviewStatus,
} from "../api";
import { formatDuration, formatNumber, reviewProgress } from "../format";

interface Props {
  token: string;
  languages: Language[];
  onAuthError: (err: unknown) => boolean;
  /** Review job state, polled by the admin shell so it survives tab switches. */
  review: ReviewStatus | null;
  onReview: (next: ReviewStatus) => void;
  /** Total logged translations, for the "All" shortcut. */
  totalTranslations: number | null;
}

export function AiReviewTab({
  token,
  languages,
  onAuthError,
  review,
  onReview,
  totalTranslations,
}: Props) {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [provider, setProvider] = useState<string>("anthropic");
  const [model, setModel] = useState<string>("");
  const [keyDraft, setKeyDraft] = useState<string>("");
  const [keyVisible, setKeyVisible] = useState(false);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [limit, setLimit] = useState(50);
  const [tgtLang, setTgtLang] = useState<string>("");
  const setReview = onReview;
  const [starting, setStarting] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [precheck, setPrecheck] = useState<ReviewPrecheck | null>(null);

  const applySettings = useCallback((next: LlmSettings) => {
    setSettings(next);
    const active = next.provider ?? "anthropic";
    setProvider(active);
    setModel(next.model ?? next.providers[active]?.default_model ?? "");
    setReviewers((prev) => {
      if (prev.length > 0) return prev;
      return next.available && next.model ? [`${active}/${next.model}`] : [];
    });
  }, []);

  useEffect(() => {
    fetchLlmSettings(token)
      .then(applySettings)
      .catch((err) => {
        if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Could not load settings.");
      });
  }, [token, applySettings, onAuthError]);

  const changeProvider = (next: string) => {
    setProvider(next);
    setKeyDraft("");
    setKeyVisible(false);
    setKeyNotice(null);
    setTestResult(null);
    if (settings) {
      setModel(
        settings.provider === next && settings.model
          ? settings.model
          : (settings.providers[next]?.default_model ?? ""),
      );
    }
  };

  const loadSavedKey = async (): Promise<string | null> => {
    if (keyDraft.trim()) return keyDraft.trim();
    try {
      const result = await fetchLlmKey(token, provider);
      return result.api_key;
    } catch (err) {
      if (!onAuthError(err)) {
        setKeyNotice(err instanceof Error ? err.message : "Could not read the saved key.");
      }
      return null;
    }
  };

  const revealKey = async () => {
    if (keyVisible) {
      setKeyVisible(false);
      if (!keyNotice?.startsWith("Copied")) setKeyNotice(null);
      return;
    }
    const key = await loadSavedKey();
    if (key == null) return;
    setKeyDraft(key);
    setKeyVisible(true);
    setKeyNotice(null);
  };

  const copyKey = async () => {
    const key = await loadSavedKey();
    if (key == null) return;
    try {
      await navigator.clipboard.writeText(key);
      setKeyNotice("Copied to clipboard.");
      window.setTimeout(() => setKeyNotice(null), 2000);
    } catch {
      setKeyNotice("Clipboard blocked by the browser. Use the eye to reveal and copy by hand.");
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await updateLlmSettings(token, {
        provider,
        model: model.trim() || undefined,
        api_keys: keyDraft.trim() ? { [provider]: keyDraft.trim() } : undefined,
      });
      applySettings(next);
      setKeyDraft("");
      setTestResult("Saved.");
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    if (!window.confirm("Remove the stored key for this provider?")) return;
    setSaving(true);
    try {
      applySettings(await updateLlmSettings(token, { api_keys: { [provider]: "" } }));
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Remove failed.");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await testLlm(token, {
        provider,
        model: model.trim() || undefined,
        api_key: keyDraft.trim() || undefined,
      });
      setTestResult(`Connected to ${result.model} (${result.ms} ms). Reply: “${result.reply}”`);
    } catch (err) {
      if (!onAuthError(err)) setTestResult(err instanceof Error ? err.message : "Test failed.");
    } finally {
      setTesting(false);
    }
  };

  const launch = async (onExisting: OnExisting) => {
    setPrecheck(null);
    setStarting(true);
    setError(null);
    try {
      setReview(
        await startReview(token, {
          limit,
          skip_reviewed: onExisting === "skip",
          tgt_lang: tgtLang || null,
          reviewers,
          on_existing: onExisting,
        }),
      );
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Could not start review.");
    } finally {
      setStarting(false);
    }
  };

  const run = async () => {
    setStarting(true);
    setError(null);
    try {
      const check = await precheckReview(token, { limit, tgt_lang: tgtLang || null, reviewers });
      const anyExisting = Object.values(check.reviewers).some((r) => r.already_reviewed > 0);
      if (anyExisting) {
        setPrecheck(check);
        setStarting(false);
        return;
      }
    } catch (err) {
      setStarting(false);
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Could not check entries.");
      return;
    }
    await launch("skip");
  };

  const stop = async () => {
    try {
      setReview(await cancelReview(token));
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Cancel failed.");
    }
  };

  const keyInfo = settings?.keys[provider];
  const providerMeta = settings?.providers[provider];
  const running = review?.status === "running";
  const progress = reviewProgress(review);

  const inputClass =
    "rounded-xl border border-stone-300/60 bg-white px-3 py-1.5 text-sm text-zomi-ink outline-none transition focus:border-zomi-red/40";

  return (
    <div className="divide-y divide-stone-300/40">
      <section className="px-4 py-4">
        <h3 className="font-serif text-base font-semibold text-zomi-ink">AI provider</h3>
        <p className="mt-0.5 text-xs text-zomi-muted">
          Pick which model reviews past translations and powers the translator's
          “Simplify English” button. Keys are stored in Firestore, readable only by the
          server. Honest note: these models know little Paite, so they are best at
          catching garbled output, dropped sentences and bad English pivots; every
          suggestion still lands in the review queue for you to accept or reject.
        </p>

        {settings && (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {Object.entries(settings.providers).map(([name, meta]) => {
              const info = settings.keys[name];
              const selected = provider === name;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => changeProvider(name)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition ${
                    selected
                      ? "border-zomi-red/50 bg-white shadow-sm"
                      : "border-stone-300/50 bg-zomi-cream hover:border-zomi-red/30"
                  }`}
                >
                  <p className="text-sm font-semibold text-zomi-ink">{meta.label}</p>
                  <p className="mt-0.5 text-[11px] text-zomi-muted">
                    {info?.configured
                      ? `Key saved ${info.hint ?? ""} (${info.source === "env" ? "server env" : "admin"})`
                      : "No key yet"}
                    {settings.provider === name ? " · active" : ""}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-3 grid gap-2 md:grid-cols-[1fr_1.4fr_auto]">
          <label className="text-[11px] text-zomi-muted">
            Model
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={`mt-1 block w-full ${inputClass}`}
            >
              {(providerMeta?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === providerMeta?.default_model ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-zomi-muted">
            API key {keyInfo?.configured ? "(leave blank to keep the saved one)" : ""}
            <span className="mt-1 flex items-center gap-1">
              <input
                type={keyVisible ? "text" : "password"}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={keyInfo?.configured ? `saved ${keyInfo.hint ?? ""}` : "paste key"}
                className={`block min-w-0 flex-1 font-mono ${inputClass}`}
              />
              <button
                type="button"
                onClick={revealKey}
                disabled={!keyInfo?.configured && !keyDraft}
                title={keyVisible ? "Hide key" : "Show saved key"}
                aria-label={keyVisible ? "Hide key" : "Show saved key"}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-stone-300/60 bg-white text-zomi-muted transition hover:text-zomi-ink disabled:opacity-40"
              >
                {keyVisible ? (
                  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M3 3l14 14M8.5 8.6A2.5 2.5 0 0 0 11.4 11.5M7 5.2A7.6 7.6 0 0 1 10 4.7c4 0 6.7 3.3 7.5 5.3-.3.8-1 1.9-2 2.9M4.3 7.3C3.3 8.3 2.8 9.3 2.5 10c.8 2 3.5 5.3 7.5 5.3 1.1 0 2.1-.2 3-.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M2.5 10c.8-2 3.5-5.3 7.5-5.3s6.7 3.3 7.5 5.3c-.8 2-3.5 5.3-7.5 5.3S3.3 12 2.5 10z" strokeLinejoin="round" />
                    <circle cx="10" cy="10" r="2.5" />
                  </svg>
                )}
              </button>
              <button
                type="button"
                onClick={copyKey}
                disabled={!keyInfo?.configured && !keyDraft}
                title="Copy key"
                aria-label="Copy key"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-stone-300/60 bg-white text-zomi-muted transition hover:text-zomi-ink disabled:opacity-40"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                  <rect x="7" y="7" width="9" height="9" rx="1.5" />
                  <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" strokeLinecap="round" />
                </svg>
              </button>
            </span>
            {keyNotice && <span className="mt-1 block text-[11px] text-zomi-ink">{keyNotice}</span>}
          </label>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={test}
              disabled={testing || saving}
              className="rounded-full border border-stone-300/60 bg-zomi-cream px-4 py-2 text-xs text-zomi-ink transition hover:bg-white disabled:opacity-60"
            >
              {testing ? "Testing…" : "Test"}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || testing}
              className="rounded-full bg-zomi-red px-4 py-2 text-xs font-semibold text-white transition hover:bg-zomi-red-dark disabled:bg-stone-300"
            >
              {saving ? "Saving…" : "Save & use"}
            </button>
          </div>
        </div>
        {keyInfo?.configured && keyInfo.source === "admin" && (
          <button
            type="button"
            onClick={removeKey}
            disabled={saving}
            className="mt-2 text-xs text-zomi-muted hover:text-zomi-red hover:underline"
          >
            Remove saved key for this provider
          </button>
        )}
        {testResult && <p className="mt-2 text-xs text-zomi-ink">{testResult}</p>}
        {error && (
          <p role="alert" className="mt-2 text-xs text-zomi-red-dark">
            {error}
          </p>
        )}
      </section>

      <section className="px-4 py-4">
        <h3 className="font-serif text-base font-semibold text-zomi-ink">Review past translations</h3>
        <p className="mt-0.5 text-xs text-zomi-muted">
          Goes through logged translations newest first, in small batches. Anything the
          model is confident is wrong becomes a <em>pending</em> correction in the
          Corrections tab. Live translations are never changed. Each entry is stamped so it
          is not reviewed twice.
        </p>

        {settings && (
          <div className="mt-3">
            <p className="mb-1.5 text-[11px] text-zomi-muted">
              Review with
            </p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(settings.providers).flatMap(([name, meta]) =>
                meta.models.map((m) => {
                  const id = `${name}/${m}`;
                  const hasKey = settings.keys[name]?.configured ?? false;
                  const on = reviewers.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={!hasKey || running}
                      title={hasKey ? meta.label : `Save a ${meta.label} key first`}
                      onClick={() =>
                        setReviewers((prev) =>
                          on ? prev.filter((r) => r !== id) : [...prev, id],
                        )
                      }
                      className={`rounded-full border px-3 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                        on
                          ? "border-violet-300 bg-violet-100 text-violet-900"
                          : "border-stone-300/60 bg-zomi-cream text-zomi-ink hover:bg-white"
                      }`}
                    >
                      {on ? "✓ " : ""}
                      {m}
                    </button>
                  );
                }),
              )}
            </div>
            <p className="mt-1 text-[11px] text-zomi-muted">
              Pick more than one to get a second opinion: each model reviews the same
              entries and its suggestions appear side by side in Corrections. If a model
              has already reviewed some of these entries you will be asked whether to skip
              them, replace its old suggestions, or keep both.
            </p>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-[11px] text-zomi-muted">
            How many
            <input
              type="number"
              min={1}
              max={50000}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(50000, Number(e.target.value) || 1)))}
              className={`mt-1 block w-28 ${inputClass}`}
            />
          </label>
          {totalTranslations != null && totalTranslations > 0 && (
            <button
              type="button"
              disabled={running}
              onClick={() => setLimit(Math.min(50000, totalTranslations))}
              className={`rounded-full border px-3 py-2 text-xs transition disabled:opacity-50 ${
                limit === totalTranslations
                  ? "border-violet-300 bg-violet-100 text-violet-900"
                  : "border-stone-300/60 bg-zomi-cream text-zomi-ink hover:bg-white"
              }`}
            >
              All {totalTranslations.toLocaleString()}
            </button>
          )}
          <label className="text-[11px] text-zomi-muted">
            Target language
            <select
              value={tgtLang}
              onChange={(e) => setTgtLang(e.target.value)}
              className={`mt-1 block ${inputClass}`}
            >
              <option value="">Any</option>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </label>
          {running ? (
            <button
              type="button"
              onClick={stop}
              className="rounded-full border border-zomi-red/40 bg-white px-4 py-2 text-xs font-semibold text-zomi-red transition hover:bg-zomi-red/5"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={run}
              disabled={starting || !settings?.available || reviewers.length === 0}
              title={
                !settings?.available
                  ? "Save a working API key first"
                  : reviewers.length === 0
                    ? "Pick at least one model"
                    : ""
              }
              className="rounded-full bg-zomi-red px-4 py-2 text-xs font-semibold text-white transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {starting
                ? "Starting…"
                : `Review ${limit === totalTranslations ? "all" : "last"} ${limit.toLocaleString()}${reviewers.length > 1 ? ` with ${reviewers.length} models` : ""}`}
            </button>
          )}
        </div>

        {limit > 500 && !running && (
          <p className="mt-2 text-[11px] text-zomi-muted">
            A run this size takes a while and costs real API money, roughly one model
            call per 8 entries. It keeps going on the server if you close this page. If
            the server restarts mid-run, start it again and choose Skip: finished entries
            are not repeated.
          </p>
        )}

        {review && review.status !== "idle" && progress && (
          <div className="mt-4 rounded-xl border border-stone-300/50 bg-zomi-cream/70 px-4 py-3 text-xs">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm text-zomi-ink">
                <span className="font-serif text-2xl font-semibold tabular-nums">{progress.percent}%</span>{" "}
                <span className="text-zomi-muted">
                  {review.status === "running"
                    ? "reviewing"
                    : review.status === "done"
                      ? "finished"
                      : review.status}
                  {review.current_reviewer ? ` with ${review.current_reviewer}` : ""}
                  {(review.models_total ?? 1) > 1
                    ? ` (model ${(review.model_index ?? 0) + 1} of ${review.models_total})`
                    : ""}
                </span>
              </p>
              <p className="tabular-nums text-zomi-muted">
                {formatNumber(progress.done)} of {formatNumber(progress.total)} entries ·{" "}
                {formatDuration(progress.elapsedMs)} elapsed
                {progress.remainingMs != null
                  ? ` · about ${formatDuration(progress.remainingMs)} left`
                  : ""}
              </p>
            </div>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-stone-200/80"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
              aria-label="Review progress"
            >
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  review.status === "failed" ? "bg-stone-400" : "bg-zomi-red"
                }`}
                style={{ width: `${progress.percent}%` }}
              />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Looks fine" value={review.ok} tone="text-emerald-800" />
              <Stat label="Fix suggested" value={review.fix} tone="text-zomi-red-dark" />
              <Stat label="Unsure" value={review.unsure} tone="text-amber-900" />
              <Stat label="Skipped" value={review.skipped} tone="text-zomi-muted" />
              <Stat label="Failed" value={review.failed} tone={review.failed ? "text-zomi-red-dark" : "text-zomi-muted"} />
            </div>
            {review.failed ? (
              <p className="mt-2 text-zomi-muted">
                Failed entries were not stamped. Run again with Skip to retry only those.
              </p>
            ) : null}
            {review.replaced ? (
              <p className="mt-2 text-zomi-muted">
                {review.replaced} older suggestion{review.replaced === 1 ? "" : "s"} replaced.
              </p>
            ) : null}
            {review.errors && review.errors.length > 0 && (
              <ul className="mt-2 list-disc pl-4 text-zomi-red-dark">
                {review.errors.slice(-3).map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {precheck && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="rereview-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-zomi-ink/60 p-4 backdrop-blur-sm"
          onClick={() => setPrecheck(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md overflow-hidden rounded-2xl border border-stone-300/60 bg-zomi-paper shadow-2xl"
          >
            <div className="zomi-puan h-2" aria-hidden />
            <div className="px-5 py-4">
              <h3 id="rereview-title" className="font-serif text-lg font-semibold text-zomi-ink">
                Some entries were already reviewed
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-zomi-ink">
                {Object.entries(precheck.reviewers).map(([rid, info]) => (
                  <li key={rid}>
                    <span className="font-medium">{rid}</span>: {info.already_reviewed} of{" "}
                    {info.candidates} entr{info.candidates === 1 ? "y" : "ies"} already
                    {info.already_reviewed === 1 ? " has" : " have"} its suggestion.
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-zomi-muted">
                What should happen to those entries?
              </p>
              <div className="mt-3 grid gap-2">
                <button
                  type="button"
                  onClick={() => launch("skip")}
                  className="rounded-xl border border-stone-300/60 bg-white px-4 py-2.5 text-left text-sm transition hover:border-zomi-red/40"
                >
                  <span className="block font-semibold text-zomi-ink">Skip them</span>
                  <span className="block text-xs text-zomi-muted">
                    Only review entries this model has not seen yet.
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => launch("keep")}
                  className="rounded-xl border border-stone-300/60 bg-white px-4 py-2.5 text-left text-sm transition hover:border-zomi-red/40"
                >
                  <span className="block font-semibold text-zomi-ink">Keep both, add the new one as v2</span>
                  <span className="block text-xs text-zomi-muted">
                    The earlier suggestion stays, the fresh one is labelled v2, v3 and so on.
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => launch("replace")}
                  className="rounded-xl border border-zomi-red/30 bg-zomi-red/5 px-4 py-2.5 text-left text-sm transition hover:border-zomi-red/60"
                >
                  <span className="block font-semibold text-zomi-red-dark">Replace the old suggestions</span>
                  <span className="block text-xs text-zomi-muted">
                    Deletes this model's earlier suggestions for those entries, including any you
                    marked for training, and reviews them again.
                  </span>
                </button>
              </div>
              <button
                type="button"
                onClick={() => setPrecheck(null)}
                className="mt-3 text-xs text-zomi-muted hover:text-zomi-red hover:underline"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | undefined; tone: string }) {
  return (
    <div className="rounded-lg bg-white/70 px-2.5 py-1.5">
      <p className="text-[11px] text-zomi-muted">{label}</p>
      <p className={`font-serif text-lg font-bold tabular-nums ${tone}`}>{formatNumber(value)}</p>
    </div>
  );
}
