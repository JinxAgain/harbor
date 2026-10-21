import { useEffect, useState, useSyncExternalStore } from "react";
import type { Meta } from "@/lib/cinemeta";
import { fetchListEntry as fetchAnilistEntry } from "@/lib/anilist/mutations";
import { useAnilist } from "@/lib/anilist/provider";
import { resolveAnilistMediaId } from "@/lib/anilist/sync";
import { getEpisodeProgress } from "@/lib/episode-progress";
import { fetchListEntry as fetchMalEntry, resolveMalMediaId } from "@/lib/mal/mutations";
import { useMal } from "@/lib/mal/provider";
import { manualWatchedState, manualWatchedVersion, subscribeManualWatched } from "@/lib/manual-watched";
import { animeSeriesFromStreamId, isAnimeId } from "@/lib/series-episodes";
import { loadSimklWatchedMap, simklWatchedForId } from "@/lib/simkl/list-status";
import { useSimkl } from "@/lib/simkl/provider";
import { resolveMeta } from "@/lib/meta-resource";
import { libraryGetOne } from "@/lib/stremio";
import { decodeWatchedEpisodes } from "@/lib/stremio-watched";
import { fetchWatchedKeySet } from "@/lib/trakt/history";
import { useTrakt } from "@/lib/trakt/provider";
import type { PlayEpisode } from "@/lib/view";

export function usePlayerWatched(params: {
  meta: Meta;
  authKey: string | null;
  imdbId: string | null;
  kitsuStreamId?: string;
  enabled: boolean;
}): { watchedFor: (ep: PlayEpisode) => boolean } {
  const { meta, authKey, imdbId, kitsuStreamId, enabled } = params;
  const animeId =
    animeSeriesFromStreamId(kitsuStreamId) ?? (isAnimeId(meta.id) ? meta.id : null);
  const { isConnected: traktConnected } = useTrakt();
  const { isConnected: simklConnected } = useSimkl();
  const { isConnected: anilistConnected } = useAnilist();
  const { isConnected: malConnected } = useMal();
  useSyncExternalStore(subscribeManualWatched, manualWatchedVersion);
  const [traktWatched, setTraktWatched] = useState<Set<string>>(() => new Set());
  const [simklWatched, setSimklWatched] = useState<Set<string>>(() => new Set());
  const [stremioWatched, setStremioWatched] = useState<Set<string>>(() => new Set());
  const [anilistWatched, setAnilistWatched] = useState<Set<string>>(() => new Set());
  const [malWatched, setMalWatched] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!enabled || !traktConnected) return;
    let cancelled = false;
    fetchWatchedKeySet()
      .then((s) => {
        if (!cancelled) setTraktWatched(s);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, traktConnected, meta.id]);

  useEffect(() => {
    if (!enabled || !simklConnected) return;
    let cancelled = false;
    loadSimklWatchedMap()
      .then((m) => {
        if (!cancelled) setSimklWatched(simklWatchedForId(m, imdbId, meta.id));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, simklConnected, meta.id, imdbId]);

  useEffect(() => {
    setAnilistWatched(new Set());
    if (!enabled || !anilistConnected || !animeId) return;
    let cancelled = false;
    void (async () => {
      const mediaId = await resolveAnilistMediaId(animeId).catch(() => null);
      if (cancelled || mediaId == null) return;
      const info = await fetchAnilistEntry(mediaId).catch(() => null);
      if (cancelled || !info?.entry) return;
      const { status, progress } = info.entry;
      const total = info.episodes ?? 0;
      const count = status === "COMPLETED" && total > 0 ? total : Math.max(0, progress);
      const keys = new Set<string>();
      for (let i = 1; i <= count; i++) keys.add(`1:${i}`);
      setAnilistWatched(keys);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, anilistConnected, animeId]);

  useEffect(() => {
    setMalWatched(new Set());
    if (!enabled || !malConnected || !animeId) return;
    let cancelled = false;
    void (async () => {
      const malId = await resolveMalMediaId(animeId).catch(() => null);
      if (cancelled || malId == null) return;
      const info = await fetchMalEntry(malId).catch(() => null);
      if (cancelled || !info?.entry) return;
      const { status, numEpisodesWatched } = info.entry;
      const total = info.numEpisodes ?? 0;
      const count = status === "completed" && total > 0 ? total : Math.max(0, numEpisodesWatched);
      const keys = new Set<string>();
      for (let i = 1; i <= count; i++) keys.add(`1:${i}`);
      setMalWatched(keys);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, malConnected, animeId]);

  useEffect(() => {
    if (!enabled || !authKey) return;
    let cancelled = false;
    void (async () => {
      const item = await libraryGetOne(authKey, meta.id).catch(() => null);
      const watched = item?.state?.watched;
      if (!watched || cancelled) return;
      const full = await resolveMeta(authKey, "series", meta.id).catch(() => null);
      const keys = await decodeWatchedEpisodes(watched, full?.videos);
      if (!cancelled) setStremioWatched(keys);
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, authKey, meta.id]);

  const imdbKey = meta.id.startsWith("tt") ? meta.id : imdbId;
  const watchedFor = (ep: PlayEpisode): boolean => {
    const epSeries = animeSeriesFromStreamId(ep.kitsuStreamId);
    const sameAnimeEntry = !epSeries || !animeId || epSeries === animeId;
    const primaryId = epSeries ?? animeId ?? meta.id;
    const prog = getEpisodeProgress(
      primaryId,
      ep.season,
      ep.episode,
      null,
      imdbKey,
      traktWatched,
      stremioWatched,
      sameAnimeEntry ? anilistWatched : undefined,
      simklWatched,
      sameAnimeEntry ? malWatched : undefined,
      ep.imdbSeason,
      ep.imdbEpisode,
    );
    if (
      prog.watched ||
      primaryId === meta.id ||
      manualWatchedState(meta.id, ep.season, ep.episode) === false
    ) {
      return prog.watched;
    }
    return getEpisodeProgress(
      meta.id,
      ep.season,
      ep.episode,
      null,
      imdbKey,
      traktWatched,
      stremioWatched,
      sameAnimeEntry ? anilistWatched : undefined,
      simklWatched,
      sameAnimeEntry ? malWatched : undefined,
      ep.imdbSeason,
      ep.imdbEpisode,
    ).watched;
  };

  return { watchedFor };
}
