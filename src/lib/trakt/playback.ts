import { traktRequest, TraktApiError } from "./client";
import { getSession } from "./session";
import { isCwDismissed } from "@/lib/cw-dismiss";
import { localCwEntry } from "@/lib/local-cw";
import { readResumeEntry, saveResumeBatch } from "@/lib/resume";
import type { LibraryItem } from "@/lib/stremio";
import type { TraktIds } from "./types";

type Node = { title?: string; year?: number | null; ids?: TraktIds };

type RawPlayback = {
  progress?: number;
  paused_at?: string;
  type?: "movie" | "episode";
  movie?: Node;
  show?: Node;
  episode?: { season?: number; number?: number; title?: string; ids?: TraktIds };
};

const DURATION_MS = { movie: 6_300_000, series: 2_640_000 };

function movieMetaId(ids?: TraktIds): string | null {
  if (!ids) return null;
  if (ids.imdb && /^tt\d+$/.test(ids.imdb)) return ids.imdb;
  if (ids.tmdb) return `tmdb:movie:${ids.tmdb}`;
  return null;
}

function seriesMetaId(ids?: TraktIds): string | null {
  if (!ids) return null;
  if (ids.imdb && /^tt\d+$/.test(ids.imdb)) return ids.imdb;
  if (ids.tmdb) return `tmdb:tv:${ids.tmdb}`;
  return null;
}

function buildItem(
  id: string,
  type: "movie" | "series",
  node: Node,
  pct: number,
  durMs: number,
  when: string,
  season?: number,
  episode?: number,
): LibraryItem {
  const hasEpisode =
    type === "series" && season != null && season > 0 && episode != null && episode > 0;
  return {
    _id: id,
    type,
    name: node.title ?? "Untitled",
    state: {
      timeOffset: Math.round((pct / 100) * durMs),
      duration: durMs,
      season: hasEpisode ? season : undefined,
      episode: hasEpisode ? episode : undefined,
      video_id: hasEpisode ? `${id}:${season}:${episode}` : undefined,
      lastWatched: when,
    },
    removed: false,
    temp: false,
    _ctime: when,
    _mtime: when,
    external: "trakt",
  };
}

function resolveItemDuration(
  id: string,
  type: "movie" | "series",
  season?: number,
  episode?: number,
): number {
  const local = localCwEntry(id, false) ?? localCwEntry(id, true);
  if (local && local.durationMs > 0) {
    if (type === "movie") return local.durationMs;
    if (local.season === season && local.episode === episode) return local.durationMs;
  }
  return type === "movie" ? DURATION_MS.movie : DURATION_MS.series;
}

function toLibraryItem(raw: RawPlayback): LibraryItem | null {
  const pct = Math.min(100, Math.max(0, raw.progress ?? 0));
  if (pct < 1 || pct > 98) return null;
  const when = raw.paused_at ?? new Date(0).toISOString();

  if (raw.movie && !raw.episode) {
    const id = movieMetaId(raw.movie.ids);
    const durMs = id ? resolveItemDuration(id, "movie") : DURATION_MS.movie;
    return id ? buildItem(id, "movie", raw.movie, pct, durMs, when) : null;
  }

  if (raw.show) {
    const id = seriesMetaId(raw.show.ids);
    if (!id) return null;
    const season = raw.episode?.season;
    const episode = raw.episode?.number;
    const durMs = resolveItemDuration(id, "series", season, episode);
    return buildItem(
      id,
      "series",
      raw.show,
      pct,
      durMs,
      when,
      season,
      episode,
    );
  }
  return null;
}

export async function fetchTraktPlaybackItems(): Promise<LibraryItem[]> {
  if (!getSession()) return [];
  let raw: RawPlayback[];
  try {
    raw = await traktRequest<RawPlayback[]>("/sync/playback?limit=40");
  } catch (e) {
    if (e instanceof TraktApiError && e.status === 404) return [];
    throw e;
  }
  if (!Array.isArray(raw)) return [];

  const items: LibraryItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const item = toLibraryItem(r);
    if (!item?.state) continue;
    const key = `${item._id}|${item.state.season ?? ""}|${item.state.episode ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    // Same dismiss guard as Simkl: no resume backfill for dismissed cards, so a
    // background refresh cannot manufacture fresh activity that beats the dismissal.
    if (isCwDismissed(item)) continue;
    // Newer-wins backfill: overwrite a stale entry when the remote pause is newer
    // (paused_at) or, when the stored entry has no usable timestamp, further ahead.
    const existing = readResumeEntry(item._id, item.state.season, item.state.episode);
    const remoteT = Date.parse(item.state.lastWatched ?? "");
    const remoteValid = Number.isFinite(remoteT) && remoteT > 0;
    const isFirstParty = Boolean(existing && !existing.source);
    const shouldWrite =
      !existing ||
      (isFirstParty
        ? remoteValid && remoteT > existing.t + 60_000
        : (remoteValid && remoteT >= existing.t) ||
          (!existing.t && item.state.timeOffset > existing.ms));
    if (shouldWrite) {
      // Persist the true remote percent alongside the synthetic ms so consumers
      // can prefer pct x real runtime once migrated; pct rides along with the
      // winning write and is never mixed with another entry's ms.
      const pct01 = Math.min(100, Math.max(0, r.progress ?? 0)) / 100;
      saveResumeBatch([
        {
          id: item._id,
          ms: item.state.timeOffset,
          season: item.state.season,
          episode: item.state.episode,
          pct: pct01,
          source: "trakt",
          t: remoteValid ? remoteT : 0,
        },
      ]);
    }
  }
  return items;
}
