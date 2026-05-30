export const DEFAULT_MAX_TOKENS = 200;
export const DEFAULT_MAX_CHARS = 800;

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

export function analyzeInput(
  text: string,
  maxTokens: number = DEFAULT_MAX_TOKENS,
  maxChars: number = DEFAULT_MAX_CHARS,
) {
  const trimmed = text.trim();
  const chars = trimmed.length;
  const tokens = estimateTokens(text);
  const overLimit = tokens > maxTokens;
  const charRatio = maxChars > 0 ? Math.min(chars / maxChars, 1) : 0;

  let message = `Up to ${maxChars.toLocaleString()} characters`;
  if (!trimmed) {
    message = "Enter text to translate";
  } else if (overLimit) {
    message = "Too long — shorten your text";
  }

  return {
    chars,
    tokens,
    overLimit,
    charRatio,
    valid: Boolean(trimmed) && !overLimit,
    message,
  };
}
