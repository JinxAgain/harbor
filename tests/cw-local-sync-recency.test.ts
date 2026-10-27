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
const playerExitSource = readFileSync(
  new URL("../src/views/player/hooks/use-player-exit.ts", import.meta.url),
  "utf8",
);
const cwDismissSource = readFileSync(
  new URL("../src/lib/cw-dismiss.ts", import.meta.url),
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

test("regression: ContinueCard recency subscription, memo deps and candidate pick", () => {
  assert.match(
    continueCardSource,
    /localCwVersion,\s*subscribeLocalCw/,
    "ContinueCard must import localCwVersion and subscribeLocalCw",
  );
  assert.match(
    continueCardSource,
    /useSyncExternalStore\(\s*subscribeLocalCw,\s*localCwVersion/,
    "ContinueCard must subscribe to localCw store",
  );
  assert.match(
    continueCardSource,
    /useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*localCwVer[^\]]*\]\)/,
    "localCwMatch must include localCwVer in useMemo dependencies",
  );
  assert.match(
    continueCardSource,
    /useMemo\(\(\) => \{[\s\S]*?\}, \[[^\]]*resumeVer[^\]]*\]\)/,
    "localCwMatch must include resumeVer in useMemo dependencies",
  );
  assert.match(
    continueCardSource,
    /(!best\s*\|\|\s*e\.t\s*>\s*best\.t)/,
    "localCwMatch must pick candidate with highest e.t",
  );
  assert.match(
    continueCardSource,
    /bestLocal\.t\s*\+\s*5_?000\s*>=\s*remoteMtime/,
    "effectiveResume must allow 5s leeway for first-party same-session writes",
  );
  assert.match(
    continueCardSource,
    /localCwMatch\.t\s*>=\s*remoteMtime/,
    "off must require localCwMatch.t >= remoteMtime before preferring stale localCwMatch.positionMs over rawOff",
  );
  assert.match(
    continueCardSource,
    /name:\s*meta\.name\s*\|\|\s*source\.meta\.name/,
    "playLocal must preserve hydrated meta.name over raw filename",
  );
});

test("regression: LocalCwRow 5s write window and newest lcw entry across candidate IDs", () => {
  assert.match(
    cwRowSource,
    /\(bestLocal\?\.t\s*\?\?\s*0\)\s*\+\s*5_?000\s*>=\s*remoteMtime/,
    "LocalCwRow must use 5s leeway for first-party comparisons",
  );
  assert.match(
    cwRowSource,
    /(!bestLcw\s*\|\|\s*lcw\.t\s*>\s*bestLcw\.t)/,
    "LocalCwRow must find the newest lcw entry across candidate IDs",
  );
});

test("regression: resume-start recency precedence and 5s leeway for first-party entries", () => {
  assert.match(
    resumeStartSource,
    /localCwEntryMatch(?:\.t\s*>\s*\(localEntry\?\.t\s*\?\?\s*0\)|\s*&&\s*localCwEntryMatch\.t\s*>\s*\(localEntry\?\.t\s*\?\?\s*0\))/,
    "resolveStartMs must compare localCwEntryMatch.t against localEntry.t",
  );
  assert.match(
    resumeStartSource,
    /localTimestamp\s*\+\s*5_?000/,
    "resolveStartMs must require remoteMtime to exceed localTimestamp + 5_000 for first-party entries",
  );
});

test("regression: usePlayerExit saves resume before exit snapshot and includes duration and imdbId in deps", () => {
  const saveIdx = playerExitSource.indexOf("saveResumeMs(");
  const snapIdx = playerExitSource.indexOf("await captureExitSnapshot()");
  assert.ok(saveIdx > 0 && snapIdx > 0, "saveResumeMs and captureExitSnapshot must exist");
  assert.ok(saveIdx < snapIdx, "saveResumeMs must be called before captureExitSnapshot");
  assert.match(playerExitSource, /snap\?\.durationSec/, "closePlayer must depend on snap?.durationSec");
  assert.match(playerExitSource, /src\.imdbId\b/, "closePlayer must depend on src.imdbId");
  assert.match(playerExitSource, /src\.imdbIdVerified\b/, "closePlayer must depend on src.imdbIdVerified");
});

