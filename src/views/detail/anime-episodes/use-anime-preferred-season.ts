import { useMemo } from "react";
import { getEpisodeProgress } from "@/lib/episode-progress";
import { manualWatchedState } from "@/lib/manual-watched";
import { isEpisodeFinished } from "@/lib/detail-resume-advance";
import type { KitsuEpisode } from "@/lib/providers/kitsu";
import { parseKitsuId } from "@/lib/providers/kitsu";
import { splitFranchiseDisplaySeason } from "@/lib/streams/anime-identity-core";
import { lastPlayedEpisode } from "@/lib/resume";
import { simklWatchedForId } from "@/lib/simkl/list-status";
import { animeSeasonKey } from "./anime-season-key";

export type SelectAnimePreferredSeasonArgs = {
  episodes: KitsuEpisode[];
  metaId: string;
  trackId?: string;
  traktWatched: Set<string>;
  anilistWatched?: Set<string>;
  simklWatched?: Set<string>;
  simklMap?: Map<string, Set<string>>;
  malWatched?: Set<string>;
  lastPlayed?: { episode: number; displaySeason?: number | null } | null;
};

export function selectAnimePreferredSeason(args: SelectAnimePreferredSeasonArgs): string | null {
  const {
    episodes,
    metaId,
    trackId,
    traktWatched,
    anilistWatched,
    simklWatched,
    simklMap,
    malWatched,
  } = args;
  if (episodes.length === 0) return null;
  const partScoped =
    splitFranchiseDisplaySeason(parseKitsuId(metaId)) != null ||
    (trackId ? splitFranchiseDisplaySeason(parseKitsuId(trackId)) != null : false);
  const playedFromMeta =
    args.lastPlayed !== undefined ? args.lastPlayed : lastPlayedEpisode(metaId);
  const playedFromTrack =
    args.lastPlayed !== undefined
      ? null
      : playedFromMeta == null && trackId
        ? lastPlayedEpisode(trackId)
        : null;
  const played = playedFromMeta ?? playedFromTrack;
  const playedId =
    playedFromMeta != null ? metaId : playedFromTrack != null ? (trackId ?? null) : null;
  // Merged franchise lists (e.g. Bleach 2004 + TYBW cours) collide on `number`,
  // so prefer the episode from the entry the resume was saved under before
  // falling back to the plain number match.
  const playedEp =
    played != null
      ? ((playedId != null
          ? episodes.find(
              (e) => e.number === played.episode && (e.sourceMetaId ?? metaId) === playedId,
            )
          : undefined) ??
        (partScoped && played.displaySeason != null
          ? (episodes.find(
              (e) =>
                e.number === played.episode &&
                splitFranchiseDisplaySeason(parseKitsuId(e.sourceMetaId ?? "")) ===
                  played.displaySeason,
            ) ?? episodes.find((e) => e.number === played.episode))
          : episodes.find((e) => e.number === played.episode)))
      : undefined;
  const playedSeason = partScoped
    ? (playedEp?.seasonNumber ?? playedEp?.imdbSeason ?? null)
    : (playedEp?.imdbSeason ?? playedEp?.seasonNumber ?? null);

  let maxSeason = 1;
  let maxCurrentSeason = 1;
  for (const ep of episodes) {
    if (ep.sourceMetaId != null) continue;
    const s = ep.imdbSeason ?? ep.seasonNumber ?? 1;
    if (s > maxCurrentSeason) maxCurrentSeason = s;
  }

  for (const ep of episodes) {
    const seasonNo = partScoped
      ? (ep.seasonNumber ?? ep.imdbSeason ?? 1)
      : (ep.imdbSeason ?? ep.seasonNumber ?? 1);
    if (seasonNo < 1) continue;
    if (ep.sourceMetaId != null) {
      if (splitFranchiseDisplaySeason(parseKitsuId(ep.sourceMetaId)) != null) continue;
      if (seasonNo <= maxCurrentSeason) continue;
    }
    const isCurrent = ep.sourceMetaId == null;
    const effectiveSimklWatched = isCurrent
      ? simklWatched
      : simklMap && ep.sourceMetaId
        ? (simklWatchedForId(simklMap, ep.sourceMetaId) ?? simklMap.get(ep.sourceMetaId))
        : undefined;

    let progress = getEpisodeProgress(
      ep.sourceMetaId ?? metaId,
      animeSeasonKey(ep),
      ep.number,
      ep.length ?? null,
      ep.imdbId ?? null,
      traktWatched,
      undefined,
      isCurrent ? anilistWatched : undefined,
      effectiveSimklWatched,
      isCurrent ? malWatched : undefined,
      ep.imdbSeason,
      ep.imdbEpisode,
    );

    if (
      isCurrent &&
      !progress.watched &&
      trackId &&
      trackId !== metaId &&
      manualWatchedState(metaId, animeSeasonKey(ep), ep.number) !== false
    ) {
      const alt = getEpisodeProgress(
        trackId,
        animeSeasonKey(ep),
        ep.number,
        ep.length ?? null,
        ep.imdbId ?? null,
        traktWatched,
        undefined,
        anilistWatched,
        simklWatched,
        malWatched,
        ep.imdbSeason,
        ep.imdbEpisode,
      );
      if (alt.watched) progress = alt;
    }

    if (seasonNo > maxSeason) maxSeason = seasonNo;
    if (!progress.watched) {
      if (playedSeason != null && seasonNo < playedSeason) continue;
      return String(seasonNo);
    }
  }

  if (playedSeason != null) return String(playedSeason);
  return String(maxSeason);
}

