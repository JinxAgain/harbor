import { useSyncExternalStore } from "react";
import type { ExternalCwSource } from "@/lib/stremio";
import { privateCwProfileId } from "./cw-profile";

const KEY = "harbor.resume";
const PRIVATE_PREFIX = "harbor.resume.private.v1.";

function readKey(): string {
  const profileId = privateCwProfileId();
  return profileId ? PRIVATE_PREFIX + profileId : KEY;
}

export type Entry = { ms: number; t: number; s?: number; pct?: number; source?: ExternalCwSource };

export function pickPreferredResume(
  current: Entry | null,
  candidate: Entry | null,
): Entry | null {
  if (!candidate) return current;
  if (!current) return candidate;
  const curTracker = Boolean(current.source);
  const candTracker = Boolean(candidate.source);
  if (curTracker !== candTracker) {
    const firstParty = curTracker ? candidate : current;
    const tracker = curTracker ? current : candidate;
    return tracker.t > firstParty.t + 60_000 ? tracker : firstParty;
  }
  return candidate.t > current.t ? candidate : current;
}

function entryKey(id: string, season?: number, episode?: number): string {
  if (typeof season === "number" && typeof episode === "number") {
    return `${id}|s${season}e${episode}`;
  }
  return id;
}

function readAll(key = readKey()): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

const subs = new Set<() => void>();
let version = 0;

function emit(): void {
  version += 1;
  for (const fn of subs) fn();
}

export function subscribeResume(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

export function resumeVersion(): number {
  return version;
}

export function useResumeVersion(): number {
  return useSyncExternalStore(subscribeResume, resumeVersion, () => 0);
}

function writeAll(all: Record<string, Entry>, key: string): void {
  try {
    localStorage.setItem(key, JSON.stringify(all));
  } catch {
    /* noop */
  }
  emit();
}

export function saveResumeMs(
  id: string,
  ms: number,
  season?: number,
  episode?: number,
  displaySeason?: number,
  pct?: number,
  source?: ExternalCwSource,
  ownerId?: string,
): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  if (typeof season === "number" && typeof episode === "number") {
    if (season < 0 || episode < 1) return;
  }
  const p = pct !== undefined && Number.isFinite(pct) && pct >= 0 && pct <= 1 ? pct : undefined;
  // Imported/cloud progress never establishes a profile's playback ownership.
  for (const key of ownerId ? [KEY, PRIVATE_PREFIX + ownerId] : [KEY]) {
    const all = readAll(key);
    const existing = all[entryKey(id, season, episode)];
    const s =
      typeof displaySeason === "number" && displaySeason >= 1
        ? displaySeason
        : existing?.s;
    const entry: Entry = {
      ms,
      t: Date.now(),
      ...(s !== undefined ? { s } : {}),
      ...(p !== undefined ? { pct: p } : {}),
      ...(source !== undefined ? { source } : {}),
    };
    all[entryKey(id, season, episode)] = entry;
    writeAll(all, key);
  }
}

export function saveResumeBatch(
  entries: {
    id: string;
    ms: number;
    season?: number;
    episode?: number;
    t?: number;
    pct?: number;
    source?: ExternalCwSource;
  }[],
): void {
  if (entries.length === 0) return;
  const all = readAll(KEY);
  const now = Date.now();
  for (const e of entries) {
    if (!Number.isFinite(e.ms) || e.ms < 0) continue;
    if (typeof e.season === "number" && typeof e.episode === "number") {
      if (e.season < 0 || e.episode < 1) continue;
    }
    const p =
      e.pct !== undefined && Number.isFinite(e.pct) && e.pct >= 0 && e.pct <= 1 ? e.pct : undefined;
    all[entryKey(e.id, e.season, e.episode)] = {
      ms: e.ms,
      t: e.t ?? now,
      ...(p !== undefined ? { pct: p } : {}),
      ...(e.source !== undefined ? { source: e.source } : {}),
    };
  }
  writeAll(all, KEY);
}

export function readResumeMs(id: string, season?: number, episode?: number): number {
  return readResumeEntry(id, season, episode)?.ms ?? 0;
}

