// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";

import {
  adjacentMonthForTimezone,
  fetchSimklCalendar,
} from "../src/lib/calendar-sources.ts";
import {
  buildSimklUserEntries,
  matchSimklCdnToUserCalendar,
  type SimklCdnItem,
} from "../src/lib/simkl/calendar-data.ts";
import {
  writeSimklCalendarSnapshot,
  invalidateSimklCalendarSnapshots,
} from "../src/lib/simkl/calendar-snapshot.ts";
import {
  serializeCacheForStorage,
  saveLocalCache,
  clearLocalCache,
  type SimklCache,
  type SimklCacheItem,
} from "../src/lib/simkl/activities/store.ts";
import { setItemWithRecovery } from "../src/lib/storage-recovery.ts";
import { setSession } from "../src/lib/simkl/session.ts";

// Helper to generate a massive library with diverse statuses and categories
function generateStressSimklCache(count: number): SimklCache {
  const items: Record<string, SimklCacheItem> = {};
  const imdbToSimkl: Record<string, number> = {};
  const tmdbToSimkl: Record<string, number> = {};
  const malToSimkl: Record<string, number> = {};
  const kitsuToSimkl: Record<string, number> = {};

  const categories: Array<"movie" | "show" | "anime"> = ["movie", "show", "anime"];
  const statuses = ["completed", "watching", "plantowatch", "hold"] as const;

  for (let i = 1; i <= count; i++) {
    const simklId = 200000 + i;
    const type = categories[i % 3];
    const status = statuses[i % statuses.length];
    const imdb = `tt${String(simklId).padStart(7, "0")}`;
    const tmdb = simklId + 300000;
    const mal = type === "anime" ? simklId + 700000 : undefined;
    const kitsu = type === "anime" ? simklId + 800000 : undefined;

    // completed / dropped have many episodes to stress-test serialization
    const watchedEpisodes =
      status === "completed" || status === "dropped"
        ? Array.from({ length: 50 }, (_, idx) => `1:${idx + 1}`)
        : status === "watching"
          ? ["1:1", "1:2"]
          : undefined;

    items[String(simklId)] = {
      simklId,
      type,
      title: `Stress Item ${i} (${type})`,
      year: 2015 + (i % 12),
      status,
      userRating: (i % 10) + 1,
      watchedAt: status === "watching" ? "2026-10-01T12:00:00Z" : null,
      watchedEpisodes,
      ids: {
        simkl: simklId,
        imdb,
        tmdb,
        mal,
        kitsu,
      },
    };

    imdbToSimkl[imdb] = simklId;
    tmdbToSimkl[String(tmdb)] = simklId;
    if (mal) malToSimkl[String(mal)] = simklId;
    if (kitsu) kitsuToSimkl[String(kitsu)] = simklId;
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

// ---------------------------------------------------------------------------
// 1. Pure CDN Matching Stress Test (5,000+ items, < 50ms, 0 scraper calls)
// ---------------------------------------------------------------------------
test("Adversarial 1: Pure CDN matching with 6,000 items executes in < 50ms and makes 0 scraper calls", async () => {
  const itemCount = 6000;
  const largeCache = generateStressSimklCache(itemCount);
  const userEntries = buildSimklUserEntries(largeCache, []);
  assert.equal(userEntries.length, itemCount, `Expected ${itemCount} user entries`);

  // Build a realistic monthly CDN catalog containing 1,500 items:
  // - 150 items that match user library entries via simkl_id, imdb, tmdb, mal, kitsu
  // - 1,350 items that belong to other users / general public airings
  const cdnTv: SimklCdnItem[] = [];
  const cdnAnime: SimklCdnItem[] = [];
  const cdnMovie: SimklCdnItem[] = [];

  for (let i = 1; i <= 50; i++) {
    const matchId = 200000 + i;
    // TV match by simkl_id + imdb
    cdnTv.push({
      title: `Stress Item ${i} (show)`,
      date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T18:00:00Z`,
      ids: { simkl_id: matchId, imdb: `tt${String(matchId).padStart(7, "0")}` },
      episode: { season: 1, episode: i },
    });
    // Anime match by mal
    cdnAnime.push({
      title: `Stress Item ${i + 1} (anime)`,
      date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T19:00:00Z`,
      ids: { simkl_id: matchId + 1, mal: matchId + 1 + 700000 },
      episode: { episode: i },
    });
    // Movie match by tmdb
    cdnMovie.push({
      title: `Stress Item ${i + 2} (movie)`,
      date: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T20:00:00Z`,
      ids: { simkl_id: matchId + 2, tmdb: matchId + 2 + 300000 },
    });
  }

  // Add 1,350 non-matching CDN entries
  for (let i = 1; i <= 450; i++) {
    cdnTv.push({
      title: `Unrelated Show ${i}`,
      date: "2026-10-15T12:00:00Z",
      ids: { simkl_id: 9000000 + i, imdb: `tt9${String(i).padStart(6, "0")}` },
      episode: { season: 2, episode: i },
    });
    cdnAnime.push({
      title: `Unrelated Anime ${i}`,
      date: "2026-10-16T12:00:00Z",
      ids: { simkl_id: 9100000 + i, mal: 9100000 + i },
      episode: { episode: i },
    });
    cdnMovie.push({
      title: `Unrelated Movie ${i}`,
      date: "2026-10-17T12:00:00Z",
      ids: { simkl_id: 9200000 + i, tmdb: 9200000 + i },
    });
  }

  assert.equal(cdnTv.length + cdnAnime.length + cdnMovie.length, 1500);

  // 1A: Benchmark matching time on 6,000 library items x 1,500 CDN entries
  const start = performance.now();
  const { items: matched, matchedKeys } = matchSimklCdnToUserCalendar(
    2026,
    9,
    { tv: cdnTv, anime: cdnAnime, movie: cdnMovie },
    userEntries,
  );
  const duration = performance.now() - start;
  console.log(`[benchmark] 6,000 items pure CDN matching duration: ${duration.toFixed(3)}ms (matched ${matched.length} items)`);

  assert.ok(
    duration < 50,
    `Empirical matching time for 6,000 items took ${duration.toFixed(2)}ms (must be < 50ms)`,
  );
  assert.ok(matched.length > 0, "Expected matches to be found");
  assert.ok(matchedKeys.size > 0, "Expected matched keys to be populated");

  // 1B: Benchmark zero-match adversarial scenario:
  // User library has 6,000 items, CDN has 1,500 items, ZERO items match.
  const unrelatedCdn: SimklCdnItem[] = Array.from({ length: 500 }, (_, i) => ({
    title: `Orphan Title ${i}`,
    date: "2026-10-20T10:00:00Z",
    ids: { simkl_id: 8888888 + i },
    episode: { season: 1, episode: 1 },
  }));
  const startZero = performance.now();
  const { items: zeroMatched } = matchSimklCdnToUserCalendar(
    2026,
    9,
    { tv: unrelatedCdn, anime: [], movie: [] },
    userEntries,
  );
  const zeroDuration = performance.now() - startZero;
  console.log(`[benchmark] 6,000 items zero-match pure CDN matching duration: ${zeroDuration.toFixed(3)}ms`);
  assert.ok(
    zeroDuration < 50,
    `Zero-match matching took ${zeroDuration.toFixed(2)}ms (must be < 50ms)`,
  );
  assert.equal(zeroMatched.length, 0);

  // 1C: End-to-end fetchSimklCalendar verification:
  // Assert resolveSavedCalendar third-party scraping is invoked EXACTLY 0 times when CDN data exists
  setSession({ accessToken: "stress-token", username: "stress-user" });
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  saveLocalCache(largeCache);

  let thirdPartyCalls = 0;
  const queriedUrls: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    queriedUrls.push(urlStr);

    if (urlStr.includes("data.simkl.in") || urlStr.includes("simkl.com")) {
      // Mock CDN response for October 2026
      if (urlStr.includes("tv.json")) {
        return new Response(
          JSON.stringify({
            calendar: [{ simkl_id: 200001, date: "2026-10-15T18:00:00Z" }],
            metadata: { "200001": { title: "Stress Item 1 (show)" } },
          }),
        );
      }
      return new Response(JSON.stringify({ calendar: [], metadata: {} }));
    }

    // Third-party metadata fallback calls (Cinemeta, TMDB, TVMaze, AniZip, etc.)
    thirdPartyCalls++;
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const calendarItems = await fetchSimklCalendar(2026, 9, { tmdbKey: "test-key" });
    assert.ok(calendarItems.length >= 1, "Expected calendar items from CDN");
    assert.equal(
      thirdPartyCalls,
      0,
      `Third-party fallback scraping was invoked ${thirdPartyCalls} times (MUST be exactly 0)`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 2. Timezone Boundary Stress Test (Extreme offsets, year crossover, no out-of-bounds)
// ---------------------------------------------------------------------------
test("Adversarial 2: Timezone boundary extreme offsets (+840, -720, 0, +300, -480) and year-end crossovers", async () => {
  // Test direct mapping for extreme and standard offsets:
  // JS Date.prototype.getTimezoneOffset():
  // UTC+14 (Kiribati): -840
  // UTC-12 (Baker Island): +720
  // UTC (London): 0
  // UTC-5 (New York): +300
  // UTC+8 (Beijing/Perth): -480
  const boundaryCases = [
    { offset: -840, label: "UTC+14 Kiribati (-840)", expected: ["curr", "prev"] },
    { offset: 840, label: "UTC-14 (+840)", expected: ["curr", "next"] },
    { offset: 720, label: "UTC-12 Baker Island (+720)", expected: ["curr", "next"] },
    { offset: -720, label: "UTC+12 (-720)", expected: ["curr", "prev"] },
    { offset: 0, label: "UTC 0 (0)", expected: ["curr"] },
    { offset: 300, label: "UTC-5 (+300)", expected: ["curr", "next"] },
    { offset: -480, label: "UTC+8 (-480)", expected: ["curr", "prev"] },
    { offset: 1, label: "Boundary +1m", expected: ["curr", "next"] },
    { offset: -1, label: "Boundary -1m", expected: ["curr", "prev"] },
  ];

  for (const { offset, label, expected } of boundaryCases) {
    const rels = adjacentMonthForTimezone(offset);
    assert.deepEqual(rels, expected, `Mismatch for ${label}: expected ${JSON.stringify(expected)}`);
  }

  // End-to-end catalog URL generation check across all 12 months and extreme year crossovers:
  // Test January (month 0) and December (month 11) for year 2026
  const requestedCdnArchives: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;

  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("data.simkl.in")) {
      requestedCdnArchives.push(urlStr);
    }
    return new Response(JSON.stringify({ calendar: [], metadata: {} }));
  }) as typeof fetch;

  try {
    setSession({ accessToken: "tz-token", username: "tz-user" });
    const cache = generateStressSimklCache(10);
    saveLocalCache(cache);

    // Test Case 2A: January (month 0) with UTC+14 (Kiribati, offset -840)
    // Needs ["curr", "prev"]. "prev" from January 2026 must be December 2025 (2025/12)!
    // It must NEVER produce 2026/0, 2026/-1, or NaN/undefined!
    Date.prototype.getTimezoneOffset = () => -840;
    requestedCdnArchives.length = 0;
    invalidateSimklCalendarSnapshots({ purgeStorage: true });

    await fetchSimklCalendar(2026, 0, { tmdbKey: "test" });
    assert.ok(requestedCdnArchives.length > 0, "Expected archive requests");
    for (const archiveUrl of requestedCdnArchives) {
      if (/\/v2\/(tv|anime|movie_release)\.json/.test(archiveUrl)) continue;
      // Match /year/month/catalog.json
      const match = archiveUrl.match(/\/(\d{4})\/(\d+)\//);
      assert.ok(match, `Invalid CDN URL pattern: ${archiveUrl}`);
      const year = parseInt(match[1], 10);
      const monthNum = parseInt(match[2], 10);
      assert.ok(
        monthNum >= 1 && monthNum <= 12,
        `Out-of-bounds month ${monthNum} in URL: ${archiveUrl}`,
      );
      assert.ok(
        (year === 2026 && monthNum === 1) || (year === 2025 && monthNum === 12),
        `Unexpected year/month for January prev: ${year}/${monthNum}`,
      );
    }

    // Test Case 2B: December (month 11) with UTC-12 (Baker Island, offset +720)
    // Needs ["curr", "next"]. "next" from December 2026 must be January 2027 (2027/1)!
    // It must NEVER produce 2026/13, 2026/12 next, or NaN!
    Date.prototype.getTimezoneOffset = () => 720;
    requestedCdnArchives.length = 0;
    invalidateSimklCalendarSnapshots({ purgeStorage: true });

    await fetchSimklCalendar(2026, 11, { tmdbKey: "test" });
    assert.ok(requestedCdnArchives.length > 0, "Expected archive requests");
    for (const archiveUrl of requestedCdnArchives) {
      if (/\/v2\/(tv|anime|movie_release)\.json/.test(archiveUrl)) continue;
      const match = archiveUrl.match(/\/(\d{4})\/(\d+)\//);
      assert.ok(match, `Invalid CDN URL pattern: ${archiveUrl}`);
      const year = parseInt(match[1], 10);
      const monthNum = parseInt(match[2], 10);
      assert.ok(
        monthNum >= 1 && monthNum <= 12,
        `Out-of-bounds month ${monthNum} in URL: ${archiveUrl}`,
      );
      assert.ok(
        (year === 2026 && monthNum === 12) || (year === 2027 && monthNum === 1),
        `Unexpected year/month for December next: ${year}/${monthNum}`,
      );
    }

    // Test Case 2C: UTC 0 (London)
    // Needs ONLY ["curr"]. Never requests prev or next.
    Date.prototype.getTimezoneOffset = () => 0;
    requestedCdnArchives.length = 0;
    invalidateSimklCalendarSnapshots({ purgeStorage: true });

    await fetchSimklCalendar(2026, 5, { tmdbKey: "test" });
    for (const archiveUrl of requestedCdnArchives) {
      if (/\/v2\/(tv|anime|movie_release)\.json/.test(archiveUrl)) continue;
      const match = archiveUrl.match(/\/(\d{4})\/(\d+)\//);
      assert.ok(match, `Invalid CDN URL pattern: ${archiveUrl}`);
      const year = parseInt(match[1], 10);
      const monthNum = parseInt(match[2], 10);
      assert.equal(year, 2026);
      assert.equal(monthNum, 6, "June is month index 5 -> Simkl month 6");
    }
  } finally {
    globalThis.fetch = originalFetch;
    Date.prototype.getTimezoneOffset = originalGetTimezoneOffset;
  }
});

// ---------------------------------------------------------------------------
// 3. Storage Quota Stress Test (Simulated QuotaExceededError, setItemWithRecovery & Slimming)
// ---------------------------------------------------------------------------
test("Adversarial 3: Storage quota exhaustion recovers space and persists without data loss", async () => {
  localStorage.clear();

  // Setup DOM window mock for setTimeout debounce in store.ts
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = globalThis;

  try {
    // 3A: Direct setItemWithRecovery test under QuotaExceededError
    // Place prunable entries in storage
    const prunableCalendarKey = "harbor.simkl.calendar.v1.default";
    const prunableOmdbKey = "harbor.omdb.v1";
    const unprunableAuthKey = "harbor.auth.session";

    localStorage.setItem(prunableCalendarKey, "x".repeat(5000));
    localStorage.setItem(prunableOmdbKey, "y".repeat(5000));
    localStorage.setItem(unprunableAuthKey, JSON.stringify({ token: "secure-token" }));

    let quotaQuotaBytes = 8000;
    const rawSetItem = localStorage.setItem.bind(localStorage);

    // Override setItem to throw QuotaExceededError when total stored size exceeds quota
    localStorage.setItem = (key: string, value: string) => {
      let currentSize = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k === key) continue;
        currentSize += (localStorage.getItem(k)?.length ?? 0) + k.length;
      }
      if (currentSize + key.length + value.length > quotaQuotaBytes) {
        throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
      }
      rawSetItem(key, value);
    };

    // Attempt to write a new 4,000 char item:
    // Initially, total size = 5000 + 5000 + auth = ~10,000 > 8,000 (exceeds quota).
    // setItemWithRecovery must prune prunable entries to make room, but leave unprunableAuthKey intact!
    const recovered = setItemWithRecovery("test.recovered.key", "z".repeat(4000));
    assert.equal(recovered, true, "setItemWithRecovery should succeed after pruning");
    assert.equal(localStorage.getItem("test.recovered.key")?.length, 4000);
    assert.ok(
      localStorage.getItem(unprunableAuthKey) != null,
      "Unprunable auth session must NEVER be purged",
    );
    // At least one prunable entry must have been evicted
    const calendarEvicted = localStorage.getItem(prunableCalendarKey) == null;
    const omdbEvicted = localStorage.getItem(prunableOmdbKey) == null;
    assert.ok(calendarEvicted || omdbEvicted, "Prunable entries must be pruned to reclaim space");

    // 3B: saveLocalCache slimming fallback under quota pressure
    localStorage.clear();
    setSession({ accessToken: "fake-token", username: "quota-user" });

    // Build a cache where completed shows have 500 watched episodes
    const cache = generateStressSimklCache(30);
    for (let i = 1; i <= 20; i++) {
      cache.items[String(200000 + i)].status = "completed";
      cache.items[String(200000 + i)].watchedEpisodes = Array.from(
        { length: 100 },
        (_, idx) => `1:${idx + 1}`,
      );
    }
    // Ensure 5 watching shows have active watchedEpisodes
    for (let i = 21; i <= 25; i++) {
      cache.items[String(200000 + i)].status = "watching";
      cache.items[String(200000 + i)].watchedEpisodes = ["1:1", "1:2"];
    }

    const fullSerialized = serializeCacheForStorage(cache, false);
    const slimSerialized = serializeCacheForStorage(cache, true);

    assert.ok(
      fullSerialized.length > slimSerialized.length,
      `Full serialized (${fullSerialized.length} chars) must be larger than slim (${slimSerialized.length} chars)`,
    );

    // Set quota limit between slimSerialized.length and fullSerialized.length!
    // fullPayload will exceed quota, triggering slimming fallback!
    quotaQuotaBytes = slimSerialized.length + 500;

    clearLocalCache();
    saveLocalCache(cache);

    // Wait for the 1000ms debounce writeTimeout in store.ts to execute
    await new Promise((resolve) => setTimeout(resolve, 1150));

    const savedRaw = localStorage.getItem("harbor.simkl.cache.v2.default");
    assert.ok(savedRaw != null, "Cache must be persisted to localStorage after slimming fallback");

    const parsed = JSON.parse(savedRaw!) as SimklCache;
    // Completed shows should have watchedEpisodes stripped in saved storage
    assert.equal(
      parsed.items[String(200001)].watchedEpisodes,
      undefined,
      "Completed show must have watchedEpisodes stripped in storage",
    );
    // Watching shows must retain watchedEpisodes
    assert.deepEqual(
      parsed.items[String(200021)].watchedEpisodes,
      ["1:1", "1:2"],
      "Watching show must retain active watched episodes without data loss",
    );
    // In-memory cache must remain untouched
    assert.ok(
      cache.items[String(200001)].watchedEpisodes?.length === 100,
      "In-memory cache must retain full watched episodes for completed shows",
    );

    // 3C: Absolute hard quota exhaustion (quota = 0 bytes)
    // Verify saveLocalCache handles it gracefully without crashing or throwing unhandled errors
    quotaQuotaBytes = 0;
    let crashed = false;
    try {
      saveLocalCache(cache);
      await new Promise((resolve) => setTimeout(resolve, 1150));
    } catch {
      crashed = true;
    }
    assert.equal(crashed, false, "saveLocalCache must never crash under zero quota");
  } finally {
    (globalThis as any).window = previousWindow;
  }
});
