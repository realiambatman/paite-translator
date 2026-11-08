import { useState } from "react";
import type { AdminCorrection, CorrectionStatus } from "../api";
import { formatFull, parseDate, timeAgo } from "../format";

interface Props {
  item: AdminCorrection;
  busy: boolean;
  onStatus: (item: AdminCorrection, next: CorrectionStatus, editedText?: string) => void;
  onDelete: (item: AdminCorrection) => void;
}

const STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-100 text-amber-900",
  accepted: "bg-emerald-100 text-emerald-800",
  rejected: "bg-stone-200 text-stone-600",
};

/** One suggestion (from a visitor or an AI model) with the training decision. */
export function SuggestionCard({ item, busy, onStatus, onDelete }: Props) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? item.corrected_text ?? "";
  const edited = draft !== null && draft !== (item.corrected_text ?? "");
  const date = parseDate(item.created_at);

  const decide = (next: CorrectionStatus) => {
    onStatus(item, next, edited ? text : undefined);
    setDraft(null);
  };

  return (
    <div
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
        ) : item.origin === "admin" ? (
          <span className="rounded-full bg-sky-100 px-2 py-0.5 font-medium text-sky-800">
            You
          </span>
        ) : (
          <span className="rounded-full bg-zomi-gold/15 px-2 py-0.5 font-medium text-zomi-gold">
            Visitor{item.rating === "down" ? " · 👎" : ""}
          </span>
        )}
        <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLES[item.status] ?? STATUS_STYLES.pending}`}>
          {item.status === "pending" ? "Not decided" : item.status === "accepted" ? "Will train" : "Won't train"}
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
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(6, Math.max(2, Math.ceil(text.length / 60)))}
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
            disabled={busy || !text.trim()}
            onClick={() => decide("accepted")}
            className="rounded-full bg-emerald-600 px-3 py-1 font-semibold text-white transition hover:bg-emerald-700 disabled:bg-stone-300"
          >
            {edited ? "Use edited for training" : "Use for training"}
          </button>
        )}
        {item.status === "accepted" && edited && (
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("accepted")}
            className="rounded-full bg-emerald-600 px-3 py-1 font-semibold text-white transition hover:bg-emerald-700 disabled:bg-stone-300"
          >
            Save edit
          </button>
        )}
        {item.status !== "rejected" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("rejected")}
            className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1 text-zomi-ink transition hover:bg-white disabled:opacity-60"
          >
            Don't use
          </button>
        )}
        {item.status !== "pending" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => decide("pending")}
            className="text-zomi-muted hover:text-zomi-red hover:underline disabled:opacity-60"
          >
            Undo decision
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => onDelete(item)}
          className="ml-auto text-zomi-muted hover:text-zomi-red hover:underline disabled:opacity-60"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
