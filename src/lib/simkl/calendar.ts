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

export async function fetchSimklCdnRollingRaw(
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  const filename = catalog === "movie" ? "movie_release.json" : `${catalog}.json`;
  try {
    const res = await fetch(cdnUrl(filename), { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    return parseSimklCalendar(await res.json());
  } catch {
    return [];
  }
}

export async function fetchSimklCdnArchiveRaw(
  year: number,
  month: number,
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  const filename = catalog === "movie" ? "movie_release.json" : `${catalog}.json`;
  const simklMonth = month + 1;
  try {
    const res = await fetch(cdnUrl(`${year}/${simklMonth}/${filename}`), {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return [];
    return parseSimklCalendar(await res.json());
  } catch {
    return [];
  }
}

export async function fetchSimklCdnRolling(catalog: "tv" | "anime" | "movie"): Promise<CalendarItem[]> {
  const data = await fetchSimklCdnRollingRaw(catalog);
  const type = catalog === "movie" ? "movie" : "tv";
  return data.map((item) => mapCdnItem(item, type, catalog === "anime"));
}

export async function fetchSimklCdnArchive(
  year: number,
  month: number,
  catalog: "tv" | "anime" | "movie",
): Promise<CalendarItem[]> {
  const data = await fetchSimklCdnArchiveRaw(year, month, catalog);
  const type = catalog === "movie" ? "movie" : "tv";
  return data.map((item) => mapCdnItem(item, type, catalog === "anime"));
}

const calendarCache = new Map<string, Promise<CalendarItem[]>>();
const rawArchiveCache = new Map<string, Promise<SimklCdnItem[]>>();
const rawRollingCache = new Map<string, Promise<SimklCdnItem[]>>();

export function fetchSimklCdnArchiveCached(
  year: number,
  month: number,
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  const key = `${year}-${month}-${catalog}`;
  let p = rawArchiveCache.get(key);
  if (!p) {
    p = fetchSimklCdnArchiveRaw(year, month, catalog);
    rawArchiveCache.set(key, p);
  }
  return p;
}

export function fetchSimklCdnRollingCached(
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  let p = rawRollingCache.get(catalog);
  if (!p) {
    p = fetchSimklCdnRollingRaw(catalog);
    rawRollingCache.set(catalog, p);
  }
  return p;
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
}
