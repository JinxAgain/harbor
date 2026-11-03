import { activeProfileId } from "@/lib/active-profile-id";
import type { CalendarItem } from "@/lib/calendar";
import { setItemWithRecovery } from "@/lib/storage-recovery";
import { subscribeActivitiesMutation } from "./activities/gate";
import { getSession, subscribeSession } from "./session";

export interface MonthSnapshotEntry {
  items: CalendarItem[];
  at: number; // 0 = invalidated/stale
  lastSync: string | null;
  accessedAt: number;
}

export type ProfileCalendarSnapshots = Record<string, MonthSnapshotEntry>;

export const SNAPSHOT_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_MONTHS = 6;
const MAX_STORAGE_BYTES = 200 * 1024; // 200 KB
const BASE_KEY = "harbor.simkl.calendar.v1";

function storageKey(): string {
  return `${BASE_KEY}.${activeProfileId()}`;
}

let memorySnapshots: ProfileCalendarSnapshots | null = null;
let memoryProfile: string | null = null;

type SnapshotListener = (items: CalendarItem[]) => void;
const listeners = new Map<string, Set<SnapshotListener>>();

function loadSnapshots(): ProfileCalendarSnapshots {
  const profile = activeProfileId();
  if (memorySnapshots && memoryProfile === profile) {
    return memorySnapshots;
  }
  memoryProfile = profile;
  memorySnapshots = {};
  if (typeof localStorage === "undefined") {
    return memorySnapshots;
  }
  try {
    const raw = localStorage.getItem(storageKey());
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        memorySnapshots = parsed;
      }
    }
  } catch (e) {
    console.error("Failed to parse SIMKL calendar snapshots", e);
  }
  return memorySnapshots!;
}

function persistSnapshots(snapshots: ProfileCalendarSnapshots): void {
  memorySnapshots = snapshots;
  memoryProfile = activeProfileId();
  if (typeof localStorage === "undefined") {
    return;
  }
  const key = storageKey();
  const keys = Object.keys(snapshots);
  if (keys.length > MAX_MONTHS) {
    keys.sort((a, b) => (snapshots[a]?.accessedAt ?? 0) - (snapshots[b]?.accessedAt ?? 0));
    while (keys.length > MAX_MONTHS) {
      const oldest = keys.shift()!;
      delete snapshots[oldest];
    }
  }
  let payload = JSON.stringify(snapshots);
  while (payload.length > MAX_STORAGE_BYTES && keys.length > 1) {
    keys.sort((a, b) => (snapshots[a]?.accessedAt ?? 0) - (snapshots[b]?.accessedAt ?? 0));
    const oldest = keys.shift()!;
    delete snapshots[oldest];
    payload = JSON.stringify(snapshots);
  }
  setItemWithRecovery(key, payload);
}

export function readSimklCalendarSnapshot(
  year: number,
  month: number,
): { items: CalendarItem[]; at: number; lastSync: string | null; isStale: boolean } | null {
  const snapshots = loadSnapshots();
  const k = `${year}-${month}`;
  const entry = snapshots[k];
  if (!entry) return null;
  entry.accessedAt = Date.now();
  const isStale = entry.at === 0 || Date.now() - entry.at > SNAPSHOT_TTL_MS;
  return {
    items: entry.items,
    at: entry.at,
    lastSync: entry.lastSync,
    isStale,
  };
}

export type PeekCalendarResult = CalendarItem[] & {
  items: CalendarItem[];
  isStale: boolean;
};

export function peekSimklCalendar(year: number, month: number): PeekCalendarResult | null {
  const snap = readSimklCalendarSnapshot(year, month);
  if (!snap) return null;
  const result = [...snap.items] as PeekCalendarResult;
  Object.defineProperties(result, {
    items: { value: snap.items, enumerable: false },
    isStale: { value: snap.isStale, enumerable: false },
  });
  return result;
}

export function writeSimklCalendarSnapshot(
  year: number,
  month: number,
  items: CalendarItem[],
  lastSync: string | null,
): void {
  const snapshots = loadSnapshots();
  const k = `${year}-${month}`;
  const existing = snapshots[k];
  const now = Date.now();
  snapshots[k] = {
    items,
    at: now,
    lastSync,
    accessedAt: now,
  };
  persistSnapshots(snapshots);

  const hasChanged = !existing || JSON.stringify(existing.items) !== JSON.stringify(items);
  if (hasChanged) {
    const set = listeners.get(k);
    if (set) {
      for (const listener of set) {
        listener(items);
      }
    }
  }
}

export function subscribeSimklCalendarSnapshot(
  year: number,
  month: number,
  listener: (items: CalendarItem[]) => void,
): () => void {
  const k = `${year}-${month}`;
  let set = listeners.get(k);
  if (!set) {
    set = new Set();
    listeners.set(k, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(k);
    }
  };
}

export function invalidateSimklCalendarSnapshots(opts?: { purgeStorage?: boolean }): void {
  const profile = activeProfileId();
  if (opts?.purgeStorage) {
    memorySnapshots = {};
    memoryProfile = profile;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(storageKey());
      } catch (e) {
        console.error("Failed to remove calendar snapshots", e);
      }
    }
  } else {
    const current = loadSnapshots();
    for (const k of Object.keys(current)) {
      if (current[k]) {
        current[k] = { ...current[k], at: 0 };
      }
    }
    persistSnapshots(current);
  }
}

let lastTrackedUsername: string | null = getSession()?.username ?? null;

subscribeActivitiesMutation(() => {
  invalidateSimklCalendarSnapshots({ purgeStorage: false });
});

subscribeSession(() => {
  const session = getSession();
  const username = session?.username ?? null;
  if (!username || username !== lastTrackedUsername) {
    invalidateSimklCalendarSnapshots({ purgeStorage: true });
  }
  lastTrackedUsername = username;
});
