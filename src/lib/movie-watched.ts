import { persistCritical } from "./storage-recovery";

const KEY_PREFIX = "harbor.moviewatched.v1.";
const LEGACY_KEY = "harbor.moviewatched.v1";
const AT_KEY_PREFIX = "harbor.moviewatched.at.v1.";
const AT_LEGACY_KEY = "harbor.moviewatched.at.v1";
const PROFILES_KEY = "harbor.profiles.v1";
const COMPLETION_ECHO_MS = 60_000;

const subs = new Set<() => void>();
let version = 0;
let cache: Set<string> | null = null;
let atCache: Record<string, number> | null = null;

function activeProfileId(): string {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    if (!raw) return "";
    const s = JSON.parse(raw) as {
      activeId?: string;
      profiles?: Array<{ id?: string; isPrimary?: boolean; shareStremioWith?: string | null }>;
    };
    const profiles = Array.isArray(s.profiles) ? s.profiles : [];
    const active = profiles.find((p) => p.id === s.activeId) ?? null;
    const own = active?.id ?? profiles.find((p) => p?.isPrimary)?.id ?? "";
    if (!own) return "";
    if (active && typeof active.shareStremioWith === "string" && active.shareStremioWith) {
      const shared = profiles.find((p) => p.id === active.shareStremioWith);
      if (shared?.id) return shared.id;
    }
    return own;
  } catch {
    return "";
  }
}

function primaryProfileId(): string {
  try {
    const raw = localStorage.getItem(PROFILES_KEY);
    const s = raw
      ? (JSON.parse(raw) as { profiles?: Array<{ id?: string; isPrimary?: boolean }> })
      : null;
    const primary = s?.profiles?.find((p) => p?.isPrimary);
    return (primary && typeof primary.id === "string" && primary.id) || activeProfileId();
  } catch {
    return activeProfileId();
  }
}

function storeKey(): string {
  const id = activeProfileId();
  return id ? KEY_PREFIX + id : LEGACY_KEY;
}

function atStoreKey(): string {
  const id = activeProfileId();
  return id ? AT_KEY_PREFIX + id : AT_LEGACY_KEY;
}

function migrateLegacy(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return;
    const pid = primaryProfileId();
    if (!pid) return;
    const perKey = KEY_PREFIX + pid;
    if (!localStorage.getItem(perKey)) localStorage.setItem(perKey, legacy);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* noop */
  }
}

function load(): Set<string> {
  if (cache) return cache;
  migrateLegacy();
  try {
    const arr = JSON.parse(localStorage.getItem(storeKey()) ?? "[]");
    cache = new Set(
      Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [],
    );
  } catch {
    cache = new Set();
  }
  return cache;
}

function loadAt(): Record<string, number> {
  if (atCache) return atCache;
  try {
    const raw = JSON.parse(localStorage.getItem(atStoreKey()) ?? "{}");
    const next: Record<string, number> = {};
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) next[k] = v;
      }
    }
    atCache = next;
  } catch {
    atCache = {};
  }
  return atCache;
}

function persist(next: Set<string>, nextAt?: Record<string, number>): void {
  cache = next;
  if (nextAt) {
    atCache = nextAt;
    if (typeof localStorage !== "undefined") {
      persistCritical(atStoreKey(), JSON.stringify(nextAt));
    }
  }
  version += 1;
  if (typeof localStorage !== "undefined") {
    persistCritical(storeKey(), JSON.stringify([...next]));
  }
  for (const fn of subs) fn();
}

export function isMovieWatchedLocal(metaId: string): boolean {
  return load().has(metaId);
}

export function movieWatchedAt(metaId: string): number {
  return loadAt()[metaId] ?? 0;
}

export function isMovieCompletedAfter(
  metaId: string,
  activityMs: number,
  altId?: string | null,
): boolean {
  const watched = isMovieWatchedLocal(metaId) || (!!altId && isMovieWatchedLocal(altId));
  if (!watched) return false;
  const at = Math.max(movieWatchedAt(metaId), altId ? movieWatchedAt(altId) : 0);
  if (at <= 0) return true;
  if (!Number.isFinite(activityMs) || activityMs <= 0) return true;
  return at + COMPLETION_ECHO_MS >= activityMs;
}

export function movieWatchedIds(): Set<string> {
  return load();
}

export function setMovieWatchedLocal(
  metaId: string,
  watched: boolean,
  at: number = Date.now(),
): void {
  const cur = load();
  const curAt = loadAt();
  const validAt = Number.isFinite(at) && at > 0 ? at : Date.now();
  if (cur.has(metaId) === watched) {
    if (watched && (curAt[metaId] ?? 0) < validAt) {
      const nextAt = { ...curAt, [metaId]: validAt };
      atCache = nextAt;
      if (typeof localStorage !== "undefined") {
        persistCritical(atStoreKey(), JSON.stringify(nextAt));
      }
      version += 1;
      for (const fn of subs) fn();
    }
    return;
  }
  const next = new Set(cur);
  const nextAt = { ...curAt };
  if (watched) {
    next.add(metaId);
    nextAt[metaId] = Math.max(nextAt[metaId] ?? 0, validAt);
  } else {
    next.delete(metaId);
    delete nextAt[metaId];
  }
  persist(next, nextAt);
}

export function subscribeMovieWatched(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function movieWatchedVersion(): number {
  return version;
}

if (typeof window !== "undefined") {
  let lastProfile = activeProfileId();
  const onProfileChange = () => {
    const p = activeProfileId();
    if (p === lastProfile) return;
    lastProfile = p;
    cache = null;
    atCache = null;
    version += 1;
    for (const fn of subs) fn();
  };
  window.addEventListener("harbor:active-profile-changed", onProfileChange);
  window.addEventListener("harbor:profiles-updated", onProfileChange);
}
