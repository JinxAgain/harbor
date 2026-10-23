// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { resolveSimklAnimeShowIds, resolveAnimeAliasKeys } from "../src/lib/simkl/ids.ts";
import { computeSimklAnimeWatched } from "../src/lib/simkl/use-simkl-anime-watched.ts";
import type { KitsuEpisode } from "../src/lib/providers/kitsu.ts";

test("computeSimklAnimeWatched unions watched episodes across multiple candidate keys", () => {
  const candidateKeys = ["kitsu:47640", "mal:51191", "tt0388629"];
  const watchedMap = new Map<string, Set<string>>([
    ["kitsu:47640", new Set(["1:1", "1:2"])],
    ["mal:51191", new Set(["1:2", "1:3"])],
    ["tt0388629", new Set(["1:4"])],
  ]);
  const statusMap = new Map();
  const episodes: KitsuEpisode[] = [
    { id: 101, number: 1, seasonNumber: 1, airdate: "2023-01-01" },
    { id: 102, number: 2, seasonNumber: 1, airdate: "2023-01-08" },
    { id: 103, number: 3, seasonNumber: 1, airdate: "2023-01-15" },
    { id: 104, number: 4, seasonNumber: 1, airdate: "2023-01-22" },
    { id: 105, number: 5, seasonNumber: 1, airdate: "2023-01-29" },
  ];

  const result = computeSimklAnimeWatched(candidateKeys, watchedMap, statusMap, episodes);
  assert.deepEqual(Array.from(result.watchedKeys).sort(), ["1:1", "1:2", "1:3", "1:4"]);
  assert.equal(result.completed, false);
});

test("computeSimklAnimeWatched expands status === 'completed' to all aired episodes and sets completed: true", () => {
  const candidateKeys = ["kitsu:47640", "mal:51191"];
  const watchedMap = new Map<string, Set<string>>(); // empty individual watched rows on Simkl
  const statusMap = new Map([["mal:51191", "completed" as const]]);
  const episodes: KitsuEpisode[] = [
    { id: 101, number: 1, seasonNumber: 1, airdate: "2023-01-01" },
    { id: 102, number: 2, seasonNumber: 1, airdate: "2023-01-08" },
    // Unaired episode far in future
    { id: 103, number: 3, seasonNumber: 1, airdate: "2099-01-01" },
  ];

  const result = computeSimklAnimeWatched(candidateKeys, watchedMap, statusMap, episodes);
  assert.deepEqual(Array.from(result.watchedKeys).sort(), ["1:1", "1:2"]);
  assert.equal(result.completed, true);
});

test("resolveSimklAnimeShowIds resolves kitsu and mal IDs for anime", async () => {
  const ids = await resolveSimklAnimeShowIds("kitsu:47640");
  assert.ok(ids);
  assert.equal(ids.kitsu, 47640);
  assert.equal(ids.mal, 51191);

  const nonAnime = await resolveSimklAnimeShowIds("tt0903747");
  assert.ok(nonAnime);
  assert.equal(nonAnime.imdb, "tt0903747");
});

test("resolveAnimeAliasKeys collects cross-provider candidate keys", async () => {
  const keys = await resolveAnimeAliasKeys("kitsu:47640", "tt0388629");
  assert.ok(keys.includes("kitsu:47640"));
  assert.ok(keys.includes("mal:51191"));
  assert.ok(keys.includes("tt0388629"));
});

test("syncSimklWatchedMany groups episodes by season and calls Simkl history dispatchers", async () => {
  const { syncSimklWatchedMany } = await import(
    "../src/views/detail/anime-episodes/use-anime-watched-routing.ts"
  );
  const markCalls: Array<{ ids: unknown; season: number; episodes: number[] }> = [];
  const unmarkCalls: Array<{ ids: unknown; season: number; episodes: number[] }> = [];

  const mockDispatchers = {
    resolveIds: async () => ({ kitsu: 47640, mal: 51191 }),
    mark: async (ids: unknown, season: number, episodes: number[]) => {
      markCalls.push({ ids, season, episodes });
      return true;
    },
    unmark: async (ids: unknown, season: number, episodes: number[]) => {
      unmarkCalls.push({ ids, season, episodes });
      return true;
    },
  };

  const eps = [
    { season: 1, episode: 1 },
    { season: 1, episode: 2 },
    { season: 2, episode: 1 },
  ];

  // Mark watched
  const marked = await syncSimklWatchedMany("kitsu:47640", eps, true, mockDispatchers as any);
  assert.equal(marked, true);
  assert.equal(markCalls.length, 2);
  assert.deepEqual(markCalls[0], { ids: { kitsu: 47640, mal: 51191 }, season: 1, episodes: [1, 2] });
  assert.deepEqual(markCalls[1], { ids: { kitsu: 47640, mal: 51191 }, season: 2, episodes: [1] });

  // Unmark
  const unmarked = await syncSimklWatchedMany("kitsu:47640", eps, false, mockDispatchers as any);
  assert.equal(unmarked, true);
  assert.equal(unmarkCalls.length, 2);
  assert.deepEqual(unmarkCalls[0], { ids: { kitsu: 47640, mal: 51191 }, season: 1, episodes: [1, 2] });
  assert.deepEqual(unmarkCalls[1], { ids: { kitsu: 47640, mal: 51191 }, season: 2, episodes: [1] });
});

test("computeSimklAnimeWatched translates franchise keys using imdbSeason/imdbEpisode and ignores franchise-only completed status", () => {
  const candidateKeys = ["kitsu:47640", "tt0388629"];
  // Simkl stores Season 2 Ep 1 under IMDb TVDB coords "2:1", and Season 1 Ep 1 under "1:1"
  const watchedMap = new Map<string, Set<string>>([
    ["tt0388629", new Set(["1:1", "2:1"])],
  ]);
  // Franchise IMDb key has "completed" from Season 1 completion
  const statusMap = new Map([["tt0388629", "completed" as const]]);

  // Season 2 episodes: seasonNumber 1, but imdbSeason 2
  const episodes: KitsuEpisode[] = [
    { id: 201, number: 1, seasonNumber: 1, imdbSeason: 2, imdbEpisode: 1, airdate: "2023-01-01" },
    { id: 202, number: 2, seasonNumber: 1, imdbSeason: 2, imdbEpisode: 2, airdate: "2023-01-08" },
  ];

  const result = computeSimklAnimeWatched(candidateKeys, watchedMap, statusMap, episodes);
  // Only "2:1" matches episode 1 (imdbSeason: 2, imdbEpisode: 1 -> 1:1), "1:1" (Season 1 Ep 1) does NOT match Season 2
  assert.deepEqual(Array.from(result.watchedKeys), ["1:1"]);
  // Franchise status "completed" does NOT mark Season 2 completed because kitsu:47640 is present
  assert.equal(result.completed, false);
});
