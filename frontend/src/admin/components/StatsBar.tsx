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
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-1 text-sm">
      {tiles.map((tile) => (
        <div key={tile.label} className="flex items-baseline gap-1.5">
          <p className="font-serif text-lg font-semibold tabular-nums text-zomi-ink">
            {loading && !stats ? (
              <span className="inline-block h-4 w-8 animate-pulse rounded bg-stone-300/40 align-middle" />
            ) : (
              formatNumber(tile.value)
            )}
          </p>
          <p className="text-xs text-zomi-muted">{tile.label.toLowerCase()}</p>
        </div>
      ))}
      <div className="flex items-baseline gap-1.5">
        <p className="font-serif text-lg font-semibold tabular-nums">
          <span className="text-emerald-700">👍 {formatNumber(thumbs?.thumbs_up)}</span>{" "}
          <span className="text-zomi-red-dark">👎 {formatNumber(thumbs?.thumbs_down)}</span>
        </p>
      </div>
    </div>
  );
}
