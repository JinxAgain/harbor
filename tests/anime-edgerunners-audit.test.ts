// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { buildKitsuEpisodes } from "../src/lib/providers/anime-episode-build.ts";
import { isDerivedAnimeFormat, isFranchiseExtra } from "../src/lib/providers/anime-format.ts";
import { franchiseKey } from "../src/lib/anilist/franchise-dedupe.ts";
import { mapSeasonToEntry } from "../src/views/detail/anime-episodes/anime-season-art.ts";

test("buildKitsuEpisodes backfills kitsu streamId when addonMeta is missing or empty", () => {
  const raw = [
    {
      id: 384880,
      number: 1,
      seasonNumber: 1,
      title: "Last Chance for a Slow Dance",
      synopsis: "",
      thumbnail: null,
      airdate: "2026-10-20",
      length: 28,
    },
    {
      id: 384882,
      number: 3,
      seasonNumber: 1,
      title: "0+2=1",
      synopsis: "",
      thumbnail: null,
      airdate: "2026-10-20",
      length: 28,
    },
  ];
  const built = buildKitsuEpisodes(null, raw, 50016);
  assert.equal(built.length, 2);
  assert.equal(built[0].streamId, "kitsu:50016:1");
  assert.equal(built[1].streamId, "kitsu:50016:3");
});

test("ONA series are not treated as derived anime formats or side-format exclusions", () => {
  assert.equal(isDerivedAnimeFormat("ONA"), false);
  assert.equal(isDerivedAnimeFormat("OVA"), true);
  assert.equal(isDerivedAnimeFormat("SPECIAL"), true);

  const franchise = [
    {
      meta: { id: "kitsu:43248", type: "series" as const, name: "Cyberpunk: Edgerunners", background: "s1.jpg" },
      year: 2022,
      startDate: "2022-09-13",
      episodeCount: 10,
      subtype: "ONA",
      isCurrent: true,
      isUpcoming: false,
    },
    {
      meta: { id: "kitsu:50016", type: "series" as const, name: "Cyberpunk: Edgerunners II", background: "s2.jpg" },
      year: 2026,
      startDate: "2026-10-20",
      episodeCount: 10,
      subtype: "ONA",
      isCurrent: false,
      isUpcoming: false,
    },
  ];
  const matched = mapSeasonToEntry({ from: "2026-10-20", year: "2026" }, franchise, "kitsu:43248");
  assert.equal(matched?.meta.id, "kitsu:50016");
});