export function readResumeEntry(
  id: string,
  season?: number,
  episode?: number,
): { ms: number; t: number; s?: number; pct?: number; source?: ExternalCwSource } | null {
  const all = readAll();
  let e = all[entryKey(id, season, episode)];
  if (!e && typeof season === "number" && typeof episode === "number") {
    const prefix = `${id}|s`;
    let bestMatch: Entry | null = null;
    for (const [key, val] of Object.entries(all)) {
      if (!key.startsWith(prefix)) continue;
      const m = key.match(/\|s(\d+)e(\d+)$/);
      if (!m) continue;
      const epNum = parseInt(m[2], 10);
      if (epNum !== episode) continue;
      const keySeason = parseInt(m[1], 10);
      if (val.s === season || keySeason === season) {
        if (!bestMatch || val.t > bestMatch.t) {
          bestMatch = val;
        }
      }
    }
    if (bestMatch) {
      e = bestMatch;
    }
  }
  return e
    ? {
        ms: e.ms,
        t: e.t,
        ...(e.s !== undefined ? { s: e.s } : {}),
        ...(e.pct !== undefined ? { pct: e.pct } : {}),
        ...(e.source !== undefined ? { source: e.source } : {}),
      }
    : null;
}

export function readResumeSource(
  id: string,
  season?: number,
  episode?: number,
): ExternalCwSource | undefined {
  return readResumeEntry(id, season, episode)?.source;
}

export function clearResume(id: string, season?: number, episode?: number, ownerId?: string): void {
  for (const key of ownerId ? [KEY, PRIVATE_PREFIX + ownerId] : [readKey()]) {
    const all = readAll(key);
    const existing = all[entryKey(id, season, episode)];
    delete all[entryKey(id, season, episode)];
    if (typeof season === "number" && typeof episode === "number") {
      const prefix = `${id}|s`;
      for (const [k, val] of Object.entries(all)) {
        if (!k.startsWith(prefix)) continue;
        const m = k.match(/\|s(\d+)e(\d+)$/);
        if (!m) continue;
        const epNum = parseInt(m[2], 10);
        if (epNum !== episode) continue;
        const keySeason = parseInt(m[1], 10);
        if (
          keySeason === season ||
          val.s === season ||
          (existing?.s != null && (keySeason === existing.s || val.s === existing.s))
        ) {
          delete all[k];
        }
      }
    }
    writeAll(all, key);
  }
}

export function lastPlayedEpisode(seriesId: string): {
  season: number;
  episode: number;
  ms: number;
  t: number;
  displaySeason?: number;
  pct?: number;
  source?: ExternalCwSource;
} | null {
  const all = readAll();
  const prefix = `${seriesId}|s`;
  let best: {
    season: number;
    episode: number;
    ms: number;
    t: number;
    displaySeason?: number;
    pct?: number;
    source?: ExternalCwSource;
  } | null = null;
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(prefix)) continue;
    const m = key.match(/\|s(\d+)e(\d+)$/);
    if (!m) continue;
    const season = parseInt(m[1], 10);
    const episode = parseInt(m[2], 10);
    if (season < 1 || episode < 1) continue;
    // If this key is an alias (where keySeason equals value.s) and a canonical entry
    // (with keySeason !== value.s && value.s === season) exists for the same episode, skip the alias
    if (value.s !== undefined && season === value.s) {
      const hasCanonical = Object.entries(all).some(([k, v]) => {
        if (!k.startsWith(prefix) || k === key) return false;
        const km = k.match(/\|s(\d+)e(\d+)$/);
        if (!km) return false;
        const kEp = parseInt(km[2], 10);
        const kSeason = parseInt(km[1], 10);
        return kEp === episode && v.s === season && kSeason !== season;
      });
      if (hasCanonical) continue;
    }
    if (!best || value.t > best.t) {
      best = {
        season,
        episode,
        ms: value.ms,
        t: value.t,
        displaySeason: value.s,
        pct: value.pct,
        source: value.source,
      };
    }
  }
  return best;
}

export function hasResumeProgress(
  id: string,
  season?: number,
  episode?: number,
  altIds?: Array<string | null | undefined>,
): boolean {
  const ids = [id, ...(altIds ?? [])].filter(
    (x): x is string => typeof x === "string" && x.length > 0,
  );
  for (const cid of ids) {
    const e = readResumeEntry(cid, season, episode);
    if (e && (e.ms > 0 || (typeof e.pct === "number" && e.pct > 0.01))) return true;
  }
  return false;
}
