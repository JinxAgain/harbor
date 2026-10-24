// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { localPlayerSrc } from "../src/lib/local-library/player-src.ts";
import { localEntryToMeta } from "../src/lib/local-library.ts";

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
    /dur =\s*rawDur > 0\s*\?\s*rawDur\s*:\s*effectiveResume\?\.pct && effectiveResume\.pct > 0 && effectiveResume\.ms > 0\s*\?\s*Math\.round\(effectiveResume\.ms \/ effectiveResume\.pct\)\s*:\s*0;/,
  );
  assert.match(
    continueCardSource,
    /off = effectiveResume\s*\?\s*\(effectiveResume\.ms > 0\s*\?\s*effectiveResume\.ms/,
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

test("home, mobile and anime deduplication replace older record with fresher record", () => {
  assert.match(
    homeSource,
    /const existing = byId\.get\(i\._id\);[\s\S]*?lastWatchedOf\(i\) > lastWatchedOf\(existing\)/,
  );
  assert.match(
    cwSource,
    /const existing = byId\.get\(i\._id\);[\s\S]*?watchedAt\(i\) > watchedAt\(existing\)/,
  );
  assert.match(
    mobileCwSource,
    /const existing = byId\.get\(i\._id\);[\s\S]*?lastWatchedOf\(i\) > lastWatchedOf\(existing\)/,
  );
  assert.match(
    animeCwSource,
    /const existing = byId\.get\(i\._id\);[\s\S]*?lastWatchedOf\(i\) > lastWatchedOf\(existing\)/,
  );
  assert.doesNotMatch(homeSource, /if \(byId\.size >= 100\) break;/);
  assert.doesNotMatch(mobileCwSource, /if \(byId\.size >= limit\) break;/);
});

test("resume-start inspects candidate IDs for local resume progress", () => {
  assert.match(resumeStartSource, /lookupIds\(\{ metaId, authKey, imdbId, imdbVerified \}\)/);
  assert.match(resumeStartSource, /readResumeEntry\(id, season, episode\)/);
});
