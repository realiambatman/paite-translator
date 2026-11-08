import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "../../services/api";
import {
  cancelReview,
  fetchLlmSettings,
  fetchReviewStatus,
  startReview,
  testLlm,
  updateLlmSettings,
  type LlmSettings,
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
  const [skipReviewed, setSkipReviewed] = useState(true);
  const [tgtLang, setTgtLang] = useState<string>("");
  const [review, setReview] = useState<ReviewStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<number | null>(null);

  const applySettings = useCallback((next: LlmSettings) => {
    setSettings(next);
    const active = next.provider ?? "anthropic";
    setProvider(active);
    setModel(next.model ?? next.providers[active]?.default_model ?? "");
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

  const run = async () => {
    setStarting(true);
    setError(null);
    try {
      setReview(await startReview(token, { limit, skip_reviewed: skipReviewed, tgt_lang: tgtLang || null }));
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Could not start review.");
    } finally {
      setStarting(false);
    }
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
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
            Model
            <input
              list="llm-models"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={providerMeta?.default_model}
              className={`mt-1 block w-full ${inputClass}`}
            />
            <datalist id="llm-models">
              {providerMeta?.models.map((m) => <option key={m} value={m} />)}
            </datalist>
          </label>
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
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

        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
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
          <label className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">
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
          <label className="inline-flex items-center gap-2 pb-2 text-xs text-zomi-ink">
            <input
              type="checkbox"
              checked={skipReviewed}
              onChange={(e) => setSkipReviewed(e.target.checked)}
              className="accent-zomi-red"
            />
            Skip already-reviewed entries
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
              disabled={starting || !settings?.available}
              title={settings?.available ? "" : "Save a working API key first"}
              className="rounded-full bg-zomi-red px-4 py-2 text-xs font-semibold text-white transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {starting ? "Starting…" : `Review last ${limit}`}
            </button>
          )}
        </div>

        {review && review.status !== "idle" && (
          <div className="mt-4 rounded-xl border border-stone-300/50 bg-zomi-cream/70 px-3 py-3 text-xs">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold uppercase tracking-wider text-zomi-muted">
                {review.status === "running" ? "Reviewing…" : `Review ${review.status}`}
                {review.provider ? ` · ${review.provider}/${review.model}` : ""}
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
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | undefined; tone: string }) {
  return (
    <div className="rounded-lg bg-white/70 px-2.5 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">{label}</p>
      <p className={`font-serif text-lg font-bold tabular-nums ${tone}`}>{formatNumber(value)}</p>
    </div>
  );
}
