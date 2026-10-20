import type { DebridSlug } from "./types";

export function stripInvisibles(text: string): string {
  return text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, "").replace(/\uFE0F/g, "");
}

export const UNCACHED_MARKER_RX =
  /\[[^\]]*🧲[^\]]*\]|\b(?:real[\s\-_]?debrid|torbox|all[\s\-_]?debrid|premiumize|debrid[\s\-_]?link|easydebrid|offcloud|pikpak|putio|rd|tb|trb|ad|pm|dl|oc|ed|pkp|pp)\s*🧲|\b(?:rd|ad|pm|dl|tb|trb|oc|ed|pkp|pp|pikpak|putio)[\s\-_]*download\b|\buncached\b|\bnot\s+ready\b|\bneed[\s_-]?(?:to[\s_-]?)?cache\b|\[(?:RD|TB|AD|PM|DL|OC|ED|PKP|PP|PikPak|Putio)\]\s+jackettio\b|[⏳⌛⬇⏬🔽📥☁🔻❌🎟]/iu;

export const CACHED_MARKER_RX = /[⚡✅]/u;

export const DEBRID_TAG_RX =
  /\[(?:realdebrid|real-debrid|torbox|alldebrid|all-debrid|premiumize|debridlink|debrid-link|easydebrid|offcloud|pikpak|stremthru|rd|ad|pm|dl|tb|trb|oc|ed|pkp|pp|st|putio)\s*(?:\+|⚡|✅|⬇|⏳|🧲|\]|\s)/iu;

export function hasUncachedMarker(s: {
  name?: string | null;
  title?: string | null;
  description?: string | null;
}): boolean {
  const haystack = stripInvisibles(`${s.name ?? ""} ${s.title ?? ""} ${s.description ?? ""}`);
  return UNCACHED_MARKER_RX.test(haystack);
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
  return DEBRID_TAG_RX.test(haystack) || UNCACHED_MARKER_RX.test(haystack) || CACHED_MARKER_RX.test(haystack);
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
    infoHash?: string | null;
    cached?: Partial<Record<DebridSlug, boolean>>;
    inLibrary?: Partial<Record<DebridSlug, boolean>>;
    name?: string | null;
    title?: string | null;
    description?: string | null;
  },
  activeDebrids: DebridSlug[],
): boolean {
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
