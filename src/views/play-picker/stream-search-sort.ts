import { isExplicitlyCached, isPromoCard } from "@/lib/streams/cached";
import type { Resolution, ScoredStream, Tier } from "@/lib/streams/types";

export type StreamSearchMode = "plain" | "whole-word" | "wildcard" | "regex";
export type StreamSortField = "default" | "size" | "seeders" | "resolution" | "score";
export type StreamSortDir = "desc" | "asc";

export type CompiledStreamSearch = {
  active: boolean;
  error: string | null;
  test: (stream: ScoredStream) => boolean;
};

export function streamSearchHaystack(s: ScoredStream): string {
  const parts = [
    s.name,
    s.title,
    s.description,
    s.behaviorHints?.filename,
    s.behaviorHints?.fileName,
    s.addonName,
    s.releaseGroup,
    s.edition,
  ];
  return parts
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

export function compileStreamSearch(query: string, mode: StreamSearchMode): CompiledStreamSearch {
  const trimmed = query.trim();
  if (!trimmed) {
    return { active: false, error: null, test: () => true };
  }

  if (mode === "plain") {
    const needle = trimmed.toLowerCase();
    return {
      active: true,
      error: null,
      test: (s: ScoredStream) => streamSearchHaystack(s).toLowerCase().includes(needle),
    };
  }

  if (mode === "whole-word") {
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const prefix = /^[a-zA-Z0-9_]/.test(trimmed) ? "(?<![a-zA-Z0-9_])" : "";
    const suffix = /[a-zA-Z0-9_]$/.test(trimmed) ? "(?![a-zA-Z0-9_])" : "";
    const pattern = `${prefix}${escaped}${suffix}`;
    const rx = new RegExp(pattern, "i");
    return {
      active: true,
      error: null,
      test: (s: ScoredStream) => rx.test(streamSearchHaystack(s)),
    };
  }

  if (mode === "wildcard") {
    const escaped = trimmed.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const pattern = escaped.replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]");
    const rx = new RegExp(pattern, "i");
    return {
      active: true,
      error: null,
      test: (s: ScoredStream) => rx.test(streamSearchHaystack(s)),
    };
  }

  if (mode === "regex") {
    try {
      const rx = new RegExp(trimmed, "i");
      return {
        active: true,
        error: null,
        test: (s: ScoredStream) => rx.test(streamSearchHaystack(s)),
      };
    } catch (err) {
      return {
        active: true,
        error: err instanceof Error ? err.message : "Invalid regular expression",
        test: () => false,
      };
    }
  }

  return { active: false, error: null, test: () => true };
}

const RESOLUTION_BASE: Record<Resolution, number> = {
  "4K": 50,
  "1080p": 40,
  "720p": 30,
  "480p": 20,
  SD: 10,
};

const TIER_BONUS: Partial<Record<Tier, number>> = {
  "4K_DV": 3,
  "4K_HDR": 2,
  "4K": 1,
  "1080p_HDR": 2,
  "1080p": 1,
  "720p": 1,
  SD: 1,
  ROUGH: 0,
};

function getMetric(s: ScoredStream, sortBy: StreamSortField): number | null {
  if (sortBy === "size") {
    return typeof s.size === "number" && Number.isFinite(s.size) && s.size > 0 ? s.size : null;
  }
  if (sortBy === "seeders") {
    return typeof s.seeders === "number" && Number.isFinite(s.seeders) && s.seeders >= 0
      ? s.seeders
      : null;
  }
  if (sortBy === "resolution") {
    const base = RESOLUTION_BASE[s.resolution];
    if (base == null) return null;
    const bonus = TIER_BONUS[s.tier] ?? 0;
    return base + bonus;
  }
  if (sortBy === "score") {
    return typeof s.score === "number" && Number.isFinite(s.score) ? s.score : null;
  }
  return null;
}

function isWatchHubStream(s: ScoredStream): boolean {
  return /watchhub/i.test(s.addonId) || /watchhub/i.test(s.addonName ?? "");
}

function isExternalOnlyStream(s: ScoredStream): boolean {
  return !s.url && !s.infoHash && Boolean(s.externalUrl);
}

function defaultStreamBucket(s: ScoredStream): number {
  if (isPromoCard(s)) return 2;
  if (isWatchHubStream(s) || isExternalOnlyStream(s)) return 1;
  return 0;
}

function isUnlabeledStream(s: ScoredStream): boolean {
  return (
    s.resolution === "SD" &&
    s.source === "Other" &&
    s.size == null &&
    s.seeders == null &&
    !s.infoHash
  );
}

