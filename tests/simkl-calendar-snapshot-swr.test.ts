// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import "./_localstorage-stub.ts";

import {
  readSimklCalendarSnapshot,
  peekSimklCalendar,
  writeSimklCalendarSnapshot,
  subscribeSimklCalendarSnapshot,
  invalidateSimklCalendarSnapshots,
} from "../src/lib/simkl/calendar-snapshot.ts";
import {
  fetchSimklCalendar,
} from "../src/lib/calendar-sources.ts";
import {
  saveLocalCache,
  type SimklCache,
  type SimklCacheItem,
} from "../src/lib/simkl/activities/store.ts";
import { resetActivitiesGate } from "../src/lib/simkl/activities/gate.ts";
import { setSession } from "../src/lib/simkl/session.ts";
import type { CalendarItem } from "../src/lib/calendar.ts";

function createMockItem(id: string, name: string, date: string): CalendarItem {
  return {
    id,
    type: "tv",
    name,
    poster: `https://img.test/${id}.jpg`,
    background: null,
    releaseDate: date,
    isAnime: false,
    overview: `Overview for ${name}`,
    voteAverage: 8.5,
  };
}

// -----------------------------------------------------------------------------
// ADVERSARIAL SUITE 1: Snapshot & SWR Lifecycle Under Adversarial Pressure
// -----------------------------------------------------------------------------

test("ADV-CHALLENGER2-1.1: Zero ghost updates on unchanged data or deep-equal rewrites", () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  setSession({ accessToken: "token-adv-2", username: "user-adv-2" });

  const year = 2026;
  const month = 4; // May 2026
  let callCount = 0;
  let lastItemsReceived: CalendarItem[] | null = null;

  const unsubscribe = subscribeSimklCalendarSnapshot(year, month, (items) => {
    callCount++;
    lastItemsReceived = items;
  });

  const baseItem = createMockItem("show-1", "Test Show S01E01", "2026-05-10");

  // First write: data does not exist yet -> listener MUST be notified
  writeSimklCalendarSnapshot(year, month, [baseItem], "sync-1");
  assert.equal(callCount, 1, "Initial write must notify listener once");
  assert.equal(lastItemsReceived?.[0]?.id, "show-1");

  // Adversarial Stress: 20 sequential writes with EXACT SAME or DEEP-EQUAL items
  for (let i = 0; i < 20; i++) {
    // Alternate between same reference and newly created identical object
    const itemsToWrite = i % 2 === 0
      ? [baseItem]
      : [createMockItem("show-1", "Test Show S01E01", "2026-05-10")];
    writeSimklCalendarSnapshot(year, month, itemsToWrite, `sync-1-dup-${i}`);
  }

  assert.equal(
    callCount,
    1,
    `Zero ghost updates expected: listener was called ${callCount} times (expected 1)`,
  );

  // Write for a DIFFERENT month (month 5): listener for month 4 MUST NOT be called
  writeSimklCalendarSnapshot(year, 5, [createMockItem("show-2", "Other Month S01E01", "2026-06-10")], "sync-2");
  assert.equal(callCount, 1, "Writes to other months must never trigger ghost update on month 4");

  // Actual change: write new item -> listener MUST be notified exactly once more
  const updatedItem = createMockItem("show-1", "Test Show S01E02", "2026-05-17");
  writeSimklCalendarSnapshot(year, month, [baseItem, updatedItem], "sync-3");
  assert.equal(callCount, 2, "Actual data change must notify listener");
  assert.equal(lastItemsReceived?.length, 2);

  // Unsubscribe cleanly
  unsubscribe();

  // Subsequent writes after unsubscribe must NEVER invoke the listener
  writeSimklCalendarSnapshot(year, month, [updatedItem], "sync-4");
  assert.equal(callCount, 2, "Unsubscribed listener must never receive further updates");
});

