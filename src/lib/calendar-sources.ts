import { meta as cinemetaMeta } from "./cinemeta";
import {
  fetchAnticipatedMovies,
  fetchAnticipatedShows,
  fetchUpcomingEpisodes,
  fetchUpcomingMovies,
} from "./trakt/calendar";
import type { CalendarItem } from "./calendar";
import { localDateTimeFromIso } from "./calendar-time";
import { resolveSavedCalendar, type SavedCandidate } from "./calendar-library";
import {
  fetchHoldItems,
  fetchWatchlist as fetchSimklWatchlist,
  fetchWatchingItems,
} from "./simkl/watchlist";
import {
  buildSimklUserEntries,
  fetchSimklCdnArchiveCached,
  fetchSimklCdnCalendar,
  fetchSimklCdnRollingCached,
  matchSimklCdnToUserCalendar,
  type SimklCdnItem,
  type SimklUserEntry,
} from "./simkl/calendar";
import { getLocalCache, syncWatchlistCache } from "./simkl/activities";
import { isAuthenticated as simklConnected } from "./simkl/session";
import { fetchAniListAiringCalendar as fetchAniListAiring } from "./anilist/airing";
import { fetchDubSchedule } from "./providers/anime-dub-sub";

export { fetchLibraryCalendar } from "./calendar-library";
export { buildSimklUserEntries, matchSimklCdnToUserCalendar, type SimklUserEntry };

interface CacheEntry {
  items: CalendarItem[];
  timestamp: number;
}

const calendarCache = new Map<string, CacheEntry>();
const calendarInFlight = new Map<string, Promise<CalendarItem[]>>();
const CACHE_STALE_MS = 30 * 60 * 1000;

function withCalendarCache(
  cacheKey: string,
  fetcher: () => Promise<CalendarItem[]>,
): Promise<CalendarItem[]> {
  const cached = calendarCache.get(cacheKey);
  const now = Date.now();

  if (cached) {
    if (now - cached.timestamp >= CACHE_STALE_MS) {
      if (!calendarInFlight.has(cacheKey)) {
        const promise = fetcher()
          .then((items) => {
            calendarCache.set(cacheKey, { items, timestamp: Date.now() });
            return items;
          })
          .catch(() => cached.items)
          .finally(() => {
            calendarInFlight.delete(cacheKey);
          });
        calendarInFlight.set(cacheKey, promise);
      }
    }
    return Promise.resolve(cached.items);
  }

  if (calendarInFlight.has(cacheKey)) {
    return calendarInFlight.get(cacheKey)!;
  }

  const promise = fetcher()
    .then((items) => {
      calendarCache.set(cacheKey, { items, timestamp: Date.now() });
      return items;
    })
    .finally(() => {
      calendarInFlight.delete(cacheKey);
    });
  calendarInFlight.set(cacheKey, promise);
  return promise;
}

export function clearCalendarSourceCache() {
  calendarCache.clear();
  calendarInFlight.clear();
}

export async function fetchSimklPremieresCalendar(
  year: number,
  month: number,
): Promise<CalendarItem[]> {
  const cacheKey = `simkl-premieres:${year}-${month}`;
  return withCalendarCache(cacheKey, () => fetchSimklCdnCalendar(year, month).catch(() => []));
}

export async function fetchAniListAiringCalendar(
  year: number,
  month: number,
): Promise<CalendarItem[]> {
  const cacheKey = `anilist-airing:${year}-${month}`;
  return withCalendarCache(cacheKey, () => fetchAniListAiring(year, month).catch(() => []));
}

export async function fetchAnimeDubCalendar(year: number, month: number): Promise<CalendarItem[]> {
  const cacheKey = `anime-dub:${year}-${month}`;
  return withCalendarCache(cacheKey, () => mapDubFeedToCalendar(year, month).catch(() => []));
}

