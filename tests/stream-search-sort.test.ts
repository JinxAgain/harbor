import assert from "node:assert/strict";
import test from "node:test";
import type { ScoredStream } from "../src/lib/streams/types.ts";
import {
  compileStreamSearch,
  sortPickerStreams,
  streamSearchHaystack,
} from "../src/views/play-picker/stream-search-sort.ts";

function createMockStream(overrides: Partial<ScoredStream> = {}): ScoredStream {
  return {
    addonId: "test-addon",
    addonName: "Torrentio",
    parsedTitle: "Example Movie",
    episodeTitle: null,
    resolution: "1080p",
    hdrFormat: null,
    codec: "HEVC",
    source: "WEB-DL",
    audio: { codec: "AAC", channels: 2 },
    audioLanguages: ["en"],
    size: 2_000_000_000,
    seeders: 50,
    cached: {},
    cacheVerified: {},
    inLibrary: {},
    container: "mkv",
    releaseGroup: "FLUX",
    releaseGroupNormalized: "flux",
    remux: false,
    edition: null,
    year: 2024,
    yearRange: null,
    season: null,
    episode: null,
    episodeEnd: null,
    seasonPack: false,
    discIndex: null,
    repackIteration: 0,
    proper: false,
    hardcoded: false,
    animeHash: null,
    scamScore: 0,
    score: 100,
    reasons: [],
    tier: "1080p",
    ...overrides,
  };
}

test("streamSearchHaystack joins all stream text fields", () => {
  const stream = createMockStream({
    name: "[RD+] Torrentio",
    title: "Movie.2024.1080p.mkv",
    description: "Multi-Audio 5.1",
    behaviorHints: { filename: "internal_name.mkv" },
    addonName: "Torrentio RD",
    releaseGroup: "FLUX",
    edition: "Extended Cut",
  });

  const haystack = streamSearchHaystack(stream);
  assert.ok(haystack.includes("[RD+] Torrentio"));
  assert.ok(haystack.includes("Movie.2024.1080p.mkv"));
  assert.ok(haystack.includes("Multi-Audio 5.1"));
  assert.ok(haystack.includes("internal_name.mkv"));
  assert.ok(haystack.includes("Torrentio RD"));
  assert.ok(haystack.includes("FLUX"));
  assert.ok(haystack.includes("Extended Cut"));
});

test("compileStreamSearch returns inactive for empty or whitespace query", () => {
  const resEmpty = compileStreamSearch("", "plain");
  assert.equal(resEmpty.active, false);
  assert.equal(resEmpty.error, null);
  assert.equal(resEmpty.test(createMockStream()), true);

  const resWhitespace = compileStreamSearch("   \t\n  ", "regex");
  assert.equal(resWhitespace.active, false);
  assert.equal(resWhitespace.error, null);
  assert.equal(resWhitespace.test(createMockStream()), true);
});

test("compileStreamSearch plain mode matches case-insensitively with literal characters", () => {
  const search = compileStreamSearch("[rd+]", "plain");
  assert.equal(search.active, true);
  assert.equal(search.error, null);

  const matching = createMockStream({ name: "[RD+] Torrentio 1080p" });
  const nonMatching = createMockStream({ name: "Torrentio 1080p" });

  assert.equal(search.test(matching), true);
  assert.equal(search.test(nonMatching), false);
});

test("compileStreamSearch whole-word mode matches exact words and handles delimiters", () => {
  const search = compileStreamSearch("AAC", "whole-word");
  assert.equal(search.active, true);
  assert.equal(search.error, null);

  const standaloneWord = createMockStream({ title: "Movie 1080p AAC 5.1" });
  const bracketDelimited = createMockStream({ title: "Movie 1080p [AAC] FLUX" });
  const partialMatch = createMockStream({ title: "Movie 1080p FAAC 5.1" });
  const suffixMatch = createMockStream({ title: "Movie 1080p AAC3 5.1" });

  assert.equal(search.test(standaloneWord), true);
  assert.equal(search.test(bracketDelimited), true);
  assert.equal(search.test(partialMatch), false);
  assert.equal(search.test(suffixMatch), false);
});

test("compileStreamSearch wildcard mode supports * and ? while escaping regex symbols", () => {
  const search = compileStreamSearch("Movie*1080p?FLUX", "wildcard");
  assert.equal(search.active, true);
  assert.equal(search.error, null);

  const matching = createMockStream({ title: "Movie.2024.1080p.FLUX" });
  const nonMatching = createMockStream({ title: "Movie.2024.720p.FLUX" });

  assert.equal(search.test(matching), true);
  assert.equal(search.test(nonMatching), false);

  // Literal brackets in wildcard
  const searchBrackets = compileStreamSearch("[RD*]", "wildcard");
  const rdStream = createMockStream({ name: "[RD+] Movie" });
  const nonRdStream = createMockStream({ name: "RD Movie" });
  assert.equal(searchBrackets.test(rdStream), true);
  assert.equal(searchBrackets.test(nonRdStream), false);
});

