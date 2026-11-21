import { useSyncExternalStore } from "react";
import { normalizeCatalogBase } from "./home-customization";

const KEY = "harbor.pinnedcatalogs.v1";
const CAP = 12;
const subs = new Set<() => void>();

export type PinnedSource = "catalog" | "anilist" | "simkl" | "mal";

export type PinnedCatalog = {
  id: string;
  source: PinnedSource;
  name: string;
  params: Record<string, string>;
};

export type PinnedCatalogTarget = {
  key: string;
  base: string;
  type: string;
  id: string;
  name?: string;
};

export type PinnedBuiltinTitle = {
  key: string;
  valueKey?: string;
};

const LIST_RAIL_TITLE_KEYS: Readonly<Record<string, string>> = {
  watching: "Watching",
  planning: "Plan to Watch",
  completed: "Completed",
  onhold: "On Hold",
  paused: "On Hold",
  dropped: "Dropped",
};

export function pinnedBuiltinTitle(
  source: PinnedSource,
  railKey: string | undefined,
): PinnedBuiltinTitle | null {
  if (!railKey) return null;
  if (source === "anilist") {
    if (railKey === "trending") return { key: "Trending on AniList" };
    if (railKey === "top100") return { key: "Top 100 on AniList" };
    if (railKey === "recommended") return { key: "Recommended for you" };
    const valueKey = LIST_RAIL_TITLE_KEYS[railKey];
    return valueKey ? { key: "Your AniList: {name}", valueKey } : null;
  }
  if (source === "mal") {
    const valueKey = LIST_RAIL_TITLE_KEYS[railKey];
    return valueKey ? { key: "Your MAL: {name}", valueKey } : null;
  }
  return null;
}

function httpCatalogHost(base: string | undefined): string | null {
  if (!base) return null;
  try {
    const u = new URL(base.trim());
    if (u.protocol === "http:" || u.protocol === "https:") {
      return u.host.toLowerCase();
    }
  } catch {
    // Custom extension schemes have no HTTP host; keep them isolated by normalized base.
  }
  return null;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function manifestIdPrefix(entry: PinnedCatalog): string | null {
  if (entry.source !== "catalog") return null;
  const { type, id } = entry.params;
  if (!type || !id) return null;
  const suffix = `-${type}-${id}`;
  if (!entry.id.endsWith(suffix) || entry.id.length <= suffix.length) return null;
  return entry.id.slice(0, entry.id.length - suffix.length);
}

/** Check whether a saved pinned entry refers to a catalog target (including drifted addon URLs/IDs). */
export function matchesPinnedCatalog(entry: PinnedCatalog, target: PinnedCatalogTarget): boolean {
  if (entry.id === target.key) return true;
  if (entry.source !== "catalog") return false;
  if (
    entry.params.base &&
    target.base &&
    entry.params.type === target.type &&
    entry.params.id === target.id &&
    normalizeCatalogBase(entry.params.base) === normalizeCatalogBase(target.base)
  ) {
    return true;
  }
  const entryHost = httpCatalogHost(entry.params.base);
  const targetHost = httpCatalogHost(target.base);
  if (entryHost && targetHost && entryHost === targetHost && entry.params.type === target.type) {
    if (entry.params.id && entry.params.id === target.id) return true;
    const normEntryName = normalizeName(entry.name);
    if (target.name && normEntryName && normEntryName === normalizeName(target.name)) {
      return true;
    }
  }
  return false;
}

function pinnedEntriesConflict(a: PinnedCatalog, b: PinnedCatalog): boolean {
  if (a.id === b.id) return true;
  if (a.source !== "catalog" || b.source !== "catalog") return false;
  if (
    a.params.base &&
    b.params.base &&
    a.params.type &&
    a.params.type === b.params.type &&
    a.params.id &&
    a.params.id === b.params.id &&
    normalizeCatalogBase(a.params.base) === normalizeCatalogBase(b.params.base)
  ) {
    return true;
  }
  const hostA = httpCatalogHost(a.params.base);
  const hostB = httpCatalogHost(b.params.base);
  if (hostA && hostB && hostA === hostB && a.params.type && a.params.type === b.params.type) {
    if (a.params.id && a.params.id === b.params.id) return true;
    const prefixA = manifestIdPrefix(a);
    const prefixB = manifestIdPrefix(b);
    const normA = normalizeName(a.name);
    if (prefixA !== null && prefixA === prefixB && normA && normA === normalizeName(b.name)) {
      return true;
    }
  }
  return false;
}

function samePinnedEntry(a: PinnedCatalog, b: PinnedCatalog): boolean {
  return (
    a.id === b.id &&
    a.source === b.source &&
    a.name === b.name &&
    a.params.base === b.params.base &&
    a.params.type === b.params.type &&
    a.params.id === b.params.id
  );
}

/** Collapse duplicate or reconfigured-addon pinned entries in place, keeping the newer entry. */
export function dedupePinnedCatalogEntries(entries: PinnedCatalog[]): PinnedCatalog[] {
  if (entries.length < 2) return entries;
  const out: PinnedCatalog[] = [];
  for (const entry of entries) {
    const idx = out.findIndex((existing) => pinnedEntriesConflict(existing, entry));
    if (idx >= 0) {
      out[idx] = entry;
    } else {
      out.push(entry);
    }
  }
  return out;
}

let cache: PinnedCatalog[] = load();

function load(): PinnedCatalog[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: PinnedCatalog[] = [];
    for (const el of arr) {
      if (!el || typeof el !== "object") continue;
      const e = el as Partial<PinnedCatalog>;
      if (typeof e.id !== "string" || typeof e.name !== "string") continue;
      if (
        e.source !== "catalog" &&
        e.source !== "anilist" &&
        e.source !== "simkl" &&
        e.source !== "mal"
      )
        continue;
      out.push({
        id: e.id,
        source: e.source,
        name: e.name,
        params:
          e.params && typeof e.params === "object" ? (e.params as Record<string, string>) : {},
      });
    }
    return dedupePinnedCatalogEntries(out).slice(0, CAP);
  } catch {
    return [];
  }
}

