import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot } from "@/lib/player/bridge";
import { isLocalUrl } from "@/lib/player/local-url";
import { resetMpvSubtitleFpsForTransition } from "@/lib/player/mpv-properties";
import {
  buildSubtitleTimingMediaKey,
  isAutoSyncScopeCurrent,
  runAfterSubtitleFpsReset,
} from "@/lib/player/subtitle-fps";
import type { Settings } from "@/lib/settings";
import { isDesktopTauri } from "@/lib/platform";
import { dwarn } from "@/lib/debug";
import {
  alignSubtitlesAgainstEmbedded,
  cancelSubtitleAutoSync,
  collectSameLanguageCandidates,
  prefetchEmbeddedSubtitles,
  resolveAutoSyncScope,
  trackAutoSyncKey,
  type AutoSyncTrigger,
} from "@/lib/subtitles/autosync/embedded-sync";
import type { SubResult } from "@/lib/subtitles/types";
import type { PlayerSrc } from "@/lib/view";
import {
  buildRestoreMetadata,
  canPrefetchEmbeddedMedia,
  commitSyncedSubtitleTrack,
  EMPTY_APPLIED_STATE,
  isAutoSyncEligibleMedia,
  matchesCommittedSyncedTrack,
  normalizeTextSubFormat,
  normalizeUrlKey,
  resolveAutoSyncRunTarget,
  restoreRevertedSubtitleTrack,
  shouldResetAutoSyncOnTrackChange,
  type AppliedAutoSyncState,
  type AutoSyncScope,
} from "./use-auto-sync.helpers";

export type AutoSyncStatus =
  | "idle"
  | "analyzing"
  | "reverting"
  | "synced"
  | "within-tolerance"
  | "no-fit"
  | "no-embedded"
  | "error";

export type AutoSyncHandle = {
  status: AutoSyncStatus;
  trigger: AutoSyncTrigger;
  offsetMs: number | null;
  scale: number | null;
  withinTolerance: boolean;
  canRevert: boolean;
  errorMessage: string | null;
  errorAction?: "run" | "revert";
  noticeSeq?: number;
  transitioningTrack?: boolean;
  run: () => void;
  stop: () => void;
  revert: () => void;
  dismiss: () => void;
  suspendForManualTiming?: () => void;
};

function isSyncedTrack(t: { autoSynced?: boolean } | null | undefined): boolean {
  return t?.autoSynced === true;
}

function autoSyncMediaKey(src: PlayerSrc): string {
  return buildSubtitleTimingMediaKey({
    sourceUrl: src.url,
    mediaId: src.meta.id,
    season: src.episode?.season,
    episode: src.episode?.episode,
  });
}

function autoSyncRunKey(mediaKey: string, trackKey: string): string {
  return JSON.stringify([mediaKey, trackKey]);
}

