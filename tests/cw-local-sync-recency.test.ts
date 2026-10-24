// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { localPlayerSrc } from "../src/lib/local-library/player-src.ts";
import { localEntryToMeta } from "../src/lib/local-library.ts";
import { reconcileCwItem } from "../src/lib/continue-watching.ts";
import { pickPreferredResume } from "../src/lib/resume.ts";

const homeSource = readFileSync(new URL("../src/views/home.tsx", import.meta.url), "utf8");
const continueCardSource = readFileSync(
  new URL("../src/components/continue-card.tsx", import.meta.url),
  "utf8",
);
const resumeStartSource = readFileSync(
  new URL("../src/lib/player/resume-start.ts", import.meta.url),
  "utf8",
);
const cwSource = readFileSync(
  new URL("../src/lib/continue-watching.ts", import.meta.url),
  "utf8",
);
const stremioSyncSource = readFileSync(
  new URL("../src/views/player/hooks/use-stremio-sync.ts", import.meta.url),
  "utf8",
);
const cwRowSource = readFileSync(
  new URL("../src/views/library/local-tab/cw-row.tsx", import.meta.url),
  "utf8",
);
const mobileCwSource = readFileSync(
  new URL("../src/views/mobile/mobile-cw-row.tsx", import.meta.url),
  "utf8",
);
const animeCwSource = readFileSync(
  new URL("../src/views/anime.tsx", import.meta.url),
  "utf8",
);
const playbackSource = readFileSync(
  new URL("../src/lib/local-library/playback.ts", import.meta.url),
  "utf8",
);
const simklPlaybackSource = readFileSync(
  new URL("../src/lib/simkl/playback.ts", import.meta.url),
  "utf8",
);
const traktPlaybackSource = readFileSync(
  new URL("../src/lib/trakt/playback.ts", import.meta.url),
  "utf8",
);
const autosaveSource = readFileSync(
  new URL("../src/views/player/hooks/use-resume-autosave.ts", import.meta.url),
  "utf8",
);
const showsSource = readFileSync(
  new URL("../src/views/shows.tsx", import.meta.url),
  "utf8",
);

test("localPlayerSrc and localEntryToMeta prioritize imdbId and fall back to tmdbId", () => {
  const itemWithBoth = {
    id: "test-hash",
    path: "V:\\Movies\\Movie.mkv",
    filename: "Movie.mkv",
    title: "Movie",
    year: 2026,
    type: "movie" as const,
    tmdbId: 1419747,
    imdbId: "tt38775487",
    addedAt: Date.now(),
  };
  const srcWithBoth = localPlayerSrc(itemWithBoth);
  const metaWithBoth = localEntryToMeta(itemWithBoth);

  // When imdbId is present, both local and cloud use tt... (canonical cloudWriteId)
  assert.equal(srcWithBoth.meta.id, "tt38775487");
  assert.equal(metaWithBoth?.id, "tt38775487");
  assert.equal(srcWithBoth.imdbId, "tt38775487");
  assert.equal(srcWithBoth.imdbIdVerified, true);

  const itemTmdbOnly = {
    id: "test-hash-2",
    path: "V:\\Movies\\V.2026.mkv",
    filename: "V.2026.mkv",
    title: "V",
    year: 2026,
    type: "movie" as const,
    tmdbId: 1419747,
    addedAt: Date.now(),
  };
  const srcTmdbOnly = localPlayerSrc(itemTmdbOnly);
  const metaTmdbOnly = localEntryToMeta(itemTmdbOnly);

  // When imdbId is absent (e.g. Chinese movies), fallback to tmdb:movie:...
  assert.equal(srcTmdbOnly.meta.id, "tmdb:movie:1419747");
  assert.equal(metaTmdbOnly?.id, "tmdb:movie:1419747");
  assert.equal(srcTmdbOnly.imdbId, undefined);
  assert.equal(srcTmdbOnly.imdbIdVerified, false);

  const showSrc = localPlayerSrc({
    id: "test-show",
    path: "V:\\Shows\\S01E01.mkv",
    filename: "S01E01.mkv",
    title: "Show",
    year: 2026,
    type: "show",
    tmdbId: 99999,
    season: 1,
    episode: 1,
    addedAt: Date.now(),
  });
  assert.equal(showSrc.meta.id, "tmdb:tv:99999");
});

test("continue-card calculates off and dur without fabricating ms * 1.2 and ignores upNext", () => {
  assert.match(
    continueCardSource,
    /if \(item\.upNext === true\) return null;/,
  );
  assert.match(
    continueCardSource,
    /const dur =\s*realDur > 0\s*\?\s*realDur/,
  );
  assert.match(
    continueCardSource,
    /Math\.round\(effectiveResume\.pct \* realDur\)/,
  );
  assert.doesNotMatch(continueCardSource, /effectiveResume\.ms \* 1\.2/);
});