test("ADV-CHALLENGER2-1.2: Rapid month switching subscription isolation and no cross-month leaks", () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  setSession({ accessToken: "token-adv-2", username: "user-adv-2" });

  const notifications: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const unsubs: (() => void)[] = [];

  // Simulate user rapidly navigating through 6 months, subscribing to each
  for (let m = 0; m < 6; m++) {
    unsubs.push(
      subscribeSimklCalendarSnapshot(2026, m, () => {
        notifications[m]++;
      }),
    );
  }

  // Interleaved writes to various months
  writeSimklCalendarSnapshot(2026, 2, [createMockItem("m2", "Month 2 Show", "2026-03-01")], "s2");
  writeSimklCalendarSnapshot(2026, 4, [createMockItem("m4", "Month 4 Show", "2026-05-01")], "s4");
  writeSimklCalendarSnapshot(2026, 2, [createMockItem("m2-new", "Month 2 Show Ep 2", "2026-03-08")], "s2b");

  assert.equal(notifications[0], 0, "Month 0 received 0 notifications");
  assert.equal(notifications[1], 0, "Month 1 received 0 notifications");
  assert.equal(notifications[2], 2, "Month 2 received exactly 2 notifications");
  assert.equal(notifications[3], 0, "Month 3 received 0 notifications");
  assert.equal(notifications[4], 1, "Month 4 received exactly 1 notification");
  assert.equal(notifications[5], 0, "Month 5 received 0 notifications");

  for (const unsub of unsubs) unsub();
});

test("ADV-CHALLENGER2-1.3: High-concurrency asynchronous writes & interleaved promise resolution", async () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  setSession({ accessToken: "token-adv-2", username: "user-adv-2" });

  // Launch 30 concurrent async tasks writing to months 0..4 in random microtask order
  const tasks: Promise<void>[] = [];
  for (let i = 0; i < 30; i++) {
    const targetMonth = i % 5;
    const task = (async () => {
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 5)));
      writeSimklCalendarSnapshot(
        2026,
        targetMonth,
        [createMockItem(`task-${i}`, `Concurrent Item ${i}`, `2026-0${targetMonth + 1}-10`)],
        `sync-${i}`,
      );
    })();
    tasks.push(task);
  }

  await Promise.all(tasks);

  // Verify that all 5 target months remain readable, valid, and uncorrupted
  for (let m = 0; m < 5; m++) {
    const snap = readSimklCalendarSnapshot(2026, m);
    assert.ok(snap, `Month ${m} must be readable after concurrent writes`);
    assert.ok(snap.items.length > 0, `Month ${m} must contain items`);
    assert.ok(snap.items[0].id.startsWith("task-"));
  }
});

test("ADV-CHALLENGER2-1.4: Peek returns instant data during SWR invalidation & zero skeleton flash", () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  setSession({ accessToken: "token-adv-2", username: "user-adv-2" });

  const item = createMockItem("ep-1", "Series Finale", "2026-07-20");
  writeSimklCalendarSnapshot(2026, 6, [item], "initial-sync");

  // 1. Fresh peek
  const peek1 = peekSimklCalendar(2026, 6);
  assert.ok(peek1, "Fresh snapshot must peek immediately");
  assert.equal(peek1.isStale, false);
  assert.equal(peek1.items.length, 1);
  assert.equal(peek1[0].name, "Series Finale");

  // 2. Mark stale via activities gate mutation
  resetActivitiesGate({ kind: "set-status", ids: { simkl: 999 }, status: "completed" });

  // 3. Peek immediately after invalidation
  // CRITICAL REQUIREMENT: Peek must STILL return cached items so the UI does NOT flash skeletons!
  const peekStale = peekSimklCalendar(2026, 6);
  assert.ok(peekStale, "Stale snapshot must STILL return items to eliminate skeleton flash");
  assert.equal(peekStale.isStale, true, "isStale must be true to trigger background revalidation");
  assert.equal(peekStale.items.length, 1, "Cached items must be preserved for SWR render");
  assert.equal(peekStale[0].id, "ep-1");
});

// -----------------------------------------------------------------------------
// ADVERSARIAL SUITE 2: LRU Eviction & Size Protection
// -----------------------------------------------------------------------------