export function resolveAnimeFocusEpisode(
  displayEpisodes: KitsuEpisode[],
  episodes: KitsuEpisode[],
  progressFor: (ep: KitsuEpisode) => { ratio: number; watched: boolean; startedAt: number },
  nextUpId: number | null,
  resumeEpisode?: { season: number; episode: number } | null,
  episodeHint?: { season: number; episode: number } | null,
): KitsuEpisode | null {
  if (episodeHint) {
    const hintMatch = displayEpisodes.find(
      (ep) =>
        ((ep.imdbSeason ?? ep.seasonNumber ?? 1) === episodeHint.season &&
          (ep.imdbEpisode ?? ep.number) === episodeHint.episode) ||
        ep.number === episodeHint.episode,
    );
    if (hintMatch) return hintMatch;
  }

  const hasProgress =
    episodeHint != null ||
    resumeEpisode != null ||
    displayEpisodes.some((e) => {
      const p = progressFor(e);
      return p.watched || p.ratio > 0.01;
    }) ||
    episodes.some((e) => {
      const p = progressFor(e);
      return p.watched || p.ratio > 0.01;
    });

  if (!hasProgress) return null;

  return (
    (nextUpId != null ? displayEpisodes.find((e) => e.id === nextUpId) : null) ??
    (resumeEpisode ? displayEpisodes.find((e) => e.number === resumeEpisode.episode) : null) ??
    null
  );
}

