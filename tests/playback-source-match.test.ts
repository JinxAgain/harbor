// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  preferredSourceAddonPending,
  streamMatchesReleaseLineage,
  streamMatchesSource,
} from "../src/lib/playback-history.ts";

test("season-pack episodes match by torrent hash when their file-specific binge groups differ", () => {
  const entry = {
    infoHash: "ABCDEF123456",
    fileIdx: 3,
    addonId: "comet",
    resolution: "1080p",
    source: "BluRay",
    bingeGroup: "comet|torbox|abcdef123456|3",
    savedAt: Date.now(),
  };
  const nextEpisode = {
    infoHash: "abcdef123456",
    fileIdx: 4,
    addonId: "comet",
    resolution: "1080p",
    source: "BluRay",
    behaviorHints: { bingeGroup: "comet|torbox|abcdef123456|4" },
  };

  assert.equal(streamMatchesSource(nextEpisode, entry), true);
});

test("different known torrent hashes do not match through broader source metadata", () => {
  const entry = {
    infoHash: "pack-one",
    addonId: "torrentio",
    resolution: "1080p",
    source: "WEB-DL",
    bingeGroup: "shared-group",
    savedAt: Date.now(),
  };
  const differentRelease = {
    infoHash: "pack-two",
    addonId: "torrentio",
    resolution: "1080p",
    source: "WEB-DL",
    behaviorHints: { bingeGroup: "shared-group" },
  };

  assert.equal(streamMatchesSource(differentRelease, entry), false);
});

test("next episode keeps the same release group across per-episode torrents", () => {
  const entry = {
    infoHash: "episode-one-hash",
    addonId: "torrentio",
    resolution: "1080p",
    releaseGroup: "SUCCESSFULCRAB",
    source: "WEB-DL",
    savedAt: Date.now(),
  };
  const nextEpisode = {
    infoHash: "episode-two-hash",
    addonId: "torrentio",
    resolution: "1080p",
    releaseGroupNormalized: "SUCCESSFULCRAB",
    source: "WEB-DL",
  };

  assert.equal(streamMatchesSource(nextEpisode, entry), false);
  assert.equal(streamMatchesReleaseLineage(nextEpisode, entry), true);
});

test("next episode keeps the same release group when binge groups are file-specific", () => {
  const entry = {
    addonId: "comet",
    url: "https://debrid.example/episode-one",
    resolution: "1080p",
    releaseGroup: "NTB",
    source: "WEB-DL",
    bingeGroup: "comet|torbox|aaaa1111|3",
    savedAt: Date.now(),
  };
  const nextEpisode = {
    addonId: "comet",
    resolution: "1080p",
    releaseGroupNormalized: "NTB",
    source: "WEB-DL",
    behaviorHints: { bingeGroup: "comet|torbox|bbbb2222|4" },
  };

  assert.equal(streamMatchesSource(nextEpisode, entry), false);
  assert.equal(streamMatchesReleaseLineage(nextEpisode, entry), true);
});

test("next episode does not cross addons, release groups, or unparsed titles", () => {
  const entry = {
    infoHash: "episode-one-hash",
    addonId: "comet",
    resolution: "1080p",
    releaseGroup: "NTB",
    source: "WEB-DL",
    savedAt: Date.now(),
  };
  const otherAddon = {
    infoHash: "episode-two-hash",
    addonId: "torrentio",
    resolution: "1080p",
    releaseGroupNormalized: "NTB",
    source: "WEB-DL",
  };
  const otherGroup = {
    infoHash: "episode-two-hash",
    addonId: "comet",
    resolution: "1080p",
    releaseGroupNormalized: "FLUX",
    source: "WEB-DL",
  };
  const unknownGroup = {
    infoHash: "episode-two-hash",
    addonId: "comet",
    resolution: "1080p",
    releaseGroupNormalized: null,
    source: "WEB-DL",
  };
  const entryWithoutGroup = { ...entry, releaseGroup: null };

  assert.equal(streamMatchesReleaseLineage(otherAddon, entry), false);
  assert.equal(streamMatchesReleaseLineage(otherGroup, entry), false);
  assert.equal(streamMatchesReleaseLineage(unknownGroup, entry), false);
  assert.equal(streamMatchesReleaseLineage(otherGroup, entryWithoutGroup), false);
});

test("auto-play waits while the remembered source addon is still loading", () => {
  const entry = {
    addonId: "community.comet",
    resolution: "4K",
    source: "BluRay",
    savedAt: Date.now(),
  };
  const progress = {
    settled: 1,
    total: 2,
    queriedAddonIds: ["community.comet", "com.stremio.torrentio.addon"],
    settledAddonIds: ["com.stremio.torrentio.addon"],
  };

  assert.equal(preferredSourceAddonPending(entry, false, false, progress), true);
});

