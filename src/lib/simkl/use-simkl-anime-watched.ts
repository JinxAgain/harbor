import { useEffect, useMemo, useRef, useState } from "react";
import { airedOnly } from "@/lib/aired";
import type { KitsuEpisode } from "@/lib/providers/kitsu";
import { resolveAnimeAliasKeys } from "./ids";
import {
  loadSimklProgress,
  peekSimklWatchedMap,
  type WatchlistStatus,
} from "./list-status";
import { useSimkl } from "./provider";

export type SimklAnimeWatched = {
  watchedKeys: Set<string>;
  completed: boolean;
  simklMap: Map<string, Set<string>>;
};

const EMPTY: SimklAnimeWatched = {
  watchedKeys: new Set(),
  completed: false,
  simklMap: new Map(),
};

const ANIME_KEY = /^(kitsu|mal|anilist|anidb):/;

export function computeSimklAnimeWatched(
  candidateKeys: Array<string | null | undefined>,
  watchedMap: Map<string, Set<string>>,
  statusMap: Map<string, WatchlistStatus>,
  episodes: KitsuEpisode[],
): { watchedKeys: Set<string>; completed: boolean } {
  const watchedKeys = new Set<string>();
  const validKeys = candidateKeys.filter((k): k is string => Boolean(k));
  const animeKeys = validKeys.filter((k) => ANIME_KEY.test(k));
  const franchiseKeys = validKeys.filter((k) => !ANIME_KEY.test(k));

  for (const k of animeKeys) {
    const eps = watchedMap.get(k);
    if (eps) {
      for (const ep of eps) {
        watchedKeys.add(ep);
      }
    }
  }

  const hasMappedSeasons = episodes.some((e) => e.imdbSeason != null && e.imdbSeason >= 1);
  for (const k of franchiseKeys) {
    const eps = watchedMap.get(k);
    if (!eps) continue;
    if (!hasMappedSeasons) {
      for (const ep of eps) {
        watchedKeys.add(ep);
      }
      continue;
    }
    for (const ep of episodes) {
      if (ep.imdbSeason == null) continue;
      const providerKey = `${ep.imdbSeason}:${ep.imdbEpisode ?? ep.number}`;
      if (eps.has(providerKey)) {
        watchedKeys.add(`${ep.seasonNumber ?? 1}:${ep.number}`);
      }
    }
  }

  const statusKeys = animeKeys.length > 0 ? animeKeys : validKeys;
  const statusCompleted = statusKeys.some((k) => statusMap.get(k) === "completed");

  const sortedAired = airedOnly([...episodes], (e) => e.airdate).sort(
    (a, b) => (a.seasonNumber ?? 1) - (b.seasonNumber ?? 1) || a.number - b.number,
  );

  if (statusCompleted) {
    for (const ep of sortedAired) {
      watchedKeys.add(`${ep.seasonNumber ?? 1}:${ep.number}`);
    }
    return { watchedKeys, completed: true };
  }

  const completed =
    sortedAired.length > 0 &&
    sortedAired.every((ep) => watchedKeys.has(`${ep.seasonNumber ?? 1}:${ep.number}`));

  return { watchedKeys, completed };
}

export function useSimklAnimeWatched(
  harborId: string,
  episodes: KitsuEpisode[],
  imdbId?: string | null,
): SimklAnimeWatched {
  const { isConnected } = useSimkl();
  const [result, setResult] = useState<SimklAnimeWatched>(() => {
    if (!isConnected || !harborId) return EMPTY;
    const peeked = peekSimklWatchedMap();
    const candidateKeys = [harborId, imdbId].filter(Boolean);
    const { watchedKeys, completed } = computeSimklAnimeWatched(
      candidateKeys,
      peeked,
      new Map(),
      episodes,
    );
    return { watchedKeys, completed, simklMap: peeked };
  });

  const epSig = useMemo(
    () =>
      episodes
        .map((e) => `${e.id}:${e.seasonNumber ?? 1}:${e.number}:${e.airdate ?? ""}`)
        .join("|"),
    [episodes],
  );
  const episodesRef = useRef(episodes);
  episodesRef.current = episodes;

  useEffect(() => {
    if (!isConnected || !harborId) {
      setResult(EMPTY);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const [progress, aliasKeys] = await Promise.all([
          loadSimklProgress(),
          resolveAnimeAliasKeys(harborId, imdbId),
        ]);
        if (cancelled) return;
        const { watchedKeys, completed } = computeSimklAnimeWatched(
          aliasKeys,
          progress.watched,
          progress.statuses,
          episodesRef.current,
        );
        setResult({ watchedKeys, completed, simklMap: progress.watched });
      } catch {
        // Ignored, graceful fallback
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [harborId, imdbId, isConnected, epSig]);

  return result;
}

