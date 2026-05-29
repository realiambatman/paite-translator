interface StreamProgressProps {
  current: number;
  total: number;
  isActive: boolean;
}

export default function StreamProgress({
  current,
  total,
  isActive,
}: StreamProgressProps) {
  if (!isActive) return null;

  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const label =
    total > 0
      ? `Translating sentence ${current} of ${total}…`
      : "Starting translation…";

  return (
    <div className="border-b border-indigo-100 bg-indigo-50/60 px-4 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs font-medium text-indigo-700">
        <span className="flex items-center gap-2">
          <span
            className="stream-spinner inline-block h-3.5 w-3.5 rounded-full border-2 border-indigo-200 border-t-indigo-600"
            aria-hidden
          />
          {label}
        </span>
        {total > 0 && <span>{percent}%</span>}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-indigo-100">
        {total > 0 ? (
          <div
            className="h-full rounded-full bg-indigo-500 transition-all duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="stream-shimmer-bar h-full w-full rounded-full" />
        )}
      </div>
    </div>
  );
}
