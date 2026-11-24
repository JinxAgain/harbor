import { isSafeProviderSubtitleUrl } from "@/lib/subtitles/provider-url";

export function resolveSubtitleDownloadUrl(
  raw: string | null | undefined,
  base: string,
): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const resolved = url.toString();
    return isSafeProviderSubtitleUrl(resolved) ? resolved : null;
  } catch {
    return null;
  }
}
