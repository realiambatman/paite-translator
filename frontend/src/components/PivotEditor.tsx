import { useState } from "react";

interface Props {
  pivot: string;
  route: string | null;
  tgtLabel: string;
  disabled: boolean;
  onRetranslate: (english: string) => void;
}

/**
 * Shows the English the server used as a bridge (for pairs routed through
 * Google) and lets the user fix it before re-running the second half.
 */
export function PivotEditor({ pivot, route, tgtLabel, disabled, onRetranslate }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(pivot);
  const changed = draft.trim() !== pivot.trim();

  const hint =
    route === "from_paite"
      ? `Paite was first turned into this English, then into ${tgtLabel}. Fix the English if the meaning is off.`
      : `Your text was first turned into this English, then into ${tgtLabel}. Fix the English if the meaning is off.`;

  return (
    <div className="border-t border-stone-300/40 bg-zomi-paper/60 px-4 py-2 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 text-left text-zomi-muted"
      >
        <span>
          <span className="font-semibold uppercase tracking-wider">Via English</span>
          {!open && (
            <span className="ml-2 line-clamp-1 inline text-zomi-ink/80">{pivot}</span>
          )}
        </span>
        <span className="shrink-0 text-zomi-red">{open ? "Hide" : "Edit"}</span>
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-zomi-muted">{hint}</p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            disabled={disabled}
            className="w-full resize-y rounded-xl border border-stone-300/60 bg-white px-3 py-2 text-sm leading-relaxed text-zomi-ink outline-none transition focus:border-zomi-red/40 focus:ring-2 focus:ring-zomi-red/10 disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onRetranslate(draft.trim())}
              disabled={disabled || !draft.trim()}
              className="rounded-full bg-zomi-red px-4 py-1.5 font-semibold text-white transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {changed ? `Re-translate to ${tgtLabel}` : `Translate again to ${tgtLabel}`}
            </button>
            {changed && (
              <button
                type="button"
                onClick={() => setDraft(pivot)}
                className="text-zomi-muted hover:text-zomi-red hover:underline"
              >
                Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
