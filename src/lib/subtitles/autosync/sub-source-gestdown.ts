import { safeFetch } from "@/lib/safe-fetch";
import { normalizeLang } from "@/lib/subtitles/language";
import type { SubSearchQuery } from "@/lib/subtitles/types";
import { resolveSubtitleDownloadUrl } from "./download-url";
import {
  isSeries,
  wantedLangs,
  markRateLimited,
  rateLimitDelaySeconds,
  type ProviderCtx,
  type SourceSubCandidate,
  type SubSource,
} from "./sub-sources";

const BASE = "https://api.gestdown.info";

type GestSub = {
  subtitleId?: string;
  version?: string;
  language?: string;
  downloadUri?: string;
  completed?: boolean;
  hearingImpaired?: boolean;
};

async function resolveShowId(
  q: SubSearchQuery,
  ctx: ProviderCtx,
): Promise<{ status: "found"; id: string } | { status: "not_found" } | { status: "transient" }> {
  const tvdb = (q as { tvdbId?: number | string }).tvdbId;
  const path = tvdb
    ? `/shows/external/tvdb/${encodeURIComponent(String(tvdb))}`
    : q.title
      ? `/shows/search/${encodeURIComponent(q.title)}`
      : null;
  if (!path) return { status: "not_found" };
  let res: Response;
  try {
    res = await safeFetch(`${BASE}${path}`, {
      headers: { "User-Agent": ctx.userAgent, Accept: "application/json" },
    });
  } catch {
    return { status: "transient" };
  }
  if (res.status === 429) {
    markRateLimited("gestdown", rateLimitDelaySeconds(res, 30));
    return { status: "transient" };
  }
  if (res.status === 423 || res.status >= 500) {
    return { status: "transient" };
  }
  if (res.status === 404) return { status: "not_found" };
  if (!res.ok) return { status: "transient" };
  const data = (await res.json().catch(() => null)) as {
    shows?: Array<{ id?: string }>;
    id?: string;
  } | null;
  const id = data?.id ?? data?.shows?.[0]?.id ?? null;
  return id ? { status: "found", id } : { status: "not_found" };
}

export const gestdownSource: SubSource = {
  id: "gestdown",
  supportsHash: false,
  supportsMovie: false,
  supportsTv: true,
  async search(q: SubSearchQuery, ctx: ProviderCtx): Promise<SourceSubCandidate[] | null> {
    if (!isSeries(q) || q.season == null || q.episode == null) return [];
    const showRes = await resolveShowId(q, ctx);
    if (showRes.status === "transient") return null;
    if (showRes.status === "not_found") return [];
    const showId = showRes.id;
    const idConfirmed = (q as { tvdbId?: unknown }).tvdbId != null;
    const codes = wantedLangs(q);
    const out: SourceSubCandidate[] = [];
    let anyOk = false;
    let anyTransient = false;
    for (const code of codes.length ? codes : ["en"]) {
      const url = `${BASE}/subtitles/get/${encodeURIComponent(showId)}/${q.season}/${q.episode}/${encodeURIComponent(code)}`;
      let res: Response;
      try {
        res = await safeFetch(url, {
          headers: { "User-Agent": ctx.userAgent, Accept: "application/json" },
        });
      } catch {
        anyTransient = true;
        continue;
      }
      if (res.status === 423) return null;
      if (res.status === 429) {
        markRateLimited("gestdown", rateLimitDelaySeconds(res, 30));
        return null;
      }
      if (!res.ok) {
        if (res.status >= 500 || res.status === 408) anyTransient = true;
        continue;
      }
      anyOk = true;
      const data = (await res.json().catch(() => null)) as { matchingSubtitles?: GestSub[] } | null;
      const rows = Array.isArray(data?.matchingSubtitles)
        ? (data as { matchingSubtitles: GestSub[] }).matchingSubtitles
        : [];
      for (const r of rows) {
        if (r.completed !== true || !r.downloadUri) continue;
        const downloadUrl = resolveSubtitleDownloadUrl(r.downloadUri, BASE);
        if (!downloadUrl) continue;
        out.push({
          provider: "gestdown",
          id: r.subtitleId ?? r.downloadUri,
          url: downloadUrl,
          pageUrl: null,
          lang: normalizeLang(r.language ?? code),
          release: r.version ?? null,
          format: "srt",
          hearingImpaired: r.hearingImpaired === true,
          foreignOnly: false,
          machineTranslated: false,
          fps: null,
          downloads: 0,
          fromTrusted: true,
          hashMatched: false,
          langConfirmed: true,
          episodeConfirmed: true,
          idConfirmed,
          matchScore: 0,
        });
      }
    }
    if (!anyOk && anyTransient) return null;
    return out;
  },
};
