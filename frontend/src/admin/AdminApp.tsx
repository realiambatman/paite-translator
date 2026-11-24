import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FALLBACK_LANGUAGES } from "../languages";
import { fetchStatus, fetchZoStatus, type Language } from "../services/api";
import {
  AdminAuthError,
  addCorrection,
  deleteCorrection,
  deleteTranslation,
  downloadTranslations,
  fetchAdminStatus,
  fetchCorrections,
  fetchLlmSettings,
  fetchReviewStatus,
  fetchStats,
  fetchTranslations,
  fetchTranslationFacets,
  type TranslationFacets,
  reviewCorrection,
  reviewTranslation,
  type AdminCorrection,
  type CorrectionStatus,
  type ExportFormat,
  type OnExisting,
  type ReviewStatus,
  loadToken,
  storeToken,
  verifyToken,
  type AdminStats,
  type AdminStatus,
  type AdminTranslation,
} from "./api";
import { AiReviewTab } from "./components/AiReviewTab";
import { CorrectionsTab } from "./components/CorrectionsTab";
import { ExportMenu } from "./components/ExportMenu";
import { FilterBar, type Filters } from "./components/FilterBar";
import { GlossaryTab } from "./components/GlossaryTab";
import { ImageLightbox } from "./components/ImageLightbox";
import { LoginCard } from "./components/LoginCard";
import { StatsBar } from "./components/StatsBar";
import { TranslationCard } from "./components/TranslationCard";
import { dayKey, formatDayHeading, parseDate, reviewProgress } from "./format";

const PAGE_SIZE = 50;

type Tab = "translations" | "corrections" | "glossary" | "ai";

const TABS: { id: Tab; label: string }[] = [
  { id: "translations", label: "Translations" },
  { id: "corrections", label: "Corrections" },
  { id: "glossary", label: "Glossary" },
  { id: "ai", label: "AI review" },
];

function tabFromHash(): Tab {
  const hash = window.location.hash.replace("#", "");
  return TABS.some((t) => t.id === hash) ? (hash as Tab) : "translations";
}

const DEFAULT_FILTERS: Filters = {
  query: "",
  model: "all",
  source: "all",
  pair: "all",
  imagesOnly: false,
};

interface DayGroup {
  key: string;
  date: Date | null;
  items: AdminTranslation[];
}

