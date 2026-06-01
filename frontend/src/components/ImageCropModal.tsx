import { useEffect, useRef, useState } from "react";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import "react-image-crop/dist/ReactCrop.css";
import { cropImageToFile } from "../utils/cropImage";

interface ImageCropModalProps {
  open: boolean;
  file: File | null;
  onClose: () => void;
  onConfirm: (file: File) => void;
}

function defaultCrop(): Crop {
  return { unit: "%", x: 4, y: 28, width: 92, height: 36 };
}

export function ImageCropModal({
  open,
  file,
  onClose,
  onConfirm,
}: ImageCropModalProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>(defaultCrop());
  const [pixelCrop, setPixelCrop] = useState<PixelCrop | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !file) {
      setImageUrl(null);
      setCrop(defaultCrop());
      setPixelCrop(null);
      return;
    }

    const url = URL.createObjectURL(file);
    setImageUrl(url);
    setCrop(defaultCrop());
    setPixelCrop(null);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [open, file]);

  const handleUseFullImage = () => {
    if (!file) return;
    onConfirm(file);
    onClose();
  };

  const handleExtractCrop = async () => {
    const image = imageRef.current;
    if (!file || !image || !pixelCrop || pixelCrop.width < 8 || pixelCrop.height < 8) {
      return;
    }

    setBusy(true);
    try {
      const cropped = await cropImageToFile(
        image,
        pixelCrop,
        file.name.replace(/\.[^.]+$/, "") + "-crop.jpg",
      );
      onConfirm(cropped);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open || !file || !imageUrl) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/70 p-4">
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-stone-300/50 bg-zomi-paper shadow-2xl">
        <div className="border-b border-stone-300/40 px-4 py-3">
          <h2 className="font-serif text-lg font-semibold text-zomi-ink">
            Crop image
          </h2>
          <p className="mt-1 text-sm text-zomi-muted">
            Drag the box to the text you want. We extract text only — click
            Translate when you are ready.
          </p>
        </div>

        <div className="max-h-[60vh] overflow-auto bg-stone-900 p-3">
          <ReactCrop
            crop={crop}
            onChange={(next) => setCrop(next)}
            onComplete={(next) => setPixelCrop(next)}
            className="mx-auto max-w-full"
          >
            <img
              ref={imageRef}
              src={imageUrl}
              alt="Crop preview"
              className="max-h-[55vh] w-full object-contain"
            />
          </ReactCrop>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-stone-300/40 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-300/60 bg-zomi-cream px-4 py-1.5 text-sm text-zomi-ink transition hover:bg-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleUseFullImage}
            className="rounded-full border border-stone-300/60 bg-zomi-cream px-4 py-1.5 text-sm text-zomi-ink transition hover:bg-white"
          >
            Use full image
          </button>
          <button
            type="button"
            onClick={() => void handleExtractCrop()}
            disabled={busy || !pixelCrop}
            className="rounded-full bg-zomi-red px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-zomi-red-dark disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            {busy ? "Extracting…" : "Extract text from crop"}
          </button>
        </div>
      </div>
    </div>
  );
}
