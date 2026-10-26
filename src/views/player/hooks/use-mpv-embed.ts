import { useEffect } from "react";
import { modalOverlayClose, modalOverlaySync } from "@/lib/modal-overlay";
import { isLinuxDesktop, isMacDesktop, isWindowsDesktop } from "@/lib/platform";
import { usePlayerAmbientColor } from "@/lib/player/ambient-color";
import type { Settings } from "@/lib/settings";

export function useMpvEmbed(params: {
  engine: "html5" | "mpv";
  settings: Settings;
  ambientSources?: Array<string | null | undefined>;
}) {
  const { engine, settings, ambientSources } = params;

  const hdrOpaqueWindow = isWindowsDesktop() && settings.playerHdrOpaqueWindow;
  const needsTransparentWebView =
    isLinuxDesktop() || isMacDesktop() || (isWindowsDesktop() && !hdrOpaqueWindow);
  const mpvEmbedActive = engine === "mpv" && settings.playerMpvEmbed && needsTransparentWebView;

  usePlayerAmbientColor(ambientSources ?? [], mpvEmbedActive && settings.liquidGlass);

  useEffect(() => {
    if (!mpvEmbedActive) return;
    document.documentElement.dataset.mpvEmbed = "1";
    return () => {
      delete document.documentElement.dataset.mpvEmbed;
    };
  }, [mpvEmbedActive]);

  useEffect(() => {
    if (engine !== "mpv" || !settings.playerMpvEmbed) return;
    let unMove: (() => void) | null = null;
    let unResize: (() => void) | null = null;
    void (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        unMove = await win.onMoved(() => void modalOverlaySync());
        unResize = await win.onResized(() => void modalOverlaySync());
      } catch {}
    })();
    return () => {
      unMove?.();
      unResize?.();
      void modalOverlayClose();
    };
  }, [engine, settings.playerMpvEmbed]);
}