function groupByDay(items: AdminTranslation[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const item of items) {
    const date = parseDate(item.created_at);
    const key = dayKey(date);
    let group = groups.get(key);
    if (!group) {
      group = { key, date, items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  // Keep entries without a timestamp together at the very end.
  const ordered = [...groups.values()];
  const undated = ordered.findIndex((group) => group.key === "undated");
  if (undated >= 0) ordered.push(...ordered.splice(undated, 1));
  return ordered;
}

export default function AdminApp() {
  const [serverStatus, setServerStatus] = useState<AdminStatus | null>(null);
  const [token, setToken] = useState<string>(() => loadToken());
  const [authed, setAuthed] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [languages, setLanguages] = useState<Language[]>(FALLBACK_LANGUAGES);
  // names of our own model's language codes (pck, lus, ...), which the Zo tab logs
  const [zoLabels, setZoLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    fetchZoStatus()
      .then((z) => setZoLabels(Object.fromEntries(z.languages.map((l) => [l.code, l.label]))))
      .catch(() => {});
  }, []);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  const [items, setItems] = useState<AdminTranslation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [order, setOrder] = useState<"created_at" | "id">("created_at");

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  // Search and filters run on the server over every entry; these follow the pages of matches.
  const filtersRef = useRef<Filters>(DEFAULT_FILTERS);
  filtersRef.current = filters;
  const [matchOffset, setMatchOffset] = useState<number | null>(null);
  const [totalMatches, setTotalMatches] = useState<number | null>(null);
  const [facets, setFacets] = useState<TranslationFacets | null>(null);
  const filtersActive =
    filters.query.trim() !== "" ||
    (filters.model ?? "all") !== "all" ||
    filters.source !== "all" ||
    filters.pair !== "all" ||
    filters.imagesOnly;
  const [lightbox, setLightbox] = useState<{ src: string; title: string | null } | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>(() => tabFromHash());
  const [corrections, setCorrections] = useState<AdminCorrection[]>([]);
  const [correctionsLoading, setCorrectionsLoading] = useState(false);
  // Suggestions for the translations on the page, asked for by translation: the list above holds only the
  // newest of the queue, so an older translation's suggestions (or a new one in a long queue) would be missing.
  const [pageSuggestions, setPageSuggestions] = useState<AdminCorrection[]>([]);
  const suggestionsAskedFor = useRef(new Set<string>());
  const [busySuggestionId, setBusySuggestionId] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewStatus | null>(null);
  const [, setClock] = useState(0);
  const [reviewers, setReviewers] = useState<string[]>([]);

  const loadReviewers = useCallback(async (activeToken: string) => {
    try {
      const settings = await fetchLlmSettings(activeToken);
      const list = Object.entries(settings.providers)
        .filter(([name]) => settings.keys[name]?.configured)
        .flatMap(([name, meta]) => meta.models.map((m) => `${name}/${m}`));
      // Put the active model first so it is the default in each row.
      const active = settings.provider && settings.model ? `${settings.provider}/${settings.model}` : null;
      setReviewers(active && list.includes(active) ? [active, ...list.filter((r) => r !== active)] : list);
    } catch {
      setReviewers([]);
    }
  }, []);


  // a click on a thumbs count in the header opens the suggestions list on the translations with that rating
  const [showRated, setShowRated] = useState<{ rating: "up" | "down"; at: number } | null>(null);

  const switchTab = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, "", next === "translations" ? "#" : `#${next}`);
  };


  useEffect(() => {
    document.title = "Admin · Zomi Translator";
    fetchAdminStatus().then(setServerStatus).catch(() => setServerStatus(null));
    fetchStatus()
      .then((status) => {
        if (status.languages?.length) setLanguages(status.languages);
      })
      .catch(() => undefined);
  }, []);

  const signOut = useCallback(() => {
    storeToken(null);
    setToken("");
    setAuthed(false);
    setItems([]);
    setStats(null);
    setCursor(null);
    setHasMore(false);
  }, []);

  const handleAuthFailure = useCallback(
    (err: unknown) => {
      if (err instanceof AdminAuthError) {
        signOut();
        setAuthError("Session expired or wrong password. Sign in again.");
        return true;
      }
      return false;
    },
    [signOut],
  );

  const loadStatsRef = useRef<(activeToken: string) => Promise<void>>(async () => undefined);
  const loadStats = useCallback(
    async (activeToken: string) => {
      setStatsLoading(true);
      try {
        setStats(await fetchStats(activeToken));
      } catch (err) {
        if (!handleAuthFailure(err)) console.warn("Stats failed:", err);
      } finally {
        setStatsLoading(false);
      }
    },
    [handleAuthFailure],
  );

  const loadPage = useCallback(
    async (
      activeToken: string,
      nextCursor: string | null,
      activeOrder: "created_at" | "id",
      nextOffset = 0,
      fresh = false,
    ) => {
      setListLoading(true);
      setListError(null);
      const f = filtersRef.current;
      try {
        const page = await fetchTranslations(activeToken, {
          limit: PAGE_SIZE,
          cursor: nextCursor,
          order: activeOrder,
          q: f.query,
          model: f.model ?? "all",
          source: f.source,
          pair: f.pair,
          images: f.imagesOnly,
          offset: nextOffset,
          fresh,
        });
        if (filtersRef.current !== f) return;   // the filters changed while this page was loading
        setMatchOffset(page.next_offset ?? null);
        setTotalMatches(page.total_matches ?? null);
        setItems((prev) => {
          if (!nextCursor && !nextOffset) return page.items;
          const seen = new Set(prev.map((item) => item.id));
          return [...prev, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
      } catch (err) {
        if (!handleAuthFailure(err)) {
          setListError(err instanceof Error ? err.message : "Could not load translations.");
        }
      } finally {
        setListLoading(false);
      }
    },
    [handleAuthFailure],
  );

  loadStatsRef.current = loadStats;

  const loadCorrections = useCallback(async (activeToken: string) => {
    setCorrectionsLoading(true);
    try {
      // The list holds the first few hundred suggestions; the thumbs are asked for on their own, so every
      // rated translation is there however long the list is (the header counts all of them).
      const [page, up, down] = await Promise.all([
        fetchCorrections(activeToken, { status: "all", kind: "all" }),
        fetchCorrections(activeToken, { status: "all", kind: "all", rating: "up" }),
        fetchCorrections(activeToken, { status: "all", kind: "all", rating: "down" }),
      ]);
      const byId = new Map<string, AdminCorrection>();
      for (const item of [...page.items, ...up.items, ...down.items]) byId.set(item.id, item);
      setCorrections([...byId.values()].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")));
    } catch (err) {
      if (!(err instanceof AdminAuthError)) console.warn("Corrections failed:", err);
    } finally {
      setCorrectionsLoading(false);
    }
  }, []);

  const loadSuggestionsFor = useCallback(async (activeToken: string, ids: string[]) => {
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      try {
        const found = await fetchCorrections(activeToken, { status: "all", kind: "all", translationIds: chunk });
        const asked = new Set(chunk);
        setPageSuggestions((prev) => [
          ...prev.filter((c) => !c.translation_id || !asked.has(c.translation_id)),
          ...found.items,
        ]);
      } catch (err) {
        for (const id of chunk) suggestionsAskedFor.current.delete(id);   // asked again with the next page
        if (!(err instanceof AdminAuthError)) console.warn("Suggestions failed:", err);
      }
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    const missing = items.map((item) => item.id).filter((id) => !suggestionsAskedFor.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) suggestionsAskedFor.current.add(id);
    void loadSuggestionsFor(token, missing);
  }, [items, token, loadSuggestionsFor]);

  const handleRowReview = useCallback(
    async (item: AdminTranslation, reviewer: string, onExisting: OnExisting) => {
      const response = await reviewTranslation(token, item.id, { reviewer, on_existing: onExisting });
      setItems((prev) => prev.map((t) => (t.id === item.id ? response.item : t)));
      if (response.result.verdict === "fix" || response.result.replaced) {
        void loadStatsRef.current(token);
        void loadCorrections(token);
        void loadSuggestionsFor(token, [item.id]);
      }
      return response.result;
    },
    [token, loadCorrections, loadSuggestionsFor],
  );

  const handleSuggestionStatus = useCallback(
    async (item: AdminCorrection, next: CorrectionStatus, editedText?: string) => {
      setBusySuggestionId(item.id);
      try {
        const updated = await reviewCorrection(token, item.id, next, editedText);
        setCorrections((prev) => prev.map((c) => (c.id === item.id ? updated : c)));
        setPageSuggestions((prev) => prev.map((c) => (c.id === item.id ? updated : c)));
        void loadStatsRef.current(token);
      } catch (err) {
        if (!handleAuthFailure(err)) {
          setListError(err instanceof Error ? err.message : "Could not update the suggestion.");
        }
      } finally {
        setBusySuggestionId(null);
      }
    },
    [token, handleAuthFailure],
  );

  const handleSuggestionDelete = useCallback(
    async (item: AdminCorrection) => {
      if (!window.confirm("Delete this suggestion permanently? This cannot be undone.")) return;
      setBusySuggestionId(item.id);
      try {
        await deleteCorrection(token, item.id);
        setCorrections((prev) => prev.filter((c) => c.id !== item.id));
        setPageSuggestions((prev) => prev.filter((c) => c.id !== item.id));
        void loadStatsRef.current(token);
      } catch (err) {
        if (!handleAuthFailure(err)) {
          setListError(err instanceof Error ? err.message : "Could not delete the suggestion.");
        }
      } finally {
        setBusySuggestionId(null);
      }
    },
    [token, handleAuthFailure],
  );

  const handleAdoptCandidate = useCallback(
    async (item: AdminTranslation, text: string) => {
      try {
        const created = await addCorrection(token, {
          translation_id: item.id,
          corrected_text: text,
          comment: "Picked from the model's other candidates",
          status: "accepted",
        });
        setCorrections((prev) => [created, ...prev]);
        void loadStatsRef.current(token);
      } catch (err) {
        if (!handleAuthFailure(err)) {
          setListError(err instanceof Error ? err.message : "Could not save that candidate.");
        }
      }
    },
    [token, handleAuthFailure],
  );

  // The card shows a wrong password or a failed delete itself, so errors are passed on to it.
  const handleDeleteTranslation = useCallback(
    async (item: AdminTranslation, password: string) => {
      try {
        await deleteTranslation(token, item.id, password);
      } catch (err) {
        handleAuthFailure(err);
        throw err;
      }
      setItems((prev) => prev.filter((t) => t.id !== item.id));
      setCorrections((prev) => prev.filter((c) => c.translation_id !== item.id));
      setPageSuggestions((prev) => prev.filter((c) => c.translation_id !== item.id));
      setTotalMatches((prev) => (prev == null ? prev : Math.max(0, prev - 1)));
      void loadStatsRef.current(token);
    },
    [token, handleAuthFailure],
  );

  const suggestionsByTranslation = useMemo(() => {
    const map = new Map<string, AdminCorrection[]>();
    const seen = new Set<string>();
    for (const c of [...corrections, ...pageSuggestions]) {
      if (!c.translation_id || seen.has(c.id)) continue;
      seen.add(c.id);
      const list = map.get(c.translation_id);
      if (list) list.push(c);
      else map.set(c.translation_id, [c]);
    }
    return map;
  }, [corrections, pageSuggestions]);

  const loadFacets = useCallback(
    (activeToken: string, fresh = false) =>
      fetchTranslationFacets(activeToken, fresh)
        .then(setFacets)
        .catch(() => {}),
    [],
  );

  const refresh = useCallback(() => {
    if (!token) return;
    suggestionsAskedFor.current.clear();
    setItems([]);
    setCursor(null);
    void loadStats(token);
    void loadCorrections(token);
    void loadPage(token, null, order, 0, true);
    void loadFacets(token, true);
  }, [token, order, loadStats, loadCorrections, loadPage, loadFacets]);

  // A change of search or filters asks the server again (after a short pause while typing).
  const firstFilterRun = useRef(true);
  useEffect(() => {
    if (firstFilterRun.current) {
      firstFilterRun.current = false;
      return;
    }
    if (!authed || !token) return;
    const t = setTimeout(() => {
      setItems([]);
      setCursor(null);
      void loadPage(token, null, order, 0);
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // Auto sign-in with a remembered token.
  useEffect(() => {
    if (!token || authed) return;
    let cancelled = false;
    setAuthBusy(true);
    verifyToken(token)
      .then(() => {
        if (!cancelled) setAuthed(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof AdminAuthError) {
          storeToken(null);
          setToken("");
        } else {
          setAuthError(err instanceof Error ? err.message : "Admin API unavailable.");
        }
      })
      .finally(() => {
        if (!cancelled) setAuthBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!authed || !token) return;
    setItems([]);
    setCursor(null);
    void loadStats(token);
    void loadCorrections(token);
    void loadPage(token, null, order);
    void loadFacets(token);
  }, [authed, token, order, loadStats, loadCorrections, loadPage, loadFacets]);

  // The bulk AI review runs on the server; poll it here so progress stays
  // visible from any tab and survives switching away from the AI review tab.
  useEffect(() => {
    if (!authed || !token) return;
    let cancelled = false;
    const tick = () =>
      fetchReviewStatus(token)
        .then((next) => {
          if (cancelled) return;
          setReview((prev) => {
            if (prev?.status === "running" && next.status !== "running") {
              void loadStatsRef.current(token);
              void loadCorrections(token);
            } else if (next.status === "running" && (next.fix ?? 0) !== (prev?.fix ?? 0)) {
              // New fixes landed mid-run: keep the Corrections badge current.
              void loadStatsRef.current(token);
            }
            return next;
          });
        })
        .catch(() => undefined);
    void tick();
    const timer = window.setInterval(() => {
      setClock((n) => n + 1); // keeps elapsed time and ETA ticking
      void tick();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [authed, token, loadCorrections]);

  // Refresh the per-row reviewer list whenever the admin returns to the log,
  // since keys may have been added in the AI review tab meanwhile.
  useEffect(() => {
    if (authed && token && tab === "translations") void loadReviewers(token);
  }, [authed, token, tab, loadReviewers]);

  const handleLogin = async (password: string) => {
    setAuthBusy(true);
    setAuthError(null);
    try {
      await verifyToken(password);
      storeToken(password);
      setToken(password);
      setAuthed(true);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : "Could not reach the admin API.",
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const handleExport = async (format: ExportFormat) => {
    if (!token) return;
    try {
      await downloadTranslations(token, format);
    } catch (err) {
      if (!handleAuthFailure(err)) {
        setListError(err instanceof Error ? err.message : "Export failed.");
      }
    }
  };

  const langLabel = useCallback(
    (code: string | null) =>
      !code
        ? "—"
        : (languages.find((lang) => lang.code === code)?.label ??
          zoLabels[code] ??
          (code === "auto" ? "Detected automatically" : code)),
    [languages, zoLabels],
  );

  const pairs = useMemo(
    () =>
      (facets?.pairs ?? []).map(({ value, count }) => {
        const [src, tgt] = value.split("→");
        return { value, count, label: `${langLabel(src)} → ${langLabel(tgt)}` };
      }),
    [facets, langLabel],
  );

  const filtered = items;   // the server applied the search and filters to the whole log

  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  if (!authed) {
    return (
      <div className="min-h-screen bg-zomi-cream px-4 text-zomi-ink">
        <div>
          <LoginCard
            status={serverStatus}
            error={authError}
            busy={authBusy}
            onSubmit={handleLogin}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zomi-cream text-zomi-ink">
      <div className="mx-auto max-w-6xl px-4 pb-10 pt-4 md:px-8 md:pt-6">
        <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 pb-2">
          <h1 className="font-serif text-2xl font-bold leading-none tracking-tight text-zomi-ink">
            Zomi Translator <span className="font-normal text-zomi-muted">admin</span>
          </h1>
          <StatsBar
            stats={stats}
            loading={statsLoading}
            onShowRated={(rating) => {
              setShowRated({ rating, at: Date.now() });
              switchTab("corrections");
            }}
          />
        </header>

        <div className="zomi-puan h-[10px] rounded-sm" aria-hidden />

        {serverStatus && !serverStatus.storage_configured && (
          <p className="mt-3 rounded-xl border border-amber-200/60 bg-amber-50/80 px-3 py-2 text-xs text-amber-900">
            Object storage is not configured on this server, so image previews
            use the stored public links and may not load if the bucket is private.
          </p>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1">
        <nav className="flex flex-wrap gap-1" aria-label="Admin sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => switchTab(t.id)}
              className={`rounded-full px-4 py-1.5 text-sm transition ${
                tab === t.id
                  ? "bg-zomi-ink font-semibold text-zomi-cream"
                  : "text-zomi-muted hover:bg-white hover:text-zomi-ink"
              }`}
            >
              {t.label}
              {t.id === "corrections" && stats?.corrections?.pending ? (
                <span className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${tab === t.id ? "bg-zomi-red text-white" : "bg-zomi-red/10 text-zomi-red-dark"}`}>
                  {stats.corrections.pending}
                </span>
              ) : null}
              {t.id === "ai" && review?.status === "running" ? (
                <span
                  className={`ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                    tab === t.id ? "bg-violet-200 text-violet-900" : "bg-violet-100 text-violet-800"
                  }`}
                >
                  {reviewProgress(review)?.percent ?? 0}%
                </span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-1 text-sm">
          <a
            href="/"
            className="rounded-full px-3 py-1 text-zomi-muted transition hover:bg-white hover:text-zomi-ink"
          >
            ← Translator
          </a>
          <button
            type="button"
            onClick={refresh}
            disabled={listLoading}
            className="rounded-full px-3 py-1 text-zomi-muted transition hover:bg-white hover:text-zomi-ink disabled:opacity-60"
          >
            Refresh
          </button>
          <ExportMenu label="Export log" compact onExport={handleExport} />
          <button
            type="button"
            onClick={signOut}
            className="rounded-full px-3 py-1 text-zomi-red transition hover:bg-white"
          >
            Sign out
          </button>
        </div>
        </div>

        <div className="mt-2 overflow-hidden rounded-2xl border border-stone-300/60 bg-zomi-paper shadow-[0_1px_0_rgb(28_25_23/0.04),0_12px_32px_-16px_rgb(28_25_23/0.18)]">

          {tab === "corrections" && (
            <CorrectionsTab
              token={token}
              items={corrections}
              loading={correctionsLoading}
              busyId={busySuggestionId}
              langLabel={langLabel}
              onReload={() => void loadCorrections(token)}
              onStatus={handleSuggestionStatus}
              onDelete={handleSuggestionDelete}
              onAuthError={handleAuthFailure}
              showRated={showRated}
            />
          )}
          {tab === "glossary" && (
            <GlossaryTab token={token} languages={languages} onAuthError={handleAuthFailure} />
          )}
          {tab === "ai" && (
            <AiReviewTab
              token={token}
              languages={languages}
              onAuthError={handleAuthFailure}
              review={review}
              onReview={setReview}
              totalTranslations={stats?.total ?? null}
            />
          )}

          {tab === "translations" && (
          <>
          <FilterBar
            filters={filters}
            pairs={pairs}
            shown={items.length}
            loaded={filtersActive ? (totalMatches ?? items.length) : items.length}
            onChange={setFilters}
          />

          {listError && (
            <div
              role="alert"
              className="border-b border-zomi-red/25 bg-zomi-red/5 px-4 py-3 text-sm text-zomi-red-dark"
            >
              {listError}
            </div>
          )}

          {groups.map((group) => (
            <section key={group.key}>
              <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-300/40 bg-zomi-paper/95 px-4 py-1.5 backdrop-blur">
                <h2 className="font-serif text-sm font-semibold text-zomi-ink">
                  {formatDayHeading(group.date)}
                </h2>
                <span className="text-[11px] tabular-nums text-zomi-muted">
                  {group.items.length} translation{group.items.length === 1 ? "" : "s"}
                </span>
              </div>
              {group.items.map((item) => (
                <TranslationCard
                  key={item.id}
                  item={item}
                  langLabel={langLabel}
                  onOpenImage={(src, title) => setLightbox({ src, title })}
                  reviewers={reviewers}
                  onReview={handleRowReview}
                  suggestions={suggestionsByTranslation.get(item.id) ?? []}
                  busySuggestionId={busySuggestionId}
                  onSuggestionStatus={handleSuggestionStatus}
                  onSuggestionDelete={handleSuggestionDelete}
                  onAdoptCandidate={handleAdoptCandidate}
                  onDelete={handleDeleteTranslation}
                />
              ))}
            </section>
          ))}

          {!listLoading && filtersActive && items.length === 0 && !listError && (
            <p className="px-4 py-10 text-center text-sm text-zomi-muted">
              Nothing in the whole log matches these filters.
            </p>
          )}

          {!listLoading && !listError && items.length === 0 && (
            <p className="px-4 py-10 text-center text-sm text-zomi-muted">
              No translations logged yet.
            </p>
          )}

          {listLoading && (
            <div className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-zomi-muted">
              <span
                className="stream-spinner inline-block h-4 w-4 rounded-full border-2 border-stone-300 border-t-zomi-red"
                aria-hidden
              />
              Loading…
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-stone-300/40 px-4 py-3 text-xs text-zomi-muted">
            <span className="tabular-nums">
              {filtersActive && totalMatches != null
                ? `Showing ${items.length.toLocaleString()} of ${totalMatches.toLocaleString()} matches in the whole log`
                : `Loaded ${items.length.toLocaleString()}${stats?.total != null ? ` of ${stats.total.toLocaleString()}` : ""}`}
            </span>
            <div className="flex items-center gap-3">
              <label className="inline-flex items-center gap-1.5">
                Order
                <select
                  value={order}
                  onChange={(e) => setOrder(e.target.value as "created_at" | "id")}
                  className="rounded-full border border-stone-300/60 bg-zomi-cream px-2 py-1 text-xs text-zomi-ink"
                >
                  <option value="created_at">Newest first</option>
                  <option value="id">Document id (includes undated)</option>
                </select>
              </label>
              {hasMore && (
                <button
                  type="button"
                  onClick={() =>
                    token &&
                    (filtersActive
                      ? loadPage(token, null, order, matchOffset ?? items.length)
                      : loadPage(token, cursor, order))
                  }
                  disabled={listLoading}
                  className="rounded-full bg-zomi-red px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-zomi-red-dark disabled:bg-stone-300"
                >
                  Load {PAGE_SIZE} more
                </button>
              )}
            </div>
          </div>
          </>
          )}
        </div>
      </div>

      <ImageLightbox
        src={lightbox?.src ?? null}
        title={lightbox?.title}
        onClose={() => setLightbox(null)}
      />
    </div>
  );
}
