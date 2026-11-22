import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot } from "@/lib/player/bridge";
import { resetMpvSubtitleFpsForTransition } from "@/lib/player/mpv-properties";
import {
  buildSubtitleTimingMediaKey,
  isAutoSyncScopeCurrent,
  runAfterSubtitleFpsReset,
} from "@/lib/player/subtitle-fps";
import type { Settings } from "@/lib/settings";
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
  buildSelectedCandidateInput,
  canPrefetchEmbeddedMedia,
  commitSyncedSubtitleTrack,
  EMPTY_APPLIED_STATE,
  isAutoSyncEligibleMedia,
  matchesCommittedSyncedTrack,
  normalizeTextSubFormat,
  normalizeUrlKey,
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

function isNativeTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

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
  const {
    bridgeRef,
    src,
    snap,
    engine,
    settings,
    subtitlePreflightSettled,
    availableSubtitles,
  } = params;

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
  const awaitingCommitRef = useRef<{ mediaKey: string; deadlineMs: number } | null>(null);
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

  const runKey =
    ready && selectedTrackKey ? autoSyncRunKey(mediaKey, selectedTrackKey) : null;

  const runWithSubtitleFpsReset = useCallback(
    (
      action: () => void | Promise<void>,
      cancelled?: { current: boolean },
      isCurrent: () => boolean = () => true,
    ) =>
      runAfterSubtitleFpsReset(
        () =>
          engineRef.current === "mpv"
            ? resetMpvSubtitleFpsForTransition()
            : Promise.resolve(),
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

  // Prefetch embedded MKV/MP4 subtitle timeline index as soon as VOD media loads with auto-sync on.
  useEffect(() => {
    if (settings.subtitleAutoSync !== true || !isNativeTauri()) return;
    if (!canPrefetchEmbeddedMedia(src.url, src.isLive)) return;
    if (prefetchedUrlRef.current === src.url) return;
    prefetchedUrlRef.current = src.url;
    void prefetchEmbeddedSubtitles(src.url, src.headers).catch((err) => {
      dwarn("[auto-sync] embedded index prefetch failed", err);
    });
  }, [settings.subtitleAutoSync, src.url, src.headers, src.isLive]);

  const beginRun = useCallback(
    (manual: boolean): (() => void) | null => {
      const b = bridgeRef.current;
      const curSrc = srcRef.current;
      const curSnap = liveSnapRef.current;
      const curSettings = settingsRef.current;
      const curSelected = curSnap.subtitleTracks.find((t) => t.selected) ?? null;
      if (!b || !curSelected?.external || !curSrc.url || curSrc.isLive) return null;
      if (!isNativeTauri()) {
        if (manual) {
          triggerRef.current = "manual";
          setTrigger("manual");
          setErrorMessage("Embedded subtitle auto-sync requires desktop runtime.");
          setStatus("error");
        }
        return null;
      }

      const selectedInput = buildSelectedCandidateInput(curSelected);
      if (!selectedInput) return null;

      if (!selectedInput.localPath && !/^https?:/i.test(selectedInput.url)) {
        const inlineCues = b.getSelectedTrackCues?.();
        if (inlineCues && inlineCues.length > 0) {
          selectedInput.inlineText = toSrt(inlineCues);
          selectedInput.format = "srt";
        }
      }

      const curMediaKey = autoSyncMediaKey(curSrc);
      if (manual) {
        if (manualTimingMediaRef.current === curMediaKey) {
          manualTimingMediaRef.current = null;
        }
        if (revertedRef.current.mediaKey === curMediaKey) {
          revertedRef.current.keys.delete(trackAutoSyncKey(curSelected));
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
      const trackKey = trackAutoSyncKey(curSelected);
      const selectedSourceUrl = selectedInput.url;
      const selectedSourceNorm = normalizeUrlKey(selectedSourceUrl);
      const candidates =
        candidateScope === "selected_only"
          ? []
          : collectSameLanguageCandidates(
              curSelected,
              availableSubsRef.current,
              curSnap.subtitleTracks,
            );

      setTrigger(runTrigger);
      setErrorMessage(null);
      setWithinTolerance(false);
      setStatus("analyzing");

      const isCurrent = () =>
        !cancelled.current &&
        isCurrentAutoSyncScope(scope) &&
        statusScopeRef.current === scope;

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
              const matchedSelected =
                chosenNorm !== "" && chosenNorm === selectedSourceNorm;
              const matchedExistingTrack = matchedSelected
                ? curSelected
                : liveSnapRef.current.subtitleTracks.find(
                    (t) =>
                      t.external &&
                      ((t.originalUrl && normalizeUrlKey(t.originalUrl) === chosenNorm) ||
                        (t.url && normalizeUrlKey(t.url) === chosenNorm) ||
                        (t.externalFilename &&
                          normalizeUrlKey(t.externalFilename) === chosenNorm)),
                  ) ?? null;
              const matchedResult =
                matchedExistingTrack == null
                  ? availableSubsRef.current.find(
                      (r) => normalizeUrlKey(r.url) === chosenNorm,
                    ) ?? null
                  : null;

              const targetLang =
                matchedExistingTrack?.lang ?? matchedResult?.lang ?? curSelected.lang;
              const targetTitle =
                matchedExistingTrack?.title ??
                matchedResult?.title ??
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
                  : buildRestoreMetadata(curSelected);

              const replaceExisting = matchedExistingTrack != null;
              const replaceTrackId = matchedExistingTrack?.id;
              const commitOrigin = b.getSubtitleSelectionOrigin?.() ?? "automatic";
              const subDelayBefore = liveSnapRef.current.subDelaySec;

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
                        matchedExistingTrack?.externalFilename ?? `synced.${fmt}`,
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

                  if (engineRef.current === "mpv" && !isSyncedTrack(curSelAfter)) {
                    // mpv emits the updated track list shortly after mpv_sub_add resolves.
                    awaitingCommitRef.current = {
                      mediaKey: scope.mediaKey,
                      deadlineMs: Date.now() + 2000,
                    };
                  } else {
                    awaitingCommitRef.current = null;
                  }

                  appliedRef.current = {
                    originalTrack: curSelected,
                    replacedSelected: matchedSelected,
                    originalTrackId: curSelected.id,
                    originalTrackKey: trackKey,
                    committedTrackId: commitRes.committedTrackId,
                    committedTrackKey: commitRes.committedTrackKey,
                    originalBackupPath: res.selectedOriginalPath ?? null,
                    originalBackupText: res.selectedOriginalText ?? null,
                    originalBackupFormat: res.selectedOriginalFormat
                      ? normalizeTextSubFormat(res.selectedOriginalFormat)
                      : null,
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

  // Sync committed track identity once mpv emits the new synced track, and reset when switching tracks.
  useEffect(() => {
    if (selectedSynced && selected && appliedRef.current.changed) {
      if (awaitingCommitRef.current?.mediaKey === mediaKey) {
        awaitingCommitRef.current = null;
        if (!appliedRef.current.committedTrackId) {
          appliedRef.current.committedTrackId = selected.id;
          appliedRef.current.committedTrackKey = trackAutoSyncKey(selected);
        }
      }
    }

    if (
      !selected &&
      awaitingCommitRef.current?.mediaKey === mediaKey &&
      Date.now() <= awaitingCommitRef.current.deadlineMs
    ) {
      return;
    }

    if (
      selected &&
      !selectedSynced &&
      awaitingCommitRef.current?.mediaKey === mediaKey &&
      selected.id !== statusScopeRef.current?.trackId &&
      trackAutoSyncKey(selected) !== appliedRef.current.originalTrackKey
    ) {
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
    const currentSelected =
      liveSnapRef.current.subtitleTracks.find((t) => t.selected) ?? null;
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
