import { safeFetch as fetch } from "@/lib/safe-fetch";
import type { Settings } from "@/lib/settings";
import type { SkipKind, SkipSegment } from "./types";
import { warnProviderFailure } from "./provider-log";

export type IntroDbMediaIds = {
  tvdb?: string;
  tmdb?: string;
  imdb?: string;
};

export type IntroDbEpisodeQuery = {
  season: number;
  episode: number;
  tvdbEpisodeId?: number;
  mapping?: string;
  episodeName?: string;
};

type RawSpan = {
  start_ms: number | null;
  end_ms: number | null;
  confidence?: number;
  submission_count?: number;
};

type RawResponse = {
  tvdb_id?: number;
  type?: "movie" | "tv" | string;
  season?: number | null;
  episode?: number | null;
  group_duration_ms?: number;
  intro?: RawSpan[];
  recap?: RawSpan[];
  credits?: RawSpan[];
  preview?: RawSpan[];
};

type TheIntroDbKeyed = { theIntroDbKey?: string };

const API_MEDIA_URL = "https://api.theintrodb.org/v4/media";

const cache = new Map<string, RawResponse | null>();
const inflight = new Map<string, Promise<RawResponse | null>>();

const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
let coolingUntil = 0;

let apiKey = "";
let epoch = 0;

export function readTheIntroDbKey(settings: Settings): string {
  const raw = (settings as Settings & TheIntroDbKeyed).theIntroDbKey;
  return typeof raw === "string" ? raw.trim() : "";
}

export function theIntroDbKeyPatch(value: string): Partial<Settings> {
  return { theIntroDbKey: value.trim() } as Partial<Settings> & TheIntroDbKeyed;
}

export function resetTheIntroDbState(): void {
  epoch += 1;
  cache.clear();
  inflight.clear();
  coolingUntil = 0;
}

export function setTheIntroDbApiKey(key: string): void {
  const next = key.trim();
  if (next === apiKey) return;
  apiKey = next;
  resetTheIntroDbState();
}

function formatBearerHeader(key: string): string {
  return /^bearer\s+/i.test(key) ? key : `Bearer ${key}`;
}

export function pickId(metaId: string): IntroDbMediaIds | null {
  if (metaId.startsWith("tvdb:")) {
    const parts = metaId.slice("tvdb:".length).split(":");
    const raw =
      parts[0] === "movie" || parts[0] === "series" || parts[0] === "tv" ? parts[1] : parts[0];
    if (!raw || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > 100_000_000) return null;
    return { tvdb: raw };
  }
  if (metaId.startsWith("tmdb:")) {
    const parts = metaId.slice("tmdb:".length).split(":");
    const raw =
      parts[0] === "movie" || parts[0] === "series" || parts[0] === "tv" ? parts[1] : parts[0];
    if (!raw || !/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > 10_000_000) return null;
    return { tmdb: raw };
  }
  if (metaId.startsWith("imdb:")) {
    const parts = metaId.slice("imdb:".length).split(":");
    const raw =
      parts[0] === "movie" || parts[0] === "series" || parts[0] === "tv" ? parts[1] : parts[0];
    if (raw && /^tt\d{7,8}$/i.test(raw)) return { imdb: raw.toLowerCase() };
    return null;
  }
  if (metaId.startsWith("tt")) {
    const raw = metaId.split(":")[0];
    if (/^tt\d{7,8}$/i.test(raw)) return { imdb: raw.toLowerCase() };
    return null;
  }
  return null;
}

export function isIntroDbSupportedId(metaId: string): boolean {
  return pickId(metaId) !== null;
}

function spanToSegment(span: RawSpan, kind: SkipKind, durationSec: number): SkipSegment | null {
  let startMs: number;
  let endMs: number | null;
  if (kind === "intro" || kind === "recap") {
    startMs = span.start_ms ?? 0;
    if (typeof span.end_ms !== "number" || span.end_ms <= 0) return null;
    endMs = span.end_ms;
  } else {
    if (typeof span.start_ms !== "number" || span.start_ms <= 0) return null;
    if (span.end_ms === 0) return null;
    startMs = span.start_ms;
    endMs = span.end_ms ?? (durationSec > 0 ? Math.round(durationSec * 1000) : null);
  }
  if (endMs == null) return null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  if (startMs < 0 || endMs <= startMs) return null;
  return {
    kind,
    startSec: startMs / 1000,
    endSec: endMs / 1000,
    source: "introdb",
  };
}