function nextRunId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `autosync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useAutoSync(params: {
  bridgeRef: RefObject<PlayerBridge | null>;
  src: PlayerSrc;
  snap: PlayerSnapshot;
  engine: "html5" | "mpv";
  settings: Settings;
  subtitlePreflightSettled: boolean;
  availableSubtitles: readonly SubResult[];
}): AutoSyncHandle & { suspendForManualTiming: () => void } {
  const { bridgeRef, src, snap, engine, settings, subtitlePreflightSettled, availableSubtitles } =
    params;

  const [status, setStatus] = useState<AutoSyncStatus>("idle");
  const [trigger, setTrigger] = useState<AutoSyncTrigger>("automatic");
  const [offsetMs, setOffsetMs] = useState<number | null>(null);
  const [scale, setScale] = useState<number | null>(null);
  const [withinTolerance, setWithinTolerance] = useState(false);
  const [canRevert, setCanRevert] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [errorAction, setErrorAction] = useState<"run" | "revert">("run");
  const [noticeSeq, setNoticeSeq] = useState(0);
  const [transitioningTrack, setTransitioningTrack] = useState(false);

  const statusRef = useRef<AutoSyncStatus>("idle");
  statusRef.current = status;
  const transitionTimerRef = useRef<number | null>(null);

  const setAutoSyncStatus = useCallback((next: AutoSyncStatus, bumpNotice = false) => {
    statusRef.current = next;
    setStatus(next);
    if (bumpNotice) {
      setNoticeSeq((seq) => seq + 1);
    }
  }, []);

  const clearTransitionTimer = useCallback(() => {
    if (transitionTimerRef.current != null) {
      window.clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
  }, []);

  const beginTrackTransition = useCallback(() => {
    clearTransitionTimer();
    setTransitioningTrack(true);
  }, [clearTransitionTimer]);

  const endTrackTransition = useCallback(() => {
    clearTransitionTimer();
    setTransitioningTrack(false);
  }, [clearTransitionTimer]);

  const scheduleTrackTransitionTimeout = useCallback(() => {
    clearTransitionTimer();
    transitionTimerRef.current = window.setTimeout(() => {
      transitionTimerRef.current = null;
      setTransitioningTrack(false);
    }, 2100);
  }, [clearTransitionTimer]);

  const prefetchedUrlRef = useRef<string | null>(null);
  const attemptedRef = useRef<{ mediaKey: string; keys: Set<string> }>({
    mediaKey: "",
    keys: new Set(),
  });
  const revertedRef = useRef<{ mediaKey: string; keys: Set<string> }>({
    mediaKey: "",
    keys: new Set(),
  });
  const appliedRef = useRef<AppliedAutoSyncState>({ ...EMPTY_APPLIED_STATE });
  const activeRunIdRef = useRef<string | null>(null);
  const activeDisposeRef = useRef<(() => void) | null>(null);
  const revertTokenRef = useRef(0);
  const statusScopeRef = useRef<AutoSyncScope | null>(null);
  const committingScopeRef = useRef<AutoSyncScope | null>(null);
  const awaitingCommitRef = useRef<{
    mediaKey: string;
    deadlineMs: number;
    replacedTrackId?: string;
  } | null>(null);
  const triggerRef = useRef<AutoSyncTrigger>("automatic");
  const manualTimingMediaRef = useRef<string | null>(null);

  const liveSnapRef = useRef(snap);
  const srcRef = useRef(src);
  const engineRef = useRef(engine);
  const settingsRef = useRef(settings);
  const availableSubsRef = useRef(availableSubtitles);

  liveSnapRef.current = snap;
  srcRef.current = src;
  engineRef.current = engine;
  settingsRef.current = settings;
  availableSubsRef.current = availableSubtitles;

  const selected = snap.subtitleTracks.find((t) => t.selected) ?? null;
  const selectedSynced = isSyncedTrack(selected);
  const selectedTrackKey = selected ? trackAutoSyncKey(selected) : null;
  const mediaKey = autoSyncMediaKey(src);

  const ready =
    settings.subtitleAutoSync === true &&
    subtitlePreflightSettled &&
    isAutoSyncEligibleMedia(src.url, snap.durationSec, src.isLive) &&
    selected?.external === true &&
    !selectedSynced;

  const runKey = ready && selectedTrackKey ? autoSyncRunKey(mediaKey, selectedTrackKey) : null;

  const runWithSubtitleFpsReset = useCallback(
    (
      action: () => void | Promise<void>,
      cancelled?: { current: boolean },
      isCurrent: () => boolean = () => true,
    ) =>
      runAfterSubtitleFpsReset(
        () =>
          engineRef.current === "mpv" ? resetMpvSubtitleFpsForTransition() : Promise.resolve(),
        action,
        (error) => {
          dwarn("[auto-sync] subtitle FPS reset failed", error);
          if (!cancelled?.current) {
            setErrorAction("run");
            setErrorMessage(error instanceof Error ? error.message : String(error));
            statusRef.current = "error";
            setStatus("error");
            setNoticeSeq((seq) => seq + 1);
          }
        },
        () => cancelled?.current !== true && isCurrent(),
      ),
    [],
  );

  const isCurrentAutoSyncScope = useCallback((scope: AutoSyncScope | null) => {
    const curMediaKey = autoSyncMediaKey(srcRef.current);
    if (manualTimingMediaRef.current === curMediaKey) return false;
    if (
      scope != null &&
      committingScopeRef.current?.mediaKey === scope.mediaKey &&
      committingScopeRef.current?.trackId === scope.trackId
    ) {
      return scope.mediaKey === curMediaKey;
    }
    const currentSelected =
      liveSnapRef.current.subtitleTracks.find((track) => track.selected) ?? null;
    return isAutoSyncScopeCurrent(scope, {
      mediaKey: curMediaKey,
      trackId: currentSelected?.id ?? null,
      syncedTrack: isSyncedTrack(currentSelected),
    });
  }, []);

  // Unmount cleanup cancels any active backend auto-sync task.
  useEffect(
    () => () => {
      revertTokenRef.current += 1;
      activeDisposeRef.current?.();
      activeDisposeRef.current = null;
      committingScopeRef.current = null;
      awaitingCommitRef.current = null;
      clearTransitionTimer();
    },
    [clearTransitionTimer],
  );

  // Reset per-media caches & state whenever mediaKey changes.
  useEffect(() => {
    revertTokenRef.current += 1;
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    committingScopeRef.current = null;
    awaitingCommitRef.current = null;
    endTrackTransition();
    triggerRef.current = "automatic";
    appliedRef.current = { ...EMPTY_APPLIED_STATE };
    statusScopeRef.current = null;
    setAutoSyncStatus("idle", false);
    setTrigger("automatic");
    setOffsetMs(null);
    setScale(null);
    setWithinTolerance(false);
    setCanRevert(false);
    setErrorMessage(null);
    setErrorAction("run");
  }, [endTrackTransition, mediaKey, setAutoSyncStatus]);

  // Cancel in-flight automatic analysis if the user turns off the setting before commit begins.
  useEffect(() => {
    if (
      settings.subtitleAutoSync === false &&
      triggerRef.current === "automatic" &&
      committingScopeRef.current == null &&
      activeRunIdRef.current != null
    ) {
      activeDisposeRef.current?.();
      activeDisposeRef.current = null;
      statusScopeRef.current = null;
      setAutoSyncStatus("idle", false);
    }
  }, [setAutoSyncStatus, settings.subtitleAutoSync]);

  // Prefetch embedded MKV/MP4 subtitle timeline index once VOD media is ready with auto-sync on.
  // Wait for first frame or known duration on non-local URLs so eager range probes do not race
  // mpv against on-demand addon resolvers (e.g. StremList offline download polling).
  useEffect(() => {
    if (settings.subtitleAutoSync !== true || !isDesktopTauri()) return;
    if (!canPrefetchEmbeddedMedia(src.url, src.isLive)) return;
    const mediaReady = isLocalUrl(src.url) || snap.firstFrameReady || snap.durationSec > 0;
    if (!mediaReady) return;
    if (prefetchedUrlRef.current === src.url) return;
    prefetchedUrlRef.current = src.url;
    void prefetchEmbeddedSubtitles(src.url, src.headers).catch((err) => {
      dwarn("[auto-sync] embedded index prefetch failed", err);
    });
  }, [
    settings.subtitleAutoSync,
    src.url,
    src.headers,
    src.isLive,
    snap.firstFrameReady,
    snap.durationSec,
  ]);

  const beginRun = useCallback(
    (manual: boolean): (() => void) | null => {
      const b = bridgeRef.current;
      const curSrc = srcRef.current;
      const curSnap = liveSnapRef.current;
      const curSettings = settingsRef.current;
      const curSelected = curSnap.subtitleTracks.find((t) => t.selected) ?? null;
      if (!b || !curSelected?.external || !curSrc.url || curSrc.isLive) return null;
      if (!isDesktopTauri()) {
        if (manual) {
          triggerRef.current = "manual";
          setTrigger("manual");
          setErrorAction("run");
          setErrorMessage("Embedded subtitle auto-sync requires desktop runtime.");
          setAutoSyncStatus("error", true);
        }
        return null;
      }

      const curMediaKey = autoSyncMediaKey(curSrc);
      const runTarget = resolveAutoSyncRunTarget({
        currentSelected: curSelected,
        applied: appliedRef.current,
        currentMediaKey: curMediaKey,
        season: curSrc.episode?.season,
        episode: curSrc.episode?.episode,
        getInlineCues: () => b.getSelectedTrackCues?.(),
      });
      if (!runTarget) {
        if (manual) {
          triggerRef.current = "manual";
          setTrigger("manual");
          setErrorAction("run");
          setErrorMessage(
            curSelected.autoSynced
              ? "Original subtitle source is unavailable for re-sync."
              : "Subtitle source is unavailable for auto-sync.",
          );
          setAutoSyncStatus("error", true);
        }
        return null;
      }
      const {
        sourceTrack,
        selectedInput,
        replaceTrackId: resyncReplaceTrackId,
        preservedApplied,
      } = runTarget;

      if (manual) {
        if (manualTimingMediaRef.current === curMediaKey) {
          manualTimingMediaRef.current = null;
        }
        if (revertedRef.current.mediaKey === curMediaKey) {
          revertedRef.current.keys.delete(trackAutoSyncKey(curSelected));
          revertedRef.current.keys.delete(trackAutoSyncKey(sourceTrack));
        }
      }

      revertTokenRef.current += 1;
      activeDisposeRef.current?.();
      activeDisposeRef.current = null;
      committingScopeRef.current = null;
      awaitingCommitRef.current = null;

      const scope: AutoSyncScope = { mediaKey: curMediaKey, trackId: curSelected.id };
      statusScopeRef.current = scope;
      const cancelled = { current: false };
      const runId = nextRunId();
      const prevRunId = activeRunIdRef.current;
      if (prevRunId && prevRunId !== runId) {
        void cancelSubtitleAutoSync(prevRunId);
      }
      activeRunIdRef.current = runId;

      const dispose = () => {
        cancelled.current = true;
        if (activeRunIdRef.current === runId) {
          activeRunIdRef.current = null;
          void cancelSubtitleAutoSync(runId);
        }
      };
      activeDisposeRef.current = dispose;

      const runTrigger: AutoSyncTrigger = manual ? "manual" : "automatic";
      triggerRef.current = runTrigger;
      const selectionOrigin = b.getSubtitleSelectionOrigin?.() ?? "automatic";
      const candidateScope = resolveAutoSyncScope(runTrigger, selectionOrigin);
      const trackKey = trackAutoSyncKey(sourceTrack);
      const selectedSourceUrl = selectedInput.url;
      const selectedSourceNorm = normalizeUrlKey(selectedSourceUrl);
      const candidates =
        candidateScope === "selected_only"
          ? []
          : collectSameLanguageCandidates(
              sourceTrack,
              availableSubsRef.current,
              curSnap.subtitleTracks,
              12,
              {
                season: curSrc.episode?.season,
                episode: curSrc.episode?.episode,
              },
            );

      setTrigger(runTrigger);
      setErrorMessage(null);
      setErrorAction("run");
      setWithinTolerance(false);
      setAutoSyncStatus("analyzing", manual);

      const isCurrent = () =>
        !cancelled.current && isCurrentAutoSyncScope(scope) && statusScopeRef.current === scope;

      void alignSubtitlesAgainstEmbedded({
        runId,
        mediaUrl: curSrc.url,
        mediaHeaders: curSrc.headers,
        mode: curSettings.autoSyncMode,
        toleranceMs: curSettings.autoSyncToleranceMs,
        scope: candidateScope,
        selectedTrack: selectedInput,
        candidates,
      })
        .then((res) => {
          if (activeRunIdRef.current === runId) {
            activeRunIdRef.current = null;
          }
          if (!isCurrent()) return;

          switch (res.outcome) {
            case "cancelled":
              return;
            case "no_subtitle_tracks":
            case "no_usable_reference":
              if (!appliedRef.current.changed) {
                setOffsetMs(null);
                setScale(null);
              }
              setWithinTolerance(false);
              setAutoSyncStatus("no-embedded", true);
              return;
            case "container_unavailable":
              if (!appliedRef.current.changed) {
                setOffsetMs(null);
                setScale(null);
              }
              setWithinTolerance(false);
              setErrorAction("run");
              setErrorMessage("Could not reach video stream for subtitle alignment.");
              setAutoSyncStatus(manual ? "error" : "idle", manual);
              return;
            case "within_tolerance":
              setOffsetMs(res.medianOffsetMs);
              setScale(res.scale);
              setWithinTolerance(true);
              setAutoSyncStatus("within-tolerance", true);
              return;
            case "no_fit":
              if (!appliedRef.current.changed) {
                setOffsetMs(null);
                setScale(null);
              }
              setWithinTolerance(false);
              setAutoSyncStatus("no-fit", true);
              return;
            case "inconclusive":
              if (!appliedRef.current.changed) {
                setOffsetMs(null);
                setScale(null);
              }
              setWithinTolerance(false);
              setAutoSyncStatus(manual ? "no-fit" : "idle", manual);
              return;
            case "synced": {
              const body = res.retimedText;
              const fmt = normalizeTextSubFormat(res.format);
              if (!body) {
                setAutoSyncStatus("no-fit", true);
                return;
              }

              const chosenUrl = res.chosenUrl || selectedSourceUrl;
              const chosenNorm = normalizeUrlKey(chosenUrl);
              const matchedSelected = chosenNorm !== "" && chosenNorm === selectedSourceNorm;
              const matchedExistingTrack = matchedSelected
                ? curSelected
                : (liveSnapRef.current.subtitleTracks.find(
                    (t) =>
                      t.external &&
                      ((t.originalUrl && normalizeUrlKey(t.originalUrl) === chosenNorm) ||
                        (t.url && normalizeUrlKey(t.url) === chosenNorm) ||
                        (t.externalFilename && normalizeUrlKey(t.externalFilename) === chosenNorm)),
                  ) ?? null);
              const matchedResult =
                matchedExistingTrack == null
                  ? (availableSubsRef.current.find((r) => normalizeUrlKey(r.url) === chosenNorm) ??
                    null)
                  : null;

              const targetLang =
                matchedExistingTrack?.lang ??
                matchedResult?.lang ??
                sourceTrack.lang ??
                curSelected.lang;
              const targetTitle =
                matchedExistingTrack?.title ??
                matchedResult?.title ??
                sourceTrack.title ??
                curSelected.title ??
                `Synced (${fmt.toUpperCase()})`;
              const baseMetadata = matchedExistingTrack
                ? buildRestoreMetadata(matchedExistingTrack)
                : matchedResult
                  ? {
                      originalUrl: matchedResult.url,
                      downloadAuth: matchedResult.downloadAuth,
                      format: matchedResult.format,
                      release: matchedResult.release,
                      provider: matchedResult.upstreamProvider ?? matchedResult.source,
                      providerDerived: matchedResult.localTrusted !== true,
                      localTrusted: matchedResult.localTrusted,
                      fps: matchedResult.fps,
                      downloads: matchedResult.downloads,
                      author: matchedResult.author,
                      uploadedAt: matchedResult.uploadedAt,
                      rating: matchedResult.rating,
                      productionType: matchedResult.productionType,
                      releaseType: matchedResult.releaseType,
                      hearingImpaired: matchedResult.hearingImpaired,
                      forced: matchedResult.forced,
                      foreignOnly: matchedResult.foreignOnly,
                      machineTranslated: matchedResult.machineTranslated,
                      fromTrusted: matchedResult.fromTrusted,
                      providerMatch: matchedResult.providerMatch,
                      subId: matchedResult.id,
                    }
                  : {
                      originalUrl: chosenUrl,
                      providerDerived: true,
                      localTrusted: false,
                    };

              const replaceExisting = preservedApplied != null || matchedExistingTrack != null;
              const replaceTrackId =
                preservedApplied != null ? resyncReplaceTrackId : matchedExistingTrack?.id;
              const subDelayBefore = preservedApplied?.changed
                ? preservedApplied.subDelayBefore
                : liveSnapRef.current.subDelaySec;

              void runWithSubtitleFpsReset(
                async () => {
                  if (!isCurrent()) return;
                  const commitOrigin = manual
                    ? "manual"
                    : (b.getSubtitleSelectionOrigin?.() ?? "automatic");
                  beginTrackTransition();
                  committingScopeRef.current = scope;
                  let commitRes: {
                    ok: boolean;
                    committedTrackId: string | null;
                    committedTrackKey: string | null;
                    staleCommit?: boolean;
                  };
                  try {
                    commitRes = await commitSyncedSubtitleTrack({
                      bridge: b,
                      engine: engineRef.current,
                      chosenUrl,
                      retimedPath: res.retimedPath,
                      retimedText: body,
                      format: fmt,
                      lang: targetLang,
                      title: targetTitle,
                      baseMetadata,
                      rawFilename:
                        (!curSelected.autoSynced
                          ? matchedExistingTrack?.externalFilename
                          : undefined) ??
                        sourceTrack.externalFilename ??
                        `synced.${fmt}`,
                      replaceExisting,
                      replaceTrackId,
                      commitOrigin,
                      getCurrentTracks: () => liveSnapRef.current.subtitleTracks,
                      isStillCurrent: isCurrent,
                    });
                    if (!commitRes.ok) {
                      endTrackTransition();
                      if (isCurrent()) {
                        setErrorAction("run");
                        setErrorMessage("Could not load synced subtitle track.");
                        setAutoSyncStatus("error", true);
                      }
                      return;
                    }
                  } finally {
                    if (committingScopeRef.current === scope) {
                      committingScopeRef.current = null;
                    }
                  }

                  const curSelAfter =
                    liveSnapRef.current.subtitleTracks.find((t) => t.selected) ?? null;
                  const backupFmt = res.selectedOriginalFormat
                    ? normalizeTextSubFormat(res.selectedOriginalFormat)
                    : null;
                  const nextApplied: AppliedAutoSyncState = {
                    originalTrack: preservedApplied?.originalTrack ?? sourceTrack,
                    replacedSelected: preservedApplied?.replacedSelected ?? matchedSelected,
                    originalTrackId: preservedApplied?.originalTrackId ?? sourceTrack.id,
                    originalTrackKey: preservedApplied?.originalTrackKey ?? trackKey,
                    committedTrackId: commitRes.committedTrackId,
                    committedTrackKey: commitRes.committedTrackKey,
                    originalBackupPath:
                      preservedApplied?.originalBackupPath ?? res.selectedOriginalPath ?? null,
                    originalBackupText:
                      preservedApplied?.originalBackupText ?? res.selectedOriginalText ?? null,
                    originalBackupFormat: preservedApplied?.originalBackupFormat ?? backupFmt,
                    subDelayBefore,
                    offsetMs: res.medianOffsetMs,
                    scale: res.scale,
                    scope,
                    changed: true,
                  };

                  if (commitRes.staleCommit) {
                    endTrackTransition();
                    const stillSameTrackOrSynced =
                      curSelAfter != null &&
                      (isSyncedTrack(curSelAfter) || curSelAfter.id === scope.trackId);
                    if (
                      stillSameTrackOrSynced &&
                      activeRunIdRef.current == null &&
                      autoSyncMediaKey(srcRef.current) === scope.mediaKey &&
                      manualTimingMediaRef.current !== scope.mediaKey
                    ) {
                      appliedRef.current = nextApplied;
                      setCanRevert(true);
                    }
                    return;
                  }

                  if (
                    curSelAfter &&
                    !isSyncedTrack(curSelAfter) &&
                    curSelAfter.id !== scope.trackId
                  ) {
                    endTrackTransition();
                    return;
                  }

                  const commitStillPending =
                    !isSyncedTrack(curSelAfter) ||
                    (replaceExisting &&
                      replaceTrackId != null &&
                      curSelAfter?.id === replaceTrackId);

                  if (commitStillPending) {
                    // Both mpv (IPC event lag) and HTML5 (deferred React snapshot commit)
                    // may surface the newly selected synced track after addSubtitle resolves.
                    awaitingCommitRef.current = {
                      mediaKey: scope.mediaKey,
                      deadlineMs: Date.now() + 2000,
                      replacedTrackId: replaceExisting ? replaceTrackId : undefined,
                    };
                    scheduleTrackTransitionTimeout();
                  } else {
                    awaitingCommitRef.current = null;
                    endTrackTransition();
                  }

                  appliedRef.current = nextApplied;

                  setOffsetMs(res.medianOffsetMs);
                  setScale(res.scale);
                  setWithinTolerance(false);
                  setCanRevert(true);
                  setErrorAction("run");
                  setAutoSyncStatus("synced", true);
                },
                cancelled,
                isCurrent,
              );
              return;
            }
          }
        })
        .catch((err) => {
          if (activeRunIdRef.current === runId) {
            activeRunIdRef.current = null;
          }
          if (!isCurrent()) return;
          dwarn("[auto-sync] alignment failed", err);
          setErrorAction("run");
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setAutoSyncStatus("error", true);
        });

      return dispose;
    },
    [
      beginTrackTransition,
      bridgeRef,
      endTrackTransition,
      isCurrentAutoSyncScope,
      runWithSubtitleFpsReset,
      scheduleTrackTransitionTimeout,
      setAutoSyncStatus,
    ],
  );

  // Sync committed track identity once mpv/HTML5 emits the new synced track, and reset when switching tracks.
  useEffect(() => {
    if (selectedSynced && selected && appliedRef.current.changed) {
      const waitingReplacedId =
        awaitingCommitRef.current?.mediaKey === mediaKey
          ? awaitingCommitRef.current.replacedTrackId
          : undefined;
      if (!waitingReplacedId || selected.id !== waitingReplacedId) {
        if (awaitingCommitRef.current?.mediaKey === mediaKey) {
          awaitingCommitRef.current = null;
          endTrackTransition();
        }
        if (!appliedRef.current.committedTrackId) {
          appliedRef.current.committedTrackId = selected.id;
          appliedRef.current.committedTrackKey = trackAutoSyncKey(selected);
        }
      } else if (
        awaitingCommitRef.current?.mediaKey === mediaKey &&
        Date.now() <= awaitingCommitRef.current.deadlineMs
      ) {
        // Still rendering the superseded synced track prior to Re-sync replacement; wait for new track.
        return;
      }
    }

    const awaitingCommit =
      awaitingCommitRef.current?.mediaKey === mediaKey &&
      Date.now() <= awaitingCommitRef.current.deadlineMs;
    if (!selected && awaitingCommit) {
      return;
    }

    if (selected && !selectedSynced && awaitingCommit) {
      if (
        selected.id === statusScopeRef.current?.trackId ||
        trackAutoSyncKey(selected) === appliedRef.current.originalTrackKey
      ) {
        return;
      }
      awaitingCommitRef.current = null;
      endTrackTransition();
    }

    if (
      shouldResetAutoSyncOnTrackChange({
        mediaKey,
        selected,
        selectedSynced,
        committingScope: committingScopeRef.current,
        statusScope: statusScopeRef.current,
        applied: appliedRef.current,
      })
    ) {
      revertTokenRef.current += 1;
      activeDisposeRef.current?.();
      activeDisposeRef.current = null;
      committingScopeRef.current = null;
      awaitingCommitRef.current = null;
      endTrackTransition();
      statusScopeRef.current = null;
      appliedRef.current = { ...EMPTY_APPLIED_STATE };
      setCanRevert(false);
      setOffsetMs(null);
      setScale(null);
      setWithinTolerance(false);
      setErrorMessage(null);
      setErrorAction("run");
      setAutoSyncStatus("idle", false);
    }
  }, [endTrackTransition, mediaKey, selected, selectedSynced, setAutoSyncStatus]);

  // Automatic trigger when a non-synced external track becomes active & preflight settles.
  useEffect(() => {
    if (!runKey || !selectedTrackKey) return;
    if (manualTimingMediaRef.current === mediaKey) return;
    if (revertedRef.current.mediaKey !== mediaKey) {
      revertedRef.current = { mediaKey, keys: new Set() };
    }
    if (revertedRef.current.keys.has(selectedTrackKey)) return;

    if (attemptedRef.current.mediaKey !== mediaKey) {
      attemptedRef.current = { mediaKey, keys: new Set() };
    }
    if (attemptedRef.current.keys.has(selectedTrackKey)) return;
    attemptedRef.current.keys.add(selectedTrackKey);

    beginRun(false);
  }, [runKey, mediaKey, selectedTrackKey, beginRun]);

  const revert = useCallback(() => {
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    committingScopeRef.current = null;
    awaitingCommitRef.current = null;
    const token = ++revertTokenRef.current;
    const revertCancelled = { current: false };
    const b = bridgeRef.current;
    const a = appliedRef.current;
    const currentSelected = liveSnapRef.current.subtitleTracks.find((t) => t.selected) ?? null;
    const canRevertCurrent =
      a.changed &&
      isCurrentAutoSyncScope(a.scope) &&
      (!currentSelected ||
        !isSyncedTrack(currentSelected) ||
        matchesCommittedSyncedTrack(a, currentSelected));

    if (b && canRevertCurrent) {
      setErrorMessage(null);
      setErrorAction("run");
      setAutoSyncStatus("reverting", false);
      beginTrackTransition();
      const curMediaKey = autoSyncMediaKey(srcRef.current);
      const revertScope = a.scope;
      committingScopeRef.current = revertScope;
      activeDisposeRef.current = () => {
        revertCancelled.current = true;
        if (revertTokenRef.current === token) {
          revertTokenRef.current += 1;
        }
        if (committingScopeRef.current === revertScope) {
          committingScopeRef.current = null;
        }
      };
      if (a.originalTrackKey) {
        if (revertedRef.current.mediaKey !== curMediaKey) {
          revertedRef.current = { mediaKey: curMediaKey, keys: new Set() };
        }
        revertedRef.current.keys.add(a.originalTrackKey);
      }
      const isRevertCancelled = () =>
        revertCancelled.current ||
        revertTokenRef.current !== token ||
        autoSyncMediaKey(srcRef.current) !== curMediaKey;
      const commitOrigin = b.getSubtitleSelectionOrigin?.() ?? "automatic";
      void restoreRevertedSubtitleTrack({
        bridge: b,
        applied: a,
        currentSelected,
        availableTracks: liveSnapRef.current.subtitleTracks,
        engine: engineRef.current,
        commitOrigin,
        isCancelled: isRevertCancelled,
      }).then(
        (ok) => {
          if (committingScopeRef.current === revertScope) {
            committingScopeRef.current = null;
          }
          if (isRevertCancelled()) return;
          activeDisposeRef.current = null;
          endTrackTransition();
          if (!ok) {
            if (a.originalTrackKey && revertedRef.current.mediaKey === curMediaKey) {
              revertedRef.current.keys.delete(a.originalTrackKey);
            }
            triggerRef.current = "manual";
            setTrigger("manual");
            setCanRevert(true);
            setErrorAction("revert");
            setErrorMessage("Could not restore original subtitle track.");
            setAutoSyncStatus("error", true);
            return;
          }
          appliedRef.current = { ...EMPTY_APPLIED_STATE };
          statusScopeRef.current = null;
          setOffsetMs(null);
          setScale(null);
          setWithinTolerance(false);
          setCanRevert(false);
          setErrorMessage(null);
          setErrorAction("run");
          setAutoSyncStatus("idle", false);
        },
        () => {
          if (committingScopeRef.current === revertScope) {
            committingScopeRef.current = null;
          }
          if (isRevertCancelled()) return;
          activeDisposeRef.current = null;
          endTrackTransition();
          if (a.originalTrackKey && revertedRef.current.mediaKey === curMediaKey) {
            revertedRef.current.keys.delete(a.originalTrackKey);
          }
          triggerRef.current = "manual";
          setTrigger("manual");
          setCanRevert(true);
          setErrorAction("revert");
          setErrorMessage("Could not restore original subtitle track.");
          setAutoSyncStatus("error", true);
        },
      );
      return;
    }
    endTrackTransition();
    appliedRef.current = { ...EMPTY_APPLIED_STATE };
    statusScopeRef.current = null;
    setOffsetMs(null);
    setScale(null);
    setWithinTolerance(false);
    setCanRevert(false);
    setErrorMessage(null);
    setErrorAction("run");
    setAutoSyncStatus("idle", false);
  }, [
    beginTrackTransition,
    bridgeRef,
    endTrackTransition,
    isCurrentAutoSyncScope,
    setAutoSyncStatus,
  ]);

  const run = useCallback(() => {
    beginRun(true);
  }, [beginRun]);

  const stop = useCallback(() => {
    if (statusRef.current === "reverting") return;
    revertTokenRef.current += 1;
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    if (statusRef.current === "analyzing" && appliedRef.current.changed) {
      committingScopeRef.current = null;
      awaitingCommitRef.current = null;
      endTrackTransition();
      setOffsetMs(appliedRef.current.offsetMs);
      setScale(appliedRef.current.scale);
      setWithinTolerance(false);
      setErrorMessage(null);
      setErrorAction("run");
      setAutoSyncStatus("synced", false);
    } else if (appliedRef.current.changed) {
      revert();
    } else {
      committingScopeRef.current = null;
      awaitingCommitRef.current = null;
      endTrackTransition();
      statusScopeRef.current = null;
      setErrorMessage(null);
      setErrorAction("run");
      setAutoSyncStatus("idle", false);
    }
  }, [endTrackTransition, revert, setAutoSyncStatus]);

  const dismiss = useCallback(() => {
    setErrorMessage(null);
    setErrorAction("run");
    const curStatus = statusRef.current;
    if (curStatus === "analyzing" || curStatus === "reverting") return;
    if (appliedRef.current.changed) {
      setOffsetMs(appliedRef.current.offsetMs);
      setScale(appliedRef.current.scale);
      setWithinTolerance(false);
      setAutoSyncStatus("synced", false);
    } else {
      setAutoSyncStatus("idle", false);
    }
  }, [setAutoSyncStatus]);

  useEffect(() => {
    if (status === "idle") {
      endTrackTransition();
    }
  }, [endTrackTransition, status]);

  const suspendForManualTiming = useCallback(() => {
    // Unlike Stop/Revert, taking manual control must preserve the current offset.
    manualTimingMediaRef.current = autoSyncMediaKey(srcRef.current);
    revertTokenRef.current += 1;
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    committingScopeRef.current = null;
    awaitingCommitRef.current = null;
    appliedRef.current = { ...EMPTY_APPLIED_STATE };
    statusScopeRef.current = null;
    setCanRevert(false);
    setErrorMessage(null);
    setErrorAction("run");
    setStatus("idle");
  }, []);

  return {
    status,
    trigger,
    offsetMs,
    scale,
    withinTolerance,
    canRevert,
    errorMessage,
    errorAction,
    noticeSeq,
    transitioningTrack,
    run,
    stop,
    revert,
    dismiss,
    suspendForManualTiming,
  };
}
