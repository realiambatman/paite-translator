import { useCallback, useEffect, useState } from "react";
import {
  deleteCorrection,
  downloadCorrectionsCsv,
  fetchCorrections,
  reviewCorrection,
  type AdminCorrection,
  type CorrectionStatus,
} from "../api";
import { formatFull, parseDate, timeAgo } from "../format";

interface Props {
  token: string;
  langLabel: (code: string | null) => string;
  onAuthError: (err: unknown) => boolean;
  onChanged: () => void;
}

type StatusFilter = CorrectionStatus | "all";
type KindFilter = "all" | "correction" | "rating";

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900",
  accepted: "bg-emerald-100 text-emerald-800",
  rejected: "bg-stone-200 text-stone-600",
};

export function CorrectionsTab({ token, langLabel, onAuthError, onChanged }: Props) {
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [kind, setKind] = useState<KindFilter>("all");
  const [items, setItems] = useState<AdminCorrection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchCorrections(token, { status, kind });
      setItems(page.items);
    } catch (err) {
      if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : "Could not load corrections.");
      }
    } finally {
      setLoading(false);
    }
  }, [token, status, kind, onAuthError]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (item: AdminCorrection, next: CorrectionStatus) => {
    setBusyId(item.id);
    try {
      const edited = editing[item.id];
      const updated = await reviewCorrection(
        token,
        item.id,
        next,
        edited !== undefined && edited !== (item.corrected_text ?? "") ? edited : undefined,
      );
      setItems((prev) =>
        status === "all"
          ? prev.map((c) => (c.id === item.id ? updated : c))
          : prev.filter((c) => c.id !== item.id),
      );
      setEditing((prev) => {
        const { [item.id]: _removed, ...rest } = prev;
        return rest;
      });
      onChanged();
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: AdminCorrection) => {
    if (!window.confirm("Delete this entry permanently?")) return;
    setBusyId(item.id);
    try {
      await deleteCorrection(token, item.id);
      setItems((prev) => prev.filter((c) => c.id !== item.id));
      onChanged();
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusyId(null);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCorrectionsCsv(token, "accepted");
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-300/40 px-4 py-3 text-sm">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-zomi-ink outline-none hover:border-zomi-red/30"
        >
          <option value="pending">Pending review</option>
          <option value="accepted">Accepted</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as KindFilter)}
          className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-zomi-ink outline-none hover:border-zomi-red/30"
        >
          <option value="all">Corrections and ratings</option>
          <option value="correction">Corrections only</option>
          <option value="rating">Ratings only</option>
        </select>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-zomi-ink transition hover:bg-white disabled:opacity-60"
        >
          Refresh
        </button>
        <span className="ml-auto text-xs text-zomi-muted">
          {items.length} shown
        </span>
        <button
          type="button"
          onClick={exportCsv}
          disabled={exporting}
          title="Accepted corrections as source/target pairs for fine-tuning"
          className="rounded-full bg-zomi-red px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-zomi-red-dark disabled:bg-stone-300"
        >
          {exporting ? "Exporting…" : "Export training CSV"}
        </button>
      </div>

      {error && (
        <div role="alert" className="border-b border-zomi-red/25 bg-zomi-red/5 px-4 py-3 text-sm text-zomi-red-dark">
          {error}
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-zomi-muted">
          <span className="stream-spinner inline-block h-4 w-4 rounded-full border-2 border-stone-300 border-t-zomi-red" aria-hidden />
          Loading…
        </div>
      )}

      {!loading && items.length === 0 && !error && (
        <p className="px-4 py-10 text-center text-sm text-zomi-muted">
          Nothing here. Users' thumbs and suggested fixes, plus AI review suggestions,
          will appear in this queue.
        </p>
      )}

      {items.map((item) => {
        const date = parseDate(item.created_at);
        const isCorrection = item.kind === "correction";
        const draft = editing[item.id] ?? item.corrected_text ?? "";
        const busy = busyId === item.id;
        return (
          <article key={item.id} className="border-b border-stone-300/30 px-4 py-3 last:border-b-0">
            <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider">
              <span className={`rounded-full px-2 py-0.5 ${STATUS_STYLES[item.status] ?? STATUS_STYLES.pending}`}>
                {item.status}
              </span>
              <span className={`rounded-full px-2 py-0.5 ${isCorrection ? "bg-sky-100 text-sky-800" : "bg-stone-200/70 text-stone-700"}`}>
                {isCorrection ? "Correction" : "Rating"}
              </span>
              {item.origin === "llm" ? (
                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-violet-800" title={item.reviewer ?? ""}>
                  AI · {item.reviewer ?? "llm"}
                  {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}%` : ""}
                </span>
              ) : (
                <span className="rounded-full bg-zomi-gold/15 px-2 py-0.5 text-zomi-gold">User</span>
              )}
              {item.rating && (
                <span className="rounded-full bg-white px-2 py-0.5 text-zomi-ink">
                  {item.rating === "up" ? "👍" : "👎"}
                </span>
              )}
              <span className="normal-case tracking-normal text-zomi-ink">
                {langLabel(item.src_lang)} → <span className="text-zomi-red-dark">{langLabel(item.tgt_lang)}</span>
              </span>
              <span className="ml-auto normal-case tracking-normal text-zomi-muted" title={formatFull(date)}>
                {timeAgo(date)}
              </span>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">Source</p>
                <p className="whitespace-pre-wrap text-sm text-zomi-ink">{item.src_text}</p>
                {item.pivot_english && (
                  <p className="mt-1 text-[11px] text-zomi-muted">
                    via English: <span className="text-zomi-ink/80">{item.pivot_english}</span>
                  </p>
                )}
              </div>
              <div>
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zomi-muted">Model output</p>
                <p className="whitespace-pre-wrap font-serif text-sm text-zomi-ink">{item.model_text}</p>
              </div>
              <div>
                <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800">
                  {isCorrection ? "Suggested fix" : "No text suggested"}
                </p>
                {isCorrection ? (
                  item.status === "pending" ? (
                    <textarea
                      value={draft}
                      onChange={(e) => setEditing((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      rows={3}
                      className="w-full resize-y rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2 font-serif text-sm leading-relaxed text-zomi-ink outline-none focus:border-emerald-400"
                    />
                  ) : (
                    <p className="whitespace-pre-wrap rounded-xl bg-emerald-50/60 px-3 py-2 font-serif text-sm text-zomi-ink">
                      {item.corrected_text}
                    </p>
                  )
                ) : (
                  <p className="text-xs text-zomi-muted">Rating only.</p>
                )}
                {item.comment && (
                  <p className="mt-1 text-[11px] text-zomi-muted">Note: {item.comment}</p>
                )}
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {isCorrection && item.status !== "accepted" && (
                <button
                  type="button"
                  disabled={busy || !draft.trim()}
                  onClick={() => act(item, "accepted")}
                  className="rounded-full bg-emerald-600 px-3 py-1 font-semibold text-white transition hover:bg-emerald-700 disabled:bg-stone-300"
                >
                  Accept{editing[item.id] !== undefined && editing[item.id] !== (item.corrected_text ?? "") ? " with edits" : ""}
                </button>
              )}
              {item.status !== "rejected" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(item, isCorrection ? "rejected" : "accepted")}
                  className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1 text-zomi-ink transition hover:bg-white disabled:opacity-60"
                >
                  {isCorrection ? "Reject" : "Mark seen"}
                </button>
              )}
              {item.status !== "pending" && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => act(item, "pending")}
                  className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1 text-zomi-ink transition hover:bg-white disabled:opacity-60"
                >
                  Back to pending
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(item)}
                className="ml-auto text-zomi-muted hover:text-zomi-red hover:underline disabled:opacity-60"
              >
                Delete
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
