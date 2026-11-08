import { useState } from "react";
import type { AdminTranslation, OnExisting, ReviewOneResult } from "../api";
import { formatFull, formatTime, parseDate, timeAgo } from "../format";

interface Props {
  item: AdminTranslation;
  langLabel: (code: string | null) => string;
  onOpenImage: (src: string, title: string | null) => void;
  /** "provider/model" ids with a saved key; empty hides the AI review button. */
  reviewers: string[];
  onReview: (
    item: AdminTranslation,
    reviewer: string,
    onExisting: OnExisting,
  ) => Promise<ReviewOneResult>;
}

const SOURCE_STYLES: Record<string, string> = {
  camera: "bg-zomi-gold/15 text-zomi-gold",
  upload: "bg-sky-100 text-sky-800",
  text: "bg-stone-200/70 text-stone-700",
};

const SOURCE_LABELS: Record<string, string> = {
  camera: "Camera",
  upload: "File upload",
  text: "Typed",
};

const ROUTE_LABELS: Record<string, string> = {
  hf: "Paite model",
  google: "Google",
  to_paite: "Google → Paite",
  from_paite: "Paite → Google",
  identity: "Same language",
};

function Badge({ className, children }: { className: string; children: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${className}`}
    >
      {children}
    </span>
  );
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard blocked — nothing to do.
  }
}

export function TranslationCard({ item, langLabel, onOpenImage, reviewers, onReview }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewer, setReviewer] = useState<string>(reviewers[0] ?? "");
  const [reviewing, setReviewing] = useState(false);
  const [reviewResult, setReviewResult] = useState<ReviewOneResult | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  const chosen = reviewer || reviewers[0] || "";
  const alreadyBy = item.llm_reviews?.find((r) => r.reviewer === chosen) ?? null;

  const runReview = async (onExisting: OnExisting) => {
    if (!chosen) return;
    setReviewing(true);
    setReviewError(null);
    setReviewResult(null);
    try {
      setReviewResult(await onReview(item, chosen, onExisting));
      setReviewOpen(false);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : "Review failed.");
    } finally {
      setReviewing(false);
    }
  };
  const date = parseDate(item.created_at);
  const source = item.source ?? "text";
  const hasImage = item.is_image && item.file_url && !imageFailed;
  const hasFile = Boolean(item.file_url) && !item.is_image;
  const title = item.filename ?? (source === "camera" ? "Camera photo" : null);

  return (
    <article className="border-b border-stone-300/30 last:border-b-0">
      <div className="flex gap-4 px-4 py-3">
        <div className="w-14 shrink-0 pt-0.5 text-right">
          <p
            className="text-sm font-semibold tabular-nums text-zomi-ink"
            title={formatFull(date)}
          >
            {formatTime(date)}
          </p>
          <p className="text-[10px] text-zomi-muted">{timeAgo(date)}</p>
        </div>

        {hasImage && (
          <button
            type="button"
            onClick={() => onOpenImage(item.file_url!, title)}
            className="group relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-stone-300/60 bg-stone-100"
            aria-label="View uploaded image"
          >
            <img
              src={item.file_url!}
              alt={title ?? "Uploaded image"}
              loading="lazy"
              onError={() => setImageFailed(true)}
              className="h-full w-full object-cover transition group-hover:scale-105"
            />
          </button>
        )}

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            <Badge className={SOURCE_STYLES[source] ?? SOURCE_STYLES.text}>
              {SOURCE_LABELS[source] ?? source}
            </Badge>
            <span className="text-xs font-medium text-zomi-ink">
              {langLabel(item.src_lang)}{" "}
              <span className="text-zomi-muted">→</span>{" "}
              <span className="text-zomi-red-dark">{langLabel(item.tgt_lang)}</span>
            </span>
            {item.route && (
              <span className="text-[10px] text-zomi-muted">
                · {ROUTE_LABELS[item.route] ?? item.route}
              </span>
            )}
            {item.filename && (
              <span className="truncate text-[10px] text-zomi-muted" title={item.filename}>
                · {item.filename}
              </span>
            )}
            {item.is_image && imageFailed && (
              <span className="text-[10px] text-zomi-red-dark">· image not reachable</span>
            )}
            {(item.llm_reviews?.length ? item.llm_reviews : item.llm_review ? [item.llm_review] : []).map(
              (review) =>
                review.verdict && (
                  <span
                    key={review.reviewer ?? `${review.provider}/${review.model}`}
                    title={`${review.reviewer ?? ""}: ${review.note ?? ""}`}
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      review.verdict === "fix"
                        ? "bg-zomi-red/10 text-zomi-red-dark"
                        : review.verdict === "ok"
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-amber-100 text-amber-900"
                    }`}
                  >
                    {review.model ?? "AI"}: {review.verdict}
                  </span>
                ),
            )}
          </div>

          <div className="grid gap-x-6 gap-y-1 md:grid-cols-2">
            <p
              className={`whitespace-pre-wrap text-sm leading-relaxed text-zomi-ink ${
                expanded ? "" : "line-clamp-3"
              }`}
            >
              {item.src_text || <span className="text-stone-400">(empty)</span>}
            </p>
            <p
              className={`whitespace-pre-wrap font-serif text-sm leading-relaxed text-zomi-ink ${
                expanded ? "" : "line-clamp-3"
              }`}
            >
              {item.tgt_text || <span className="text-stone-400">(empty)</span>}
            </p>
          </div>

          {expanded && (
            <div className="mt-3 space-y-2 rounded-xl border border-stone-300/40 bg-zomi-cream/70 px-3 py-2 text-xs text-zomi-muted">
              {item.pivot_english && (
                <p>
                  <span className="font-semibold">
                    English pivot:
                  </span>{" "}
                  <span className="whitespace-pre-wrap text-zomi-ink">
                    {item.pivot_english}
                  </span>
                </p>
              )}
              {item.alternatives?.length > 0 && (
                <div>
                  <span className="font-semibold">Other candidates the model weighed:</span>
                  <ul className="mt-1 space-y-0.5">
                    {item.alternatives.map((alt) => (
                      <li key={alt} className="font-serif text-sm text-zomi-ink">
                        {alt}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p>
                <span className="font-semibold">Logged:</span>{" "}
                {formatFull(date)}
              </p>
              <p>
                <span className="font-semibold">Length:</span>{" "}
                {item.src_chars.toLocaleString()} → {item.tgt_chars.toLocaleString()}{" "}
                characters
              </p>
              <p className="break-all">
                <span className="font-semibold">Doc id:</span>{" "}
                <code className="rounded bg-white/80 px-1">{item.id}</code>
              </p>
              {item.storage_key && (
                <p className="break-all">
                  <span className="font-semibold">Storage:</span>{" "}
                  <code className="rounded bg-white/80 px-1">{item.storage_key}</code>
                </p>
              )}
              <div className="flex flex-wrap gap-3 pt-1">
                <button
                  type="button"
                  onClick={() => copyText(item.src_text)}
                  className="text-zomi-red hover:underline"
                >
                  Copy source
                </button>
                <button
                  type="button"
                  onClick={() => copyText(item.tgt_text)}
                  className="text-zomi-red hover:underline"
                >
                  Copy translation
                </button>
                {item.file_url && (
                  <a
                    href={item.file_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-zomi-red hover:underline"
                  >
                    Open {item.is_image ? "image" : "file"}
                  </a>
                )}
              </div>
            </div>
          )}

          {reviewResult && (
            <p
              className={`mt-2 rounded-lg px-3 py-1.5 text-xs ${
                reviewResult.skipped
                  ? "bg-stone-200/60 text-stone-700"
                  : reviewResult.verdict === "fix"
                    ? "bg-zomi-red/5 text-zomi-red-dark"
                    : reviewResult.verdict === "ok"
                      ? "bg-emerald-50 text-emerald-800"
                      : "bg-amber-50 text-amber-900"
              }`}
            >
              {reviewResult.skipped ? (
                <>Already reviewed by {reviewResult.reviewer}; nothing changed.</>
              ) : reviewResult.verdict === "fix" ? (
                <>
                  <span className="font-semibold">{reviewResult.reviewer} suggests a fix</span>
                  {reviewResult.version && reviewResult.version > 1 ? ` (v${reviewResult.version})` : ""}
                  : <span className="font-serif">{reviewResult.corrected}</span>
                  {reviewResult.note ? ` (${reviewResult.note})` : ""}. Added to Corrections.
                </>
              ) : reviewResult.verdict === "ok" ? (
                <>
                  <span className="font-semibold">{reviewResult.reviewer}:</span> looks fine
                  {reviewResult.note ? ` — ${reviewResult.note}` : ""}.
                </>
              ) : (
                <>
                  <span className="font-semibold">{reviewResult.reviewer}:</span> unsure
                  {reviewResult.note ? ` — ${reviewResult.note}` : ""}.
                </>
              )}
            </p>
          )}
          {reviewError && (
            <p className="mt-2 rounded-lg bg-zomi-red/5 px-3 py-1.5 text-xs text-zomi-red-dark">{reviewError}</p>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px]">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="text-zomi-red hover:underline"
            >
              {expanded ? "Show less" : "Show details"}
            </button>
            {reviewers.length > 0 && !reviewOpen && (
              <button
                type="button"
                onClick={() => setReviewOpen(true)}
                disabled={reviewing}
                className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-violet-800 transition hover:bg-violet-100 disabled:opacity-60"
              >
                {reviewing ? (
                  <span className="stream-spinner inline-block h-3 w-3 rounded-full border-2 border-violet-200 border-t-violet-700" aria-hidden />
                ) : (
                  <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M10 3v3m0 8v3m7-7h-3M6 10H3m11.5-4.5-2 2m-5 5-2 2m9 0-2-2m-5-5-2-2" strokeLinecap="round" />
                  </svg>
                )}
                {reviewing ? "Reviewing…" : "AI review"}
              </button>
            )}
            {reviewOpen && (
              <span className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-violet-200 bg-violet-50/70 px-2 py-1">
                {reviewers.length > 1 ? (
                  <select
                    value={chosen}
                    onChange={(e) => setReviewer(e.target.value)}
                    disabled={reviewing}
                    className="rounded-full border border-violet-200 bg-white px-2 py-0.5 text-[11px] text-zomi-ink outline-none"
                  >
                    {reviewers.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                ) : (
                  <span className="text-violet-900">{chosen}</span>
                )}
                {alreadyBy ? (
                  <>
                    <span className="text-violet-900">already reviewed this →</span>
                    <button
                      type="button"
                      disabled={reviewing}
                      onClick={() => runReview("keep")}
                      className="rounded-full bg-violet-700 px-2.5 py-0.5 font-semibold text-white hover:bg-violet-800 disabled:opacity-60"
                    >
                      Review again as v{(alreadyBy.version ?? 1) + 1}
                    </button>
                    <button
                      type="button"
                      disabled={reviewing}
                      onClick={() => runReview("replace")}
                      className="rounded-full border border-violet-300 bg-white px-2.5 py-0.5 text-violet-900 hover:bg-violet-100 disabled:opacity-60"
                    >
                      Replace old
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={reviewing}
                    onClick={() => runReview("keep")}
                    className="rounded-full bg-violet-700 px-2.5 py-0.5 font-semibold text-white hover:bg-violet-800 disabled:opacity-60"
                  >
                    {reviewing ? "Reviewing…" : "Review now"}
                  </button>
                )}
                <button
                  type="button"
                  disabled={reviewing}
                  onClick={() => setReviewOpen(false)}
                  className="text-violet-900 hover:underline"
                >
                  Cancel
                </button>
              </span>
            )}
            {hasFile && (
              <a
                href={item.file_url!}
                target="_blank"
                rel="noreferrer"
                className="text-zomi-muted hover:text-zomi-red hover:underline"
              >
                Open file ↗
              </a>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
