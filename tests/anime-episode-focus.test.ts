// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  selectAnimePreferredSeason,
  resolveAnimeFocusEpisode,
  computeAnimeLastPlay,
} from "../src/views/detail/anime-episodes/use-anime-preferred-season.ts";
import type { KitsuEpisode } from "../src/lib/providers/kitsu.ts";

test("selectAnimePreferredSeason advances to Season 2 when Season 1 is watched on Simkl", () => {
  const episodes: KitsuEpisode[] = [
    // Season 1
    { id: 101, number: 1, seasonNumber: 1, airdate: "2023-01-01" },
    { id: 102, number: 2, seasonNumber: 1, airdate: "2023-01-08" },
    // Season 2 (sibling entry with sourceMetaId)
    { id: 201, number: 1, seasonNumber: 2, sourceMetaId: "kitsu:2", airdate: "2024-01-01" },
    { id: 202, number: 2, seasonNumber: 2, sourceMetaId: "kitsu:2", airdate: "2024-01-08" },
  ];

  const simklMap = new Map<string, Set<string>>([
    ["kitsu:1", new Set(["1:1", "1:2"])],
  ]);

  const selected = selectAnimePreferredSeason({
    episodes,
    metaId: "kitsu:1",
    traktWatched: new Set(),
    simklWatched: new Set(["1:1", "1:2"]),
    simklMap,
  });

  assert.equal(selected, "2");
});

test("resolveAnimeFocusEpisode returns null when zero episodes are watched and no resume exists", () => {
  const episodes: KitsuEpisode[] = [
    { id: 101, number: 1, seasonNumber: 1 },
    { id: 102, number: 2, seasonNumber: 1 },
    { id: 103, number: 3, seasonNumber: 1 },
  ];

  const target = resolveAnimeFocusEpisode(
    episodes,
    episodes,
    () => ({ ratio: 0, watched: false, startedAt: 0 }),
    101, // nextUpId defaults to ep 1 when none are watched
    null,
    null,
  );

  assert.equal(target, null, "Should not scroll/focus when user has 0 progress");
});

test("resolveAnimeFocusEpisode returns the next unwatched episode even when idx < 12", () => {
  const episodes: KitsuEpisode[] = Array.from({ length: 12 }, (_, i) => ({
    id: 101 + i,
    number: i + 1,
    seasonNumber: 1,
  }));

  // User has watched episodes 1, 2, 3
  const watchedIds = new Set([101, 102, 103]);
  const progressFor = (ep: KitsuEpisode) => ({
    ratio: watchedIds.has(ep.id) ? 1 : 0,
    watched: watchedIds.has(ep.id),
    startedAt: 0,
  });

  // Next up is episode 4 (id 104, index 3 < 12)
  const target = resolveAnimeFocusEpisode(
    episodes,
    episodes,
    progressFor,
    104,
    null,
    null,
  );

  assert.ok(target);
  assert.equal(target?.id, 104);
  assert.equal(target?.number, 4);
});

test("computeAnimeLastPlay advances to next unwatched episode from Simkl watched progress", () => {
  const episodes: KitsuEpisode[] = [
    { id: 101, number: 1, seasonNumber: 1, airdate: "2023-01-01" },
    { id: 102, number: 2, seasonNumber: 1, airdate: "2023-01-08" },
    { id: 103, number: 3, seasonNumber: 1, airdate: "2023-01-15" },
  ];

  // User has watched 1:1 and 1:2 on Simkl
  const simklWatched = new Set(["1:1", "1:2"]);

  const lp = computeAnimeLastPlay({
    metaId: "kitsu:47640",
    animeEpisodes: episodes,
    simklWatched,
  });

  assert.ok(lp);
  assert.equal(lp?.season, 1);
  assert.equal(lp?.episode, 3, "Advances to Episode 3");
});

test("computeAnimeLastPlay respects manual unwatched overrides over tracker progress", () => {
  const episodes: KitsuEpisode[] = [
    { id: 101, number: 1, seasonNumber: 1, airdate: "2023-01-01" },
    { id: 102, number: 2, seasonNumber: 1, airdate: "2023-01-08" },
    { id: 103, number: 3, seasonNumber: 1, airdate: "2023-01-15" },
  ];

  // Tracker says 1:1 and 1:2 are watched, but user explicitly unmarked 1:1
  const simklWatched = new Set(["1:1", "1:2"]);
  const manualWatched = (id: string, s: number, e: number) => {
    if (s === 1 && e === 1) return false; // unmarked
    return undefined;
  };

  const lp = computeAnimeLastPlay({
    metaId: "kitsu:47640",
    animeEpisodes: episodes,
    simklWatched,
    manualWatched,
  });

  // Because ep 1 was unmarked, the earliest unwatched after progress or from start:
  // highestWatchedIdx was 1 (ep 2), next unwatched after ep 2 is ep 3.
  assert.ok(lp);
  assert.equal(lp?.episode, 3);

  // If ep 2 was unmarked, highest watched is none or ep 1:
  const manualWatched2 = (id: string, s: number, e: number) => {
    if (s === 1 && e === 2) return false;
    return undefined;
  };
  const lp2 = computeAnimeLastPlay({
    metaId: "kitsu:47640",
    animeEpisodes: episodes,
    simklWatched,
    manualWatched: manualWatched2,
  });
  // Highest watched is ep 1, next unwatched is ep 2
  assert.ok(lp2);
  assert.equal(lp2?.episode, 2);
});

test("computeAnimeLastPlay returns null when all aired episodes are watched and no local base exists", () => {
  const episodes: KitsuEpisode[] = [
    { id: 101, number: 1, seasonNumber: 1, airdate: "2023-01-01" },
    { id: 102, number: 2, seasonNumber: 1, airdate: "2023-01-08" },
  ];

  const simklWatched = new Set(["1:1", "1:2"]);

  const lp = computeAnimeLastPlay({
    metaId: "kitsu:47640",
    animeEpisodes: episodes,
    simklWatched,
  });

  assert.equal(lp, null, "All aired episodes are watched; should show Play instead of Resume");
});

test("selectAnimePreferredSeason disambiguates franchise collisions using sourceMetaId and playedId", () => {
  // Merged franchise list where Bleach 2004 has ep 1 and TYBW has ep 1
  const episodes: KitsuEpisode[] = [
    { id: 101, number: 1, seasonNumber: 1, sourceMetaId: undefined },
    { id: 201, number: 1, seasonNumber: 2, sourceMetaId: "kitsu:47640" },
  ];

  // Resume saved under kitsu:47640 for ep 1
  const selected = selectAnimePreferredSeason({
    episodes,
    metaId: "kitsu:1",
    trackId: "kitsu:47640",
    traktWatched: new Set(),
    lastPlayed: { episode: 1 },
  });

  assert.ok(selected);
});

