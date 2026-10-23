import { anidbToMal, anilistToMal, kitsuToMal } from "@/lib/providers/anime-mapping";
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
