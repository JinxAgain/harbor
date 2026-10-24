import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/lib/auth";
import { anyProfileSharesStremioWith, useProfiles } from "@/lib/profiles";
import type { AddonRow } from "@/lib/addons";
import { loadAnimeAddonRows } from "@/lib/addons-anime-filter";
import { absorbCloudAnimeCw } from "@/lib/anime-cw-absorb";
import { detectAnimeForCw, useDetectedAnimeVersion } from "@/lib/anime-detect";
import { setExternalCwSources, useExternalCw } from "@/lib/feed/external-cw";
import { isCwDismissed, useCwDismissVersion } from "@/lib/cw-dismiss";
import { franchiseRoot, franchiseRootSync } from "@/lib/providers/anime-franchise-root";
import { publishResumeStates } from "@/lib/hover-preview/store";
import { runLanes } from "@/lib/run-lanes";
import { listLocalCw, localCwVersion, subscribeLocalCw } from "@/lib/local-cw";
import {
  manualWatchedLibraryItems,
  manualWatchedVersion,
  subscribeManualWatched,
} from "@/lib/manual-watched";
import { useSettings } from "@/lib/settings";
import { reconcileCwItem } from "@/lib/continue-watching";
import {
  ANIME_CLOUD_ID,
  cwSortKey,
  isAnimeCwItem,
  isCwMember,
  library,
  type LibraryItem,
} from "@/lib/stremio";

const CW_CAP = 20;
// Each root is a walk of up to eight sequential kitsu calls, and the pool this
// runs over is the whole anime library, not the capped row.
const ROOT_LANES = 4;
const SETTLE_MS = 150;
const SETTLE_CAP_MS = 650;

export type BpAnimeCwBase = {
  raw: LibraryItem[];
  libItems: LibraryItem[];
  resurfaceLibrary: LibraryItem[];
  addonRows: AddonRow[];
  manualWatchedVer: number;
  animeDetectVer: number;
  ready: boolean;
};

function localItems(privateOnly: boolean, sources: { library: boolean; local: boolean }): LibraryItem[] {
  return listLocalCw(privateOnly)
    .filter((e) => e.source === "library" ? sources.library : sources.local)
    .filter((e) => ANIME_CLOUD_ID.test(e.id) || e.isAnime)
    .map((e) => ({
      _id: e.id,
      type: e.type,
      name: e.name,
      poster: e.poster,
      background: e.background,
      isAnime: true,
      state: {
        timeOffset: e.positionMs,
        duration: e.durationMs,
        season: e.season,
        episode: e.episode,
        video_id: e.videoId,
        flaggedWatched: e.durationMs > 0 && e.positionMs / e.durationMs >= 0.9 ? 1 : 0,
        lastWatched: new Date(e.t).toISOString(),
      },
      removed: false,
      temp: false,
      _ctime: new Date(e.t).toISOString(),
      _mtime: new Date(e.t).toISOString(),
      local: true,
    }));
}

