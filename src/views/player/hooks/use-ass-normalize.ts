import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { safeFetchBytes } from "@/lib/safe-fetch";
import { decodeSubtitleBytes } from "@/lib/subtitles/encoding";
import { embeddedSubIndex, resolveReadableUrl } from "@/lib/subtitles/extract";
import { subtitleTrackDownloadHeaders } from "@/lib/subtitles/provider-auth";
import {
  assNormalizeCacheKey,
  assNormalizeTrackOrigin,
  assScaleFromFactor,
  computeAssBaseFactor,
} from "@/lib/player/ass-header";
import type { TrackInfo } from "@/lib/player/bridge";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isRemoteHttp(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0") {
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

async function loadAssText(
  sourceUrl: string,
  track: TrackInfo,
  tracks: TrackInfo[],
  headers?: Record<string, string>,
): Promise<string | null> {
  if (track.external === true || track.url) {
    const raw = track.externalFilename ?? track.url;
    if (!raw) return null;
    const isLocalPath = /^(?:[a-zA-Z]:[/\\]|\/|file:\/\/|\\\\)/i.test(raw);
    if (isTauri() && isLocalPath) {
      try {
        const text = await invoke<string>("subtitle_extract_ass", {
          source: raw,
          streamIndex: 0,
          headers: null,
        });
        if (text) return text;
      } catch {
        // Fall back to resolving readable url
      }
    }
    const readable = await resolveReadableUrl(raw);
    if (!readable) return null;
    let res: Response;
    if (/^(?:asset\.localhost|https?:\/\/asset\.localhost|asset:|blob:|data:)/i.test(readable)) {
      res = await fetch(readable);
    } else {
      // Never forward video stream credentials to third-party subtitle hosts.
      const subHeaders = subtitleTrackDownloadHeaders(
        track.downloadAuth,
        readable,
        track.providerDerived ?? Boolean(track.provider),
      );
      res = await safeFetchBytes(
        readable,
        { method: "GET", headers: subHeaders },
        30_000,
        16 * 1024 * 1024,
        track.localTrusted === true,
      );
    }
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return decodeSubtitleBytes(new Uint8Array(buf), {});
  }
  if (!isTauri()) return null;
  if (isRemoteHttp(sourceUrl)) return null;
  const streamIndex = embeddedSubIndex(tracks, track.id);
  return invoke<string>("subtitle_extract_ass", {
    source: sourceUrl,
    streamIndex,
    headers: headers ?? null,
  });
}

export function useAssNormalize(params: {
  enabled: boolean;
  holdOnNull?: boolean;
  sourceUrl: string | null;
  headers?: Record<string, string>;
  track: TrackInfo | null;
  tracks: TrackInfo[];
  targetFontSize: number;
}): number | undefined {
  const { enabled, holdOnNull = false, sourceUrl, headers, track, tracks, targetFontSize } = params;
  const cacheRef = useRef<Map<string, number | null>>(new Map());
  const cacheSourceRef = useRef<string | null>(null);
  if (cacheSourceRef.current !== sourceUrl) {
    cacheRef.current.clear();
    cacheSourceRef.current = sourceUrl;
  }
  const liveRef = useRef({ sourceUrl, track, tracks, headers });
  liveRef.current = { sourceUrl, track, tracks, headers };
  const [resolved, setResolved] = useState<{
    sourceUrl: string;
    trackOrigin: string;
    factor: number | null;
  }>({
    sourceUrl: "",
    trackOrigin: "",
    factor: null,
  });
  const key = assNormalizeCacheKey(enabled, sourceUrl, track);
  const trackOrigin = assNormalizeTrackOrigin(track);
  const hasTrack = track != null;

  useEffect(() => {
    if (!enabled || !sourceUrl) {
      setResolved({ sourceUrl: "", trackOrigin: "", factor: null });
      return;
    }
    if (!hasTrack) {
      if (!holdOnNull) {
        setResolved({ sourceUrl: "", trackOrigin: "", factor: null });
      }
      return;
    }
    if (!key) {
      setResolved({ sourceUrl: "", trackOrigin: "", factor: null });
      return;
    }
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      setResolved({ sourceUrl, trackOrigin, factor: cached });
      return;
    }
    let cancelled = false;
    void (async () => {
      const live = liveRef.current;
      let result: number | null = null;
      let textLoaded = false;
      try {
        if (live.sourceUrl && live.track) {
          const text = await loadAssText(live.sourceUrl, live.track, live.tracks, live.headers);
          if (text != null) {
            textLoaded = true;
            result = computeAssBaseFactor(text);
          }
        }
      } catch {
        result = null;
      }
      if (textLoaded && cacheSourceRef.current === sourceUrl) {
        if (cacheRef.current.size >= 32) {
          const oldest = cacheRef.current.keys().next().value;
          if (oldest !== undefined) cacheRef.current.delete(oldest);
        }
        cacheRef.current.set(key, result);
      }
      if (!cancelled) setResolved({ sourceUrl, trackOrigin, factor: result });
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, hasTrack, holdOnNull, key, sourceUrl, trackOrigin]);

  const activeFactor =
    enabled &&
    sourceUrl &&
    resolved.sourceUrl === sourceUrl &&
    ((!track && holdOnNull) ||
      (track != null && key !== "" && resolved.trackOrigin === trackOrigin))
      ? resolved.factor
      : null;
  return activeFactor == null ? undefined : assScaleFromFactor(activeFactor, targetFontSize);
}
