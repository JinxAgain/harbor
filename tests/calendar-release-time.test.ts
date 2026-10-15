// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { localDateTimeFromIso } from "../src/lib/calendar-time.ts";
import { matchSimklCdnToUserCalendar } from "../src/lib/simkl/calendar-data.ts";

test("calendar timestamps retain their exact release instant", () => {
  const iso = "2026-08-31T18:30:00Z";
  const result = localDateTimeFromIso(iso);
  assert.equal(result.atMs, Date.parse(iso));
  assert.match(result.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(result.time ?? "", /^\d{1,2}:\d{2} (AM|PM)$/);
});

test("AniZip calendar entries prefer the UTC timestamp over the date-only fallback", () => {
  const source = readFileSync(new URL("../src/lib/calendar-library.ts", import.meta.url), "utf8");
  assert.match(source, /localDateTimeFromIso\(ep\.airDateUtc \?\? ep\.airDate\)/);
});

test("Simkl calendar matching preserves TV, Movie, and Anime accuracy without cross-type or cross-season collisions", () => {
  const { items } = matchSimklCdnToUserCalendar(
    2026,
    9, // October (0-indexed)
    {
      tv: [
        {
          title: "Severance",
          poster: "11/sev",
          date: "2026-10-15T12:00:00Z",
          ids: { simkl_id: 1001, imdb: "tt11280740", tmdb: "95396" },
          episode: { season: 2, episode: 4, title: "Woe's Hollow" },
          ratings: { simkl: { rating: 8.9 } },
        },
        {
          title: "South Park",
          poster: "22/sp",
          date: "2026-10-15T12:00:00Z",
          genres: ["Animation", "Comedy"],
          ids: { simkl_id: 2002, imdb: "tt0121955", tmdb: "2190" },
          episode: { season: 29, episode: 2, title: "Episode 2" },
        },
        {
          title: "TV With Movie TMDB Collision",
          poster: null,
          date: "2026-10-16T12:00:00Z",
          ids: { simkl_id: 9999, tmdb: "555" },
          episode: { season: 1, episode: 1, title: "Pilot" },
        },
      ],
      anime: [
        {
          title: "Dandadan Season 2",
          poster: "33/ddd",
          date: "2026-10-17T15:00:00Z",
          ids: { simkl_id: 3002, mal: "60002", kitsu: "9002", imdb: "tt30217403", tmdb: "240411" },
          episode: { episode: 3, title: "Turbo Granny Returns" },
        },
        {
          title: "Dandadan OVA (Untracked)",
          poster: "33/ova",
          date: "2026-10-18T15:00:00Z",
          ids: { simkl_id: 3099, mal: "60099", imdb: "tt30217403", tmdb: "240411" },
          episode: { episode: 1, title: "Special OVA" },
        },
      ],
      movie: [
        {
          title: "Dune: Messiah",
          poster: "44/dune",
          date: "2026-10-20T12:00:00Z",
          ids: { simkl_id: 4001, imdb: "tt15239678", tmdb: "555" },
        },
      ],
    },
    [
      {
        simklId: 1001,
        category: "show",
        status: "watching",
        title: "Severance",
        ids: { simkl: 1001, imdb: "tt11280740", tmdb: "95396" },
      },
      {
        simklId: 2002,
        category: "show",
        status: "watching",
        title: "South Park",
        ids: { simkl: 2002, imdb: "tt0121955", tmdb: "2190" },
      },
      {
        simklId: 3002,
        category: "anime",
        status: "watching",
        title: "Dandadan Season 2",
        ids: { simkl: 3002, mal: "60002", kitsu: "9002", imdb: "tt30217403", tmdb: "240411" },
      },
      {
        simklId: 4001,
        category: "movie",
        status: "plantowatch",
        title: "Dune: Messiah",
        ids: { simkl: 4001, imdb: "tt15239678", tmdb: "555" },
      },
    ],
  );

  assert.equal(items.length, 4);
  const byId = new Map(items.map((i) => [i.id, i]));

  const sev = byId.get("tt11280740:2:4");
  assert.ok(sev);
  assert.equal(sev.name, "Severance S02E04: Woe's Hollow");
  assert.equal(sev.isAnime, false);
  assert.ok(sev.releaseTime);

  const sp = byId.get("tt0121955:29:2");
  assert.ok(sp);
  assert.equal(sp.name, "South Park S29E02");
  assert.equal(sp.isAnime, true);

  const ddd = byId.get("mal:60002:1:3");
  assert.ok(ddd);
  assert.equal(ddd.name, "Dandadan Season 2 S01E03: Turbo Granny Returns");
  assert.equal(ddd.isAnime, true);

  const dune = byId.get("tt15239678");
  assert.ok(dune);
  assert.equal(dune.type, "movie");
  assert.equal(dune.name, "Dune: Messiah");
});
