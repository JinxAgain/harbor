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
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
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
  "SD": 10,
};

const TIER_BONUS: Partial<Record<Tier, number>> = {
  "4K_DV": 3,
  "4K_HDR": 2,
  "4K": 1,
  "1080p_HDR": 2,
  "1080p": 1,
  "720p": 1,
  "SD": 1,
  "ROUGH": 0,
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
