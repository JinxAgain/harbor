import type { ScoredStream } from "@/lib/streams/types";
import { streamIdentity } from "./picker-utils";

/** Builds per-stream keys anchored to stream identity instead of list index. */
export function buildUniqueStreamKeys(streams: ScoredStream[]): string[] {
  const seen = new Map<string, number>();
  return streams.map((s) => {
    const id = streamIdentity(s);
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    return count === 1 ? id : `${id}#${count}`;
  });
}

/**
 * Preserves the relative ordering of already-displayed streams across
 * incremental addon batches or backend handoffs while refreshing their
 * objects and placing newly discovered streams in their incoming slots.
 */
export function stabilizeStreamOrder(
  prevKeys: string[],
  incoming: ScoredStream[],
): { ordered: ScoredStream[]; keys: string[] } {
  const incomingKeys = buildUniqueStreamKeys(incoming);
  if (prevKeys.length === 0 || incoming.length === 0) {
    return { ordered: incoming, keys: incomingKeys };
  }

  const incomingByKey = new Map<string, ScoredStream>();
  for (let i = 0; i < incoming.length; i += 1) {
    incomingByKey.set(incomingKeys[i], incoming[i]);
  }

  const existingOrdered: ScoredStream[] = [];
  const existingKeys = new Set<string>();
  for (const key of prevKeys) {
    const fresh = incomingByKey.get(key);
    if (!fresh || existingKeys.has(key)) continue;
    existingKeys.add(key);
    existingOrdered.push(fresh);
  }

  let existingIdx = 0;
  const ordered: ScoredStream[] = [];
  for (let i = 0; i < incoming.length; i += 1) {
    const key = incomingKeys[i];
    if (existingKeys.has(key)) {
      const nextExisting = existingOrdered[existingIdx];
      if (nextExisting) {
        ordered.push(nextExisting);
        existingIdx += 1;
      }
    } else {
      ordered.push(incoming[i]);
    }
  }

  return { ordered, keys: buildUniqueStreamKeys(ordered) };
}
