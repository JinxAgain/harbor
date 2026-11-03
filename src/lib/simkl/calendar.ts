import { safeFetch as fetch } from "@/lib/safe-fetch";
import type { CalendarItem } from "@/lib/calendar";
import { SIMKL_APP_NAME, SIMKL_APP_VERSION, SIMKL_CLIENT_ID } from "./config";
import {
  buildSimklUserEntries,
  matchSimklCdnToUserCalendar,
  parseSimklCalendar,
  type SimklCdnItem,
  type SimklUserEntry,
} from "./calendar-data";
import { invalidateSimklCalendarSnapshots } from "./calendar-snapshot";
export {
  buildSimklUserEntries,
  matchSimklCdnToUserCalendar,
  type SimklCdnItem,
  type SimklUserEntry,
};

const UA = `${SIMKL_APP_NAME}/${SIMKL_APP_VERSION}`;

function cdnUrl(path: string): string {
  return `https://data.simkl.in/calendar/v2/${path}?client_id=${SIMKL_CLIENT_ID}&app-name=${SIMKL_APP_NAME}&app-version=${SIMKL_APP_VERSION}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function mapCdnItem(item: SimklCdnItem, type: "tv" | "movie", isAnime: boolean): CalendarItem {
  const tmdbId = item.ids?.tmdb ? String(item.ids.tmdb) : null;
  const animeId =
    isAnime
      ? item.ids?.mal != null && String(item.ids.mal).trim() !== ""
        ? `mal:${item.ids.mal}`
        : item.ids?.kitsu != null && String(item.ids.kitsu).trim() !== ""
          ? `kitsu:${item.ids.kitsu}`
          : item.ids?.anilist != null && String(item.ids.anilist).trim() !== ""
            ? `anilist:${item.ids.anilist}`
            : null
      : null;
  const id =
    animeId ??
    item.ids?.imdb ??
    (tmdbId
      ? type === "movie"
        ? `tmdb:movie:${tmdbId}`
        : `tmdb:tv:${tmdbId}`
      : `simkl:${item.ids?.simkl_id}`);

  let name = item.title;
  const season = item.episode?.season ?? (isAnime && item.episode?.episode !== undefined ? 1 : undefined);
  if (type === "tv" && season !== undefined && item.episode?.episode !== undefined) {
    name = `${item.title} S${pad(season)}E${pad(item.episode.episode)}`;
  }

  const poster = item.poster ? `https://wsrv.nl/?url=https://simkl.in/posters/${item.poster}_m.webp&q=90` : null;

  return {
    id,
    imdbId: item.ids?.imdb ?? null,
    type,
    name,
    poster,
    background: null,
    releaseDate: (item.date ?? "").slice(0, 10),
    isAnime,
    overview: "",
    voteAverage: item.ratings?.simkl?.rating ?? item.ratings?.imdb?.rating ?? item.ratings?.mal?.rating ?? 0,
  };
}

const RAW_CACHE_TTL_MS = 30 * 60 * 1000;

interface RawCacheEntry {
  promise: Promise<SimklCdnItem[]>;
  timestamp: number;
}

export async function fetchSimklCdnRollingRaw(
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  const filename = catalog === "movie" ? "movie_release.json" : `${catalog}.json`;
  const res = await fetch(cdnUrl(filename), { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`SIMKL CDN rolling HTTP ${res.status}`);
  return parseSimklCalendar(await res.json());
}

export async function fetchSimklCdnArchiveRaw(
  year: number,
  month: number,
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  const filename = catalog === "movie" ? "movie_release.json" : `${catalog}.json`;
  const simklMonth = month + 1;
  const res = await fetch(cdnUrl(`${year}/${simklMonth}/${filename}`), {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`SIMKL CDN archive HTTP ${res.status}`);
  return parseSimklCalendar(await res.json());
}

export async function fetchSimklCdnRolling(catalog: "tv" | "anime" | "movie"): Promise<CalendarItem[]> {
  try {
    const data = await fetchSimklCdnRollingCached(catalog);
    const type = catalog === "movie" ? "movie" : "tv";
    return data.map((item) => mapCdnItem(item, type, catalog === "anime"));
  } catch {
    return [];
  }
}

export async function fetchSimklCdnArchive(
  year: number,
  month: number,
  catalog: "tv" | "anime" | "movie",
): Promise<CalendarItem[]> {
  try {
    const data = await fetchSimklCdnArchiveCached(year, month, catalog);
    const type = catalog === "movie" ? "movie" : "tv";
    return data.map((item) => mapCdnItem(item, type, catalog === "anime"));
  } catch {
    return [];
  }
}

const calendarCache = new Map<string, Promise<CalendarItem[]>>();
const rawArchiveCache = new Map<string, RawCacheEntry>();
const rawRollingCache = new Map<string, RawCacheEntry>();

export function fetchSimklCdnArchiveCached(
  year: number,
  month: number,
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  const key = `${year}-${month}-${catalog}`;
  const now = Date.now();
  const existing = rawArchiveCache.get(key);
  if (existing && now - existing.timestamp < RAW_CACHE_TTL_MS) {
    return existing.promise;
  }
  const promise = fetchSimklCdnArchiveRaw(year, month, catalog).catch((err) => {
    rawArchiveCache.delete(key);
    throw err;
  });
  rawArchiveCache.set(key, { promise, timestamp: now });
  return promise;
}

export function fetchSimklCdnRollingCached(
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  const now = Date.now();
  const existing = rawRollingCache.get(catalog);
  if (existing && now - existing.timestamp < RAW_CACHE_TTL_MS) {
    return existing.promise;
  }
  const promise = fetchSimklCdnRollingRaw(catalog).catch((err) => {
    rawRollingCache.delete(catalog);
    throw err;
  });
  rawRollingCache.set(catalog, { promise, timestamp: now });
  return promise;
}

export function fetchSimklCdnCalendar(year: number, month: number): Promise<CalendarItem[]> {
  const cacheKey = `${year}-${month}`;
  let p = calendarCache.get(cacheKey);
  if (!p) {
    p = Promise.all([
      fetchSimklCdnArchive(year, month, "tv"),
      fetchSimklCdnArchive(year, month, "anime"),
      fetchSimklCdnArchive(year, month, "movie"),
    ]).then(([tv, anime, movies]) => {
      const combined = [...tv, ...anime, ...movies];
      combined.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
      return combined;
    });
    calendarCache.set(cacheKey, p);
  }
  return p;
}

export function clearCalendarCache() {
  calendarCache.clear();
  rawArchiveCache.clear();
  rawRollingCache.clear();
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
}
