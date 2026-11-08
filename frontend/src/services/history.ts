import type { LangCode } from "./api";

const KEY = "paite-translator-history";
const MAX_ITEMS = 20;

export interface HistoryItem {
  id: string;
  srcLang: LangCode;
  tgtLang: LangCode;
  srcText: string;
  tgtText: string;
  at: number;
}

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persist(items: HistoryItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    // Storage blocked — history is session-only.
  }
}

export function pushHistory(
  entry: Omit<HistoryItem, "id" | "at">,
  current: HistoryItem[] = loadHistory(),
): HistoryItem[] {
  const deduped = current.filter(
    (item) =>
      !(
        item.srcText === entry.srcText &&
        item.srcLang === entry.srcLang &&
        item.tgtLang === entry.tgtLang
      ),
  );
  const next: HistoryItem[] = [
    { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() },
    ...deduped,
  ].slice(0, MAX_ITEMS);
  persist(next);
  return next;
}

export function clearHistory(): HistoryItem[] {
  persist([]);
  return [];
}
