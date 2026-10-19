import { useEffect, useState } from "react";
import { lruSet } from "@/lib/cache";
import { registerEvictable } from "@/lib/maintenance";
import { safeFetch } from "@/lib/safe-fetch";

export type DoubanScore = {
  rating: number | null;
  doubanId: string | null;
  fetchedAt: number;
};

const LEGACY_CACHE_KEY = "harbor.douban.v1";
const CACHE_KEY = "harbor.douban.v2";
const CACHE_MAX = 1500;
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 2;
const MIN_INTERVAL_MS = 280;

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const cache = new Map<string, DoubanScore>();
const inflight = new Map<string, Promise<DoubanScore | null>>();
const subs = new Set<() => void>();

let loaded = false;
let blockedUntil = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    localStorage.removeItem(LEGACY_CACHE_KEY);
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, DoubanScore>;
      for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === "object") {
          cache.set(k, v);
        }
      }
    }
  } catch {
    /* ignore parse error */
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
    } catch {
      /* ignore quota errors */
    }
  }, 1000);
}

registerEvictable("douban-scores", (aggressive) => {
  if (aggressive) {
    cache.clear();
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* ignore */
    }
    notify();
  }
});

function notify(): void {
  for (const fn of subs) fn();
}

function isFresh(score: DoubanScore): boolean {
  const ttl = score.rating !== null ? HIT_TTL_MS : MISS_TTL_MS;
  return Date.now() - score.fetchedAt < ttl;
}

export function doubanCached(imdbId: string | null | undefined): DoubanScore | null {
  if (!imdbId || !imdbId.startsWith("tt")) return null;
  load();
  const hit = cache.get(imdbId);
  if (!hit) return null;
  if (!isFresh(hit)) {
    cache.delete(imdbId);
    scheduleSave();
    return null;
  }
  return hit;
}

export function parseMobileSearchHtml(
  html: string,
): { doubanId: string; rating: number | null } | null {
  const block = /<a\s+href="\/movie\/subject\/(\d+)\/"[\s\S]*?<\/a>/i.exec(html);
  if (!block?.[1]) return null;
  const doubanId = block[1];
  const ratingMatch = /<p\s+class="rating"[\s\S]*?<span>([0-9.]+)<\/span>/i.exec(block[0]);
  const val = ratingMatch?.[1] ? Number(ratingMatch[1]) : NaN;
  const rating = Number.isFinite(val) && val > 0 ? val : null;
  return { doubanId, rating };
}

export function parseDesktopSearchHtml(
  html: string,
): { doubanId: string; rating: number | null } | null {
  const sidMatch =
    /sid:\s*(\d+)/.exec(html) ??
    /subject%2F(\d+)%2F/i.exec(html) ??
    /movie\.douban\.com\/subject\/(\d+)\//i.exec(html);
  if (!sidMatch?.[1]) return null;
  const doubanId = sidMatch[1];
  const ratingMatch = /class="rating_nums">([0-9.]+)<\/span>/i.exec(html);
  const val = ratingMatch?.[1] ? Number(ratingMatch[1]) : NaN;
  const rating = Number.isFinite(val) && val > 0 ? val : null;
  return { doubanId, rating };
}

async function resolveRatingByDoubanId(
  doubanId: string,
  mediaType?: "movie" | "show",
): Promise<number | null> {
  const primaryKind = mediaType === "show" ? "tv" : "movie";
  const secondaryKind = mediaType === "show" ? "movie" : "tv";

  for (const kind of [primaryKind, secondaryKind]) {
    if (Date.now() < blockedUntil) return null;
    try {
      const res = await safeFetch(
        `https://m.douban.com/rexxar/api/v2/${kind}/${encodeURIComponent(doubanId)}`,
        {
          headers: {
            Referer: "https://m.douban.com/movie/",
            Accept: "application/json",
            "User-Agent": MOBILE_UA,
          },
        },
      );
      if (res.status === 429) {
        blockedUntil = Date.now() + BACKOFF_MS;
        return null;
      }
      if (res.ok) {
        const data = (await res.json()) as { rating?: { value?: number | string | null } };
        const val = Number(data?.rating?.value);
        if (Number.isFinite(val) && val > 0) return val;
        return null;
      }
      if (res.status !== 404) break;
    } catch {
      break;
    }
  }
  return null;
}

