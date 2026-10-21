import { useEffect, useRef, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackBuffered, getPlaybackPosition } from "@/lib/player/playback-clock";
import type { PartialSyncState } from "@/lib/together/provider";
import type { RoomSnapshot } from "@/lib/together/client";
import type { EpisodeRef, SourceDescriptor, SyncState } from "@/lib/together/protocol";
import type { PlayerSrc } from "@/lib/view";
import type { RoomCommand } from "@/lib/together/protocol";
import {
  HOST_HEARTBEAT_MS,
  SEEK_APPLY_DEBOUNCE_MS,
  SYNC_BEHIND_SUSTAINED_MS,
  SYNC_DEFAULT_REWIND_THRESHOLD_S,
  SYNC_DRIFT_CONVERGED_S,
  SYNC_DRIFT_TOLERANCE_S,
  SYNC_MAX_AGE_S,
  SYNC_PLAY_LOOKAHEAD_S,
  SYNC_SEEK_COOLDOWN_MS,
  SYNC_SEEK_JUMP_S,
  SYNC_SLOWDOWN_RATE,
  SYNC_SUPPRESS_MS,
} from "../player-utils";
import { useSettings } from "@/lib/settings";

type ForeignNotice = { title: string | null; from: string };

function syncRate(state: SyncState): number {
  return typeof state.speed === "number" && Number.isFinite(state.speed) && state.speed > 0
    ? state.speed
    : 1;
}

export function syncExpectedPosition(state: SyncState, duration: number): number {
  const age = Math.min(SYNC_MAX_AGE_S, Math.max(0, (Date.now() - state.updatedAt) / 1000));
  const expected = state.positionSeconds + (state.playing && !state.buffering ? age * syncRate(state) : 0);
  return duration > 0 ? Math.min(expected, Math.max(0, duration - 0.25)) : expected;
}

export function syncTarget(state: SyncState, duration: number): number {
  const age = Math.min(SYNC_MAX_AGE_S, Math.max(0, (Date.now() - state.updatedAt) / 1000));
  // Age and lookahead are wall-clock seconds; project them at the host's rate.
  const target = state.positionSeconds + (state.playing && !state.buffering ? (age + SYNC_PLAY_LOOKAHEAD_S) * syncRate(state) : 0);
  return duration > 0 ? Math.min(target, Math.max(0, duration - 0.25)) : target;
}

function isDifferentMedia(state: SyncState, src: PlayerSrc): boolean {
  if (!state.mediaId) return false;
  if (state.mediaId !== src.meta.id) return true;
  const se = state.episode;
  const le = src.episode;
  if (!!se !== !!le) return true;
  if (se && le && (se.season !== le.season || se.episode !== le.episode)) return true;
  return false;
}

