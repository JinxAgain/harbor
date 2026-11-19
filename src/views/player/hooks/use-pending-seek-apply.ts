import { useEffect, useRef, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot } from "@/lib/player/bridge";
import { notifyMediaSeeked } from "@/lib/media-session";

export function usePendingSeekApply(params: {
  pendingSeekSec: number | null;
  clearPendingSeek: () => void;
  durationSec: number;
  bridgeRef: RefObject<PlayerBridge | null>;
  inRoomRef: RefObject<boolean>;
  sourceKey: string;
  startPaused?: boolean;
  loadedWithStartAt?: boolean;
}) {
  const {
    pendingSeekSec,
    clearPendingSeek,
    durationSec,
    bridgeRef,
    inRoomRef,
    sourceKey,
    startPaused,
    loadedWithStartAt = false,
  } = params;
  const onApplied = useRef(clearPendingSeek);
  onApplied.current = clearPendingSeek;
  useEffect(() => {
    if (pendingSeekSec == null) return;
    if (durationSec <= 0) return;
    const b = bridgeRef.current;
    if (!b) return;
    const target = pendingSeekSec;
    const t = target <= 5 || target >= durationSec - 20 ? 0 : Math.min(target, durationSec - 1);
    const deferToStartAt = Boolean(loadedWithStartAt && t > 0);
    let issued = false;
    let applied = false;
    let fallbackSeekIssued = false;
    let initialSnap: PlayerSnapshot | null = null;
    const handleSnap = (snap: PlayerSnapshot) => {
      // seek() queues a native command. Keep automatic intro/outro actions blocked
      // until the player reports the requested position, including while paused.
      if (!issued) {
        if (deferToStartAt) initialSnap = snap;
        return;
      }
      if (applied || bridgeRef.current !== b || snap.status === "loading") return;
      if (Number.isFinite(snap.positionSec) && Math.abs(snap.positionSec - t) <= 1) {
        applied = true;
        notifyMediaSeeked(t);
        onApplied.current();
        if (!inRoomRef.current && !startPaused) b.play().catch(() => {});
        return;
      }
      if (
        deferToStartAt &&
        !fallbackSeekIssued &&
        snap.firstFrameReady === true &&
        Number.isFinite(snap.positionSec) &&
        Math.abs(snap.positionSec - t) > 2
      ) {
        // Fallback if the bridge or stream started from 0 despite startAtSec.
        fallbackSeekIssued = true;
        b.seek(t);
      }
    };
    const off = b.subscribe(handleSnap);
    issued = true;
    if (deferToStartAt) {
      if (initialSnap) handleSnap(initialSnap);
    } else {
      b.seek(t);
    }
    return off;
  }, [
    pendingSeekSec,
    durationSec,
    bridgeRef,
    inRoomRef,
    sourceKey,
    startPaused,
    loadedWithStartAt,
  ]);
}
