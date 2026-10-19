import { activeProfileId } from "@/lib/active-profile-id";
import { getSession, subscribeSession } from "./session";
import { resolveForMeta } from "@/lib/tracker-resolve";
import {
  currentActivitiesAll,
  resetActivitiesGate,
  subscribeActivitiesMutation,
} from "./activities/gate";
import { simklRequest } from "./client";
import { simklTargetIds } from "./ids";
import type { SimklIds, SimklTarget } from "./types";

const ANIME_ID = /^(kitsu|mal|anilist|anidb):/;

export type SimklHistoryItem = {
  id: number;
  watchedAt: string;
  type: "movie" | "episode";
  imdb?: string;
  tmdb?: number;
  title: string;
  year: number | null;
  showImdb?: string;
  showTmdb?: number;
  season?: number;
  number?: number;
};

type RawIds = { simkl?: number; imdb?: string; tmdb?: number | string };
type RawNode = { title?: string; year?: number | null; ids?: RawIds };
type RawEntry = {
  last_watched_at?: string;
  anime_type?: string | null;
  movie?: RawNode;
  show?: RawNode;
  anime?: RawNode;
};
type RawAllItems = { movies?: RawEntry[]; shows?: RawEntry[]; anime?: RawEntry[] };
type HistoryWriteResult = {
  added?: {
    movies?: number;
    shows?: number;
    episodes?: number;
    statuses?: Array<{ response?: { status?: string } }>;
  };
  not_found?: {
    movies?: unknown[];
    shows?: unknown[];
    episodes?: unknown[];
  };
};

function num(v: number | string | undefined): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

const HISTORY_TTL_MS = 25000;
let historyCache: { at: number; val: Promise<SimklHistoryItem[]> } | null = null;
let historyMarker: string | null = null;

export function invalidateHistoryCache(): void {
  historyCache = null;
  historyMarker = null;
}

subscribeSession?.(invalidateHistoryCache);
subscribeActivitiesMutation?.(invalidateHistoryCache);

async function loadHistory(): Promise<SimklHistoryItem[]> {
  const all = await currentActivitiesAll();
  if (historyCache) {
    if (all !== null && all === historyMarker) return historyCache.val;
    if (all === null && Date.now() - historyCache.at < HISTORY_TTL_MS) return historyCache.val;
  }
  const val = pullHistory();
  historyCache = { at: Date.now(), val };
  historyMarker = all;
  return val;
}

export async function fetchWatchedHistory(limit = 200): Promise<SimklHistoryItem[]> {
  return (await loadHistory()).slice(0, limit);
}

async function pullHistory(): Promise<SimklHistoryItem[]> {
  const data = await simklRequest<RawAllItems>("/sync/all-items/all/completed?extended=full")
    .catch((err) => {
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status?: number }).status === 400
      ) {
        return simklRequest<RawAllItems>("/sync/all-items/all/completed");
      }
      throw err;
    })
    .catch(() => {
      invalidateHistoryCache();
      return {} as RawAllItems;
    });
  const out: SimklHistoryItem[] = [];
  for (const e of data.movies ?? []) {
    const m = e.movie;
    if (!m) continue;
    out.push({
      id: m.ids?.simkl ?? 0,
      watchedAt: e.last_watched_at ?? "",
      type: "movie",
      title: m.title ?? "",
      year: m.year ?? null,
      imdb: m.ids?.imdb,
      tmdb: num(m.ids?.tmdb),
    });
  }
  for (const e of data.shows ?? []) {
    const s = e.show;
    if (!s) continue;
    out.push({
      id: s.ids?.simkl ?? 0,
      watchedAt: e.last_watched_at ?? "",
      type: "episode",
      title: s.title ?? "",
      year: s.year ?? null,
      showImdb: s.ids?.imdb,
      showTmdb: num(s.ids?.tmdb),
    });
  }
  for (const e of data.anime ?? []) {
    const s = e.show ?? e.anime ?? e.movie;
    if (!s) continue;
    const isMovie = e.anime_type === "movie";
    out.push({
      id: s.ids?.simkl ?? 0,
      watchedAt: e.last_watched_at ?? "",
      type: isMovie ? "movie" : "episode",
      title: s.title ?? "",
      year: s.year ?? null,
      ...(isMovie
        ? { imdb: s.ids?.imdb, tmdb: num(s.ids?.tmdb) }
        : { showImdb: s.ids?.imdb, showTmdb: num(s.ids?.tmdb) }),
    });
  }
  out.sort((a, b) => b.watchedAt.localeCompare(a.watchedAt));
  return out;
}

