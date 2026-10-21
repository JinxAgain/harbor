import { localCwEntry } from "@/lib/local-cw";
import { manualWatchedState } from "@/lib/manual-watched";
import {
  DEFAULT_WATCHED_THRESHOLD_PCT,
  isPlaybackFinished,
} from "@/lib/player/playback-finished";
import { readResumeEntry } from "@/lib/resume";

const FINISHED_RATIO = 0.85;

export type EpisodePoint = { season: number; episode: number };

type EpisodeRef = {
  season?: number | null;
  episode?: number | null;
  number?: number | null;
};

export function isEpisodeFinished(
  metaId: string,
  at: EpisodePoint,
  thresholdPct: number = DEFAULT_WATCHED_THRESHOLD_PCT,
  durationSec?: number,
): boolean {
  const manual = manualWatchedState(metaId, at.season, at.episode);
  if (manual !== undefined) return manual;
  const thresholdRatio = Math.max(0.7, Math.min(0.95, (thresholdPct || DEFAULT_WATCHED_THRESHOLD_PCT) / 100));
  const entry = readResumeEntry(metaId, at.season, at.episode);
  if (entry && entry.ms > 0) {
    if (typeof entry.pct === "number" && entry.pct >= Math.min(FINISHED_RATIO, thresholdRatio)) {
      return true;
    }
    if (durationSec && durationSec > 0 && isPlaybackFinished(entry.ms / 1000, durationSec, thresholdPct, [])) {
      return true;
    }
  }
  const lc = localCwEntry(metaId);
  if (
    lc &&
    lc.season === at.season &&
    lc.episode === at.episode &&
    lc.durationMs > 0 &&
    isPlaybackFinished(lc.positionMs / 1000, lc.durationMs / 1000, thresholdPct, [])
  ) {
    return true;
  }
  return false;
}

export function advancePastFinished(
  metaId: string,
  at: EpisodePoint,
  videos: EpisodeRef[] | undefined,
  thresholdPct: number = DEFAULT_WATCHED_THRESHOLD_PCT,
): EpisodePoint {
  if (!isEpisodeFinished(metaId, at, thresholdPct)) return at;
  const ordered = (videos ?? [])
    .map((v) => ({ season: v.season ?? 1, episode: v.episode ?? v.number ?? 0 }))
    .filter((v) => v.season >= 1 && v.episode >= 1)
    .sort((a, b) => a.season - b.season || a.episode - b.episode);
  const idx = ordered.findIndex((v) => v.season === at.season && v.episode === at.episode);
  if (idx < 0) return at;
  for (let i = idx + 1; i < ordered.length; i += 1) {
    if (!isEpisodeFinished(metaId, ordered[i], thresholdPct)) return ordered[i];
  }
  return at;
}
