import { useEffect, useRef, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackBuffered, getPlaybackPosition } from "@/lib/player/playback-clock";
import type { PartialSyncState } from "@/lib/together/provider";
import type { RoomSnapshot } from "@/lib/together/client";
import type { SourceDescriptor, SyncState } from "@/lib/together/protocol";
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
  SYNC_SPEEDUP_RATE,
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
  publishState: (state: PartialSyncState) => void;
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
    publishState,
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
  const syncCatchUpRef = useRef(false);
  const syncSpeedAdjustedRef = useRef<-1 | 0 | 1>(0);
  const behindSinceRef = useRef<number | null>(null);
  const lastAppliedStateAtRef = useRef(0);
  const lastSeekAtRef = useRef(0);
  const bufferingRef = useRef(snap.buffering);
  bufferingRef.current = snap.buffering;
  const mediaKey = `${src.meta.id}|${src.episode?.season ?? ""}|${src.episode?.episode ?? ""}`;

  useEffect(() => {
    syncCatchUpRef.current = false;
    syncSpeedAdjustedRef.current = 0;
    behindSinceRef.current = null;
    lastAppliedStateAtRef.current = 0;
  }, [src.url, mediaKey, inRoom]);

  useEffect(() => {
    return () => {
      if (syncSpeedAdjustedRef.current !== 0) {
        bridgeRef.current?.setRate(rateRef.current || 1);
        syncSpeedAdjustedRef.current = 0;
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
  const rateRef = useRef(snap.rate);
  rateRef.current = snap.rate;
  const initialSyncDoneRef = useRef(false);

  useEffect(() => {
    if (!inRoom || !isHost || !hasStarted) return;
    if (cast?.activeRef.current) return;
    const tick = () => {
      if (cast?.activeRef.current) return;
      const status = statusRef.current;
      if (status !== "playing" && status !== "paused") return;
      const pos = getPlaybackPosition();
      if (durationRef.current <= 0) return;
      if (pos <= 0) return;
      const isBuffering = bufferingRef.current === true;
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
        speed: rateRef.current,
        source: hostSourceRef.current ?? undefined,
        guestPick: guestPickRef.current || undefined,
      });
    };
    tick();
    const id = window.setInterval(tick, HOST_HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [inRoom, isHost, hasStarted, publishState, src.meta.id, src.meta.name, src.meta.poster, src.episode, cast]);

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
      b.seek(Math.max(0, Math.min(pos, durationRef.current - 1)));
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
      if (command.action === "play") {
        flushPending();
        b.play().catch(() => {});
      } else if (command.action === "pause") {
        flushPending();
        b.pause();
      } else if (command.action === "seek") {
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
      if (isDifferentMedia(state, src)) {
        setForeignNotice({ title: state.mediaTitle, from: state.updatedBy });
        return;
      }
      if (!state.mediaId) return;
      if (state.updatedAt < lastAppliedStateAtRef.current) return;
      lastAppliedStateAtRef.current = state.updatedAt;

      const rate = syncRate(state);
      const isPlaying = snap.status === "playing";
      const playStateChanged = state.playing !== isPlaying;

      const livePos = getPlaybackPosition();
      const expectedPos = syncExpectedPosition(state, durationRef.current);
      const target = syncTarget(state, durationRef.current);

      const signedDrift = livePos - expectedPos;
      const absDrift = Math.abs(signedDrift);

      // Track duration spent lagging behind host
      if (signedDrift < -SYNC_DRIFT_TOLERANCE_S && !state.buffering) {
        if (behindSinceRef.current == null) {
          behindSinceRef.current = Date.now();
        }
      } else {
        behindSinceRef.current = null;
      }

      // 1. Smooth speed catch-up (Syncplay-style)
      if (togetherSlowOnDesync && state.playing && isPlaying) {
        if (signedDrift > SYNC_DRIFT_TOLERANCE_S && absDrift < togetherRewindThresholdSec) {
          const slowRate = rate * SYNC_SLOWDOWN_RATE;
          if (Math.abs(rateRef.current - slowRate) > 0.01) {
            b.setRate(slowRate);
          }
          syncSpeedAdjustedRef.current = 1;
        } else if (
          signedDrift < -SYNC_DRIFT_TOLERANCE_S &&
          absDrift < togetherRewindThresholdSec &&
          !bufferingRef.current &&
          !state.buffering &&
          getPlaybackBuffered() >= 2.0
        ) {
          const fastRate = rate * SYNC_SPEEDUP_RATE;
          if (Math.abs(rateRef.current - fastRate) > 0.01) {
            b.setRate(fastRate);
          }
          syncSpeedAdjustedRef.current = -1;
        } else {
          const aheadConverged =
            syncSpeedAdjustedRef.current === 1 &&
            (signedDrift <= SYNC_DRIFT_CONVERGED_S || absDrift >= togetherRewindThresholdSec);
          const behindConverged =
            syncSpeedAdjustedRef.current === -1 &&
            (signedDrift >= -SYNC_DRIFT_CONVERGED_S ||
              bufferingRef.current ||
              !!state.buffering ||
              absDrift >= togetherRewindThresholdSec);
          if (aheadConverged || behindConverged) {
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
      // Condition 1: absDrift >= togetherRewindThresholdSec (require sustained behind for >= 2000ms if lagging, and host not buffering)
      const sustainedBehind =
        !state.buffering &&
        behindSinceRef.current != null &&
        Date.now() - behindSinceRef.current >= SYNC_BEHIND_SUSTAINED_MS;
      const behindEligible = signedDrift >= 0 || (!state.buffering && (absDrift >= SYNC_SEEK_JUMP_S || sustainedBehind));
      const driftRequiresHardSeek = absDrift >= togetherRewindThresholdSec && behindEligible;

      // Condition 2: playStateChanged is true AND (togetherSyncOnPause is true OR absDrift >= togetherRewindThresholdSec)
      const playStateRequiresSeek =
        playStateChanged && (togetherSyncOnPause || absDrift >= togetherRewindThresholdSec);

      const shouldSeek = driftRequiresHardSeek || playStateRequiresSeek;

      if (shouldSeek) {
        const inCooldown =
          Date.now() - lastSeekAtRef.current < SYNC_SEEK_COOLDOWN_MS &&
          absDrift < SYNC_SEEK_JUMP_S;
        if (!inCooldown && (!bufferingRef.current || absDrift >= SYNC_SEEK_JUMP_S)) {
          b.seek(target);
          lastSeekAtRef.current = Date.now();
          if (syncSpeedAdjustedRef.current !== 0) {
            b.setRate(rate);
            syncSpeedAdjustedRef.current = 0;
          }
          behindSinceRef.current = null;
          syncCatchUpRef.current = true;
        }
      }

      if (state.playing && !isPlaying) b.play().catch(() => {});
      if (!state.playing && isPlaying) b.pause();
    });
  }, [
    inRoom,
    onIncomingState,
    clientId,
    mediaKey,
    suppressOutgoingFor,
    snap.status,
    snap.durationSec,
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
  }, [mediaKey, inRoom, markReady, selfFrameReadyRef]);
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
    if (
      !isHost &&
      seed &&
      !isDifferentMedia(seed, src) &&
      !seed.playing &&
      !!hostId &&
      seed.updatedBy === hostId &&
      Math.abs(getPlaybackPosition() - seed.positionSeconds) > 1.5
    ) {
      bridgeRef.current?.seek(seed.positionSeconds);
    }
    if (snap.status === "playing") bridgeRef.current?.pause();
  }, [inRoom, hasStarted, snap.status, isHost, roomSnapshot.started, roomSnapshot.syncState, roomSnapshot.hostClientId]);

  const lobbySeededRef = useRef(false);
  useEffect(() => {
    lobbySeededRef.current = false;
  }, [mediaKey]);
  useEffect(() => {
    if (!inRoom || !isHost || hasStarted || lobbySeededRef.current) return;
    if (snap.durationSec <= 0) return;
    lobbySeededRef.current = true;
    publishState({
      mediaId: src.meta.id,
      mediaTitle: src.meta.name ?? null,
      episode: src.episode
        ? { season: src.episode.season, episode: src.episode.episode, name: src.episode.name }
        : null,
      posterUrl: src.meta.poster ?? null,
      positionSeconds: getPlaybackPosition(),
      playing: false,
      speed: rateRef.current,
      source: hostSourceRef.current ?? undefined,
      guestPick: guestPickRef.current || undefined,
    });
  }, [inRoom, isHost, hasStarted, snap.durationSec, publishState, src.meta.id, src.meta.name, src.meta.poster, src.episode]);

  useEffect(() => {
    if (!inRoom || isHost || hasStarted) return;
    if (roomSnapshot.started) setHasStarted(true);
  }, [inRoom, isHost, hasStarted, roomSnapshot.started]);

  useEffect(() => {
    initialSyncDoneRef.current = false;
  }, [mediaKey, inRoom]);
  useEffect(() => {
    if (!inRoom || isHost || !hasStarted || initialSyncDoneRef.current) return;
    const state = roomSnapshot.syncState;
    if (!state?.mediaId || isDifferentMedia(state, src)) return;
    const b = bridgeRef.current;
    if (!b) return;
    initialSyncDoneRef.current = true;
    const target = syncTarget(state, durationRef.current);
    suppressOutgoingFor(SYNC_SUPPRESS_MS);
    b.setRate(syncRate(state));
    b.seek(target);
    if (state.playing) b.play().catch(() => {});
    else b.pause();
  }, [inRoom, isHost, hasStarted, roomSnapshot.syncState, mediaKey, suppressOutgoingFor]);

  return { inRoomRef, isHostRef, initialSyncDoneRef };
}
