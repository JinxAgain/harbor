import type { HomeRow, HomeRowCatalogSource } from "@/views/home/home-types";
import type { SourceRow } from "./custom-sources";

export type HomeRowCustomization = {
  order: string[];
  hidden: string[];
  renamed: Record<string, string>;
  numerals: string[];
  heroSource: string | null;
  customSources: SourceRow[];
  listRows?: string[];
  playButtonSquare?: boolean;
  secondaryMoreInfo?: boolean;
  cwTop?: boolean;
};

export function applyHomeRowCustomization(
  rows: HomeRow[],
  custom: HomeRowCustomization,
  includeHidden = false,
): HomeRow[] {
  const seenInput = new Set<string>();
  const renamed: HomeRow[] = [];
  for (const r of rows) {
    if (seenInput.has(r.key)) continue;
    seenInput.add(r.key);
    if (!includeHidden && custom.hidden.includes(r.key)) continue;
    renamed.push({
      ...r,
      name: custom.renamed[r.key] ?? r.name,
    });
  }
  if (custom.order.length === 0) return renamed;
  const byKey = new Map(renamed.map((r) => [r.key, r]));
  const emitted = new Set<string>();
  const ordered: HomeRow[] = [];
  for (const k of custom.order) {
    if (emitted.has(k)) continue;
    const r = byKey.get(k);
    if (r) {
      emitted.add(k);
      ordered.push(r);
    }
  }
  for (const r of renamed) {
    if (emitted.has(r.key)) continue;
    emitted.add(r.key);
    ordered.push(r);
  }
  return ordered;
}

export function isRowHidden(custom: HomeRowCustomization, key: string): boolean {
  return custom.hidden.includes(key);
}

