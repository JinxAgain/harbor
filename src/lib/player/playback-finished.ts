import { getSkipSegmentsView } from "@/lib/skip-intro/segment-store";

export const DEFAULT_WATCHED_THRESHOLD_PCT = 85;
const ED_REMAINING_WINDOW_SEC = 180; // 3 minutes
const ED_MIN_PROGRESS_RATIO = 0.75; // 75%
const MIN_OUTRO_START_RATIO = 0.5; // Outro must be in second half of media

export function isPlaybackFinished(
  positionSec: number,
  durationSec: number,
  thresholdPct: number = DEFAULT_WATCHED_THRESHOLD_PCT,
  overrideSegments?: Array<{ kind: string; startSec: number; endSec: number }>,
): boolean {
  if (durationSec <= 0 || positionSec <= 0) return false;
  const ratio = positionSec / durationSec;
  const pct = Number.isFinite(thresholdPct) ? thresholdPct : DEFAULT_WATCHED_THRESHOLD_PCT;
  const thresholdRatio = Math.max(0.7, Math.min(0.95, pct / 100));

  // 1. Outro segment reached (AniSkip / Chapters >> Next Episode trigger)
  const segments = overrideSegments ?? getSkipSegmentsView();
  const outro = segments.find(
    (s) => s.kind === "outro" && s.startSec >= durationSec * MIN_OUTRO_START_RATIO,
  );
  if (outro && positionSec >= outro.startSec - 1) {
    return true;
  }

  // 2. Percentage threshold reached
  if (ratio >= thresholdRatio) return true;

  // 3. ED heuristic: within last 3 minutes and at least 75% watched
  const remainingSec = durationSec - positionSec;
  if (ratio >= ED_MIN_PROGRESS_RATIO && remainingSec <= ED_REMAINING_WINDOW_SEC) {
    return true;
  }

  return false;
}
