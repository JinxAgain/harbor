import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHomeRowCustomization,
  dedupeAgainstPinnedRows,
  hideRow,
  pinnedCatalogIdFromRowKey,
  pinnedRowKey,
  resetHomeRows,
  showRow,
  syncHomeRowsForCatalogPinChange,
  type HomeRowCustomization,
} from "../src/lib/home-customization";
import type { HomeRow } from "../src/views/home/home-types";

function makeRow(key: string, name = key, type: "movie" | "series" = "series"): HomeRow {
  return {
    key,
    type,
    name,
    metas: [{ id: `tt:${key}`, type, name: `${name} Item` }],
    page: 1,
    hasMore: false,
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
