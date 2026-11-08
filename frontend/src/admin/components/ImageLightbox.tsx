import { useEffect } from "react";

interface Props {
  src: string | null;
  title?: string | null;
  onClose: () => void;
}

export function ImageLightbox({ src, title, onClose }: Props) {
  useEffect(() => {
    if (!src) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title ?? "Uploaded image"}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-zomi-ink/80 p-4 backdrop-blur-sm"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-stone-200 px-4 py-2 text-sm">
          <span className="truncate text-zomi-ink">{title ?? "Uploaded image"}</span>
          <div className="flex shrink-0 items-center gap-3">
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-zomi-red hover:underline"
            >
              Open original
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-stone-300/60 px-2.5 py-0.5 text-xs text-zomi-ink hover:bg-stone-100"
            >
              Close
            </button>
          </div>
        </div>
        <img
          src={src}
          alt={title ?? "Uploaded image"}
          className="max-h-[80vh] w-auto max-w-full object-contain"
        />
      </div>
    </div>
  );
}
