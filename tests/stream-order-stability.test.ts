// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { parseStream } from "../src/lib/streams/parser/parser-stream.ts";
import type { ScoredStream } from "../src/lib/streams/types.ts";
import {
  buildUniqueStreamKeys,
  stabilizeStreamOrder,
} from "../src/views/play-picker/stream-order-stability.ts";

function makeScored(
  overrides: Partial<ScoredStream> & { idSuffix: string; score?: number },
): ScoredStream {
  const { idSuffix, score = 50, ...rest } = overrides;
  const parsed = parseStream({
    addonId: rest.addonId ?? "org.stremio.stremlist",
    addonName: rest.addonName ?? "StremList (115 / PikPak)",
    name: rest.name ?? "[PikPak 🧲] StremList 1080p",
    title: rest.title ?? `Movie.${idSuffix}.1080p.mkv`,
    url: rest.url ?? `http://127.0.0.1:7000/play/${idSuffix}`,
    infoHash: rest.infoHash,
    fileIdx: rest.fileIdx,
  });
  return {
    ...parsed,
    score,
    reasons: [],
    tier: "1080p",
    ...rest,
  };
}

test("buildUniqueStreamKeys generates stable identity keys independent of index shifts", () => {
  const dream = makeScored({ idSuffix: "aa7fa862", title: "DreamHD" });
  const lchd = makeScored({ idSuffix: "27472ca1", title: "LCHD" });
  const dup = makeScored({ idSuffix: "aa7fa862", title: "DreamHD" });

  const forward = buildUniqueStreamKeys([dream, lchd]);
  const reversed = buildUniqueStreamKeys([lchd, dream]);
  assert.equal(forward[0], reversed[1]);
  assert.equal(forward[1], reversed[0]);

  const withDup = buildUniqueStreamKeys([dream, lchd, dup]);
  assert.equal(withDup[0], forward[0]);
  assert.equal(withDup[2], `${forward[0]}#2`);
});

test("stabilizeStreamOrder preserves DreamHD before LCHD across partial/final flips while refreshing objects", () => {
  const dreamV1 = makeScored({ idSuffix: "aa7fa862", title: "DreamHD v1", score: 62 });
  const lchdV1 = makeScored({ idSuffix: "27472ca1", title: "LCHD v1", score: 61 });
  const initialKeys = buildUniqueStreamKeys([dreamV1, lchdV1]);

  // Simulate Rust/backend final batch flipping LCHD ahead of DreamHD.
  const lchdV2 = makeScored({ idSuffix: "27472ca1", title: "LCHD v2", score: 61 });
  const dreamV2 = makeScored({ idSuffix: "aa7fa862", title: "DreamHD v2", score: 60 });

  const stabilized = stabilizeStreamOrder(initialKeys, [lchdV2, dreamV2]);
  assert.equal(stabilized.ordered.length, 2);
  assert.equal(stabilized.ordered[0], dreamV2, "DreamHD must keep its original slot ahead of LCHD");
  assert.equal(stabilized.ordered[1], lchdV2, "LCHD must remain below DreamHD");
  assert.equal(
    stabilized.ordered[0].title,
    "DreamHD v2",
    "Metadata/object reference should be refreshed",
  );
});

test("stabilizeStreamOrder inserts newly arrived addons without reordering existing rows", () => {
  const dreamV1 = makeScored({ idSuffix: "aa7fa862", title: "DreamHD", score: 62 });
  const lchdV1 = makeScored({ idSuffix: "27472ca1", title: "LCHD", score: 61 });
  const initialKeys = buildUniqueStreamKeys([dreamV1, lchdV1]);

  const s111477 = makeScored({
    addonId: "org.111477.stremio",
    addonName: "111477 stremio",
    name: "111477 stremio",
    idSuffix: "mars111477",
    url: "https://example.invalid/mars.mkv",
    score: 80,
  });
  const lchdV2 = makeScored({ idSuffix: "27472ca1", title: "LCHD", score: 61 });
  const dreamV2 = makeScored({ idSuffix: "aa7fa862", title: "DreamHD", score: 60 });
  const hdhub = makeScored({
    addonId: "com.stremio.hdhub",
    addonName: "HdHub",
    name: "HdHub",
    idSuffix: "hdhub1",
    url: "https://example.invalid/hdhub.mkv",
    score: 45,
  });

  // Incoming has [s111477 (new), lchd (existing), dream (existing), hdhub (new)].
  const stabilized = stabilizeStreamOrder(initialKeys, [s111477, lchdV2, dreamV2, hdhub]);
  assert.deepEqual(
    stabilized.ordered.map((s) => s.url),
    [s111477.url, dreamV2.url, lchdV2.url, hdhub.url],
  );
});