test("multi-episode ONA seasons are kept while side stories, OVAs, and 0-ep entries are extras", () => {
  const detailSrc = readFileSync(
    new URL("../src/lib/providers/anime-detail.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(detailSrc, /SHORT_SUBTYPES\s*=\s*new Set\(\[[^\]]*"ona"/);
  assert.doesNotMatch(detailSrc, /SIDE_ENTRY_SUBTYPES\s*=\s*new Set\(\[[^\]]*"ona"/);

  // Main multi-episode ONA season (e.g. Cyberpunk: Edgerunners II) -> NOT an extra
  assert.equal(
    isFranchiseExtra({
      meta: { id: "kitsu:50016", type: "series", name: "Cyberpunk: Edgerunners II" },
      year: 2026,
      startDate: "2026-10-20",
      episodeCount: 10,
      subtype: "ONA",
      isCurrent: false,
      isUpcoming: false,
    }),
    false,
  );

  // Side-story ONA mini-anime (e.g. Sousou no Frieren: ●● no Mahou) -> extra
  assert.equal(
    isFranchiseExtra({
      meta: { id: "anilist:170000", type: "series", name: "Sousou no Frieren: ●● no Mahou" },
      year: 2023,
      startDate: "2023-10-11",
      episodeCount: 12,
      subtype: "ONA",
      isCurrent: false,
      isUpcoming: false,
      isSideStory: true,
    }),
    true,
  );

  // Donghua / web OVA tagged as ONA subtype (e.g. The Outcast OVA, 2 eps) -> extra
  assert.equal(
    isFranchiseExtra({
      meta: { id: "kitsu:41000", type: "series", name: "The Outcast OVA" },
      year: 2018,
      startDate: "2018-01-01",
      episodeCount: 2,
      subtype: "ONA",
      isCurrent: false,
      isUpcoming: false,
    }),
    true,
  );

  // 0-episode / unknown-episode past entry -> extra
  assert.equal(
    isFranchiseExtra({
      meta: { id: "anilist:180000", type: "series", name: "Cyberpunk: Edgerunners MADNESS" },
      year: 2024,
      startDate: "2024-01-01",
      episodeCount: undefined,
      subtype: undefined,
      isCurrent: false,
      isUpcoming: false,
    }),
    true,
  );
});

test("getAnimeEpisodes falls back to Kitsu API when anime-kitsu addon has no videos", () => {
  const seriesSrc = readFileSync(
    new URL("../src/lib/series-episodes.ts", import.meta.url),
    "utf8",
  );
  assert.match(seriesSrc, /kitsuEpisodes\(kitsuId,\s*100\)/);
  assert.match(seriesSrc, /const byKey = \(eps \?\? \[\]\)\.filter\(\(e\) => animeSeasonKey\(e\) === season\);/);
  assert.match(seriesSrc, /if \(byKey\.length > 0\) return byKey;/);
  assert.match(seriesSrc, /return \(eps \?\? \[\]\)\.filter\(\(e\) => e\.season === season\);/);
});

test("useSeasonBrowser aligns active season when fetched season list does not contain initial season", () => {
  const browserSrc = readFileSync(
    new URL("../src/components/player/episode-panel/use-season-browser.ts", import.meta.url),
    "utf8",
  );
  assert.match(browserSrc, /setSeason\(\(cur\) => \(s\.includes\(cur\) \? cur : s\[0\]\)\)/);
});

test("useAnimeFranchiseNav includes franchiseNav entries in pickerItems without duplicating multi-season order", () => {
  const navSrc = readFileSync(
    new URL("../src/views/detail/anime-episodes/use-anime-franchise-nav.ts", import.meta.url),
    "utf8",
  );
  assert.match(navSrc, /return \[\.\.\.order\.items,\s*\.\.\.extras\];/);
});

test("AniList franchise dedupe and relations handle trailing Arabic/Roman sequel numbers and filter non-ANIME edges", () => {
  const s1 = franchiseKey({
    id: 120377,
    title: { romaji: "Cyberpunk: Edgerunners", english: "Cyberpunk: Edgerunners", native: null },
    coverImage: {},
  });
  const s2 = franchiseKey({
    id: 195539,
    title: { romaji: "Cyberpunk: Edgerunners 2", english: "Cyberpunk: Edgerunners 2", native: null },
    coverImage: {},
  });
  assert.equal(s1, s2);

  // Colon-free titles exercise trailing Roman and Arabic numeral stripping directly
  const mob2Roman = franchiseKey({
    id: 101728,
    title: { romaji: "Mob Psycho 100 II", english: "Mob Psycho 100 II", native: null },
    coverImage: {},
  });
  const mob2Arabic = franchiseKey({
    id: 101729,
    title: { romaji: "Mob Psycho 100 2", english: "Mob Psycho 100 2", native: null },
    coverImage: {},
  });
  const mob3Roman = franchiseKey({
    id: 140439,
    title: { romaji: "Mob Psycho 100 III", english: "Mob Psycho 100 III", native: null },
    coverImage: {},
  });
  assert.equal(mob2Roman, mob2Arabic);
  assert.equal(mob2Roman, mob3Roman);

  const relSrc = readFileSync(
    new URL("../src/lib/anilist/relations.ts", import.meta.url),
    "utf8",
  );
  assert.match(relSrc, /isSameFranchiseOther/);
  assert.match(relSrc, /nodeYear < e\.parentYear/);
  assert.match(relSrc, /if \(n\.type && n\.type !== "ANIME"\) continue;/);
  assert.match(relSrc, /if \(n\.format && !ANIME_FORMATS\.has\(n\.format\)\) continue;/);
});

test("anizip 404 responses use bounded negCache instead of permanent session cache", () => {
  const azSrc = readFileSync(
    new URL("../src/lib/providers/anizip.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(azSrc, /if \(res\.status === 404\) cache\.set\(query,\s*null\)/);
  assert.match(azSrc, /if \(!res\.ok\) \{\s*negCache\.set\(query,\s*Date\.now\(\)\);/);
});

test("player watched hook, big picture detail, and mobile detail wire anime episodes and trackers", () => {
  const pwSrc = readFileSync(
    new URL("../src/views/player/hooks/use-player-watched.ts", import.meta.url),
    "utf8",
  );
  assert.match(pwSrc, /setAnilistWatched\(new Set\(\)\);\s*if \(!enabled/);
  assert.match(pwSrc, /setMalWatched\(new Set\(\)\);\s*if \(!enabled/);
  assert.match(pwSrc, /animeSeriesFromStreamId\(ep\.kitsuStreamId\)/);
  assert.match(pwSrc, /ep\.imdbSeason,\s*ep\.imdbEpisode/);

  const bpSrc = readFileSync(
    new URL("../src/views/big-picture/use-bp-anime-detail.ts", import.meta.url),
    "utf8",
  );
  assert.match(bpSrc, /useFranchiseEpisodes\(/);
  assert.match(bpSrc, /panelPool,/);

  const mobileSrc = readFileSync(
    new URL("../src/views/mobile/mobile-detail/detail.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(mobileSrc, /const isSeries = !isAnime &&/);
  assert.match(mobileSrc, /full=\{effectiveFull\}/);
  assert.match(mobileSrc, /resolvePlayCoords/);

  const mobileEpSrc = readFileSync(
    new URL("../src/views/mobile/mobile-detail/episodes.tsx", import.meta.url),
    "utf8",
  );
  assert.match(mobileEpSrc, /intentSeason/);
});
