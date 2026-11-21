import assert from "node:assert/strict";
import test from "node:test";
import "./_localstorage-stub";
import {
  applyHomeRowCustomization,
  catalogSourceKey,
  dedupeAgainstPinnedRows,
  dedupePinnedRows,
  effectiveOrder,
  hideRow,
  moveRow,
  normalizeCatalogBase,
  pinnedCatalogIdFromRowKey,
  pinnedRowKey,
  resetHomeRows,
  showRow,
  syncHomeRowsForCatalogPinChange,
  type HomeRowCustomization,
} from "../src/lib/home-customization";
import type { HomeRow, HomeRowCatalogSource } from "../src/views/home/home-types";

function makeRow(
  key: string,
  name = key,
  type: "movie" | "series" = "series",
  opts: {
    metaIds?: string[];
    catalogSource?: HomeRowCatalogSource;
    hasFetcher?: boolean;
  } = {},
): HomeRow {
  const metaIds = opts.metaIds ?? [`tt:${key}`];
  return {
    key,
    type,
    name,
    metas: metaIds.map((id, i) => ({ id, type, name: `${name} Item ${i + 1}` })),
    page: 1,
    hasMore: false,
    ...(opts.catalogSource ? { catalogSource: opts.catalogSource } : null),
    ...(opts.hasFetcher ? { fetcher: async () => [] } : null),
  };
}

test("pinnedRowKey and pinnedCatalogIdFromRowKey round-trip catalog keys", () => {
  const catalogKey = "community.trakt.tv-trakt-latest_releases";
  const rowKey = pinnedRowKey(catalogKey);
  assert.equal(rowKey, `pinned:${catalogKey}`);
  assert.equal(pinnedCatalogIdFromRowKey(rowKey), catalogKey);
  assert.equal(pinnedCatalogIdFromRowKey(catalogKey), null);
  assert.equal(pinnedCatalogIdFromRowKey("tmdb-trending-movies"), null);
});

test("dedupeAgainstPinnedRows drops auto-loaded addon rows shadowed by pinned rows", () => {
  const catalogKey = "community.trakt.tv-trakt-latest_releases";
  const autoLoaded = makeRow(catalogKey, "Latest Releases");
  const unrelatedAddon = makeRow("cinemeta-movie-top", "Popular Movies", "movie");
  const pinnedRows = [
    makeRow(pinnedRowKey(catalogKey), "Latest Releases"),
    makeRow(pinnedRowKey("anilist:trending"), "Trending on AniList"),
  ];

  const deduped = dedupeAgainstPinnedRows([autoLoaded, unrelatedAddon], pinnedRows);
  assert.deepEqual(
    deduped.map((r) => r.key),
    ["cinemeta-movie-top"],
  );
});

test("dedupeAgainstPinnedRows keeps rows when no matching pinned row exists", () => {
  const autoLoaded = makeRow("community.trakt.tv-trakt-latest_releases", "Latest Releases");
  const other = makeRow("tmdb-popular-movies", "Popular Movies", "movie");

  assert.deepEqual(
    dedupeAgainstPinnedRows([autoLoaded, other], []).map((r) => r.key),
    [autoLoaded.key, other.key],
  );
  assert.deepEqual(
    dedupeAgainstPinnedRows([autoLoaded, other], [makeRow(pinnedRowKey("anilist:top100"))]).map(
      (r) => r.key,
    ),
    [autoLoaded.key, other.key],
  );
});

test("dedupeAgainstPinnedRows prevents duplicates in applyHomeRowCustomization even with custom order or hidden pinned row", () => {
  const catalogKey = "community.trakt.tv-trakt-latest_releases";
  const pinnedRow = makeRow(pinnedRowKey(catalogKey), "Latest Releases");
  const autoRow = makeRow(catalogKey, "Latest Releases");
  const otherRow = makeRow("tmdb-trending-movies", "Trending This Week", "movie");

  const customWithOrder: HomeRowCustomization = {
    ...resetHomeRows(),
    order: ["tmdb-trending-movies"],
  };
  const visible = applyHomeRowCustomization(
    [pinnedRow, ...dedupeAgainstPinnedRows([autoRow, otherRow], [pinnedRow])],
    customWithOrder,
    false,
  );
  assert.deepEqual(
    visible.map((r) => r.key),
    ["tmdb-trending-movies", pinnedRowKey(catalogKey)],
  );

  const customWithPinnedHidden: HomeRowCustomization = hideRow(customWithOrder, pinnedRow.key);
  const visibleWhenHidden = applyHomeRowCustomization(
    [pinnedRow, ...dedupeAgainstPinnedRows([autoRow, otherRow], [pinnedRow])],
    customWithPinnedHidden,
    false,
  );
  assert.deepEqual(
    visibleWhenHidden.map((r) => r.key),
    ["tmdb-trending-movies"],
  );
});

