import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "../../services/api";
import {
  cancelReview,
  fetchLlmSettings,
  fetchReviewStatus,
  precheckReview,
  startReview,
  testLlm,
  updateLlmSettings,
  type LlmSettings,
  type OnExisting,
  type ReviewPrecheck,
  type ReviewStatus,
} from "../api";
import { formatNumber } from "../format";

interface Props {
  token: string;
  languages: Language[];
  onAuthError: (err: unknown) => boolean;
  onChanged: () => void;
}

export function AiReviewTab({ token, languages, onAuthError, onChanged }: Props) {
  const [settings, setSettings] = useState<LlmSettings | null>(null);
  const [provider, setProvider] = useState<string>("anthropic");
  const [model, setModel] = useState<string>("");
  const [keyDraft, setKeyDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [limit, setLimit] = useState(50);
  const [tgtLang, setTgtLang] = useState<string>("");
  const [review, setReview] = useState<ReviewStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [precheck, setPrecheck] = useState<ReviewPrecheck | null>(null);
  const pollRef = useRef<number | null>(null);

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
    fetchReviewStatus(token).then(setReview).catch(() => undefined);
  }, [token, applySettings, onAuthError]);

  // Poll while a review runs.
  useEffect(() => {
    if (review?.status !== "running") {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    if (pollRef.current) return;
    pollRef.current = window.setInterval(() => {
      fetchReviewStatus(token)
        .then((next) => {
          setReview(next);
          if (next.status !== "running") onChanged();
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [review?.status, token, onChanged]);

  const changeProvider = (next: string) => {
    setProvider(next);
    setKeyDraft("");
    setTestResult(null);
    if (settings) {
      setModel(
        settings.provider === next && settings.model
          ? settings.model
          : (settings.providers[next]?.default_model ?? ""),
      );
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
  const progress =
    review && review.limit ? Math.min(100, Math.round(((review.reviewed ?? 0) / review.limit) * 100)) : 0;

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
            <input
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              autoComplete="off"
              placeholder={keyInfo?.configured ? `saved ${keyInfo.hint ?? ""}` : "paste key"}
              className={`mt-1 block w-full ${inputClass}`}
            />
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
              max={1000}
              value={limit}
              onChange={(e) => setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
              className={`mt-1 block w-28 ${inputClass}`}
            />
          </label>
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
                : `Review last ${limit}${reviewers.length > 1 ? ` with ${reviewers.length} models` : ""}`}
            </button>
          )}
        </div>

        {review && review.status !== "idle" && (
          <div className="mt-4 rounded-xl border border-stone-300/50 bg-zomi-cream/70 px-3 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-zomi-muted">
                {review.status === "running" ? "Reviewing…" : `Review ${review.status}`}
                {review.current_reviewer
                  ? ` · ${review.current_reviewer}`
                  : review.provider
                    ? ` · ${review.provider}/${review.model}`
                    : ""}
                {review.reviewers && review.reviewers.length > 1
                  ? ` (${review.reviewers.indexOf(review.current_reviewer ?? "") + 1} of ${review.reviewers.length})`
                  : ""}
              </span>
              <span className="tabular-nums text-zomi-muted">
                {formatNumber(review.reviewed)} / {formatNumber(review.limit)}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-200/80">
              <div
                className="h-full rounded-full bg-zomi-red transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Looks fine" value={review.ok} tone="text-emerald-800" />
              <Stat label="Fix suggested" value={review.fix} tone="text-zomi-red-dark" />
              <Stat label="Unsure" value={review.unsure} tone="text-amber-900" />
              <Stat label="Skipped" value={review.skipped} tone="text-zomi-muted" />
            </div>
            {review.replaced ? (
              <p className="mt-2 text-zomi-muted">
                {review.replaced} older suggestion{review.replaced === 1 ? "" : "s"} replaced.
              </p>
            ) : null}
            {review.errors && review.errors.length > 0 && (
              <ul className="mt-2 list-disc pl-4 text-zomi-red-dark">
                {review.errors.slice(-5).map((e, i) => (
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
