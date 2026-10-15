import { currentActivitiesAll } from "./activities/gate";
import { simklRequest } from "./client";
import { simklTargetIds } from "./ids";
import type { SimklIds, SimklItem, SimklTarget } from "./types";

export type RawIds = {
  simkl?: number;
  imdb?: string;
  tmdb?: number | string;
  tvdb?: number | string;
  mal?: number | string;
  anidb?: number | string;
  kitsu?: number | string;
  anilist?: number | string;
};
type RawNode = { title?: string; year?: number | null; ids?: RawIds };
type RawEntry = {
  status?: string;
  added_to_watchlist_at?: string;
  last_watched_at?: string | null;
  anime_type?: string | null;
  movie?: RawNode;
  show?: RawNode;
  anime?: RawNode;
};
type RawAllItems = { movies?: RawEntry[]; shows?: RawEntry[]; anime?: RawEntry[] };

export function num(v: number | string | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function mapIds(ids: RawIds | undefined): SimklIds {
  const out: SimklIds = {
    simkl: num(ids?.simkl),
    imdb: ids?.imdb || undefined,
    tmdb: num(ids?.tmdb),
    tvdb: num(ids?.tvdb),
    mal: num(ids?.mal),
    anidb: num(ids?.anidb),
  };
  const kitsu = num(ids?.kitsu);
  if (kitsu !== undefined) out.kitsu = kitsu;
  const anilist = num(ids?.anilist);
  if (anilist !== undefined) out.anilist = anilist;
  return out;
}

const WATCHLIST_TTL_MS = 25000;
const statusCache = new Map<string, { at: number; marker: string | null; val: Promise<SimklItem[]> }>();

export function invalidateWatchlistCache(): void {
  statusCache.clear();
}

async function fetchByStatus(status: string): Promise<SimklItem[]> {
  const all = await currentActivitiesAll();
  const hit = statusCache.get(status);
  if (hit) {
    if (all !== null && all === hit.marker) return hit.val;
    if (all === null && Date.now() - hit.at < WATCHLIST_TTL_MS) return hit.val;
  }
  const val = fetchByStatusRaw(status);
  statusCache.set(status, { at: Date.now(), marker: all, val });
  return val;
}

async function fetchByStatusRaw(status: string): Promise<SimklItem[]> {
  const data = await simklRequest<RawAllItems>(`/sync/all-items/all/${status}?extended=full`)
    .catch((err) => {
      if (err && typeof err === "object" && "status" in err && (err as { status?: number }).status === 400) {
        return simklRequest<RawAllItems>(`/sync/all-items/all/${status}`);
      }
      throw err;
    })
    .catch(() => ({}) as RawAllItems);
  const out: SimklItem[] = [];
  for (const e of data?.movies ?? []) {
    const m = e.movie;
    if (!m) continue;
    out.push({
      type: "movie",
      category: "movie",
      status: e.status ?? status,
      title: m.title ?? "",
      year: m.year ?? null,
      ids: mapIds(m.ids),
      watchedAt: e.last_watched_at ?? e.added_to_watchlist_at,
    });
  }
  for (const e of data?.shows ?? []) {
    const s = e.show;
    if (!s) continue;
    out.push({
      type: "show",
      category: "show",
      status: e.status ?? status,
      title: s.title ?? "",
      year: s.year ?? null,
      ids: mapIds(s.ids),
      watchedAt: e.last_watched_at ?? e.added_to_watchlist_at,
    });
  }
  for (const e of data?.anime ?? []) {
    const s = e.show ?? e.anime ?? e.movie;
    if (!s) continue;
    out.push({
      type: e.anime_type === "movie" ? "movie" : "show",
      category: "anime",
      status: e.status ?? status,
      title: s.title ?? "",
      year: s.year ?? null,
      ids: mapIds(s.ids),
      watchedAt: e.last_watched_at ?? e.added_to_watchlist_at,
    });
  }
  return out;
}

export async function fetchWatchlist(): Promise<SimklItem[]> {
  return fetchByStatus("plantowatch");
}

export async function fetchWatchingItems(): Promise<SimklItem[]> {
  return fetchByStatus("watching");
}

export async function fetchHoldItems(): Promise<SimklItem[]> {
  return fetchByStatus("hold");
}

export async function addToWatchlist(target: SimklTarget): Promise<boolean> {
  try {
    const body =
      target.kind === "movie"
        ? { movies: [{ to: "plantowatch", ids: target.ids }] }
        : { shows: [{ to: "plantowatch", ids: simklTargetIds(target) }] };
    await simklRequest("/sync/add-to-list", { method: "POST", body });
    invalidateWatchlistCache();
    return true;
  } catch {
    return false;
  }
}

export async function removeFromWatchlist(target: SimklTarget): Promise<boolean> {
  try {
    const body =
      target.kind === "movie"
        ? { movies: [{ ids: target.ids }] }
        : { shows: [{ ids: simklTargetIds(target) }] };
    await simklRequest("/sync/history/remove", { method: "POST", body });
    invalidateWatchlistCache();
    return true;
  } catch {
    return false;
  }
}
