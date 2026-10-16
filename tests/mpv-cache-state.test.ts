// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

const at = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(at(path), "utf8");

test("mpv observes demuxer-cache-state as a Node property with throttling in event loop", () => {
  const mpvRs = read("src-tauri/src/mpv.rs");
  assert.match(
    mpvRs,
    /\("demuxer-cache-state", 22, PropertyKind::Node\)/,
    "demuxer-cache-state must be registered in OBSERVED_PROPS",
  );
  assert.match(
    mpvRs,
    /else if \*name == "demuxer-cache-state"/,
    "demuxer-cache-state must be throttled to prevent IPC flooding",
  );
});

test("mpv bridge tracks seekable-ranges from demuxer-cache-state to stabilize buffer rendering", () => {
  const mpvTs = read("src/lib/player/mpv.ts");
  assert.match(
    mpvTs,
    /name === "demuxer-cache-state"/,
    "mpv bridge must process demuxer-cache-state events",
  );
  assert.match(
    mpvTs,
    /rawRanges\s*\.map/,
    "mpv bridge must extract seekable ranges",
  );
  assert.match(
    mpvTs,
    /computeBufferedSec/,
    "mpv bridge must use active seekable range to compute buffered forward duration",
  );
});
