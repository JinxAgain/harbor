import type { PlayerBridge, TrackInfo } from "@/lib/player/bridge";
import type { SubtitleSelectionOrigin } from "@/lib/player/subtitle-selection";
import { subtitleTrackDownloadHeaders } from "@/lib/subtitles/provider-auth";
import { trackAutoSyncKey, type SubtitleCandidateInput } from "@/lib/subtitles/autosync/embedded-sync";
import { parseSubtitle } from "@/lib/subtitles/parser";
import {
  registerPreparedSubtitle,
  takePreparedSubtitle,
} from "@/lib/subtitles/prepared-registry";
import type { SubtitleLoadMetadata } from "@/lib/subtitles/types";

export type AutoSyncScope = { mediaKey: string; trackId: string };
export type SupportedTextSubFormat = "srt" | "vtt" | "ass" | "ssa";

export type AppliedAutoSyncState = {
  originalTrack: TrackInfo | null;
  replacedSelected: boolean;
  originalTrackId: string | null;
  originalTrackKey: string | null;
  committedTrackId: string | null;
  committedTrackKey: string | null;
  originalBackupPath: string | null;
  originalBackupText: string | null;
  originalBackupFormat: SupportedTextSubFormat | null;
  subDelayBefore: number;
  scope: AutoSyncScope | null;
  changed: boolean;
};

export const EMPTY_APPLIED_STATE: AppliedAutoSyncState = {
  originalTrack: null,
  replacedSelected: false,
  originalTrackId: null,
  originalTrackKey: null,
  committedTrackId: null,
  committedTrackKey: null,
  originalBackupPath: null,
  originalBackupText: null,
  originalBackupFormat: null,
  subDelayBefore: 0,
  scope: null,
  changed: false,
};

export function normalizeUrlKey(url: string | null | undefined): string {
  return (url ?? "").replace(/\\/g, "/");
}

export function normalizeTextSubFormat(
  fmt: string | null | undefined,
): SupportedTextSubFormat {
  if (fmt === "ass" || fmt === "ssa" || fmt === "vtt") return fmt;
  return "srt";
}

export function matchesCommittedSyncedTrack(
  applied: Pick<AppliedAutoSyncState, "changed" | "committedTrackId" | "committedTrackKey">,
  track: Pick<TrackInfo, "id" | "url" | "originalUrl" | "externalFilename"> | null,
): boolean {
  if (!applied.changed || !track) return false;
  if (applied.committedTrackId != null && track.id === applied.committedTrackId) return true;
  if (applied.committedTrackKey != null && trackAutoSyncKey(track) === applied.committedTrackKey) {
    return true;
  }
  return false;
}

export function shouldResetAutoSyncOnTrackChange(params: {
  mediaKey: string;
  selected: TrackInfo | null;
  selectedSynced: boolean;
  committingScope: AutoSyncScope | null;
  statusScope: AutoSyncScope | null;
  applied: AppliedAutoSyncState;
}): boolean {
  const { mediaKey, selected, selectedSynced, committingScope, statusScope, applied } = params;
  // In-place track replacement emits transient `selected === null` (mpv) and `selectedSynced = true` (HTML5).
  if (committingScope != null && committingScope.mediaKey === mediaKey) {
    return false;
  }
  if (selectedSynced) {
    if (applied.changed && !matchesCommittedSyncedTrack(applied, selected)) {
      return true;
    }
    return false;
  }
  if (!selected || !selected.external) {
    return true;
  }
  const currentKey = trackAutoSyncKey(selected);
  const scopeMatchesSelected =
    statusScope?.mediaKey === mediaKey && statusScope?.trackId === selected.id;
  return !scopeMatchesSelected && applied.originalTrackKey !== currentKey;
}

function createTextBlobUrl(text: string): { url: string; cleanup: () => void } {
  const blobUrl = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  return {
    url: blobUrl,
    cleanup: () => URL.revokeObjectURL(blobUrl),
  };
}

