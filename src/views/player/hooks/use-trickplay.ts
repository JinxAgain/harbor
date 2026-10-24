import { useEffect } from "react";
import { isBundledEngineUrl } from "@/lib/stremio-server";
import { setTrickplayState, trickplaySetUrl, trickplaySpawnEager, trickplayStop } from "@/lib/trickplay";

export function useTrickplay({ url, enabled, isLive }: { url: string; enabled: boolean; isLive?: boolean }) {
  useEffect(() => {
    if (!enabled || !url) {
      setTrickplayState({ active: false, bufferedOnly: false });
      return;
    }
    const isTorrent = isBundledEngineUrl(url);
    setTrickplayState({ active: true, bufferedOnly: isTorrent });
    let alive = true;
    const isLocal = !url.includes("://") || url.startsWith("file://");
    void trickplaySetUrl(url).then(() => {
      if (!alive) return;
      if (!isLive) {
        if (isLocal) {
          setTimeout(() => {
            if (alive) void trickplaySpawnEager();
          }, 3500);
        } else {
          void trickplaySpawnEager();
        }
      }
    });
    return () => {
      alive = false;
      setTrickplayState({ active: false, bufferedOnly: false });
      void trickplayStop();
    };
  }, [url, enabled, isLive]);
}
