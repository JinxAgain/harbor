// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  clampGlassOpacity,
  DEFAULT_GLASS_OPACITY,
  MAX_GLASS_OPACITY,
  MIN_GLASS_OPACITY,
  resolveLiquidGlassTier,
  supportsEnhancedLiquidGlass,
  syncLiquidGlassRootState,
} from "../src/lib/liquid-glass.ts";
import { parseStoredSettings } from "../src/lib/settings/load.ts";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const source = readFileSync(
  new URL("../src/components/ThreeLiquidGlassSurface.tsx", import.meta.url),
  "utf8",
);

test("liquid glass does not ship the Three.js runtime or types", () => {
  assert.equal(packageJson.dependencies?.three, undefined);
  assert.equal(packageJson.devDependencies?.["@types/three"], undefined);
  assert.doesNotMatch(source, /from ["']three["']/);
});

test("liquid glass does not keep a GPU render loop alive", () => {
  assert.doesNotMatch(source, /getContext\("webgl/);
  assert.doesNotMatch(source, /requestAnimationFrame/);
  assert.doesNotMatch(source, /<canvas/);
  assert.match(source, /linear-gradient/);
  assert.match(source, /backdropFilter:\s+blurEnabled \?/);
  assert.match(source, /WebkitBackdropFilter/);
});

test("liquid glass keeps its public compatibility props", () => {
  assert.doesNotMatch(source, /spectralStrength/);
  assert.match(source, /refractionStrength/);
  assert.match(source, /lensStrength/);
  assert.match(source, /alwaysActive/);
  assert.match(source, /surfaceClassName/);
  assert.match(source, /variant/);
  assert.match(source, /backdropBlur/);
});

test("clampGlassOpacity clamps values within [15, 100] and falls back to default on invalid inputs", () => {
  assert.equal(clampGlassOpacity(90), 90);
  assert.equal(clampGlassOpacity(15), 15);
  assert.equal(clampGlassOpacity(100), 100);
  assert.equal(clampGlassOpacity(5), MIN_GLASS_OPACITY);
  assert.equal(clampGlassOpacity(-10), MIN_GLASS_OPACITY);
  assert.equal(clampGlassOpacity(120), MAX_GLASS_OPACITY);
  assert.equal(clampGlassOpacity("50"), 50);
  assert.equal(clampGlassOpacity("invalid"), DEFAULT_GLASS_OPACITY);
  assert.equal(clampGlassOpacity(null), DEFAULT_GLASS_OPACITY);
  assert.equal(clampGlassOpacity(undefined), DEFAULT_GLASS_OPACITY);
  assert.equal(clampGlassOpacity(NaN), DEFAULT_GLASS_OPACITY);
});

test("supportsEnhancedLiquidGlass enables enhanced tier only on Chromium/WebView2 and gates platforms/accessibility", () => {
  // Windows with Chromium
  assert.equal(
    supportsEnhancedLiquidGlass({
      os: "windows",
      hasChromeGlobal: true,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    }),
    true,
  );

  // macOS (WKWebView) downgrade
  assert.equal(
    supportsEnhancedLiquidGlass({
      os: "macos",
      hasChromeGlobal: true,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0",
    }),
    false,
  );

  // Linux (WebKitGTK) downgrade
  assert.equal(
    supportsEnhancedLiquidGlass({
      os: "linux",
      hasChromeGlobal: true,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0",
    }),
    false,
  );

  // Pure WebKit UA without Chromium
  assert.equal(
    supportsEnhancedLiquidGlass({
      os: "windows",
      hasChromeGlobal: false,
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    }),
    false,
  );

  // Accessibility gates: reduced transparency
  assert.equal(
    supportsEnhancedLiquidGlass({
      os: "windows",
      hasChromeGlobal: true,
      reducedTransparency: true,
    }),
    false,
  );

  // Accessibility gates: reduced motion
  assert.equal(
    supportsEnhancedLiquidGlass({
      os: "windows",
      hasChromeGlobal: true,
      reducedMotion: true,
    }),
    false,
  );
});

test("resolveLiquidGlassTier resolves off, base, and enhanced states correctly", () => {
  const enhancedEnv = {
    os: "windows",
    hasChromeGlobal: true,
    userAgent: "Chrome/120.0.0.0",
    reducedTransparency: false,
    reducedMotion: false,
  };
  const webKitEnv = {
    os: "macos",
    hasChromeGlobal: false,
    userAgent: "AppleWebKit/605.1.15",
  };

  // When liquidGlass is disabled
  assert.equal(
    resolveLiquidGlassTier({ liquidGlass: false, experimentalLiquidGlassEnabled: false }, enhancedEnv),
    "off",
  );
  assert.equal(
    resolveLiquidGlassTier({ liquidGlass: false, experimentalLiquidGlassEnabled: true }, enhancedEnv),
    "off",
  );

  // When liquidGlass is enabled but experimental is false
  assert.equal(
    resolveLiquidGlassTier({ liquidGlass: true, experimentalLiquidGlassEnabled: false }, enhancedEnv),
    "base",
  );

  // When experimental is true and environment supports it
  assert.equal(
    resolveLiquidGlassTier({ liquidGlass: true, experimentalLiquidGlassEnabled: true }, enhancedEnv),
    "enhanced",
  );

  // When experimental is true but environment does NOT support it
  assert.equal(
    resolveLiquidGlassTier({ liquidGlass: true, experimentalLiquidGlassEnabled: true }, webKitEnv),
    "base",
  );
});

test("syncLiquidGlassRootState synchronizes dataset attributes and CSS variables onto root element", () => {
  const properties = new Map<string, string>();
  const dataset: Record<string, string> = {};

  const mockRoot = {
    dataset,
    style: {
      setProperty(key: string, val: string) {
        properties.set(key, val);
      },
      removeProperty(key: string) {
        properties.delete(key);
      },
    },
  } as unknown as HTMLElement;

  // 1. Off state
  syncLiquidGlassRootState(
    {
      liquidGlass: false,
      experimentalLiquidGlassEnabled: false,
      experimentalLiquidGlassOpacity: 90,
    },
    mockRoot,
  );
  assert.equal(mockRoot.dataset.liquidGlass, undefined);
  assert.equal(mockRoot.dataset.liquidGlassTier, undefined);
  assert.equal(properties.has("--harbor-glass-opacity"), false);

  // 2. Base on state
  syncLiquidGlassRootState(
    {
      liquidGlass: true,
      experimentalLiquidGlassEnabled: false,
      experimentalLiquidGlassOpacity: 80,
    },
    mockRoot,
  );
  assert.equal(mockRoot.dataset.liquidGlass, "on");
  assert.equal(mockRoot.dataset.liquidGlassTier, "base");
  assert.equal(properties.get("--harbor-glass-opacity"), "0.800");

  // 3. Turn off again: cleanly removes attributes and properties
  syncLiquidGlassRootState(
    {
      liquidGlass: false,
      experimentalLiquidGlassEnabled: false,
      experimentalLiquidGlassOpacity: 80,
    },
    mockRoot,
  );
  assert.equal(mockRoot.dataset.liquidGlass, undefined);
  assert.equal(mockRoot.dataset.liquidGlassTier, undefined);
  assert.equal(properties.has("--harbor-glass-opacity"), false);
});

test("settings loader migrates legacy 25% opacity to default 90% and clamps values", () => {
  // 1. Unmigrated with legacy 25% opacity
  const migrated25 = parseStoredSettings(JSON.stringify({ experimentalLiquidGlassOpacity: 25 }));
  assert.equal(migrated25.experimentalLiquidGlassOpacity, 90);

  // 2. Unmigrated with null / missing opacity
  const migratedNull = parseStoredSettings(JSON.stringify({}));
  assert.equal(migratedNull.experimentalLiquidGlassOpacity, 90);

  // 3. Unmigrated with explicit custom opacity (e.g., 60%)
  const migrated60 = parseStoredSettings(JSON.stringify({ experimentalLiquidGlassOpacity: 60 }));
  assert.equal(migrated60.experimentalLiquidGlassOpacity, 60);

  // 4. Out of bounds opacity below 15% is clamped to 15%
  const migratedLow = parseStoredSettings(JSON.stringify({ experimentalLiquidGlassOpacity: 5 }));
  assert.equal(migratedLow.experimentalLiquidGlassOpacity, 15);

  // 5. Already migrated with _liquidGlassUnifiedV1: true preserves 25% if deliberately set
  const alreadyMigrated = parseStoredSettings(
    JSON.stringify({ _liquidGlassUnifiedV1: true, experimentalLiquidGlassOpacity: 25 }),
  );
  assert.equal(alreadyMigrated.experimentalLiquidGlassOpacity, 25);
});

