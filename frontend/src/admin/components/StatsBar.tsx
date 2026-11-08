import type { AdminStats } from "../api";
import { formatNumber } from "../format";

interface Props {
  stats: AdminStats | null;
  loading: boolean;
}

export function StatsBar({ stats, loading }: Props) {
  const tiles: { label: string; value: number | null | undefined }[] = [
    { label: "Total", value: stats?.total },
    { label: "Today", value: stats?.today },
    { label: "Last 7 days", value: stats?.last_7_days },
    { label: "Last 30 days", value: stats?.last_30_days },
    { label: "File uploads", value: stats?.by_source.upload },
    { label: "Camera photos", value: stats?.by_source.camera },
    { label: "Fixes to review", value: stats?.corrections?.pending },
    { label: "Fixes accepted", value: stats?.corrections?.accepted },
  ];
  const thumbs = stats?.corrections;

  return (
    <div className="grid grid-cols-3 divide-x divide-stone-300/40 overflow-hidden rounded-2xl border border-stone-300/60 bg-zomi-paper sm:grid-cols-5 lg:grid-cols-9">
      {tiles.map((tile) => (
        <div key={tile.label} className="px-3 py-2.5">
          <p className="text-[11px] leading-tight text-zomi-muted">
            {tile.label}
          </p>
          <p className="mt-0.5 font-serif text-2xl font-semibold tabular-nums text-zomi-ink">
            {loading && !stats ? (
              <span className="inline-block h-6 w-12 animate-pulse rounded bg-stone-300/40" />
            ) : (
              formatNumber(tile.value)
            )}
          </p>
        </div>
      ))}
      <div className="px-3 py-2.5">
        <p className="text-[11px] leading-tight text-zomi-muted">
          Ratings
        </p>
        <p className="mt-0.5 font-serif text-2xl font-semibold tabular-nums text-zomi-ink">
          <span className="text-emerald-700">👍 {formatNumber(thumbs?.thumbs_up)}</span>{" "}
          <span className="text-zomi-red-dark">👎 {formatNumber(thumbs?.thumbs_down)}</span>
        </p>
      </div>
    </div>
  );
}
