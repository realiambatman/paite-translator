const API_BASE = import.meta.env.VITE_API_URL ?? "";

export const ADMIN_TOKEN_KEY = "paite-admin-token";

export type SourceKind = "text" | "upload" | "camera";

export interface AdminTranslation {
  id: string;
  created_at: string | null;
  src_lang: string | null;
  tgt_lang: string | null;
  src_text: string;
  tgt_text: string;
  src_chars: number;
  tgt_chars: number;
  route: string | null;
  pivot_english: string | null;
  source: SourceKind | string;
  filename: string | null;
  storage_url: string | null;
  storage_key: string | null;
  /** Presigned (or public) link that can be used directly in <img>/<a>. */
  file_url: string | null;
  is_image: boolean;
  llm_review: LlmReview | null;
  llm_reviews: LlmReview[];
  /** Other beam-search candidates the model considered, if any were logged. */
  alternatives: string[];
}

export interface LlmReview {
  verdict: "ok" | "fix" | "unsure" | string | null;
  confidence: number | null;
  note: string | null;
  provider: string | null;
  model: string | null;
  reviewer: string | null;
  version?: number;
  at: string | null;
}

export type OnExisting = "skip" | "replace" | "keep";

export interface ReviewPrecheck {
  candidates: number;
  reviewers: Record<string, { already_reviewed: number; candidates: number }>;
}

export type CorrectionStatus = "pending" | "accepted" | "rejected";

export interface AdminCorrection {
  id: string;
  created_at: string | null;
  reviewed_at: string | null;
  kind: "correction" | "rating" | string;
  status: CorrectionStatus | string;
  rating: "up" | "down" | null;
  translation_id: string | null;
  src_lang: string | null;
  tgt_lang: string | null;
  src_text: string;
  model_text: string;
  corrected_text: string | null;
  comment: string | null;
  route: string | null;
  pivot_english: string | null;
  origin: "user" | "llm" | string;
  reviewer: string | null;
  confidence: number | null;
  version: number;
}

export interface GlossaryRule {
  id: string;
  tgt_lang: string | null;
  src_lang: string | null;
  find: string;
  replace: string;
  enabled: boolean;
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export type GlossaryRuleInput = Omit<GlossaryRule, "id" | "created_at" | "updated_at">;

export interface LlmKeyInfo {
  configured: boolean;
  source: "admin" | "env" | null;
  hint: string | null;
}

export interface LlmSettings {
  provider: string | null;
  model: string | null;
  providers: Record<string, { label: string; default_model: string; models: string[] }>;
  keys: Record<string, LlmKeyInfo>;
  available: boolean;
}

export interface ReviewStatus {
  status: "idle" | "running" | "done" | "cancelled" | "failed" | string;
  started_at?: string | null;
  finished_at?: string | null;
  provider?: string;
  model?: string;
  reviewers?: string[];
  current_reviewer?: string;
  on_existing?: OnExisting;
  replaced?: number;
  failed?: number;
  /** Position of the model currently running (0-based) and how many will run. */
  model_index?: number;
  models_total?: number;
  /** Entries the current model has finished (reviewed, skipped or failed). */
  model_done?: number;
  /** Set when fewer entries exist than were asked for. */
  scan_total?: number | null;
  limit?: number;
  scanned?: number;
  reviewed?: number;
  ok?: number;
  fix?: number;
  unsure?: number;
  skipped?: number;
  errors?: string[];
}

export interface AdminStats {
  total: number | null;
  today: number | null;
  last_7_days: number | null;
  last_30_days: number | null;
  by_source: { upload: number | null; camera: number | null };
  corrections?: {
    pending: number | null;
    accepted: number | null;
    thumbs_up: number | null;
    thumbs_down: number | null;
  };
  generated_at: string;
}

export interface AdminStatus {
  auth_configured: boolean;
  firestore_configured: boolean;
  firestore_error: string | null;
  storage_configured: boolean;
  collection: string;
  build: string;
}

export interface TranslationsPage {
  items: AdminTranslation[];
  next_cursor: string | null;
  has_more: boolean;
}

export class AdminAuthError extends Error {
  constructor(message = "Wrong admin password.") {
    super(message);
    this.name = "AdminAuthError";
  }
}

export function loadToken(): string {
  try {
    return sessionStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
    else sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // Storage blocked — token lives in memory only.
  }
}

async function adminFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (response.status === 401) {
    throw new AdminAuthError();
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : `Request failed (${response.status}).`;
    throw new Error(detail);
  }
  return response;
}

async function adminJson<T>(path: string, token: string): Promise<T> {
  const response = await adminFetch(path, token);
  return (await response.json()) as T;
}

export async function fetchAdminStatus(): Promise<AdminStatus> {
  const response = await fetch(`${API_BASE}/api/admin/status`);
  if (!response.ok) throw new Error("Admin API unavailable.");
  return (await response.json()) as AdminStatus;
}

export function verifyToken(token: string): Promise<{ ok: boolean }> {
  return adminJson<{ ok: boolean }>("/api/admin/me", token);
}

export function fetchStats(token: string): Promise<AdminStats> {
  return adminJson<AdminStats>("/api/admin/stats", token);
}

export function fetchTranslations(
  token: string,
  options: { limit?: number; cursor?: string | null; order?: "created_at" | "id" } = {},
): Promise<TranslationsPage> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 50));
  params.set("order", options.order ?? "created_at");
  if (options.cursor) params.set("cursor", options.cursor);
  return adminJson<TranslationsPage>(
    `/api/admin/translations?${params.toString()}`,
    token,
  );
}

