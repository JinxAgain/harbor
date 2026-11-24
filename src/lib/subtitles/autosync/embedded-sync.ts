import { invoke } from "@tauri-apps/api/core";
import type { TrackInfo } from "@/lib/player/bridge";
import { isDesktopTauri } from "@/lib/platform";
import type { AutoSyncMode } from "@/lib/settings/types";
import { normalizeLang } from "@/lib/subtitles/language";
import {
  subtitleTrackDownloadHeaders,
  type SubtitleDownloadAuth,
} from "@/lib/subtitles/provider-auth";
import type { SubtitleSelectionOrigin } from "@/lib/player/subtitle-selection";
import type { SubResult } from "@/lib/subtitles/types";

export type AutoSyncCandidateScope = "startup_search" | "selected_then_search" | "selected_only";

export type AutoSyncTrigger = "automatic" | "manual";

export type SubtitleCandidateInput = {
  url: string;
  localPath?: string;
  inlineText?: string;
  format?: string;
  lang?: string;
  title?: string;
  release?: string;
  filename?: string;
  season?: number;
  episode?: number;
  headers?: Record<string, string>;
  localTrusted?: boolean;
  downloadAuth?: SubtitleDownloadAuth;
  subId?: string;
};

export type AlignSubtitlesRequest = {
  runId: string;
  mediaUrl: string;
  mediaHeaders?: Record<string, string>;
  mode: AutoSyncMode;
  toleranceMs: number;
  scope: AutoSyncCandidateScope;
  selectedTrack: SubtitleCandidateInput;
  candidates: SubtitleCandidateInput[];
};

export type PrefetchEmbeddedResponse = {
  status: "ready" | "no_subtitle_tracks" | "no_usable_reference" | "unavailable";
  trackCount: number;
};

export type AlignOutcome =
  | "synced"
  | "within_tolerance"
  | "no_fit"
  | "no_subtitle_tracks"
  | "no_usable_reference"
  | "container_unavailable"
  | "inconclusive"
  | "cancelled";

export type AlignSubtitlesResponse = {
  outcome: AlignOutcome;
  chosenUrl: string | null;
  chosenSubId: string | null;
  retimedPath: string | null;
  retimedText: string | null;
  format: "srt" | "vtt" | "ass" | "ssa" | "ttml" | null;
  selectedOriginalPath?: string | null;
  selectedOriginalText?: string | null;
  selectedOriginalFormat?: "srt" | "vtt" | "ass" | "ssa" | "ttml" | null;
  medianOffsetMs: number;
  maxShiftMs: number;
  scale: number;
  withinTolerance: boolean;
  matchedCueCount: number;
  totalCueCount: number;
  referenceTrackLabel: string | null;
};

export async function prefetchEmbeddedSubtitles(
  mediaUrl: string,
  mediaHeaders?: Record<string, string>,
): Promise<PrefetchEmbeddedResponse> {
  return invoke<PrefetchEmbeddedResponse>("subsync_prefetch_embedded", {
    mediaUrl,
    mediaHeaders: mediaHeaders ?? null,
  });
}

export async function alignSubtitlesAgainstEmbedded(
  request: AlignSubtitlesRequest,
): Promise<AlignSubtitlesResponse> {
  return invoke<AlignSubtitlesResponse>("subsync_align_subtitles", { request });
}

export async function cancelSubtitleAutoSync(runId: string): Promise<void> {
  await invoke("subsync_cancel", { runId }).catch(() => {});
}

/**
 * Matches NuvioMobile's candidate search scope policy:
 * - User manual Sync clicks ("manual" trigger) align ONLY the selected track.
 * - Automatic startup selections try all same-language candidates ("startup_search").
 * - Restored selections try the selected track first, then fall back to search if NO_FIT.
 * - Manual selections/imports on automatic trigger align ONLY that chosen track.
 */
export function resolveAutoSyncScope(
  trigger: AutoSyncTrigger,
  selectionOrigin: SubtitleSelectionOrigin,
): AutoSyncCandidateScope {
  if (trigger === "manual") return "selected_only";
  if (selectionOrigin === "automatic") return "startup_search";
  if (selectionOrigin === "restore") return "selected_then_search";
  return "selected_only";
}