test("ADV-CHALLENGER2-2.1: 12 sequential months pushed: exactly oldest 6 evicted, newest 6 kept", () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  setSession({ accessToken: "token-adv-2", username: "user-adv-2" });

  const storageKey = "harbor.simkl.calendar.v1.default";

  // Push 12 sequential months: (2026, 0) through (2026, 11)
  const baseTime = 1700000000000;
  const realNow = Date.now;
  try {
    for (let m = 0; m < 12; m++) {
      Date.now = () => baseTime + m * 1000; // each month written 1 second after the previous
      writeSimklCalendarSnapshot(
        2026,
        m,
        [createMockItem(`id-${m}`, `Show Month ${m}`, `2026-${String(m + 1).padStart(2, "0")}-15`)],
        `sync-m${m}`,
      );
    }
  } finally {
    Date.now = realNow;
  }

  const raw = localStorage.getItem(storageKey);
  assert.ok(raw, "Snapshots must be persisted in localStorage");
  const stored = JSON.parse(raw);
  const storedKeys = Object.keys(stored);

  // Must have exactly 6 months stored
  assert.equal(storedKeys.length, 6, `Expected exactly 6 months, got ${storedKeys.length}`);

  // Oldest 6 months (0, 1, 2, 3, 4, 5) MUST ALL BE EVICTED
  for (let m = 0; m < 6; m++) {
    const k = `2026-${m}`;
    assert.equal(
      storedKeys.includes(k),
      false,
      `Month ${k} was written among oldest 6 and MUST be evicted`,
    );
    assert.equal(
      readSimklCalendarSnapshot(2026, m),
      null,
      `Month ${k} must return null on read`,
    );
  }

  // Newest 6 months (6, 7, 8, 9, 10, 11) MUST ALL BE PRESENT
  for (let m = 6; m < 12; m++) {
    const k = `2026-${m}`;
    assert.equal(
      storedKeys.includes(k),
      true,
      `Month ${k} was among newest 6 and MUST be present`,
    );
    const snap = readSimklCalendarSnapshot(2026, m);
    assert.ok(snap, `Month ${k} must be present in snapshot store`);
    assert.equal(snap.items[0].id, `id-${m}`);
  }
});

test("ADV-CHALLENGER2-2.2: LRU access refresh preserves read month over untouched older month", () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  setSession({ accessToken: "token-adv-2", username: "user-adv-2" });

  const storageKey = "harbor.simkl.calendar.v1.default";
  const baseTime = 1700000000000;
  const realNow = Date.now;

  try {
    // Fill up exactly 6 months: months 0, 1, 2, 3, 4, 5
    for (let m = 0; m < 6; m++) {
      Date.now = () => baseTime + m * 1000;
      writeSimklCalendarSnapshot(2026, m, [createMockItem(`item-${m}`, `Show ${m}`, "2026-01-01")], "s");
    }

    // Now, simulate user accessing/viewing Month 0 (the oldest inserted month)
    // Month 0 accessedAt is bumped to baseTime + 100,000 (making it the MOST RECENTLY accessed)
    Date.now = () => baseTime + 100000;
    const peeked0 = peekSimklCalendar(2026, 0);
    assert.ok(peeked0);

    // Now insert Month 6
    Date.now = () => baseTime + 101000;
    writeSimklCalendarSnapshot(2026, 6, [createMockItem("item-6", "Show 6", "2026-07-01")], "s");

    const raw = localStorage.getItem(storageKey);
    const stored = JSON.parse(raw!);
    const keys = Object.keys(stored);

    // Verify 6 months total
    assert.equal(keys.length, 6);

    // Month 0 must STILL BE PRESENT because it was refreshed!
    assert.ok(keys.includes("2026-0"), "Month 2026-0 was refreshed and must NOT be evicted");

    // Month 1 was never refreshed and is now the oldest: IT must be evicted!
    assert.ok(!keys.includes("2026-1"), "Month 2026-1 is the true LRU entry and must be evicted");

    // Month 6 must be present
    assert.ok(keys.includes("2026-6"), "Month 2026-6 must be present");
  } finally {
    Date.now = realNow;
  }
});