export type ExportFormat = "csv" | "json" | "jsonl";

export async function downloadTranslations(
  token: string,
  format: ExportFormat = "csv",
): Promise<void> {
  const response = await adminFetch(`/api/admin/export?format=${format}`, token);
  await saveBlob(response, `translations.${format}`);
}

async function adminSend<T>(
  path: string,
  token: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<T> {
  const response = await adminFetch(path, token, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return (await response.json()) as T;
}

// ---------------------------------------------------------------- corrections

export function fetchCorrections(
  token: string,
  options: { status?: CorrectionStatus | "all"; kind?: "all" | "correction" | "rating" } = {},
): Promise<{ items: AdminCorrection[]; count: number; truncated: boolean }> {
  const params = new URLSearchParams();
  params.set("status", options.status ?? "pending");
  params.set("kind", options.kind ?? "all");
  return adminJson(`/api/admin/corrections?${params.toString()}`, token);
}

export function addCorrection(
  token: string,
  body: {
    translation_id: string;
    corrected_text: string;
    comment?: string | null;
    status?: CorrectionStatus;
  },
): Promise<AdminCorrection> {
  return adminSend("/api/admin/corrections", token, "POST", body);
}

export function reviewCorrection(
  token: string,
  id: string,
  status: CorrectionStatus,
  correctedText?: string,
): Promise<AdminCorrection> {
  return adminSend(`/api/admin/corrections/${encodeURIComponent(id)}`, token, "PATCH", {
    status,
    corrected_text: correctedText,
  });
}

export function deleteCorrection(token: string, id: string): Promise<{ ok: boolean }> {
  return adminSend(`/api/admin/corrections/${encodeURIComponent(id)}`, token, "DELETE");
}

export async function downloadCorrections(
  token: string,
  status: CorrectionStatus | "all" = "accepted",
  format: ExportFormat = "csv",
): Promise<void> {
  const response = await adminFetch(
    `/api/admin/corrections/export?status=${status}&format=${format}`,
    token,
  );
  await saveBlob(response, `corrections-${status}.${format}`);
}

async function saveBlob(response: Response, fallbackName: string) {
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/.exec(disposition);
  const filename = match?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------------- glossary

export function fetchGlossary(token: string): Promise<{ items: GlossaryRule[] }> {
  return adminJson("/api/admin/glossary", token);
}

export function addGlossaryRule(token: string, rule: GlossaryRuleInput): Promise<GlossaryRule> {
  return adminSend("/api/admin/glossary", token, "POST", rule);
}

export function updateGlossaryRule(
  token: string,
  id: string,
  patch: Partial<GlossaryRuleInput>,
): Promise<GlossaryRule> {
  return adminSend(`/api/admin/glossary/${encodeURIComponent(id)}`, token, "PATCH", patch);
}

export function deleteGlossaryRule(token: string, id: string): Promise<{ ok: boolean }> {
  return adminSend(`/api/admin/glossary/${encodeURIComponent(id)}`, token, "DELETE");
}

export function previewGlossary(
  token: string,
  text: string,
  srcLang: string,
  tgtLang: string,
): Promise<{ text: string }> {
  return adminSend("/api/admin/glossary/preview", token, "POST", {
    text,
    src_lang: srcLang,
    tgt_lang: tgtLang,
  });
}

// ------------------------------------------------------------ AI provider/review

export function fetchLlmSettings(token: string): Promise<LlmSettings> {
  return adminJson("/api/admin/llm", token);
}

export function updateLlmSettings(
  token: string,
  patch: { provider?: string; model?: string; api_keys?: Record<string, string> },
): Promise<LlmSettings> {
  return adminSend("/api/admin/llm", token, "PUT", patch);
}

export function fetchLlmKey(
  token: string,
  provider: string,
): Promise<{ provider: string; api_key: string; source: "admin" | "env" }> {
  return adminJson(`/api/admin/llm/key/${encodeURIComponent(provider)}`, token);
}

export function testLlm(
  token: string,
  body: { provider?: string; model?: string; api_key?: string } = {},
): Promise<{ ok: boolean; provider: string; model: string; reply: string; ms: number }> {
  return adminSend("/api/admin/llm/test", token, "POST", body);
}

export function fetchReviewStatus(token: string): Promise<ReviewStatus> {
  return adminJson("/api/admin/review/status", token);
}

export function startReview(
  token: string,
  body: {
    limit: number;
    skip_reviewed: boolean;
    tgt_lang?: string | null;
    reviewers?: string[];
    on_existing?: OnExisting;
  },
): Promise<ReviewStatus> {
  return adminSend("/api/admin/review/run", token, "POST", body);
}

export interface ReviewOneResult {
  skipped?: boolean;
  verdict?: "ok" | "fix" | "unsure" | string;
  confidence?: number;
  note?: string;
  corrected?: string | null;
  correction_id?: string | null;
  version?: number;
  reviewer: string;
  replaced?: number;
  errors?: string[];
}

export function reviewTranslation(
  token: string,
  id: string,
  body: { reviewer?: string | null; on_existing?: OnExisting },
): Promise<{ result: ReviewOneResult; item: AdminTranslation }> {
  return adminSend(`/api/admin/translations/${encodeURIComponent(id)}/review`, token, "POST", body);
}

export function precheckReview(
  token: string,
  body: { limit: number; tgt_lang?: string | null; reviewers?: string[] },
): Promise<ReviewPrecheck> {
  return adminSend("/api/admin/review/precheck", token, "POST", body);
}

export function cancelReview(token: string): Promise<ReviewStatus> {
  return adminSend("/api/admin/review/cancel", token, "POST");
}