export async function commitSyncedSubtitleTrack(params: {
  bridge: Pick<PlayerBridge, "addSubtitle" | "setSubDelay">;
  engine: "html5" | "mpv";
  chosenUrl: string;
  retimedPath: string | null;
  retimedText: string;
  format: SupportedTextSubFormat;
  lang?: string;
  title?: string;
  baseMetadata: SubtitleLoadMetadata;
  rawFilename?: string;
  replaceExisting: boolean;
  replaceTrackId?: string;
  commitOrigin: SubtitleSelectionOrigin;
  getCurrentTracks: () => readonly TrackInfo[];
  isStillCurrent: () => boolean;
}): Promise<{
  ok: boolean;
  committedTrackId: string | null;
  committedTrackKey: string | null;
}> {
  const {
    bridge,
    engine,
    chosenUrl,
    retimedPath,
    retimedText,
    format,
    lang,
    title,
    baseMetadata,
    rawFilename,
    replaceExisting,
    replaceTrackId,
    commitOrigin,
    getCurrentTracks,
    isStillCurrent,
  } = params;

  let playableUrl: string;
  let cleanup = () => {};
  if (engine === "mpv") {
    if (!retimedPath) {
      return { ok: false, committedTrackId: null, committedTrackKey: null };
    }
    playableUrl = retimedPath;
  } else {
    const blob = createTextBlobUrl(retimedText);
    playableUrl = blob.url;
    cleanup = blob.cleanup;
  }

  const cues = parseSubtitle(retimedText, format);
  registerPreparedSubtitle({
    originalUrl: chosenUrl || playableUrl,
    playableUrl,
    format,
    cues,
    text: retimedText,
    encoding: "utf-8",
    encodingHealth: 1,
    encodingDiagnostics: [],
    release: baseMetadata.release,
    rawFilename: rawFilename ?? `synced.${format}`,
    archive: false,
    cleanup,
  });

  const ok = await bridge.addSubtitle(
    playableUrl,
    lang,
    title,
    true,
    {
      ...baseMetadata,
      originalUrl: chosenUrl || playableUrl,
      format,
      prepared: true,
      autoSynced: true,
      replaceExisting,
      replaceTrackId,
    },
    commitOrigin,
  );

  if (!ok) {
    takePreparedSubtitle(playableUrl)?.cleanup();
    return { ok: false, committedTrackId: null, committedTrackKey: null };
  }
  if (!isStillCurrent()) {
    return { ok: false, committedTrackId: null, committedTrackKey: null };
  }

  const tracks = getCurrentTracks();
  const committedTrack =
    tracks.find(
      (t) =>
        t.selected &&
        t.autoSynced === true &&
        (!replaceTrackId || t.id !== replaceTrackId),
    ) ?? null;
  // Pre-seed the deterministic source key because HTML5 emits snapshot updates asynchronously
  // after addSubtitle resolves and liveSnapRef may still hold pre-commit tracks here.
  const deterministicKey = normalizeUrlKey(chosenUrl || playableUrl);

  bridge.setSubDelay(0);
  return {
    ok: true,
    committedTrackId: committedTrack?.id ?? null,
    committedTrackKey: committedTrack ? trackAutoSyncKey(committedTrack) : deterministicKey,
  };
}

export async function restoreRevertedSubtitleTrack(params: {
  bridge: Pick<PlayerBridge, "addSubtitle" | "setSubtitleTrack" | "setSubDelay">;
  applied: AppliedAutoSyncState;
  currentSelected: TrackInfo | null;
  engine: "html5" | "mpv";
  commitOrigin: SubtitleSelectionOrigin;
}): Promise<boolean> {
  const { bridge, applied, currentSelected, engine, commitOrigin } = params;
  if (!applied.changed) return false;
  if (
    currentSelected &&
    currentSelected.autoSynced === true &&
    !matchesCommittedSyncedTrack(applied, currentSelected)
  ) {
    return false;
  }

  if (applied.replacedSelected && applied.originalTrack) {
    const orig = applied.originalTrack;
    const origUrl = orig.originalUrl || orig.url || orig.externalFilename || "";
    const backupFmt = applied.originalBackupFormat ?? normalizeTextSubFormat(orig.format);

    let playableUrl: string | null = null;
    let cleanup = () => {};
    let usedPrepared = false;

    if (engine === "mpv" && applied.originalBackupPath) {
      playableUrl = applied.originalBackupPath;
      usedPrepared = true;
    } else if (applied.originalBackupText != null && engine !== "mpv") {
      const blob = createTextBlobUrl(applied.originalBackupText);
      playableUrl = blob.url;
      cleanup = blob.cleanup;
      usedPrepared = true;
    } else if (origUrl) {
      playableUrl = origUrl;
    }

    if (playableUrl) {
      try {
        if (usedPrepared) {
          const text = applied.originalBackupText ?? "";
          registerPreparedSubtitle({
            originalUrl: origUrl || playableUrl,
            playableUrl,
            format: backupFmt,
            cues: text ? parseSubtitle(text, backupFmt) : [],
            text,
            encoding: "utf-8",
            encodingHealth: 1,
            encodingDiagnostics: [],
            release: orig.release,
            rawFilename: orig.externalFilename ?? `restored.${backupFmt}`,
            archive: false,
            cleanup,
          });
        }
        const ok = await bridge.addSubtitle(
          playableUrl,
          orig.lang,
          orig.title,
          true,
          {
            ...buildRestoreMetadata(orig),
            originalUrl: origUrl || playableUrl,
            format: backupFmt,
            ...(usedPrepared
              ? {
                  rawFilename: orig.externalFilename ?? `restored.${backupFmt}`,
                  prepared: true,
                }
              : {}),
            autoSynced: false,
            replaceExisting: true,
            replaceTrackId: currentSelected?.id,
          },
          commitOrigin,
        );
        if (!ok && usedPrepared) {
          takePreparedSubtitle(playableUrl)?.cleanup();
        }
        return ok;
      } finally {
        bridge.setSubDelay(applied.subDelayBefore);
      }
    }
  }

  if (applied.originalTrackId) {
    bridge.setSubtitleTrack(applied.originalTrackId, commitOrigin);
    bridge.setSubDelay(applied.subDelayBefore);
    return true;
  }
  return false;
}

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

