import { useCallback, useEffect, useMemo, useState } from "react";
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

type GroupFilter = "all" | "undecided" | "accepted" | "people" | "ai";

interface Group {
  key: string;
  translationId: string | null;
  srcLang: string | null;
  tgtLang: string | null;
  srcText: string;
  modelText: string;
  pivotEnglish: string | null;
  newest: Date | null;
  people: AdminCorrection[];
  ai: AdminCorrection[];
  thumbsUp: number;
  thumbsDown: number;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900",
  accepted: "bg-emerald-100 text-emerald-800",
  rejected: "bg-stone-200 text-stone-600",
};

function groupCorrections(items: AdminCorrection[]): Group[] {
  const groups = new Map<string, Group>();
  for (const item of items) {
    const key =
      item.translation_id ??
      `${item.src_lang ?? ""}|${item.tgt_lang ?? ""}|${item.src_text}|${item.model_text}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        translationId: item.translation_id,
        srcLang: item.src_lang,
        tgtLang: item.tgt_lang,
        srcText: item.src_text,
        modelText: item.model_text,
        pivotEnglish: item.pivot_english,
        newest: null,
        people: [],
        ai: [],
        thumbsUp: 0,
        thumbsDown: 0,
      };
      groups.set(key, group);
    }
    const date = parseDate(item.created_at);
    if (date && (!group.newest || date > group.newest)) group.newest = date;
    if (item.rating === "up") group.thumbsUp += 1;
    if (item.rating === "down") group.thumbsDown += 1;
    if (item.kind === "correction") {
      (item.origin === "llm" ? group.ai : group.people).push(item);
    }
  }
  const list = [...groups.values()];
  for (const group of list) {
    const byNewest = (a: AdminCorrection, b: AdminCorrection) =>
      (b.created_at ?? "").localeCompare(a.created_at ?? "");
    group.people.sort(byNewest);
    group.ai.sort(byNewest);
  }
  list.sort((a, b) => (b.newest?.getTime() ?? 0) - (a.newest?.getTime() ?? 0));
  return list;
}

export function CorrectionsTab({ token, langLabel, onAuthError, onChanged }: Props) {
  const [items, setItems] = useState<AdminCorrection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<GroupFilter>("all");
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchCorrections(token, { status: "all", kind: "all" });
      setItems(page.items);
    } catch (err) {
      if (!onAuthError(err)) {
        setError(err instanceof Error ? err.message : "Could not load suggestions.");
      }
    } finally {
      setLoading(false);
    }
  }, [token, onAuthError]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupCorrections(items), [items]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((group) => {
      const all = [...group.people, ...group.ai];
      if (filter === "undecided" && !all.some((c) => c.status === "pending")) return false;
      if (filter === "accepted" && !all.some((c) => c.status === "accepted")) return false;
      if (filter === "people" && group.people.length === 0 && group.thumbsUp + group.thumbsDown === 0) {
        return false;
      }
      if (filter === "ai" && group.ai.length === 0) return false;
      if (q) {
        const hay = [
          group.srcText,
          group.modelText,
          ...all.map((c) => `${c.corrected_text ?? ""} ${c.comment ?? ""} ${c.reviewer ?? ""}`),
        ]
          .join("\n")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [groups, filter, query]);

  const setStatus = async (item: AdminCorrection, next: CorrectionStatus) => {
    setBusyId(item.id);
    try {
      const draft = drafts[item.id];
      const updated = await reviewCorrection(
        token,
        item.id,
        next,
        draft !== undefined && draft !== (item.corrected_text ?? "") ? draft : undefined,
      );
      setItems((prev) => prev.map((c) => (c.id === item.id ? updated : c)));
      setDrafts((prev) => {
        const { [item.id]: _dropped, ...rest } = prev;
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
    if (!window.confirm("Delete this suggestion permanently? This cannot be undone.")) return;
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

  const totals = useMemo(() => {
    const corrections = items.filter((c) => c.kind === "correction");
    return {
      pending: corrections.filter((c) => c.status === "pending").length,
      accepted: corrections.filter((c) => c.status === "accepted").length,
    };
  }, [items]);

  const renderSuggestion = (item: AdminCorrection) => {
    const draft = drafts[item.id] ?? item.corrected_text ?? "";
    const busy = busyId === item.id;
    const edited = drafts[item.id] !== undefined && drafts[item.id] !== (item.corrected_text ?? "");
    const date = parseDate(item.created_at);
    return (
      <div
        key={item.id}
        className={`rounded-xl border px-3 py-2.5 ${
          item.status === "accepted"
            ? "border-emerald-200 bg-emerald-50/50"
            : item.status === "rejected"
              ? "border-stone-200 bg-stone-100/60"
              : "border-stone-300/50 bg-white/70"
        }`}
      >
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
          {item.origin === "llm" ? (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 font-medium text-violet-800">
              {item.reviewer ?? "AI"}
              {item.version > 1 ? ` · v${item.version}` : ""}
              {item.confidence != null ? ` · ${Math.round(item.confidence * 100)}% sure` : ""}
            </span>
          ) : (
            <span className="rounded-full bg-zomi-gold/15 px-2 py-0.5 font-medium text-zomi-gold">
              Visitor{item.rating === "down" ? " · 👎" : ""}
            </span>
          )}
          <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[item.status] ?? STATUS_STYLES.pending}`}>
            {item.status === "pending"
              ? "Not decided"
              : item.status === "accepted"
                ? "Will train"
                : "Won't train"}
          </span>
          <span className="ml-auto text-zomi-muted" title={formatFull(date)}>
            {timeAgo(date)}
          </span>
        </div>

        {item.status === "rejected" ? (
          <p className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-stone-500 line-through">
            {item.corrected_text}
          </p>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDrafts((prev) => ({ ...prev, [item.id]: e.target.value }))}
            rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 60)))}
            className="w-full resize-y rounded-lg border border-transparent bg-transparent px-1 py-0.5 font-serif text-sm leading-relaxed text-zomi-ink outline-none transition hover:border-stone-300/60 focus:border-emerald-400 focus:bg-white"
          />
        )}
        {item.comment && (
          <p className="mt-1 text-[11px] leading-snug text-zomi-muted">{item.comment}</p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          {item.status !== "accepted" && (
            <button
              type="button"
              disabled={busy || !draft.trim()}
              onClick={() => setStatus(item, "accepted")}
              className="rounded-full bg-emerald-600 px-3 py-1 font-semibold text-white transition hover:bg-emerald-700 disabled:bg-stone-300"
            >
              {edited ? "Use edited for training" : "Use for training"}
            </button>
          )}
          {item.status === "accepted" && edited && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setStatus(item, "accepted")}
              className="rounded-full bg-emerald-600 px-3 py-1 font-semibold text-white transition hover:bg-emerald-700 disabled:bg-stone-300"
            >
              Save edit
            </button>
          )}
          {item.status !== "rejected" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setStatus(item, "rejected")}
              className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1 text-zomi-ink transition hover:bg-white disabled:opacity-60"
            >
              Don't use
            </button>
          )}
          {item.status !== "pending" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setStatus(item, "pending")}
              className="text-zomi-muted hover:text-zomi-red hover:underline disabled:opacity-60"
            >
              Undo decision
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
      </div>
    );
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-300/40 px-4 py-3 text-sm">
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as GroupFilter)}
          className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-zomi-ink outline-none hover:border-zomi-red/30"
        >
          <option value="all">All suggestions</option>
          <option value="undecided">With undecided suggestions</option>
          <option value="accepted">With accepted suggestions</option>
          <option value="people">From visitors</option>
          <option value="ai">From AI review</option>
        </select>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search source, output, or suggestion…"
          className="min-w-[200px] flex-1 rounded-full border border-stone-300/60 bg-white px-4 py-1.5 text-zomi-ink outline-none transition focus:border-zomi-red/40"
        />
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-zomi-ink transition hover:bg-white disabled:opacity-60"
        >
          Refresh
        </button>
        <span className="text-xs text-zomi-muted">
          {visible.length} translation{visible.length === 1 ? "" : "s"} · {totals.pending} undecided ·{" "}
          {totals.accepted} for training
        </span>
        <button
          type="button"
          onClick={exportCsv}
          disabled={exporting || totals.accepted === 0}
          title="Suggestions marked 'Use for training', as source/target pairs"
          className="rounded-full bg-zomi-red px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-zomi-red-dark disabled:bg-stone-300"
        >
          {exporting ? "Exporting…" : "Export training CSV"}
        </button>
      </div>

      <p className="border-b border-stone-300/40 bg-white/40 px-4 py-2 text-xs text-zomi-muted">
        Each card is one translation. Suggestions from visitors and from each AI model sit
        side by side and stay here whatever you decide. Marking one “Use for training” only
        affects the export; the live translation is never changed.
      </p>

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

      {!loading && visible.length === 0 && !error && (
        <p className="px-4 py-10 text-center text-sm text-zomi-muted">
          {items.length === 0
            ? "No suggestions yet. Visitors' fixes and AI review results will appear here."
            : "Nothing matches this filter."}
        </p>
      )}

      {visible.map((group) => (
        <article key={group.key} className="border-b border-stone-300/30 px-4 py-4 last:border-b-0">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium text-zomi-ink">
              {langLabel(group.srcLang)} → <span className="text-zomi-red-dark">{langLabel(group.tgtLang)}</span>
            </span>
            {group.thumbsUp + group.thumbsDown > 0 && (
              <span className="rounded-full bg-white px-2 py-0.5 text-zomi-ink">
                👍 {group.thumbsUp} · 👎 {group.thumbsDown}
              </span>
            )}
            <span className="text-zomi-muted">
              {group.people.length} from visitors · {group.ai.length} from AI
            </span>
            {group.translationId && (
              <code className="ml-auto rounded bg-white/70 px-1 text-[10px] text-zomi-muted">
                {group.translationId}
              </code>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1.6fr]">
            <div>
              <p className="mb-1 text-[11px] text-zomi-muted">Source</p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-zomi-ink">{group.srcText}</p>
              {group.pivotEnglish && (
                <p className="mt-2 text-[11px] leading-snug text-zomi-muted">
                  via English: <span className="text-zomi-ink/80">{group.pivotEnglish}</span>
                </p>
              )}
            </div>
            <div>
              <p className="mb-1 text-[11px] text-zomi-muted">Model output</p>
              <p className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-zomi-ink">
                {group.modelText}
              </p>
            </div>
            <div className="space-y-3">
              {group.people.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] text-zomi-gold">From visitors</p>
                  <div className="space-y-2">{group.people.map(renderSuggestion)}</div>
                </div>
              )}
              {group.ai.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] text-violet-800">From AI review</p>
                  <div className="space-y-2">{group.ai.map(renderSuggestion)}</div>
                </div>
              )}
              {group.people.length === 0 && group.ai.length === 0 && (
                <p className="text-xs text-zomi-muted">Ratings only, no text suggested.</p>
              )}
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