test("hideRow and showRow update hidden list immutably and stay idempotent", () => {
  const base = resetHomeRows();
  const key = "community.trakt.tv-trakt-latest_releases";

  assert.equal(showRow(base, key), base);

  const hidden = hideRow(base, key);
  assert.notEqual(hidden, base);
  assert.deepEqual(hidden.hidden, [key]);
  assert.equal(hideRow(hidden, key), hidden);

  const shown = showRow(hidden, key);
  assert.notEqual(shown, hidden);
  assert.deepEqual(shown.hidden, []);
});

test("syncHomeRowsForCatalogPinChange hides auto-loaded addon rows on remove and unhides pinned row on add", () => {
  const catalogKey = "community.trakt.tv-trakt-latest_releases";
  const base = resetHomeRows();

  const afterRemove = syncHomeRowsForCatalogPinChange(base, catalogKey, "removed");
  assert.deepEqual(afterRemove.hidden, [catalogKey]);

  const extensionAfterRemove = syncHomeRowsForCatalogPinChange(base, catalogKey, "removed", {
    hideAutoLoadedOnRemove: false,
  });
  assert.equal(extensionAfterRemove, base);

  const withHiddenPinned = hideRow(afterRemove, pinnedRowKey(catalogKey));
  const afterAdd = syncHomeRowsForCatalogPinChange(withHiddenPinned, catalogKey, "added");
  assert.equal(afterAdd.hidden.includes(pinnedRowKey(catalogKey)), false);
  assert.equal(afterAdd.hidden.includes(catalogKey), true);

  assert.equal(syncHomeRowsForCatalogPinChange(afterAdd, catalogKey, "added"), afterAdd);
});

test("full add/remove/re-add lifecycle keeps Home showing 1 -> 1 -> 0 -> 1 row", () => {
  const catalogKey = "community.trakt.tv-trakt-latest_releases";
  const autoRow = makeRow(catalogKey, "Latest Releases");
  const pinnedRow = makeRow(pinnedRowKey(catalogKey), "Latest Releases");
  let custom = resetHomeRows();

  const renderHome = (pinnedRows: HomeRow[], c: HomeRowCustomization) => {
    const rest = dedupeAgainstPinnedRows([autoRow], pinnedRows);
    return applyHomeRowCustomization([...pinnedRows, ...rest], c, false).map((r) => r.key);
  };

  // 1. Before pinning: auto-loaded row renders once.
  assert.deepEqual(renderHome([], custom), [catalogKey]);

  // 2. Pin catalog to Home: pinned row replaces auto-loaded row, still renders once.
  custom = syncHomeRowsForCatalogPinChange(custom, catalogKey, "added");
  assert.deepEqual(renderHome([pinnedRow], custom), [pinnedRow.key]);

  // 3. Remove from Home in Catalogs: auto-loaded row is hidden, so 0 rows remain.
  custom = syncHomeRowsForCatalogPinChange(custom, catalogKey, "removed");
  assert.deepEqual(renderHome([], custom), []);

  // 4. Re-add to Home in Catalogs: pinned row is shown again, renders once.
  custom = syncHomeRowsForCatalogPinChange(custom, catalogKey, "added");
  assert.deepEqual(renderHome([pinnedRow], custom), [pinnedRow.key]);
});

test("applyHomeRowCustomization deduplicates duplicate keys in custom.order and input rows", () => {
  const rowA = makeRow("pinned:latest", "Latest Releases");
  const rowB = makeRow("tmdb-trending-movies", "Trending", "movie");
  const rowDuplicate = makeRow("tmdb-trending-movies", "Trending", "movie");

  const emptyOrder = applyHomeRowCustomization(
    [rowA, rowB, makeRow("pinned:latest", "Latest Releases Duplicate"), rowDuplicate],
    resetHomeRows(),
    false,
  );
  assert.deepEqual(
    emptyOrder.map((r) => r.key),
    ["pinned:latest", "tmdb-trending-movies"],
  );

  const duplicateOrder: HomeRowCustomization = {
    ...resetHomeRows(),
    order: ["pinned:latest", "pinned:latest", "tmdb-trending-movies", "pinned:latest"],
  };
  const withOrder = applyHomeRowCustomization([rowA, rowB, rowDuplicate], duplicateOrder, false);
  assert.deepEqual(
    withOrder.map((r) => r.key),
    ["pinned:latest", "tmdb-trending-movies"],
  );

  const omitFromOrder = applyHomeRowCustomization(
    [rowA, rowB, rowDuplicate],
    { ...resetHomeRows(), order: ["pinned:latest"] },
    false,
  );
  assert.deepEqual(
    omitFromOrder.map((r) => r.key),
    ["pinned:latest", "tmdb-trending-movies"],
  );
});