test("continue-card and playback resolve local:<hash> and migrate to canonical ID", () => {
  assert.match(
    playbackSource,
    /if \(id\.startsWith\("local:"\)\) localId = id\.slice\(6\);/,
  );
  assert.match(
    playbackSource,
    /if \(localId\) \{[\s\S]*?readLocalLibrary\(\)/,
  );
  assert.match(
    continueCardSource,
    /id: source\.meta\.id && !source\.meta\.id\.startsWith\("local:"\)\s*\?\s*source\.meta\.id\s*:\s*meta\.id/,
  );
});

test("useStremioSync guards progress position updates against snapshot reset on rerender", () => {
  assert.match(
    stremioSyncSource,
    /if \(progress\.position === 0 && snap\.positionSec >= MIN_POSITION_SEC\)\s*progress\.position = snap\.positionSec;/,
  );
});

test("LocalCwRow retains canonical ID and passes reconciled resume offset", () => {
  assert.match(
    cwRowSource,
    /src\.meta\.id && !src\.meta\.id\.startsWith\("local:"\)\s*\?\s*src\.meta\.id\s*:\s*item\._id/,
  );
  assert.match(cwRowSource, /startPositionMs:\s*off/);
});

test("home, mobile and anime deduplication use reconcileCwItem with recency replacement", () => {
  assert.match(
    homeSource,
    /reconcileCwItem\(existing, i, lastWatchedOf\)/,
  );
  assert.match(
    cwSource,
    /reconcileCwItem\(existing, i, watchedAt\)/,
  );
  assert.match(
    cwSource,
    /export function reconcileCwItem\(/,
  );
  assert.match(
    mobileCwSource,
    /reconcileCwItem\(existing, i, lastWatchedOf\)/,
  );
  assert.match(
    animeCwSource,
    /reconcileCwItem\(existing, i, lastWatchedOf\)/,
  );
  assert.doesNotMatch(homeSource, /if \(byId\.size >= 100\) break;/);
  assert.doesNotMatch(mobileCwSource, /if \(byId\.size >= limit\) break;/);
});

test("resume-start inspects candidate IDs for local resume progress", () => {
  assert.match(resumeStartSource, /lookupIds\(\{ metaId, authKey, imdbId, imdbVerified \}\)/);
  assert.match(resumeStartSource, /readResumeEntry\(id, season, episode\)/);
});

test("regression: simkl and trakt playback backfill never clobber first-party local saves or known durations", () => {
  // Simkl: checks localCwEntry and scales duration
  assert.match(simklPlaybackSource, /import \{ localCwEntry \} from "@\/lib\/local-cw"/);
  assert.match(simklPlaybackSource, /const local = localCwEntry\(id, false\) \?\? localCwEntry\(id, true\)/);
  assert.match(simklPlaybackSource, /isFirstParty\s*\?\s*remoteValid && remoteT > existing\.t \+ 60_000/);

  // Trakt: checks localCwEntry, uses saveResumeBatch with remoteT, and preserves first-party saves
  assert.match(traktPlaybackSource, /import \{ localCwEntry \} from "@\/lib\/local-cw"/);
  assert.match(traktPlaybackSource, /const local = localCwEntry\(id, false\) \?\? localCwEntry\(id, true\)/);
  assert.match(traktPlaybackSource, /saveResumeBatch\(\[/);
  assert.match(traktPlaybackSource, /isFirstParty\s*\?\s*remoteValid && remoteT > existing\.t \+ 60_000/);
});

test("regression: ContinueCard and LocalCwRow prioritize pct * dur over synthetic ms", () => {
  assert.match(
    continueCardSource,
    /effectiveResume\.source && realDur > 0 && effectiveResume\.pct != null\s*\?\s*Math\.round\(effectiveResume\.pct \* realDur\)/,
  );
  assert.match(
    continueCardSource,
    /const hasRealOffset =\s*!item\.external \|\| \(effectiveResume && !effectiveResume\.source\) \|\| realDur > 0;/,
  );
  assert.match(
    continueCardSource,
    /startPositionMs: startPos/,
  );
  assert.match(
    cwRowSource,
    /effectiveResume\.source && localDur > 0 && effectiveResume\.pct != null\s*\?\s*Math\.round\(effectiveResume\.pct \* localDur\)/,
  );
});

test("regression: reconcileCwItem prevents external card within 60s from replacing non-external card and scales duration", () => {
  const lastWatchedOf = (i: any) => (i.state?.lastWatched ? Date.parse(i.state.lastWatched) : 0);

  const localItem = {
    _id: "tmdb:movie:1419747",
    name: "V",
    type: "movie" as const,
    state: {
      timeOffset: 7_330_430,
      duration: 9_625_042,
      lastWatched: new Date(100_000).toISOString(),
    },
    local: true,
  };

  const echoCandidate = {
    _id: "tmdb:movie:1419747",
    name: "V",
    type: "movie" as const,
    external: "simkl" as const,
    state: {
      timeOffset: 4_798_080,
      duration: 6_300_000,
      lastWatched: new Date(101_000).toISOString(), // 1s later scrobble echo
    },
  };

  // Within 60s echo window: local item must win
  const winnerEcho = reconcileCwItem(localItem, echoCandidate, lastWatchedOf);
  assert.equal(winnerEcho._id, localItem._id);
  assert.equal(winnerEcho.state?.duration, 9_625_042);
  assert.equal(winnerEcho.state?.timeOffset, 7_330_430);
  assert.equal(winnerEcho.local, true);

  // 2 hours later on another device: candidate wins but preserves real duration and scales progress
  const newerCandidate = {
    _id: "tmdb:movie:1419747",
    name: "V",
    type: "movie" as const,
    external: "simkl" as const,
    state: {
      timeOffset: 5_040_000, // 80% of 6,300,000
      duration: 6_300_000,
      lastWatched: new Date(7_300_000).toISOString(),
    },
  };

  const winnerNewer = reconcileCwItem(localItem, newerCandidate, lastWatchedOf);
  assert.equal(winnerNewer.state?.duration, 9_625_042);
  // Progress ratio 5040000 / 6300000 = 0.8; scaled: Math.round(0.8 * 9625042) = 7700034
  assert.equal(winnerNewer.state?.timeOffset, 7_700_034);
  assert.equal(winnerNewer.local, true);

  // Cross-episode test: local is on S1E1 (finished, flaggedWatched: 1), candidate is newer on S1E2
  const localSeriesS1E1 = {
    _id: "tt99999",
    name: "Show",
    type: "series" as const,
    state: {
      season: 1,
      episode: 1,
      timeOffset: 3_500_000,
      duration: 3_600_000,
      flaggedWatched: 1,
      lastWatched: new Date(100_000).toISOString(),
    },
    local: true,
  };
  const extSeriesS1E2 = {
    _id: "tt99999",
    name: "Show",
    type: "series" as const,
    external: "simkl" as const,
    state: {
      season: 1,
      episode: 2,
      timeOffset: 600_000,
      duration: 2_640_000,
      flaggedWatched: 0,
      lastWatched: new Date(105_000).toISOString(), // 5s later, different episode
    },
  };
  const winnerDifferentEp = reconcileCwItem(localSeriesS1E1, extSeriesS1E2, lastWatchedOf);
  // S1E2 is genuinely newer; because sameTarget is false, it should NOT be rejected by 60s echo,
  // should NOT inherit S1E1's duration, and should NOT inherit flaggedWatched: 1
  assert.equal(winnerDifferentEp.state?.season, 1);
  assert.equal(winnerDifferentEp.state?.episode, 2);
  assert.equal(winnerDifferentEp.state?.flaggedWatched, 0);
  assert.equal(winnerDifferentEp.state?.duration, 2_640_000);
});

test("regression: pickPreferredResume prefers first-party save over 1s-newer tracker echo", () => {
  const firstParty = { ms: 7_330_430, t: 100_000 };
  const trackerEcho = { ms: 4_798_080, t: 101_000, source: "simkl" as const };
  const picked = pickPreferredResume(firstParty, trackerEcho);
  assert.deepEqual(picked, firstParty);

  const trackerNewer = { ms: 5_040_000, t: 7_300_000, source: "simkl" as const };
  const pickedNewer = pickPreferredResume(firstParty, trackerNewer);
  assert.deepEqual(pickedNewer, trackerNewer);
});

test("regression: online streams persist to shared localcw and home backfill uses real watch time", () => {
  // Online streams write to shared localcw
  assert.match(autosaveSource, /const ttAnimeUnmapped =/);
  assert.match(autosaveSource, /Boolean\(id\) \|\| isLocalUrl\(s\.url\) \|\| animeLocal/);

  // Home backfill uses lastWatched over _mtime and skips dismissed items
  assert.match(homeSource, /if \(isCwDismissed\(i\)\) continue;/);
  assert.match(homeSource, /const w = i\.state\?\.lastWatched;/);
});

test("regression: shows and anime CW completeness with source gates", () => {
  // Shows includes listLocalCw, items, externalCw and gates by cwSources
  assert.match(showsSource, /listLocalCw\(hideSharedCw\)/);
  assert.match(showsSource, /useExternalCw\(/);
  assert.match(showsSource, /settings\.cwSources\.library/);
  assert.match(showsSource, /reconcileCwItem\(/);

  // Anime uses useExternalCw and gates
  assert.match(animeCwSource, /useExternalCw\(/);
  assert.match(animeCwSource, /settings\.cwSources\.simkl/);
});