test("ADV-CHALLENGER2-2.3: Size bounding aggressively prunes oldest when payload exceeds 200 KB", () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });
  setSession({ accessToken: "token-adv-2", username: "user-adv-2" });

  const storageKey = "harbor.simkl.calendar.v1.default";
  const MAX_STORAGE_BYTES = 200 * 1024; // 200 KB

  // Create a chunky item (~10 KB each)
  const createHeavyItems = (monthIndex: number, count: number): CalendarItem[] => {
    const list: CalendarItem[] = [];
    for (let i = 0; i < count; i++) {
      list.push({
        id: `m${monthIndex}-heavy-${i}`,
        type: "tv",
        name: `Extremely Long Show Title For Stress Testing Overflow Size ${monthIndex} - Episode ${i}`,
        poster: `https://image.tmdb.org/t/p/w1280/very-long-path-name-padding-${"x".repeat(300)}.jpg`,
        background: `https://image.tmdb.org/t/p/w1280/very-long-background-padding-${"y".repeat(300)}.jpg`,
        releaseDate: `2026-0${monthIndex + 1}-10`,
        isAnime: false,
        overview: `Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ${"z".repeat(500)}`,
        voteAverage: 8.8,
      });
    }
    return list;
  };

  // Write 5 months, each containing ~60 KB of JSON data (total ~300 KB > 200 KB limit)
  for (let m = 0; m < 5; m++) {
    const heavyItems = createHeavyItems(m, 40);
    writeSimklCalendarSnapshot(2026, m, heavyItems, `sync-${m}`);
  }

  const raw = localStorage.getItem(storageKey);
  assert.ok(raw);
  assert.ok(
    raw.length <= MAX_STORAGE_BYTES,
    `Persisted snapshot size was ${raw.length} bytes, must be <= ${MAX_STORAGE_BYTES} bytes (200 KB)`,
  );

  const stored = JSON.parse(raw);
  const storedKeys = Object.keys(stored);

  // Newest months must survive, older months must have been pruned by size limiter
  assert.ok(storedKeys.includes("2026-4"), "Newest month 4 must survive");
  assert.ok(!storedKeys.includes("2026-0"), "Oldest month 0 must be pruned to satisfy 200 KB limit");
});

// -----------------------------------------------------------------------------
// ADVERSARIAL SUITE 3: Far-Future Unpublished CDN Fallback Bounding
// -----------------------------------------------------------------------------

