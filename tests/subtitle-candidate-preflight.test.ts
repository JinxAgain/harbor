// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  choosePreparedCandidate,
  classifyIdentityTiming,
  preparedCandidateAutoSelectionEligible,
  probePreparedSubtitleBatch,
  preflightPreparedCandidates,
  type TimingMeasurement,
} from "../src/lib/subtitles/candidate-preflight.ts";
import type { PreparedSubtitle, PreparedCandidateResult } from "../src/lib/subtitles/prepare.ts";
import {
  registerPreparedSubtitle,
  takePreparedSubtitle,
} from "../src/lib/subtitles/prepared-registry.ts";
import {
  isAutoSelectableSubtitleTrack,
  pickDesiredSubtitleTrack,
} from "../src/lib/subtitles/track-selection.ts";

function prepared(name: string): PreparedSubtitle {
  return {
    originalUrl: name,
    playableUrl: `memory:${name}`,
    format: "srt",
    cues: [
      { start: 1, end: 2, text: "one" },
      { start: 5, end: 6, text: "two" },
      { start: 10, end: 11, text: "three" },
      { start: 15, end: 16, text: "four" },
    ],
    text: "",
    encoding: "utf-8",
    encodingHealth: 1,
    encodingDiagnostics: [],
    archive: false,
    cleanup: () => {},
  };
}

test("identity timing never fabricates quality for an unknown measurement", () => {
  assert.equal(classifyIdentityTiming({ status: "unknown", reason: "timeout" }), "unmeasurable");
  assert.equal(
    classifyIdentityTiming({ status: "unknown", reason: "audio-unavailable" }),
    "unmeasurable",
  );
});

test("bounded preflight classifies aligned, fixed-offset, drifting, and different-cut", () => {
  const identity = { ncc: 0.2, coverage: 0.3, z: 2 };
  assert.equal(
    classifyIdentityTiming({
      status: "measured",
      value: { ncc: 0.9, coverage: 0.85, z: 8 },
      method: "bounded-audio-preflight",
    }),
    "aligned",
  );
  assert.equal(
    classifyIdentityTiming({
      status: "measured",
      value: identity,
      best: { ncc: 0.82, coverage: 0.8, z: 7 },
      bestTransform: { offsetSec: 3.5, ratio: 1 },
      method: "bounded-audio-preflight",
    }),
    "fixed-offset",
  );
  assert.equal(
    classifyIdentityTiming({
      status: "measured",
      value: identity,
      best: { ncc: 0.82, coverage: 0.8, z: 7 },
      bestTransform: { offsetSec: 1, ratio: 25 / 24 },
      method: "bounded-audio-preflight",
    }),
    "drifting",
  );
  assert.equal(
    classifyIdentityTiming({
      status: "measured",
      value: identity,
      method: "bounded-audio-preflight",
    }),
    "different-cut",
  );
  assert.equal(
    classifyIdentityTiming({ status: "unknown", reason: "insufficient-data" }, "invalid"),
    "invalid",
  );
});

test("default preflight validates cue timelines locally without invoking FFmpeg IPC", async () => {
  const valid = prepared("valid");
  const shortDuration = await probePreparedSubtitleBatch([valid], {
    mediaUrl: "file:///movie.mkv",
    durationSec: 30,
  });
  assert.deepEqual(shortDuration, [{ status: "unknown", reason: "insufficient-data" }]);

  const invalid = {
    ...prepared("invalid"),
    cues: [
      { start: 10, end: 11, text: "out of order 1" },
      { start: 5, end: 6, text: "out of order 2" },
      { start: 12, end: 13, text: "three" },
      { start: 14, end: 15, text: "four" },
    ],
  };
  const measurements = await probePreparedSubtitleBatch([valid, invalid], {
    mediaUrl: "file:///movie.mkv",
    durationSec: 120,
  });
  assert.deepEqual(measurements, [
    { status: "unknown", reason: "not-supported" },
    { status: "unknown", reason: "insufficient-data" },
  ]);
});

test("a naturally aligned prepared subtitle is preferred over a higher-ranked different cut", async () => {
  const inputs: PreparedCandidateResult<string>[] = [
    { status: "prepared", candidate: "popular-wrong", prepared: prepared("wrong"), rank: 0 },
    { status: "prepared", candidate: "release-correct", prepared: prepared("right"), rank: 1 },
  ];
  const probe = async (item: PreparedSubtitle): Promise<TimingMeasurement> =>
    item.originalUrl === "right"
      ? {
          status: "measured",
          value: { ncc: 0.9, coverage: 0.86, z: 8 },
          method: "identity-audio-preflight",
        }
      : {
          status: "measured",
          value: { ncc: 0.08, coverage: 0.12, z: 1 },
          method: "identity-audio-preflight",
        };
  const results = await preflightPreparedCandidates(
    inputs,
    { mediaUrl: "https://example.test/video", durationSec: 120 },
    { probe },
  );

  const chosen = choosePreparedCandidate(results, {
    rankOf: (candidate) => candidate.rank,
  });
  assert.equal(chosen?.candidate, "release-correct");
  assert.equal(chosen?.timingStatus, "aligned");
  assert.match(chosen?.explanation.reasons.join(" ") ?? "", /audio timing verified/);
});

