import { useState } from "react";
import type { ExportFormat } from "../api";

interface Props {
  label: string;
  disabled?: boolean;
  onExport: (format: ExportFormat) => Promise<void>;
  primary?: boolean;
  title?: string;
  compact?: boolean;
}

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: "csv", label: "CSV", hint: "For spreadsheets" },
  { id: "json", label: "JSON", hint: "One array of records" },
  { id: "jsonl", label: "JSONL", hint: "One record per line, for training scripts" },
];

/** Button that opens a small menu to pick the export file format. */
export function ExportMenu({ label, disabled, onExport, primary, title, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);

  const run = async (format: ExportFormat) => {
    setBusy(format);
    try {
      await onExport(format);
    } finally {
      setBusy(null);
      setOpen(false);
    }
  };

  const base = primary
    ? "rounded-full bg-zomi-red font-semibold text-white transition hover:bg-zomi-red-dark disabled:bg-stone-300"
    : compact
      ? "rounded-full text-zomi-muted transition hover:bg-white hover:text-zomi-ink disabled:opacity-60"
      : "rounded-full border border-stone-300/60 bg-zomi-cream text-zomi-ink transition hover:bg-white disabled:opacity-60";
  const size = compact ? "px-3 py-1 text-sm" : "px-4 py-1.5 text-xs";

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        disabled={disabled || busy !== null}
        onClick={() => setOpen((v) => !v)}
        title={title}
        className={`${base} ${size}`}
      >
        {busy ? `Exporting ${busy.toUpperCase()}…` : label}
      </button>
      {open && (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <span className="absolute right-0 top-full z-20 mt-1 w-60 overflow-hidden rounded-xl border border-stone-300/60 bg-white shadow-lg">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => run(f.id)}
                className="block w-full px-3 py-2 text-left text-xs text-zomi-ink hover:bg-zomi-cream"
              >
                <span className="font-semibold">{f.label}</span>
                <span className="block text-[11px] text-zomi-muted">{f.hint}</span>
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  );
}
