import {
  anidbToMal,
  anilistToMal,
  kitsuToAnidb,
  kitsuToAnilist,
  kitsuToMal,
  relatedLibraryIds,
} from "@/lib/providers/anime-mapping";
import type { SimklIds, SimklTarget } from "./types";

export type IdResolution =
  | { ok: true; target: SimklTarget }
  | { ok: false; reason: "anime" | "unrecognized" };

export function simklTargetIds(target: SimklTarget): SimklIds {
  if (target.kind === "episode") return target.show.ids;
  if (target.kind === "anime-episode") return target.anime.ids;
  return target.ids;
}

async function animeIdToMal(harborId: string): Promise<number | null> {
  const n = Number(harborId.split(":")[1]);
  if (!Number.isFinite(n)) return null;
  if (harborId.startsWith("mal:")) return n;
  if (harborId.startsWith("kitsu:")) return kitsuToMal(n).catch(() => null);
  if (harborId.startsWith("anilist:")) return anilistToMal(n).catch(() => null);
  if (harborId.startsWith("anidb:")) return anidbToMal(n).catch(() => null);
  return null;
}

function nativeAnimeIds(harborId: string): SimklIds | null {
  const [prefix, raw] = harborId.split(":");
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (prefix === "mal") return { mal: n };
  if (prefix === "kitsu") return { kitsu: n };
  if (prefix === "anilist") return { anilist: n };
  if (prefix === "anidb") return { anidb: n };
  return null;
}

type EpisodeIdentity = {
  season: number;
  episode: number;
  imdbSeason?: number;
  imdbEpisode?: number;
};

export async function resolveSimklEpisodeTarget(
  harborId: string,
  episode: EpisodeIdentity,
  fallbackImdb?: string,
): Promise<SimklTarget | null> {
  const direct = stremioIdToSimklTarget(harborId, episode);
  if (direct.ok && (direct.target.kind === "episode" || direct.target.kind === "anime-episode")) {
    return direct.target;
  }
  const season = episode.imdbSeason ?? episode.season;
  const number = episode.imdbEpisode ?? episode.episode;
  if (fallbackImdb && /^tt\d+$/.test(fallbackImdb)) {
    return { kind: "episode", show: { ids: { imdb: fallbackImdb } }, season, number };
  }
  const animeSeason = episode.season || 1;
  const animeNumber = episode.episode;
  const mal = await animeIdToMal(harborId);
  if (mal != null) {
    return {
      kind: "anime-episode",
      anime: { ids: { mal } },
      season: animeSeason,
      number: animeNumber,
    };
  }
  const native = nativeAnimeIds(harborId);
  if (native) {
    return {
      kind: "anime-episode",
      anime: { ids: native },
      season: animeSeason,
      number: animeNumber,
    };
  }
  return null;
}

export async function resolveSimklTarget(
  harborId: string,
  type: "movie" | "series",
): Promise<SimklTarget | null> {
  let tgt: SimklTarget | null = null;
  const resolution = stremioIdToSimklTarget(harborId);
  if (resolution.ok) {
    tgt = resolution.target;
  } else {
    const mal = await animeIdToMal(harborId);
    const native = nativeAnimeIds(harborId);
    if (mal != null || native != null) {
      tgt = {
        kind: "show",
        ids: { ...(native ?? {}), ...(mal != null ? { mal } : {}) },
      };
    }
  }
  if (!tgt) return null;
  if (type === "series" && tgt.kind === "movie") tgt = { kind: "show", ids: tgt.ids };
  if (type === "movie" && tgt.kind === "show") tgt = { kind: "movie", ids: tgt.ids };
  return tgt;
}

export function simklShowIdsForMeta(metaId: string): SimklIds | null {
  const r = stremioIdToSimklTarget(metaId, { season: 1, episode: 1 });
  if (r.ok) {
    if (r.target.kind === "episode") return r.target.show.ids;
    if (r.target.kind === "anime-episode") return r.target.anime.ids;
  }
  return nativeAnimeIds(metaId);
}

export async function resolveSimklAnimeShowIds(harborId: string): Promise<SimklIds | null> {
  const direct = stremioIdToSimklTarget(harborId, { season: 1, episode: 1 });
  if (direct.ok) {
    if (direct.target.kind === "episode") return direct.target.show.ids;
    if (direct.target.kind === "anime-episode") return direct.target.anime.ids;
  }
  const mal = await animeIdToMal(harborId);
  const native = nativeAnimeIds(harborId);
  if (native || mal != null) {
    return { ...(native ?? {}), ...(mal != null ? { mal } : {}) };
  }
  return null;
}

