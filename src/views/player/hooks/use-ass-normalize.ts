import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { safeFetch } from "@/lib/safe-fetch";
import { decodeSubtitleBytes } from "@/lib/subtitles/encoding";
import { embeddedSubIndex, resolveReadableUrl } from "@/lib/subtitles/extract";
import {
  assNormalizeCacheKey,
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
    const isLocalPath = /^(?:[a-zA-Z]:[/\\]|\/|file:\/\/)/i.test(raw);
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
      res = await safeFetch(readable, { method: "GET", headers });
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
  sourceUrl: string | null;
  headers?: Record<string, string>;
  track: TrackInfo | null;
  tracks: TrackInfo[];
  targetFontSize: number;
}): number | undefined {
  const { enabled, sourceUrl, headers, track, tracks, targetFontSize } = params;
  const cacheRef = useRef<Map<string, number | null>>(new Map());
  const liveRef = useRef({ sourceUrl, track, tracks, headers });
  liveRef.current = { sourceUrl, track, tracks, headers };
  const [resolved, setResolved] = useState<{ sourceUrl: string; factor: number | null }>({
    sourceUrl: "",
    factor: null,
  });
  const key = assNormalizeCacheKey(enabled, sourceUrl, track);

  useEffect(() => {
    if (!key || !sourceUrl) {
      setResolved({ sourceUrl: "", factor: null });
      return;
    }
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      setResolved({ sourceUrl, factor: cached });
      return;
    }
    let cancelled = false;
    void (async () => {
      const live = liveRef.current;
      let result: number | null = null;
      let loadedCleanly = false;
      try {
        if (live.sourceUrl && live.track) {
          const text = await loadAssText(live.sourceUrl, live.track, live.tracks, live.headers);
          result = text ? computeAssBaseFactor(text) : null;
          loadedCleanly = true;
        }
      } catch {
        result = null;
      }
      if (loadedCleanly) {
        cacheRef.current.set(key, result);
      }
      if (!cancelled) setResolved({ sourceUrl, factor: result });
    })();
    return () => {
      cancelled = true;
    };
  }, [key, sourceUrl]);

  const activeFactor =
    key && sourceUrl && resolved.sourceUrl === sourceUrl ? resolved.factor : null;
  return activeFactor == null ? undefined : assScaleFromFactor(activeFactor, targetFontSize);
}
