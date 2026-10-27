import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { anyProfileSharesStremioWith, useProfiles } from "@/lib/profiles";
import { useSettings } from "@/lib/settings";
import { listLocalCw, subscribeLocalCw } from "@/lib/local-cw";
import { setExternalCwSources } from "@/lib/feed/external-cw";
import { useExternalCw } from "@/lib/feed/external-cw";
import {
  ANIME_CLOUD_ID,
  cwMemberViaResume,
  cwSortKey,
  episodeFromVideoId,
  isCwMember,
  library,
  resumeSourceForItem,
  subscribeLibraryItemWrites,
  type ExternalCwSource,
  type LibraryItem,
} from "@/lib/stremio";

export type CwCard = {
  id: string;
  type: "movie" | "series";
  name: string;
  poster?: string;
  background?: string;
  season?: number;
  episode?: number;
  videoId?: string;
  progress: number;
  at: number;
};

export function localToLibraryItem(e: ReturnType<typeof listLocalCw>[number]): LibraryItem {
  return {
    _id: e.id,
    type: e.type,
    name: e.name,
    poster: e.poster,
    background: e.background,
    isAnime: e.isAnime,
    state: {
      timeOffset: e.positionMs,
      duration: e.durationMs,
      season: e.season,
      episode: e.episode,
      video_id:
        e.videoId ??
        (e.season != null && e.episode != null ? `${e.id}:${e.season}:${e.episode}` : undefined),
      flaggedWatched: e.durationMs > 0 && e.positionMs / e.durationMs >= 0.85 ? 1 : 0,
      lastWatched: new Date(e.t).toISOString(),
    },
    removed: false,
    temp: false,
    _ctime: new Date(e.t).toISOString(),
    _mtime: new Date(e.t).toISOString(),
    local: true,
  };
}

export function reconcileCwItem(
  existing: LibraryItem,
  candidate: LibraryItem,
  lastWatchedOf: (i: LibraryItem) => number,
): LibraryItem {
  const tExisting = lastWatchedOf(existing);
  const tCandidate = lastWatchedOf(candidate);
  const candidateIsExternal = candidate.external != null;
  const existingIsExternal = existing.external != null;

  if (candidateIsExternal !== existingIsExternal) {
    const ext = candidateIsExternal ? candidate : existing;
    const nonExt = candidateIsExternal ? existing : candidate;
    const tExt = candidateIsExternal ? tCandidate : tExisting;
    const tNonExt = candidateIsExternal ? tExisting : tCandidate;
    const sameTarget =
      nonExt.type === "movie" ||
      (ext.state?.season === nonExt.state?.season &&
        ext.state?.episode === nonExt.state?.episode);

    // Echo window: if external scrobble timestamp is within 60s of non-external local pause
    // on the same movie/episode, the local/non-external session wins.
    if (sameTarget ? tExt <= tNonExt + 60_000 : tExt <= tNonExt) {
      return nonExt;
    }

    // External genuinely newer on the same movie/episode: scale external progress onto nonExt's real duration
    const nonExtDur = sameTarget ? (nonExt.state?.duration ?? 0) : 0;
    if (nonExtDur > 0) {
      const extDur = ext.state?.duration ?? 0;
      const extOff = ext.state?.timeOffset ?? 0;
      const ratio = extDur > 0 ? extOff / extDur : 0;
      return {
        ...nonExt,
        state: {
          ...nonExt.state,
          duration: nonExtDur,
          timeOffset: Math.round(ratio * nonExtDur),
          flaggedWatched: ext.state?.flaggedWatched ?? 0,
          lastWatched: ext.state?.lastWatched ?? nonExt.state?.lastWatched,
          season: ext.state?.season ?? nonExt.state?.season,
          episode: ext.state?.episode ?? nonExt.state?.episode,
          video_id: ext.state?.video_id ?? nonExt.state?.video_id,
        },
        _mtime: ext._mtime ?? nonExt._mtime,
      };
    }
    return ext;
  }

  if (
    tCandidate > tExisting ||
    (candidate.local && !existing.local && tCandidate >= tExisting)
  ) {
    return candidate;
  }
  return existing;
}

function episodeOf(i: LibraryItem): { season: number; episode: number } | null {
  const season = i.state?.season;
  const episode = i.state?.episode;
  if (season && episode) return { season, episode };
  const vid = i.state?.video_id ?? "";
  if (/^(kitsu|mal|anilist|anidb):/.test(i._id) && vid.split(":").length === 3) {
    const ep = Number(vid.split(":")[2]);
    return Number.isFinite(ep) && ep > 0 ? { season: 1, episode: ep } : null;
  }
  const parsed = episodeFromVideoId(vid);
  return parsed && parsed.episode > 0 ? parsed : null;
}

function watchedAt(i: LibraryItem): number {
  const lw = i.state?.lastWatched ? Date.parse(i.state.lastWatched) : NaN;
  if (Number.isFinite(lw)) return lw;
  const m = i._mtime ? Date.parse(i._mtime) : NaN;
  return Number.isFinite(m) ? m : 0;
}