test("effectiveOrder and moveRow deduplicate duplicate keys in custom.order and rows", () => {
  const rowA = makeRow("pinned:latest", "Latest Releases");
  const rowB = makeRow("tmdb-trending-movies", "Trending", "movie");
  const custom: HomeRowCustomization = {
    ...resetHomeRows(),
    order: ["pinned:latest", "pinned:latest", "tmdb-trending-movies"],
  };

  assert.deepEqual(effectiveOrder([rowA, rowB, rowB], custom), [
    "pinned:latest",
    "tmdb-trending-movies",
  ]);

  const moved = moveRow(custom, [rowA, rowB, rowB], "tmdb-trending-movies", -1);
  assert.deepEqual(moved.order, ["tmdb-trending-movies", "pinned:latest"]);
});

test("normalizeCatalogBase and catalogSourceKey normalize HTTP URLs without corrupting extension bases", () => {
  assert.equal(
    normalizeCatalogBase("https://2ECBBD610840-Trakt.Baby-Beamup.Club/cfg123/manifest.json/"),
    "https://2ecbbd610840-trakt.baby-beamup.club/cfg123",
  );
  assert.equal(
    normalizeCatalogBase("  HTTP://LocalHost:7000/Config/MANIFEST.JSON  "),
    "http://localhost:7000/Config",
  );
  assert.equal(normalizeCatalogBase("harbor-ext://MyPlugin/ProviderA/"), "harbor-ext://MyPlugin/ProviderA");
  assert.equal(
    catalogSourceKey({
      base: "https://2ecbbd610840-trakt.baby-beamup.club/cfg1/manifest.json",
      type: "trakt",
      id: "trakt_latest_releases",
    }),
    "https://2ecbbd610840-trakt.baby-beamup.club/cfg1|trakt|trakt_latest_releases",
  );
  assert.equal(catalogSourceKey(null), null);
});

test("dedupeAgainstPinnedRows matches drifted keys by catalogSource and catalog content overlap", () => {
  const ids10 = Array.from({ length: 10 }, (_, i) => `tt100${i}`);
  const pinnedBySource = makeRow("pinned:old-trakt-key", "Latest Releases", "movie", {
    metaIds: ["tt1", "tt2"],
    catalogSource: {
      base: "https://trakt.example/cfg1/manifest.json",
      type: "trakt",
      id: "latest_releases",
    },
  });
  const autoDifferentKeySameSource = makeRow("new-trakt-key", "Latest Releases", "movie", {
    metaIds: ["tt3", "tt4"],
    catalogSource: {
      base: "https://TRAKT.example/cfg1/",
      type: "trakt",
      id: "latest_releases",
    },
  });

  // Same content (>= 80% overlap, 1-item skew) and mergeRows `: Movies` suffix
  const pinnedByContent = makeRow("pinned:old-latest", "Latest Releases", "movie", {
    metaIds: ids10,
    hasFetcher: true,
  });
  const skewedIds = ["tt_new", ...ids10.slice(0, 9)];
  const autoDifferentSourceSameContent = makeRow("trakt-drifted", "Latest Releases: Movies", "movie", {
    metaIds: skewedIds,
    catalogSource: {
      base: "https://trakt.example/cfg2",
      type: "trakt",
      id: "drifted_latest",
    },
  });

  // Distinct catalog that happens to share a generic name
  const tmdbPopular = makeRow("tmdb-popular-movies", "Popular Movies", "movie", {
    metaIds: Array.from({ length: 10 }, (_, i) => `tmdb:movie:${i}`),
    hasFetcher: true,
  });
  const traktPopularPinned = makeRow("pinned:trakt-popular", "Popular Movies", "movie", {
    metaIds: ids10,
    hasFetcher: true,
  });

  // Non-catalog curated row with no fetcher and no catalogSource should not match by content
  const nonCatalogSameTitle = makeRow("curated-latest", "Latest Releases", "movie", {
    metaIds: ids10,
  });

  const remaining = dedupeAgainstPinnedRows(
    [
      autoDifferentKeySameSource,
      autoDifferentSourceSameContent,
      tmdbPopular,
      nonCatalogSameTitle,
    ],
    [pinnedBySource, pinnedByContent, traktPopularPinned],
  );
  assert.deepEqual(
    remaining.map((r) => r.key),
    ["tmdb-popular-movies", "curated-latest"],
  );
});