async function resolveFromNetwork(
  imdbId: string,
  mediaType?: "movie" | "show",
): Promise<DoubanScore | null> {
  if (Date.now() < blockedUntil) return null;

  let foundDoubanId: string | null = null;
  let anyResponseOk = false;

  // Stage 1: Single-request Mobile Search HTML (returns both doubanId and rating)
  try {
    const res = await safeFetch(
      `https://m.douban.com/search/?query=${encodeURIComponent(imdbId)}&type=1002`,
      {
        headers: {
          Referer: "https://m.douban.com/",
          "User-Agent": MOBILE_UA,
        },
      },
    );
    if (res.status === 429) {
      blockedUntil = Date.now() + BACKOFF_MS;
      return null;
    }
    if (res.ok) {
      anyResponseOk = true;
      const html = await res.text();
      const parsed = parseMobileSearchHtml(html);
      if (parsed) {
        if (parsed.rating !== null) {
          return { rating: parsed.rating, doubanId: parsed.doubanId, fetchedAt: Date.now() };
        }
        foundDoubanId = parsed.doubanId;
      }
    }
  } catch {
    /* continue to Stage 2 */
  }

  if (Date.now() < blockedUntil) return null;

  // Stage 2: Single-request Desktop Search HTML fallback
  if (!foundDoubanId) {
    try {
      const res = await safeFetch(
        `https://www.douban.com/search?cat=1002&q=${encodeURIComponent(imdbId)}`,
        {
          headers: {
            Referer: "https://www.douban.com/",
            "User-Agent": DESKTOP_UA,
          },
        },
      );
      if (res.status === 429) {
        blockedUntil = Date.now() + BACKOFF_MS;
        return null;
      }
      if (res.ok) {
        anyResponseOk = true;
        const html = await res.text();
        const parsed = parseDesktopSearchHtml(html);
        if (parsed) {
          if (parsed.rating !== null) {
            return { rating: parsed.rating, doubanId: parsed.doubanId, fetchedAt: Date.now() };
          }
          foundDoubanId = parsed.doubanId;
        }
      }
    } catch {
      /* continue to Stage 3 */
    }
  }

  if (Date.now() < blockedUntil) return null;

  // Stage 3: Wikidata SPARQL fallback for doubanId (P345 -> P4529)
  if (!foundDoubanId) {
    try {
      const query = `SELECT ?douban WHERE { ?item wdt:P345 "${imdbId}". ?item wdt:P4529 ?douban. } LIMIT 1`;
      const res = await safeFetch(
        `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`,
        {
          headers: {
            Accept: "application/sparql-results+json",
            "User-Agent": "Harbor/1.0",
          },
        },
      );
      if (res.ok) {
        anyResponseOk = true;
        const data = (await res.json()) as {
          results?: { bindings?: Array<{ douban?: { value?: string } }> };
        };
        const val = data?.results?.bindings?.[0]?.douban?.value?.trim();
        if (val && /^\d+$/.test(val)) {
          foundDoubanId = val;
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (foundDoubanId) {
    const rating = await resolveRatingByDoubanId(foundDoubanId, mediaType);
    return { rating, doubanId: foundDoubanId, fetchedAt: Date.now() };
  }

  if (!anyResponseOk) {
    // Transient network or proxy error — do not cache a 24h miss
    return null;
  }

  return { rating: null, doubanId: null, fetchedAt: Date.now() };
}

type QueueItem = {
  imdbId: string;
  mediaType?: "movie" | "show";
  priority: "high" | "normal";
  resolve: (value: DoubanScore | null) => void;
  reject: (err: unknown) => void;
};

const highQueue: QueueItem[] = [];
const normalQueue: QueueItem[] = [];
let activeWorkers = 0;
let lastRequestTime = 0;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

function processNext(): void {
  drainTimer = null;
  if (activeWorkers >= MAX_CONCURRENT) return;
  const item = highQueue.shift() ?? normalQueue.shift();
  if (!item) return;

  const cached = doubanCached(item.imdbId);
  if (cached) {
    item.resolve(cached);
    scheduleDrain();
    return;
  }

  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  if (timeSinceLast < MIN_INTERVAL_MS) {
    if (item.priority === "high") highQueue.unshift(item);
    else normalQueue.unshift(item);
    drainTimer = setTimeout(processNext, MIN_INTERVAL_MS - timeSinceLast);
    return;
  }

  activeWorkers++;
  lastRequestTime = Date.now();

  let p = inflight.get(item.imdbId);
  if (!p) {
    p = resolveFromNetwork(item.imdbId, item.mediaType)
      .then((score) => {
        if (score !== null) {
          lruSet(cache, item.imdbId, score, CACHE_MAX);
          scheduleSave();
          notify();
        }
        return score;
      })
      .catch(() => null)
      .finally(() => {
        inflight.delete(item.imdbId);
      });
    inflight.set(item.imdbId, p);
  }

  p.then((res) => {
    item.resolve(res);
  })
    .catch((err) => {
      item.reject(err);
    })
    .finally(() => {
      activeWorkers--;
      scheduleDrain();
    });

  if (activeWorkers < MAX_CONCURRENT && (highQueue.length > 0 || normalQueue.length > 0)) {
    scheduleDrain();
  }
}

function scheduleDrain(): void {
  if (drainTimer) return;
  const now = Date.now();
  const timeSinceLast = now - lastRequestTime;
  const delay = Math.max(0, MIN_INTERVAL_MS - timeSinceLast);
  drainTimer = setTimeout(processNext, delay);
}

function enqueue(
  imdbId: string,
  mediaType?: "movie" | "show",
  priority: "high" | "normal" = "normal",
): Promise<DoubanScore | null> {
  const cached = doubanCached(imdbId);
  if (cached) return Promise.resolve(cached);

  const existingInflight = inflight.get(imdbId);
  if (existingInflight) return existingInflight;

  if (priority === "high") {
    const idx = normalQueue.findIndex((q) => q.imdbId === imdbId);
    if (idx !== -1) {
      const [promoted] = normalQueue.splice(idx, 1);
      promoted.priority = "high";
      if (mediaType && !promoted.mediaType) promoted.mediaType = mediaType;
      highQueue.push(promoted);
      scheduleDrain();
      return new Promise<DoubanScore | null>((resolve, reject) => {
        const origResolve = promoted.resolve;
        const origReject = promoted.reject;
        promoted.resolve = (val) => {
          origResolve(val);
          resolve(val);
        };
        promoted.reject = (err) => {
          origReject(err);
          reject(err);
        };
      });
    }

    const highIdx = highQueue.findIndex((q) => q.imdbId === imdbId);
    if (highIdx !== -1) {
      const existing = highQueue[highIdx];
      return new Promise<DoubanScore | null>((resolve, reject) => {
        const origResolve = existing.resolve;
        const origReject = existing.reject;
        existing.resolve = (val) => {
          origResolve(val);
          resolve(val);
        };
        existing.reject = (err) => {
          origReject(err);
          reject(err);
        };
      });
    }
  } else {
    const qItem =
      highQueue.find((q) => q.imdbId === imdbId) ?? normalQueue.find((q) => q.imdbId === imdbId);
    if (qItem) {
      return new Promise<DoubanScore | null>((resolve, reject) => {
        const origResolve = qItem.resolve;
        const origReject = qItem.reject;
        qItem.resolve = (val) => {
          origResolve(val);
          resolve(val);
        };
        qItem.reject = (err) => {
          origReject(err);
          reject(err);
        };
      });
    }
  }

  return new Promise<DoubanScore | null>((resolve, reject) => {
    const item: QueueItem = { imdbId, mediaType, priority, resolve, reject };
    if (priority === "high") {
      highQueue.push(item);
    } else {
      normalQueue.push(item);
    }
    scheduleDrain();
  });
}

export function fetchDoubanScore(
  imdbId: string,
  mediaType?: "movie" | "show",
  priority: "high" | "normal" = "normal",
): Promise<DoubanScore | null> {
  if (!imdbId || !imdbId.startsWith("tt")) return Promise.resolve(null);
  return enqueue(imdbId, mediaType, priority);
}

export function doubanPrefetch(imdbId: string, mediaType?: "movie" | "show"): void {
  if (!imdbId || !imdbId.startsWith("tt")) return;
  void fetchDoubanScore(imdbId, mediaType, "normal");
}

export function useDoubanScore(
  imdbId: string | null | undefined,
  mediaType?: "movie" | "show",
  enabled = true,
  priority: "high" | "normal" = "normal",
): DoubanScore | null {
  const [score, setScore] = useState<DoubanScore | null>(() => doubanCached(imdbId));

  useEffect(() => {
    const current = doubanCached(imdbId);
    setScore(current);

    if (!enabled || !imdbId || !imdbId.startsWith("tt")) return;

    if (!current) {
      void fetchDoubanScore(imdbId, mediaType, priority);
    }

    const onChange = () => {
      setScore(doubanCached(imdbId));
    };
    subs.add(onChange);
    return () => {
      subs.delete(onChange);
    };
  }, [imdbId, mediaType, enabled, priority]);

  return enabled ? score : null;
}