test("compileStreamSearch regex mode evaluates regex and catches syntax errors gracefully", () => {
  const validRegex = compileStreamSearch("\\b(hevc|x265)\\b.*10bit", "regex");
  assert.equal(validRegex.active, true);
  assert.equal(validRegex.error, null);

  const matching = createMockStream({ title: "Movie.x265.10bit.HDR" });
  const nonMatching = createMockStream({ title: "Movie.h264.8bit" });

  assert.equal(validRegex.test(matching), true);
  assert.equal(validRegex.test(nonMatching), false);

  // Invalid regex should not throw, returns error and tests false
  const invalidRegex = compileStreamSearch("[unclosed-group(", "regex");
  assert.equal(invalidRegex.active, true);
  assert.notEqual(invalidRegex.error, null);
  assert.equal(invalidRegex.test(matching), false);
});

test("sortPickerStreams default preserves defaultOrder", () => {
  const s1 = createMockStream({ title: "Stream 1", size: 100 });
  const s2 = createMockStream({ title: "Stream 2", size: 200 });
  const defaultOrder = (arr: ScoredStream[]) => [arr[1], arr[0]];

  const sorted = sortPickerStreams([s1, s2], "default", "desc", defaultOrder);
  assert.deepEqual(sorted, [s2, s1]);
});

test("sortPickerStreams size sorts desc and asc with nulls placed last", () => {
  const small = createMockStream({ title: "Small", size: 1_000_000_000 });
  const large = createMockStream({ title: "Large", size: 5_000_000_000 });
  const noSize = createMockStream({ title: "NoSize", size: null });
  const zeroSize = createMockStream({ title: "ZeroSize", size: 0 });
  const defaultOrder = (arr: ScoredStream[]) => arr;

  const desc = sortPickerStreams([noSize, small, zeroSize, large], "size", "desc", defaultOrder);
  assert.deepEqual(desc, [large, small, noSize, zeroSize]);

  const asc = sortPickerStreams([noSize, small, zeroSize, large], "size", "asc", defaultOrder);
  assert.deepEqual(asc, [small, large, noSize, zeroSize]);
});

test("sortPickerStreams seeders sorts desc and asc with nulls placed last", () => {
  const few = createMockStream({ title: "Few", seeders: 5 });
  const many = createMockStream({ title: "Many", seeders: 500 });
  const zero = createMockStream({ title: "Zero", seeders: 0 });
  const noSeeders = createMockStream({ title: "NoSeeders", seeders: null });
  const defaultOrder = (arr: ScoredStream[]) => arr;

  const desc = sortPickerStreams([few, noSeeders, zero, many], "seeders", "desc", defaultOrder);
  assert.deepEqual(desc, [many, few, zero, noSeeders]);

  const asc = sortPickerStreams([few, noSeeders, zero, many], "seeders", "asc", defaultOrder);
  assert.deepEqual(asc, [zero, few, many, noSeeders]);
});

test("sortPickerStreams resolution sorts 4K > 1080p > 720p > 480p > SD and respects tier bonuses", () => {
  const dv4k = createMockStream({ title: "4K DV", resolution: "4K", tier: "4K_DV" });
  const hdr4k = createMockStream({ title: "4K HDR", resolution: "4K", tier: "4K_HDR" });
  const sdr4k = createMockStream({ title: "4K SDR", resolution: "4K", tier: "4K" });
  const p1080 = createMockStream({ title: "1080p", resolution: "1080p", tier: "1080p" });
  const p720 = createMockStream({ title: "720p", resolution: "720p", tier: "720p" });
  const sd = createMockStream({ title: "SD", resolution: "SD", tier: "SD" });
  const defaultOrder = (arr: ScoredStream[]) => arr;

  const desc = sortPickerStreams([p720, sd, hdr4k, p1080, dv4k, sdr4k], "resolution", "desc", defaultOrder);
  assert.deepEqual(desc, [dv4k, hdr4k, sdr4k, p1080, p720, sd]);

  const asc = sortPickerStreams([p720, sd, hdr4k, p1080, dv4k, sdr4k], "resolution", "asc", defaultOrder);
  assert.deepEqual(asc, [sd, p720, p1080, sdr4k, hdr4k, dv4k]);
});

test("sortPickerStreams score sorts desc and asc with ties falling back to defaultOrder", () => {
  const high1 = createMockStream({ title: "High 1", score: 95 });
  const high2 = createMockStream({ title: "High 2", score: 95 });
  const low = createMockStream({ title: "Low", score: 40 });
  const defaultOrder = (arr: ScoredStream[]) => arr;

  const desc = sortPickerStreams([low, high1, high2], "score", "desc", defaultOrder);
  assert.deepEqual(desc, [high1, high2, low]);

  const asc = sortPickerStreams([low, high1, high2], "score", "asc", defaultOrder);
  assert.deepEqual(asc, [low, high1, high2]);
});