function isConfirmedMovieOrShow(r: HistoryWriteResult | undefined, kind: "movies" | "shows"): boolean {
  if ((r?.not_found?.[kind]?.length ?? 0) > 0) return false;
  if ((r?.added?.[kind] ?? 0) > 0) return true;
  if (kind === "shows" && (r?.added?.episodes ?? 0) > 0) return true;
  return (r?.added?.statuses?.length ?? 0) > 0 || Array.isArray(r?.not_found?.[kind]);
}

function isConfirmedEpisodes(r: HistoryWriteResult | undefined, needed: number): boolean {
  if ((r?.added?.episodes ?? 0) >= needed) return true;
  if ((r?.not_found?.shows?.length ?? 0) > 0 || (r?.not_found?.episodes?.length ?? 0) > 0) {
    return false;
  }
  // When an episode was already marked watched (e.g. by /scrobble/stop moments earlier),
  // Simkl skips the duplicate and returns added: { shows: 0, episodes: 0 } with the
  // resolved show in added.statuses and empty not_found arrays.
  if ((r?.added?.shows ?? 0) === 0 && (r?.added?.episodes ?? 0) === 0) {
    return (
      (r?.added?.statuses?.length ?? 0) > 0 ||
      (Array.isArray(r?.not_found?.shows) && Array.isArray(r?.not_found?.episodes))
    );
  }
  return false;
}

async function postHistory(target: SimklTarget): Promise<boolean> {
  const watchedAt = new Date().toISOString();
  try {
    invalidateHistoryCache();
    resetActivitiesGate?.({ kind: "write" });
    if (target.kind === "movie") {
      const r = await simklRequest<HistoryWriteResult>("/sync/history", {
        method: "POST",
        body: { movies: [{ ids: target.ids, watched_at: watchedAt }] },
      });
      return isConfirmedMovieOrShow(r, "movies");
    }
    if (target.kind === "episode") {
      const r = await simklRequest<HistoryWriteResult>("/sync/history", {
        method: "POST",
        body: {
          shows: [
            {
              ids: target.show.ids,
              seasons: [
                {
                  number: target.season,
                  episodes: [{ number: target.number, watched_at: watchedAt }],
                },
              ],
            },
          ],
        },
      });
      return isConfirmedEpisodes(r, 1);
    }
    const r = await simklRequest<HistoryWriteResult>("/sync/history", {
      method: "POST",
      body: {
        shows: [{ ids: simklTargetIds(target), status: "completed", watched_at: watchedAt }],
      },
    });
    return isConfirmedMovieOrShow(r, "shows");
  } catch {
    return false;
  }
}

export async function addToHistory(target: SimklTarget, metaId?: string): Promise<boolean> {
  const profile = activeProfileId();
  const session = getSession();
  const owned = () => session != null && getSession() === session && activeProfileId() === profile;
  if (!owned()) return false;
  if (await postHistory(target)) return true;
  if (!owned() || !metaId || target.kind !== "episode" || ANIME_ID.test(metaId)) return false;
  const resolved = await resolveForMeta(metaId, target.season, target.number);
  if (!owned() || !resolved.ok) return false;
  return postHistory({
    kind: "episode",
    show: { ids: resolved.episode.showIds },
    season: resolved.episode.season,
    number: resolved.episode.number,
  });
}

export async function markEpisodesWatched(
  show: SimklIds,
  season: number,
  episodes: number[],
): Promise<boolean> {
  if (episodes.length === 0) return false;
  const watchedAt = new Date().toISOString();
  try {
    invalidateHistoryCache();
    resetActivitiesGate?.({ kind: "write" });
    const result = await simklRequest<HistoryWriteResult>("/sync/history", {
      method: "POST",
      body: {
        shows: [
          {
            ids: show,
            seasons: [
              {
                number: season,
                episodes: episodes.map((n) => ({ number: n, watched_at: watchedAt })),
              },
            ],
          },
        ],
      },
    });
    return isConfirmedEpisodes(result, new Set(episodes).size);
  } catch {
    return false;
  }
}

export async function unmarkEpisodeWatched(
  show: SimklIds,
  season: number,
  episode: number,
): Promise<boolean> {
  return unmarkEpisodesWatched(show, season, [episode]);
}

export async function unmarkEpisodesWatched(
  show: SimklIds,
  season: number,
  episodes: number[],
): Promise<boolean> {
  if (episodes.length === 0) return false;
  try {
    invalidateHistoryCache();
    resetActivitiesGate?.({
      kind: "remove-episodes",
      ids: show as Record<string, unknown>,
      season,
      episodes,
    });
    await simklRequest("/sync/history/remove", {
      method: "POST",
      body: {
        shows: [
          {
            ids: show,
            seasons: [{ number: season, episodes: episodes.map((n) => ({ number: n })) }],
          },
        ],
      },
    });
    return true;
  } catch {
    return false;
  }
}
