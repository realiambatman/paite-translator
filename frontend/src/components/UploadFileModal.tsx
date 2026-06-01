import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { isSupportedUploadFile } from "../utils/cropImage";

interface UploadFileModalProps {
  open: boolean;
  accept: string;
  onClose: () => void;
  onFile: (file: File) => void;
}

export function UploadFileModal({
  open,
  accept,
  onClose,
  onFile,
}: UploadFileModalProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    if (!isSupportedUploadFile(file)) {
      setError("Unsupported file. Use .txt, .pdf, .docx, or an image.");
      return;
    }
    setError(null);
    onFile(file);
    onClose();
  };

  const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    handleFile(event.dataTransfer.files?.[0]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/70 p-4">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl border border-stone-300/50 bg-zomi-paper shadow-2xl">
        <div className="border-b border-stone-300/40 px-4 py-3">
          <h2 className="font-serif text-lg font-semibold text-zomi-ink">
            Upload file
          </h2>
          <p className="mt-1 text-sm text-zomi-muted">
            Drag a file here or choose one to extract text.
          </p>
        </div>

        <div className="p-4">
          <input
            ref={inputRef}
            type="file"
            accept={accept}
            onChange={handleInputChange}
            className="hidden"
          />

          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`flex min-h-[180px] flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-8 text-center transition ${
              dragging
                ? "border-zomi-red bg-zomi-red/5"
                : "border-stone-300/60 bg-zomi-cream/60"
            }`}
          >
            <p className="text-sm font-medium text-zomi-ink">
              Drop file here
            </p>
            <p className="mt-1 text-xs text-zomi-muted">
              .txt, .pdf, .docx, or image
            </p>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="mt-4 rounded-full bg-zomi-red px-5 py-1.5 text-sm font-semibold text-white transition hover:bg-zomi-red-dark"
            >
              Select file
            </button>
          </div>

          {error && (
            <p className="mt-3 text-xs text-zomi-red-dark">{error}</p>
          )}
        </div>

        <div className="flex justify-end border-t border-stone-300/40 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-300/60 bg-zomi-cream px-4 py-1.5 text-sm text-zomi-ink transition hover:bg-white"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
