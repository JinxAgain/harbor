// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { extractDominantColorFromPixels } from "../src/lib/player/ambient-color.ts";

function fill(count: number, rgba: [number, number, number, number]): number[] {
  return Array.from({ length: count }, () => rgba).flat();
}

test("ambient colour picks the dominant saturated hue over the dark backdrop", () => {
  const pixels = new Uint8ClampedArray([...fill(40, [10, 12, 16, 255]), ...fill(24, [220, 42, 68, 255])]);
  const color = extractDominantColorFromPixels(pixels);
  assert.match(color ?? "", /^#[0-9a-f]{6}$/);
});

test("ambient colour yields null for near-black artwork so the theme accent applies", () => {
  assert.equal(extractDominantColorFromPixels(new Uint8ClampedArray(fill(16, [12, 12, 12, 255]))), null);
});

test("ambient colour ignores transparent pixels", () => {
  assert.equal(extractDominantColorFromPixels(new Uint8ClampedArray(fill(16, [220, 42, 68, 0]))), null);
});