test("auto-play may fall back after the remembered source addon settles without a match", () => {
  const entry = {
    addonId: "community.comet",
    resolution: "4K",
    source: "BluRay",
    savedAt: Date.now(),
  };
  const progress = {
    settled: 2,
    total: 2,
    queriedAddonIds: ["community.comet", "com.stremio.torrentio.addon"],
    settledAddonIds: ["community.comet", "com.stremio.torrentio.addon"],
  };

  assert.equal(preferredSourceAddonPending(entry, false, false, progress), false);
});

test("auto-play does not wait once the remembered source already matched", () => {
  const entry = {
    addonId: "community.comet",
    resolution: "4K",
    source: "BluRay",
    savedAt: Date.now(),
  };
  const progress = {
    settled: 0,
    total: 1,
    queriedAddonIds: ["community.comet"],
    settledAddonIds: [],
  };

  assert.equal(preferredSourceAddonPending(entry, true, false, progress), false);
});

test("buildPlayInvite preserves sourceMetaId and tags series/anime/episodes as series mediaType", async () => {
  const { buildPlayInvite, toEpisodeRef } = await import("../src/lib/together/build-invite.ts");
  const ep = {
    season: 1,
    episode: 2,
    name: "Ep 2",
    sourceMetaId: "kitsu:12345",
  };
  const epRef = toEpisodeRef(ep);
  assert.equal(epRef.sourceMetaId, "kitsu:12345");

  const animeInvite = buildPlayInvite({ id: "kitsu:123", type: "anime", name: "Anime Show" } as any, ep);
  assert.equal(animeInvite.mediaType, "series");
  assert.equal(animeInvite.episode?.sourceMetaId, "kitsu:12345");

  const movieWithEpInvite = buildPlayInvite({ id: "tt123", type: "movie", name: "Movie Mini" } as any, ep);
  assert.equal(movieWithEpInvite.mediaType, "series");

  const pureMovieInvite = buildPlayInvite({ id: "tt999", type: "movie", name: "Movie Alone" } as any);
  assert.equal(pureMovieInvite.mediaType, "movie");
});

test("useAutoCandidates falls back to release lineage and respects preferPacks when hostSource is present", async () => {
  // Mock react useMemo to execute directly
  const origUseMemo = (await import("react")).useMemo;
  // Transpile useAutoCandidates or test with node
  const { readFileSync } = await import("node:fs");
  const ts = (await import("typescript")).default;
  const source = readFileSync(new URL("../src/views/play-picker/use-auto-candidates.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modExports: any = {};
  new Function("require", "exports", code)(
    (name: string) => {
      if (name === "react") return { useMemo: (fn: any) => fn() };
      if (name.includes("playback-history")) {
        return {
          streamMatchesEntry: () => false,
          streamMatchesSource: (s: any, e: any) => s.infoHash === e.infoHash,
          streamMatchesReleaseLineage: (s: any, e: any) => s.releaseGroupNormalized === e.releaseGroup,
        };
      }
      if (name.includes("source-match")) return { buildMatchScores: () => new Map() };
      if (name.includes("host-stream")) return { hostSourceStream: () => [] };
      if (name.includes("dead-streams")) return { isStreamDead: () => false };
      if (name.includes("stremio-stream")) return { engineP2pEligible: () => true };
      if (name.includes("picker-utils")) return { hasInstantMarker: () => false, isWatchHub: () => false, needsDownload: () => false, streamMatchesLangs: () => true };
      if (name.includes("trust")) return { titleTokensPresent: () => true };
      if (name.includes("episode-span")) return { episodeSpanContains: () => true };
      return {};
    },
    modExports,
  );
  const { useAutoCandidates } = modExports;

  const lockedSourceEntry = {
    infoHash: "hash-ep1",
    addonId: "torrentio",
    resolution: "1080p",
    releaseGroup: "SUBSPLEASE",
    source: "WEB-DL",
  };

  const ep2LineageStream: any = {
    infoHash: "hash-ep2", // different hash!
    addonId: "torrentio",
    resolution: "1080p",
    releaseGroupNormalized: "SUBSPLEASE",
    source: "WEB-DL",
    tier: "tier_1080p",
  };

  const hostPickedStream: any = {
    infoHash: "hash-host",
    addonId: "other",
    resolution: "1080p",
    releaseGroupNormalized: "OTHER",
    source: "WEB-DL",
    tier: "tier_1080p",
  };

  const candidates = useAutoCandidates({
    filteredPicker: {
      all: [hostPickedStream, ep2LineageStream],
      allRaw: [hostPickedStream, ep2LineageStream],
      primary: hostPickedStream,
    },
    previousPlayback: null,
    sourceEntry: lockedSourceEntry,
    sourceEntryLineage: false, // seasonLockEntry was non-null, so lineage was false!
    isCached: () => true,
    addons: [],
    hasStrongAddon: false,
    isTorrentioStream: () => true,
    preferredLangs: [],
    hostSource: { infoHash: "hash-host" }, // hostSource present!
    preferPacks: true, // seasonLock active!
  });

  assert.ok(candidates.length > 0, "Candidates must not be empty");
  assert.equal(
    candidates[0].releaseGroupNormalized,
    "SUBSPLEASE",
    "Must select locked season release lineage as candidate 0 even when hostSource is present",
  );
});
