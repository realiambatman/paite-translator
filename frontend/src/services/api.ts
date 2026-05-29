const API_BASE = import.meta.env.VITE_API_URL ?? "";

export type LangCode =
  | "eng_Latn"
  | "pai_Latn"
  | "lus_Latn"
  | "mni_Beng"
  | "mya_Mymr"
  | "hin_Deva";

export interface Language {
  code: LangCode;
  label: string;
  provider: "hf" | "google";
}

export interface TranslationLimits {
  max_tokens: number;
  single_sentence_only: boolean;
}

export interface ModelStatus {
  ready: boolean;
  device: string;
  quantization: string;
  model_repo: string;
  languages: Language[];
  error: string | null;
  limits?: TranslationLimits;
  google_translate_enabled?: boolean;
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

export interface StreamUpdate {
  translation: string;
  current: number;
  total: number;
}

export interface StreamResult {
  translation: string;
  route?: string | null;
  pivotEnglish?: string | null;
}

export interface TranslateStreamEvent {
  translation?: string;
  current?: number;
  total?: number;
  route?: string | null;
  pivot_english?: string | null;
  done: boolean;
  error?: string;
}

export function translateTextStream(
  text: string,
  srcLang: LangCode,
  tgtLang: LangCode,
  onChunk: (update: StreamUpdate) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    fetch(`${API_BASE}/api/translate/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        src_lang: srcLang,
        tgt_lang: tgtLang,
      }),
      signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          const detail =
            typeof payload.detail === "string"
              ? payload.detail
              : "Request failed. Please try again.";
          throw new Error(detail);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("Streaming not supported.");

        const decoder = new TextDecoder();
        let buffer = "";
        let finalResult: StreamResult = { translation: "" };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const event = JSON.parse(line.slice(6)) as TranslateStreamEvent;
            if (event.error) throw new Error(event.error);
            if (event.translation !== undefined) {
              onChunk({
                translation: event.translation,
                current: event.current ?? 0,
                total: event.total ?? 0,
              });
            }
            if (event.done && event.translation !== undefined) {
              finalResult = {
                translation: event.translation,
                route: event.route ?? null,
                pivotEnglish: event.pivot_english ?? null,
              };
            }
          }
        }
        resolve(finalResult);
      })
      .catch(reject);
  });
}
