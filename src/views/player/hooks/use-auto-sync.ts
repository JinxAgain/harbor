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
import { toSrt } from "@/lib/subtitles/serialize";
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
  run: () => void;
  stop: () => void;
  revert: () => void;
  dismiss: () => void;
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
            setErrorMessage(error instanceof Error ? error.message : String(error));
            setStatus("error");
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
      activeDisposeRef.current?.();
      activeDisposeRef.current = null;
      committingScopeRef.current = null;
      awaitingCommitRef.current = null;
    },
    [],
  );

  // Reset per-media caches & state whenever mediaKey changes.
  useEffect(() => {
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    committingScopeRef.current = null;
    awaitingCommitRef.current = null;
    triggerRef.current = "automatic";
    appliedRef.current = { ...EMPTY_APPLIED_STATE };
    statusScopeRef.current = null;
    setStatus("idle");
    setTrigger("automatic");
    setOffsetMs(null);
    setScale(null);
    setWithinTolerance(false);
    setCanRevert(false);
    setErrorMessage(null);
  }, [mediaKey]);

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
      setStatus("idle");
    }
  }, [settings.subtitleAutoSync]);

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
          setErrorMessage("Embedded subtitle auto-sync requires desktop runtime.");
          setStatus("error");
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
      });
      if (!runTarget) {
        if (manual) {
          triggerRef.current = "manual";
          setTrigger("manual");
          setErrorMessage("Original subtitle source is unavailable for re-sync.");
          setStatus("error");
        }
        return null;
      }
      const {
        sourceTrack,
        selectedInput,
        replaceTrackId: resyncReplaceTrackId,
        preservedApplied,
      } = runTarget;

      if (
        !selectedInput.localPath &&
        !selectedInput.inlineText &&
        !/^https?:/i.test(selectedInput.url) &&
        !curSelected.autoSynced
      ) {
        const inlineCues = b.getSelectedTrackCues?.();
        if (inlineCues && inlineCues.length > 0) {
          selectedInput.inlineText = toSrt(inlineCues);
          selectedInput.format = "srt";
        }
      }

      if (manual) {
        if (manualTimingMediaRef.current === curMediaKey) {
          manualTimingMediaRef.current = null;
        }
        if (revertedRef.current.mediaKey === curMediaKey) {
          revertedRef.current.keys.delete(trackAutoSyncKey(curSelected));
          revertedRef.current.keys.delete(trackAutoSyncKey(sourceTrack));
        }
      }

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
      setWithinTolerance(false);
      setStatus("analyzing");

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
              setOffsetMs(null);
              setScale(null);
              setWithinTolerance(false);
              setStatus("no-embedded");
              return;
            case "container_unavailable":
              setOffsetMs(null);
              setScale(null);
              setWithinTolerance(false);
              setErrorMessage("Could not reach video stream for subtitle alignment.");
              setStatus(manual ? "error" : "idle");
              return;
            case "within_tolerance":
              setOffsetMs(res.medianOffsetMs);
              setScale(res.scale);
              setWithinTolerance(true);
              setStatus("within-tolerance");
              return;
            case "no_fit":
              setOffsetMs(null);
              setScale(null);
              setWithinTolerance(false);
              setStatus("no-fit");
              return;
            case "inconclusive":
              setOffsetMs(null);
              setScale(null);
              setWithinTolerance(false);
              setStatus(manual ? "no-fit" : "idle");
              return;
            case "synced": {
              const body = res.retimedText;
              const fmt = normalizeTextSubFormat(res.format);
              if (!body) {
                setStatus("no-fit");
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
                      providerDerived: true,
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
                  : buildRestoreMetadata(sourceTrack);

              const replaceExisting = preservedApplied != null || matchedExistingTrack != null;
              const replaceTrackId =
                preservedApplied != null ? resyncReplaceTrackId : matchedExistingTrack?.id;
              const commitOrigin = b.getSubtitleSelectionOrigin?.() ?? "automatic";
              const subDelayBefore = preservedApplied?.changed
                ? preservedApplied.subDelayBefore
                : liveSnapRef.current.subDelaySec;

              void runWithSubtitleFpsReset(
                async () => {
                  if (!isCurrent()) return;
                  committingScopeRef.current = scope;
                  let commitRes: {
                    ok: boolean;
                    committedTrackId: string | null;
                    committedTrackKey: string | null;
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
                      if (isCurrent()) {
                        setErrorMessage("Could not load synced subtitle track.");
                        setStatus("error");
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
                  if (
                    curSelAfter &&
                    !isSyncedTrack(curSelAfter) &&
                    curSelAfter.id !== scope.trackId
                  ) {
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
                  } else {
                    awaitingCommitRef.current = null;
                  }

                  const backupFmt = res.selectedOriginalFormat
                    ? normalizeTextSubFormat(res.selectedOriginalFormat)
                    : null;
                  appliedRef.current = {
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
                    scope,
                    changed: true,
                  };

                  setOffsetMs(res.medianOffsetMs);
                  setScale(res.scale);
                  setWithinTolerance(false);
                  setCanRevert(true);
                  setStatus("synced");
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
          setErrorMessage(err instanceof Error ? err.message : String(err));
          setStatus("error");
        });

      return dispose;
    },
    [bridgeRef, isCurrentAutoSyncScope, runWithSubtitleFpsReset],
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
      activeDisposeRef.current?.();
      activeDisposeRef.current = null;
      committingScopeRef.current = null;
      awaitingCommitRef.current = null;
      statusScopeRef.current = null;
      appliedRef.current = { ...EMPTY_APPLIED_STATE };
      setCanRevert(false);
      setOffsetMs(null);
      setScale(null);
      setWithinTolerance(false);
      setErrorMessage(null);
      setStatus("idle");
    }
  }, [mediaKey, selected, selectedSynced]);

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
      const curMediaKey = autoSyncMediaKey(srcRef.current);
      if (a.originalTrackKey) {
        if (revertedRef.current.mediaKey !== curMediaKey) {
          revertedRef.current = { mediaKey: curMediaKey, keys: new Set() };
        }
        revertedRef.current.keys.add(a.originalTrackKey);
      }
      const commitOrigin = b.getSubtitleSelectionOrigin?.() ?? "automatic";
      void restoreRevertedSubtitleTrack({
        bridge: b,
        applied: a,
        currentSelected,
        engine: engineRef.current,
        commitOrigin,
      });
    }
    appliedRef.current = { ...EMPTY_APPLIED_STATE };
    statusScopeRef.current = null;
    setOffsetMs(null);
    setScale(null);
    setWithinTolerance(false);
    setCanRevert(false);
    setErrorMessage(null);
    setStatus("idle");
  }, [bridgeRef, isCurrentAutoSyncScope]);

  const run = useCallback(() => {
    beginRun(true);
  }, [beginRun]);

  const stop = useCallback(() => {
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    if (appliedRef.current.changed) {
      revert();
    } else {
      committingScopeRef.current = null;
      awaitingCommitRef.current = null;
      statusScopeRef.current = null;
      setStatus("idle");
    }
  }, [revert]);

  const dismiss = useCallback(() => {
    setErrorMessage(null);
    if (!appliedRef.current.changed && status !== "analyzing") {
      setStatus("idle");
    }
  }, [status]);

  const suspendForManualTiming = useCallback(() => {
    // Unlike Stop/Revert, taking manual control must preserve the current offset.
    manualTimingMediaRef.current = autoSyncMediaKey(srcRef.current);
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    committingScopeRef.current = null;
    awaitingCommitRef.current = null;
    appliedRef.current = { ...EMPTY_APPLIED_STATE };
    statusScopeRef.current = null;
    setCanRevert(false);
    setErrorMessage(null);
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
    run,
    stop,
    revert,
    dismiss,
    suspendForManualTiming,
  };
}
