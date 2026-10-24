import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { BackToTop } from "@/components/back-to-top";
import { CatalogRows } from "@/components/catalog/catalog-rows";
import { CatalogCustomizeBar } from "@/components/catalog/customize-bar";
import { ContinueCard } from "@/components/continue-card";
import { dismissCw, isCwDismissed, useCwDismissVersion } from "@/lib/cw-dismiss";
import { PeekHero } from "@/components/peek-hero";
import { Row, ScrollRootContext } from "@/components/row";
import { TmdbNudge } from "@/components/nudge";
import { useAuth } from "@/lib/auth";
import { useProfiles, anyProfileSharesStremioWith } from "@/lib/profiles";
import { topSeries, type Meta } from "@/lib/cinemeta";
import { useHideAnimeMetas } from "@/lib/anime-hide";
import { useT } from "@/lib/i18n";
import { publishResumeStates } from "@/lib/hover-preview/store";
import { listPager } from "@/lib/list-pager";
import { CATALOG_REQUEST_TIMEOUT_MS, upsertOrdered, withTimeout } from "@/lib/progressive-rows";
import { hasPageRowChanges, resetPageRows, usePageRows } from "@/lib/page-rows";
import { useSettings } from "@/lib/settings";
import {
  ANIME_CLOUD_ID,
  cwMemberViaResume,
  cwSortKey,
  episodeFromVideoId,
  isAnimeCwItem,
  isCwMember,
  library,
  libraryMetaType,
  resumeSourceForItem,
  type LibraryItem,
} from "@/lib/stremio";
import { resolveLocalPlayVersions } from "@/lib/local-library/playback";
import { listLocalCw, localCwVersion, subscribeLocalCw, clearLocalCw } from "@/lib/local-cw";
import { localToLibraryItem, reconcileCwItem } from "@/lib/continue-watching";
import { useExternalCw } from "@/lib/feed/external-cw";
import {
  dismissManualWatched,
  manualWatchedLibraryItems,
  manualWatchedVersion,
  subscribeManualWatched,
} from "@/lib/manual-watched";
import { useCwAdvance } from "./home/hooks/use-cw-advance";
import { useScrollMemory } from "@/lib/view";
import { buildShowHero, bucketCopy } from "./shows/hero-curation";
import { showSpecs } from "./shows/show-specs";
import { useCollectionRowsForPage } from "@/lib/page-collection-rows";

const HERO_POOL_TARGET = 6;
const MAX_PER_ROW = 30;

type ShowRow = {
  key: string;
  title: string;
  metas: Meta[];
  page: number;
  hasMore: boolean;
  fetcher?: (page: number) => Promise<Meta[]>;
  variant?: "rank";
};

