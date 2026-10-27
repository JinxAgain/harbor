import { useCallback, type RefObject } from "react";
import { clearOnePickerCache } from "@/lib/picker-cache";
import {
  clearPlayback,
  readPlayback,
  savePlayback,
  streamMatchesEntry,
} from "@/lib/playback-history";
import type { PlayerBridge } from "@/lib/player/bridge";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import { DEFAULT_WATCHED_THRESHOLD_PCT, isPlaybackFinished } from "@/lib/player/playback-finished";
import { saveResumeMs } from "@/lib/resume";
import { useProfiles } from "@/lib/profiles";
import { useSettings } from "@/lib/settings";
import { exitWindowFullscreenOnPlayerClose } from "@/lib/fullscreen-state";
import type { PartialSyncState } from "@/lib/together/provider";
import { useView, type PlayerSrc, type PlayerStreamRef } from "@/lib/view";
import { MAX_AUTORETRY_ATTEMPTS } from "../player-utils";

const REMEMBER_MIN_SEC = 30;

export function usePlayerExit(params: {
  src: PlayerSrc;
  season: number | undefined;
  episode: number | undefined;
  bridgeRef: RefObject<PlayerBridge | null>;
  liveUrl: string;
  liveStreamRef: PlayerStreamRef | undefined;
  inRoom: boolean;
  isHost: boolean;
  instantPlay: boolean;
  captureExitSnapshot: () => Promise<void>;
  exitPip: () => Promise<void>;
  castActiveRef: RefObject<boolean>;
  stopCast: () => Promise<void>;
  publishState: (state: PartialSyncState) => void;
  notifyHostLeaving: () => void;
  clearInvite: () => void;
  exitPlayback: () => void;
  openPicker: ReturnType<typeof useView>["openPicker"];
  snap?: { durationSec?: number };
}) {
  const {
    src,
    season,
    episode,
    bridgeRef,
    liveUrl,
    liveStreamRef,
    inRoom,
    isHost,
    instantPlay,
    captureExitSnapshot,
    exitPip,
    castActiveRef,
    stopCast,
    publishState,
    notifyHostLeaving,
    clearInvite,
    exitPlayback,
    openPicker,
    snap,
  } = params;

  const { activeProfile } = useProfiles();
  const thresholdPct =
    (typeof useSettings === "function" ? useSettings()?.settings?.watchedThreshold : undefined) ??
    DEFAULT_WATCHED_THRESHOLD_PCT;

  const closePlayer = useCallback(async () => {
    const saveCurrent = (pos: number) => {
      const dur = snap?.durationSec ?? 0;
      const finished =
        dur > 0 &&
        (pos >= dur * 0.92 ||
          (typeof isPlaybackFinished === "function" && isPlaybackFinished(pos, dur, thresholdPct)));
      if (Number.isFinite(pos) && pos >= 5 && !finished) {
        saveResumeMs(
          src.meta.id,
          pos * 1000,
          season,
          episode,
          undefined,
          undefined,
          undefined,
          activeProfile?.id,
        );
        if (src.imdbIdVerified && src.imdbId && src.imdbId !== src.meta.id) {
          saveResumeMs(
            src.imdbId,
            pos * 1000,
            season,
            episode,
            undefined,
            undefined,
            undefined,
            activeProfile?.id,
          );
        }
        if (liveStreamRef && pos >= REMEMBER_MIN_SEC) {
          const rememberedUrl = (src.historyUrl ?? liveUrl) || src.url;
          const entry = { ...liveStreamRef, url: rememberedUrl, title: src.meta.name };
          savePlayback(src.meta.id, entry, season, episode);
          if (src.imdbIdVerified && src.imdbId && src.imdbId !== src.meta.id) {
            savePlayback(src.imdbId, entry, season, episode);
          }
        }
      }
    };

    const initialPos = getPlaybackPosition();
    saveCurrent(initialPos);
    await captureExitSnapshot();
    const finalPos = getPlaybackPosition();
    if (finalPos !== initialPos) {
      saveCurrent(finalPos);
    }
    await exitPip();
    if (castActiveRef.current) await stopCast().catch(() => {});
    await exitWindowFullscreenOnPlayerClose();
    if (inRoom && isHost) {
      publishState({
        mediaId: null,
        mediaTitle: null,
        episode: null,
        posterUrl: null,
        positionSeconds: 0,
        playing: false,
      });
      notifyHostLeaving();
      clearInvite();
    }
    exitPlayback();
  }, [
    captureExitSnapshot,
    exitPlayback,
    src.meta.id,
    src.meta.name,
    src.imdbId,
    src.imdbIdVerified,
    src.historyUrl,
    season,
    episode,
    inRoom,
    isHost,
    notifyHostLeaving,
    clearInvite,
    publishState,
    exitPip,
    liveStreamRef,
    liveUrl,
    src.url,
    stopCast,
    castActiveRef,
    activeProfile?.id,
    snap?.durationSec,
  ]);

  const onStubEject = useCallback(() => {
    const nextAttempt = (src.attempt ?? 0) + 1;
    if (bridgeRef.current) {
      bridgeRef.current.destroy();
      bridgeRef.current = null;
    }
    if (src.streamRef) {
      const remembered = readPlayback(src.meta.id, season, episode);
      if (remembered && streamMatchesEntry(src.streamRef, remembered)) {
        clearPlayback(src.meta.id, season, episode);
      }
    }
    if (nextAttempt > MAX_AUTORETRY_ATTEMPTS) {
      void closePlayer();
      return;
    }
    if (nextAttempt >= 2) clearOnePickerCache(src.meta, src.episode);
    openPicker(
      src.meta,
      src.episode,
      instantPlay || inRoom
        ? {
            autoPlay: true,
            attempt: nextAttempt,
            resume: src.resume,
            startPositionMs: src.startPositionMs,
          }
        : {
            autoPlay: false,
            resume: src.resume,
            startPositionMs: src.startPositionMs,
          },
    );
  }, [
    src.attempt,
    src.meta,
    src.episode,
    src.resume,
    src.startPositionMs,
    src.streamRef,
    season,
    episode,
    openPicker,
    instantPlay,
    inRoom,
    closePlayer,
    bridgeRef,
  ]);

  return { closePlayer, onStubEject };
}
