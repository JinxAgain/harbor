import type { CalendarItem } from "../calendar";
import { localDateTimeFromIso } from "../calendar-time";
import type { SimklCache } from "./activities/store";

export type SimklCdnItem = {
  title: string;
  title_romaji?: string | null;
  poster?: string | null;
  fanart?: string | null;
  date: string;
  release_date?: string | null;
  anime_type?: string | null;
  genres?: string[];
  ratings?: {
    simkl?: { rating?: number | null; votes?: number | null };
    imdb?: { rating?: number | null; votes?: number | null };
    mal?: { rating?: number | null; votes?: number | null };
  };
  ids?: {
    simkl_id?: number;
    slug?: string;
    tmdb?: string | number;
    tvdb?: string | number;
    imdb?: string;
    mal?: string | number;
    anidb?: string | number;
    anilist?: string | number;
    kitsu?: string | number;
  };
  episode?: {
    season?: number;
    episode?: number;
    title?: string | null;
    runtime?: number | null;
    url?: string;
  };
};

export type SimklUserEntry = {
  simklId?: number;
  category: "movie" | "show" | "anime";
  status: string;
  title: string;
  poster?: string | null;
  watchedAt?: string | null;
  ids: {
    simkl?: number;
    imdb?: string;
    tmdb?: string;
    tvdb?: string;
    mal?: string;
    anidb?: string;
    anilist?: string;
    kitsu?: string;
  };
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// V2 stores shared title metadata once and joins each airing by its Simkl ID.
export function parseSimklCalendar(data: unknown): SimklCdnItem[] {
  const payload = record(data);
  const metadata = record(payload?.metadata);
  if (!Array.isArray(payload?.calendar) || !metadata) return [];
  const items: SimklCdnItem[] = [];
  for (const value of payload.calendar) {
    const entry = record(value);
    const id = entry?.simkl_id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;
    const show = record(metadata[String(id)]);
    if (!show || typeof show.title !== "string" || !show.title.trim()) continue;
    if (typeof entry?.date !== "string" || !Number.isFinite(Date.parse(entry.date))) continue;
    items.push({
      ...(show as Omit<SimklCdnItem, "date">),
      ids: { ...record(show.ids), simkl_id: id },
      date: entry.date,
      episode: record(entry.episode) ?? undefined,
    });
  }
  return items;
}

function cleanId(v: string | number | undefined | null): string | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s !== "" && s !== "0" ? s : undefined;
}

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

function isGenericEpisodeTitle(title: string | null | undefined, epNum: number | undefined): boolean {
  if (!title) return true;
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (/^(tba|tbd|n\/a|unknown)$/i.test(trimmed)) return true;
  if (epNum !== undefined && new RegExp(`^episode\\s*0*${epNum}$`, "i").test(trimmed)) return true;
  return false;
}