function defaultResolutionRank(s: ScoredStream): number {
  if (s.tier === "ROUGH") return 5;
  if (isUnlabeledStream(s)) return 0;
  return RESOLUTION_BASE[s.resolution] ?? 0;
}

function seederRank(s: ScoredStream): number {
  return typeof s.seeders === "number" && Number.isFinite(s.seeders) && s.seeders >= 0
    ? s.seeders
    : -1;
}

function sizeRank(s: ScoredStream): number {
  return typeof s.size === "number" && Number.isFinite(s.size) && s.size > 0 ? s.size : -1;
}

/**
 * Default stream ordering for the picker:
 * - Promo/donation cards always sink to the bottom (even when preserveOrder is true).
 * - Explicitly cached streams always float to the top (even when preserveOrder is true).
 * - In preserveOrder mode (addon order / Watch Together), incoming order is kept for non-cached real streams.
 * - Otherwise: real streams before WatchHub/external, explicitly cached first, labeled before unlabeled,
 *   then Resolution > Seeders > Size > Score.
 */
export function defaultSortStreams(
  streams: ScoredStream[],
  opts?: { preserveOrder?: boolean },
): ScoredStream[] {
  const indexed = streams.map((stream, index) => ({ stream, index }));
  if (opts?.preserveOrder) {
    return indexed
      .sort((a, b) => {
        const ba = defaultStreamBucket(a.stream);
        const bb = defaultStreamBucket(b.stream);
        if (ba === 2 || bb === 2) {
          if (ba !== bb) return ba - bb;
        }
        const ca = isExplicitlyCached(a.stream) ? 1 : 0;
        const cb = isExplicitlyCached(b.stream) ? 1 : 0;
        if (ca !== cb) return cb - ca;
        return a.index - b.index;
      })
      .map((entry) => entry.stream);
  }

  return indexed
    .sort((a, b) => {
      const sa = a.stream;
      const sb = b.stream;

      const bucketDiff = defaultStreamBucket(sa) - defaultStreamBucket(sb);
      if (bucketDiff !== 0) return bucketDiff;

      const cachedDiff = (isExplicitlyCached(sb) ? 1 : 0) - (isExplicitlyCached(sa) ? 1 : 0);
      if (cachedDiff !== 0) return cachedDiff;

      const unlabeledDiff = (isUnlabeledStream(sa) ? 1 : 0) - (isUnlabeledStream(sb) ? 1 : 0);
      if (unlabeledDiff !== 0) return unlabeledDiff;

      const resDiff = defaultResolutionRank(sb) - defaultResolutionRank(sa);
      if (resDiff !== 0) return resDiff;

      const seederDiff = seederRank(sb) - seederRank(sa);
      if (seederDiff !== 0) return seederDiff;

      const sizeDiff = sizeRank(sb) - sizeRank(sa);
      if (sizeDiff !== 0) return sizeDiff;

      const scoreA = typeof sa.score === "number" && Number.isFinite(sa.score) ? sa.score : 0;
      const scoreB = typeof sb.score === "number" && Number.isFinite(sb.score) ? sb.score : 0;
      if (scoreB !== scoreA) return scoreB - scoreA;

      return a.index - b.index;
    })
    .map((entry) => entry.stream);
}

export function sortPickerStreams(
  streams: ScoredStream[],
  sortBy: StreamSortField,
  sortDir: StreamSortDir,
  defaultOrder: (streams: ScoredStream[]) => ScoredStream[],
): ScoredStream[] {
  const base = defaultOrder(streams);
  if (sortBy === "default") {
    return base;
  }

  const baseIdx = new Map(base.map((s, i) => [s, i]));

  return base.slice().sort((a, b) => {
    const cachedDiff = (isExplicitlyCached(b) ? 1 : 0) - (isExplicitlyCached(a) ? 1 : 0);
    if (cachedDiff !== 0) {
      return cachedDiff;
    }

    const va = getMetric(a, sortBy);
    const vb = getMetric(b, sortBy);

    if (va == null && vb == null) {
      return (baseIdx.get(a) ?? 0) - (baseIdx.get(b) ?? 0);
    }
    if (va == null) {
      return 1;
    }
    if (vb == null) {
      return -1;
    }

    const diff = sortDir === "desc" ? vb - va : va - vb;
    return diff !== 0 ? diff : (baseIdx.get(a) ?? 0) - (baseIdx.get(b) ?? 0);
  });
}
