import type { DebridSlug } from "./types";

export function stripInvisibles(text: string): string {
  return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\uFE0F/g, "");
}

export const UNCACHED_MARKER_RX =
  /\[[^\]]*🧲[^\]]*\]|\b(?:real[\s\-_]?debrid|torbox|all[\s\-_]?debrid|premiumize|debrid[\s\-_]?link|easydebrid|offcloud|pikpak|putio|rd|tb|trb|ad|pm|dl|oc|ed|pkp|pp)\s*🧲|\b(?:rd|ad|pm|dl|tb|trb|oc|ed|pkp|pp|pikpak|putio)[\s\-_]*download\b|\buncached\b|\bnot\s+ready\b|\bneed[\s_-]?(?:to[\s_-]?)?cache\b|\[(?:RD|TB|AD|PM|DL|OC|ED|PKP|PP|PikPak|Putio)\]\s+jackettio\b|[⏳⌛⬇⏬🔽📥☁🔻❌🎟]/iu;

export const CACHED_MARKER_RX = /[⚡✅]/u;

export const DEBRID_TAG_RX =
  /\[(?:realdebrid|real-debrid|torbox|alldebrid|all-debrid|premiumize|debridlink|debrid-link|easydebrid|offcloud|pikpak|stremthru|rd|ad|pm|dl|tb|trb|oc|ed|pkp|pp|st|putio)\s*(?:\+|⚡|✅|⬇|⏳|🧲|\]|\s)/iu;

export const PROMO_BANNER_RX =
  /\b(?:donation\s+needed|donate\b|support\s+the\s+project|join\s+(?:the\s+|our\s+)?discord|discord\s+server|donating\s+hides\s+this|keep\s+the\s+project\s+alive|patreon\.com|ko-fi\.com|buymeacoffee\.com|discord\.gg)\b/i;

const VIDEO_EXT_RX = /\.(mkv|mp4|m4v|avi|webm|mov|ts)(?:\?|$)/i;

/** Returns true for non-video addon promo/donation/Discord announcement cards. */
export function isPromoCard(s: {
  infoHash?: string | null;
  url?: string | null;
  name?: string | null;
  title?: string | null;
  description?: string | null;
  size?: number | null;
  seeders?: number | null;
  behaviorHints?: {
    videoSize?: number | null;
    filename?: string | null;
    fileName?: string | null;
  } | null;
}): boolean {
  if (s.infoHash) return false;
  if (s.url && VIDEO_EXT_RX.test(s.url)) return false;
  if (s.behaviorHints?.videoSize && s.behaviorHints.videoSize > 0) return false;
  if (s.behaviorHints?.filename || s.behaviorHints?.fileName) return false;
  if (s.size != null && s.size > 0) return false;
  if (s.seeders != null) return false;
  const haystack = stripInvisibles(`${s.name ?? ""} ${s.title ?? ""} ${s.description ?? ""}`);
  return PROMO_BANNER_RX.test(haystack);
}

export function hasUncachedMarker(s: {
  name?: string | null;
  title?: string | null;
  description?: string | null;
}): boolean {
  const haystack = stripInvisibles(`${s.name ?? ""} ${s.title ?? ""} ${s.description ?? ""}`);
  return UNCACHED_MARKER_RX.test(haystack);
}

/**
 * Returns true only when the stream is explicitly cached in a debrid service,
 * present in the user's debrid library, or carries an explicit cached marker
 * (e.g. ⚡ or ✅), without any uncached marker. Plain HTTP direct links return false.
 */
export function isExplicitlyCached(s: {
  infoHash?: string | null;
  url?: string | null;
  externalUrl?: string | null;
  cached?: Partial<Record<DebridSlug, boolean>>;
  inLibrary?: Partial<Record<DebridSlug, boolean>>;
  name?: string | null;
  title?: string | null;
  description?: string | null;
  size?: number | null;
  seeders?: number | null;
  behaviorHints?: {
    videoSize?: number | null;
    filename?: string | null;
    fileName?: string | null;
  } | null;
}): boolean {
  if (isPromoCard(s)) return false;
  if (hasUncachedMarker(s)) return false;
  if (
    Object.values(s.cached ?? {}).some((v) => v === true) ||
    Object.values(s.inLibrary ?? {}).some((v) => v === true)
  ) {
    return true;
  }
  return hasCachedMarker(s);
}

export function hasCachedMarker(s: {
  name?: string | null;
  title?: string | null;
  description?: string | null;
}): boolean {
  const haystack = stripInvisibles(`${s.name ?? ""} ${s.title ?? ""} ${s.description ?? ""}`);
  return CACHED_MARKER_RX.test(haystack);
}

export function hasDebridMarker(s: {
  name?: string | null;
  title?: string | null;
  description?: string | null;
}): boolean {
  const haystack = stripInvisibles(`${s.name ?? ""} ${s.title ?? ""} ${s.description ?? ""}`);
  return (
    DEBRID_TAG_RX.test(haystack) ||
    UNCACHED_MARKER_RX.test(haystack) ||
    CACHED_MARKER_RX.test(haystack)
  );
}

export function isExplicitlyUncached(
  s: {
    name?: string | null;
    title?: string | null;
    description?: string | null;
    cached?: Partial<Record<string, boolean>>;
    inLibrary?: Partial<Record<string, boolean>>;
  },
  activeDebrids?: DebridSlug[],
): boolean {
  const hasCachedDebrid =
    activeDebrids && activeDebrids.length > 0
      ? activeDebrids.some((slug) => s.cached?.[slug] === true || s.inLibrary?.[slug] === true)
      : Object.values(s.cached ?? {}).some((v) => v === true) ||
        Object.values(s.inLibrary ?? {}).some((v) => v === true);

  if (hasCachedDebrid) return false;

  if (hasUncachedMarker(s)) return true;
  if (Object.values(s.cached ?? {}).some((v) => v === false)) return true;
  return false;
}

export function isCached(
  s: {
    url?: string | null;
    externalUrl?: string | null;
    infoHash?: string | null;
    cached?: Partial<Record<DebridSlug, boolean>>;
    inLibrary?: Partial<Record<DebridSlug, boolean>>;
    name?: string | null;
    title?: string | null;
    description?: string | null;
    size?: number | null;
    seeders?: number | null;
    behaviorHints?: {
      videoSize?: number | null;
      filename?: string | null;
      fileName?: string | null;
    } | null;
  },
  activeDebrids: DebridSlug[],
): boolean {
  if (isPromoCard(s)) return false;
  if (!s.url && !s.infoHash && s.externalUrl) return false;
  if (isExplicitlyUncached(s, activeDebrids)) return false;
  if (
    activeDebrids.some((slug) => s.cached?.[slug] === true || s.inLibrary?.[slug] === true) ||
    Object.values(s.cached ?? {}).some((v) => v === true) ||
    Object.values(s.inLibrary ?? {}).some((v) => v === true)
  ) {
    return true;
  }
  if (hasCachedMarker(s)) return true;
  if (s.url != null && !s.infoHash && !hasDebridMarker(s)) return true;
  return false;
}

export function isP2pStream(s: {
  infoHash?: string | null;
  url?: string | null;
  cached?: Partial<Record<string, boolean>>;
  name?: string | null;
  title?: string | null;
  description?: string | null;
}): boolean {
  if (!s.infoHash) return false;
  if (s.cached && Object.values(s.cached).some(Boolean)) return false;
  const haystack = stripInvisibles(`${s.name ?? ""} ${s.title ?? ""} ${s.description ?? ""}`);
  return !DEBRID_TAG_RX.test(haystack) && !CACHED_MARKER_RX.test(haystack);
}
