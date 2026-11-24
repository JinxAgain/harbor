import assert from "node:assert/strict";
import test from "node:test";
import type { ScoredStream } from "../src/lib/streams/types.ts";
import {
  compileStreamSearch,
  defaultSortStreams,
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

  const desc = sortPickerStreams(
    [p720, sd, hdr4k, p1080, dv4k, sdr4k],
    "resolution",
    "desc",
    defaultOrder,
  );
  assert.deepEqual(desc, [dv4k, hdr4k, sdr4k, p1080, p720, sd]);

  const asc = sortPickerStreams(
    [p720, sd, hdr4k, p1080, dv4k, sdr4k],
    "resolution",
    "asc",
    defaultOrder,
  );
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

test("defaultSortStreams sorts Resolution > Seeders > Size and keeps 4K above high-seeder 1080p", () => {
  const uhdLowSeedSmall = createMockStream({
    name: "[PikPak 🧲] StremList 2160p",
    title: "Movie.2026.2160p.WEB-DL.H265.mkv",
    resolution: "4K",
    tier: "4K_DV",
    seeders: 2,
    size: 10 * 1024 ** 3,
    score: 25,
  });
  const uhdHighSeed = createMockStream({
    name: "[PikPak 🧲] StremList 2160p",
    title: "Movie.2026.2160p.WEB-DL.H265.mkv",
    resolution: "4K",
    tier: "4K",
    seeders: 12,
    size: 18 * 1024 ** 3,
    score: 20,
  });
  const fhdHighSeed = createMockStream({
    name: "[PikPak 🧲] StremList 1080p",
    title: "Movie.2026.1080p.WEBRip.x265.mkv",
    resolution: "1080p",
    tier: "1080p",
    seeders: 8930,
    size: 2 * 1024 ** 3,
    score: 90,
  });
  const fhdMedSeedLarge = createMockStream({
    name: "[PikPak 🧲] StremList 1080p",
    title: "Movie.2026.1080p.WEB-DL.H264.mkv",
    resolution: "1080p",
    tier: "1080p",
    seeders: 206,
    size: 12 * 1024 ** 3,
    score: 60,
  });
  const fhdMedSeedSmall = createMockStream({
    name: "[PikPak 🧲] StremList 1080p",
    title: "Movie.2026.1080p.WEB-DL.H264.mkv",
    resolution: "1080p",
    tier: "1080p",
    seeders: 206,
    size: 5 * 1024 ** 3,
    score: 70,
  });
  const hd720 = createMockStream({
    name: "[PikPak 🧲] StremList 720p",
    title: "Movie.2026.720p.WEB-DL.mkv",
    resolution: "720p",
    tier: "720p",
    seeders: 9999,
    size: 4 * 1024 ** 3,
  });

  const sorted = defaultSortStreams([
    hd720,
    fhdMedSeedSmall,
    uhdLowSeedSmall,
    fhdHighSeed,
    fhdMedSeedLarge,
    uhdHighSeed,
  ]);

  assert.deepEqual(sorted, [
    uhdHighSeed,
    uhdLowSeedSmall,
    fhdHighSeed,
    fhdMedSeedLarge,
    fhdMedSeedSmall,
    hd720,
  ]);
});

test("defaultSortStreams puts cached before uncached and sinks promo and unlabeled cards", () => {
  const promo = createMockStream({
    addonId: "com.hdhub",
    addonName: "HDHub",
    name: "🌟 Donation needed.",
    title: "Click here to donate to hdhub to keep the project alive.",
    url: "https://example.invalid/donate",
    resolution: "SD",
    source: "Other",
    size: null,
    seeders: null,
    tier: "SD",
    score: 999,
  });
  const unlabeled = createMockStream({
    addonId: "org.unlabeled",
    addonName: "Random",
    name: "Stream link",
    title: "Open stream",
    url: "https://example.invalid/watch",
    resolution: "SD",
    source: "Other",
    size: null,
    seeders: null,
    tier: "SD",
    score: 200,
  });
  const uncached4k = createMockStream({
    name: "[PikPak 🧲] StremList 2160p",
    title: "Movie.2160p.WEB-DL.mkv",
    resolution: "4K",
    tier: "4K",
    seeders: 50,
    size: 15 * 1024 ** 3,
  });
  const cached1080 = createMockStream({
    name: "[PikPak ⚡] StremList 1080p",
    title: "Movie.1080p.WEB-DL.mkv",
    resolution: "1080p",
    tier: "1080p",
    seeders: 10,
    size: 4 * 1024 ** 3,
  });

  assert.deepEqual(defaultSortStreams([promo, unlabeled, uncached4k, cached1080]), [
    cached1080,
    uncached4k,
    unlabeled,
    promo,
  ]);

  // preserveOrder keeps addon order for non-cached real streams while pinning cached first and sinking promo cards.
  assert.deepEqual(defaultSortStreams([promo, uncached4k, cached1080], { preserveOrder: true }), [
    cached1080,
    uncached4k,
    promo,
  ]);
});

test("defaultSortStreams does not promote plain direct HTTP 1080p streams above 4K uncached streams", () => {
  const cached1080 = createMockStream({
    name: "[PikPak ⚡] StremList 1080p",
    title: "Movie.1080p.WEB-DL.mkv",
    url: "https://example.invalid/cached.mkv",
    resolution: "1080p",
    tier: "1080p",
    seeders: 10,
    size: 2 * 1024 ** 3,
  });
  const directHdhub1080 = createMockStream({
    addonId: "com.hdhub",
    addonName: "4KHDHub",
    name: "4KHDHub 1080p",
    title: "[PixelDrain] Movie.1080p.BluRay.x265.mkv",
    url: "https://pixeldrain.example/file",
    resolution: "1080p",
    tier: "1080p",
    seeders: null,
    size: 4.88 * 1024 ** 3,
  });
  const direct111477 = createMockStream({
    addonId: "org.111477",
    addonName: "111477 stremio",
    name: "111477 stremio",
    title: "Movie.1080p.BluRay.x265.mkv [a11 3.1 GB]",
    url: "https://111477.example/video.mkv",
    resolution: "1080p",
    tier: "1080p",
    seeders: null,
    size: 3.1 * 1024 ** 3,
  });
  const uncached4k = createMockStream({
    name: "[PikPak 🧲] StremList 2160p",
    title: "Movie.2160p.BluRay.x265.mkv",
    url: "https://example.invalid/4k",
    resolution: "4K",
    tier: "4K",
    seeders: 271,
    size: 6.6 * 1024 ** 3,
  });

  assert.deepEqual(defaultSortStreams([directHdhub1080, direct111477, uncached4k, cached1080]), [
    cached1080,
    uncached4k,
    directHdhub1080,
    direct111477,
  ]);
});

test("sortPickerStreams always keeps explicitly cached streams at the top across all sort modes and directions", () => {
  const cachedMarker1080 = createMockStream({
    name: "[PikPak ⚡] StremList 1080p",
    title: "Cached.1080p.mkv",
    resolution: "1080p",
    tier: "1080p",
    seeders: 5,
    size: 2 * 1024 ** 3,
    score: 20,
  });
  const cachedDebrid720 = createMockStream({
    name: "Comet 720p",
    title: "Cached.720p.mkv",
    cached: { rd: true },
    resolution: "720p",
    tier: "720p",
    seeders: 1,
    size: 1 * 1024 ** 3,
    score: 10,
  });
  const uncached4k = createMockStream({
    name: "[PikPak 🧲] StremList 2160p",
    title: "Uncached.4K.mkv",
    resolution: "4K",
    tier: "4K_DV",
    seeders: 9000,
    size: 25 * 1024 ** 3,
    score: 200,
  });
  const direct1080 = createMockStream({
    name: "111477 stremio",
    title: "Direct.1080p.mkv",
    url: "https://111477.example/direct.mkv",
    resolution: "1080p",
    tier: "1080p",
    seeders: 500,
    size: 12 * 1024 ** 3,
    score: 150,
  });
  const defaultOrder = (arr: ScoredStream[]) => arr;
  const input = [uncached4k, direct1080, cachedDebrid720, cachedMarker1080];

  for (const sortBy of ["size", "seeders", "resolution", "score"] as const) {
    for (const sortDir of ["desc", "asc"] as const) {
      const sorted = sortPickerStreams(input, sortBy, sortDir, defaultOrder);
      const topTwo = sorted.slice(0, 2);
      assert.ok(
        topTwo.includes(cachedMarker1080) && topTwo.includes(cachedDebrid720),
        `expected cached streams first for ${sortBy} (${sortDir})`,
      );
      if (sortDir === "desc") {
        assert.deepEqual(sorted, [cachedMarker1080, cachedDebrid720, uncached4k, direct1080]);
      } else {
        assert.deepEqual(sorted, [cachedDebrid720, cachedMarker1080, direct1080, uncached4k]);
      }
    }
  }
});
