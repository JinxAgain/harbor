export const DERIVED_ANILIST_FORMATS = new Set(["SPECIAL", "OVA", "MUSIC"]);

export function isDerivedAnimeFormat(format?: string): boolean {
  return format != null && DERIVED_ANILIST_FORMATS.has(format.toUpperCase());
}

const SHORT_SUBTYPES = new Set(["special", "music", "one_shot"]);

export type FranchiseExtraCandidate = {
  meta: { type: string; name: string };
  episodeCount?: number;
  subtype?: string;
  isCurrent: boolean;
  isUpcoming: boolean;
  isSideStory?: boolean;
};

export function isFranchiseExtra(f: FranchiseExtraCandidate): boolean {
  if (f.meta.type === "movie") return true;
  if (f.isSideStory) return true;
  const sub = (f.subtype ?? "").toLowerCase();
  if (SHORT_SUBTYPES.has(sub)) return true;
  if (/\b(ova|oad|special|mini)\b/i.test(f.meta.name)) return true;
  const airingSeason = f.meta.type === "series" && (f.isCurrent || f.isUpcoming);
  if (sub === "ova" || sub === "ona") return (f.episodeCount ?? 0) <= 2 && !airingSeason;
  return (f.episodeCount ?? 0) <= 1 && !airingSeason;
}
