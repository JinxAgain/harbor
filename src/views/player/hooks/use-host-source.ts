import { useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerSnapshot } from "@/lib/player/bridge";
import { getPlaybackPosition } from "@/lib/player/playback-clock";
import type { PartialSyncState } from "@/lib/together/provider";
import type { SourceDescriptor } from "@/lib/together/protocol";
import { buildSourceDescriptor, descriptorsEqual } from "@/lib/together/source-descriptor";
import type { PlayerSrc, PlayerStreamRef } from "@/lib/view";

const URL_CHANGE_DURATION_GUARD_MS = 1500;

export function useHostSource(params: {
  inRoom: boolean;
  isHost: boolean;
  hasStarted: boolean;
  resumeReady?: boolean;
  resolvedStartSec?: number | null;
  src: PlayerSrc;
  liveUrl: string;
  liveStreamRef: PlayerStreamRef | undefined;
  snap: PlayerSnapshot;
  guestPickRef: RefObject<boolean>;
  guestControlRef?: RefObject<boolean>;
  publishState: (state: PartialSyncState) => void;
}): { hostSourceRef: RefObject<SourceDescriptor | null> } {
  const {
    inRoom,
    isHost,
    hasStarted,
    resumeReady = true,
    resolvedStartSec = null,
    src,
    liveUrl,
    liveStreamRef,
    snap,
    guestPickRef,
    guestControlRef,
    publishState,
  } = params;

  const [validDurationSec, setValidDurationSec] = useState(0);
  const urlChangedAtRef = useRef(0);
  const firstUrlRef = useRef(true);
  useEffect(() => {
    if (firstUrlRef.current) {
      firstUrlRef.current = false;
      return;
    }
    urlChangedAtRef.current = Date.now();
    setValidDurationSec(0);
  }, [liveUrl]);
  useEffect(() => {
    if (snap.durationSec <= 0) return;
    if (snap.status !== "playing" && snap.status !== "paused") return;
    if (Date.now() - urlChangedAtRef.current < URL_CHANGE_DURATION_GUARD_MS) return;
    setValidDurationSec(snap.durationSec);
  }, [snap.durationSec, snap.status]);

  const stableRef = useRef<SourceDescriptor | null>(null);
  const next = buildSourceDescriptor(
    liveStreamRef ?? src.streamRef ?? null,
    validDurationSec > 0 ? validDurationSec : undefined,
  );
  if (!descriptorsEqual(stableRef.current, next)) stableRef.current = next;
  const descriptor = stableRef.current;

  const hostSourceRef = useRef<SourceDescriptor | null>(null);
  hostSourceRef.current = descriptor;

  const lastSeedRef = useRef<SourceDescriptor | null>(null);
  useEffect(() => {
    if (!inRoom || !isHost || hasStarted) {
      lastSeedRef.current = null;
      return;
    }
    if (!descriptor) return;
    if (descriptorsEqual(lastSeedRef.current, descriptor)) return;
    lastSeedRef.current = descriptor;
    const rawPos = resumeReady
      ? Math.max(0, getPlaybackPosition())
      : Math.max(0, resolvedStartSec ?? 0);
    const safePos =
      snap.durationSec > 0 && rawPos >= Math.max(0, snap.durationSec - 20) ? 0 : rawPos;
    publishState({
      mediaId: src.meta.id,
      mediaTitle: src.meta.name ?? null,
      episode: src.episode
        ? { season: src.episode.season, episode: src.episode.episode, name: src.episode.name }
        : null,
      posterUrl: src.meta.poster ?? null,
      positionSeconds: safePos,
      playing: false,
      speed: snap.rate,
      source: descriptor,
      guestPick: guestPickRef.current || undefined,
      guestControl: guestControlRef ? guestControlRef.current : undefined,
    });
  }, [inRoom, isHost, hasStarted, resumeReady, resolvedStartSec, descriptor, publishState, src.meta.id, src.meta.name, src.meta.poster, src.episode, snap.durationSec, snap.rate]);

  return { hostSourceRef };
}
