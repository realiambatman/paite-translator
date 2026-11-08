import { useState } from "react";
import type { LangCode } from "../services/api";
import { saveFeedback } from "../services/corrections";

export interface LastResult {
  srcText: string;
  srcLang: LangCode;
  tgtLang: LangCode;
  translation: string;
  route: string | null;
  pivotEnglish: string | null;
  translationId: string | null;
}

interface Props {
  result: LastResult;
  outputText: string;
  alternatives: string[];
  tgtLabel: string;
  onPickAlternative: (alt: string) => void;
}

type Mode = "idle" | "correcting" | "sent-up" | "sent-fix" | "sent-pick";

export function FeedbackPanel({
  result,
  outputText,
  alternatives,
  tgtLabel,
  onPickAlternative,
}: Props) {
  const [mode, setMode] = useState<Mode>("idle");
  const [draft, setDraft] = useState(outputText);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);

  const base = {
    translationId: result.translationId,
    srcLang: result.srcLang,
    tgtLang: result.tgtLang,
    srcText: result.srcText,
    modelText: result.translation,
    route: result.route,
    pivotEnglish: result.pivotEnglish,
  };

  const thumbsUp = async () => {
    setSending(true);
    await saveFeedback({ ...base, rating: "up" });
    setSending(false);
    setMode("sent-up");
  };

  const startCorrection = () => {
    setDraft(outputText);
    setMode("correcting");
  };

  const sendCorrection = async () => {
    const corrected = draft.trim();
    setSending(true);
    await saveFeedback({
      ...base,
      rating: "down",
      correctedText: corrected && corrected !== result.translation.trim() ? corrected : null,
      comment,
    });
    setSending(false);
    setMode("sent-fix");
  };

  const pick = async (alt: string) => {
    onPickAlternative(alt);
    setMode("sent-pick");
    void saveFeedback({
      ...base,
      correctedText: alt,
      comment: "Chosen from suggested alternatives",
    });
  };

  const visibleAlternatives = alternatives.filter(
    (alt) => alt.trim().toLowerCase() !== outputText.trim().toLowerCase(),
  );

  return (
    <div className="border-t border-stone-300/30 px-4 py-3 text-xs">
      {visibleAlternatives.length > 0 && mode !== "correcting" && (
        <div className="mb-3">
          <p className="mb-1.5 text-zomi-muted">
            Other suggestions
          </p>
          <div className="flex flex-wrap gap-1.5">
            {visibleAlternatives.map((alt) => (
              <button
                key={alt}
                type="button"
                onClick={() => pick(alt)}
                className="max-w-full rounded-lg border border-stone-300/60 bg-zomi-cream px-2.5 py-1.5 text-left font-serif text-sm text-zomi-ink transition hover:border-zomi-red/30 hover:bg-white"
              >
                {alt}
              </button>
            ))}
          </div>
        </div>
      )}

      {mode === "idle" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-zomi-muted">Was this {tgtLabel} translation right?</span>
          <button
            type="button"
            onClick={thumbsUp}
            disabled={sending}
            className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1 text-zomi-ink transition hover:border-emerald-400/60 hover:bg-white disabled:opacity-60"
          >
            👍 Yes
          </button>
          <button
            type="button"
            onClick={startCorrection}
            disabled={sending}
            className="rounded-full border border-stone-300/60 bg-zomi-cream px-3 py-1 text-zomi-ink transition hover:border-zomi-red/40 hover:bg-white disabled:opacity-60"
          >
            👎 Suggest a fix
          </button>
        </div>
      )}

      {mode === "correcting" && (
        <div className="space-y-2">
          <p className="text-zomi-muted">
            Edit the {tgtLabel} text so it reads the way a speaker would say it.
            Your fix goes to review and helps retrain the model.
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={4}
            className="w-full resize-y rounded-xl border border-stone-300/60 bg-white px-3 py-2 font-serif text-sm leading-relaxed text-zomi-ink outline-none transition focus:border-zomi-red/40 focus:ring-2 focus:ring-zomi-red/10"
          />
          <input
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional note (what was wrong?)"
            maxLength={500}
            className="w-full rounded-full border border-stone-300/60 bg-white px-3 py-1.5 text-xs text-zomi-ink outline-none transition focus:border-zomi-red/40"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={sendCorrection}
              disabled={sending}
              className="rounded-full bg-zomi-red px-4 py-1.5 font-semibold text-white transition hover:bg-zomi-red-dark disabled:bg-stone-300"
            >
              {sending ? "Sending…" : "Send correction"}
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              disabled={sending}
              className="rounded-full border border-stone-300/60 bg-zomi-cream px-4 py-1.5 text-zomi-ink transition hover:bg-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "sent-up" && (
        <p className="text-emerald-800">Thanks! Marked as a good translation.</p>
      )}
      {mode === "sent-fix" && (
        <p className="text-emerald-800">
          Thank you. Your correction was saved for review.
        </p>
      )}
      {mode === "sent-pick" && (
        <p className="text-emerald-800">Switched to that suggestion and noted your choice.</p>
      )}
    </div>
  );
}
