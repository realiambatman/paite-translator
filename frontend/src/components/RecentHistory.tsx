import type { HistoryItem } from "../services/history";

interface Props {
  items: HistoryItem[];
  langLabel: (code: string) => string;
  disabled: boolean;
  onPick: (item: HistoryItem) => void;
  onClear: () => void;
}

function when(at: number): string {
  const diff = Date.now() - at;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return new Date(at).toLocaleDateString();
}

export function RecentHistory({ items, langLabel, disabled, onPick, onClear }: Props) {
  if (items.length === 0) return null;

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zomi-muted">
          Recent on this device
        </h2>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-zomi-muted hover:text-zomi-red hover:underline"
        >
          Clear
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {items.slice(0, 6).map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onPick(item)}
            disabled={disabled}
            className="rounded-xl border border-stone-300/50 bg-zomi-paper/60 p-3 text-left text-sm transition hover:border-zomi-red/30 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <p className="mb-1 flex items-center justify-between text-[10px] text-zomi-muted">
              <span>
                {langLabel(item.srcLang)} → {langLabel(item.tgtLang)}
              </span>
              <span>{when(item.at)}</span>
            </p>
            <p className="line-clamp-2 text-zomi-ink">{item.srcText}</p>
            <p className="mt-1 line-clamp-2 font-serif text-zomi-red-dark">{item.tgtText}</p>
          </button>
        ))}
      </div>
    </section>
  );
}
