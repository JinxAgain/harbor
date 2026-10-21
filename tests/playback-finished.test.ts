import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WATCHED_THRESHOLD_PCT,
  isPlaybackFinished,
} from "../src/lib/player/playback-finished.ts";
import {
  setSkipSegmentsView,
} from "../src/lib/skip-intro/segment-store.ts";
import {
  advancePastFinished,
  isEpisodeFinished,
} from "../src/lib/detail-resume-advance.ts";
import {
  setManualWatched,
} from "../src/lib/manual-watched.ts";
import {
  clearResume,
  saveResumeMs,
} from "../src/lib/resume.ts";
import {
  clearLocalCw,
  saveLocalCw,
} from "../src/lib/local-cw.ts";

// Ensure mock localStorage exists in Node test environment
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, String(v)),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    length: 0,
  } as Storage;
}

test("isPlaybackFinished: default threshold is 85%", () => {
  assert.equal(DEFAULT_WATCHED_THRESHOLD_PCT, 85);
});

test("isPlaybackFinished: invalid or zero duration/position returns false", () => {
  assert.equal(isPlaybackFinished(0, 1000), false);
  assert.equal(isPlaybackFinished(100, 0), false);
  assert.equal(isPlaybackFinished(-10, 1000), false);
  assert.equal(isPlaybackFinished(100, -1000), false);
});

test("isPlaybackFinished: mid-episode progress at 50% returns false", () => {
  assert.equal(isPlaybackFinished(720, 1440), false);
});

test("isPlaybackFinished: active outro segment via overrideSegments or store returns true", () => {
  // 28m35s (1715s) episode at 22m00s (1320s = 76.97% progress), outro starts at 1320s
  const outro = [{ kind: "outro", startSec: 1320, endSec: 1715 }];
  assert.equal(isPlaybackFinished(1320, 1715, 85, outro), true);
  // Also when position is 1 second before outro startSec (positionSec >= outro.startSec - 1)
  assert.equal(isPlaybackFinished(1319, 1715, 85, outro), true);
  // 2 seconds before outro is not finished yet if below threshold and remaining > 180
  // Note: 1715 - 1318 = 397s remaining (> 180s), ratio = 1318/1715 = 76.8% (< 85%)
  assert.equal(isPlaybackFinished(1318, 1715, 85, outro), false);

  // Active outro segment from segment store
  setSkipSegmentsView([{ kind: "outro", startSec: 1350, endSec: 1620, label: "Ending" }]);
  // 27m (1620s) anime at 22m50s (1370s = 84.57%) inside outro starting at 1350s
  assert.equal(isPlaybackFinished(1370, 1620, 85), true);
  // Clean up store
  setSkipSegmentsView([]);
});

test("isPlaybackFinished: percentage threshold reached", () => {
  // 24m (1440s) anime at 21m30s (1290s = 89.58%), default 85% threshold
  assert.equal(isPlaybackFinished(1290, 1440, 85, []), true);

  // 27m (1620s) anime at 22m50s (1370s = 84.57%) with 80% custom threshold
  assert.equal(isPlaybackFinished(1370, 1620, 80, []), true);
  // Same episode at 84.57% with 85% threshold and no outro segment and >180s left (1620 - 1370 = 250s)
  assert.equal(isPlaybackFinished(1370, 1620, 85, []), false);
});

test("isPlaybackFinished: ED fallback heuristic (ratio >= 0.75 && remainingSec <= 180)", () => {
  // 20m (1200s) episode at 17m00s (1020s, ratio = 0.85, remaining = 180s)
  // Even if threshold is set to 95%, remainingSec <= 180 and ratio >= 0.75 triggers ED heuristic
  assert.equal(isPlaybackFinished(1020, 1200, 95, []), true);

  // 27m (1620s) anime at 24m00s (1440s = 88.88%, 180s left) with 95% threshold
  assert.equal(isPlaybackFinished(1440, 1620, 95, []), true);

  // But if remainingSec > 180 (e.g. 190s left = 1430s / 1620s = 88.27%) and threshold is 95% -> false
  assert.equal(isPlaybackFinished(1430, 1620, 95, []), false);

  // And if ratio < 0.75 even if remaining <= 180 (impossible for long videos, but for a 200s short clip at 100s, 100s remaining <= 180, ratio = 0.5 < 0.75) -> false
  assert.equal(isPlaybackFinished(100, 200, 85, []), false);
});

test("isPlaybackFinished: ignores outro if it starts in the first half of media", () => {
  // Outro starting at 40% of media should not trigger completion early
  const bogusOutro = [{ kind: "outro", startSec: 400, endSec: 500 }];
  assert.equal(isPlaybackFinished(450, 1000, 85, bogusOutro), false);
});

test("isEpisodeFinished: respects manual watched state over resume entries", () => {
  const metaId = "test_manual_series";
  setManualWatched(metaId, 1, 1, true);
  assert.equal(isEpisodeFinished(metaId, { season: 1, episode: 1 }), true);

  setManualWatched(metaId, 1, 2, false);
  assert.equal(isEpisodeFinished(metaId, { season: 1, episode: 2 }), false);
});

test("isEpisodeFinished: evaluates resume entries against watchedThreshold", () => {
  const metaId = "test_resume_series";
  // Saved at 88% pct (exceeds default 85% threshold)
  saveResumeMs(metaId, 1290000, 1, 3, undefined, 0.88);
  assert.equal(isEpisodeFinished(metaId, { season: 1, episode: 3 }, 85), true);

  // Saved at 78% pct (below 85% default, but finished under 75% threshold)
  saveResumeMs(metaId, 1100000, 1, 4, undefined, 0.78);
  assert.equal(isEpisodeFinished(metaId, { season: 1, episode: 4 }, 85), false);
  assert.equal(isEpisodeFinished(metaId, { season: 1, episode: 4 }, 75), true);

  clearResume(metaId, 1, 3);
  clearResume(metaId, 1, 4);
});

test("isEpisodeFinished: checks localCwEntry and advances past finished episodes", () => {
  const metaId = "test_lc_series";
  clearLocalCw(metaId);

  // Save localCw entry for S1:E1 at 86%
  saveLocalCw({
    id: metaId,
    type: "series",
    name: "Test Series",
    season: 1,
    episode: 1,
    positionMs: 1250000,
    durationMs: 1440000,
    t: Date.now(),
  });

  assert.equal(isEpisodeFinished(metaId, { season: 1, episode: 1 }, 85), true);
  assert.equal(isEpisodeFinished(metaId, { season: 1, episode: 2 }, 85), false);

  const videos = [
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 1, episode: 3 },
  ];

  // advancePastFinished should advance from E1 to E2
  const next = advancePastFinished(metaId, { season: 1, episode: 1 }, videos, 85);
  assert.deepEqual(next, { season: 1, episode: 2 });

  // If E2 is also marked watched manually, advance to E3
  setManualWatched(metaId, 1, 2, true);
  const next2 = advancePastFinished(metaId, { season: 1, episode: 1 }, videos, 85);
  assert.deepEqual(next2, { season: 1, episode: 3 });

  clearLocalCw(metaId);
});
