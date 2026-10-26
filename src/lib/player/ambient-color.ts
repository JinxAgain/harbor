import { useEffect } from "react";

const SAMPLE_SIZE = 32;
const HUE_BINS = 12;
const MAX_CACHE_ENTRIES = 120;

const colorCache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

function rewriteProbeUrl(url: string): string {
  return url
    .replace(/^https:\/\/images\.metahub\.space\//i, "https://live.metahub.space/")
    .replace(/\/t\/p\/(w\d+|original)\//, "/t/p/w185/");
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === rn) {
    h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  } else if (max === gn) {
    h = ((bn - rn) / d + 2) / 6;
  } else {
    h = ((rn - gn) / d + 4) / 6;
  }
  return [h * 360, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = l - c / 2;
  const toHex = (v: number) =>
    Math.max(0, Math.min(255, Math.round((v + m) * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

export function extractDominantColorFromPixels(data: Uint8ClampedArray): string | null {
  const binWeights = new Float64Array(HUE_BINS);
  const binR = new Float64Array(HUE_BINS);
  const binG = new Float64Array(HUE_BINS);
  const binB = new Float64Array(HUE_BINS);

  let fallbackWeight = 0;
  let fallbackR = 0;
  let fallbackG = 0;
  let fallbackB = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 128) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);

    // Skip near-black and blown-out white pixels
    if (max < 28 || min > 235) continue;

    const chroma = (max - min) / 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const midtoneWeight = Math.max(0.15, 1 - Math.abs(lum - 0.5) * 1.4);

    fallbackWeight += midtoneWeight;
    fallbackR += r * midtoneWeight;
    fallbackG += g * midtoneWeight;
    fallbackB += b * midtoneWeight;

    // Require meaningful chromaticity to enter hue buckets
    if (chroma < 0.1) continue;

    const [hue, sat] = rgbToHsl(r, g, b);
    const bin = Math.min(HUE_BINS - 1, Math.floor((hue / 360) * HUE_BINS));
    const weight = (chroma * 0.7 + sat * 0.3) * midtoneWeight;

    binWeights[bin] += weight;
    binR[bin] += r * weight;
    binG[bin] += g * weight;
    binB[bin] += b * weight;
  }

  let bestBin = -1;
  let bestWeight = 0;
  for (let b = 0; b < HUE_BINS; b++) {
    if (binWeights[b] > bestWeight) {
      bestWeight = binWeights[b];
      bestBin = b;
    }
  }

  let avgR: number;
  let avgG: number;
  let avgB: number;

  if (bestBin >= 0 && bestWeight > 0) {
    avgR = binR[bestBin] / bestWeight;
    avgG = binG[bestBin] / bestWeight;
    avgB = binB[bestBin] / bestWeight;
  } else if (fallbackWeight > 0) {
    avgR = fallbackR / fallbackWeight;
    avgG = fallbackG / fallbackWeight;
    avgB = fallbackB / fallbackWeight;
  } else {
    return null;
  }

  const [h, s, l] = rgbToHsl(avgR, avgG, avgB);
  if (s < 0.08) return null;

  const tunedSat = Math.min(0.85, Math.max(0.55, s * 1.15));
  const tunedLight = Math.min(0.66, Math.max(0.5, l));
  return hslToHex(h, tunedSat, tunedLight);
}

function probeSingleImage(originalSrc: string): Promise<string | null> {
  // Key on the rewritten probe URL so poster/background variants of one image share a hit.
  const src = rewriteProbeUrl(originalSrc);
  const cached = colorCache.get(src);
  if (cached !== undefined) return Promise.resolve(cached);

  const running = inflight.get(src);
  if (running) return running;

  const promise = new Promise<string | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";

    let settled = false;
    const finish = (color: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      if (colorCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = colorCache.keys().next().value;
        if (firstKey !== undefined) colorCache.delete(firstKey);
      }
      colorCache.set(src, color);
      resolve(color);
    };

    const timer = window.setTimeout(() => finish(null), 6000);

    img.onerror = () => finish(null);
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) return finish(null);
      try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return finish(null);
        ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const pixels = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
        finish(extractDominantColorFromPixels(pixels));
      } catch {
        finish(null);
      }
    };

    img.src = src;
  }).finally(() => {
    inflight.delete(src);
  });

  inflight.set(src, promise);
  return promise;
}

export async function resolveAmbientColor(
  candidates: Array<string | null | undefined>,
): Promise<string | null> {
  const urls = candidates.filter((u): u is string => typeof u === "string" && u.trim().length > 0);
  for (const url of urls) {
    const color = await probeSingleImage(url);
    if (color) return color;
  }
  return null;
}

export function usePlayerAmbientColor(
  candidates: Array<string | null | undefined>,
  enabled = true,
) {
  const primary = candidates[0] ?? null;
  const secondary = candidates[1] ?? null;
  const tertiary = candidates[2] ?? null;

  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    let alive = true;

    void resolveAmbientColor([primary, secondary, tertiary]).then((color) => {
      if (!alive) return;
      if (color) {
        root.style.setProperty("--harbor-player-ambient", color);
      } else {
        root.style.removeProperty("--harbor-player-ambient");
      }
    });

    return () => {
      alive = false;
      root.style.removeProperty("--harbor-player-ambient");
    };
  }, [enabled, primary, secondary, tertiary]);
}

