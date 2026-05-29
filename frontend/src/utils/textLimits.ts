export const DEFAULT_MAX_TOKENS = 100;

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(countWords(trimmed), Math.ceil(trimmed.length / 4));
}

/** Rough client-side check; backend uses NLTK for final validation. */
export function estimateSentenceCount(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (trimmed.includes("\n")) return 2;
  const parts = trimmed.split(/(?<=[.!?])\s+/).filter((part) => part.trim());
  return parts.length || 1;
}

export function analyzeInput(text: string, maxTokens: number = DEFAULT_MAX_TOKENS) {
  const words = countWords(text);
  const tokens = estimateTokens(text);
  const sentences = estimateSentenceCount(text);
  const overTokens = tokens > maxTokens;
  const multiSentence = sentences > 1;
  const tokenRatio = maxTokens > 0 ? Math.min(tokens / maxTokens, 1) : 0;

  let message = "One sentence · max " + maxTokens + " tokens";
  if (!text.trim()) {
    message = "Enter one sentence to translate";
  } else if (multiSentence) {
    message = "Only one sentence allowed";
  } else if (overTokens) {
    message = "Too long — shorten your sentence";
  }

  return {
    words,
    tokens,
    sentences,
    overTokens,
    multiSentence,
    tokenRatio,
    valid: Boolean(text.trim()) && !overTokens && !multiSentence,
    message,
  };
}