async function fetchRaw(cacheKey: string, baseKey: string): Promise<RawResponse | null> {
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;
  if (cache.get(baseKey) === null) return null;
  if (Date.now() < coolingUntil) return null;
  const pending = inflight.get(cacheKey);
  if (pending) return pending;
  const gen = epoch;
  const key = apiKey;
  const p = (async () => {
    const res = await fetch(
      `${API_MEDIA_URL}?${cacheKey}`,
      key ? { headers: { Authorization: formatBearerHeader(key) } } : undefined,
    );
    if (!res.ok) {
      if (res.status === 404) {
        if (gen === epoch) {
          cache.set(cacheKey, null);
          cache.set(baseKey, null);
        }
      } else if (res.status === 400 || res.status === 422) {
        if (gen === epoch) cache.set(cacheKey, null);
      } else {
        if (gen === epoch) coolingUntil = Date.now() + FAILURE_COOLDOWN_MS;
        warnProviderFailure("theintrodb", res.status, cacheKey);
      }
      return null;
    }
    const json = (await res.json()) as RawResponse;
    if (gen === epoch) cache.set(cacheKey, json);
    return json;
  })()
    .catch(() => null)
    .finally(() => {
      if (gen === epoch) inflight.delete(cacheKey);
    });
  inflight.set(cacheKey, p);
  return p;
}

export async function fetchIntroDbSegments(
  metaId: string,
  episode: IntroDbEpisodeQuery | undefined,
  durationSec: number,
): Promise<SkipSegment[]> {
  const ids = pickId(metaId);
  if (!ids) return [];

  const baseParams = new URLSearchParams();
  if (ids.tvdb) baseParams.set("tvdb_id", ids.tvdb);
  else if (ids.tmdb) baseParams.set("tmdb_id", ids.tmdb);
  else if (ids.imdb) baseParams.set("imdb_id", ids.imdb);

  if (episode) {
    if (
      !Number.isInteger(episode.season) ||
      episode.season < 0 ||
      episode.season > 1000 ||
      !Number.isInteger(episode.episode) ||
      episode.episode < 0 ||
      episode.episode > 10000
    ) {
      return [];
    }
    baseParams.set("season", String(episode.season));
    baseParams.set("episode", String(episode.episode));
    if (
      typeof episode.tvdbEpisodeId === "number" &&
      Number.isInteger(episode.tvdbEpisodeId) &&
      episode.tvdbEpisodeId > 0
    ) {
      baseParams.set("tvdb_episode_id", String(episode.tvdbEpisodeId));
    }
    if (ids.tvdb && typeof episode.mapping === "string" && episode.mapping.trim()) {
      baseParams.set("mapping", episode.mapping.trim());
    }
    if (!ids.tmdb && typeof episode.episodeName === "string" && episode.episodeName.trim()) {
      baseParams.set("episode_name", episode.episodeName.trim());
    }
  }

  const baseKey = baseParams.toString();
  const params = new URLSearchParams(baseParams);
  if (durationSec > 0 && Number.isFinite(durationSec)) {
    const durationMs = Math.round(durationSec) * 1000;
    if (durationMs > 0) params.set("duration_ms", String(durationMs));
  }

  const json = await fetchRaw(params.toString(), baseKey);
  if (!json) return [];
  const out: SkipSegment[] = [];
  const collect = (spans: RawSpan[] | undefined, kind: SkipKind) => {
    if (!spans) return;
    for (const s of spans) {
      const seg = spanToSegment(s, kind, durationSec);
      if (seg) out.push(seg);
    }
  };
  collect(json.intro, "intro");
  collect(json.recap, "recap");
  collect(json.credits, "outro");
  collect(json.preview, "outro");
  out.sort((a, b) => a.startSec - b.startSec);
  return out;
}