export function effectiveOrder(rows: HomeRow[], custom: HomeRowCustomization): string[] {
  const live = rows.map((r) => r.key);
  const liveSet = new Set(live);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of custom.order) {
    if (liveSet.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  for (const k of live) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

export function moveRow(
  custom: HomeRowCustomization,
  rows: HomeRow[],
  key: string,
  delta: -1 | 1,
): HomeRowCustomization {
  const order = effectiveOrder(rows, custom);
  const idx = order.indexOf(key);
  if (idx < 0) return custom;
  const target = idx + delta;
  if (target < 0 || target >= order.length) return custom;
  const next = order.slice();
  [next[idx], next[target]] = [next[target], next[idx]];
  return { ...custom, order: next };
}

export const PINNED_ROW_PREFIX = "pinned:";

/** Build the Home row key used for a catalog or tracker rail pinned to Home. */
export function pinnedRowKey(id: string): string {
  return `${PINNED_ROW_PREFIX}${id}`;
}

/** Extract the underlying catalog/rail id from a pinned Home row key, or null. */
export function pinnedCatalogIdFromRowKey(rowKey: string): string | null {
  return rowKey.startsWith(PINNED_ROW_PREFIX)
    ? rowKey.slice(PINNED_ROW_PREFIX.length)
    : null;
}

/** Normalize an addon or extension catalog base URL into a canonical comparison string. */
export function normalizeCatalogBase(base: string): string {
  const stripped = base
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/manifest\.json$/i, "")
    .replace(/\/+$/, "");
  try {
    const u = new URL(stripped);
    if (u.protocol === "http:" || u.protocol === "https:") {
      const pathname = u.pathname
        .replace(/\/+$/, "")
        .replace(/\/manifest\.json$/i, "")
        .replace(/\/+$/, "");
      return `${u.protocol}//${u.host.toLowerCase()}${pathname}${u.search}`;
    }
  } catch {
    // Preserve non-URL or custom-scheme bases (such as extension catalogue bases) as trimmed text.
  }
  return stripped;
}

/** Build a canonical source key for a catalog HomeRow, or null when metadata is incomplete. */
export function catalogSourceKey(source?: HomeRowCatalogSource | null): string | null {
  if (!source?.base || !source?.type || !source?.id) return null;
  return `${normalizeCatalogBase(source.base)}|${source.type}|${source.id}`;
}

function normalizeRowTitle(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractUniqueMetaIds(metas: HomeRow["metas"], limit: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of metas) {
    if (typeof m.id !== "string" || m.id.length === 0 || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m.id);
    if (out.length >= limit) break;
  }
  return out;
}

function sameCatalogContent(
  a: HomeRow,
  b: HomeRow,
  opts?: { allowTypeSuffix?: boolean },
): boolean {
  if ((a.catalogSource == null && a.fetcher == null) || (b.catalogSource == null && b.fetcher == null)) {
    return false;
  }
  const titleA = normalizeRowTitle(a.name);
  const titleB = normalizeRowTitle(b.name);
  if (!titleA || !titleB) return false;
  const titleMatches =
    titleA === titleB ||
    (Boolean(opts?.allowTypeSuffix) &&
      (titleB.startsWith(`${titleA}:`) || titleA.startsWith(`${titleB}:`)));
  if (!titleMatches) return false;

  const idsA = extractUniqueMetaIds(a.metas, 20);
  const idsB = extractUniqueMetaIds(b.metas, 20);
  const headA = idsA.slice(0, 10);
  const headB = idsB.slice(0, 10);
  if (headA.length === 0 || headB.length === 0) return false;

  const poolA = new Set(idsA);
  const poolB = new Set(idsB);
  const shorter = Math.min(headA.length, headB.length);
  if (shorter < 3) {
    return headA.length === headB.length && headA.every((id) => poolB.has(id));
  }
  const hitsA = headA.filter((id) => poolB.has(id)).length;
  const hitsB = headB.filter((id) => poolA.has(id)).length;
  return hitsA / headA.length >= 0.8 || hitsB / headB.length >= 0.8;
}

function areEquivalentCatalogRows(pinnedRow: HomeRow, candidate: HomeRow): boolean {
  if (pinnedRow.key === candidate.key) return true;
  if (pinnedCatalogIdFromRowKey(pinnedRow.key) === candidate.key) return true;
  if (pinnedCatalogIdFromRowKey(candidate.key) === pinnedRow.key) return true;
  const srcA = catalogSourceKey(pinnedRow.catalogSource);
  const srcB = catalogSourceKey(candidate.catalogSource);
  if (srcA !== null && srcA === srcB) return true;
  return sameCatalogContent(pinnedRow, candidate, { allowTypeSuffix: true });
}

/** Collapse duplicate or drifted pinned rows so fresher entries supersede older ones in place. */
export function dedupePinnedRows(pinnedRows: HomeRow[]): HomeRow[] {
  if (pinnedRows.length < 2) return pinnedRows;
  const out: HomeRow[] = [];
  for (const row of pinnedRows) {
    const idx = out.findIndex((existing) => areEquivalentCatalogRows(existing, row));
    if (idx >= 0) {
      out[idx] = row;
    } else {
      out.push(row);
    }
  }
  return out;
}

/** Drop auto-loaded rows already represented in `pinnedRows` by key, source, or catalog content. */
export function dedupeAgainstPinnedRows(
  rows: HomeRow[],
  pinnedRows: HomeRow[],
): HomeRow[] {
  if (pinnedRows.length === 0 || rows.length === 0) return rows;
  const shadowed = new Set<string>();
  const shadowedSources = new Set<string>();
  for (const row of pinnedRows) {
    shadowed.add(row.key);
    const catalogId = pinnedCatalogIdFromRowKey(row.key);
    if (catalogId) shadowed.add(catalogId);
    const sourceKey = catalogSourceKey(row.catalogSource);
    if (sourceKey) shadowedSources.add(sourceKey);
  }
  return rows.filter((row) => {
    if (shadowed.has(row.key)) return false;
    const sourceKey = catalogSourceKey(row.catalogSource);
    if (sourceKey && shadowedSources.has(sourceKey)) return false;
    return !pinnedRows.some((pinned) =>
      sameCatalogContent(pinned, row, { allowTypeSuffix: true }),
    );
  });
}

export function hideRow(custom: HomeRowCustomization, key: string): HomeRowCustomization {
  if (custom.hidden.includes(key)) return custom;
  return { ...custom, hidden: [...custom.hidden, key] };
}

export function showRow(custom: HomeRowCustomization, key: string): HomeRowCustomization {
  if (!custom.hidden.includes(key)) return custom;
  return { ...custom, hidden: custom.hidden.filter((k) => k !== key) };
}

export function toggleRowHidden(custom: HomeRowCustomization, key: string): HomeRowCustomization {
  return custom.hidden.includes(key) ? showRow(custom, key) : hideRow(custom, key);
}

/** Keep Home row visibility synchronized when pinning or removing a catalog from Home. */
export function syncHomeRowsForCatalogPinChange(
  custom: HomeRowCustomization,
  catalogKey: string,
  action: "added" | "removed",
  opts: { hideAutoLoadedOnRemove?: boolean } = {},
): HomeRowCustomization {
  if (action === "added") {
    return showRow(custom, pinnedRowKey(catalogKey));
  }
  // Auto-loaded Stremio addon catalogs render on Home even when unpinned, so removing
  // one from Home must also hide its auto-loaded row key.
  if (opts.hideAutoLoadedOnRemove === false) return custom;
  return hideRow(custom, catalogKey);
}

export function renameRow(
  custom: HomeRowCustomization,
  key: string,
  label: string,
): HomeRowCustomization {
  const trimmed = label.trim();
  const renamed = { ...custom.renamed };
  if (!trimmed) {
    delete renamed[key];
  } else {
    renamed[key] = trimmed;
  }
  return { ...custom, renamed };
}

export function toggleRowNumerals(
  custom: HomeRowCustomization,
  key: string,
): HomeRowCustomization {
  const cur = custom.numerals ?? [];
  const has = cur.includes(key);
  return { ...custom, numerals: has ? cur.filter((k) => k !== key) : [...cur, key] };
}

export function toggleHeroSource(
  custom: HomeRowCustomization,
  key: string,
): HomeRowCustomization {
  return { ...custom, heroSource: custom.heroSource === key ? null : key };
}

export function togglePlayButtonSquare(custom: HomeRowCustomization): HomeRowCustomization {
  return { ...custom, playButtonSquare: !custom.playButtonSquare };
}

export function toggleSecondaryMoreInfo(custom: HomeRowCustomization): HomeRowCustomization {
  return { ...custom, secondaryMoreInfo: !custom.secondaryMoreInfo };
}

export function toggleCwTop(custom: HomeRowCustomization): HomeRowCustomization {
  return { ...custom, cwTop: !custom.cwTop };
}

export function addListRow(custom: HomeRowCustomization, listId: string): HomeRowCustomization {
  const cur = custom.listRows ?? [];
  if (cur.includes(listId)) return custom;
  return { ...custom, listRows: [...cur, listId] };
}

export function removeListRow(custom: HomeRowCustomization, listId: string): HomeRowCustomization {
  const cur = custom.listRows ?? [];
  return { ...custom, listRows: cur.filter((id) => id !== listId) };
}

export function resetHomeRows(): HomeRowCustomization {
  return { order: [], hidden: [], renamed: {}, numerals: [], heroSource: null, customSources: [], listRows: [], playButtonSquare: false, secondaryMoreInfo: false, cwTop: false };
}
