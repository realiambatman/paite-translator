const API_BASE = import.meta.env.VITE_API_URL ?? "";

export type LangCode = "eng_Latn" | "pai_Latn";

export interface Language {
  code: LangCode;
  label: string;
}

export interface ModelStatus {
  ready: boolean;
  device: string;
  quantization: string;
  model_repo: string;
  languages: Language[];
  error: string | null;
}

export interface TranslateResult {
  translation: string;
  src_lang: LangCode;
  tgt_lang: LangCode;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : "Request failed. Please try again.";
    throw new Error(detail);
  }

  return payload as T;
}

export function fetchStatus(): Promise<ModelStatus> {
  return request<ModelStatus>("/api/status");
}

export function translateText(
  text: string,
  srcLang: LangCode,
  tgtLang: LangCode,
): Promise<TranslateResult> {
  return request<TranslateResult>("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      src_lang: srcLang,
      tgt_lang: tgtLang,
    }),
  });
}