export type AutoSyncRunTarget = {
  sourceTrack: TrackInfo;
  selectedInput: SubtitleCandidateInput;
  replaceTrackId: string;
  preservedApplied: AppliedAutoSyncState | null;
};

function isRetimedAutosyncPath(value: string | null | undefined): boolean {
  return typeof value === "string" && /(?:^|[\\/])autosync_(?!orig_)/i.test(value);
}

/**
 * Resolves the original pre-sync source when re-running auto-sync on an already synced track
 * so repeated clicks of "Re-sync" align the un-retimed source and preserve backup/delay state.
 */
export function resolveAutoSyncRunTarget(params: {
  currentSelected: TrackInfo;
  applied: AppliedAutoSyncState;
  currentMediaKey: string;
  season?: number;
  episode?: number;
}): AutoSyncRunTarget | null {
  const { currentSelected, applied, currentMediaKey, season, episode } = params;
  if (!currentSelected.autoSynced) {
    const selectedInput = buildSelectedCandidateInput(currentSelected, { season, episode });
    if (!selectedInput) return null;
    return {
      sourceTrack: currentSelected,
      selectedInput,
      replaceTrackId: currentSelected.id,
      preservedApplied: null,
    };
  }

  const sameApplied =
    applied.changed &&
    applied.scope?.mediaKey === currentMediaKey &&
    matchesCommittedSyncedTrack(applied, currentSelected);

  if (sameApplied && applied.replacedSelected && applied.originalTrack) {
    const orig = applied.originalTrack;
    const origSanitized: TrackInfo = isRetimedAutosyncPath(orig.externalFilename)
      ? { ...orig, externalFilename: undefined, prepared: false }
      : orig;
    const selectedInput = buildSelectedCandidateInput(origSanitized, { season, episode });
    if (!selectedInput) return null;
    if (applied.originalBackupPath && !isRetimedAutosyncPath(applied.originalBackupPath)) {
      selectedInput.localPath = applied.originalBackupPath;
    }
    if (applied.originalBackupText != null) {
      selectedInput.inlineText = applied.originalBackupText;
      selectedInput.format = applied.originalBackupFormat ?? selectedInput.format;
    }
    return {
      sourceTrack: orig,
      selectedInput,
      replaceTrackId: currentSelected.id,
      preservedApplied: applied,
    };
  }

  // Fallback for an auto-synced alternative track or restored UI state: use its original URL
  // while stripping the temporary `autosync_*` retimed filename so we never feed retimed text back.
  const externalTemp = isRetimedAutosyncPath(currentSelected.externalFilename);
  const sourceUrl =
    currentSelected.originalUrl || (!externalTemp ? currentSelected.url : undefined);
  if (!sourceUrl || isRetimedAutosyncPath(sourceUrl)) return null;
  const sanitized: TrackInfo = {
    ...currentSelected,
    url: sourceUrl,
    originalUrl: sourceUrl,
    externalFilename: externalTemp ? undefined : currentSelected.externalFilename,
    prepared: externalTemp ? false : currentSelected.prepared,
  };
  const selectedInput = buildSelectedCandidateInput(sanitized, { season, episode });
  if (!selectedInput) return null;
  return {
    sourceTrack: sanitized,
    selectedInput,
    replaceTrackId: currentSelected.id,
    preservedApplied: sameApplied ? applied : null,
  };
}

export function buildSelectedCandidateInput(
  track: TrackInfo,
  context?: { season?: number; episode?: number },
): SubtitleCandidateInput | null {
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
    release: track.release,
    filename: track.externalFilename,
    season: context?.season,
    episode: context?.episode,
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
