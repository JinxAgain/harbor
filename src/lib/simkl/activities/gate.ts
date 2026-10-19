import { simklRequest } from "../client";
import { getSession, removePendingWatchesByIds, subscribeSession } from "../session";

// SIMKL rule: never call /sync/all-items without first checking /sync/activities.
// This is a shared, briefly-cached read of the global `activities.all` watermark so the
// full-library readers (list-status, watchlist, history) can skip a full pull when nothing
// changed. On any failure it returns null and the caller falls back to pulling (fail-open).

let cachedAll: string | null = null;
let cachedAt = 0;
let inflight: Promise<string | null> | null = null;
let generation = 0;
const GATE_TTL_MS = 20000;

export async function currentActivitiesAll(): Promise<string | null> {
  const now = Date.now();
  if (cachedAll !== null && now - cachedAt < GATE_TTL_MS) return cachedAll;
  if (inflight) return inflight;
  const owner = getSession();
  const started = generation;
  const request = (async () => {
    try {
      const a = await simklRequest<{ all?: string }>("/sync/activities");
      if (getSession() !== owner || started !== generation) return null;
      if (a && typeof a.all === "string") {
        cachedAll = a.all;
        cachedAt = Date.now();
        return cachedAll;
      }
    } catch {
      /* fail-open: caller pulls */
    } finally {
      if (started === generation) inflight = null;
    }
    return null;
  })();
  inflight = request;
  return inflight;
}

export type SimklGateMutation =
  | { kind: "write" }
  | {
      kind: "remove-target";
      ids: Record<string, unknown>;
      targetKind?: string;
    }
  | {
      kind: "remove-episodes";
      ids: Record<string, unknown>;
      season: number;
      episodes: number[];
    };

const mutationListeners = new Set<(mutation?: SimklGateMutation) => void>();

export function subscribeActivitiesMutation(
  fn: (mutation?: SimklGateMutation) => void,
): () => void {
  mutationListeners.add(fn);
  return () => {
    mutationListeners.delete(fn);
  };
}

subscribeSession(() => resetActivitiesGate());

export function resetActivitiesGate(mutation?: SimklGateMutation): void {
  generation += 1;
  cachedAll = null;
  cachedAt = 0;
  inflight = null;
  if (mutation?.kind === "remove-target") {
    removePendingWatchesByIds?.(mutation.ids);
  } else if (mutation?.kind === "remove-episodes") {
    removePendingWatchesByIds?.(mutation.ids, {
      season: mutation.season,
      episodes: mutation.episodes,
    });
  }
  for (const fn of mutationListeners) fn(mutation);
}
