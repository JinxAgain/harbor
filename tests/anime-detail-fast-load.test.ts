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

test("animeDetails returns Stage 1 immediately while enrichPromise and extrasPromise are pending", async () => {
  clearAnimeDetailCache();
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
});

test("animeDetails uses LRU cache on repeat calls for the same kitsuId and language", async () => {
  clearAnimeDetailCache();
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
  const second = await animeDetails(settings, meta);
  assert.equal(first, second, "Repeat call should return the cached instance");

  clearAnimeDetailCache();
  // After clear, a fresh call can be made
});