test("regression: useResumeAutosave clears localCw for both id and rid when movie completes", () => {
  assert.match(
    autosaveSource,
    /if\s*\(\s*s\.meta\.type\s*===\s*"movie"\s*&&\s*finished\s*\)\s*\{[\s\S]*?clearLocalCw\(id,\s*current\.ownerId\);[\s\S]*?if\s*\(\s*rv\s*&&\s*rid\s*&&\s*rid\s*!==\s*id\s*\)\s*\{?\s*clearLocalCw\(rid,\s*current\.ownerId\);/,
    "movie finish must clear localCw for both id and rid",
  );
});

test("regression: cw-dismiss syncs cloudLibraryPut on external dismissal when authKey is provided", () => {
  assert.match(
    cwDismissSource,
    /if\s*\(\s*item\.external\s*\)\s*\{[\s\S]*?cloudLibraryPut\(authKey,\s*\{[\s\S]*?timeOffset:\s*0/,
    "dismissCw on external item must cloudLibraryPut zeroed timeOffset when authKey is present",
  );
});

test("regression: Home onDismissCw clears localCw for candidate IDs, dismisses matching siblings with max ratio, and updates items state", () => {
  assert.match(
    homeSource,
    /setItems\(\(prev\)\s*=>\s*prev\.map\(/,
    "Home onDismissCw must immediately zero timeOffset in in-memory items state",
  );
});

test("regression: finishing a movie after an earlier pause clears stale pause state across localCw, externalCw, resume backfill, and Stremio sync", async () => {
  const movieWatchedMod = await import("../src/lib/movie-watched.ts");
  assert.equal(
    typeof (movieWatchedMod as Record<string, unknown>).isMovieCompletedAfter,
    "function",
    "movie-watched must export isMovieCompletedAfter",
  );
  const { setMovieWatchedLocal, isMovieCompletedAfter } = movieWatchedMod as typeof movieWatchedMod & {
    setMovieWatchedLocal: (id: string, watched: boolean, at?: number) => void;
    isMovieCompletedAfter: (id: string, activityMs: number, altId?: string | null) => boolean;
  };

  // Pause happened at t = 1_000_000 (30m left); movie finished at t = 2_800_000
  const pauseAt = 1_000_000;
  const finishAt = 2_800_000;
  setMovieWatchedLocal("tt38775487", true, finishAt);
  setMovieWatchedLocal("tmdb:movie:1419747", true, finishAt);

  // Earlier pause on cloud/tracker/local must be recognized as completed
  assert.equal(isMovieCompletedAfter("tt38775487", pauseAt), true);
  assert.equal(isMovieCompletedAfter("tmdb:movie:1419747", pauseAt), true);
  // Same-session delayed scrobble echo within 60s of finish is also completed
  assert.equal(isMovieCompletedAfter("tt38775487", finishAt + 30_000), true);
  // A genuine rewatch on another device 2 hours later is NOT treated as completed
  assert.equal(isMovieCompletedAfter("tt38775487", finishAt + 7_200_000), false);

  // Local rewatch past 45s clears watched state so the movie can re-enter Continue Watching
  setMovieWatchedLocal("tt38775487", false);
  setMovieWatchedLocal("tmdb:movie:1419747", false);
  assert.equal(isMovieCompletedAfter("tt38775487", pauseAt), false);

  // Stremio cloud sync must zero timeOffset when a movie finishes and use isPlaybackFinished
  assert.match(
    stremioSyncSource,
    /isPlaybackFinished/,
    "useStremioSync must use isPlaybackFinished so movies finished at >=85% are flagged watched",
  );
  assert.match(
    stremioSyncSource,
    /timeOffset:\s*(?:finaleDone\s*\|\|\s*movieDone|movieDone\s*\|\|\s*finaleDone)\s*\?\s*0\s*:\s*offsetMs/,
    "useStremioSync must reset timeOffset to 0 when a movie finishes",
  );

  // usePlayerExit must use isPlaybackFinished rather than only >= 0.92
  assert.match(
    playerExitSource,
    /isPlaybackFinished/,
    "usePlayerExit must check isPlaybackFinished before saving resume on close",
  );

  // useResumeAutosave must mark rid watched as well as id and evict externalCw on completion
  assert.match(
    autosaveSource,
    /setMovieWatchedLocal\(rid,\s*true\)/,
    "useResumeAutosave must mark resolvedImdbId watched when movie completes",
  );
  assert.match(
    autosaveSource,
    /evictExternalCwItem/,
    "useResumeAutosave must evict finished item from externalCw",
  );

  // Home, Trakt playback, and Simkl playback must guard against completed movies
  assert.match(homeSource, /isMovieCompletedAfter/);
  assert.match(traktPlaybackSource, /isMovieCompletedAfter/);
  assert.match(simklPlaybackSource, /isMovieCompletedAfter/);
});