export function buildSimklUserEntries(
  cache: SimklCache | null,
  lists: Array<{
    type: "movie" | "show";
    category?: "movie" | "show" | "anime";
    status?: string;
    title: string;
    ids: {
      simkl?: number;
      imdb?: string;
      tmdb?: number | string;
      tvdb?: number;
      mal?: number;
      anidb?: number;
      kitsu?: number;
      anilist?: number;
    };
    watchedAt?: string;
  }>,
): SimklUserEntry[] {
  const byKey = new Map<string, SimklUserEntry>();

  const statusRank = (s: string): number => {
    if (s === "watching") return 4;
    if (s === "plantowatch") return 3;
    if (s === "hold") return 2;
    if (s === "completed") return 1;
    return 0;
  };

  const mergeEntry = (entry: SimklUserEntry) => {
    if (entry.status === "dropped") return;
    const key =
      entry.simklId != null
        ? `simkl:${entry.simklId}`
        : entry.ids.imdb
          ? `${entry.category}:imdb:${entry.ids.imdb}`
          : entry.ids.tmdb
            ? `${entry.category}:tmdb:${entry.ids.tmdb}`
            : entry.ids.mal
              ? `anime:mal:${entry.ids.mal}`
              : entry.ids.kitsu
                ? `anime:kitsu:${entry.ids.kitsu}`
                : entry.ids.anilist
                  ? `anime:anilist:${entry.ids.anilist}`
                  : null;
    if (!key) return;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, entry);
      return;
    }
    byKey.set(key, {
      simklId: prev.simklId ?? entry.simklId,
      category: prev.category,
      status: statusRank(entry.status) > statusRank(prev.status) ? entry.status : prev.status,
      title: prev.title || entry.title,
      poster: prev.poster ?? entry.poster,
      watchedAt:
        prev.watchedAt && entry.watchedAt
          ? prev.watchedAt > entry.watchedAt
            ? prev.watchedAt
            : entry.watchedAt
          : (prev.watchedAt ?? entry.watchedAt),
      ids: {
        simkl: prev.ids.simkl ?? entry.ids.simkl,
        imdb: prev.ids.imdb ?? entry.ids.imdb,
        tmdb: prev.ids.tmdb ?? entry.ids.tmdb,
        tvdb: prev.ids.tvdb ?? entry.ids.tvdb,
        mal: prev.ids.mal ?? entry.ids.mal,
        anidb: prev.ids.anidb ?? entry.ids.anidb,
        anilist: prev.ids.anilist ?? entry.ids.anilist,
        kitsu: prev.ids.kitsu ?? entry.ids.kitsu,
      },
    });
  };

  if (cache) {
    const revImdb = new Map<number, string>();
    for (const [imdb, sId] of Object.entries(cache.imdbToSimkl)) revImdb.set(sId, imdb);
    const revTmdb = new Map<number, string>();
    for (const [tmdbKey, sId] of Object.entries(cache.tmdbToSimkl)) {
      const parts = tmdbKey.split(":");
      if (parts.length === 2) revTmdb.set(sId, parts[1]);
    }
    const revMal = new Map<number, string>();
    for (const [mal, sId] of Object.entries(cache.malToSimkl)) revMal.set(sId, mal);
    const revKitsu = new Map<number, string>();
    for (const [kitsu, sId] of Object.entries(cache.kitsuToSimkl)) revKitsu.set(sId, kitsu);

    for (const item of Object.values(cache.items)) {
      if (item.status === "dropped") continue;
      const sId = item.simklId;
      const category: "movie" | "show" | "anime" =
        item.type === "anime"
          ? item.animeType === "movie"
            ? "movie"
            : "anime"
          : item.type;
      mergeEntry({
        simklId: sId,
        category,
        status: item.status,
        title: item.title,
        poster: item.poster,
        watchedAt: item.watchedAt,
        ids: {
          simkl: sId,
          imdb: cleanId(item.ids?.imdb) ?? (category !== "anime" ? revImdb.get(sId) : undefined),
          tmdb: cleanId(item.ids?.tmdb) ?? (category !== "anime" ? revTmdb.get(sId) : undefined),
          tvdb: cleanId(item.ids?.tvdb),
          mal: cleanId(item.ids?.mal) ?? revMal.get(sId),
          anidb: cleanId(item.ids?.anidb),
          anilist: cleanId(item.ids?.anilist),
          kitsu: cleanId(item.ids?.kitsu) ?? revKitsu.get(sId),
        },
      });
    }
  }

  for (const it of lists) {
    const hasAnimeId =
      it.ids.mal != null || it.ids.anidb != null || it.ids.kitsu != null || it.ids.anilist != null;
    const category: "movie" | "show" | "anime" =
      it.category === "anime"
        ? it.type === "movie"
          ? "movie"
          : "anime"
        : it.category ?? (it.type === "movie" ? "movie" : hasAnimeId ? "anime" : "show");
    mergeEntry({
      simklId: it.ids.simkl,
      category,
      status: it.status ?? "watching",
      title: it.title,
      watchedAt: it.watchedAt ?? null,
      ids: {
        simkl: it.ids.simkl,
        imdb: cleanId(it.ids.imdb),
        tmdb: cleanId(it.ids.tmdb),
        tvdb: cleanId(it.ids.tvdb),
        mal: cleanId(it.ids.mal),
        anidb: cleanId(it.ids.anidb),
        anilist: cleanId(it.ids.anilist),
        kitsu: cleanId(it.ids.kitsu),
      },
    });
  }

  return Array.from(byKey.values());
}

