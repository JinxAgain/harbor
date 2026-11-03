// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";

import {
  adjacentMonthForTimezone,
  fetchSimklCalendar,
  peekSimklCalendar,
} from "../src/lib/calendar-sources.ts";
import {
  buildSimklUserEntries,
  matchSimklCdnToUserCalendar,
  type SimklCdnItem,
} from "../src/lib/simkl/calendar-data.ts";
import {
  readSimklCalendarSnapshot,
  writeSimklCalendarSnapshot,
  subscribeSimklCalendarSnapshot,
  invalidateSimklCalendarSnapshots,
  SNAPSHOT_TTL_MS,
} from "../src/lib/simkl/calendar-snapshot.ts";
import {
  serializeCacheForStorage,
  saveLocalCache,
  type SimklCache,
  type SimklCacheItem,
} from "../src/lib/simkl/activities/store.ts";
import { resetActivitiesGate } from "../src/lib/simkl/activities/gate.ts";
import { setSession } from "../src/lib/simkl/session.ts";
import type { CalendarItem } from "../src/lib/calendar.ts";

// Helper to generate a large library
function generateLargeSimklCache(count: number): SimklCache {
  const items: Record<string, SimklCacheItem> = {};
  const imdbToSimkl: Record<string, number> = {};
  const tmdbToSimkl: Record<string, number> = {};
  const malToSimkl: Record<string, number> = {};
  const kitsuToSimkl: Record<string, number> = {};

  for (let i = 1; i <= count; i++) {
    const simklId = 100000 + i;
    const type = i % 3 === 0 ? "movie" : i % 3 === 1 ? "show" : "anime";
    const status =
      i % 4 === 0
        ? "completed"
        : i % 4 === 1
          ? "watching"
          : i % 4 === 2
            ? "plantowatch"
            : "hold";
    const imdb = `tt${String(simklId).padStart(7, "0")}`;
    const tmdb = simklId + 500000;
    const mal = type === "anime" ? simklId + 900000 : undefined;

    items[String(simklId)] = {
      simklId,
      type,
      title: `Test Title ${i}`,
      year: 2020 + (i % 7),
      status,
      userRating: 8,
      watchedAt: status === "watching" ? "2026-10-01T12:00:00Z" : null,
      watchedEpisodes: ["1:1", "1:2", "1:3", "1:4", "1:5"],
      ids: {
        simkl: simklId,
        imdb,
        tmdb,
        mal,
      },
    };

    imdbToSimkl[imdb] = simklId;
    tmdbToSimkl[String(tmdb)] = simklId;
    if (mal) malToSimkl[String(mal)] = simklId;
  }

  return {
    lastSync: "2026-11-01T00:00:00Z",
    activities: { movies: null, shows: null, anime: null, ratings: null },
    items,
    imdbToSimkl,
    tmdbToSimkl,
    malToSimkl,
    kitsuToSimkl,
  };
}

test("1. Timezone boundary archive windowing selects correct adjacent months", () => {
  // UTC+ (offset < 0): local ahead of UTC -> [curr, prev]
  assert.deepEqual(adjacentMonthForTimezone(-480), ["curr", "prev"]); // UTC+8 (Asia)
  assert.deepEqual(adjacentMonthForTimezone(-60), ["curr", "prev"]); // UTC+1 (Europe)
  assert.deepEqual(adjacentMonthForTimezone(-720), ["curr", "prev"]); // UTC+12 (NZ)

  // UTC- (offset > 0): local behind UTC -> [curr, next]
  assert.deepEqual(adjacentMonthForTimezone(300), ["curr", "next"]); // UTC-5 (US East)
  assert.deepEqual(adjacentMonthForTimezone(480), ["curr", "next"]); // UTC-8 (US West)

  // UTC 0 (offset === 0): no boundary crossing -> [curr]
  assert.deepEqual(adjacentMonthForTimezone(0), ["curr"]);
});