test("dedupePinnedRows collapses duplicate or drifted pinned rows and prefers newer entry in earlier slot", () => {
  const sharedIds = Array.from({ length: 10 }, (_, i) => `tt200${i}`);
  const stalePinned = makeRow("pinned:old-latest", "Latest Releases", "movie", {
    metaIds: sharedIds,
    catalogSource: {
      base: "https://trakt.example/cfg1",
      type: "trakt",
      id: "latest_old",
    },
  });
  const otherPinned = makeRow("pinned:anilist:trending", "Trending on AniList", "series", {
    metaIds: ["anilist:1", "anilist:2"],
    hasFetcher: true,
  });
  const freshPinned = makeRow("pinned:new-latest", "Latest Releases", "movie", {
    metaIds: sharedIds,
    catalogSource: {
      base: "https://trakt.example/cfg2",
      type: "trakt",
      id: "latest_new",
    },
  });

  const collapsed = dedupePinnedRows([stalePinned, otherPinned, freshPinned]);
  assert.deepEqual(
    collapsed.map((r) => r.key),
    ["pinned:new-latest", "pinned:anilist:trending"],
  );
});

test("pinned-catalogs deduplicates persisted entries on startup load, handles drifted reconfig pins, and unpins matching entries", async () => {
  localStorage.clear();
  localStorage.setItem(
    "harbor.pinnedcatalogs.v1",
    JSON.stringify([
      {
        id: "community.trakt.tv-trakt-latest_old",
        source: "catalog",
        name: "Latest Releases",
        params: {
          base: "https://2ecbbd610840-trakt.baby-beamup.club/cfgA",
          type: "trakt",
          id: "latest_old",
        },
      },
      {
        id: "community.trakt.tv-trakt-latest_new",
        source: "catalog",
        name: "Latest Releases",
        params: {
          base: "https://2ecbbd610840-trakt.baby-beamup.club/cfgB",
          type: "trakt",
          id: "latest_new",
        },
      },
      {
        id: "ext.plugin-provA-Latest Releases",
        source: "catalog",
        name: "Latest Releases",
        params: {
          base: "harbor-ext://ext.plugin/provA",
          type: "movie",
          id: "Latest Releases",
        },
      },
      {
        id: "ext.plugin-provB-Latest Releases",
        source: "catalog",
        name: "Latest Releases",
        params: {
          base: "harbor-ext://ext.plugin/provB",
          type: "movie",
          id: "Latest Releases",
        },
      },
    ]),
  );

  const pinnedMod = await import("../src/lib/pinned-catalogs");

  // Startup load() collapsed the reconfigured Trakt entries while keeping distinct extension providers
  assert.deepEqual(
    pinnedMod.readPinnedCatalogs().map((c) => c.id),
    [
      "community.trakt.tv-trakt-latest_new",
      "ext.plugin-provA-Latest Releases",
      "ext.plugin-provB-Latest Releases",
    ],
  );

  // Drifted target on same HTTP host + type + name matches even with another config path and id
  const driftedTarget = {
    key: "community.trakt.tv-trakt-latest_v3",
    base: "https://2ecbbd610840-trakt.baby-beamup.club/cfgC",
    type: "trakt",
    id: "latest_v3",
    name: "Latest Releases",
  };
  assert.equal(pinnedMod.isCatalogPinned(driftedTarget), true);

  // Extension providers remain isolated by normalized base
  assert.equal(
    pinnedMod.matchesPinnedCatalog(pinnedMod.readPinnedCatalogs()[1]!, {
      key: "ext.plugin-provC-Latest Releases",
      base: "harbor-ext://ext.plugin/provC",
      type: "movie",
      id: "Latest Releases",
      name: "Latest Releases",
    }),
    false,
  );

  // pinCatalog updates conflicting slot in-place rather than adding a duplicate
  assert.equal(
    pinnedMod.pinCatalog({
      id: "community.trakt.tv-trakt-latest_v3",
      source: "catalog",
      name: "Latest Releases",
      params: {
        base: "https://2ecbbd610840-trakt.baby-beamup.club/cfgC",
        type: "trakt",
        id: "latest_v3",
      },
    }),
    true,
  );
  assert.deepEqual(
    pinnedMod.readPinnedCatalogs().map((c) => c.id),
    [
      "community.trakt.tv-trakt-latest_v3",
      "ext.plugin-provA-Latest Releases",
      "ext.plugin-provB-Latest Releases",
    ],
  );

  // unpinMatchingCatalog removes drifted entry and reports removed id(s)
  const removed = pinnedMod.unpinMatchingCatalog({
    key: "community.trakt.tv-trakt-latest_v4",
    base: "https://2ecbbd610840-trakt.baby-beamup.club/cfgD",
    type: "trakt",
    id: "latest_v4",
    name: "Latest Releases",
  });
  assert.deepEqual(removed, ["community.trakt.tv-trakt-latest_v3"]);
  assert.equal(pinnedMod.isCatalogPinned(driftedTarget), false);
});
