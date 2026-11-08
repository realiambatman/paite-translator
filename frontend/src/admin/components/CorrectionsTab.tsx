import { useMemo, useState } from "react";
import {
  downloadCorrections,
  type AdminCorrection,
  type CorrectionStatus,
  type ExportFormat,
} from "../api";
import { parseDate } from "../format";
import { ExportMenu } from "./ExportMenu";
import { SuggestionCard } from "./SuggestionCard";

interface Props {
  token: string;
  items: AdminCorrection[];
  loading: boolean;
  busyId: string | null;
  langLabel: (code: string | null) => string;
  onReload: () => void;
  onStatus: (item: AdminCorrection, next: CorrectionStatus, editedText?: string) => void;
  onDelete: (item: AdminCorrection) => void;
  onAuthError: (err: unknown) => boolean;
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

export function groupCorrections(items: AdminCorrection[]): Group[] {
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
  const byNewest = (a: AdminCorrection, b: AdminCorrection) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? "");
  for (const group of list) {
    group.people.sort(byNewest);
    group.ai.sort(byNewest);
  }
  list.sort((a, b) => (b.newest?.getTime() ?? 0) - (a.newest?.getTime() ?? 0));
  return list;
}

export function CorrectionsTab({
  token,
  items,
  loading,
  busyId,
  langLabel,
  onReload,
  onStatus,
  onDelete,
  onAuthError,
}: Props) {
  const [filter, setFilter] = useState<GroupFilter>("all");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  const totals = useMemo(() => {
    const corrections = items.filter((c) => c.kind === "correction");
    return {
      pending: corrections.filter((c) => c.status === "pending").length,
      accepted: corrections.filter((c) => c.status === "accepted").length,
    };
  }, [items]);

  const exportTraining = async (format: ExportFormat) => {
    try {
      await downloadCorrections(token, "accepted", format);
    } catch (err) {
      if (!onAuthError(err)) setError(err instanceof Error ? err.message : "Export failed.");
    }
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
          onClick={onReload}
          disabled={loading}
          className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-zomi-ink transition hover:bg-white disabled:opacity-60"
        >
          Refresh
        </button>
        <span className="text-xs text-zomi-muted">
          {visible.length} translation{visible.length === 1 ? "" : "s"} · {totals.pending} undecided ·{" "}
          {totals.accepted} for training
        </span>
        <ExportMenu
          label="Export training data"
          primary
          disabled={totals.accepted === 0}
          title="Suggestions marked 'Use for training', as source/target pairs"
          onExport={exportTraining}
        />
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
                  <div className="space-y-2">
                    {group.people.map((c) => (
                      <SuggestionCard key={c.id} item={c} busy={busyId === c.id} onStatus={onStatus} onDelete={onDelete} />
                    ))}
                  </div>
                </div>
              )}
              {group.ai.length > 0 && (
                <div>
                  <p className="mb-1.5 text-[11px] text-violet-800">From AI review</p>
                  <div className="space-y-2">
                    {group.ai.map((c) => (
                      <SuggestionCard key={c.id} item={c} busy={busyId === c.id} onStatus={onStatus} onDelete={onDelete} />
                    ))}
                  </div>
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