export function Shows({ active = true }: { active?: boolean }) {
  const { settings } = useSettings();
  const { authKey } = useAuth();
  const { activeProfile, profiles } = useProfiles();
  const hideSharedCw =
    settings.cwPerProfile && anyProfileSharesStremioWith(activeProfile, profiles);
  const cwVersion = useCwDismissVersion();
  const t = useT();
  const pageRows = usePageRows("shows");
  const [hero, setHero] = useState<Meta[]>([]);
  const [rows, setRows] = useState<ShowRow[]>([]);
  const [items, setItems] = useState<LibraryItem[]>([]);
  const rowsRef = useRef<ShowRow[]>([]);
  const loadingRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useScrollMemory("shows", scrollRef, active);

  const scrollCb = useCallback((el: HTMLElement | null) => {
    (scrollRef as { current: HTMLElement | null }).current = el;
    setScrollEl(el);
  }, []);

  const refreshLibrary = useCallback(() => {
    if (!authKey) {
      setItems([]);
      return;
    }
    library(authKey)
      .then(setItems)
      .catch(() => {});
  }, [authKey]);

  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  useEffect(() => {
    if (!active) return;
    refreshLibrary();
  }, [active, refreshLibrary]);

  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState === "visible") refreshLibrary();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshLibrary]);

  useEffect(() => {
    let cancelled = false;
    setHero([]);
    setRows([]);
    (async () => {
      if (settings.tmdbKey) {
        const specs = showSpecs(settings.tmdbKey);
        const order = specs.map((spec) => spec.key);
        void withTimeout(buildShowHero(settings.tmdbKey), CATALOG_REQUEST_TIMEOUT_MS)
          .then((heroPool) => {
            if (!cancelled) setHero(heroPool);
          })
          .catch(() => {});
        const results = await Promise.allSettled(
          specs.map(async (spec) => {
            const metas = await withTimeout(spec.fetcher(1), CATALOG_REQUEST_TIMEOUT_MS);
            if (cancelled || metas.length === 0) return false;
            const row: ShowRow = {
              key: spec.key,
              title: spec.title,
              metas,
              page: 1,
              hasMore: !spec.noPaginate && metas.length >= 14,
              fetcher: spec.noPaginate ? undefined : spec.fetcher,
            };
            setRows((current) => upsertOrdered(current, row, order));
            return true;
          }),
        );
        if (cancelled) return;
        if (results.some((result) => result.status === "fulfilled" && result.value)) return;
      }
      {
        const genreList = [
          "Drama",
          "Comedy",
          "Crime",
          "Sci-Fi",
          "Thriller",
          "Mystery",
          "Action",
          "Animation",
          "Adventure",
          "Fantasy",
          "Documentary",
          "Romance",
          "Horror",
        ];
        const [top, ...byGenre] = await Promise.all([
          withTimeout(topSeries(), CATALOG_REQUEST_TIMEOUT_MS).catch(() => [] as Meta[]),
          ...genreList.map((g) =>
            withTimeout(topSeries(g), CATALOG_REQUEST_TIMEOUT_MS).catch(() => [] as Meta[]),
          ),
        ]);
        if (cancelled) return;
        setHero(top.filter((m) => m.background).slice(0, HERO_POOL_TARGET));
        const built: ShowRow[] = [
          {
            key: "cinemeta-top",
            title: "Top Series",
            metas: top.slice(0, 30),
            page: 1,
            hasMore: false,
            fetcher: listPager(top),
          },
        ];
        for (let i = 0; i < genreList.length; i++) {
          const list = byGenre[i] ?? [];
          if (list.length === 0) continue;
          built.push({
            key: `cinemeta-genre-${genreList[i].toLowerCase().replace(/[^a-z]/g, "")}`,
            title: `Top ${genreList[i]}`,
            metas: list.slice(0, 30),
            page: 1,
            hasMore: false,
            fetcher: listPager(list),
          });
        }
        setRows(built);
      }
    })().catch(console.error);
    return () => {
      cancelled = true;
    };
  }, [settings.tmdbKey]);

  const externalCw = useExternalCw(
    !hideSharedCw && (settings.cwSources.trakt || settings.cwSources.simkl),
  );
  const localCwVer = useSyncExternalStore(subscribeLocalCw, localCwVersion);
  const continueWatching = useMemo(() => {
    const disabledSources = new Set<string>();
    if (!settings.cwSources.trakt) disabledSources.add("trakt");
    if (!settings.cwSources.simkl) disabledSources.add("simkl");

    const base = hideSharedCw
      ? []
      : [
          ...(settings.cwSources.library
            ? items.filter((i) => !ANIME_CLOUD_ID.test(i._id) && isCwMember(i))
            : []),
          ...externalCw.filter((i) => !disabledSources.has(i.external ?? "")),
        ];
    const local = listLocalCw(hideSharedCw)
      .filter((e) => (e.source === "library" ? settings.cwSources.library : settings.cwSources.local))
      .map(localToLibraryItem);

    const lastWatchedOf = (i: LibraryItem) => {
      const w = i.state?.lastWatched;
      const lw = typeof w === "number" ? w : Date.parse(String(w ?? ""));
      if (Number.isFinite(lw) && lw > 0) return lw;
      const m = i._mtime as unknown;
      const mt = typeof m === "number" ? m : Date.parse(String(m ?? ""));
      return Number.isFinite(mt) ? mt : 0;
    };

    const eligible = [...base, ...local].filter((i) => {
      if (i.type !== "series") return false;
      if (ANIME_CLOUD_ID.test(i._id)) return false;
      if (isCwDismissed(i)) return false;
      if (!isCwMember(i)) return false;
      if ((settings.animeOnlyInAnimeRoom || settings.hideContent.anime) && isAnimeCwItem(i)) return false;
      if (disabledSources.size > 0 && cwMemberViaResume(i)) {
        const src = resumeSourceForItem(i);
        if (src && disabledSources.has(src)) return false;
      }
      return true;
    });

    const byId = new Map<string, LibraryItem>();
    for (const i of eligible) {
      const existing = byId.get(i._id);
      if (existing) {
        const winner = reconcileCwItem(existing, i, lastWatchedOf);
        if (winner !== existing) {
          byId.set(i._id, winner);
        }
        continue;
      }
      byId.set(i._id, i);
    }

    return [...byId.values()]
      .map((i) => ({ i, k: cwSortKey(i) }))
      .sort((a, b) => b.k - a.k || lastWatchedOf(b.i) - lastWatchedOf(a.i))
      .map((e) => e.i)
      .slice(0, 16);
  }, [
    items,
    externalCw,
    cwVersion,
    hideSharedCw,
    localCwVer,
    settings.cwSources,
    settings.animeOnlyInAnimeRoom,
    settings.hideContent.anime,
    activeProfile?.id,
  ]);

  const manualWatchedVer = useSyncExternalStore(subscribeManualWatched, manualWatchedVersion);
  const resurfaceLibrary = useMemo(() => {
    const localSeries = listLocalCw(hideSharedCw)
      .filter((e) => e.type === "series" && (e.source === "library" ? settings.cwSources.library : settings.cwSources.local))
      .map(localToLibraryItem);
    const base = [
      ...(hideSharedCw || !settings.cwSources.library ? [] : items.filter((i) => !ANIME_CLOUD_ID.test(i._id))),
      ...localSeries,
    ];
    const manual = manualWatchedLibraryItems().filter((i) => !isAnimeCwItem(i));
    if (manual.length === 0) return base;
    const cwMemberIds = new Set(base.filter(isCwMember).map((i) => i._id));
    const usable = manual.filter((i) => !cwMemberIds.has(i._id));
    if (usable.length === 0) return base;
    const overrideIds = new Set(usable.map((i) => i._id));
    return [...base.filter((i) => !overrideIds.has(i._id)), ...usable];
  }, [items, manualWatchedVer, hideSharedCw, localCwVer, settings.cwSources]);
  const cwItems = useCwAdvance(
    continueWatching,
    settings.tmdbKey,
    settings.cwAdvanceNext,
    resurfaceLibrary,
    "exclude",
    manualWatchedVer,
  );

  useEffect(() => {
    publishResumeStates(cwItems);
  }, [cwItems]);

  const loadMore = useCallback((rowKey: string) => {
    if (loadingRef.current.has(rowKey)) return;
    const row = rowsRef.current.find((r) => r.key === rowKey);
    if (!row || !row.fetcher || !row.hasMore || row.metas.length >= MAX_PER_ROW) return;
    loadingRef.current.add(rowKey);
    const next = row.page + 1;
    row
      .fetcher(next)
      .then((more) => {
        setRows((rs) =>
          rs.map((r) => {
            if (r.key !== rowKey) return r;
            const ids = new Set(r.metas.map((m) => m.id));
            const fresh = more.filter((m) => !ids.has(m.id));
            const combined = [...r.metas, ...fresh];
            const reachedCap = combined.length >= MAX_PER_ROW;
            return {
              ...r,
              metas: reachedCap ? combined.slice(0, MAX_PER_ROW) : combined,
              page: next,
              hasMore: !reachedCap && more.length > 0,
            };
          }),
        );
      })
      .catch(() => {})
      .finally(() => {
        loadingRef.current.delete(rowKey);
      });
  }, []);

  const shownHero = useHideAnimeMetas(hero);
  const trendingMetas = useMemo(() => rows.find((r) => r.key === "trending")?.metas ?? [], [rows]);
  const shownTrending = useHideAnimeMetas(trendingMetas);
  const top10 = useMemo(() => shownTrending.slice(0, 10), [shownTrending]);

  const restRows = useMemo(() => {
    const seen = new Set<string>();
    for (const m of hero) seen.add(m.id);
    return rows
      .filter((r) => r.key !== "trending" || top10.length === 0)
      .map((r) => ({
        ...r,
        metas: r.metas.filter((m) => !seen.has(m.id)),
      }))
      .filter((r) => r.metas.length >= 4);
  }, [rows, hero, top10.length]);

  const showCollections = useCollectionRowsForPage("shows");
  const collectionRows = useMemo<ShowRow[]>(
    () =>
      showCollections
        .filter((c) => c.items.length > 0)
        .map((c) => ({
          key: `collection-${c.id}`,
          title: c.name,
          metas: c.items.map((it) => ({
            id: it.id,
            type: it.type,
            name: it.name,
            poster: it.poster,
          })),
          page: 1,
          hasMore: false,
        })),
    [showCollections],
  );
  const allRestRows = useMemo(() => [...collectionRows, ...restRows], [collectionRows, restRows]);
  const catalogRows = useMemo<ShowRow[]>(() => {
    if (top10.length < 10) return allRestRows;
    const trending = rows.find((r) => r.key === "trending");
    return [
      {
        key: "top10",
        title: "Top 10 Series Today",
        metas: top10.slice(0, 10),
        page: 1,
        hasMore: false,
        fetcher: trending?.fetcher,
        variant: "rank",
      },
      ...allRestRows,
    ];
  }, [top10, rows, allRestRows]);

  return (
    <main ref={scrollCb} className="relative h-full overflow-y-auto overflow-x-hidden bg-canvas">
      <ScrollRootContext.Provider value={scrollEl}>
        <div className="relative flex w-full flex-col gap-12 px-12 pb-32 pt-32">
          <PageMast />
          <div className="relative">
            <PeekHero slides={shownHero} />
            <div className="absolute bottom-3 end-3 z-20">
              <CatalogCustomizeBar
                editMode={pageRows.editMode}
                hasChanges={hasPageRowChanges(pageRows.custom)}
                onToggleEdit={() => pageRows.setEditMode((v) => !v)}
                onReset={() => pageRows.persist(resetPageRows())}
              />
            </div>
          </div>
          {!settings.tmdbKey && <TmdbNudge />}
          {cwItems.length > 0 && (
            <Row
              title={t("Pick up where you left off")}
              min={260}
              shape="landscape"
              scrollKey="shows:cw"
            >
              {cwItems.map((it) => (
                <ContinueCard
                  key={it._id}
                  item={it}
                  onDismiss={(item) => {
                    if (item.manualWatched) {
                      dismissManualWatched(item._id);
                      return;
                    }
                    if (item.local) clearLocalCw(item._id);
                    dismissCw(item, authKey);
                    const candidateIds = new Set<string>([item._id]);
                    const ep =
                      item.state?.season && item.state?.episode
                        ? { season: item.state.season, episode: item.state.episode }
                        : episodeFromVideoId(item.state?.video_id);
                    const imdbId = item._id.startsWith("tt") ? item._id : undefined;
                    const local = resolveLocalPlayVersions(
                      { id: item._id, type: libraryMetaType(item.type), name: item.name },
                      ep ?? null,
                      imdbId,
                    );
                    for (const entry of local) {
                      candidateIds.add(`local:${entry.id}`);
                      if (entry.imdbId) candidateIds.add(entry.imdbId);
                      if (entry.tmdbId != null) {
                        candidateIds.add(`tmdb:${entry.type === "show" ? "tv" : "movie"}:${entry.tmdbId}`);
                      }
                    }
                    for (const cid of candidateIds) clearLocalCw(cid);
                    for (const cid of candidateIds) {
                      if (cid !== item._id) dismissCw({ ...item, _id: cid }, authKey);
                    }
                    setItems((prev) =>
                      prev.map((i) =>
                        candidateIds.has(i._id) && i.state
                          ? { ...i, state: { ...i.state, timeOffset: 0 }, _mtime: new Date().toISOString() }
                          : i,
                      ),
                    );
                  }}
                />
              ))}
            </Row>
          )}
          <CatalogRows
            rows={catalogRows}
            editMode={pageRows.editMode}
            custom={pageRows.custom}
            onPersist={pageRows.persist}
            scrollPrefix="shows"
            onLoadMore={loadMore}
          />
        </div>
        <BackToTop scrollRef={scrollRef} />
      </ScrollRootContext.Provider>
    </main>
  );
}

function PageMast() {
  const t = useT();
  const copy = bucketCopy();
  return (
    <header data-tauri-drag-region className="flex flex-col gap-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.42em] text-ink-subtle">
        {t(copy.kicker)}
      </span>
      <h1 className="font-display text-[44px] font-medium leading-[1.05] tracking-tight text-ink">
        {t(copy.title)}
      </h1>
      <p className="max-w-2xl text-[15px] leading-relaxed text-ink-muted">{t(copy.subtitle)}</p>
    </header>
  );
}
