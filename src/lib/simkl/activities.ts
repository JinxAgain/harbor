import { subscribeActivitiesMutation } from "./activities/gate";
import { clearLocalCache } from "./activities/store";
import { updateCachedStatusByTarget } from "./activities/targets";
import { getSession, subscribeSession } from "./session";
import type { SimklTarget } from "./types";

export type { SimklCacheItem, SimklCache } from "./activities/store";
export { getLocalCache, saveLocalCache, clearLocalCache } from "./activities/store";
export { syncWatchlistCache, getCachedSimklData } from "./activities/sync";
export {
  updateCachedStatus,
  updateCachedStatusByTarget,
  updateCachedRatingByTarget,
  getCachedRatingByTarget,
} from "./activities/targets";

let lastSessionUsername: string | null | undefined = getSession()?.username;
subscribeSession(() => {
  const current = getSession();
  if (!current || (lastSessionUsername && current.username && current.username !== lastSessionUsername)) {
    clearLocalCache();
  }
  lastSessionUsername = current?.username;
});

subscribeActivitiesMutation((mutation) => {
  if (mutation?.kind === "remove-target") {
    const kind =
      mutation.targetKind === "movie"
        ? "movie"
        : mutation.targetKind === "anime" || mutation.targetKind === "anime-episode"
          ? "anime"
          : "show";
    updateCachedStatusByTarget({ kind, ids: mutation.ids as SimklTarget extends { ids: infer I } ? I : never }, null);
  }
});
