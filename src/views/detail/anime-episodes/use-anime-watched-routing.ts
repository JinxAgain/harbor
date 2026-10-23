import { useMemo } from "react";
import type { Meta } from "@/lib/cinemeta";
import type { FranchiseEntry } from "@/lib/providers/anime-detail";
import type { KitsuEpisode } from "@/lib/providers/kitsu";
import {
  recordManualWatchedMeta,
  setManualWatchedMany,
  type ManualWatchedMeta,
} from "@/lib/manual-watched";
import { syncAnimeProgress } from "@/lib/anilist/sync";
import { syncMalProgress } from "@/lib/mal/sync";
import { useSettings } from "@/lib/settings";
import { useSimkl } from "@/lib/simkl/provider";
import { resolveSimklAnimeShowIds } from "@/lib/simkl/ids";
import { markEpisodesWatched, unmarkEpisodesWatched } from "@/lib/simkl/history";
import type { SimklIds } from "@/lib/simkl/types";
import { airedOnly } from "../helpers";
import { animeSeasonKey } from "./anime-season-key";

const ANIME_TRACK_ID = /^(kitsu|mal|anilist|anidb):/;

export async function syncSimklWatchedMany(
  syncId: string,
  eps: Array<{ season: number; episode: number }>,
  watched: boolean,
  dispatchers?: {
    resolveIds?: (id: string) => Promise<SimklIds | null>;
    mark?: typeof markEpisodesWatched;
    unmark?: typeof unmarkEpisodesWatched;
  },
): Promise<boolean> {
  const resolveIds = dispatchers?.resolveIds ?? resolveSimklAnimeShowIds;
  const mark = dispatchers?.mark ?? markEpisodesWatched;
  const unmark = dispatchers?.unmark ?? unmarkEpisodesWatched;

  const ids = await resolveIds(syncId).catch(() => null);
  if (!ids) return false;

  const bySeason = new Map<number, number[]>();
  for (const ep of eps) {
    const list = bySeason.get(ep.season) ?? [];
    list.push(ep.episode);
    bySeason.set(ep.season, list);
  }

  let ok = true;
  for (const [season, epNums] of bySeason) {
    if (watched) {
      const res = await mark(ids, season, epNums).catch(() => false);
      if (!res) ok = false;
    } else {
      const res = await unmark(ids, season, epNums).catch(() => false);
      if (!res) ok = false;
    }
  }
  return ok;
}

export function useAnimeWatchedRouting(meta: Meta, franchise: FranchiseEntry[], trackId?: string) {
  const { settings } = useSettings();
  const { isConnected: simklConnected } = useSimkl();
  const byId = useMemo(() => {
    const m = new Map<string, Meta>();
    for (const f of franchise) m.set(f.meta.id, f.meta);
    return m;
  }, [franchise]);

  const metaForEp = (ep: KitsuEpisode): Meta => {
    if (!ep.sourceMetaId) return meta;
    return byId.get(ep.sourceMetaId) ?? { id: ep.sourceMetaId, type: "series", name: meta.name };
  };

  const manualMetaFor = (metaId: string): ManualWatchedMeta => {
    const m = metaId === meta.id ? meta : (byId.get(metaId) ?? meta);
    return { type: "series", name: m.name, poster: m.poster, background: m.background };
  };

  const markMany = (displayEpisodes: KitsuEpisode[], watched: boolean) => {
    const eligible = watched ? airedOnly(displayEpisodes, (ep) => ep.airdate) : displayEpisodes;
    if (eligible.length === 0) return;
    const groups = new Map<string, Array<{ season: number; episode: number }>>();
    for (const ep of eligible) {
      const id = ep.sourceMetaId ?? meta.id;
      const list = groups.get(id) ?? [];
      list.push({
        season: animeSeasonKey(ep),
        episode: ep.number,
      });
      groups.set(id, list);
    }
    for (const [id, eps] of groups) {
      if (watched) recordManualWatchedMeta(id, manualMetaFor(id));
      setManualWatchedMany(id, eps, watched);
      const syncId =
        id === meta.id && trackId && ANIME_TRACK_ID.test(trackId) && !ANIME_TRACK_ID.test(id)
          ? trackId
          : id;
      if (watched && ANIME_TRACK_ID.test(syncId)) {
        const highest = Math.max(...eps.map((e) => e.episode));
        if (Number.isFinite(highest) && highest > 0) {
          const title = manualMetaFor(id).name;
          if (settings.anilistAutoSync) void syncAnimeProgress(syncId, highest, title);
          if (settings.malAutoSync) void syncMalProgress(syncId, highest, title);
        }
      }
      if (simklConnected) {
        void syncSimklWatchedMany(syncId, eps, watched);
      }
    }
  };

  return { metaForEp, manualMetaFor, markMany };
}