export function computeAnimeLastPlay(args: {
  metaId: string;
  animeCanonicalId?: string | null;
  animeEpisodes: KitsuEpisode[];
  watchedThreshold?: number;
  simklWatched?: Set<string>;
  anilistWatched?: Set<string>;
  malWatched?: Set<string>;
  stremioWatched?: Set<string>;
  localBase?: { season: number; episode: number; displaySeason?: number | null } | null;
  manualWatched?: (id: string, s: number, e: number) => boolean | undefined;
  isFinished?: (
    id: string,
    ep: { season: number; episode: number },
    pct: number,
    dur?: number,
  ) => boolean;
  now?: number;
}): { season: number; episode: number; displaySeason?: number } | null {
  const {
    metaId,
    animeCanonicalId,
    animeEpisodes,
    watchedThreshold = 85,
    simklWatched,
    anilistWatched,
    malWatched,
    stremioWatched,
    localBase,
    manualWatched = manualWatchedState,
    isFinished = isEpisodeFinished,
  } = args;

  if (animeEpisodes.length === 0) {
    if (!localBase) return null;
    return {
      season: localBase.season,
      episode: localBase.episode,
      ...(localBase.displaySeason != null ? { displaySeason: localBase.displaySeason } : {}),
    };
  }

  const now = args.now ?? Date.now();
  const idAnime = /^(kitsu|mal|anilist|anidb):/.test(metaId);

  const isAired = (ep: KitsuEpisode): boolean => {
    if (!ep.airdate) return true;
    const t = Date.parse(ep.airdate);
    return !Number.isFinite(t) || t <= now;
  };
  const isRegularAired = (ep: KitsuEpisode): boolean => {
    const s = ep.imdbSeason ?? 1;
    if (s < 1) return false;
    return isAired(ep);
  };

  const isEpDone = (ep: KitsuEpisode): boolean => {
    const s = ep.seasonNumber ?? 1;
    const e = ep.number;
    const ds = ep.imdbSeason ?? undefined;
    const key = `${s}:${e}`;
    const providerKey = ds != null ? `${ds}:${ep.imdbEpisode ?? e}` : null;
    const durSec = ep.length && ep.length > 0 ? ep.length * 60 : undefined;

    const ids = [metaId, animeCanonicalId].filter((x): x is string => Boolean(x));
    for (const id of ids) {
      if (manualWatched(id, s, e) === false) return false;
      if (ds != null && manualWatched(id, ds, e) === false) return false;
    }

    for (const id of ids) {
      if (manualWatched(id, s, e) === true) return true;
      if (ds != null && manualWatched(id, ds, e) === true) return true;
      if (isFinished(id, { season: s, episode: e }, watchedThreshold, durSec)) return true;
      if (ds != null && isFinished(id, { season: ds, episode: e }, watchedThreshold, durSec))
        return true;
    }

    if (simklWatched?.has(key)) return true;
    if (providerKey && simklWatched?.has(providerKey)) return true;
    if (anilistWatched?.has(key)) return true;
    if (malWatched?.has(key)) return true;
    if (stremioWatched?.has(key)) return true;
    if (providerKey && stremioWatched?.has(providerKey)) return true;

    return false;
  };

  const formatEp = (
    ep: KitsuEpisode,
    baseDisplaySeason?: number,
  ): { season: number; episode: number; displaySeason?: number } => {
    const s = idAnime ? (ep.seasonNumber ?? 1) : (ep.imdbSeason ?? ep.seasonNumber ?? 1);
    const e = idAnime ? ep.number : (ep.imdbEpisode ?? ep.number);
    const ds =
      baseDisplaySeason ??
      splitFranchiseDisplaySeason(parseKitsuId(metaId)) ??
      (ep.imdbSeason != null && ep.imdbSeason >= 1 ? ep.imdbSeason : undefined);
    return {
      season: s,
      episode: e,
      ...(ds != null ? { displaySeason: ds } : {}),
    };
  };

  if (localBase) {
    const matchIdx = animeEpisodes.findIndex(
      (e) =>
        ((e.seasonNumber ?? 1) === localBase.season && e.number === localBase.episode) ||
        (e.imdbSeason === (localBase.displaySeason ?? localBase.season) &&
          (e.imdbEpisode ?? e.number) === localBase.episode) ||
        (e.sourceMetaId == null && e.number === localBase.episode),
    );
    const matchEp = matchIdx >= 0 ? animeEpisodes[matchIdx] : undefined;
    if (matchEp && isEpDone(matchEp)) {
      for (let i = matchIdx + 1; i < animeEpisodes.length; i++) {
        const nextEp = animeEpisodes[i];
        if (isRegularAired(nextEp) && !isEpDone(nextEp)) {
          return formatEp(nextEp, localBase.displaySeason ?? undefined);
        }
      }
    }
    return {
      season: localBase.season,
      episode: localBase.episode,
      ...(localBase.displaySeason != null ? { displaySeason: localBase.displaySeason } : {}),
    };
  }

  let highestWatchedIdx = -1;
  for (let i = 0; i < animeEpisodes.length; i++) {
    if (isEpDone(animeEpisodes[i])) {
      highestWatchedIdx = i;
    }
  }

  if (highestWatchedIdx >= 0) {
    for (let i = highestWatchedIdx + 1; i < animeEpisodes.length; i++) {
      const nextEp = animeEpisodes[i];
      if (isRegularAired(nextEp) && !isEpDone(nextEp)) {
        return formatEp(nextEp);
      }
    }
    return null;
  }

  return null;
}

export function useAnimePreferredSeason({
  episodes,
  metaId,
  trackId,
  traktWatched,
  anilistWatched,
  simklWatched,
  simklMap,
  malWatched,
  mwVersion,
}: {
  episodes: KitsuEpisode[];
  metaId: string;
  trackId?: string;
  traktWatched: Set<string>;
  anilistWatched?: Set<string>;
  simklWatched?: Set<string>;
  simklMap?: Map<string, Set<string>>;
  malWatched?: Set<string>;
  mwVersion: number;
}): string | null {
  return useMemo(() => {
    return selectAnimePreferredSeason({
      episodes,
      metaId,
      trackId,
      traktWatched,
      anilistWatched,
      simklWatched,
      simklMap,
      malWatched,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    episodes,
    metaId,
    trackId,
    traktWatched,
    anilistWatched,
    simklWatched,
    simklMap,
    malWatched,
    mwVersion,
  ]);
}