function commit(next: PinnedCatalog[]) {
  cache = dedupePinnedCatalogEntries(next).slice(0, CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {}
  for (const s of subs) s();
}

export function readPinnedCatalogs(): PinnedCatalog[] {
  return cache;
}

export function isPinned(id: string): boolean {
  return cache.some((c) => c.id === id);
}

/** Check whether any pinned entry matches the given catalog target (exact or drifted). */
export function isCatalogPinned(target: PinnedCatalogTarget): boolean {
  return cache.some((c) => matchesPinnedCatalog(c, target));
}

export function pinnedCount(): number {
  return cache.length;
}

export function pinCatalog(desc: PinnedCatalog): boolean {
  const idx = cache.findIndex((c) => pinnedEntriesConflict(c, desc));
  if (idx >= 0) {
    if (samePinnedEntry(cache[idx]!, desc)) return true;
    const next = cache.slice();
    next[idx] = desc;
    commit(next);
    return true;
  }
  if (cache.length >= CAP) return false;
  commit([...cache, desc]);
  return true;
}

export function unpinCatalog(id: string): void {
  if (!isPinned(id)) return;
  commit(cache.filter((c) => c.id !== id));
}

/** Remove every pinned entry matching a catalog target and return the removed ids. */
export function unpinMatchingCatalog(target: PinnedCatalogTarget): string[] {
  const removed = cache.filter((c) => matchesPinnedCatalog(c, target)).map((c) => c.id);
  if (removed.length === 0) return [];
  commit(cache.filter((c) => !matchesPinnedCatalog(c, target)));
  return removed;
}

export function togglePinnedCatalog(desc: PinnedCatalog): boolean {
  if (isPinned(desc.id)) {
    unpinCatalog(desc.id);
    return false;
  }
  return pinCatalog(desc);
}

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function usePinnedCatalogs(): PinnedCatalog[] {
  return useSyncExternalStore(subscribe, readPinnedCatalogs, readPinnedCatalogs);
}

export function useIsPinned(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isPinned(id),
    () => isPinned(id),
  );
}

/** Reactively check whether a catalog target is pinned (exact or drifted). */
export function useIsCatalogPinned(target: PinnedCatalogTarget): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isCatalogPinned(target),
    () => isCatalogPinned(target),
  );
}

export function isPinCapReached(): boolean {
  return cache.length >= CAP;
}

export const PINNED_CATALOGS_CAP = CAP;
