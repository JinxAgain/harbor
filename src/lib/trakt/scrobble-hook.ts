import { useEffect, useRef } from "react";
import { useTrakt } from "./provider";
import { TRAKT_API_BASE, TRAKT_API_VERSION, TRAKT_CLIENT_ID } from "./config";
import { getSession } from "./session";
import { getPlaybackPosition, subscribePlaybackClock } from "@/lib/player/playback-clock";
import { isPlaybackFinished } from "@/lib/player/playback-finished";
import { useSettings } from "@/lib/settings";
import type { PlayerSrc } from "@/lib/view";

type Snap = {
  status: string;
  positionSec: number;
  durationSec: number;
};

type LastAction = "start" | "pause" | "stop" | null;

const STUB_MAX_SEC = 150;
// Keep pause scrobbles (resumable on other devices) up to where Harbor's own
// CW drops the card (CW_FINISHED_RATIO); only beyond that report stop/watched.
const WATCHED_MARK_PCT = 85;

export function useTraktScrobble({ src, snap }: { src: PlayerSrc; snap: Snap }): void {
  const { isConnected, resolveTarget, scrobble } = useTrakt();
  const { settings } = useSettings();
  const thresholdRef = useRef(settings.watchedThreshold ?? WATCHED_MARK_PCT);
  thresholdRef.current = settings.watchedThreshold ?? WATCHED_MARK_PCT;
  const lastActionRef = useRef<LastAction>(null);
  const lastKeyRef = useRef<string | null>(null);
  const prevIdentityRef = useRef({
    metaId: src.meta.id,
    episode: src.episode,
    durationSec: snap.durationSec,
  });
  const progressRef = useRef(0);
  const finishedRef = useRef(false);
  const loadResetSeenRef = useRef(true);

  const metaId = src.meta.id;
  const season = src.episode?.season;
  const episode = src.episode?.episode;
  const key = `${metaId}|${season ?? ""}|${episode ?? ""}`;

  const stopArgsRef = useRef({ metaId, episode: src.episode, snap });
  stopArgsRef.current = { metaId, episode: src.episode, snap };

  useEffect(() => {
    if (!isConnected) return;
    const target = resolveTarget(metaId, src.episode);
    if (!target) return;
    const onPageHide = () => {
      const a = stopArgsRef.current;
      if (a.snap.durationSec <= 0) return;
      if (lastActionRef.current !== "start" && lastActionRef.current !== "pause") return;
      const livePos = getPlaybackPosition();
      const live = (livePos / a.snap.durationSec) * 100;
      const progress = Math.min(100, Math.max(0, progressRef.current, live));
      const posSec = livePos > 0 ? livePos : (progress / 100) * a.snap.durationSec;
      const finished =
        finishedRef.current ||
        progress >= thresholdRef.current ||
        isPlaybackFinished(posSec, a.snap.durationSec, thresholdRef.current);
      const action = finished ? "stop" : "pause";
      sendBeacon(target, action === "stop" ? 100 : progress, action);
      // Beacon is fire-and-forget and may drop on exit, so also run the
      // confirmed stop to clear Trakt's "Now Playing" and write history.
      if (action === "stop") void scrobble("stop", { metaId, episode: a.episode, progress: 100 });
      lastActionRef.current = action;
    };
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [isConnected, resolveTarget, scrobble, metaId, src.episode]);

  useEffect(() => {
    if (lastKeyRef.current && lastKeyRef.current !== key) {
      const prev = prevIdentityRef.current;
      const prevProgress = progressRef.current;
      if (lastActionRef.current !== "stop") {
        const finished =
          finishedRef.current ||
          prevProgress >= thresholdRef.current ||
          (prev.durationSec > 0 &&
            isPlaybackFinished(
              (prevProgress / 100) * prev.durationSec,
              prev.durationSec,
              thresholdRef.current,
            ));
        if (finished) {
          scrobble("stop", { metaId: prev.metaId, episode: prev.episode, progress: 100 });
        } else if (prevProgress > 0) {
          scrobble("pause", { metaId: prev.metaId, episode: prev.episode, progress: prevProgress });
        }
      }
      lastActionRef.current = null;
      progressRef.current = 0;
      finishedRef.current = false;
      loadResetSeenRef.current = false;
    }
    lastKeyRef.current = key;
    prevIdentityRef.current = { metaId, episode: src.episode, durationSec: snap.durationSec };
  }, [key, metaId, src.episode, scrobble, snap.durationSec]);

  useEffect(() => {
    if (!isConnected) return;
    const target = resolveTarget(metaId, src.episode);
    if (!target) return;
    if (snap.status === "ended") {
      if (
        snap.durationSec >= STUB_MAX_SEC &&
        (lastActionRef.current === "start" || lastActionRef.current === "pause")
      ) {
        const livePos = getPlaybackPosition() || snap.positionSec;
        const endPct =
          snap.durationSec > 0
            ? Math.min(
                100,
                Math.max(0, progressRef.current, (livePos / snap.durationSec) * 100),
              )
            : 100;
        const finished =
          finishedRef.current ||
          endPct >= thresholdRef.current ||
          isPlaybackFinished(livePos, snap.durationSec, thresholdRef.current);
        scrobble("stop", { metaId, episode: src.episode, progress: finished ? 100 : endPct });
        lastActionRef.current = "stop";
      }
      return;
    }
    if (!loadResetSeenRef.current) {
      if (snap.status === "loading" || snap.durationSec <= 0) loadResetSeenRef.current = true;
      return;
    }
    if (snap.durationSec <= 0) return;
    if (snap.durationSec < STUB_MAX_SEC) return;
    const livePos = getPlaybackPosition();
    const progress = Math.min(100, Math.max(0, (livePos / snap.durationSec) * 100));
    if (progress > progressRef.current) progressRef.current = progress;
    if (
      !finishedRef.current &&
      (progress >= thresholdRef.current ||
        isPlaybackFinished(livePos, snap.durationSec, thresholdRef.current))
    ) {
      finishedRef.current = true;
    }

    if (lastActionRef.current === "stop") return;

    if (snap.status === "playing" && lastActionRef.current !== "start") {
      scrobble("start", { metaId, episode: src.episode, progress });
      lastActionRef.current = "start";
    } else if (snap.status === "paused" && lastActionRef.current === "start") {
      scrobble("pause", { metaId, episode: src.episode, progress });
      lastActionRef.current = "pause";
    }
  }, [isConnected, resolveTarget, scrobble, metaId, src.episode, snap.status, snap.durationSec]);

  useEffect(() => {
    if (!isConnected) return;
    if (snap.durationSec < STUB_MAX_SEC) return;
    const updateFromPos = (posSec: number) => {
      if (key !== lastKeyRef.current) return;
      if (lastActionRef.current !== "start" && lastActionRef.current !== "pause") return;
      const pct = Math.min(100, Math.max(0, (posSec / snap.durationSec) * 100));
      if (pct > progressRef.current) progressRef.current = pct;
      if (
        !finishedRef.current &&
        (pct >= thresholdRef.current ||
          isPlaybackFinished(posSec, snap.durationSec, thresholdRef.current))
      ) {
        finishedRef.current = true;
      }
    };
    updateFromPos(getPlaybackPosition() || snap.positionSec);
    return subscribePlaybackClock(() => {
      updateFromPos(getPlaybackPosition());
    });
  }, [isConnected, key, snap.positionSec, snap.durationSec]);

  const seekTrackRef = useRef({ pos: 0, at: 0, lastResyncAt: 0 });
  useEffect(() => {
    if (!isConnected) return;
    if (snap.durationSec <= 0) return;
    if (snap.durationSec < STUB_MAX_SEC) return;
    if (lastActionRef.current !== "start") {
      seekTrackRef.current = { pos: getPlaybackPosition(), at: Date.now(), lastResyncAt: 0 };
      return;
    }
    const id = window.setInterval(() => {
      if (lastActionRef.current !== "start") return;
      const now = Date.now();
      const ref = seekTrackRef.current;
      const pos = getPlaybackPosition();
      if (snap.durationSec > 0) {
        const pct = (pos / snap.durationSec) * 100;
        if (pct > progressRef.current) progressRef.current = pct;
      }
      const dPos = pos - ref.pos;
      const dT = (now - ref.at) / 1000;
      ref.pos = pos;
      ref.at = now;
      const isSeek = Math.abs(dPos) > 8 && (dT < 1.5 || Math.abs(dPos / Math.max(0.001, dT)) > 4);
      if (!isSeek) return;
      if (now - ref.lastResyncAt < 30000) return;
      ref.lastResyncAt = now;
      const progress = Math.min(100, Math.max(0, (pos / snap.durationSec) * 100));
      scrobble("start", { metaId, episode: src.episode, progress });
    }, 1000);
    return () => window.clearInterval(id);
  }, [isConnected, scrobble, metaId, src.episode, snap.status, snap.durationSec]);

  useEffect(() => {
    return () => {
      if (lastActionRef.current !== "start" && lastActionRef.current !== "pause") return;
      const a = stopArgsRef.current;
      if (a.snap.durationSec > 0) {
        const livePos = getPlaybackPosition();
        const live = (livePos / a.snap.durationSec) * 100;
        const progress = Math.min(100, Math.max(progressRef.current, live));
        const posSec = livePos > 0 ? livePos : (progress / 100) * a.snap.durationSec;
        const finished =
          finishedRef.current ||
          progress >= thresholdRef.current ||
          isPlaybackFinished(posSec, a.snap.durationSec, thresholdRef.current);
        const action = finished ? "stop" : "pause";
        scrobble(action, {
          metaId: a.metaId,
          episode: a.episode,
          progress: action === "stop" ? 100 : progress,
        });
        lastActionRef.current = action;
      } else {
        lastActionRef.current = "pause";
      }
    };
  }, [scrobble]);
}

function sendBeacon(
  target: ReturnType<NonNullable<ReturnType<typeof useTrakt>["resolveTarget"]>> & object,
  progress: number,
  action: "stop" | "pause",
): void {
  const session = getSession();
  if (!session) return;
  if (target.kind === "show") return;
  const clamped = Math.max(0, Math.min(100, Number(progress.toFixed(2))));
  let body: object;
  if (target.kind === "movie") {
    body = { movie: { ids: target.ids }, progress: clamped };
  } else if (target.episodeIds && Object.keys(target.episodeIds).length > 0) {
    body =
      Object.keys(target.show.ids).length > 0
        ? { show: { ids: target.show.ids }, episode: { ids: target.episodeIds }, progress: clamped }
        : { episode: { ids: target.episodeIds }, progress: clamped };
  } else {
    body = {
      show: { ids: target.show.ids },
      episode: { season: target.season, number: target.number },
      progress: clamped,
    };
  }
  const url = `${TRAKT_API_BASE}/scrobble/${action}`;
  try {
    void fetch(url, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        "trakt-api-version": TRAKT_API_VERSION,
        "trakt-api-key": TRAKT_CLIENT_ID,
      },
      body: JSON.stringify(body),
    });
  } catch {
    /* noop */
  }
}
