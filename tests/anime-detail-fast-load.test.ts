// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  animeDetails,
  clearAnimeDetailCache,
} from "../src/lib/providers/anime-detail.ts";
import type { Settings } from "../src/lib/settings.ts";
import type { Meta } from "../src/lib/cinemeta.ts";

const originalFetch = globalThis.fetch;

function installMockFetch() {
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/anime/47640/episodes")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              id: "101",
              type: "episodes",
              attributes: { number: 1, seasonNumber: 1, canonicalTitle: "Episode 1" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/anime/47640/streaming-links")) {
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/anime/47640")) {
      return new Response(
        JSON.stringify({
          data: {
            id: "47640",
            type: "anime",
            attributes: { canonicalTitle: "Bleach: TYBW", episodeCount: 13, showType: "TV" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("anime-kitsu.strem.fun")) {
      return new Response(
        JSON.stringify({
          meta: { id: "kitsu:47640", name: "Bleach: TYBW", type: "series", videos: [] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("ani.zip")) {
      return new Response(
        JSON.stringify({ titles: { en: "Bleach: TYBW" }, episodes: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

test("animeDetails returns Stage 1 immediately while enrichPromise and extrasPromise are pending", async () => {
  clearAnimeDetailCache();
  installMockFetch();
  try {
    const settings: Settings = {
      tmdbLanguage: "en-US",
      uiLanguage: "en",
      translateTitles: false,
      translateDescriptions: false,
    } as unknown as Settings;

    const meta: Meta = {
      id: "kitsu:47640",
      type: "series",
      name: "Bleach: Thousand-Year Blood War",
    };

    const res = await animeDetails(settings, meta);
    assert.ok(res, "animeDetails should return a result");
    assert.equal(res.kitsuId, 47640);
    assert.ok(res.detail, "Stage 1 detail exists");
    assert.ok(Array.isArray(res.episodes), "Stage 1 episodes exist");
    assert.ok(res.enrichPromise instanceof Promise, "enrichPromise is a Promise");
    assert.ok(res.extrasPromise instanceof Promise, "extrasPromise is a Promise");

    // Await Stage 2 background promises
    const [enrichedEps, extras] = await Promise.all([res.enrichPromise, res.extrasPromise]);
    assert.ok(Array.isArray(enrichedEps));
    assert.ok(extras && typeof extras === "object");
  } finally {
    restoreFetch();
  }
});

test("animeDetails uses LRU cache on repeat calls and preserves in-place extras on cache hits", async () => {
  clearAnimeDetailCache();
  installMockFetch();
  try {
    const settings: Settings = {
      tmdbLanguage: "en-US",
      uiLanguage: "en",
      translateTitles: false,
      translateDescriptions: false,
    } as unknown as Settings;

    const meta: Meta = {
      id: "kitsu:47640",
      type: "series",
      name: "Bleach",
    };

    const first = await animeDetails(settings, meta);
    // Wait for extras to finish and mutate first.detail in place
    await first.extrasPromise;

    const second = await animeDetails(settings, meta);
    assert.equal(first, second, "Repeat call should return the cached instance");
    assert.equal(first.detail, second.detail, "Cached instance retains enriched detail reference");

    clearAnimeDetailCache();
  } finally {
    restoreFetch();
  }
});

