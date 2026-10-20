// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { parseStream } from "../src/lib/streams/parser/parser-stream.ts";
import {
  hasCachedMarker,
  hasUncachedMarker,
  isCached,
  isExplicitlyUncached,
} from "../src/lib/streams/cached.ts";
import { streamIsCached, needsDownload } from "../src/views/play-picker/picker-utils.ts";
import { resolveStream } from "../src/lib/streams/resolve.ts";
import { verifyAddonSamples } from "../src/lib/streams/__fixtures__/verify.ts";
import type { Stream, ScoredStream } from "../src/lib/streams/types.ts";
import type { DebridStore } from "../src/lib/debrid/types.ts";

const playPickerSource = readFileSync(
  new URL("../src/views/play-picker.tsx", import.meta.url),
  "utf8",
);
const continueCardSource = readFileSync(
  new URL("../src/components/continue-card.tsx", import.meta.url),
  "utf8",
);
const pickCardSource = readFileSync(
  new URL("../src/components/pick-card.tsx", import.meta.url),
  "utf8",
);
const playOnModalSource = readFileSync(
  new URL("../src/components/play-on-modal.tsx", import.meta.url),
  "utf8",
);
const voyageRouteSource = readFileSync(
  new URL("../src/components/voyage/voyage-route.tsx", import.meta.url),
  "utf8",
);
const kidsDetailSource = readFileSync(
  new URL("../src/views/kids-detail.tsx", import.meta.url),
  "utf8",
);
const useAutoCandidatesSource = readFileSync(
  new URL("../src/views/play-picker/use-auto-candidates.ts", import.meta.url),
  "utf8",
);
const useAutoFireSource = readFileSync(
  new URL("../src/views/play-picker/use-auto-fire.ts", import.meta.url),
  "utf8",
);

test("1. Manual mode (instantPlay: false) does not auto-fire rememberedHandledFirst", () => {
  // Verify rememberedHandledFirst requires autoActive and settings.instantPlay
  assert.match(
    playPickerSource,
    /rememberedHandledFirst\s*=\s*[\s\S]*?autoActive\s*&&[\s\S]*?settings\.instantPlay/,
  );
  // Verify rememberedInstant does NOT include !!previousMatch.url bypass
  assert.doesNotMatch(
    playPickerSource,
    /rememberedInstant\s*=[\s\S]*?\|\|\s*!!previousMatch\.url/,
  );
});

