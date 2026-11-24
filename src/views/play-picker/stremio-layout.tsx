import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addonLogoSrc, resolveAddonLogo } from "@/components/addon-logo";
import type { Addon } from "@/lib/addons";
import type { ScoredStream } from "@/lib/streams/types";
import { StremioRow } from "./stremio-row";
import { FACET_DIMS, facetOptions, matchesFacets, type FacetState } from "./stream-facets";
import { addonInstanceKey, buildAddonOptions } from "./picker-utils";
import { buildUniqueStreamKeys, stabilizeStreamOrder } from "./stream-order-stability";
import { useSettings } from "@/lib/settings";
import { useT } from "@/lib/i18n";
import type { CustomStreamFilter } from "@/lib/streams/custom-filters";
import { FacetMenuRow } from "./facet-menu-row";
import { FilterBuilder } from "./filter-builder";
import { SearchSortRow } from "./search-sort-row";
import {
  compileStreamSearch,
  defaultSortStreams,
  sortPickerStreams,
  type StreamSearchMode,
  type StreamSortField,
} from "./stream-search-sort";

export function StremioLayout({
  streams,
  addons,
  pipelineDone,
  loadingAddonCount,
  failedStreams,
  preserveOrder,
  matchFor,
  onPlay,
  download = false,
  downloadStateFor,
  isAnime = false,
}: {
  streams: ScoredStream[];
  addons: Addon[] | null;
  pipelineDone: boolean;
  loadingAddonCount: number;
  failedStreams: Set<ScoredStream>;
  preserveOrder?: boolean;
  matchFor?: (s: ScoredStream) => "same" | "close" | null;
  onPlay: (stream: ScoredStream) => void;
  download?: boolean;
  downloadStateFor?: (stream: ScoredStream) => "idle" | "preparing" | "queued";
  isAnime?: boolean;
}) {
  const t = useT();
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<StreamSearchMode>("plain");
  const { settings, update } = useSettings();
  const savedFilter = settings.pickerAddonFilter || "all";
  const savedFacet: FacetState = settings.pickerFacets ?? {};
  const setFilter = (next: string) => {
    update({ pickerAddonFilter: next || "all" });
  };
  const setFacetValue = (key: string, value: string) => {
    const next: FacetState = { ...savedFacet };
    if (!value || value === "all") delete next[key];
    else next[key] = value;
    update({ pickerFacets: next });
  };
  const sortBy = settings.pickerSortBy ?? "default";
  const sortDir = settings.pickerSortDir ?? "desc";
  const handleSortByChange = (newSortBy: StreamSortField) => {
    update({ pickerSortBy: newSortBy });
  };
  const handleSortDirToggle = () => {
    update({ pickerSortDir: sortDir === "desc" ? "asc" : "desc" });
  };
  const customFilters = settings.customStreamFilters;
  const activeFilterId = settings.activeStreamFilterId;
  const setActiveFilterId = (id: string | null) => update({ activeStreamFilterId: id });
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingFilter, setEditingFilter] = useState<CustomStreamFilter | null>(null);
  const addonLogoMap = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const a of addons ?? []) {
      const logo = resolveAddonLogo(a.manifest.logo, a.transportUrl);
      if (a.transportUrl) m.set(a.transportUrl, logo);
      if (!m.has(a.manifest.id)) m.set(a.manifest.id, logo);
    }
    return m;
  }, [addons]);
  const addonRank = useMemo(() => {
    const m = new Map<string, number>();
    (addons ?? []).forEach((a, i) => {
      if (a.transportUrl) m.set(a.transportUrl, i);
    });
    return m;
  }, [addons]);
  const addonOptions = useMemo(() => buildAddonOptions(streams, addonRank), [streams, addonRank]);
  const filter = useMemo(() => {
    if (savedFilter === "all") return "all";
    const hasMatch = streams.some((s) => addonInstanceKey(s) === savedFilter);
    if (hasMatch) return savedFilter;
    // Only fall back locally after all addons finish, without overwriting the user's saved default.
    return pipelineDone && streams.length > 0 ? "all" : savedFilter;
  }, [savedFilter, streams, pipelineDone]);
  const addonFiltered = useMemo(
    () => (filter === "all" ? streams : streams.filter((s) => addonInstanceKey(s) === filter)),
    [streams, filter],
  );
  const compiledSearch = useMemo(
    () => compileStreamSearch(searchQuery, searchMode),
    [searchQuery, searchMode],
  );
  const searchFiltered = useMemo(
    () => (compiledSearch.active ? addonFiltered.filter(compiledSearch.test) : addonFiltered),
    [addonFiltered, compiledSearch],
  );
  const facet = useMemo(() => {
    if (!pipelineDone || searchFiltered.length === 0) return savedFacet;
    const next: FacetState = {};
    for (const dim of FACET_DIMS) {
      const sel = savedFacet[dim.key];
      if (!sel || sel === "all") continue;
      const pool = searchFiltered.filter((s) => matchesFacets(s, next, dim.key));
      if (facetOptions(pool, dim).some((o) => o.key === sel)) {
        next[dim.key] = sel;
      }
    }
    return next;
  }, [pipelineDone, savedFacet, searchFiltered]);
  const facetData = useMemo(
    () =>
      FACET_DIMS.map((dim) => {
        const base = searchFiltered.filter((s) => matchesFacets(s, facet, dim.key));
        return {
          dim,
          options: facetOptions(base, dim),
          total: base.length,
          value: facet[dim.key] ?? "all",
        };
      }),
    [searchFiltered, facet],
  );
  const computedStreams = useMemo(() => {
    const filtered = searchFiltered.filter((s) => matchesFacets(s, facet));
    return sortPickerStreams(filtered, sortBy, sortDir, (list) =>
      defaultSortStreams(list, { preserveOrder }),
    );
  }, [searchFiltered, facet, preserveOrder, sortBy, sortDir]);

  const facetSignature = useMemo(
    () =>
      Object.entries(facet)
        .filter(([, v]) => v && v !== "all")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&"),
    [facet],
  );
  const resetSignature = `${filter}|${facetSignature}|${searchQuery}|${searchMode}|${sortBy}|${sortDir}|${activeFilterId ?? ""}|${preserveOrder ? "1" : "0"}`;

  const [displayedStreams, setDisplayedStreams] = useState<ScoredStream[]>(() => computedStreams);
  const [deferredStreams, setDeferredStreams] = useState<ScoredStream[] | null>(null);
  const [interacting, setInteracting] = useState(false);
  const hoveringRef = useRef(false);
  const pointerDownRef = useRef(false);
  const focusInsideRef = useRef(false);
  const interactingRef = useRef(false);
  const orderKeysRef = useRef<string[]>(buildUniqueStreamKeys(computedStreams));
  const lastResetSigRef = useRef(resetSignature);
  const displayedStreamsRef = useRef(displayedStreams);
  displayedStreamsRef.current = displayedStreams;

  const syncInteracting = useCallback(() => {
    const next = hoveringRef.current || pointerDownRef.current || focusInsideRef.current;
    interactingRef.current = next;
    setInteracting(next);
  }, []);

  const commitStreams = useCallback((incoming: ScoredStream[], resetOrder: boolean) => {
    if (resetOrder || orderKeysRef.current.length === 0 || incoming.length === 0) {
      orderKeysRef.current = buildUniqueStreamKeys(incoming);
      setDisplayedStreams(incoming);
      setDeferredStreams(null);
      return;
    }
    const next = stabilizeStreamOrder(orderKeysRef.current, incoming);
    orderKeysRef.current = next.keys;
    setDisplayedStreams(next.ordered);
    setDeferredStreams(null);
  }, []);

  useEffect(() => {
    const resetChanged = lastResetSigRef.current !== resetSignature;
    lastResetSigRef.current = resetSignature;
    if (resetChanged || computedStreams.length === 0 || displayedStreamsRef.current.length === 0) {
      commitStreams(computedStreams, resetChanged || computedStreams.length === 0);
      return;
    }
    if (interactingRef.current) {
      const curKeys = orderKeysRef.current;
      const nextKeys = buildUniqueStreamKeys(computedStreams);
      const curSet = new Set(curKeys);
      const changed = curKeys.length !== nextKeys.length || nextKeys.some((k) => !curSet.has(k));
      setDeferredStreams(changed ? computedStreams : null);
      return;
    }
    commitStreams(computedStreams, false);
  }, [computedStreams, resetSignature, commitStreams]);

  useEffect(() => {
    if (!interacting && deferredStreams != null) {
      commitStreams(deferredStreams, false);
    }
  }, [interacting, deferredStreams, commitStreams]);

  useEffect(() => {
    if (!interacting) return;
    const clearPointerDown = () => {
      if (!pointerDownRef.current) return;
      pointerDownRef.current = false;
      syncInteracting();
    };
    window.addEventListener("pointerup", clearPointerDown);
    window.addEventListener("pointercancel", clearPointerDown);
    return () => {
      window.removeEventListener("pointerup", clearPointerDown);
      window.removeEventListener("pointercancel", clearPointerDown);
    };
  }, [interacting, syncInteracting]);

  const displayKeys = useMemo(() => buildUniqueStreamKeys(displayedStreams), [displayedStreams]);
  const filterLabel =
    filter === "all" ? t("All") : (addonOptions.find((o) => o.id === filter)?.name ?? t("All"));
  const filterLogo = filter === "all" ? null : (addonLogoMap.get(filter) ?? null);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <button
          onClick={() => setFilterOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-3 rounded-2xl bg-elevated/60 px-4 py-3 text-start text-[15px] font-medium text-ink ring-1 ring-edge-soft transition-colors hover:bg-elevated"
        >
          <div className="flex min-w-0 items-center gap-3">
            <CircleLogo
              addonId={filter === "all" ? null : filter}
              addonName={filterLabel}
              logo={filterLogo}
            />
            <span className="truncate">{filterLabel}</span>
          </div>
          <ChevronDown
            size={18}
            strokeWidth={2.2}
            className={`shrink-0 text-ink-muted transition-transform duration-200 ${
              filterOpen ? "rotate-180" : ""
            }`}
          />
        </button>
        {filterOpen && (
          <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-80 overflow-y-auto rounded-2xl bg-elevated p-1.5 ring-1 ring-edge shadow-[0_18px_44px_-14px_rgba(0,0,0,0.7)]">
            <button
              onClick={() => {
                setFilter("all");
                setFilterOpen(false);
              }}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-[14px] transition-colors hover:bg-raised ${
                filter === "all" ? "text-ink font-semibold" : "text-ink-muted"
              }`}
            >
              <CircleLogo addonId={null} addonName={t("All")} logo={null} />
              <span className="flex-1 truncate">{t("All sources")}</span>
              <span className="text-[12px] text-ink-subtle">{streams.length}</span>
            </button>
            {addonOptions.map((opt) => (
              <button
                key={opt.id}
                onClick={() => {
                  setFilter(opt.id);
                  setFilterOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start text-[14px] transition-colors hover:bg-raised ${
                  filter === opt.id ? "text-ink font-semibold" : "text-ink-muted"
                }`}
              >
                <CircleLogo
                  addonId={opt.id}
                  addonName={opt.name}
                  logo={addonLogoMap.get(opt.id) ?? null}
                />
                <span className="flex-1 truncate">{opt.name}</span>
                <span className="text-[12px] text-ink-subtle">{opt.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <SearchSortRow
        query={searchQuery}
        onQueryChange={setSearchQuery}
        mode={searchMode}
        onModeChange={setSearchMode}
        regexError={Boolean(compiledSearch.error)}
        sortBy={sortBy}
        onSortByChange={handleSortByChange}
        sortDir={sortDir}
        onSortDirToggle={handleSortDirToggle}
      />
      <FacetMenuRow
        facets={facetData}
        onFacet={setFacetValue}
        filters={customFilters}
        activeFilterId={activeFilterId}
        onSelectFilter={setActiveFilterId}
        onNewFilter={() => {
          setEditingFilter(null);
          setBuilderOpen(true);
        }}
        onEditFilter={(f) => {
          setEditingFilter(f);
          setBuilderOpen(true);
        }}
        extraNarrowed={compiledSearch.active}
        onResetExtra={() => setSearchQuery("")}
        onResetFacets={() => {
          update({ pickerFacets: {}, activeStreamFilterId: null });
          setSearchQuery("");
        }}
      />
      <div
        className="flex flex-col gap-2"
        onPointerEnter={() => {
          hoveringRef.current = true;
          syncInteracting();
        }}
        onPointerMove={() => {
          if (!hoveringRef.current) {
            hoveringRef.current = true;
            syncInteracting();
          }
        }}
        onPointerLeave={() => {
          hoveringRef.current = false;
          syncInteracting();
        }}
        onPointerDown={() => {
          pointerDownRef.current = true;
          syncInteracting();
        }}
        onPointerUp={() => {
          pointerDownRef.current = false;
          syncInteracting();
        }}
        onFocusCapture={() => {
          focusInsideRef.current = true;
          syncInteracting();
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            focusInsideRef.current = false;
            syncInteracting();
          }
        }}
      >
        {displayedStreams.map((s, i) => (
          <StremioRow
            key={displayKeys[i]}
            stream={s}
            failed={failedStreams.has(s)}
            addonLogo={addonLogoMap.get(s.addonUrl ?? "") ?? addonLogoMap.get(s.addonId) ?? null}
            match={matchFor ? matchFor(s) : null}
            onPlay={() => onPlay(s)}
            download={download}
            downloadState={downloadStateFor?.(s)}
            isAnime={isAnime}
          />
        ))}
      </div>
      {streams.length > 0 &&
        displayedStreams.length === 0 &&
        (pipelineDone || Boolean(compiledSearch.error)) && (
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-elevated/60 px-5 py-6 text-center ring-1 ring-edge-soft">
            <p className="text-[14px] text-ink-muted">
              {compiledSearch.error
                ? t("Invalid regular expression")
                : streams.length === 1
                  ? t("All {n} source is hidden by the active filter.", { n: streams.length })
                  : t("All {n} sources are hidden by the active filter.", { n: streams.length })}
            </p>
            <button
              onClick={() => {
                update({ pickerAddonFilter: "all", pickerFacets: {}, activeStreamFilterId: null });
                setSearchQuery("");
              }}
              className="rounded-full bg-accent-soft px-4 py-2 text-[13px] font-semibold text-accent ring-1 ring-edge-soft transition-transform hover:scale-[1.02] active:scale-[0.98] motion-reduce:transition-none motion-reduce:hover:scale-100"
            >
              {t("Clear filters")}
            </button>
          </div>
        )}
      {deferredStreams != null && (
        <div className="pointer-events-none sticky bottom-14 z-10 flex justify-center">
          <button
            type="button"
            onClick={() => commitStreams(deferredStreams, false)}
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-edge-soft bg-elevated/95 px-3.5 py-1.5 text-[12px] font-medium text-ink shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md transition-transform hover:scale-[1.02] active:scale-[0.98]"
          >
            <span>{t("Refresh sources")}</span>
            <span className="text-ink-subtle">({deferredStreams.length})</span>
          </button>
        </div>
      )}
      {!pipelineDone && (
        <PendingAddonsPill addons={addons} streams={streams} fallbackCount={loadingAddonCount} />
      )}
      <FilterBuilder
        open={builderOpen}
        initial={editingFilter}
        onClose={() => setBuilderOpen(false)}
        onSave={(f) => {
          const exists = customFilters.some((x) => x.id === f.id);
          update({
            customStreamFilters: exists
              ? customFilters.map((x) => (x.id === f.id ? f : x))
              : [...customFilters, f],
            activeStreamFilterId: f.id,
          });
          setBuilderOpen(false);
        }}
        onDelete={(id) => {
          update({
            customStreamFilters: customFilters.filter((x) => x.id !== id),
            ...(activeFilterId === id ? { activeStreamFilterId: null } : {}),
          });
          setBuilderOpen(false);
        }}
      />
    </div>
  );
}