function toCard(i: LibraryItem): CwCard {
  const ep = i.type === "movie" ? null : episodeOf(i);
  const duration = i.state?.duration ?? 0;
  const offset = i.state?.timeOffset ?? 0;
  return {
    id: i._id,
    type: i.type === "movie" ? "movie" : "series",
    name: i.name,
    poster: i.poster,
    background: i.background,
    season: ep?.season,
    episode: ep?.episode,
    videoId: i.state?.video_id,
    progress: duration > 0 ? Math.min(1, offset / duration) : 0,
    at: watchedAt(i),
  };
}

const CW_RETRY_DELAYS_MS = [1000, 4000, 10000];
let cwCacheKey: string | null = null;
let cwCacheItems: LibraryItem[] = [];

export function useContinueWatching(excludeId?: string, limit = 12): CwCard[] {
  const { authKey } = useAuth();
  const { settings } = useSettings();
  const { activeProfile, profiles } = useProfiles();
  const hideSharedCw =
    settings.cwPerProfile && anyProfileSharesStremioWith(activeProfile, profiles);
  const cwSources = settings.cwSources;
  useEffect(() => {
    setExternalCwSources({ trakt: cwSources.trakt, simkl: cwSources.simkl });
  }, [cwSources.trakt, cwSources.simkl]);
  const externalCw = useExternalCw(!hideSharedCw && (cwSources.trakt || cwSources.simkl));
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [localVersion, setLocalVersion] = useState(0);

  useEffect(() => {
    if (!authKey) {
      setItems([]);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    let attempt = 0;
    if (cwCacheKey === authKey && cwCacheItems.length > 0) setItems(cwCacheItems);
    const load = () => {
      library(authKey)
        .then((li) => {
          cwCacheKey = authKey;
          cwCacheItems = li;
          attempt = 0;
          if (!cancelled) setItems(li);
        })
        .catch(() => {
          if (cancelled || attempt >= CW_RETRY_DELAYS_MS.length) return;
          const wait = CW_RETRY_DELAYS_MS[attempt];
          attempt += 1;
          timer = window.setTimeout(load, wait);
        });
    };
    load();
    const retryNow = () => {
      if (cancelled || cwCacheKey === authKey) return;
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
      attempt = 0;
      load();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") retryNow();
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [authKey]);

  useEffect(() => subscribeLocalCw(() => setLocalVersion((v) => v + 1)), []);
  useEffect(() => {
    if (typeof subscribeLibraryItemWrites !== "function") return;
    return subscribeLibraryItemWrites((updated) => {
      setItems((prev) => {
        const idx = prev.findIndex((i) => i._id === updated._id);
        return idx >= 0
          ? prev.map((i, k) => (k === idx ? updated : i))
          : [updated, ...prev];
      });
    });
  }, []);

  return useMemo(() => {
    void localVersion;
    const disabledSources = new Set<ExternalCwSource>();
    if (!cwSources.simkl) disabledSources.add("simkl");
    if (!cwSources.trakt) disabledSources.add("trakt");
    const base = hideSharedCw
      ? []
      : [
          ...(cwSources.library ? items.filter((i) => !ANIME_CLOUD_ID.test(i._id)) : []),
          ...externalCw.filter((i) => !(i.external && disabledSources.has(i.external))),
        ];
    const local = listLocalCw(hideSharedCw).filter((e) =>
      e.source === "library" ? cwSources.library : cwSources.local,
    );
    const merged = [...base, ...local.map(localToLibraryItem)]
      .filter((i) => {
        if ((i.type as string) === "other" || i._id.startsWith("iptv:")) return false;
        if (!isCwMember(i)) return false;
        // A disabled source's backfilled resume entry must not resurrect library cards.
        if (disabledSources.size > 0 && cwMemberViaResume(i)) {
          const src = resumeSourceForItem(i);
          if (src && disabledSources.has(src)) return false;
        }
        return true;
      })
      .map((i) => ({ i, k: cwSortKey(i) }))
      .sort(
        (a, b) =>
          b.k - a.k ||
          watchedAt(b.i) - watchedAt(a.i) ||
          (b.i.local ? 1 : 0) - (a.i.local ? 1 : 0),
      )
      .map((e) => e.i);
    const byId = new Map<string, LibraryItem>();
    for (const i of merged) {
      if (i._id === excludeId) continue;
      const existing = byId.get(i._id);
      if (existing) {
        const winner = reconcileCwItem(existing, i, watchedAt);
        if (winner !== existing) {
          byId.set(i._id, winner);
        }
        continue;
      }
      byId.set(i._id, i);
    }
    const out: CwCard[] = [];
    for (const i of byId.values()) {
      out.push(toCard(i));
      if (out.length >= limit) break;
    }
    return out;
  }, [items, externalCw, localVersion, excludeId, limit, hideSharedCw, cwSources, activeProfile?.id]);
}