export function useRoomSync(params: {
  inRoom: boolean;
  isHost: boolean;
  hasStarted: boolean;
  setHasStarted: (v: boolean) => void;
  selfFrameReadyRef: RefObject<boolean>;
  roomSnapshot: RoomSnapshot;
  clientId: string;
  src: PlayerSrc;
  snap: PlayerSnapshot;
  bridgeRef: RefObject<PlayerBridge | null>;
  hostSourceRef: RefObject<SourceDescriptor | null>;
  guestPickRef: RefObject<boolean>;
  guestControlRef?: RefObject<boolean>;
  startRoom?: () => void;
  publishState: (state: PartialSyncState) => void;
  sendCommand?: (command: RoomCommand) => void;
  onIncomingState: (cb: (state: SyncState) => void) => () => void;
  onIncomingCommand: (cb: (from: string, command: RoomCommand) => void) => () => void;
  markReady: (ready: boolean) => void;
  suppressOutgoingFor: (ms: number) => void;
  setForeignNotice: (n: ForeignNotice | null) => void;
  syncSettings?: {
    togetherSlowOnDesync?: boolean;
    togetherRewindThresholdSec?: number;
    togetherSyncOnPause?: boolean;
  };
  cast?: {
    activeRef: RefObject<boolean>;
    play: () => Promise<void> | void;
    pause: () => Promise<void> | void;
    seek: (sec: number) => Promise<void> | void;
    getPosition: () => number;
    isPlaying: () => boolean;
  };
}) {
  const {
    inRoom,
    isHost,
    hasStarted,
    setHasStarted,
    selfFrameReadyRef,
    roomSnapshot,
    clientId,
    src,
    snap,
    bridgeRef,
    hostSourceRef,
    guestPickRef,
    guestControlRef,
    startRoom,
    publishState,
    sendCommand,
    onIncomingState,
    onIncomingCommand,
    markReady,
    suppressOutgoingFor,
    setForeignNotice,
    syncSettings,
    cast,
  } = params;

  let settingsCtx: { settings?: Record<string, any> } | null = null;
  try {
    settingsCtx = typeof useSettings === "function" ? useSettings() : null;
  } catch {
    // Isolated unit test execution without SettingsProvider
  }
  const settings = settingsCtx?.settings;
  const togetherSlowOnDesync =
    syncSettings?.togetherSlowOnDesync ?? settings?.togetherSlowOnDesync ?? true;
  const togetherRewindThresholdSec =
    syncSettings?.togetherRewindThresholdSec ??
    settings?.togetherRewindThresholdSec ??
    SYNC_DEFAULT_REWIND_THRESHOLD_S;
  const togetherSyncOnPause =
    syncSettings?.togetherSyncOnPause ?? settings?.togetherSyncOnPause ?? false;

  const inRoomRef = useRef(inRoom);
  inRoomRef.current = inRoom;
  const isHostRef = useRef(isHost);
  isHostRef.current = isHost;
  const hasStartedRef = useRef(hasStarted);
  hasStartedRef.current = hasStarted;
  const srcRef = useRef(src);
  srcRef.current = src;
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const syncCatchUpRef = useRef(false);
  const syncCatchUpUntilRef = useRef(0);
  const syncSpeedAdjustedRef = useRef<-1 | 0 | 1>(0);
  const behindSinceRef = useRef<number | null>(null);
  const behindResetUntilRef = useRef(0);
  const lastAppliedStateAtRef = useRef(0);
  const lastSeekAtRef = useRef(0);
  const bufferingRef = useRef(snap.buffering);
  bufferingRef.current = snap.buffering;
  const guestReportsRef = useRef<
    Map<
      string,
      {
        positionSeconds: number;
        playing: boolean;
        buffering?: boolean;
        mediaId?: string | null;
        episode?: EpisodeRef | null;
        updatedAt?: number;
        rtt?: number;
        receivedAt: number;
      }
    >
  >(new Map());
  const hostSeekGraceUntilRef = useRef(0);
  const hostRewindCooldownUntilRef = useRef(0);
  const hostBehindSinceRef = useRef<number | null>(null);
  const hostSlowdownActiveRef = useRef(false);
  const lastHostPosRef = useRef(0);
  const lastHostTickAtRef = useRef(0);
  const hostPendingSeekRef = useRef<{ targetPos: number; at: number; until: number } | null>(null);
  const hostPendingPlayRef = useRef<{ playing: boolean; until: number } | null>(null);
  const guestSeekGraceRef = useRef<{ targetPos: number; until: number } | null>(null);
  const guestPlayGraceRef = useRef<{ playing: boolean; until: number } | null>(null);
  const mediaKey = `${src.meta.id}|${src.episode?.season ?? ""}|${src.episode?.episode ?? ""}`;

  const selectedAudioId = snap.audioTracks?.find((t) => t.selected)?.id ?? null;
  const selectedSubId = snap.subtitleTracks?.find((t) => t.selected)?.id ?? null;
  const prevAudioIdRef = useRef<string | null>(selectedAudioId);
  const prevSubIdRef = useRef<string | null>(selectedSubId);

  const rateRef = useRef(snap.rate);
  rateRef.current = snap.rate;
  const hostBaseRateRef = useRef(snap.rate || 1);
  if (
    !hostSlowdownActiveRef.current ||
    Math.abs(snap.rate - hostBaseRateRef.current * SYNC_SLOWDOWN_RATE) > 0.02
  ) {
    hostBaseRateRef.current = snap.rate || 1;
  }

  useEffect(() => {
    syncCatchUpRef.current = false;
    syncCatchUpUntilRef.current = 0;
    syncSpeedAdjustedRef.current = 0;
    behindSinceRef.current = null;
    behindResetUntilRef.current = 0;
    lastAppliedStateAtRef.current = 0;
    guestReportsRef.current.clear();
    hostSeekGraceUntilRef.current = 0;
    hostRewindCooldownUntilRef.current = 0;
    hostBehindSinceRef.current = null;
    hostSlowdownActiveRef.current = false;
    lastHostPosRef.current = 0;
    lastHostTickAtRef.current = 0;
    hostPendingSeekRef.current = null;
    hostPendingPlayRef.current = null;
    guestSeekGraceRef.current = null;
    guestPlayGraceRef.current = null;
    prevAudioIdRef.current = selectedAudioId;
    prevSubIdRef.current = selectedSubId;
    hostBaseRateRef.current = snap.rate || 1;
  }, [src.url, mediaKey, inRoom]);

  useEffect(() => {
    return () => {
      if (syncSpeedAdjustedRef.current !== 0 || hostSlowdownActiveRef.current) {
        bridgeRef.current?.setRate(hostBaseRateRef.current || 1);
        syncSpeedAdjustedRef.current = 0;
        hostSlowdownActiveRef.current = false;
      }
    };
  }, [bridgeRef]);

  const publishedRef = useRef<{ status: string; positionSec: number; at: number }>({
    status: "",
    positionSec: 0,
    at: 0,
  });
  const statusRef = useRef(snap.status);
  statusRef.current = snap.status;
  const durationRef = useRef(snap.durationSec);
  durationRef.current = snap.durationSec;
  const initialSyncDoneRef = useRef(false);

  const publishHostStateNow = (opts?: {
    positionSeconds?: number;
    playing?: boolean;
    doSeek?: boolean;
  }) => {
    if (!inRoomRef.current || !isHostRef.current) return;
    if (cast?.activeRef.current) return;
    const curSrc = srcRef.current;
    const now = Date.now();
    const baseRate = hostBaseRateRef.current || 1;
    let pos =
      typeof opts?.positionSeconds === "number" && Number.isFinite(opts.positionSeconds)
        ? opts.positionSeconds
        : getPlaybackPosition();
    if (
      opts?.positionSeconds == null &&
      hostPendingSeekRef.current &&
      now < hostPendingSeekRef.current.until
    ) {
      pos = hostPendingSeekRef.current.targetPos;
    }
    if (!Number.isFinite(pos) || pos < 0) pos = 0;
    if (
      !hasStartedRef.current &&
      durationRef.current > 0 &&
      pos >= Math.max(0, durationRef.current - 20)
    ) {
      pos = 0;
    }
    let isPlaying =
      typeof opts?.playing === "boolean"
        ? opts.playing
        : statusRef.current === "playing";
    if (
      opts?.playing == null &&
      hostPendingPlayRef.current &&
      now < hostPendingPlayRef.current.until
    ) {
      isPlaying = hostPendingPlayRef.current.playing;
    }
    if (!hasStartedRef.current && opts?.playing !== true) {
      isPlaying = false;
    }
    publishState({
      mediaId: curSrc.meta.id,
      mediaTitle: curSrc.meta.name ?? null,
      episode: curSrc.episode
        ? {
            season: curSrc.episode.season,
            episode: curSrc.episode.episode,
            name: curSrc.episode.name,
          }
        : null,
      posterUrl: curSrc.meta.poster ?? null,
      positionSeconds: pos,
      playing: isPlaying,
      buffering: bufferingRef.current === true ? true : undefined,
      speed: baseRate,
      source: hostSourceRef.current ?? undefined,
      guestPick: guestPickRef.current || undefined,
      guestControl: guestControlRef ? guestControlRef.current : undefined,
      doSeek: opts?.doSeek ? true : undefined,
    });
  };

  const notifyHostPlayPause = (playing: boolean) => {
    const now = Date.now();
    hostPendingPlayRef.current = { playing, until: now + 1500 };
    if (!playing && hostSlowdownActiveRef.current) {
      bridgeRef.current?.setRate(hostBaseRateRef.current || 1);
      hostSlowdownActiveRef.current = false;
    }
    publishHostStateNow({ playing });
  };

  const notifyHostSeek = (targetSec: number) => {
    const dur = durationRef.current;
    const targetPos =
      dur > 0 ? Math.max(0, Math.min(targetSec, dur - 0.5)) : Math.max(0, targetSec);
    const now = Date.now();
    hostSeekGraceUntilRef.current = now + 5000;
    hostPendingSeekRef.current = { targetPos, at: now, until: now + 2500 };
    hostBehindSinceRef.current = null;
    lastHostPosRef.current = targetPos;
    lastHostTickAtRef.current = now;
    if (hostSlowdownActiveRef.current) {
      bridgeRef.current?.setRate(hostBaseRateRef.current || 1);
      hostSlowdownActiveRef.current = false;
    }
    publishHostStateNow({
      positionSeconds: targetPos,
      doSeek: hasStartedRef.current ? true : undefined,
    });
  };

  const notifyGuestPlayPause = (playing: boolean) => {
    guestPlayGraceRef.current = { playing, until: Date.now() + 2000 };
  };

  const notifyGuestSeek = (targetSec: number) => {
    const now = Date.now();
    guestSeekGraceRef.current = { targetPos: Math.max(0, targetSec), until: now + 2500 };
    lastSeekAtRef.current = now;
    syncCatchUpRef.current = true;
    syncCatchUpUntilRef.current = now + 4000;
    behindSinceRef.current = null;
    behindResetUntilRef.current = now + 3000;
  };

  useEffect(() => {
    if (!inRoom || !isHost || !hasStarted) return;
    if (cast?.activeRef.current) return;
    const tick = () => {
      if (cast?.activeRef.current) return;
      const now = Date.now();
      let status = statusRef.current;
      if (hostPendingPlayRef.current) {
        if (now < hostPendingPlayRef.current.until) {
          if ((status === "playing") === hostPendingPlayRef.current.playing) {
            hostPendingPlayRef.current = null;
          } else {
            status = hostPendingPlayRef.current.playing ? "playing" : "paused";
          }
        } else {
          hostPendingPlayRef.current = null;
        }
      }
      if (status !== "playing" && status !== "paused") return;
      if (durationRef.current <= 0) return;
      let pos = getPlaybackPosition();
      if (!Number.isFinite(pos) || pos < 0) return;
      const isBuffering = bufferingRef.current === true;
      const baseRate = hostBaseRateRef.current || 1;
      if (hostPendingSeekRef.current) {
        if (now < hostPendingSeekRef.current.until) {
          if (Math.abs(pos - hostPendingSeekRef.current.targetPos) <= 3.0) {
            hostPendingSeekRef.current = null;
          } else {
            const seekElapsed = Math.max(0, (now - hostPendingSeekRef.current.at) / 1000);
            pos =
              hostPendingSeekRef.current.targetPos +
              (status === "playing" && !isBuffering ? seekElapsed * baseRate : 0);
          }
        } else {
          hostPendingSeekRef.current = null;
        }
      }
      const elapsed = lastHostTickAtRef.current > 0 ? (now - lastHostTickAtRef.current) / 1000 : 0;
      const expectedHostPos =
        lastHostPosRef.current + (status === "playing" ? elapsed * baseRate : 0);
      const isHostJump = lastHostTickAtRef.current > 0 && Math.abs(pos - expectedHostPos) > 1.5;
      if (isHostJump) {
        hostSeekGraceUntilRef.current = now + 5000;
        hostBehindSinceRef.current = null;
        if (hostSlowdownActiveRef.current) {
          bridgeRef.current?.setRate(baseRate);
          hostSlowdownActiveRef.current = false;
        }
      }
      lastHostPosRef.current = pos;
      lastHostTickAtRef.current = now;

      // Clean up stale or disconnected guest reports
      const activeParticipantIds = new Set(roomSnapshot.participants.map((p) => p.id));
      for (const [from, report] of guestReportsRef.current) {
        if (!activeParticipantIds.has(from) || now - report.receivedAt > 5000) {
          guestReportsRef.current.delete(from);
        }
      }

      // Filter matching guests on same media
      const matchingGuestPositions: number[] = [];
      const bufferingGuestPositions: number[] = [];
      let anyGuestBuffering = false;
      for (const [from, r] of guestReportsRef.current) {
        if (from === clientId) continue;
        if (r.mediaId !== src.meta.id) continue;
        const se = r.episode;
        const le = src.episode;
        if (!!se !== !!le) continue;
        if (se && le && (se.season !== le.season || se.episode !== le.episode)) continue;
        if (r.positionSeconds <= 2) continue;
        if (!r.playing && !r.buffering) continue;
        const rtt = typeof r.rtt === "number" && r.rtt > 0 ? r.rtt : 0;
        const transit = (rtt / 2) / 1000;
        const age = Math.max(0, (now - r.receivedAt) / 1000) + transit;
        const guestPos = r.positionSeconds + (r.playing && !r.buffering ? age * baseRate : 0);
        matchingGuestPositions.push(guestPos);
        if (r.buffering) {
          anyGuestBuffering = true;
          bufferingGuestPositions.push(guestPos);
        }
      }

      const b = bridgeRef.current;
      if (
        b &&
        matchingGuestPositions.length > 0 &&
        now >= hostSeekGraceUntilRef.current &&
        now >= hostRewindCooldownUntilRef.current &&
        status === "playing"
      ) {
        const minGuestPos = Math.min(...matchingGuestPositions);
        const hostDrift = pos - minGuestPos;
        const minBufferingPos =
          bufferingGuestPositions.length > 0 ? Math.min(...bufferingGuestPositions) : null;
        const bufferingDrift = minBufferingPos != null ? pos - minBufferingPos : 0;

        if (
          minBufferingPos != null &&
          bufferingDrift >= togetherRewindThresholdSec &&
          bufferingDrift < 30
        ) {
          if (hostBehindSinceRef.current == null) {
            hostBehindSinceRef.current = now;
          } else if (now - hostBehindSinceRef.current >= SYNC_BEHIND_SUSTAINED_MS) {
            console.info(`[together] host-rewind to ${minBufferingPos.toFixed(2)}s (drift ${bufferingDrift.toFixed(2)}s)`);
            b.seek(minBufferingPos);
            lastHostPosRef.current = minBufferingPos;
            lastHostTickAtRef.current = now;
            hostBehindSinceRef.current = null;
            hostRewindCooldownUntilRef.current = now + 5000;
            if (hostSlowdownActiveRef.current) {
              b.setRate(baseRate);
              hostSlowdownActiveRef.current = false;
            }
            publishState({
              mediaId: src.meta.id,
              mediaTitle: src.meta.name ?? null,
              episode: src.episode
                ? { season: src.episode.season, episode: src.episode.episode, name: src.episode.name }
                : null,
              posterUrl: src.meta.poster ?? null,
              positionSeconds: minBufferingPos,
              playing: true,
              buffering: isBuffering || undefined,
              speed: baseRate,
              source: hostSourceRef.current ?? undefined,
              guestPick: guestPickRef.current || undefined,
              guestControl: guestControlRef ? guestControlRef.current : undefined,
              doSeek: false,
            });
            return;
          }
        } else {
          hostBehindSinceRef.current = null;
        }

        const shouldSlowdown =
          togetherSlowOnDesync &&
          ((hostDrift > SYNC_DRIFT_TOLERANCE_S && hostDrift < togetherRewindThresholdSec) ||
            (anyGuestBuffering && hostDrift > 0.5));

        if (shouldSlowdown) {
          const slowRate = baseRate * SYNC_SLOWDOWN_RATE;
          if (Math.abs(rateRef.current - slowRate) > 0.01) {
            b.setRate(slowRate);
            hostSlowdownActiveRef.current = true;
            console.info(`[together] host-slowdown to ${slowRate.toFixed(3)} (drift ${hostDrift.toFixed(2)}s)`);
          }
        } else if (hostSlowdownActiveRef.current) {
          if (hostDrift <= SYNC_DRIFT_CONVERGED_S && !anyGuestBuffering) {
            b.setRate(baseRate);
            hostSlowdownActiveRef.current = false;
            console.info(`[together] host-slowdown converged (drift ${hostDrift.toFixed(2)}s)`);
          }
        }
      } else if (hostSlowdownActiveRef.current && b) {
        b.setRate(baseRate);
        hostSlowdownActiveRef.current = false;
        hostBehindSinceRef.current = null;
      }

      publishState({
        mediaId: src.meta.id,
        mediaTitle: src.meta.name ?? null,
        episode: src.episode
          ? { season: src.episode.season, episode: src.episode.episode, name: src.episode.name }
          : null,
        posterUrl: src.meta.poster ?? null,
        positionSeconds: pos,
        playing: status === "playing",
        buffering: isBuffering || undefined,
        speed: baseRate,
        source: hostSourceRef.current ?? undefined,
        guestPick: guestPickRef.current || undefined,
        guestControl: guestControlRef ? guestControlRef.current : undefined,
        doSeek: isHostJump || now < hostSeekGraceUntilRef.current ? true : undefined,
      });
    };
    tick();
    const id = window.setInterval(tick, HOST_HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [
    inRoom,
    isHost,
    hasStarted,
    publishState,
    src.meta.id,
    src.meta.name,
    src.meta.poster,
    src.episode,
    cast,
    togetherSlowOnDesync,
    togetherRewindThresholdSec,
    roomSnapshot.participants,
    clientId,
  ]);

  const seekSeqRef = useRef<Map<string, number>>(new Map());
  const pendingSeekRef = useRef<number | null>(null);
  const seekApplyTimerRef = useRef<number | null>(null);
  const clearPendingSeek = () => {
    if (seekApplyTimerRef.current != null) {
      window.clearTimeout(seekApplyTimerRef.current);
      seekApplyTimerRef.current = null;
    }
    pendingSeekRef.current = null;
  };
  useEffect(() => {
    if (inRoom && isHost) return;
    clearPendingSeek();
  }, [inRoom, isHost]);
  useEffect(() => clearPendingSeek, []);
  useEffect(() => {
    if (!inRoom || !isHost) return;
    const applySeek = (pos: number) => {
      const b = bridgeRef.current;
      if (!b || durationRef.current <= 0) return;
      const targetPos = Math.max(0, Math.min(pos, durationRef.current - 1));
      b.seek(targetPos);
      notifyHostSeek(targetPos);
    };
    const fireTimer = () => {
      seekApplyTimerRef.current = null;
      const pos = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (pos == null) return;
      if (!inRoomRef.current || !isHostRef.current) return;
      applySeek(pos);
    };
    const flushPending = () => {
      if (seekApplyTimerRef.current != null) {
        window.clearTimeout(seekApplyTimerRef.current);
        seekApplyTimerRef.current = null;
      }
      const pos = pendingSeekRef.current;
      pendingSeekRef.current = null;
      if (pos != null) applySeek(pos);
    };
    const off = onIncomingCommand((from, command) => {
      if (cast?.activeRef.current) return;
      const b = bridgeRef.current;
      if (!b) return;
      if (command.action === "report") {
        guestReportsRef.current.set(from, { ...command, receivedAt: Date.now() });
        return;
      }
      if (guestControlRef && !guestControlRef.current) {
        return;
      }
      if (command.action === "play") {
        flushPending();
        if (!hasStartedRef.current) {
          setHasStarted(true);
          startRoom?.();
          suppressOutgoingFor(0);
        }
        b.play().catch(() => {});
        notifyHostPlayPause(true);
      } else if (command.action === "pause") {
        flushPending();
        b.pause();
        notifyHostPlayPause(false);
      } else if (command.action === "seek") {
        hostSeekGraceUntilRef.current = Date.now() + 5000;
        hostBehindSinceRef.current = null;
        if (hostSlowdownActiveRef.current) {
          b.setRate(hostBaseRateRef.current || 1);
          hostSlowdownActiveRef.current = false;
        }
        if (typeof command.seq === "number") {
          const last = seekSeqRef.current.get(from);
          if (last != null && command.seq <= last) return;
          seekSeqRef.current.set(from, command.seq);
        }
        pendingSeekRef.current = command.positionSeconds;
        if (seekApplyTimerRef.current != null) window.clearTimeout(seekApplyTimerRef.current);
        seekApplyTimerRef.current = window.setTimeout(fireTimer, SEEK_APPLY_DEBOUNCE_MS);
      }
    });
    return off;
  }, [inRoom, isHost, onIncomingCommand, bridgeRef, cast]);

  useEffect(() => {
    if (!inRoom) return;
    return onIncomingState((state) => {
      if (state.updatedBy === clientId) return;
      if (cast?.activeRef.current) return;
      const b = bridgeRef.current;
      if (!b) return;
      const curSrc = srcRef.current;
      if (isDifferentMedia(state, curSrc)) {
        setForeignNotice({ title: state.mediaTitle, from: state.updatedBy });
        return;
      }
      if (!state.mediaId) return;
      if (state.updatedAt < lastAppliedStateAtRef.current) return;
      lastAppliedStateAtRef.current = state.updatedAt;

      const curSnap = snapRef.current;
      const isFrameReady =
        curSnap.firstFrameReady !== undefined
          ? Boolean(curSnap.firstFrameReady || selfFrameReadyRef.current)
          : selfFrameReadyRef.current
            ? true
            : curSnap.status === "playing";
      if (
        curSnap.status === "loading" ||
        curSnap.status === "idle" ||
        curSnap.status === "error" ||
        curSnap.status === "ended" ||
        durationRef.current <= 0 ||
        !isFrameReady
      ) {
        if (state.playing && curSnap.status === "loading") {
          b.play().catch(() => {});
        }
        return;
      }

      const now = Date.now();
      if (guestSeekGraceRef.current) {
        if (now < guestSeekGraceRef.current.until) {
          if (Math.abs(state.positionSeconds - guestSeekGraceRef.current.targetPos) <= 5.0) {
            guestSeekGraceRef.current = null;
          } else {
            return;
          }
        } else {
          guestSeekGraceRef.current = null;
        }
      }

      if (guestPlayGraceRef.current) {
        if (now < guestPlayGraceRef.current.until) {
          if (state.playing === guestPlayGraceRef.current.playing) {
            guestPlayGraceRef.current = null;
          }
        } else {
          guestPlayGraceRef.current = null;
        }
      }

      const rate = syncRate(state);
      const isPlaying = curSnap.status === "playing";
      const playStateChanged = state.playing !== isPlaying;

      const livePos = getPlaybackPosition();
      const expectedPos = syncExpectedPosition(state, durationRef.current);
      const target = syncTarget(state, durationRef.current);

      const signedDrift = livePos - expectedPos;
      const absDrift = Math.abs(signedDrift);

      // Check settlement of post-seek buffer
      const nearEof = durationRef.current > 0 && livePos >= durationRef.current - 5;
      if (
        syncCatchUpRef.current &&
        ((isPlaying && !bufferingRef.current && (getPlaybackBuffered() >= 2.0 || nearEof)) ||
          (syncCatchUpUntilRef.current > 0 && now >= syncCatchUpUntilRef.current))
      ) {
        syncCatchUpRef.current = false;
        syncCatchUpUntilRef.current = 0;
      }

      // Track duration spent lagging behind host (Syncplay-style behind reset)
      const canAccumulateBehind =
        signedDrift < -SYNC_DRIFT_TOLERANCE_S &&
        !state.buffering &&
        !bufferingRef.current &&
        !syncCatchUpRef.current &&
        isPlaying &&
        now >= behindResetUntilRef.current;

      if (canAccumulateBehind) {
        if (behindSinceRef.current == null) {
          behindSinceRef.current = now;
        }
      } else {
        behindSinceRef.current = null;
        if (bufferingRef.current) {
          behindResetUntilRef.current = now + 3000;
        }
      }

      // 1. Smooth speed catch-up (Syncplay-style)
      // Only slow down when ahead (signedDrift > SYNC_DRIFT_TOLERANCE_S).
      // Never speed up above normal rate when lagging behind! Lag is absorbed by the host slowing down/rewinding.
      if (togetherSlowOnDesync && state.playing && isPlaying) {
        if (signedDrift > SYNC_DRIFT_TOLERANCE_S && absDrift < togetherRewindThresholdSec) {
          const slowRate = rate * SYNC_SLOWDOWN_RATE;
          if (Math.abs(rateRef.current - slowRate) > 0.01) {
            console.info(
              `[together] speed-adjust slow down to ${slowRate.toFixed(3)} (drift ${signedDrift.toFixed(2)}s)`,
            );
            b.setRate(slowRate);
          }
          syncSpeedAdjustedRef.current = 1;
        } else {
          const aheadConverged =
            syncSpeedAdjustedRef.current === 1 &&
            (signedDrift <= SYNC_DRIFT_CONVERGED_S || absDrift >= togetherRewindThresholdSec);
          if (aheadConverged) {
            console.info(
              `[together] speed-adjust restored to ${rate.toFixed(3)} (drift ${signedDrift.toFixed(2)}s)`,
            );
            b.setRate(rate);
            syncSpeedAdjustedRef.current = 0;
          } else if (syncSpeedAdjustedRef.current === 0 && Math.abs(rate - rateRef.current) > 0.01) {
            b.setRate(rate);
          }
        }
      } else if (!state.playing || !isPlaying) {
        if (syncSpeedAdjustedRef.current !== 0) {
          b.setRate(rate);
          syncSpeedAdjustedRef.current = 0;
        }
      } else if (Math.abs(rate - rateRef.current) > 0.01) {
        syncSpeedAdjustedRef.current = 0;
        b.setRate(rate);
      }

      // 2. Hard seek check:
      // While still settling after a seek, block hard seeks unless explicit doSeek or big jump
      if (syncCatchUpRef.current && state.doSeek !== true && absDrift < SYNC_SEEK_JUMP_S) {
        if (!guestPlayGraceRef.current || now >= guestPlayGraceRef.current.until) {
          if (state.playing && !isPlaying) b.play().catch(() => {});
          if (!state.playing && isPlaying) b.pause();
        }
        return;
      }

      const forwardSeekThreshold =
        state.doSeek === true
          ? togetherRewindThresholdSec
          : Math.max(togetherRewindThresholdSec + 1, 5);
      const effectiveThreshold =
        signedDrift < 0 ? forwardSeekThreshold : togetherRewindThresholdSec;

      const sustainedBehind =
        !state.buffering &&
        behindSinceRef.current != null &&
        now - behindSinceRef.current >= SYNC_BEHIND_SUSTAINED_MS;
      const behindEligible =
        state.doSeek === true ||
        signedDrift >= 0 ||
        (!state.buffering && (absDrift >= SYNC_SEEK_JUMP_S || sustainedBehind));
      const driftRequiresHardSeek = absDrift >= effectiveThreshold && behindEligible;

      const playStateRequiresSeek =
        playStateChanged && (togetherSyncOnPause || absDrift >= effectiveThreshold);

      const shouldSeek = driftRequiresHardSeek || playStateRequiresSeek;

      if (shouldSeek) {
        const inCooldown =
          now - lastSeekAtRef.current < SYNC_SEEK_COOLDOWN_MS &&
          absDrift < SYNC_SEEK_JUMP_S &&
          state.doSeek !== true;
        if (!inCooldown && (!bufferingRef.current || absDrift >= SYNC_SEEK_JUMP_S)) {
          console.info(
            `[together] hard-seek to ${target.toFixed(2)}s (drift ${signedDrift.toFixed(2)}s, doSeek: ${state.doSeek === true})`,
          );
          b.seek(target);
          lastSeekAtRef.current = now;
          if (syncSpeedAdjustedRef.current !== 0) {
            b.setRate(rate);
            syncSpeedAdjustedRef.current = 0;
          }
          behindSinceRef.current = null;
          behindResetUntilRef.current = now + 3000;
          syncCatchUpRef.current = true;
          syncCatchUpUntilRef.current = now + 6000;
        }
      }

      if (!guestPlayGraceRef.current || now >= guestPlayGraceRef.current.until) {
        if (state.playing && !isPlaying) b.play().catch(() => {});
        if (!state.playing && isPlaying) b.pause();
      }
    });
  }, [
    inRoom,
    onIncomingState,
    clientId,
    src.url,
    mediaKey,
    suppressOutgoingFor,
    snap.status,
    snap.durationSec,
    snap.firstFrameReady,
    cast,
    togetherSlowOnDesync,
    togetherRewindThresholdSec,
    togetherSyncOnPause,
  ]);

  useEffect(() => {
    if (!inRoom || !cast) return;
    return onIncomingState((state) => {
      if (state.updatedBy === clientId) return;
      if (!cast.activeRef.current) return;
      if (!state.mediaId) return;
      if (isDifferentMedia(state, src)) {
        setForeignNotice({ title: state.mediaTitle, from: state.updatedBy });
        return;
      }
      if (state.updatedAt < lastAppliedStateAtRef.current) return;
      lastAppliedStateAtRef.current = state.updatedAt;
      const expectedPos = syncExpectedPosition(state, durationRef.current);
      const target = syncTarget(state, durationRef.current);
      const playing = cast.isPlaying();
      const drift = Math.abs(cast.getPosition() - expectedPos);
      const playStateChanged = state.playing !== playing;
      const driftTooBig = drift >= togetherRewindThresholdSec;
      if (!playStateChanged && !driftTooBig) return;
      if (!playStateChanged && drift < SYNC_SEEK_JUMP_S && Date.now() - lastSeekAtRef.current < SYNC_SEEK_COOLDOWN_MS) {
        return;
      }
      const shouldCastSeek = driftTooBig || (playStateChanged && (togetherSyncOnPause || driftTooBig));
      suppressOutgoingFor(SYNC_SUPPRESS_MS);
      if (shouldCastSeek) {
        void cast.seek(target);
        lastSeekAtRef.current = Date.now();
      }
      if (state.playing && !playing) void cast.play();
      if (!state.playing && playing) void cast.pause();
    });
  }, [
    inRoom,
    cast,
    onIncomingState,
    clientId,
    mediaKey,
    suppressOutgoingFor,
    setForeignNotice,
    togetherRewindThresholdSec,
    togetherSyncOnPause,
  ]);

  useEffect(() => {
    if (!inRoom || !isHost || !cast) return;
    const publishCast = () => {
      if (!cast.activeRef.current) return;
      const pos = cast.getPosition();
      const playing = cast.isPlaying();
      if (durationRef.current <= 0) return;
      if (pos <= 0 && playing) return;
      publishedRef.current = { status: playing ? "playing" : "paused", positionSec: pos, at: Date.now() };
      publishState({
        mediaId: src.meta.id,
        mediaTitle: src.meta.name ?? null,
        episode: src.episode
          ? { season: src.episode.season, episode: src.episode.episode, name: src.episode.name }
          : null,
        posterUrl: src.meta.poster ?? null,
        positionSeconds: pos,
        playing,
        source: hostSourceRef.current ?? undefined,
        guestPick: guestPickRef.current || undefined,
      });
    };
    publishCast();
    const id = window.setInterval(publishCast, 3000);
    return () => window.clearInterval(id);
  }, [inRoom, isHost, cast, publishState, src.meta.id, src.meta.name, src.meta.poster, src.episode]);

  const prevMediaKeyRef = useRef(mediaKey);
  useEffect(() => {
    if (prevMediaKeyRef.current === mediaKey) return;
    prevMediaKeyRef.current = mediaKey;
    if (inRoomRef.current) setHasStarted(false);
  }, [mediaKey, setHasStarted]);

  useEffect(() => {
    selfFrameReadyRef.current = false;
    markReady(false);
  }, [src.url, mediaKey, inRoom, markReady, selfFrameReadyRef]);
  useEffect(() => {
    if (!inRoom) return;
    if (selfFrameReadyRef.current) {
      const self = roomSnapshot.participants.find((p) => p.id === clientId);
      if (self && self.ready === false) {
        markReady(true);
      }
      return;
    }
    if (snap.videoWidth > 0 && snap.videoHeight > 0 && snap.durationSec > 0) {
      selfFrameReadyRef.current = true;
      markReady(true);
    }
  }, [inRoom, snap.videoWidth, snap.videoHeight, snap.durationSec, markReady, selfFrameReadyRef, roomSnapshot.participants, clientId]);

  useEffect(() => {
    if (!inRoom || hasStarted || roomSnapshot.started) return;
    const seed = roomSnapshot.syncState;
    const hostId = roomSnapshot.hostClientId;
    const isReady = Boolean(snap.firstFrameReady || selfFrameReadyRef.current);
    if (
      !isHost &&
      seed &&
      !isDifferentMedia(seed, src) &&
      !seed.playing &&
      !!hostId &&
      seed.updatedBy === hostId &&
      snap.durationSec > 0 &&
      snap.status !== "loading" &&
      isReady &&
      Math.abs(getPlaybackPosition() - seed.positionSeconds) > 1.5
    ) {
      const safeTarget =
        seed.positionSeconds >= Math.max(0, snap.durationSec - 20)
          ? 0
          : seed.positionSeconds;
      bridgeRef.current?.seek(safeTarget);
    }
    if (snap.status === "playing") bridgeRef.current?.pause();
  }, [
    inRoom,
    hasStarted,
    snap.status,
    snap.durationSec,
    snap.firstFrameReady,
    isHost,
    roomSnapshot.started,
    roomSnapshot.syncState,
    roomSnapshot.hostClientId,
  ]);

  const lobbySeededRef = useRef(false);
  const lastLobbySeedPosRef = useRef<number | null>(null);
  useEffect(() => {
    lobbySeededRef.current = false;
    lastLobbySeedPosRef.current = null;
  }, [src.url, mediaKey]);
  useEffect(() => {
    if (!inRoom || !isHost || hasStarted) return;
    if (snap.durationSec <= 0) return;
    const rawPos = getPlaybackPosition();
    const safePos =
      Number.isFinite(rawPos) && rawPos >= 0 && rawPos < Math.max(0, snap.durationSec - 20)
        ? rawPos
        : 0;
    if (
      lobbySeededRef.current &&
      lastLobbySeedPosRef.current != null &&
      Math.abs(safePos - lastLobbySeedPosRef.current) <= 1.5
    ) {
      return;
    }
    lobbySeededRef.current = true;
    lastLobbySeedPosRef.current = safePos;
    publishState({
      mediaId: src.meta.id,
      mediaTitle: src.meta.name ?? null,
      episode: src.episode
        ? { season: src.episode.season, episode: src.episode.episode, name: src.episode.name }
        : null,
      posterUrl: src.meta.poster ?? null,
      positionSeconds: safePos,
      playing: false,
      speed: rateRef.current,
      source: hostSourceRef.current ?? undefined,
      guestPick: guestPickRef.current || undefined,
      guestControl: guestControlRef ? guestControlRef.current : undefined,
    });
  }, [
    inRoom,
    isHost,
    hasStarted,
    snap.durationSec,
    snap.positionSec,
    publishState,
    src.meta.id,
    src.meta.name,
    src.meta.poster,
    src.episode,
  ]);

  useEffect(() => {
    if (!inRoom || isHost || hasStarted) return;
    if (roomSnapshot.started) setHasStarted(true);
  }, [inRoom, isHost, hasStarted, roomSnapshot.started]);

  useEffect(() => {
    initialSyncDoneRef.current = false;
  }, [src.url, mediaKey, inRoom]);
  useEffect(() => {
    if (!inRoom || isHost || !hasStarted || initialSyncDoneRef.current) return;
    const state = roomSnapshot.syncState;
    if (!state?.mediaId || isDifferentMedia(state, src)) return;
    const curSnap = snapRef.current;
    const isReady =
      curSnap.firstFrameReady !== undefined
        ? Boolean(curSnap.firstFrameReady || selfFrameReadyRef.current)
        : selfFrameReadyRef.current
          ? true
          : curSnap.status === "playing";
    if (
      curSnap.status === "loading" ||
      curSnap.status === "idle" ||
      curSnap.status === "error" ||
      curSnap.status === "ended" ||
      durationRef.current <= 0 ||
      !isReady
    ) {
      return;
    }
    const b = bridgeRef.current;
    if (!b) return;
    initialSyncDoneRef.current = true;
    const target = syncTarget(state, durationRef.current);
    suppressOutgoingFor(SYNC_SUPPRESS_MS);
    console.info(
      `[together] initial-sync to ${target.toFixed(2)}s (rate ${syncRate(state)})`,
    );
    b.setRate(syncRate(state));
    const now = Date.now();
    lastSeekAtRef.current = now;
    syncCatchUpRef.current = true;
    syncCatchUpUntilRef.current = now + 6000;
    b.seek(target);
    if (state.playing) b.play().catch(() => {});
    else b.pause();
  }, [
    inRoom,
    isHost,
    hasStarted,
    roomSnapshot.syncState,
    src.url,
    mediaKey,
    suppressOutgoingFor,
    snap.status,
    snap.durationSec,
    snap.firstFrameReady,
  ]);

  useEffect(() => {
    if (!inRoom || isHost || !hasStarted) return;
    if (!sendCommand) return;
    const reportState = () => {
      const curSnap = snapRef.current;
      const isReady = Boolean(curSnap.firstFrameReady || selfFrameReadyRef.current);
      if (!initialSyncDoneRef.current || durationRef.current <= 0 || !isReady) return;
      sendCommand({
        action: "report",
        positionSeconds: getPlaybackPosition(),
        playing: statusRef.current === "playing",
        buffering: bufferingRef.current === true,
        mediaId: src.meta.id,
        episode: src.episode ? { season: src.episode.season, episode: src.episode.episode } : null,
        updatedAt: Date.now(),
      });
    };
    reportState();
    const id = window.setInterval(reportState, HOST_HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [inRoom, isHost, hasStarted, sendCommand, src.meta.id, src.episode, snap.firstFrameReady, selfFrameReadyRef]);

  useEffect(() => {
    if (!inRoom || isHost || !hasStarted) return;
    if (!snap.buffering) return;
    const isReady = Boolean(snap.firstFrameReady || selfFrameReadyRef.current);
    if (!sendCommand || !initialSyncDoneRef.current || durationRef.current <= 0 || !isReady) return;
    sendCommand({
      action: "report",
      positionSeconds: getPlaybackPosition(),
      playing: statusRef.current === "playing",
      buffering: true,
      mediaId: src.meta.id,
      episode: src.episode ? { season: src.episode.season, episode: src.episode.episode } : null,
      updatedAt: Date.now(),
    });
  }, [inRoom, isHost, hasStarted, sendCommand, snap.buffering, src.meta.id, src.episode, snap.firstFrameReady, selfFrameReadyRef]);

  useEffect(() => {
    if (!inRoom) return;
    const isReady = Boolean(snap.firstFrameReady || selfFrameReadyRef.current);
    if (durationRef.current <= 0 || !isReady) {
      prevAudioIdRef.current = selectedAudioId;
      prevSubIdRef.current = selectedSubId;
      return;
    }
    const audioChanged =
      prevAudioIdRef.current !== undefined &&
      prevAudioIdRef.current !== selectedAudioId;
    const subChanged =
      prevSubIdRef.current !== undefined &&
      prevSubIdRef.current !== selectedSubId;

    prevAudioIdRef.current = selectedAudioId;
    prevSubIdRef.current = selectedSubId;

    if (audioChanged) {
      console.info(
        `[together] track-switch-grace (audio: ${selectedAudioId}, sub: ${selectedSubId})`,
      );
      const now = Date.now();
      behindResetUntilRef.current = now + 4000;
      behindSinceRef.current = null;
      syncCatchUpRef.current = true;
      syncCatchUpUntilRef.current = now + 4000;
      if (!isHost && sendCommand && (initialSyncDoneRef.current || hasStarted)) {
        sendCommand({
          action: "report",
          positionSeconds: getPlaybackPosition(),
          playing: statusRef.current === "playing",
          buffering: true,
          mediaId: src.meta.id,
          episode: src.episode
            ? { season: src.episode.season, episode: src.episode.episode }
            : null,
          updatedAt: now,
        });
      }
    } else if (subChanged) {
      behindResetUntilRef.current = Date.now() + 2000;
      behindSinceRef.current = null;
    }
  }, [
    inRoom,
    isHost,
    selectedAudioId,
    selectedSubId,
    snap.firstFrameReady,
    selfFrameReadyRef,
    sendCommand,
    src.meta.id,
    src.episode,
  ]);

  return {
    inRoomRef,
    isHostRef,
    initialSyncDoneRef,
    notifyHostPlayPause,
    notifyHostSeek,
    notifyGuestPlayPause,
    notifyGuestSeek,
  };
}