function PendingAddonsPill({
  addons,
  streams,
  fallbackCount,
}: {
  addons: Addon[] | null;
  streams: ScoredStream[];
  fallbackCount: number;
}) {
  const t = useT();
  const pending = useMemo(() => {
    if (!addons || addons.length === 0) return [] as Addon[];
    const returned = new Set(streams.map((s) => s.addonId));
    return addons.filter((a) => {
      const id = a.manifest?.id;
      if (!id) return false;
      const hasStream = (a.manifest?.resources ?? []).some((r) =>
        typeof r === "string" ? r === "stream" : r.name === "stream",
      );
      if (!hasStream) return false;
      return !returned.has(id);
    });
  }, [addons, streams]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (pending.length <= 1) return;
    const t = window.setInterval(() => setTick((v) => v + 1), 1800);
    return () => window.clearInterval(t);
  }, [pending.length]);
  if (pending.length === 0 && fallbackCount === 0) return null;
  const current = pending.length > 0 ? pending[tick % pending.length] : null;
  return (
    <div className="pointer-events-none sticky bottom-3 z-10 mt-3 flex justify-center">
      <div
        key={current?.manifest?.id ?? "fallback"}
        className="pointer-events-auto inline-flex items-center gap-2.5 rounded-full border border-edge-soft bg-elevated/95 px-3 py-1.5 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.6)] backdrop-blur-md animate-in fade-in slide-in-from-bottom-1 duration-200"
      >
        <Spinner />
        {current ? (
          <PendingChip addon={current} />
        ) : (
          <span className="text-[12px] text-ink-muted">
            {fallbackCount > 0
              ? fallbackCount === 1
                ? t("{n} addon loading", { n: fallbackCount })
                : t("{n} addons loading", { n: fallbackCount })
              : t("Loading more sources")}
          </span>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span className="relative inline-block h-3 w-3">
      <span className="absolute inset-0 rounded-full border-[1.5px] border-edge" />
      <span className="absolute inset-0 animate-spin rounded-full border-[1.5px] border-transparent border-t-ink" />
    </span>
  );
}

function PendingChip({ addon }: { addon: Addon }) {
  const t = useT();
  const id = addon.manifest?.id ?? "";
  const name = addon.manifest?.name ?? id ?? "addon";
  const remoteLogo = resolveAddonLogo(addon.manifest?.logo, addon.transportUrl);
  const bundled = addonLogoSrc(id, name);
  const src = remoteLogo ?? bundled ?? null;
  return (
    <span className="flex items-center gap-2 text-[12px] text-ink">
      <span className="text-ink-subtle">{t("Waiting for")}</span>
      <span className="flex items-center gap-1.5">
        {src ? (
          <img src={src} alt="" className="h-4 w-4 rounded-sm object-contain" />
        ) : (
          <span className="flex h-4 w-4 items-center justify-center rounded-sm bg-raised text-[8.5px] font-semibold text-ink-muted">
            {name.slice(0, 1).toUpperCase()}
          </span>
        )}
        <span className="font-medium text-ink">{name}</span>
      </span>
    </span>
  );
}

function CircleLogo({
  addonId,
  addonName,
  logo,
}: {
  addonId: string | null;
  addonName: string;
  logo: string | null;
}) {
  const [remoteFailed, setRemoteFailed] = useState(false);
  if (addonId === null) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-elevated ring-1 ring-edge-soft">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect
            x="3"
            y="3"
            width="7"
            height="7"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="2"
            className="text-ink-muted"
          />
          <rect
            x="14"
            y="3"
            width="7"
            height="7"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="2"
            className="text-ink-muted"
          />
          <rect
            x="3"
            y="14"
            width="7"
            height="7"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="2"
            className="text-ink-muted"
          />
          <rect
            x="14"
            y="14"
            width="7"
            height="7"
            rx="1.5"
            stroke="currentColor"
            strokeWidth="2"
            className="text-ink-muted"
          />
        </svg>
      </div>
    );
  }
  const bundled = addonLogoSrc(addonId, addonName);
  const src = !remoteFailed && logo ? logo : bundled;
  if (!src) {
    const initial = (addonName || "?").trim().charAt(0).toUpperCase();
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-elevated text-[13px] font-bold text-ink-muted ring-1 ring-edge-soft">
        {initial}
      </div>
    );
  }
  return (
    <div className="flex h-9 w-9 shrink-0 overflow-hidden rounded-full bg-canvas ring-1 ring-edge-soft">
      <img
        src={src}
        alt={addonName}
        title={addonName}
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover"
        onError={() => {
          if (!remoteFailed && bundled) setRemoteFailed(true);
        }}
      />
    </div>
  );
}
