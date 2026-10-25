import type { Settings } from "@/lib/settings/types";

export type LiquidGlassTier = "off" | "base" | "enhanced";
export type GlassSurfaceRole = "dock" | "modal" | "popover" | "pill" | "hud" | "scrim";

export const MIN_GLASS_OPACITY = 15;
export const MAX_GLASS_OPACITY = 100;
export const DEFAULT_GLASS_OPACITY = 90;

export function clampGlassOpacity(value: unknown, fallback = DEFAULT_GLASS_OPACITY): number {
  if (value == null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(MAX_GLASS_OPACITY, Math.max(MIN_GLASS_OPACITY, Math.round(num)));
}

export function supportsEnhancedLiquidGlass(
  env?: {
    userAgent?: string;
    hasChromeGlobal?: boolean;
    os?: string;
    reducedTransparency?: boolean;
    reducedMotion?: boolean;
  },
): boolean {
  if (typeof window === "undefined" && !env) return false;
  const reducedTransparency =
    env?.reducedTransparency ??
    (typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-transparency: reduce)")?.matches === true);
  const reducedMotion =
    env?.reducedMotion ??
    (typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true);
  if (reducedTransparency || reducedMotion) return false;

  const os =
    env?.os ??
    (typeof document !== "undefined" ? document.documentElement.dataset.os : undefined) ??
    "";
  if (os === "macos" || os === "linux") return false;

  const ua = env?.userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "");
  const hasChrome =
    env?.hasChromeGlobal ?? (typeof window !== "undefined" && "chrome" in window);
  const isChromiumUa = /Chrome\/|Edg\/|Chromium\//.test(ua);
  const isAppleWebKitOnly = /AppleWebKit\//.test(ua) && !isChromiumUa;
  if (isAppleWebKitOnly) return false;
  return Boolean(hasChrome || isChromiumUa);
}

export function resolveLiquidGlassTier(
  settings: Pick<Settings, "liquidGlass" | "experimentalLiquidGlassEnabled">,
  env?: Parameters<typeof supportsEnhancedLiquidGlass>[0],
): LiquidGlassTier {
  if (!settings.liquidGlass) return "off";
  if (settings.experimentalLiquidGlassEnabled && supportsEnhancedLiquidGlass(env)) {
    return "enhanced";
  }
  return "base";
}

export function syncLiquidGlassRootState(
  settings: Pick<
    Settings,
    "liquidGlass" | "experimentalLiquidGlassEnabled" | "experimentalLiquidGlassOpacity"
  >,
  root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null,
): void {
  if (!root) return;
  const tier = resolveLiquidGlassTier(settings);
  if (tier === "off") {
    delete root.dataset.liquidGlass;
    delete root.dataset.liquidGlassTier;
    root.style.removeProperty("--harbor-glass-opacity");
    return;
  }
  const opacityPct = clampGlassOpacity(settings.experimentalLiquidGlassOpacity);
  root.dataset.liquidGlass = "on";
  root.dataset.liquidGlassTier = tier;
  root.style.setProperty("--harbor-glass-opacity", (opacityPct / 100).toFixed(3));
}
