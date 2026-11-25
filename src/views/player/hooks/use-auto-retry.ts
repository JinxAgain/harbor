import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PlayerBridge, PlayerSnapshot } from "@/lib/player/bridge";
import {
  getPlaybackBuffered,
  getPlaybackPosition,
  usePlaybackFlag,
} from "@/lib/player/playback-clock";
import { isTruncatedEnd } from "@/lib/player/playback-end";
import { isLocalUrl } from "@/lib/player/local-url";
import { probeStreamStatus } from "@/lib/player/stream-probe";
import { clearOnePickerCache } from "@/lib/picker-cache";
import { resolveViaDebrids } from "@/lib/streams/resolve";
import { registerStreamProxy } from "@/lib/stream-proxy";
import { buildTranscodedUrl, probeStremioServer } from "@/lib/stremio-server";
import type { DebridStore } from "@/lib/debrid/types";
import { type useView, type PlayerSrc } from "@/lib/view";
import {
  BLACK_SCREEN_GRACE_MS,
  MAX_AUTORETRY_ATTEMPTS,
  NEVER_STARTED_CEILING_MS,
  ROOM_STALL_MS,
  SLOW_LOAD_MS,
  STUCK_AUTORETRY_MS,
} from "../player-utils";
import { GENUINE_FAILURE_WINDOW_MS, type EngineStats } from "@/lib/torrent/engine-stats";

type OpenPicker = ReturnType<typeof useView>["openPicker"];

export type SourceErrorReason = "archive_restoring" | "http_error" | "truncated" | "no_response";

export type SourceError = {
  status: number;
  host: string;
  viaHost?: string;
  reason?: SourceErrorReason;
  detail?: string;
  exhausted?: boolean;
  probing?: boolean;
  autoRetryInSec?: number | null;
  autoRetryAttempt?: number;
};

const ARCHIVE_POLL_INTERVAL_SEC = 15;
const ARCHIVE_MAX_AUTO_RETRIES = 12;