test("2. All Play entry points respect settings.instantPlay and seasonSourceLock", () => {
  // continue-card: openPicker uses settings.instantPlay or seasonSourceLock
  assert.match(
    continueCardSource,
    /openPicker\(meta,\s*episode,\s*\{\s*autoPlay:\s*!chooseEveryTime\s*&&\s*\(settings\.instantPlay\s*\|\|\s*\(!!episode\s*&&\s*settings\.seasonSourceLock\)\)/,
  );

  // pick-card: CustomHoverOverlay and CardHoverOverlay use settings.instantPlay
  assert.doesNotMatch(
    pickCardSource,
    /openPicker\(meta,\s*undefined,\s*\{\s*autoPlay:\s*true,\s*resume:\s*true\s*\}\)/,
  );
  assert.match(
    pickCardSource,
    /openPicker\(meta,\s*undefined,\s*\{\s*autoPlay:\s*settings\.instantPlay,\s*resume:\s*true\s*\}\)/,
  );

  // play-on-modal: uses settings.instantPlay or seasonSourceLock
  assert.match(
    playOnModalSource,
    /autoPlay:\s*settings\.instantPlay\s*\|\|\s*\(!!request\.episode\s*&&\s*settings\.seasonSourceLock\)/,
  );

  // voyage-route: uses settings.instantPlay
  assert.match(
    voyageRouteSource,
    /openPicker\(meta,\s*undefined,\s*\{\s*autoPlay:\s*settings\.instantPlay,\s*resume:\s*true\s*\}\)/,
  );

  // kids-detail: uses settings.instantPlay
  assert.match(
    kidsDetailSource,
    /openPicker\(meta,\s*hint,\s*\{\s*autoPlay:\s*settings\.instantPlay,\s*resume:\s*true\s*\}\)/,
  );

  // seasonSourceLock in play-picker.tsx gates autoActive on seasonLockEntry != null when !instantPlay
  assert.match(
    playPickerSource,
    /seasonLockAutoEligible\s*=\s*settings\.instantPlay\s*\|\|\s*!seasonLock\s*\|\|\s*seasonLockEntry\s*!=\s*null/,
  );

  // use-auto-fire.ts does not fall through to autoCandidates[0] when seasonLockOnly && protectingPreferredSource
  assert.match(
    useAutoFireSource,
    /if\s*\(seasonLockOnly\s*&&\s*protectingPreferredSource\)\s*\{\s*if\s*\(pipelineDone\s*\|\|\s*preferredWaitElapsed\)\s*\{\s*setAutoCancelled\(true\);\s*\}\s*return;\s*\}/,
  );
});

test("3. Uncached debrid streams with url (including [PikPak 🧲 ]) are never treated as cached, while [PikPak ⚡ ] is cached", async () => {
  const debrids: DebridStore[] = [
    {
      slug: "rd",
      name: "RealDebrid",
      token: "test-token",
      enabled: true,
      queueCache: false,
      priority: 1,
    } as unknown as DebridStore,
  ];

  // Cached PikPak stream with ⚡
  const cachedRaw: Stream = {
    name: "[PikPak ⚡ ] StremList 2160p",
    title: "Torrentio 4k DV | HDR\nBig.Buck.Bunny.2160p.mkv",
    url: "https://stremio-addon.example/stream/play.mp4",
  };
  const cachedParsed = parseStream(cachedRaw);
  assert.equal(hasCachedMarker(cachedParsed), true);
  assert.equal(hasUncachedMarker(cachedParsed), false);
  assert.equal(isExplicitlyUncached(cachedParsed, ["rd"]), false);
  assert.equal(isCached(cachedParsed, ["rd"]), true);
  assert.equal(streamIsCached(cachedParsed as unknown as ScoredStream, [{ slug: "rd" }]), true);
  assert.equal(needsDownload(cachedParsed as unknown as ScoredStream), false);

  // Uncached PikPak stream with 🧲
  const uncachedRaw: Stream = {
    name: "[PikPak 🧲 ] StremList 2160p",
    title: "Comet 2160p\nBig.Buck.Bunny.2160p.mkv",
    url: "https://stremio-addon.example/stream/resolve-uncached",
  };
  const uncachedParsed = parseStream(uncachedRaw);
  assert.equal(hasCachedMarker(uncachedParsed), false);
  assert.equal(hasUncachedMarker(uncachedParsed), true);
  assert.equal(isExplicitlyUncached(uncachedParsed, ["rd"]), true);
  assert.equal(isCached(uncachedParsed, ["rd"]), false);
  assert.equal(streamIsCached(uncachedParsed as unknown as ScoredStream, [{ slug: "rd" }]), false);
  assert.equal(needsDownload(uncachedParsed as unknown as ScoredStream), true);

  // Verify MediaFusion TRB ⚡ sample still passes
  const verifyResult = verifyAddonSamples();
  assert.equal(verifyResult.failed.length, 0, `verifyAddonSamples had failures: ${JSON.stringify(verifyResult.failed)}`);

  // Uncached markers: [RD download], [RD ⏳], [RD] Jackettio, ❌ Not Ready, and ⏳
  const markerFixtures = [
    { name: "[RD download] 1080p", title: "Movie.1080p.mkv" },
    { name: "[RD ⏳] 4k", title: "Movie.2160p.mkv" },
    { name: "[RD] Jackettio", title: "Movie.720p.mkv" },
    { name: "Prism", title: "❌ Not Ready\nMovie.1080p.mkv" },
    { name: "AIOStreams ⏳", title: "Movie.1080p.mkv" },
  ];
  for (const f of markerFixtures) {
    const s = parseStream({ ...f, url: "https://example.com/play" });
    assert.equal(isExplicitlyUncached(s, ["rd"]), true, `Expected ${f.name} to be explicitly uncached`);
    assert.equal(isCached(s, ["rd"]), false, `Expected ${f.name} to NOT be isCached`);
  }

  // Verify use-auto-candidates and use-auto-fire do not bypass isCached via !!s.url
  assert.doesNotMatch(
    useAutoCandidatesSource,
    /if\s*\(!isCached\(s\)\s*&&\s*!s\.url/,
  );
  assert.doesNotMatch(
    useAutoCandidatesSource,
    /instantPlayable\s*=\s*[\s\S]*?\|\|\s*!!s\.url/,
  );
  assert.doesNotMatch(
    useAutoFireSource,
    /topInstantPlayable\s*=[\s\S]*?\|\|\s*!!s\.url/,
  );
  assert.doesNotMatch(
    useAutoFireSource,
    /pickInstant\s*=[\s\S]*?\|\|\s*!!pick\.url/,
  );

  // Verify resolveStream rejects uncached stream with url when userCommitted is false
  const abortController = new AbortController();
  const resolveRes = await resolveStream(
    uncachedParsed as unknown as ScoredStream,
    debrids,
    abortController.signal,
    false, // userCommitted = false (autoPlay)
  );
  assert.equal(resolveRes.ok, false);
  assert.equal(resolveRes.code, "uncached-not-committed");
});