async function mapDubFeedToCalendar(year: number, month: number): Promise<CalendarItem[]> {
  const entries = await fetchDubSchedule();
  const out: CalendarItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const media = e?.media?.media;
    if (!media) continue;
    if (media.isAdult) continue;
    if (media.format === "MOVIE" || e.episodeNumber == null) continue;
    const { date: dateISO, time, atMs } = localDateTimeFromIso(e.episodeDate);
    if (!inMonth(dateISO, year, month)) continue;
    const title =
      media.title?.english?.trim() ||
      media.title?.romaji?.trim() ||
      e.english?.trim() ||
      e.romaji?.trim() ||
      "Untitled";
    const baseId = media.idMal != null ? `mal:${media.idMal}` : `anilist:${media.id}`;
    const id = `${baseId}:1:${e.episodeNumber}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      imdbId: null,
      type: "tv",
      name: `${title} S1E${pad(e.episodeNumber)}`,
      poster: media.coverImage?.extraLarge ?? media.coverImage?.medium ?? null,
      background: media.bannerImage ?? null,
      releaseDate: dateISO,
      releaseTime: time,
      releaseAtMs: atMs,
      isAnime: true,
      overview: "",
      voteAverage: 0,
    });
  }
  out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return out;
}

async function fetchSimklMonthCdnCatalog(
  year: number,
  month: number,
  catalog: "tv" | "anime" | "movie",
): Promise<SimklCdnItem[]> {
  const prevDate = new Date(year, month - 1, 1);
  const nextDate = new Date(year, month + 1, 1);
  const today = new Date();
  const monthDiff = (year - today.getFullYear()) * 12 + (month - today.getMonth());
  const tasks: Promise<SimklCdnItem[]>[] = [
    fetchSimklCdnArchiveCached(year, month, catalog).catch(() => []),
    fetchSimklCdnArchiveCached(prevDate.getFullYear(), prevDate.getMonth(), catalog).catch(
      () => [],
    ),
    fetchSimklCdnArchiveCached(nextDate.getFullYear(), nextDate.getMonth(), catalog).catch(
      () => [],
    ),
  ];
  if (monthDiff >= -1 && monthDiff <= 1) {
    tasks.push(fetchSimklCdnRollingCached(catalog).catch(() => []));
  }
  const batches = await Promise.all(tasks);
  const seen = new Set<string>();
  const out: SimklCdnItem[] = [];
  for (const batch of batches) {
    for (const item of batch) {
      const sId = item.ids?.simkl_id ?? item.title;
      const epKey =
        item.episode?.episode !== undefined
          ? `${item.episode.season ?? 1}:${item.episode.episode}`
          : "movie";
      const key = `${catalog}:${sId}:${epKey}:${(item.date ?? "").slice(0, 10)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

export async function fetchSimklCalendar(
  year: number,
  month: number,
  opts: { tmdbKey: string },
): Promise<CalendarItem[]> {
  if (!simklConnected()) return [];
  const cacheKey = `simkl-calendar:${year}-${month}`;
  return withCalendarCache(cacheKey, async () => {
    const [cache, watchlist, watching, hold, cdnTv, cdnAnime, cdnMovie] = await Promise.all([
      syncWatchlistCache().catch(() => getLocalCache()),
      fetchSimklWatchlist().catch(() => []),
      fetchWatchingItems().catch(() => []),
      fetchHoldItems().catch(() => []),
      fetchSimklMonthCdnCatalog(year, month, "tv"),
      fetchSimklMonthCdnCatalog(year, month, "anime"),
      fetchSimklMonthCdnCatalog(year, month, "movie"),
    ]);

    const userEntries = buildSimklUserEntries(cache, [...watching, ...watchlist, ...hold]);
    if (userEntries.length === 0) return [];

    const { items: cdnMatched, matchedKeys } = matchSimklCdnToUserCalendar(
      year,
      month,
      { tv: cdnTv, anime: cdnAnime, movie: cdnMovie },
      userEntries,
    );

    const candidates: SavedCandidate[] = [];
    const seenCandidateIds = new Set<string>();
    for (const entry of userEntries) {
      if (entry.status !== "watching" && entry.status !== "plantowatch") continue;
      if (entry.simklId != null && matchedKeys.has(`simkl:${entry.simklId}`)) continue;
      const id =
        entry.category === "anime"
          ? (entry.ids.mal ? `mal:${entry.ids.mal}` : null) ??
            (entry.ids.kitsu ? `kitsu:${entry.ids.kitsu}` : null) ??
            (entry.ids.anilist ? `anilist:${entry.ids.anilist}` : null)
          : entry.ids.imdb ??
            (entry.ids.tmdb
              ? entry.category === "movie"
                ? `tmdb:movie:${entry.ids.tmdb}`
                : `tmdb:tv:${entry.ids.tmdb}`
              : null);
      if (!id || matchedKeys.has(id) || seenCandidateIds.has(id)) continue;
      seenCandidateIds.add(id);
      const ts = entry.watchedAt ? Date.parse(entry.watchedAt) || 0 : 0;
      const priorityBoost = entry.status === "watching" ? 1e13 : 0;
      candidates.push({
        id,
        type: entry.category === "movie" ? "movie" : "series",
        name: entry.title,
        mtime: priorityBoost + ts,
        temp: false,
      });
    }

    if (candidates.length === 0) {
      cdnMatched.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
      return cdnMatched;
    }

    const fallbackItems = await resolveSavedCalendar(candidates, year, month, opts).catch(
      () => [] as CalendarItem[],
    );
    const combined = [...cdnMatched];
    const seenKeys = new Set<string>();
    for (const item of cdnMatched) {
      const ep = item.name.match(/\sS(\d+)E(\d+)/i);
      const show = ep ? item.name.slice(0, item.name.indexOf(ep[0])) : item.name;
      const norm = show.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const key = ep
        ? `tv|${norm}|s${Number(ep[1])}e${Number(ep[2])}|${item.releaseDate}`
        : `movie|${norm}|${item.releaseDate}`;
      seenKeys.add(key);
      seenKeys.add(item.id);
    }
    for (const item of fallbackItems) {
      const ep = item.name.match(/\sS(\d+)E(\d+)/i);
      const show = ep ? item.name.slice(0, item.name.indexOf(ep[0])) : item.name;
      const norm = show.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const key = ep
        ? `tv|${norm}|s${Number(ep[1])}e${Number(ep[2])}|${item.releaseDate}`
        : `movie|${norm}|${item.releaseDate}`;
      if (seenKeys.has(key) || seenKeys.has(item.id)) continue;
      seenKeys.add(key);
      seenKeys.add(item.id);
      combined.push(item);
    }
    combined.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
    return combined;
  });
}

const TRAKT_MAX_FORWARD_MONTHS = 6;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function inMonth(iso: string, year: number, month: number): boolean {
  if (!iso) return false;
  const [y, m] = iso.split("-").map(Number);
  return y === year && (m ?? 0) - 1 === month;
}

function isAnimationGenre(genres: string[] | undefined): boolean {
  if (!genres) return false;
  const wanted = ["animation", "anime"];
  return genres.some((g) => wanted.includes(g.toLowerCase()));
}

export async function fetchTraktCalendar(year: number, month: number): Promise<CalendarItem[]> {
  const today = new Date();
  const cur = new Date(year, month, 1);
  const fwdMonths =
    (cur.getFullYear() - today.getFullYear()) * 12 + (cur.getMonth() - today.getMonth());
  if (fwdMonths < 0 || fwdMonths > TRAKT_MAX_FORWARD_MONTHS) return [];
  const days = Math.max(31, (fwdMonths + 1) * 31);
  const [eps, mvs] = await Promise.all([fetchUpcomingEpisodes(days), fetchUpcomingMovies(days)]);

  const epsInMonth = eps
    .map((ep) => ({ ep, ...localDateTimeFromIso(ep.airDate) }))
    .filter((x) => inMonth(x.date, year, month));
  const mvsInMonth = mvs
    .map((m) => ({ m, ...localDateTimeFromIso(m.contextDate) }))
    .filter((x) => inMonth(x.date, year, month));

  const showIds = [
    ...new Set(epsInMonth.map((x) => x.ep.ids.imdb).filter((x): x is string => !!x)),
  ];
  const movieIds = [
    ...new Set(mvsInMonth.map((x) => x.m.ids.imdb).filter((x): x is string => !!x)),
  ];
  const [showMetas, movieMetas] = await Promise.all([
    Promise.all(showIds.map((id) => cinemetaMeta("series", id).catch(() => null))),
    Promise.all(movieIds.map((id) => cinemetaMeta("movie", id).catch(() => null))),
  ]);
  const showMeta = new Map(showIds.map((id, i) => [id, showMetas[i]] as const));
  const movieMeta = new Map(movieIds.map((id, i) => [id, movieMetas[i]] as const));

  const out: CalendarItem[] = [];
  for (const { ep, date, time, atMs } of epsInMonth) {
    const imdb = ep.ids.imdb ?? null;
    const meta = imdb ? (showMeta.get(imdb) ?? null) : null;
    const baseId = imdb ?? `trakt:${ep.ids.tmdb ?? ep.ids.tvdb ?? ep.title}`;
    const epLabel = `S${pad(ep.season)}E${pad(ep.number)}`;
    const vid = meta?.videos?.find(
      (v) => (v.season ?? 0) === ep.season && (v.episode ?? v.number ?? 0) === ep.number,
    );
    out.push({
      id: `${baseId}:${ep.season}:${ep.number}`,
      imdbId: imdb,
      type: "tv",
      name: ep.episodeTitle
        ? `${ep.title} ${epLabel}: ${ep.episodeTitle}`
        : `${ep.title} ${epLabel}`,
      poster: meta?.poster ?? vid?.thumbnail ?? null,
      background: meta?.background ?? null,
      releaseDate: date,
      releaseTime: time,
      releaseAtMs: atMs,
      isAnime: isAnimationGenre(meta?.genres),
      overview: meta?.description ?? "",
      voteAverage: parseFloat(meta?.imdbRating ?? "0") || 0,
    });
  }
  for (const { m, date, time, atMs } of mvsInMonth) {
    const imdb = m.ids.imdb ?? null;
    const meta = imdb ? (movieMeta.get(imdb) ?? null) : null;
    const id = imdb ?? `trakt:${m.ids.tmdb ?? m.title}`;
    out.push({
      id,
      imdbId: imdb,
      type: "movie",
      name: m.title,
      poster: meta?.poster ?? null,
      background: meta?.background ?? null,
      releaseDate: date,
      releaseTime: time,
      releaseAtMs: atMs,
      isAnime: isAnimationGenre(meta?.genres),
      overview: meta?.description ?? "",
      voteAverage: parseFloat(meta?.imdbRating ?? "0") || 0,
    });
  }
  out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return out;
}

export async function fetchAnticipatedCalendar(
  year: number,
  month: number,
): Promise<CalendarItem[]> {
  const [shows, mvs] = await Promise.all([fetchAnticipatedShows(), fetchAnticipatedMovies()]);
  const inMonthShows = shows.filter((s) => inMonth(s.firstAired, year, month));
  const inMonthMovies = mvs.filter((m) => inMonth(m.released, year, month));
  const [showMetas, movieMetas] = await Promise.all([
    Promise.all(
      inMonthShows.map((s) =>
        s.ids.imdb ? cinemetaMeta("series", s.ids.imdb).catch(() => null) : Promise.resolve(null),
      ),
    ),
    Promise.all(
      inMonthMovies.map((m) =>
        m.ids.imdb ? cinemetaMeta("movie", m.ids.imdb).catch(() => null) : Promise.resolve(null),
      ),
    ),
  ]);
  const out: CalendarItem[] = [];
  for (let i = 0; i < inMonthShows.length; i++) {
    const s = inMonthShows[i];
    const meta = showMetas[i];
    const id = s.ids.imdb ?? `trakt:${s.ids.tmdb ?? s.ids.tvdb ?? s.title}`;
    out.push({
      id: `${id}:premiere`,
      imdbId: s.ids.imdb ?? null,
      type: "tv",
      name: `${s.title} (premiere)`,
      poster: meta?.poster ?? s.poster,
      background: meta?.background ?? null,
      releaseDate: s.firstAired,
      isAnime: false,
      overview: meta?.description ?? s.overview,
      voteAverage: parseFloat(meta?.imdbRating ?? "0") || 0,
    });
  }
  for (let i = 0; i < inMonthMovies.length; i++) {
    const m = inMonthMovies[i];
    const meta = movieMetas[i];
    const id = m.ids.imdb ?? `trakt:${m.ids.tmdb ?? m.title}`;
    out.push({
      id,
      imdbId: m.ids.imdb ?? null,
      type: "movie",
      name: m.title,
      poster: meta?.poster ?? m.poster,
      background: meta?.background ?? null,
      releaseDate: m.released,
      isAnime: false,
      overview: meta?.description ?? m.overview,
      voteAverage: parseFloat(meta?.imdbRating ?? "0") || 0,
    });
  }
  out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));
  return out;
}