test("2. Large library pure CDN matching (3000+ items executes in < 50ms with 0 fallback calls)", async () => {
  const largeCache = generateLargeSimklCache(3500);
  const userEntries = buildSimklUserEntries(largeCache, []);
  assert.equal(userEntries.length, 3500);

  // Setup CDN data for October 2026 (month 9) with 30 items
  const cdnTv: SimklCdnItem[] = [];
  const cdnAnime: SimklCdnItem[] = [];
  const cdnMovie: SimklCdnItem[] = [];

  for (let i = 1; i <= 10; i++) {
    // Matching items
    const matchId = 100000 + i;
    cdnTv.push({
      title: `Test Title ${i}`,
      date: "2026-10-15T18:00:00Z",
      ids: { simkl_id: matchId, imdb: `tt${String(matchId).padStart(7, "0")}` },
      episode: { season: 1, episode: i },
    });
    cdnAnime.push({
      title: `Anime Title ${i}`,
      date: "2026-10-16T18:00:00Z",
      ids: { simkl_id: matchId + 1, mal: matchId + 900001 },
      episode: { episode: i },
    });
    cdnMovie.push({
      title: `Movie Title ${i}`,
      date: "2026-10-17T18:00:00Z",
      ids: { simkl_id: matchId + 2 },
    });
  }

  // Measure in-memory pure CDN matching duration
  const start = performance.now();
  const { items: matched } = matchSimklCdnToUserCalendar(
    2026,
    9,
    { tv: cdnTv, anime: cdnAnime, movie: cdnMovie },
    userEntries,
  );
  const duration = performance.now() - start;

  assert.ok(
    duration < 50,
    `Pure CDN matching for 3500 items took ${duration.toFixed(2)}ms, expected < 50ms`,
  );
  assert.ok(matched.length > 0, "Expected matches from user library");

  // Zero-match month where CDN has data: must also complete in < 50ms
  const nonMatchingCdn: SimklCdnItem[] = [
    {
      title: "Untracked Show",
      date: "2026-10-20T12:00:00Z",
      ids: { simkl_id: 9999999 },
      episode: { season: 1, episode: 1 },
    },
  ];
  const startZero = performance.now();
  const { items: zeroMatched } = matchSimklCdnToUserCalendar(
    2026,
    9,
    { tv: nonMatchingCdn, anime: [], movie: [] },
    userEntries,
  );
  const durationZero = performance.now() - startZero;
  assert.ok(
    durationZero < 50,
    `Zero-match matching took ${durationZero.toFixed(2)}ms, expected < 50ms`,
  );
  assert.equal(zeroMatched.length, 0);

  // Verify fetchSimklCalendar skips resolveSavedCalendar when CDN has month data
  setSession({ accessToken: "fake-token", username: "simkl-user" });
  saveLocalCache(largeCache);

  let thirdPartyScrapeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr.includes("data.simkl.in") || urlStr.includes("simkl.com")) {
      // Return mock CDN archive or activities response
      if (urlStr.includes("tv.json")) {
        return new Response(JSON.stringify({ calendar: [{ simkl_id: 100001, date: "2026-10-15T18:00:00Z" }], metadata: { "100001": { title: "Test Title 1" } } }));
      }
      return new Response(JSON.stringify({ calendar: [], metadata: {} }));
    }
    // Any third party scrapers (cinemeta, tmdb, tvmaze, anizip)
    thirdPartyScrapeCalls++;
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const calendarItems = await fetchSimklCalendar(2026, 9, { tmdbKey: "test-key" });
    assert.ok(calendarItems.length >= 1);
    assert.equal(
      thirdPartyScrapeCalls,
      0,
      `Expected 0 third-party fallback scraper calls, got ${thirdPartyScrapeCalls}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("3. Far-future unpublished CDN fallback bounding (capped at <= 24 prioritized items)", async () => {
  const largeCache = generateLargeSimklCache(100);
  // Ensure we have at least 50 watching items
  for (let i = 1; i <= 50; i++) {
    largeCache.items[String(100000 + i)].status = "watching";
    largeCache.items[String(100000 + i)].watchedAt = new Date(2026, 0, i).toISOString();
  }
  setSession({ accessToken: "fake-token", username: "simkl-user" });
  saveLocalCache(largeCache);

  const queriedCandidates = new Set<string>();
  const originalFetch = globalThis.fetch;

  // Simulate far-future month: 2028-10 (monthDiff > 1), CDN returns empty
  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("data.simkl.in")) {
      // Unpublished CDN month returns 404
      return new Response("Not Found", { status: 404 });
    }
    // Third-party resolver call intercepted: track candidates queried
    const match = urlStr.match(/(tt\d+)/);
    if (match) queriedCandidates.add(match[1]);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    // Invalidate snapshots first
    invalidateSimklCalendarSnapshots({ purgeStorage: true });
    await fetchSimklCalendar(2028, 9, { tmdbKey: "test-key" });
    // Candidate resolution must be capped to <= 24 items
    assert.ok(
      queriedCandidates.size <= 24,
      `Fallback candidate count was ${queriedCandidates.size}, expected <= 24`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("4. Persisted calendar snapshot SWR lifecycle (peek, TTL staleness, mutation invalidation, 6-month LRU, session disconnect)", () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  setSession({ accessToken: "test-token", username: "user_a" });

  const mockItem: CalendarItem = {
    id: "item-1",
    type: "tv",
    name: "Show A S01E01",
    poster: null,
    background: null,
    releaseDate: "2026-10-15",
    isAnime: false,
    overview: "",
    voteAverage: 8,
  };

  // 1. Instant peek hit
  writeSimklCalendarSnapshot(2026, 9, [mockItem], "sync-v1");
  const peeked = peekSimklCalendar(2026, 9);
  assert.ok(peeked, "Expected peek hit");
  assert.equal(peeked.length, 1);
  assert.equal(peeked[0].id, "item-1");

  const snapFresh = readSimklCalendarSnapshot(2026, 9);
  assert.ok(snapFresh);
  assert.equal(snapFresh.isStale, false);

  // 2. 30m TTL staleness (advancing time by 31 minutes)
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + (SNAPSHOT_TTL_MS + 60000);
    const snapStale = readSimklCalendarSnapshot(2026, 9);
    assert.ok(snapStale);
    assert.equal(snapStale.isStale, true, "Expected snapshot to be stale after TTL");
    // Peek should STILL return the stale items for instant 0 ms rendering
    const peekedStale = peekSimklCalendar(2026, 9);
    assert.ok(peekedStale);
    assert.equal(peekedStale.length, 1);
  } finally {
    Date.now = realNow;
  }

  // 3. Mutation invalidation
  writeSimklCalendarSnapshot(2026, 9, [mockItem], "sync-v1");
  assert.equal(readSimklCalendarSnapshot(2026, 9)?.isStale, false);
  resetActivitiesGate({ kind: "set-status", ids: {}, status: "completed" });
  const snapAfterMutation = readSimklCalendarSnapshot(2026, 9);
  assert.ok(snapAfterMutation);
  assert.equal(snapAfterMutation.isStale, true, "Snapshot must be stale after gate mutation");
  assert.equal(snapAfterMutation.at, 0, "at must be 0 after invalidation");
  // Items still present for SWR
  assert.equal(snapAfterMutation.items.length, 1);

  // 4. Subscriber notification on data change
  let listenerCalledWith: CalendarItem[] | null = null;
  const unsub = subscribeSimklCalendarSnapshot(2026, 9, (updated) => {
    listenerCalledWith = updated;
  });
  const updatedItem: CalendarItem = { ...mockItem, name: "Show A S01E02" };
  writeSimklCalendarSnapshot(2026, 9, [updatedItem], "sync-v2");
  assert.ok(listenerCalledWith);
  assert.equal((listenerCalledWith as CalendarItem[])[0].name, "Show A S01E02");
  unsub();

  // 5. 6-Month LRU Eviction: write 7 months, oldest accessed must be evicted
  for (let m = 0; m < 7; m++) {
    writeSimklCalendarSnapshot(2026, m, [{ ...mockItem, id: `m-${m}` }], "sync");
  }
  const storedMonths = JSON.parse(
    localStorage.getItem("harbor.simkl.calendar.v1.default") || "{}",
  );
  const storedKeys = Object.keys(storedMonths);
  assert.equal(storedKeys.length, 6, "LRU must cap stored snapshots to exactly 6 months");
  assert.ok(!storedKeys.includes("2026-0"), "Month 0 should be evicted as least recently accessed");
  assert.ok(storedKeys.includes("2026-6"), "Month 6 should be present");

  // 6. Session disconnect purge
  setSession(null);
  assert.equal(peekSimklCalendar(2026, 6), null, "Snapshots must be purged on session logout");
  assert.equal(
    localStorage.getItem("harbor.simkl.calendar.v1.default"),
    null,
    "Storage key must be removed on session logout",
  );
});

test("5. Cache serialization slimming strips watchedEpisodes on completed/dropped only", () => {
  const cache: SimklCache = {
    lastSync: "2026-11-01T00:00:00Z",
    activities: null,
    items: {
      "1": {
        simklId: 1,
        type: "show",
        title: "Watching Show",
        year: 2024,
        status: "watching",
        userRating: null,
        watchedAt: null,
        watchedEpisodes: ["1:1", "1:2"],
      },
      "2": {
        simklId: 2,
        type: "show",
        title: "Completed Show",
        year: 2023,
        status: "completed",
        userRating: null,
        watchedAt: null,
        watchedEpisodes: ["1:1", "1:2", "1:3", "1:4"],
      },
      "3": {
        simklId: 3,
        type: "show",
        title: "Dropped Show",
        year: 2022,
        status: "dropped",
        userRating: null,
        watchedAt: null,
        watchedEpisodes: ["1:1"],
      },
    },
    imdbToSimkl: {},
    tmdbToSimkl: {},
    malToSimkl: {},
    kitsuToSimkl: {},
  };

  const fullStr = serializeCacheForStorage(cache, false);
  const fullParsed = JSON.parse(fullStr) as SimklCache;
  assert.deepEqual(fullParsed.items["2"].watchedEpisodes, ["1:1", "1:2", "1:3", "1:4"]);

  const slimStr = serializeCacheForStorage(cache, true);
  const slimParsed = JSON.parse(slimStr) as SimklCache;
  // Watching show retains watchedEpisodes
  assert.deepEqual(slimParsed.items["1"].watchedEpisodes, ["1:1", "1:2"]);
  // Completed and Dropped shows have watchedEpisodes stripped
  assert.equal(slimParsed.items["2"].watchedEpisodes, undefined);
  assert.equal(slimParsed.items["3"].watchedEpisodes, undefined);
  // In-memory cache is untouched
  assert.deepEqual(cache.items["2"].watchedEpisodes, ["1:1", "1:2", "1:3", "1:4"]);
});
