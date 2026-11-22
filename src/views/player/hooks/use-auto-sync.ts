import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot, TrackInfo } from "@/lib/player/bridge";
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
import { parseSubtitle } from "@/lib/subtitles/parser";
import {
  registerPreparedSubtitle,
  takePreparedSubtitle,
} from "@/lib/subtitles/prepared-registry";
import { toSrt } from "@/lib/subtitles/serialize";
import type { SubResult } from "@/lib/subtitles/types";
import type { PlayerSrc } from "@/lib/view";
import {
  buildRestoreMetadata,
  buildSelectedCandidateInput,
  canPrefetchEmbeddedMedia,
  isAutoSyncEligibleMedia,
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

type AutoSyncScope = { mediaKey: string; trackId: string };
type AppliedState = {
  originalTrack: TrackInfo | null;
  replacedSelected: boolean;
  originalTrackId: string | null;
  originalTrackKey: string | null;
  subDelayBefore: number;
  scope: AutoSyncScope | null;
  changed: boolean;
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

const EMPTY_APPLIED: AppliedState = {
  originalTrack: null,
  replacedSelected: false,
  originalTrackId: null,
  originalTrackKey: null,
  subDelayBefore: 0,
  scope: null,
  changed: false,
};

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
  const appliedRef = useRef<AppliedState>({ ...EMPTY_APPLIED });
  const activeRunIdRef = useRef<string | null>(null);
  const activeDisposeRef = useRef<(() => void) | null>(null);
  const statusScopeRef = useRef<AutoSyncScope | null>(null);
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
    if (manualTimingMediaRef.current === autoSyncMediaKey(srcRef.current)) return false;
    const currentSelected =
      liveSnapRef.current.subtitleTracks.find((track) => track.selected) ?? null;
    return isAutoSyncScopeCurrent(scope, {
      mediaKey: autoSyncMediaKey(srcRef.current),
      trackId: currentSelected?.id ?? null,
      syncedTrack: isSyncedTrack(currentSelected),
    });
  }, []);

  // Reset per-media caches & state whenever mediaKey changes.
  useEffect(() => {
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    appliedRef.current = { ...EMPTY_APPLIED };
    statusScopeRef.current = null;
    setStatus("idle");
    setTrigger("automatic");
    setOffsetMs(null);
    setScale(null);
    setWithinTolerance(false);
    setCanRevert(false);
    setErrorMessage(null);
  }, [mediaKey]);

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
      const selectionOrigin = b.getSubtitleSelectionOrigin?.() ?? "automatic";
      const candidateScope = resolveAutoSyncScope(runTrigger, selectionOrigin);
      const trackKey = trackAutoSyncKey(curSelected);
      const selectedSourceUrl = curSelected.originalUrl || curSelected.url || "";
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
              const fmt =
                res.format === "ass" || res.format === "ssa" || res.format === "vtt"
                  ? res.format
                  : "srt";
              if (!body) {
                setStatus("no-fit");
                return;
              }
              const cues = parseSubtitle(body, fmt);
              const chosenUrl = res.chosenUrl || selectedSourceUrl;
              const matchedSelected =
                chosenUrl !== "" && chosenUrl === selectedSourceUrl;
              const matchedExistingTrack = matchedSelected
                ? curSelected
                : liveSnapRef.current.subtitleTracks.find(
                    (t) =>
                      t.external &&
                      ((t.originalUrl && t.originalUrl === chosenUrl) ||
                        (t.url && t.url === chosenUrl)),
                  ) ?? null;
              const matchedResult =
                matchedExistingTrack == null
                  ? availableSubsRef.current.find((r) => r.url === chosenUrl) ?? null
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

              void runWithSubtitleFpsReset(
                async () => {
                  if (!isCurrent()) return;
                  let playableUrl: string;
                  let cleanup = () => {};
                  if (engineRef.current === "mpv") {
                    if (!res.retimedPath) {
                      if (isCurrent()) setStatus("error");
                      return;
                    }
                    playableUrl = res.retimedPath;
                  } else {
                    const blobUrl = URL.createObjectURL(
                      new Blob([body], { type: "text/plain;charset=utf-8" }),
                    );
                    playableUrl = blobUrl;
                    cleanup = () => URL.revokeObjectURL(blobUrl);
                  }

                  registerPreparedSubtitle({
                    originalUrl: chosenUrl || playableUrl,
                    playableUrl,
                    format: fmt,
                    cues,
                    text: body,
                    encoding: "utf-8",
                    encodingHealth: 1,
                    encodingDiagnostics: [],
                    release: baseMetadata.release,
                    rawFilename:
                      matchedExistingTrack?.externalFilename ?? `synced.${fmt}`,
                    archive: false,
                    cleanup,
                  });

                  const ok = await b.addSubtitle(
                    playableUrl,
                    targetLang,
                    targetTitle,
                    true,
                    {
                      ...baseMetadata,
                      originalUrl: chosenUrl || playableUrl,
                      format: fmt,
                      autoSynced: true,
                      replaceExisting,
                      replaceTrackId,
                    },
                    commitOrigin,
                  );

                  if (!ok) {
                    takePreparedSubtitle(playableUrl)?.cleanup();
                    if (isCurrent()) {
                      setErrorMessage("Could not load synced subtitle track.");
                      setStatus("error");
                    }
                    return;
                  }
                  if (!isCurrent()) return;

                  const a = appliedRef.current;
                  a.originalTrack = curSelected;
                  a.replacedSelected = matchedSelected;
                  a.originalTrackId = curSelected.id;
                  a.originalTrackKey = trackKey;
                  a.subDelayBefore = liveSnapRef.current.subDelaySec;
                  a.scope = scope;
                  a.changed = true;
                  b.setSubDelay(0);

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

  // Clear stale non-synced status when user switches to a different un-synced track or turns subs off.
  useEffect(() => {
    if (selectedSynced) return;
    if (!selected || !selected.external) {
      activeDisposeRef.current?.();
      activeDisposeRef.current = null;
      statusScopeRef.current = null;
      appliedRef.current = { ...EMPTY_APPLIED };
      setCanRevert(false);
      setStatus("idle");
      return;
    }
    const currentKey = trackAutoSyncKey(selected);
    const scopeMatchesSelected =
      statusScopeRef.current?.mediaKey === mediaKey &&
      statusScopeRef.current?.trackId === selected.id;
    if (!scopeMatchesSelected && appliedRef.current.originalTrackKey !== currentKey) {
      activeDisposeRef.current?.();
      activeDisposeRef.current = null;
      statusScopeRef.current = null;
      appliedRef.current = { ...EMPTY_APPLIED };
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

    const dispose = beginRun(false);
    return () => {
      dispose?.();
    };
  }, [runKey, mediaKey, selectedTrackKey, beginRun]);

  const revert = useCallback(() => {
    activeDisposeRef.current?.();
    activeDisposeRef.current = null;
    const b = bridgeRef.current;
    const a = appliedRef.current;
    const canRevertNow = a.changed && isCurrentAutoSyncScope(a.scope);
    if (b && canRevertNow) {
      const curMediaKey = autoSyncMediaKey(srcRef.current);
      if (a.originalTrackKey) {
        if (revertedRef.current.mediaKey !== curMediaKey) {
          revertedRef.current = { mediaKey: curMediaKey, keys: new Set() };
        }
        revertedRef.current.keys.add(a.originalTrackKey);
      }
      const commitOrigin = b.getSubtitleSelectionOrigin?.() ?? "automatic";
      const currentSelected =
        liveSnapRef.current.subtitleTracks.find((t) => t.selected) ?? null;
      if (a.replacedSelected && a.originalTrack) {
        const restoreUrl =
          a.originalTrack.originalUrl ||
          a.originalTrack.url ||
          a.originalTrack.externalFilename;
        if (restoreUrl) {
          void b
            .addSubtitle(
              restoreUrl,
              a.originalTrack.lang,
              a.originalTrack.title,
              true,
              {
                ...buildRestoreMetadata(a.originalTrack),
                autoSynced: false,
                replaceExisting: true,
                replaceTrackId: currentSelected?.id,
              },
              commitOrigin,
            )
            .finally(() => {
              b.setSubDelay(a.subDelayBefore);
            });
        } else if (a.originalTrackId) {
          b.setSubtitleTrack(a.originalTrackId, commitOrigin);
          b.setSubDelay(a.subDelayBefore);
        }
      } else if (a.originalTrackId) {
        b.setSubtitleTrack(a.originalTrackId, commitOrigin);
        b.setSubDelay(a.subDelayBefore);
      }
    }
    appliedRef.current = { ...EMPTY_APPLIED };
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
    statusScopeRef.current = null;
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
