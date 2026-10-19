import { activeProfileId } from "@/lib/active-profile-id";
import type { WatchlistStatus } from "../list-status";

export type SimklCacheItem = {
  simklId: number;
  type: "movie" | "show" | "anime";
  animeType?: string | null;
  title: string;
  year: number | null;
  status: WatchlistStatus;
  userRating: number | null;
  watchedAt: string | null;
  watchedEpisodes?: string[];
  poster?: string | null;
  ids?: RawIds;
};

export type SimklCache = {
  lastSync: string | null;
  activities: {
    movies: string | null;
    shows: string | null;
    anime: string | null;
    ratings: string | null;
  } | null;
  items: Record<string, SimklCacheItem>;
  imdbToSimkl: Record<string, number>;
  tmdbToSimkl: Record<string, number>;
  malToSimkl: Record<string, number>;
  kitsuToSimkl: Record<string, number>;
};

export interface RawIds {
  simkl?: number;
  imdb?: string;
  tmdb?: number | string;
  tvdb?: number | string;
  mal?: number | string;
  anidb?: number | string;
  kitsu?: number | string;
  anilist?: number | string;
}

const CACHE_KEY_BASE = "harbor.simkl.cache.v2";
function cacheKey(): string {
  return `${CACHE_KEY_BASE}.${activeProfileId()}`;
}
let memoryCache: SimklCache | null = null;
let memoryCacheLoaded = false;
let memoryCacheProfile: string | null = null;
let writeTimeout: number | null = null;

export function getLocalCache(): SimklCache | null {
  const profile = activeProfileId();
  if (memoryCacheLoaded && memoryCacheProfile === profile) return memoryCache;
  memoryCache = null;
  memoryCacheProfile = profile;
  if (typeof window === "undefined" || typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(cacheKey());
    if (raw) memoryCache = JSON.parse(raw) as SimklCache;
  } catch (e) {
    console.error("Failed to parse SIMKL cache", e);
  }
  memoryCacheLoaded = true;
  return memoryCache;
}

export function saveLocalCache(cache: SimklCache) {
  const profile = activeProfileId();
  const key = cacheKey();
  memoryCache = cache;
  memoryCacheLoaded = true;
  memoryCacheProfile = profile;
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  if (writeTimeout !== null) return;
  writeTimeout = window.setTimeout(() => {
    writeTimeout = null;
    try {
      if (memoryCache && memoryCacheProfile === profile) {
        localStorage.setItem(key, JSON.stringify(memoryCache));
      }
    } catch (e) {
      console.error("Failed to save SIMKL cache asynchronously", e);
    }
  }, 1000);
}

export function clearLocalCache() {
  memoryCache = null;
  memoryCacheLoaded = true;
  memoryCacheProfile = activeProfileId();
  if (writeTimeout !== null) {
    window.clearTimeout(writeTimeout);
    writeTimeout = null;
  }
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(cacheKey());
  } catch (e) {
    console.error("Failed to clear SIMKL cache", e);
  }
}

export function resetForProfile() {
  memoryCache = null;
  memoryCacheLoaded = false;
  memoryCacheProfile = null;
  if (writeTimeout !== null) {
    window.clearTimeout(writeTimeout);
    writeTimeout = null;
  }
}

export function emptyCache(): SimklCache {
  return {
    lastSync: null,
    activities: null,
    items: {},
    imdbToSimkl: {},
    tmdbToSimkl: {},
    malToSimkl: {},
    kitsuToSimkl: {},
  };
}

export function indexItem(cache: SimklCache, item: SimklCacheItem, ids: RawIds | undefined) {
  if (!ids) return;
  item.ids = { ...item.ids, ...ids, simkl: item.simklId };
  const simklId = item.simklId;
  if (ids.imdb) {
    cache.imdbToSimkl[ids.imdb] = simklId;
  }
  if (ids.tmdb != null) {
    const tmdbKey = item.type === "movie" ? `movie:${ids.tmdb}` : `tv:${ids.tmdb}`;
    cache.tmdbToSimkl[tmdbKey] = simklId;
  }
  if (ids.mal != null) {
    cache.malToSimkl[String(ids.mal)] = simklId;
  }
  if (ids.kitsu != null) {
    cache.kitsuToSimkl[String(ids.kitsu)] = simklId;
  }
}

export function pruneItem(cache: SimklCache, simklId: number) {
  delete cache.items[String(simklId)];
  for (const key of Object.keys(cache.imdbToSimkl)) {
    if (cache.imdbToSimkl[key] === simklId) delete cache.imdbToSimkl[key];
  }
  for (const key of Object.keys(cache.tmdbToSimkl)) {
    if (cache.tmdbToSimkl[key] === simklId) delete cache.tmdbToSimkl[key];
  }
  for (const key of Object.keys(cache.malToSimkl)) {
    if (cache.malToSimkl[key] === simklId) delete cache.malToSimkl[key];
  }
  for (const key of Object.keys(cache.kitsuToSimkl)) {
    if (cache.kitsuToSimkl[key] === simklId) delete cache.kitsuToSimkl[key];
  }
}