function clampRetryAfterSec(retryAfterSec: number | null | undefined): number {
  return retryAfterSec != null
    ? Math.min(30, Math.max(10, retryAfterSec))
    : ARCHIVE_POLL_INTERVAL_SEC;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

export function useAutoRetry(params: {
  bridgeRef: RefObject<PlayerBridge | null>;
  src: PlayerSrc;
  snap: PlayerSnapshot;
  stremioServerTranscode: boolean;
  instantPlay: boolean;
  inRoom: boolean;
  debrids: DebridStore[];
  selfFrameReadyRef: RefObject<boolean>;
  openPicker: OpenPicker;
  engineFailure: boolean;
  isP2pEngine: boolean;
  engineStats: EngineStats | null;
}) {
  const {
    bridgeRef,
    src,
    snap,
    stremioServerTranscode,
    instantPlay,
    inRoom,
    debrids,
    selfFrameReadyRef,
    openPicker,
    engineFailure,
    isP2pEngine,
    engineStats,
  } = params;
  const isLocal = isLocalUrl(src.url);
  const isLive = src.meta.id.startsWith("iptv:");
  const isManualSelection = src.autoFired === false;
  const canAutoSwitch = !isManualSelection && (instantPlay || inRoom);
  const ENGINE_FIRST_FRAME_GRACE_MS = 20_000;
  const ENGINE_HARD_CEILING_MS = 75_000;
  const ENGINE_COMPLETE_RELOAD_MS = 8_000;
  const ENGINE_COMPLETE_FAILURE_MS = 20_000;
  const urlAtRef = useRef(0);
  const urlSeenRef = useRef<string | null>(null);
  if (urlSeenRef.current !== src.url) {
    urlSeenRef.current = src.url;
    urlAtRef.current = Date.now();
  }
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const engineStatsRef = useRef(engineStats);
  engineStatsRef.current = engineStats;
  const dlRef = useRef({ bytes: 0, at: 0 });

  const hasProgress = usePlaybackFlag(
    () => getPlaybackPosition() > 0.5 || getPlaybackBuffered() > 0.5,
  );
  const startedPlaying = usePlaybackFlag(() => getPlaybackPosition() > 0.5);
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    setSlowLoad(false);
    if (isLocal) return;
    const hasMeaningful = hasProgress || snap.firstFrameReady;
    if (hasMeaningful) return;
    const t = window.setTimeout(() => setSlowLoad(true), SLOW_LOAD_MS);
    return () => window.clearTimeout(t);
  }, [src.url, snap.firstFrameReady, hasProgress, isLocal]);

  const autoRetriedRef = useRef(false);
  const transcodedTriedRef = useRef(false);
  const sameUrlRetriedRef = useRef(false);
  const proxyRetriedRef = useRef(false);
  const transcodeRescueRef = useRef(false);
  const debridFailoverTriedRef = useRef(false);
  const p2pCompleteReloadedRef = useRef(false);
  const p2pCompleteReloadedAtRef = useRef(0);
  const liveRetryCountRef = useRef(0);
  const livePlayedRef = useRef(false);
  const truncatedReloadedRef = useRef(false);
  const resumedAfterTruncatedRef = useRef(false);
  const firstFrameRenderedRef = useRef(false);
  if (snap.firstFrameReady || snap.videoWidth > 0) {
    firstFrameRenderedRef.current = true;
  }
  const [transcodedUrl, setTranscodedUrl] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<SourceError | null>(null);
  const sourceErrorRef = useRef<SourceError | null>(null);
  sourceErrorRef.current = sourceError;
  const probeSessionRef = useRef(0);
  useEffect(() => {
    probeSessionRef.current += 1;
    sourceErrorRef.current = null;
    setSourceError(null);
    autoRetriedRef.current = false;
    transcodedTriedRef.current = false;
    sameUrlRetriedRef.current = false;
    proxyRetriedRef.current = false;
    transcodeRescueRef.current = false;
    debridFailoverTriedRef.current = false;
    p2pCompleteReloadedRef.current = false;
    p2pCompleteReloadedAtRef.current = 0;
    liveRetryCountRef.current = 0;
    livePlayedRef.current = false;
    truncatedReloadedRef.current = false;
    resumedAfterTruncatedRef.current = false;
    firstFrameRenderedRef.current = false;
    dlRef.current = { bytes: 0, at: Date.now() };
    setTranscodedUrl(null);
  }, [src.url]);

  useEffect(() => {
    return () => {
      probeSessionRef.current += 1;
    };
  }, []);

  const reportSourceError = useCallback(
    (exhausted = false) => {
      if (sourceErrorRef.current != null) return;
      const probeUrl = src.url;
      const canProbe =
        typeof probeStreamStatus === "function" && !isLocal && /^https?:\/\//i.test(probeUrl);
      const initialError: SourceError = {
        status: 0,
        host: hostOf(probeUrl),
        exhausted: exhausted || undefined,
        probing: canProbe,
      };
      sourceErrorRef.current = initialError;
      setSourceError(initialError);

      if (!canProbe) return;
      const session = ++probeSessionRef.current;
      void probeStreamStatus(probeUrl, src.headers)
        .then((result) => {
          if (probeSessionRef.current !== session || urlSeenRef.current !== probeUrl) {
            return;
          }
          setSourceError((prev) => {
            if (!prev) return null;
            if (!result) return { ...prev, probing: false };
            if (result.reason === "archive_restoring") {
              return {
                status: result.status,
                host: result.host || prev.host,
                viaHost: result.viaHost || undefined,
                reason: "archive_restoring",
                detail: result.detail || undefined,
                exhausted: prev.exhausted,
                probing: false,
                autoRetryInSec: prev.exhausted ? null : clampRetryAfterSec(result.retryAfterSec),
                autoRetryAttempt: 0,
              };
            }
            if (result.reason === "ready") {
              return {
                status: result.status || 200,
                host: result.host || prev.host,
                viaHost: result.viaHost || undefined,
                detail: result.detail || undefined,
                exhausted: prev.exhausted,
                probing: false,
              };
            }
            return {
              status: result.status,
              host: result.host || prev.host,
              viaHost: result.viaHost || undefined,
              reason: result.reason,
              detail: result.detail || undefined,
              exhausted: prev.exhausted,
              probing: false,
            };
          });
        })
        .catch(() => {
          if (probeSessionRef.current !== session || urlSeenRef.current !== probeUrl) {
            return;
          }
          setSourceError((prev) => (prev ? { ...prev, probing: false } : null));
        });
    },
    [isLocal, src.url, src.headers],
  );

  useEffect(() => {
    if (isLive && hasProgress) livePlayedRef.current = true;
  }, [isLive, hasProgress]);

  useEffect(() => {
    if (!isLive) return;
    if (snap.errorCode == null) return;
    const maxAttempts = livePlayedRef.current ? 2 : 1;
    if (liveRetryCountRef.current >= maxAttempts) return;
    const b = bridgeRef.current;
    if (!b) return;
    const attempt = liveRetryCountRef.current + 1;
    const timer = window.setTimeout(
      () => {
        liveRetryCountRef.current = attempt;
        console.warn(`[player] live auto-reconnect attempt ${attempt}/${maxAttempts}`);
        void b.load({
          url: src.url,
          subtitles: src.subtitles,
          notWebReady: src.notWebReady,
          isLive: true,
          headers: src.headers,
        });
      },
      livePlayedRef.current ? 4000 : 1500,
    );
    return () => window.clearTimeout(timer);
  }, [isLive, snap.errorCode, src.url, src.subtitles, src.notWebReady, bridgeRef]);

  const triggerAutoRetry = useCallback(
    (reason: string) => {
      if (autoRetriedRef.current) return;
      if (isLocal) {
        console.warn(`[player] local file: skipping auto-retry (${reason})`);
        return;
      }
      if (isLive) {
        console.warn(`[player] live channel: skipping auto-retry (${reason})`);
        return;
      }
      if (startedPlaying || selfFrameReadyRef.current) {
        console.warn(
          `[player] playback already started: skipping auto-retry/picker exit (${reason})`,
        );
        return;
      }
      // An explicitly selected source must not be killed by a short startup
      // timer or auto-replaced by another addon. Signed/local-resolver playback
      // URLs can take > 9s to respond or resolve offline downloads. Keep mpv
      // alive and let the longer startup ceiling or a genuine mpv error own the
      // visible failure state.
      if (!canAutoSwitch) {
        console.warn(`[player] manual source failed (${reason})`);
        reportSourceError(false);
        return;
      }
      const currentAttempt = src.attempt ?? 0;
      if (currentAttempt >= MAX_AUTORETRY_ATTEMPTS) {
        console.warn(`[player] giving up after ${currentAttempt} attempts (${reason})`);
        if (!isP2pEngine && getPlaybackPosition() < 0.5) {
          reportSourceError(true);
        }
        return;
      }
      autoRetriedRef.current = true;
      const nextAttempt = currentAttempt + 1;
      console.warn(`[player] ${reason} — retrying with candidate #${nextAttempt}`);
      if (bridgeRef.current) {
        bridgeRef.current.destroy();
        bridgeRef.current = null;
      }
      if (nextAttempt >= 2) {
        clearOnePickerCache(src.meta, src.episode);
      }
      openPicker(
        src.meta,
        src.episode,
        canAutoSwitch
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
    },
    [
      src.attempt,
      src.meta,
      src.episode,
      src.resume,
      src.startPositionMs,
      openPicker,
      canAutoSwitch,
      isLocal,
      isLive,
      isP2pEngine,
      src.url,
      src.subtitles,
      src.notWebReady,
      bridgeRef,
      startedPlaying,
      selfFrameReadyRef,
      reportSourceError,
    ],
  );

  useEffect(() => {
    if (snap.errorCode == null) return;
    if (snap.status === "ended") return;
    if (isLive) {
      console.warn(`[player] live channel: ignoring "${snap.errorCode}", mpv handles reconnection`);
      return;
    }
    // Only skip error recovery after playback has actually rendered a frame; an
    // initial startAtSec failure can advance time-pos before dying without video.
    if (
      getPlaybackPosition() > 5 &&
      (firstFrameRenderedRef.current || snap.firstFrameReady || selfFrameReadyRef.current)
    ) {
      return;
    }
    if (
      isP2pEngine &&
      !engineFailure &&
      Date.now() - urlAtRef.current < ENGINE_FIRST_FRAME_GRACE_MS
    )
      return;
    const recoveryBridge = bridgeRef.current;
    if (!recoveryBridge) return;
    const ac = new AbortController();
    // A recovery belongs to the failed load, never to a later source or bridge.
    const current = () => !ac.signal.aborted && bridgeRef.current === recoveryBridge;
    const retry = () => {
      if (current()) triggerAutoRetry(`playback error "${snap.errorCode}"`);
    };
    const cancel = () => ac.abort();
    const failoverHash = src.streamRef?.infoHash;
    if (failoverHash && debrids.length > 0 && !debridFailoverTriedRef.current) {
      debridFailoverTriedRef.current = true;
      const cached = Object.fromEntries((src.streamRef?.cachedSlugs ?? []).map((s) => [s, true]));
      const hint = src.episode
        ? { season: src.episode.season ?? null, episode: src.episode.episode ?? null }
        : undefined;
      void resolveViaDebrids(
        failoverHash,
        src.streamRef?.fileIdx ?? undefined,
        cached,
        debrids,
        ac.signal,
        false,
        {},
        hint,
      )
        .then(async (r) => {
          if (!current()) return;
          if (r.ok) {
            let url = r.data.url;
            if (r.data.headers && Object.keys(r.data.headers).length > 0) {
              try {
                url = (await registerStreamProxy(r.data.url, r.data.headers)).url;
              } catch {
                /* fall back to the raw debrid url */
              }
            }
            if (!current()) return;
            console.warn(`[player] debrid failover via ${r.via}`);
            void recoveryBridge.load({
              url,
              subtitles: src.subtitles,
              notWebReady: r.data.notWebReady ?? src.notWebReady,
            });
          } else {
            retry();
          }
        })
        .catch(retry);
      return cancel;
    }
    if (!sameUrlRetriedRef.current) {
      sameUrlRetriedRef.current = true;
      const b = bridgeRef.current;
      if (b) {
        console.warn(`[player] error "${snap.errorCode}" before playback — reloading same URL`);
        void b.load({
          url: src.url,
          subtitles: src.subtitles,
          notWebReady: src.notWebReady,
          isLive,
          headers: src.headers,
        });
        return;
      }
    }
    if (
      !proxyRetriedRef.current &&
      !isLocal &&
      !isP2pEngine &&
      /^https?:\/\//i.test(src.url) &&
      !src.url.includes("127.0.0.1")
    ) {
      proxyRetriedRef.current = true;
      const b = bridgeRef.current;
      if (b) {
        console.warn(`[player] error "${snap.errorCode}" — retrying via local stream proxy`);
        void registerStreamProxy(src.url, src.headers)
          .then((p) => {
            if (current())
              void recoveryBridge.load({
                url: p.url,
                subtitles: src.subtitles,
                notWebReady: src.notWebReady,
              });
          })
          .catch(retry);
        return cancel;
      }
    }
    if (
      !transcodeRescueRef.current &&
      !isLocal &&
      !isP2pEngine &&
      /^https?:\/\//i.test(src.url) &&
      !src.url.includes("127.0.0.1")
    ) {
      transcodeRescueRef.current = true;
      const b = bridgeRef.current;
      if (b) {
        console.warn(`[player] error "${snap.errorCode}" — remuxing via ffmpeg`);
        void registerStreamProxy(src.url, src.headers, { transcode: true })
          .then((p) => {
            if (current())
              void recoveryBridge.load({ url: p.url, subtitles: src.subtitles, notWebReady: true });
          })
          .catch(retry);
        return cancel;
      }
    }
    if (
      stremioServerTranscode &&
      (!isP2pEngine || engineFailure) &&
      !transcodedTriedRef.current &&
      snap.errorCode === "decode" &&
      transcodedUrl == null
    ) {
      transcodedTriedRef.current = true;
      void probeStremioServer()
        .then((ok) => {
          if (!current()) return;
          if (ok) {
            console.warn("[player] decode error — retrying via p2p transcoding");
            recoveryBridge.destroy();
            bridgeRef.current = null;
            setTranscodedUrl(buildTranscodedUrl(src.url));
          } else {
            retry();
          }
        })
        .catch(retry);
      return cancel;
    }
    triggerAutoRetry(`playback error "${snap.errorCode}"`);
  }, [
    snap.errorCode,
    snap.status,
    triggerAutoRetry,
    stremioServerTranscode,
    transcodedUrl,
    src.url,
    src.subtitles,
    src.notWebReady,
    bridgeRef,
    isP2pEngine,
    engineFailure,
  ]);

  // Distinguishes a genuine re-truncation after reload from the same EOF re-emitted:
  // any departure from "ended" (loading/playing) after the reload marks the next
  // ended as a real second death, even if it never managed to play.
  useEffect(() => {
    if (snap.status !== "ended") resumedAfterTruncatedRef.current = true;
  }, [snap.status]);

  // Premature EOF: reload the same URL once (sidecar re-registers a fresh session),
  // and only escalate to candidate retry if the reloaded stream also dies.
  useEffect(() => {
    if (snap.status !== "ended") return;
    if (isLocal) return;
    if (isLive) return;
    const pos = snap.positionSec > 0 ? snap.positionSec : getPlaybackPosition();
    if (!isTruncatedEnd(snap, pos)) return;
    const b = bridgeRef.current;
    if (!b) return;
    if (!truncatedReloadedRef.current) {
      truncatedReloadedRef.current = true;
      resumedAfterTruncatedRef.current = false;
      console.warn(
        `[player] stream ended prematurely at ${pos.toFixed(1)}s of ${snap.durationSec.toFixed(1)}s — reloading same URL for a fresh session`,
      );
      void b.load({
        url: src.url,
        subtitles: src.subtitles,
        notWebReady: src.notWebReady,
        startAtSec: pos > 5 ? pos : undefined,
        isLive,
        headers: src.headers,
      });
      return;
    }
    if (!resumedAfterTruncatedRef.current) return;
    triggerAutoRetry("stream ended prematurely again after reload");
  }, [
    snap.status,
    snap.durationSec,
    snap.positionSec,
    triggerAutoRetry,
    isLocal,
    isLive,
    src.url,
    src.subtitles,
    src.notWebReady,
    src.headers,
    bridgeRef,
  ]);

  const lastPosRef = useRef({ pos: 0, at: 0, started: false, urlAt: 0 });
  useEffect(() => {
    lastPosRef.current = { pos: 0, at: 0, started: false, urlAt: Date.now() };
  }, [src.url]);
  useEffect(() => {
    if (snap.status !== "playing") {
      lastPosRef.current.at = Date.now();
      lastPosRef.current.pos = getPlaybackPosition();
      lastPosRef.current.started = false;
      return;
    }
    const id = window.setInterval(() => {
      const now = Date.now();
      const ref = lastPosRef.current;
      const pos = getPlaybackPosition();
      if (!ref.started) {
        ref.started = true;
        ref.at = now;
        ref.pos = pos;
        return;
      }
      if (pos > ref.pos + 0.3) {
        ref.pos = pos;
        ref.at = now;
        return;
      }
      if (ref.pos > 5) return;
      const neverStarted = ref.pos < 0.5;
      const graceMs = neverStarted ? 75_000 : 18_000;
      if (now - ref.urlAt < graceMs) return;
      if ((!isP2pEngine || engineFailure) && now - ref.at > graceMs && pos < 5) {
        triggerAutoRetry(
          neverStarted ? "source did not start after 75s" : "position frozen for 18s",
        );
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [snap.status, triggerAutoRetry, src.url, isP2pEngine, engineFailure]);

  const noVideoSinceRef = useRef<number | null>(null);
  const videoSeenRef = useRef(false);
  useEffect(() => {
    videoSeenRef.current = false;
    noVideoSinceRef.current = null;
  }, [src.url]);
  useEffect(() => {
    const hasVideo = snap.videoWidth > 0 && snap.videoHeight > 0;
    if (hasVideo) {
      videoSeenRef.current = true;
      noVideoSinceRef.current = null;
      return;
    }
    if (snap.status !== "playing") {
      noVideoSinceRef.current = null;
      return;
    }
    if (videoSeenRef.current) return;
    if (noVideoSinceRef.current == null) {
      noVideoSinceRef.current = Date.now();
      return;
    }
    const graceMs = isP2pEngine
      ? Math.max(BLACK_SCREEN_GRACE_MS, ENGINE_FIRST_FRAME_GRACE_MS)
      : BLACK_SCREEN_GRACE_MS;
    if (Date.now() - noVideoSinceRef.current > graceMs) {
      if (!isP2pEngine || engineFailure) {
        triggerAutoRetry("audio plays but no video frames (black screen)");
      }
    }
  }, [
    snap.status,
    snap.videoWidth,
    snap.videoHeight,
    triggerAutoRetry,
    src.url,
    isP2pEngine,
    engineFailure,
  ]);

  useEffect(() => {
    if (snap.status === "ended") return;
    if (isP2pEngine && !engineFailure) return;
    if (!canAutoSwitch) return;
    if (snap.durationSec > 0 || getPlaybackPosition() > 1) return;
    const t = window.setTimeout(() => {
      if (snap.durationSec === 0 && getPlaybackPosition() === 0) {
        triggerAutoRetry("stuck on load");
      }
    }, STUCK_AUTORETRY_MS);
    return () => window.clearTimeout(t);
  }, [
    src.url,
    snap.durationSec,
    snap.status,
    triggerAutoRetry,
    isP2pEngine,
    engineFailure,
    canAutoSwitch,
  ]);

  useEffect(() => {
    if (isLive || isLocal || canAutoSwitch || isP2pEngine) return;
    const remaining = NEVER_STARTED_CEILING_MS - (Date.now() - urlAtRef.current);
    const t = window.setTimeout(
      () => {
        const s = snapRef.current;
        if (s.status === "playing" || s.status === "ended") return;
        if (s.durationSec > 0 || getPlaybackPosition() > 0) return;
        console.warn(`[player] source never started within ${NEVER_STARTED_CEILING_MS}ms`);
        reportSourceError(false);
      },
      Math.max(0, remaining),
    );
    return () => window.clearTimeout(t);
  }, [src.url, isLive, isLocal, canAutoSwitch, isP2pEngine, reportSourceError]);

  useEffect(() => {
    if (startedPlaying) {
      probeSessionRef.current += 1;
      sourceErrorRef.current = null;
      setSourceError(null);
    }
  }, [startedPlaying]);

  useEffect(() => {
    if (!inRoom || isManualSelection || isLocal || isLive) return;
    if (selfFrameReadyRef.current) return;
    if (snap.status === "ended") return;
    if (snap.videoWidth > 0 && snap.videoHeight > 0) return;
    const t = window.setTimeout(() => {
      if (!selfFrameReadyRef.current && (snap.videoWidth <= 0 || snap.videoHeight <= 0)) {
        if (!isP2pEngine || engineFailure) {
          triggerAutoRetry("room stream produced no video");
        }
      }
    }, ROOM_STALL_MS);
    return () => window.clearTimeout(t);
  }, [
    inRoom,
    isManualSelection,
    isLocal,
    isLive,
    snap.status,
    snap.videoWidth,
    snap.videoHeight,
    triggerAutoRetry,
    src.url,
    selfFrameReadyRef,
    isP2pEngine,
    engineFailure,
  ]);

  useEffect(() => {
    if (!isP2pEngine || snap.status === "ended") return;
    const id = window.setInterval(() => {
      if (getPlaybackPosition() > 5) return;
      if ((src.attempt ?? 0) >= MAX_AUTORETRY_ATTEMPTS) return;
      const age = Date.now() - urlAtRef.current;
      if (engineFailure && !debridFailoverTriedRef.current && age >= ENGINE_FIRST_FRAME_GRACE_MS) {
        triggerAutoRetry("engine reports no peers and no download progress");
        return;
      }
      const st = engineStatsRef.current;
      const selectedFileComplete =
        !!st && st.streamLen != null && st.streamLen > 0 && st.streamProgress >= st.streamLen;
      if (
        selectedFileComplete &&
        !snapRef.current.firstFrameReady &&
        snapRef.current.videoWidth <= 0 &&
        getPlaybackPosition() < 0.5
      ) {
        const now = Date.now();
        if (!p2pCompleteReloadedRef.current && age >= ENGINE_COMPLETE_RELOAD_MS) {
          const bridge = bridgeRef.current;
          if (bridge) {
            p2pCompleteReloadedRef.current = true;
            p2pCompleteReloadedAtRef.current = now;
            console.warn("[player] completed P2P file produced no frame — reloading local stream");
            void bridge.load({
              url: src.url,
              subtitles: src.subtitles,
              notWebReady: src.notWebReady,
              headers: src.headers,
            });
            return;
          }
        }
        if (
          p2pCompleteReloadedAtRef.current > 0 &&
          now - p2pCompleteReloadedAtRef.current >= ENGINE_COMPLETE_FAILURE_MS
        ) {
          triggerAutoRetry("completed P2P file produced no video frame");
          return;
        }
      }
      if (st && st.downloaded > dlRef.current.bytes + 65536) {
        dlRef.current = { bytes: st.downloaded, at: Date.now() };
      }
      const progressing =
        !!st &&
        (st.downloadSpeed > 0 ||
          st.unchoked > 0 ||
          (dlRef.current.at > 0 && Date.now() - dlRef.current.at < GENUINE_FAILURE_WINDOW_MS));
      if (
        !progressing &&
        snapRef.current.status !== "paused" &&
        snapRef.current.videoWidth <= 0 &&
        getPlaybackPosition() < 0.5 &&
        age > ENGINE_HARD_CEILING_MS
      ) {
        triggerAutoRetry("engine produced no video within ceiling");
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [
    isP2pEngine,
    snap.status,
    engineFailure,
    triggerAutoRetry,
    bridgeRef,
    src.url,
    src.subtitles,
    src.notWebReady,
    src.headers,
  ]);

  const clearSourceError = useCallback(() => {
    probeSessionRef.current += 1;
    sourceErrorRef.current = null;
    setSourceError(null);
  }, []);

  const retryCurrentSource = useCallback(() => {
    probeSessionRef.current += 1;
    sourceErrorRef.current = null;
    setSourceError(null);
    autoRetriedRef.current = false;
    sameUrlRetriedRef.current = false;
    proxyRetriedRef.current = false;
    transcodeRescueRef.current = false;
    debridFailoverTriedRef.current = false;
    p2pCompleteReloadedRef.current = false;
    p2pCompleteReloadedAtRef.current = 0;
    truncatedReloadedRef.current = false;
    resumedAfterTruncatedRef.current = false;
    urlAtRef.current = Date.now();
    const b = bridgeRef.current;
    if (!b) return;
    void b.load({
      url: src.url,
      subtitles: src.subtitles,
      notWebReady: src.notWebReady,
      isLive,
      headers: src.headers,
    });
  }, [bridgeRef, src.url, src.subtitles, src.notWebReady, isLive, src.headers]);

  useEffect(() => {
    if (
      sourceError?.reason !== "archive_restoring" ||
      sourceError.exhausted ||
      startedPlaying ||
      sourceError.autoRetryInSec == null ||
      typeof probeStreamStatus !== "function"
    ) {
      return;
    }

    if (sourceError.autoRetryInSec > 0) {
      const timer = window.setTimeout(() => {
        setSourceError((prev) => {
          if (!prev || prev.reason !== "archive_restoring" || prev.autoRetryInSec == null) {
            return prev;
          }
          return { ...prev, autoRetryInSec: Math.max(0, prev.autoRetryInSec - 1) };
        });
      }, 1000);
      return () => window.clearTimeout(timer);
    }

    let cancelled = false;
    const session = ++probeSessionRef.current;
    const probeUrl = src.url;
    void probeStreamStatus(probeUrl, src.headers)
      .then((result) => {
        if (cancelled || probeSessionRef.current !== session || urlSeenRef.current !== probeUrl) {
          return;
        }
        if (result?.reason === "ready") {
          retryCurrentSource();
          return;
        }
        if (result && (result.reason === "http_error" || result.reason === "truncated")) {
          const terminalReason: SourceErrorReason = result.reason;
          setSourceError((prev) => {
            if (!prev) return null;
            return {
              status: result.status,
              host: result.host || prev.host,
              viaHost: result.viaHost || undefined,
              reason: terminalReason,
              detail: result.detail || undefined,
              exhausted: prev.exhausted,
              probing: false,
              autoRetryInSec: null,
            };
          });
          return;
        }
        setSourceError((prev) => {
          if (!prev || prev.reason !== "archive_restoring") return prev;
          const nextAttempt = (prev.autoRetryAttempt ?? 0) + 1;
          const retrySec = clampRetryAfterSec(result?.retryAfterSec);
          return {
            ...prev,
            status: result?.status ?? prev.status,
            host: result?.host || prev.host,
            viaHost: result?.viaHost || prev.viaHost,
            detail: result?.detail || prev.detail,
            autoRetryAttempt: nextAttempt,
            autoRetryInSec: nextAttempt < ARCHIVE_MAX_AUTO_RETRIES ? retrySec : null,
          };
        });
      })
      .catch(() => {
        if (cancelled || probeSessionRef.current !== session || urlSeenRef.current !== probeUrl) {
          return;
        }
        setSourceError((prev) => {
          if (!prev || prev.reason !== "archive_restoring") return prev;
          const nextAttempt = (prev.autoRetryAttempt ?? 0) + 1;
          return {
            ...prev,
            autoRetryAttempt: nextAttempt,
            autoRetryInSec:
              nextAttempt < ARCHIVE_MAX_AUTO_RETRIES ? ARCHIVE_POLL_INTERVAL_SEC : null,
          };
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    sourceError?.reason,
    sourceError?.exhausted,
    sourceError?.autoRetryInSec,
    sourceError?.autoRetryAttempt,
    src.url,
    src.headers,
    startedPlaying,
    retryCurrentSource,
  ]);

  return {
    slowLoad,
    transcodedUrl,
    sourceError,
    clearSourceError,
    retryCurrentSource,
  };
}