test("unknown timing is retained as unknown and falls back by deterministic rank", async () => {
  const inputs: PreparedCandidateResult<string>[] = [
    { status: "prepared", candidate: "first", prepared: prepared("first"), rank: 0 },
    { status: "prepared", candidate: "second", prepared: prepared("second"), rank: 1 },
  ];
  const results = await preflightPreparedCandidates(
    inputs,
    { mediaUrl: "https://example.test/video", durationSec: 120 },
    { probe: async () => ({ status: "unknown", reason: "timeout" }) },
  );

  assert.equal(
    results.every((result) => result.measurement.status === "unknown"),
    true,
  );
  assert.equal(choosePreparedCandidate(results)?.candidate, "first");
});

test("bounded corrections do not displace a higher-ranked exact candidate", async () => {
  const inputs: PreparedCandidateResult<string>[] = [
    { status: "prepared", candidate: "exact", prepared: prepared("exact"), rank: 0 },
    { status: "prepared", candidate: "offset", prepared: prepared("offset"), rank: 1 },
    { status: "prepared", candidate: "drift", prepared: prepared("drift"), rank: 2 },
  ];
  const probe = async (item: PreparedSubtitle): Promise<TimingMeasurement> => {
    if (item.originalUrl === "exact") return { status: "unknown", reason: "timeout" };
    return {
      status: "measured",
      value: { ncc: 0.2, coverage: 0.3, z: 2 },
      best: { ncc: 0.82, coverage: 0.8, z: 7 },
      bestTransform:
        item.originalUrl === "offset"
          ? { offsetSec: 3.5, ratio: 1 }
          : { offsetSec: 1, ratio: 25 / 24 },
      method: "bounded-audio-preflight",
    };
  };
  const results = await preflightPreparedCandidates(
    inputs,
    { mediaUrl: "https://example.test/video", durationSec: 120 },
    { probe },
  );

  assert.deepEqual(
    results.map((result) => result.timingStatus),
    ["unmeasurable", "fixed-offset", "drifting"],
  );
  assert.equal(choosePreparedCandidate(results)?.candidate, "exact");
});

test("prepared subtitle ownership transfers with parsed cues exactly once", () => {
  const item = prepared("owned");
  registerPreparedSubtitle(item);
  assert.equal(takePreparedSubtitle(item.playableUrl), item);
  assert.equal(takePreparedSubtitle(item.playableUrl), null);
});

test("legacy automatic selection cannot override prepared preflight safety", () => {
  const chosen = pickDesiredSubtitleTrack(
    [
      {
        id: "different-cut",
        lang: "en",
        external: true,
        prepared: true,
        autoSelectionEligible: true,
        timingStatus: "different-cut" as const,
        matchConfidence: "exact" as const,
        matchScore: 999,
      },
      {
        id: "unprepared",
        lang: "en",
        external: true,
        prepared: false,
        autoSelectionEligible: true,
        matchConfidence: "exact" as const,
        matchScore: 998,
      },
      {
        id: "prepared-but-unprobed",
        lang: "en",
        external: true,
        prepared: true,
        matchConfidence: "exact" as const,
        matchScore: 997,
      },
      {
        id: "aligned",
        lang: "en",
        external: true,
        prepared: true,
        autoSelectionEligible: true,
        timingStatus: "aligned" as const,
        matchConfidence: "high" as const,
        matchScore: 50,
      },
      {
        id: "foreign-only",
        lang: "en",
        external: true,
        prepared: true,
        autoSelectionEligible: true,
        foreignOnly: true,
        matchConfidence: "exact" as const,
      },
    ],
    ["en"],
    false,
  );
  assert.equal(chosen?.id, "aligned");
});

test("prepared external tracks require explicit preflight auto-selection eligibility", () => {
  const chosen = pickDesiredSubtitleTrack(
    [
      {
        id: "unprobed-extra",
        lang: "en",
        external: true,
        prepared: true,
        matchConfidence: "exact" as const,
      },
    ],
    ["en"],
    false,
  );
  assert.equal(chosen, null);
});

test("prepared candidates require both an enabled run and a current selection lease", () => {
  const candidate = {
    candidate: "safe",
    prepared: prepared("safe"),
    rank: 0,
    measurement: { status: "unknown", reason: "timeout" } as const,
    timingStatus: "unmeasurable" as const,
    cueSpanSane: true,
    outputFormatSafe: true,
    explanation: {
      compatibilityPercent: 80,
      releaseConfidence: "high",
      timingStatus: "unmeasurable" as const,
      reasons: [],
    },
  };

  assert.equal(
    preparedCandidateAutoSelectionEligible(candidate, {
      autoSelect: false,
      selectionLeaseValid: true,
    }),
    false,
  );
  assert.equal(
    preparedCandidateAutoSelectionEligible(candidate, {
      autoSelect: true,
      selectionLeaseValid: false,
    }),
    false,
  );
  assert.equal(
    preparedCandidateAutoSelectionEligible(candidate, {
      autoSelect: true,
      selectionLeaseValid: true,
    }),
    true,
  );
});

test("forced-track auto selection uses the same preparation safety gate", () => {
  assert.equal(
    isAutoSelectableSubtitleTrack({
      id: "raw-forced",
      external: true,
      forced: true,
      prepared: false,
      autoSelectionEligible: true,
    }),
    false,
  );
  assert.equal(
    isAutoSelectableSubtitleTrack({
      id: "safe-forced",
      external: true,
      forced: true,
      prepared: true,
      autoSelectionEligible: true,
      timingStatus: "aligned",
    }),
    true,
  );
});