export function matchSimklCdnToUserCalendar(
  year: number,
  month: number,
  cdn: { tv: SimklCdnItem[]; anime: SimklCdnItem[]; movie: SimklCdnItem[] },
  entries: SimklUserEntry[],
): { items: CalendarItem[]; matchedKeys: Set<string> } {
  const bySimklId = new Map<number, SimklUserEntry>();
  const tvByImdb = new Map<string, SimklUserEntry>();
  const tvByTmdb = new Map<string, SimklUserEntry>();
  const tvByTvdb = new Map<string, SimklUserEntry>();
  const movieByImdb = new Map<string, SimklUserEntry>();
  const movieByTmdb = new Map<string, SimklUserEntry>();
  const animeByMal = new Map<string, SimklUserEntry>();
  const animeByAnidb = new Map<string, SimklUserEntry>();
  const animeByAnilist = new Map<string, SimklUserEntry>();
  const animeByKitsu = new Map<string, SimklUserEntry>();

  for (const e of entries) {
    if (e.simklId != null) bySimklId.set(e.simklId, e);
    if (e.category === "show") {
      if (e.ids.imdb) tvByImdb.set(e.ids.imdb, e);
      if (e.ids.tmdb) tvByTmdb.set(e.ids.tmdb, e);
      if (e.ids.tvdb) tvByTvdb.set(e.ids.tvdb, e);
    } else if (e.category === "movie") {
      if (e.ids.imdb) movieByImdb.set(e.ids.imdb, e);
      if (e.ids.tmdb) movieByTmdb.set(e.ids.tmdb, e);
      if (e.ids.mal) animeByMal.set(e.ids.mal, e);
      if (e.ids.anidb) animeByAnidb.set(e.ids.anidb, e);
      if (e.ids.anilist) animeByAnilist.set(e.ids.anilist, e);
      if (e.ids.kitsu) animeByKitsu.set(e.ids.kitsu, e);
    } else if (e.category === "anime") {
      if (e.ids.mal) animeByMal.set(e.ids.mal, e);
      if (e.ids.anidb) animeByAnidb.set(e.ids.anidb, e);
      if (e.ids.anilist) animeByAnilist.set(e.ids.anilist, e);
      if (e.ids.kitsu) animeByKitsu.set(e.ids.kitsu, e);
    }
  }

  const matchedKeys = new Set<string>();
  const markMatched = (e: SimklUserEntry) => {
    if (e.simklId != null) matchedKeys.add(`simkl:${e.simklId}`);
    if (e.ids.imdb) matchedKeys.add(`imdb:${e.ids.imdb}`);
    if (e.ids.tmdb) matchedKeys.add(`tmdb:${e.category === "movie" ? "movie" : "tv"}:${e.ids.tmdb}`);
    if (e.ids.mal) matchedKeys.add(`mal:${e.ids.mal}`);
    if (e.ids.kitsu) matchedKeys.add(`kitsu:${e.ids.kitsu}`);
    if (e.ids.anilist) matchedKeys.add(`anilist:${e.ids.anilist}`);
  };

  const out: CalendarItem[] = [];
  const seenItemIds = new Set<string>();

  const processCatalog = (list: SimklCdnItem[], catalog: "tv" | "anime" | "movie") => {
    for (const cdnItem of list) {
      const { date, time, atMs } = localDateTimeFromIso(cdnItem.date);
      if (!inMonth(date, year, month)) continue;

      const cIds = cdnItem.ids;
      const simklId = cIds?.simkl_id;
      const imdb = cleanId(cIds?.imdb);
      const tmdb = cleanId(cIds?.tmdb);
      const tvdb = cleanId(cIds?.tvdb);
      const mal = cleanId(cIds?.mal);
      const anidb = cleanId(cIds?.anidb);
      const anilist = cleanId(cIds?.anilist);
      const kitsu = cleanId(cIds?.kitsu);

      let matched: SimklUserEntry | undefined;
      if (simklId != null) {
        const direct = bySimklId.get(simklId);
        if (direct) {
          const directIsMovie = direct.category === "movie";
          const cdnIsMovie = catalog === "movie" || cdnItem.anime_type === "movie";
          if (directIsMovie === cdnIsMovie || (catalog === "anime" && direct.category === "anime")) {
            matched = direct;
          }
        }
      }

      if (!matched) {
        if (catalog === "tv") {
          matched =
            (imdb ? tvByImdb.get(imdb) : undefined) ??
            (tmdb ? tvByTmdb.get(tmdb) : undefined) ??
            (tvdb ? tvByTvdb.get(tvdb) : undefined);
        } else if (catalog === "movie") {
          matched =
            (imdb ? movieByImdb.get(imdb) : undefined) ??
            (tmdb ? movieByTmdb.get(tmdb) : undefined);
        } else if (catalog === "anime") {
          matched =
            (mal ? animeByMal.get(mal) : undefined) ??
            (anidb ? animeByAnidb.get(anidb) : undefined) ??
            (anilist ? animeByAnilist.get(anilist) : undefined) ??
            (kitsu ? animeByKitsu.get(kitsu) : undefined);
        }
      }

      if (!matched) continue;
      if (catalog === "movie" && matched.status === "completed") continue;

      markMatched(matched);

      const finalImdb = imdb ?? (catalog !== "anime" ? matched.ids.imdb : undefined) ?? null;
      const finalTmdb = tmdb ?? (catalog !== "anime" ? matched.ids.tmdb : undefined) ?? null;
      const finalMal = mal ?? matched.ids.mal ?? null;
      const finalKitsu = kitsu ?? matched.ids.kitsu ?? null;
      const finalAnilist = anilist ?? matched.ids.anilist ?? null;
      const finalSimkl = simklId ?? matched.simklId;

      const isMovie = catalog === "movie" || (catalog === "anime" && cdnItem.anime_type === "movie" && !cdnItem.episode);
      const itemType: "movie" | "tv" = isMovie ? "movie" : "tv";
      const isAnime = catalog === "anime" || isAnimationGenre(cdnItem.genres);

      let baseId: string;
      if (catalog === "anime") {
        baseId =
          (finalMal ? `mal:${finalMal}` : null) ??
          (finalKitsu ? `kitsu:${finalKitsu}` : null) ??
          (finalAnilist ? `anilist:${finalAnilist}` : null) ??
          (finalSimkl != null ? `simkl:${finalSimkl}` : null) ??
          finalImdb ??
          (finalTmdb ? `tmdb:${itemType}:${finalTmdb}` : `simkl:${cdnItem.title}`);
      } else {
        baseId =
          finalImdb ??
          (finalTmdb ? `tmdb:${itemType}:${finalTmdb}` : null) ??
          (finalSimkl != null ? `simkl:${finalSimkl}` : `simkl:${cdnItem.title}`);
      }

      const showTitle = cdnItem.title || matched.title || "Untitled";
      let name = showTitle;
      let id = baseId;

      if (itemType === "tv" && cdnItem.episode?.episode !== undefined) {
        const season = cdnItem.episode.season ?? 1;
        const epNum = cdnItem.episode.episode;
        const epLabel = `S${pad(season)}E${pad(epNum)}`;
        const epTitle = cdnItem.episode.title;
        name = !isGenericEpisodeTitle(epTitle, epNum)
          ? `${showTitle} ${epLabel}: ${epTitle!.trim()}`
          : `${showTitle} ${epLabel}`;
        id = `${baseId}:${season}:${epNum}`;
      }

      if (seenItemIds.has(id)) continue;
      seenItemIds.add(id);

      const posterPath = cdnItem.poster || matched.poster;
      const poster = posterPath
        ? `https://wsrv.nl/?url=https://simkl.in/posters/${posterPath}_m.webp&q=90`
        : null;
      const background = cdnItem.fanart
        ? `https://wsrv.nl/?url=https://simkl.in/fanart/${cdnItem.fanart}_medium.webp&q=85`
        : null;

      out.push({
        id,
        imdbId: finalImdb,
        type: itemType,
        name,
        poster,
        background,
        releaseDate: date,
        releaseTime: time,
        releaseAtMs: atMs,
        isAnime,
        overview: "",
        voteAverage:
          cdnItem.ratings?.simkl?.rating ??
          cdnItem.ratings?.imdb?.rating ??
          cdnItem.ratings?.mal?.rating ??
          0,
      });
    }
  };

  processCatalog(cdn.tv, "tv");
  processCatalog(cdn.anime, "anime");
  processCatalog(cdn.movie, "movie");

  return { items: out, matchedKeys };
}