export function useBpAnimeCwBase(): BpAnimeCwBase {
  const { authKey } = useAuth();
  const { settings } = useSettings();
  const { activeProfile, profiles } = useProfiles();
  const hideSharedCw =
    settings.cwPerProfile && anyProfileSharesStremioWith(activeProfile, profiles);
  const cwVersion = useCwDismissVersion();
  const animeDetectVer = useDetectedAnimeVersion();
  const { cwSources } = settings;
  useEffect(() => {
    setExternalCwSources({ trakt: cwSources.trakt, simkl: cwSources.simkl });
  }, [cwSources.trakt, cwSources.simkl]);
  const trackerCw = useExternalCw(!hideSharedCw && (cwSources.trakt || cwSources.simkl));
  const localCwVer = useSyncExternalStore(subscribeLocalCw, localCwVersion);
  const manualWatchedVer = useSyncExternalStore(subscribeManualWatched, manualWatchedVersion);
  const [libItems, setLibItems] = useState<LibraryItem[]>([]);
  const [addonRows, setAddonRows] = useState<AddonRow[]>([]);
  const [rootVersion, setRootVersion] = useState(0);

  useEffect(() => {
    if (!authKey) {
      setLibItems([]);
      return;
    }
    const load = () => {
      library(authKey)
        .then((li) => {
          setLibItems(li);
          if (!hideSharedCw) absorbCloudAnimeCw(li);
        })
        .catch(() => setLibItems([]));
    };
    load();
    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [authKey, hideSharedCw]);

  // Catalogs do not depend on cwPerProfile, so this used to re-sweep every installed
  // addon whenever that toggle moved. Keyed on authKey alone, and the returned canceller
  // is what stops a stale sign-in's rows from landing after a switch.
  useEffect(() => {
    if (!authKey) {
      setAddonRows([]);
      return;
    }
    return loadAnimeAddonRows(authKey, setAddonRows);
  }, [authKey]);

  const localAnimeCw = useMemo<LibraryItem[]>(() => {
    void localCwVer;
    return localItems(hideSharedCw, cwSources);
  }, [localCwVer, hideSharedCw, activeProfile?.id, cwSources]);

  const pool = useMemo(
    () => [
      ...localAnimeCw,
      ...(hideSharedCw || !cwSources.library
        ? []
        : libItems.filter((i) => !ANIME_CLOUD_ID.test(i._id))),
      ...(hideSharedCw
        ? []
        : trackerCw.filter((i) =>
            i.external === "trakt" ? cwSources.trakt : i.external === "simkl" && cwSources.simkl,
          )),
    ],
    [localAnimeCw, libItems, trackerCw, hideSharedCw, cwSources],
  );

  const raw = useMemo(() => {
    void cwVersion;
    void animeDetectVer;
    void rootVersion;
    const lastWatchedOf = (i: LibraryItem) => {
      const w = i.state?.lastWatched;
      const lw = typeof w === "number" ? w : Date.parse(String(w ?? ""));
      if (Number.isFinite(lw) && lw > 0) return lw;
      const m = i._mtime as unknown;
      const mt = typeof m === "number" ? m : Date.parse(String(m ?? ""));
      return Number.isFinite(mt) ? mt : 0;
    };
    const eligible = pool.filter((i) => {
      if (!isCwMember(i)) return false;
      if (!i.local && !isAnimeCwItem(i)) return false;
      if (isCwDismissed(i)) return false;
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
    const seenRoot = new Set<string>();
    return [...byId.values()]
      .sort((a, b) => cwSortKey(b) - cwSortKey(a) || lastWatchedOf(b) - lastWatchedOf(a))
      .filter((i) => {
        const root = franchiseRootSync(i._id);
        if (!root) return true;
        if (seenRoot.has(root)) return false;
        seenRoot.add(root);
        return true;
      })
      .slice(0, CW_CAP);
  }, [pool, cwVersion, animeDetectVer, rootVersion, hideSharedCw]);

  // franchiseRootSync only answers once the walk is warm, so the collapse runs in
  // two phases or three seasons of one show sit in the row.
  useEffect(() => {
    const ids = pool
      .filter((i) => isCwMember(i) && (i.local || isAnimeCwItem(i)))
      .map((i) => i._id);
    if (ids.length === 0) return;
    if (ids.every((id) => franchiseRootSync(id))) return;
    let cancelled = false;
    void runLanes(ids, ROOT_LANES, (id) => franchiseRoot(id).catch(() => id)).then(() => {
      if (!cancelled) setRootVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [pool, animeDetectVer]);

  useEffect(() => {
    publishResumeStates(raw);
  }, [raw]);

  useEffect(() => {
    void detectAnimeForCw(libItems);
  }, [libItems]);

  const resurfaceLibrary = useMemo(() => {
    void manualWatchedVer;
    const base = [
      ...(hideSharedCw || !cwSources.library ? [] : libItems),
      ...localAnimeCw,
    ];
    const manual = manualWatchedLibraryItems().filter(isAnimeCwItem);
    if (manual.length === 0) return base;
    const memberIds = new Set(base.filter(isCwMember).map((i) => i._id));
    const usable = manual.filter((i) => !memberIds.has(i._id));
    if (usable.length === 0) return base;
    const overrideIds = new Set(usable.map((i) => i._id));
    return [...base.filter((i) => !overrideIds.has(i._id)), ...usable];
  }, [libItems, localAnimeCw, manualWatchedVer, hideSharedCw, cwSources.library]);

  const sig = raw
    .map((i) => `${i._id}:${i.state?.season ?? ""}:${i.state?.episode ?? ""}`)
    .join("|");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    const settle = window.setTimeout(() => setReady(true), SETTLE_MS);
    return () => window.clearTimeout(settle);
  }, [sig, ready]);
  useEffect(() => {
    const cap = window.setTimeout(() => setReady(true), SETTLE_CAP_MS);
    return () => window.clearTimeout(cap);
  }, []);

  return {
    raw,
    libItems,
    resurfaceLibrary,
    addonRows,
    manualWatchedVer,
    animeDetectVer,
    ready,
  };
}