/**
 * Uniquely identifies an external subtitle track by source identity rather than language,
 * ensuring switching between two subtitles of the same language re-triggers auto-sync.
 */
export function trackAutoSyncKey(
  track: Pick<TrackInfo, "id" | "url" | "originalUrl" | "externalFilename">,
): string {
  const source = track.originalUrl || track.url || track.externalFilename;
  if (source) return source.replace(/\\/g, "/");
  return `id:${track.id}`;
}

export function collectSameLanguageCandidates(
  selected: Pick<TrackInfo, "lang" | "url" | "originalUrl" | "externalFilename">,
  availableSubs: readonly SubResult[],
  allTracks: readonly TrackInfo[],
  limit = 12,
  context?: { season?: number; episode?: number },
): SubtitleCandidateInput[] {
  const targetLang = normalizeLang(selected.lang ?? "");
  if (!targetLang) return [];
  const selectedUrls = new Set(
    [selected.originalUrl, selected.url, selected.externalFilename]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .map((v) => v.replace(/\\/g, "/")),
  );
  const out: SubtitleCandidateInput[] = [];
  const seenUrls = new Set<string>(selectedUrls);
  const nativeTauri = isDesktopTauri();

  const pushCandidate = (cand: SubtitleCandidateInput) => {
    const normUrl = cand.url.replace(/\\/g, "/");
    if (!normUrl || seenUrls.has(normUrl)) return;
    seenUrls.add(normUrl);
    out.push(cand);
  };

  for (const track of allTracks) {
    if (out.length >= limit) break;
    if (!track.external) continue;
    const trackLang = normalizeLang(track.lang ?? "");
    if (trackLang !== targetLang) continue;
    const url = track.originalUrl || track.url;
    if (!url || !/^https?:/i.test(url)) continue;
    const providerDerived =
      track.providerDerived ?? (Boolean(track.provider) && track.localTrusted !== true);
    pushCandidate({
      url,
      localPath: track.prepared && track.externalFilename ? track.externalFilename : undefined,
      format: track.format,
      lang: track.lang,
      title: track.title,
      release: track.release,
      filename: track.externalFilename,
      season: context?.season,
      episode: context?.episode,
      // On desktop Tauri, Rust resolves downloadAuth/localTrusted from typed fields so we do not
      // pass internal X-Harbor-* policy markers over IPC.
      headers: nativeTauri
        ? undefined
        : subtitleTrackDownloadHeaders(track.downloadAuth, url, providerDerived),
      localTrusted: track.localTrusted === true,
      downloadAuth: track.downloadAuth,
      subId: track.subId,
    });
  }

  for (const res of availableSubs) {
    if (out.length >= limit) break;
    const resLang = normalizeLang(res.lang ?? "");
    if (resLang !== targetLang) continue;
    if (!res.url || !/^https?:/i.test(res.url)) continue;
    const providerDerived = res.localTrusted !== true;
    pushCandidate({
      url: res.url,
      format: res.format,
      lang: res.lang,
      title: res.title,
      release: res.release,
      season: context?.season,
      episode: context?.episode,
      headers: nativeTauri
        ? undefined
        : subtitleTrackDownloadHeaders(res.downloadAuth, res.url, providerDerived),
      localTrusted: res.localTrusted === true,
      downloadAuth: res.downloadAuth,
      subId: res.id,
    });
  }

  return out;
}

export function formatSyncShift(offsetMs: number): string {
  if (!Number.isFinite(offsetMs)) return "";
  const absMs = Math.abs(offsetMs);
  if (absMs < 50) return "0s";
  const sign = offsetMs >= 0 ? "+" : "-";
  if (absMs < 1000) return `${sign}${Math.round(absMs)}ms`;
  const sec = absMs / 1000;
  return `${sign}${sec >= 10 ? sec.toFixed(0) : sec.toFixed(1)}s`;
}