export async function resolveAnimeAliasKeys(
  harborId: string,
  imdbId?: string | null,
): Promise<string[]> {
  const keys = new Set<string>();
  if (harborId) keys.add(harborId);
  if (imdbId) keys.add(imdbId);

  const n = Number(harborId.split(":")[1]);
  if (Number.isFinite(n) && harborId.startsWith("kitsu:")) {
    const [mal, anilist, anidb] = await Promise.all([
      kitsuToMal(n).catch(() => null),
      kitsuToAnilist(n).catch(() => null),
      kitsuToAnidb(n).catch(() => null),
    ]);
    if (mal != null) keys.add(`mal:${mal}`);
    if (anilist != null) keys.add(`anilist:${anilist}`);
    if (anidb != null) keys.add(`anidb:${anidb}`);
  } else if (Number.isFinite(n) && harborId.startsWith("anilist:")) {
    const mal = await anilistToMal(n).catch(() => null);
    if (mal != null) keys.add(`mal:${mal}`);
  } else if (Number.isFinite(n) && harborId.startsWith("anidb:")) {
    const mal = await anidbToMal(n).catch(() => null);
    if (mal != null) keys.add(`mal:${mal}`);
  }

  const related = await relatedLibraryIds(harborId).catch(() => []);
  for (const r of related) {
    if (r) keys.add(r);
  }
  if (imdbId && !/^(kitsu|mal|anilist|anidb):/.test(harborId)) {
    const imdbRelated = await relatedLibraryIds(imdbId).catch(() => []);
    for (const r of imdbRelated) {
      if (r) keys.add(r);
    }
  }

  return Array.from(keys);
}

export function stremioIdToSimklTarget(
  metaId: string,
  episode?: { season: number; episode: number },
): IdResolution {
  if (!metaId) return { ok: false, reason: "unrecognized" };

  if (metaId.startsWith("mal:")) {
    const n = Number(metaId.split(":")[1]);
    if (!Number.isFinite(n)) return { ok: false, reason: "unrecognized" };
    if (episode) return { ok: false, reason: "anime" };
    return { ok: true, target: { kind: "show", ids: { mal: n } } };
  }

  if (metaId.startsWith("kitsu:")) {
    return { ok: false, reason: "anime" };
  }

  if (metaId.startsWith("tt")) {
    const parts = metaId.split(":");
    const imdb = parts[0];
    if (!/^tt\d+$/.test(imdb)) return { ok: false, reason: "unrecognized" };

    if (parts.length >= 3) {
      const season = Number(parts[1]);
      const number = Number(parts[2]);
      if (!Number.isFinite(season) || !Number.isFinite(number)) {
        return { ok: false, reason: "unrecognized" };
      }
      return {
        ok: true,
        target: { kind: "episode", show: { ids: { imdb } }, season, number },
      };
    }

    if (episode) {
      return {
        ok: true,
        target: {
          kind: "episode",
          show: { ids: { imdb } },
          season: episode.season,
          number: episode.episode,
        },
      };
    }

    return { ok: true, target: { kind: "movie", ids: { imdb } } };
  }

  if (metaId.startsWith("tmdb:")) {
    const parts = metaId.split(":");
    const kind = parts[1];
    const id = Number(parts[2]);
    if (!Number.isFinite(id)) return { ok: false, reason: "unrecognized" };

    if (kind === "movie") {
      return { ok: true, target: { kind: "movie", ids: { tmdb: id } } };
    }
    if (kind === "tv") {
      if (parts.length >= 5) {
        const season = Number(parts[3]);
        const number = Number(parts[4]);
        if (Number.isFinite(season) && Number.isFinite(number)) {
          return {
            ok: true,
            target: { kind: "episode", show: { ids: { tmdb: id } }, season, number },
          };
        }
      }
      if (episode) {
        return {
          ok: true,
          target: {
            kind: "episode",
            show: { ids: { tmdb: id } },
            season: episode.season,
            number: episode.episode,
          },
        };
      }
      return { ok: true, target: { kind: "show", ids: { tmdb: id } } };
    }
    return { ok: false, reason: "unrecognized" };
  }

  if (metaId.startsWith("simkl:")) {
    const n = Number(metaId.split(":")[1]);
    if (!Number.isFinite(n)) return { ok: false, reason: "unrecognized" };
    if (episode) {
      return {
        ok: true,
        target: {
          kind: "episode",
          show: { ids: { simkl: n } },
          season: episode.season,
          number: episode.episode,
        },
      };
    }
    return { ok: true, target: { kind: "show", ids: { simkl: n } } };
  }

  return { ok: false, reason: "unrecognized" };
}
