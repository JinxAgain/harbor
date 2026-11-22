import type { TrackInfo } from "@/lib/player/bridge";
import { subtitleTrackDownloadHeaders } from "@/lib/subtitles/provider-auth";
import type { SubtitleCandidateInput } from "@/lib/subtitles/autosync/embedded-sync";
import type { SubtitleLoadMetadata } from "@/lib/subtitles/types";

export function isAutoSyncEligibleMedia(
  url: string | null | undefined,
  durationSec: number,
  isLive?: boolean,
): boolean {
  if (!url || isLive) return false;
  if (/^(blob|data):/i.test(url)) return false;
  return durationSec >= 60;
}

export function canPrefetchEmbeddedMedia(
  url: string | null | undefined,
  isLive?: boolean,
): boolean {
  if (!url || isLive) return false;
  if (/^(blob|data):/i.test(url)) return false;
  return true;
}

export function buildSelectedCandidateInput(track: TrackInfo): SubtitleCandidateInput | null {
  const sourceUrl = track.originalUrl || track.url || track.externalFilename;
  if (!sourceUrl) return null;
  const localPath =
    track.prepared && track.externalFilename
      ? track.externalFilename
      : !/^(https?|blob|data|memory):/i.test(sourceUrl)
        ? sourceUrl
        : undefined;
  const providerDerived = track.providerDerived ?? Boolean(track.provider);
  const headers = /^https?:/i.test(sourceUrl)
    ? subtitleTrackDownloadHeaders(track.downloadAuth, sourceUrl, providerDerived)
    : undefined;
  return {
    url: sourceUrl,
    localPath,
    format: track.format,
    lang: track.lang,
    title: track.title,
    headers,
    localTrusted: track.localTrusted === true,
    downloadAuth: track.downloadAuth,
    subId: track.subId,
  };
}

export function buildRestoreMetadata(track: TrackInfo): SubtitleLoadMetadata {
  return {
    originalUrl: track.originalUrl ?? track.url,
    downloadAuth: track.downloadAuth,
    format: track.format,
    release: track.release,
    provider: track.provider,
    providerDerived: track.providerDerived,
    localTrusted: track.localTrusted,
    fps: track.fps,
    downloads: track.downloads,
    author: track.author,
    uploadedAt: track.uploadedAt,
    rating: track.rating,
    productionType: track.productionType,
    releaseType: track.releaseType,
    hearingImpaired: track.hearingImpaired,
    forced: track.forced,
    foreignOnly: track.foreignOnly,
    machineTranslated: track.machineTranslated,
    fromTrusted: track.fromTrusted,
    providerMatch: track.providerMatch,
    timingStatus: track.timingStatus,
    timingMeasurementStatus: track.timingMeasurementStatus,
    matchExplanation: track.matchExplanation,
    autoSelectionEligible: track.autoSelectionEligible,
    matchScore: track.matchScore,
    matchConfidence: track.matchConfidence,
    matchReasons: track.matchReasons,
    subId: track.subId,
  };
}
