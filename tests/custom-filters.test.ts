import assert from "node:assert/strict";
import test from "node:test";
import { isCached, isPromoCard } from "../src/lib/streams/cached.ts";
import {
  isFilterEmpty,
  matchesCustomFilter,
  newCustomFilter,
  summarizeFilter,
  validateFilterRegex,
} from "../src/lib/streams/custom-filters.ts";
import { applyTrust } from "../src/lib/streams/trust.ts";
import type { ParsedStream } from "../src/lib/streams/types.ts";

function makeStream(overrides: Partial<ParsedStream> = {}): ParsedStream {
  return {
    addonId: "test-addon",
    addonName: "StremList",
    name: "[PikPak ⚡] StremList 1080p",
    title: "Example.Movie.2024.1080p.WEB-DL.x265-FLUX.mkv",
    url: "https://example.invalid/stream.mkv",
    parsedTitle: "Example Movie",
    episodeTitle: null,
    resolution: "1080p",
    hdrFormat: null,
    codec: "HEVC",
    source: "WEB-DL",
    audio: { codec: "DD+", channels: 6 },
    audioLanguages: ["English"],
    size: 4 * 1024 ** 3,
    seeders: 42,
    cached: { pm: true },
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
    ...overrides,
  };
}

test("applyTrust rejects donation and Discord promo cards while keeping real streams", () => {
  const donationCard = makeStream({
    addonId: "com.hdhub",
    addonName: "HDHub",
    name: "🌟 Donation needed.",
    title: "Click here to donate to hdhub to keep the project alive.",
    url: "https://hdhub.example/donate",
    infoHash: undefined,
    size: null,
    seeders: null,
    cached: {},
    resolution: "SD",
    source: "Other",
  });
  const discordCard = makeStream({
    addonId: "com.hdhub",
    addonName: "HDHub",
    name: "💬 Join the Discord server",
    title: "Get latest updates, early access to new features, or just get support.",
    url: "https://discord.gg/example",
    infoHash: undefined,
    size: null,
    seeders: null,
    cached: {},
    resolution: "SD",
    source: "Other",
  });
  const penguCard = makeStream({
    addonId: "com.pengu",
    addonName: "Pengu",
    name: "✨ | support the project!",
    title: "pengu.uk/donate (donating hides this message)",
    url: "https://pengu.uk/donate",
    infoHash: undefined,
    size: null,
    seeders: null,
    cached: {},
    resolution: "SD",
    source: "Other",
  });
  const realMovie = makeStream({
    title: "Support.Your.Local.Sheriff.1969.1080p.BluRay.x264.mkv",
    url: "https://cdn.example/video.mkv",
  });

  assert.equal(isPromoCard(donationCard), true);
  assert.equal(isCached(donationCard, []), false);
  assert.equal(isPromoCard(realMovie), false);

  const result = applyTrust([donationCard, discordCard, penguCard, realMovie], {
    kind: "movie",
    strict: false,
  });

  assert.equal(result.keep.length, 1);
  assert.equal(result.keep[0], realMovie);
  assert.deepEqual(
    result.rejected.map((r) => r.reason),
    ["addon-promo-card", "addon-promo-card", "addon-promo-card"],
  );
});

test("custom filter includeRegex and excludeRegex match across stream text", () => {
  const filter = {
    ...newCustomFilter("Clean x265"),
    includeRegex: "\\b(x265|hevc)\\b",
    excludeRegex: "\\b(cam|ts|rus)\\b",
  };

  assert.equal(isFilterEmpty(filter), false);
  assert.equal(summarizeFilter(filter), "+/\\b(x265|hevc)\\b/ / -/\\b(cam|ts|rus)\\b/");

  const matching = makeStream({ title: "Movie.2024.1080p.x265.10bit-FLUX.mkv" });
  const missingInclude = makeStream({ title: "Movie.2024.1080p.x264-FLUX.mkv" });
  const hitsExclude = makeStream({ title: "Movie.2024.1080p.x265.RUS-FLUX.mkv" });

  assert.equal(matchesCustomFilter(matching, filter), true);
  assert.equal(matchesCustomFilter(missingInclude, filter), false);
  assert.equal(matchesCustomFilter(hitsExclude, filter), false);
});

test("validateFilterRegex reports syntax errors and invalid stored regex does not throw", () => {
  assert.equal(validateFilterRegex(""), null);
  assert.equal(validateFilterRegex("  \\bhevc\\b  "), null);
  assert.notEqual(validateFilterRegex("[unclosed("), null);

  const broken = {
    ...newCustomFilter("Broken"),
    includeRegex: "[unclosed(",
    excludeRegex: "(also-broken",
  };
  assert.equal(matchesCustomFilter(makeStream(), broken), true);
});
