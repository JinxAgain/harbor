import { activeProfileId } from "@/lib/active-profile-id";
import { getSession } from "./session";
import { resolveForMeta } from "@/lib/tracker-resolve";
import { resolveSimklEpisodeTarget, stremioIdToSimklTarget } from "./ids";
import { addToHistory, markEpisodesWatched } from "./history";
import type { ScrobbleInfo } from "./scrobble-body";
import type { PlayerSrc } from "@/lib/view";

const ANIME_ID = /^(kitsu|mal|anilist|anidb):/;

function animeFallbackTarget(
  metaId: string,
  episode: PlayerSrc["episode"] | undefined,
): { animeMetaId: string; animeEpisode: NonNullable<PlayerSrc["episode"]> } | null {
  if (!episode) return null;
  if (episode.sourceMetaId && ANIME_ID.test(episode.sourceMetaId)) {
    return {
      animeMetaId: episode.sourceMetaId,
      animeEpisode: { ...episode, season: 1 },
    };
  }
  if (episode.kitsuStreamId?.startsWith("kitsu:")) {
    const parts = episode.kitsuStreamId.split(":");
    if (parts.length >= 2 && parts[1]) {
      const streamEp = parts.length >= 3 ? Number(parts[2]) : NaN;
      return {
        animeMetaId: `kitsu:${parts[1]}`,
        animeEpisode: {
          ...episode,
          season: 1,
          episode: Number.isFinite(streamEp) && streamEp > 0 ? streamEp : episode.episode,
        },
      };
    }
  }
  if (ANIME_ID.test(metaId)) {
    return { animeMetaId: metaId, animeEpisode: episode };
  }
  return null;
}

/**
 * Directly records the finished item in Simkl's watch history as a fallback,
 * because the beacon is fire-and-forget and would otherwise leave the item
 * stuck in "watching" if its request is ever lost.
 *
 * Returns true when the write was confirmed so callers can persist the intent
 * for a later retry instead of dropping it.
 */
export async function recordWatchedFallback(
  metaId: string,
  episode: PlayerSrc["episode"] | undefined,
  info?: ScrobbleInfo,
): Promise<boolean> {
  const profile = activeProfileId();
  const session = getSession();
  const owned = () => session != null && getSession() === session && activeProfileId() === profile;
  if (!owned()) return false;
  const r = stremioIdToSimklTarget(metaId, episode);
  const t = r.ok
    ? r.target
    : episode
      ? await resolveSimklEpisodeTarget(metaId, episode, info?.imdb)
      : null;
  if (!owned() || !t) return false;
  if (t.kind === "episode") {
    if (await markEpisodesWatched(t.show.ids, t.season, [t.number])) return true;
    if (!owned()) return false;
    const animeFallback = animeFallbackTarget(metaId, episode);
    if (animeFallback) {
      const animeTarget = await resolveSimklEpisodeTarget(
        animeFallback.animeMetaId,
        animeFallback.animeEpisode,
      );
      if (!owned()) return false;
      if (
        animeTarget?.kind === "anime-episode" &&
        (await markEpisodesWatched(animeTarget.anime.ids, animeTarget.season, [animeTarget.number]))
      ) {
        return true;
      }
      if (!owned()) return false;
    }
    if (ANIME_ID.test(metaId)) return false;
    const resolved = await resolveForMeta(metaId, t.season, t.number);
    if (!owned() || !resolved.ok) return false;
    return markEpisodesWatched(resolved.episode.showIds, resolved.episode.season, [
      resolved.episode.number,
    ]);
  }
  if (t.kind === "anime-episode") return markEpisodesWatched(t.anime.ids, t.season, [t.number]);
  return addToHistory(t, metaId);
}
