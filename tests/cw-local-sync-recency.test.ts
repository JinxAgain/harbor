// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { localPlayerSrc } from "../src/lib/local-library/player-src.ts";

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

test("localPlayerSrc prefers tmdbId matching localEntryToMeta and sets imdbIdVerified", () => {
  const src = localPlayerSrc({
    id: "test-hash",
    path: "V:\\Movies\\V.2026.mkv",
    filename: "V.2026.mkv",
    title: "V",
    year: 2026,
    type: "movie",
    tmdbId: 1419747,
    imdbId: "tt38775487",
    addedAt: Date.now(),
  });
  // Must match localEntryToMeta's tmdb priority so Detail and Player share the same meta ID
  assert.equal(src.meta.id, "tmdb:movie:1419747");
  assert.equal(src.imdbId, "tt38775487");
  assert.equal(src.imdbIdVerified, true);

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

test("continue-card calculates off and dur without fabricating ms * 1.2", () => {
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