test("ADV-CHALLENGER2-3.1: Far-future month with 200 candidates strictly sliced to <= 24 highest-priority items", async () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });

  // Generate SimklCache with 200 items: 100 watching, 100 plantowatch
  const items: Record<string, SimklCacheItem> = {};
  const imdbToSimkl: Record<string, number> = {};

  // 100 watching items: watchedAt dates from 2026-01-01 to 2026-04-10
  for (let i = 1; i <= 100; i++) {
    const simklId = 200000 + i;
    const imdb = `tt${String(simklId).padStart(7, "0")}`;
    const watchedTimestamp = new Date(2026, 0, i).toISOString(); // Day i: Day 100 is most recent!
    items[String(simklId)] = {
      simklId,
      type: "show",
      title: `Watching Show ${i}`,
      year: 2025,
      status: "watching",
      userRating: 8,
      watchedAt: watchedTimestamp,
      ids: { simkl: simklId, imdb },
    };
    imdbToSimkl[imdb] = simklId;
  }

  // 100 plantowatch items
  for (let i = 101; i <= 200; i++) {
    const simklId = 200000 + i;
    const imdb = `tt${String(simklId).padStart(7, "0")}`;
    items[String(simklId)] = {
      simklId,
      type: "show",
      title: `Plan To Watch Show ${i}`,
      year: 2025,
      status: "plantowatch",
      userRating: null,
      watchedAt: null,
      ids: { simkl: simklId, imdb },
    };
    imdbToSimkl[imdb] = simklId;
  }

  const cache: SimklCache = {
    lastSync: "2026-11-01T00:00:00Z",
    activities: null,
    items,
    imdbToSimkl,
    tmdbToSimkl: {},
    malToSimkl: {},
    kitsuToSimkl: {},
  };

  setSession({ accessToken: "fake-token", username: "simkl-user" });
  saveLocalCache(cache);

  const fallbackQueriedImdbs: string[] = [];
  const originalFetch = globalThis.fetch;

  // Far-future month: year 2028, month 11 (December 2028, monthDiff >> 1)
  // CDN returns 404 (unpublished)
  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("data.simkl.in")) {
      return new Response("Not Found", { status: 404 });
    }
    // Intercept third-party scraping resolver
    const match = urlStr.match(/(tt\d+)/);
    if (match && !fallbackQueriedImdbs.includes(match[1])) {
      fallbackQueriedImdbs.push(match[1]);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    await fetchSimklCalendar(2028, 11, { tmdbKey: "test-tmdb-key" });

    // CRITICAL ASSERTION 1: Candidate resolution must be capped at EXACTLY <= 24 items
    assert.ok(
      fallbackQueriedImdbs.length <= 24,
      `Queried ${fallbackQueriedImdbs.length} candidates, expected <= 24`,
    );

    // CRITICAL ASSERTION 2: Exactly 24 candidates should have been queried (since 100 available)
    assert.equal(
      fallbackQueriedImdbs.length,
      24,
      `Expected exactly 24 bounded candidates to be resolved, got ${fallbackQueriedImdbs.length}`,
    );

    // CRITICAL ASSERTION 3: Priority verification
    // All 24 queried items MUST be the most recently watched items (i = 77 to 100)
    for (const imdb of fallbackQueriedImdbs) {
      const simklId = imdbToSimkl[imdb];
      assert.ok(simklId, `Expected recognized simklId for ${imdb}`);
      const item = items[String(simklId)];
      assert.equal(
        item.status,
        "watching",
        `Expected candidate ${item.title} to be "watching", not "plantowatch"`,
      );
      const index = simklId - 200000;
      assert.ok(
        index >= 77 && index <= 100,
        `Expected candidate index ${index} to be within the top 24 most recently watched (77..100)`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ADV-CHALLENGER2-3.2: Far-future fallback with 10 watching and 190 plantowatch candidates", async () => {
  invalidateSimklCalendarSnapshots({ purgeStorage: true });

  const items: Record<string, SimklCacheItem> = {};
  const imdbToSimkl: Record<string, number> = {};

  // 10 watching items
  for (let i = 1; i <= 10; i++) {
    const simklId = 300000 + i;
    const imdb = `tt${String(simklId).padStart(7, "0")}`;
    items[String(simklId)] = {
      simklId,
      type: "show",
      title: `Watching Show ${i}`,
      year: 2025,
      status: "watching",
      userRating: 8,
      watchedAt: new Date(2026, 0, i).toISOString(),
      ids: { simkl: simklId, imdb },
    };
    imdbToSimkl[imdb] = simklId;
  }

  // 190 plantowatch items (with watchedAt or modified timestamps)
  for (let i = 11; i <= 200; i++) {
    const simklId = 300000 + i;
    const imdb = `tt${String(simklId).padStart(7, "0")}`;
    items[String(simklId)] = {
      simklId,
      type: "show",
      title: `PTW Show ${i}`,
      year: 2025,
      status: "plantowatch",
      userRating: null,
      watchedAt: new Date(2026, 0, i).toISOString(),
      ids: { simkl: simklId, imdb },
    };
    imdbToSimkl[imdb] = simklId;
  }

  const cache: SimklCache = {
    lastSync: "2026-11-01T00:00:00Z",
    activities: null,
    items,
    imdbToSimkl,
    tmdbToSimkl: {},
    malToSimkl: {},
    kitsuToSimkl: {},
  };

  setSession({ accessToken: "fake-token", username: "simkl-user" });
  saveLocalCache(cache);

  const fallbackQueriedImdbs: string[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (url: string | URL | Request) => {
    const urlStr = String(url);
    if (urlStr.includes("data.simkl.in")) {
      return new Response("Not Found", { status: 404 });
    }
    const match = urlStr.match(/(tt\d+)/);
    if (match && !fallbackQueriedImdbs.includes(match[1])) {
      fallbackQueriedImdbs.push(match[1]);
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    await fetchSimklCalendar(2029, 5, { tmdbKey: "test-tmdb-key" });

    // Total must be bounded to exactly 24
    assert.equal(fallbackQueriedImdbs.length, 24);

    // ALL 10 watching items MUST be included
    const watchingIncluded = fallbackQueriedImdbs.filter((imdb) => {
      const simklId = imdbToSimkl[imdb];
      return items[String(simklId)].status === "watching";
    });
    assert.equal(
      watchingIncluded.length,
      10,
      `Expected all 10 watching items to be included, got ${watchingIncluded.length}`,
    );

    // Remaining 14 must be the top plantowatch items
    const ptwIncluded = fallbackQueriedImdbs.filter((imdb) => {
      const simklId = imdbToSimkl[imdb];
      return items[String(simklId)].status === "plantowatch";
    });
    assert.equal(
      ptwIncluded.length,
      14,
      `Expected 14 highest-priority plantowatch items to be included, got ${ptwIncluded.length}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
