export type SourceFilter = "all" | "text" | "upload" | "camera";

export interface Filters {
  query: string;
  source: SourceFilter;
  pair: string;
  imagesOnly: boolean;
}

interface Props {
  filters: Filters;
  pairs: { value: string; label: string; count: number }[];
  shown: number;
  loaded: number;
  onChange: (next: Filters) => void;
}

const SOURCE_OPTIONS: { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "text", label: "Typed text" },
  { value: "upload", label: "File upload" },
  { value: "camera", label: "Camera" },
];

export function FilterBar({ filters, pairs, shown, loaded, onChange }: Props) {
  const update = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const active =
    filters.query.trim() !== "" ||
    filters.source !== "all" ||
    filters.pair !== "all" ||
    filters.imagesOnly;

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-stone-300/40 px-4 py-3">
      <input
        type="search"
        value={filters.query}
        onChange={(e) => update({ query: e.target.value })}
        placeholder="Search text, translation, or filename…"
        className="min-w-[200px] flex-1 rounded-full border border-stone-300/60 bg-white px-4 py-1.5 text-sm text-zomi-ink outline-none transition focus:border-zomi-red/40 focus:ring-2 focus:ring-zomi-red/10"
      />

      <select
        value={filters.source}
        onChange={(e) => update({ source: e.target.value as SourceFilter })}
        className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm text-zomi-ink outline-none transition hover:border-zomi-red/30"
      >
        {SOURCE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <select
        value={filters.pair}
        onChange={(e) => update({ pair: e.target.value })}
        className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm text-zomi-ink outline-none transition hover:border-zomi-red/30"
      >
        <option value="all">All language pairs</option>
        {pairs.map((pair) => (
          <option key={pair.value} value={pair.value}>
            {pair.label} ({pair.count})
          </option>
        ))}
      </select>

      <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1.5 text-sm text-zomi-ink transition hover:border-zomi-red/30">
        <input
          type="checkbox"
          checked={filters.imagesOnly}
          onChange={(e) => update({ imagesOnly: e.target.checked })}
          className="accent-zomi-red"
        />
        With images
      </label>

      <span className="ml-auto text-xs tabular-nums text-zomi-muted">
        {active ? `${shown} of ${loaded} loaded` : `${loaded} loaded`}
        {active && (
          <button
            type="button"
            onClick={() =>
              onChange({ query: "", source: "all", pair: "all", imagesOnly: false })
            }
            className="ml-2 text-zomi-red hover:underline"
          >
            Clear
          </button>
        )}
      </span>
    </div>
  );
}
