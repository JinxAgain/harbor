// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  fetchIntroDbSegments,
  isIntroDbSupportedId,
  pickId,
  resetTheIntroDbState,
  setTheIntroDbApiKey,
} from "@/lib/skip-intro/theintrodb";

type FetchCall = {
  url: string;
  init?: RequestInit;
};

function setupFetchInterceptor(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const call: FetchCall = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

test("requests target /v4/media instead of /v2/media", async () => {
  resetTheIntroDbState();
  const interceptor = setupFetchInterceptor(() =>
    Response.json({
      tvdb_id: 169,
      type: "movie",
      intro: [{ start_ms: 1000, end_ms: 5000 }],
    }),
  );

  try {
    const segments = await fetchIntroDbSegments("tvdb:movie:169", undefined, 120);
    assert.equal(interceptor.calls.length, 1);
    const targetUrl = new URL(interceptor.calls[0].url);
    assert.equal(targetUrl.origin, "https://api.theintrodb.org");
    assert.equal(targetUrl.pathname, "/v4/media");
    assert.equal(targetUrl.searchParams.get("tvdb_id"), "169");
    assert.equal(segments.length, 1);
  } finally {
    interceptor.restore();
  }
});

test("pickId and fetchIntroDbSegments handle TVDB, TMDB, and IMDb IDs, and skip invalid IDs", async () => {
  resetTheIntroDbState();
  assert.deepEqual(pickId("tvdb:movie:169"), { tvdb: "169" });
  assert.deepEqual(pickId("tvdb:series:71663"), { tvdb: "71663" });
  assert.deepEqual(pickId("tvdb:71663"), { tvdb: "71663" });
  assert.deepEqual(pickId("tvdb:tv:71663"), { tvdb: "71663" });
  assert.deepEqual(pickId("tmdb:movie:456"), { tmdb: "456" });
  assert.deepEqual(pickId("tmdb:tv:456"), { tmdb: "456" });
  assert.deepEqual(pickId("tmdb:456"), { tmdb: "456" });
  assert.deepEqual(pickId("tt0111161"), { imdb: "tt0111161" });
  assert.deepEqual(pickId("tt0111161:1:2"), { imdb: "tt0111161" });
  assert.deepEqual(pickId("imdb:tt0111161"), { imdb: "tt0111161" });

  assert.equal(pickId("tvdb:invalid"), null);
  assert.equal(pickId("tvdb:0"), null);
  assert.equal(pickId("tmdb:0"), null);
  assert.equal(pickId("tmdb:notanumber"), null);
  assert.equal(pickId("tt123"), null);
  assert.equal(pickId("random:123"), null);
  assert.equal(pickId("kitsu:123"), null);

  assert.equal(isIntroDbSupportedId("tvdb:series:71663"), true);
  assert.equal(isIntroDbSupportedId("tmdb:movie:456"), true);
  assert.equal(isIntroDbSupportedId("tt0111161:1:2"), true);
  assert.equal(isIntroDbSupportedId("kitsu:123"), false);

  const interceptor = setupFetchInterceptor(() => Response.json({}));
  try {
    const invalidSegments = await fetchIntroDbSegments("kitsu:123", undefined, 100);
    assert.deepEqual(invalidSegments, []);
    assert.equal(interceptor.calls.length, 0);
  } finally {
    interceptor.restore();
  }
});

test("setTheIntroDbApiKey formats Authorization Bearer header without duplicate Bearer prefix", async () => {
  resetTheIntroDbState();
  let interceptor = setupFetchInterceptor(() => Response.json({}));
  try {
    setTheIntroDbApiKey("theintrodb:user:secret");
    await fetchIntroDbSegments("tvdb:169", undefined, 120);
    assert.equal(interceptor.calls.length, 1);
    const headers = new Headers(interceptor.calls[0].init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer theintrodb:user:secret");
    assert.equal(headers.has("X-API-Key"), false);
  } finally {
    interceptor.restore();
  }

  resetTheIntroDbState();
  interceptor = setupFetchInterceptor(() => Response.json({}));
  try {
    setTheIntroDbApiKey("Bearer already_prefixed_token");
    await fetchIntroDbSegments("tvdb:169", undefined, 120);
    assert.equal(interceptor.calls.length, 1);
    const headers = new Headers(interceptor.calls[0].init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer already_prefixed_token");
  } finally {
    interceptor.restore();
    setTheIntroDbApiKey("");
  }
});

test("durationSec > 0 appends duration_ms and durationSec <= 0 omits duration_ms", async () => {
  resetTheIntroDbState();
  const interceptor = setupFetchInterceptor(() => Response.json({}));
  try {
    await fetchIntroDbSegments("tmdb:movie:456", undefined, 1420.4);
    assert.equal(interceptor.calls.length, 1);
    const url1 = new URL(interceptor.calls[0].url);
    assert.equal(url1.searchParams.get("duration_ms"), "1420000");

    await fetchIntroDbSegments("tmdb:movie:789", undefined, 0);
    assert.equal(interceptor.calls.length, 2);
    const url2 = new URL(interceptor.calls[1].url);
    assert.equal(url2.searchParams.has("duration_ms"), false);
  } finally {
    interceptor.restore();
  }
});

test("TV episode requests forward season, episode, tvdb_episode_id, mapping, and episode_name", async () => {
  resetTheIntroDbState();
  const interceptor = setupFetchInterceptor(() => Response.json({}));
  try {
    await fetchIntroDbSegments(
      "tvdb:series:71663",
      {
        season: 1,
        episode: 5,
        tvdbEpisodeId: 98765,
        mapping: "alternate",
        episodeName: "The Test Episode",
      },
      1200,
    );
    assert.equal(interceptor.calls.length, 1);
    const url = new URL(interceptor.calls[0].url);
    assert.equal(url.searchParams.get("tvdb_id"), "71663");
    assert.equal(url.searchParams.get("season"), "1");
    assert.equal(url.searchParams.get("episode"), "5");
    assert.equal(url.searchParams.get("tvdb_episode_id"), "98765");
    assert.equal(url.searchParams.get("mapping"), "alternate");
    assert.equal(url.searchParams.get("episode_name"), "The Test Episode");
  } finally {
    interceptor.restore();
  }
});

test("v4 response parsing handles null boundaries and filters no-segment markers", async () => {
  resetTheIntroDbState();
  const interceptor = setupFetchInterceptor(() =>
    Response.json({
      tvdb_id: 71663,
      type: "tv",
      season: 1,
      episode: 5,
      intro: [
        { start_ms: null, end_ms: 90000 }, // valid: null start becomes 0
        { start_ms: 10000, end_ms: 0 }, // marker: end_ms: 0 ignored
        { start_ms: 10000, end_ms: null }, // marker: end_ms: null ignored
      ],
      recap: [
        { start_ms: 0, end_ms: 30000 }, // valid recap
      ],
      credits: [
        { start_ms: 1300000, end_ms: null }, // valid: end_ms: null becomes durationSec (1420s)
        { start_ms: 0, end_ms: null }, // marker: 0 start on credits ignored
        { start_ms: null, end_ms: 1400000 }, // marker: null start on credits ignored
        { start_ms: 1200000, end_ms: 0 }, // marker: 0 end on credits ignored
      ],
      preview: [
        { start_ms: 1400000, end_ms: 1415000 }, // valid preview (outro)
      ],
    }),
  );

  try {
    const segments = await fetchIntroDbSegments(
      "tvdb:series:71663",
      { season: 1, episode: 5 },
      1420,
    );
    assert.deepEqual(segments, [
      { kind: "intro", startSec: 0, endSec: 90, source: "introdb" },
      { kind: "recap", startSec: 0, endSec: 30, source: "introdb" },
      { kind: "outro", startSec: 1300, endSec: 1420, source: "introdb" },
      { kind: "outro", startSec: 1400, endSec: 1415, source: "introdb" },
    ]);
  } finally {
    interceptor.restore();
  }
});

test("404 and 400 responses cache negative result without cooldown; 429/500 trigger cooldown", async () => {
  resetTheIntroDbState();
  let statusToReturn = 404;
  const interceptor = setupFetchInterceptor(() => new Response("Not Found", { status: statusToReturn }));

  try {
    // 1. 404 on prefetch (durationSec = 0)
    const res1 = await fetchIntroDbSegments("tvdb:71663", { season: 1, episode: 1 }, 0);
    assert.deepEqual(res1, []);
    assert.equal(interceptor.calls.length, 1);

    // Subsequent call for same episode with durationSec > 0 should hit baseKey negative cache (no network call)
    const res2 = await fetchIntroDbSegments("tvdb:71663", { season: 1, episode: 1 }, 1200);
    assert.deepEqual(res2, []);
    assert.equal(interceptor.calls.length, 1); // no extra fetch call!

    // But a different episode SHOULD call fetch (cooldown was NOT triggered)
    const res3 = await fetchIntroDbSegments("tvdb:71663", { season: 1, episode: 2 }, 1200);
    assert.deepEqual(res3, []);
    assert.equal(interceptor.calls.length, 2);

    // 2. 400 Bad Request caches query key without cooldown
    statusToReturn = 400;
    const res4 = await fetchIntroDbSegments("tvdb:71663", { season: 1, episode: 3 }, 1200);
    assert.deepEqual(res4, []);
    assert.equal(interceptor.calls.length, 3);

    // Call for different episode still calls fetch
    statusToReturn = 500;
    const res5 = await fetchIntroDbSegments("tvdb:71663", { season: 1, episode: 4 }, 1200);
    assert.deepEqual(res5, []);
    assert.equal(interceptor.calls.length, 4);

    // Now 500 triggered cooldown. Any subsequent request for any ID should be blocked by cooldown!
    const res6 = await fetchIntroDbSegments("tvdb:71663", { season: 1, episode: 5 }, 1200);
    assert.deepEqual(res6, []);
    assert.equal(interceptor.calls.length, 4); // still 4!
  } finally {
    interceptor.restore();
  }
});

test("src/lib/skip-intro/index.ts wires isIntroDbSupportedId, tvdbEpisodeId, and TVDB resolution", () => {
  const indexSource = readFileSync(new URL("../src/lib/skip-intro/index.ts", import.meta.url), "utf8");

  // isIntroDbSupportedId must be imported and used
  assert.match(indexSource, /import\s*\{[^}]*isIntroDbSupportedId[^}]*\}\s*from\s*["']\.\/theintrodb["']/);
  assert.match(indexSource, /isIntroDbSupportedId\(meta\.id\)/);
  assert.match(indexSource, /if\s*\(!isIntroDbSupportedId\(introDbId\)\)\s*return;/);

  // resolveAnimeToExternalId must resolve anime via cache.items with ids?.tvdb
  assert.match(indexSource, /item\.ids\?\.tvdb/);
  assert.match(indexSource, /tvdb:movie:/);
  assert.match(indexSource, /tvdb:series:/);

  // useSkipSegments must pass tvdbEpisodeId and include it in dependency array
  assert.match(indexSource, /tvdbEpisodeId:\s*episode\?\.tvdbEpisodeId/);
  assert.match(
    indexSource,
    /\[introDbId,\s*introSeason,\s*introEpisode,\s*durationSec,\s*theIntroDbKey,\s*episode\?\.tvdbEpisodeId\]/,
  );

  // prefetchSegments must also guard with isIntroDbSupportedId and pass tvdbEpisodeId
  const prefetchPart = indexSource.slice(indexSource.indexOf("export function prefetchSegments"));
  assert.match(prefetchPart, /if\s*\(isIntroDbSupportedId\(introDbId\)\)/);
  assert.match(prefetchPart, /tvdbEpisodeId:\s*episode\?\.tvdbEpisodeId/);
});

