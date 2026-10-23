// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

const at = (p: string) => new URL(`../${p}`, import.meta.url);
const read = (p: string) => readFileSync(at(p), "utf8");
const simkl = read("src/lib/simkl/scrobble-hook.ts");
const trakt = read("src/lib/trakt/scrobble-hook.ts");
const safeFetch = read("src/lib/safe-fetch.ts");
const simklClient = read("src/lib/simkl/client.ts");

function compileModule(
  path: string,
  mocks: Record<string, unknown>,
  globals: Record<string, unknown> = {},
) {
  const code = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, any> = {};
  const mod = { exports };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(
    (id: string) => {
      assert.ok(id in mocks, `Unexpected import in ${path}: ${id}`);
      return mocks[id];
    },
    mod,
    exports,
    ...Object.values(globals),
  );
  return mod.exports;
}

function createHookRunner() {
  const refs: Array<{ current: any }> = [];
  const effects: Array<{ deps: unknown[] | undefined; cleanup?: () => void }> = [];
  let refIdx = 0;
  let effectIdx = 0;
  let pending: Array<{ index: number; deps: unknown[] | undefined; run: () => any }> = [];
  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef: (init: any) => refs[refIdx++] ?? (refs[refIdx - 1] = { current: init }),
    useEffect: (run: () => any, deps?: unknown[]) => {
      const i = effectIdx++;
      if (!effects[i] || !sameDeps(effects[i].deps, deps)) {
        pending.push({ index: i, deps, run });
      }
    },
    useSyncExternalStore: () => 0,
  };
  return {
    react,
    render(fn: () => void) {
      refIdx = 0;
      effectIdx = 0;
      pending = [];
      fn();
      for (const e of pending) effects[e.index]?.cleanup?.();
      for (const e of pending) effects[e.index] = { deps: e.deps, cleanup: e.run() };
    },
    unmount() {
      for (const e of effects) e?.cleanup?.();
    },
  };
}

test("no tracker gates its pause behind a setting with no UI", () => {
  for (const [name, src] of [
    ["simkl", simkl],
    ["trakt", trakt],
  ] as const) {
    assert.doesNotMatch(
      src,
      /pauseOnPauseRef|pauseListStatusOnPause/,
      `${name} pause is gated again; the flag has no UI so the gate is always off`,
    );
  }
});

test("pausing playback always tells the tracker", () => {
  for (const [name, src] of [
    ["simkl", simkl],
    ["trakt", trakt],
  ] as const) {
    const branch = src.match(
      /status === "paused" && lastActionRef\.current === "start"\)\s*\{[\s\S]{0,220}?\n\s{4}\}/,
    );
    assert.ok(branch, `${name} has no paused branch`);
    assert.match(branch[0], /"pause"/, `${name} does not send pause`);
    assert.doesNotMatch(branch[0], /if \(/, `${name} still guards the pause send`);
  }
});

test("the Simkl exit send uses a transport that survives teardown", () => {
  const beacon = simkl.slice(simkl.indexOf("function sendBeacon"));
  assert.match(beacon, /void fetch\(url\.toString\(\), \{/);
  assert.doesNotMatch(beacon, /safeFetch/);
  assert.match(beacon, /keepalive: true/);
  assert.match(safeFetch, /timeoutMs: 30000,/);
  assert.doesNotMatch(
    safeFetch.slice(
      safeFetch.indexOf('invoke<HarborFetchResponse>("harbor_fetch"'),
      safeFetch.indexOf('invoke<HarborFetchResponse>("harbor_fetch"') + 320,
    ),
    /keepalive/,
    "if harbor_fetch ever forwards keepalive, revisit whether the beacon still needs native fetch",
  );
});

test("the Simkl exit send does not queue behind the POST throttle", () => {
  assert.match(simklClient, /const POST_MIN_GAP_MS = 1050;/);
  const unmount = simkl.slice(simkl.lastIndexOf("return () => {"));
  assert.match(unmount, /sendBeacon\(/, "unmount must beacon, not go through the queued client");
  assert.doesNotMatch(
    unmount,
    /simklScrobble\(/,
    "simklScrobble waits on queueTail and can sleep 1050ms",
  );
});

test("Simkl and Trakt agree on when a session is finished", () => {
  const traktPct = Number(trakt.match(/WATCHED_MARK_PCT\s*=\s*([\d.]+)/)?.[1]);
  const simklRatio = Number(
    read("src/lib/simkl/config.ts").match(/SIMKL_WATCHED_RATIO\s*=\s*([\d.]+)/)?.[1],
  );
  assert.equal(traktPct, 85);
  assert.equal(simklRatio * 100, traktPct);
  assert.match(simkl, /WATCHED_MARK_PCT = SIMKL_WATCHED_RATIO \* 100;/);
});

test("Simkl does not write an early EOF directly to watched history", () => {
  const ended = simkl.slice(
    simkl.indexOf('if (snap.status === "ended")'),
    simkl.indexOf("if (!loadResetSeenRef.current)"),
  );
  assert.match(ended, /if \(endPct >= WATCHED_MARK_PCT/);
  assert.match(ended, /recordWatchedFallback/);
});

test("Simkl and Trakt scrobble hooks subscribe to the live playback clock and latch finished state", () => {
  for (const [name, src] of [
    ["simkl", simkl],
    ["trakt", trakt],
  ] as const) {
    assert.match(src, /subscribePlaybackClock\(/, `${name} must subscribe to playback clock`);
    assert.match(src, /finishedRef\.current = true;/, `${name} must latch finishedRef`);
    assert.match(src, /finishedRef\.current \|\|/, `${name} must consult finishedRef on exit`);
  }
});

test("usePlayerBridge defers playback clock reset on unmount so sibling cleanups read the final position", () => {
  const bridgeHook = read("src/views/player/hooks/use-player-bridge.ts");
  assert.match(bridgeHook, /let activeBridgeCount = 0;/);
  assert.match(
    bridgeHook,
    /queueMicrotask\(\(\) => \{\s*if \(activeBridgeCount === 0\) \{\s*setPlaybackClock\(0, 0\);/,
  );
});

test("Simkl and Trakt hooks track live clock ticks when snap.positionSec is stagnant and preserve progress across deferred bridge unmount", async () => {
  const runner = createHookRunner();
  const clock = compileModule("src/lib/player/playback-clock.ts", {
    react: runner.react,
  });
  let outroFinished = false;
  const simklCalls: Array<{ action: string; progress: number }> = [];
  const simklBeacons: Array<{ url: string; body: any }> = [];
  const simklFallbackCalls: Array<{ metaId: string; ep: any }> = [];
  const traktCalls: Array<{ action: string; progress: number; ep: any }> = [];

  const mockWindow = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const mockFetch = async (url: string, init: any) => {
    simklBeacons.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };

  const simklMod = compileModule(
    "src/lib/simkl/scrobble-hook.ts",
    {
      react: runner.react,
      "./provider": { useSimkl: () => ({ isConnected: true }) },
      "./scrobble": {
        simklScrobble: async (action: string, _m: string, _e: any, progress: number) => {
          simklCalls.push({ action, progress });
          return true;
        },
        buildBody: (metaId: string, ep: any, progress: number) => ({ metaId, ep, progress }),
      },
      "./pending-sync": { recordPendingWatch: () => {}, removePendingWatch: () => {} },
      "./record-watched": {
        recordWatchedFallback: async (metaId: string, ep: any) => {
          simklFallbackCalls.push({ metaId, ep });
          return true;
        },
      },
      "@/lib/player/playback-clock": clock,
      "@/lib/player/playback-finished": {
        isPlaybackFinished: (pos: number, dur: number, thresh: number) =>
          outroFinished || (dur > 0 && (pos / dur) * 100 >= thresh),
      },
      "@/lib/settings": {
        useSettings: () => ({ settings: { simklScrobbleEnabled: true, watchedThreshold: 85 } }),
      },
      "./config": {
        SIMKL_API_BASE: "https://api.simkl.com",
        SIMKL_APP_NAME: "Harbor",
        SIMKL_APP_VERSION: "1.0",
        SIMKL_CLIENT_ID: "cid",
        SIMKL_USER_AGENT: "Harbor/1.0",
        SIMKL_WATCHED_RATIO: 0.85,
      },
      "./session": { getSession: () => ({ accessToken: "tok" }) },
    },
    { window: mockWindow, fetch: mockFetch },
  );

  const traktMod = compileModule(
    "src/lib/trakt/scrobble-hook.ts",
    {
      react: runner.react,
      "./provider": {
        useTrakt: () => ({
          isConnected: true,
          resolveTarget: () => ({
            kind: "episode",
            show: { ids: { imdb: "tt100" } },
            season: 1,
            number: 1,
          }),
          scrobble: (action: string, args: any) => {
            traktCalls.push({ action, progress: args.progress, ep: args.episode });
          },
        }),
      },
      "./config": {
        TRAKT_API_BASE: "https://api.trakt.tv",
        TRAKT_API_VERSION: "2",
        TRAKT_CLIENT_ID: "tid",
      },
      "./session": { getSession: () => ({ accessToken: "tok" }) },
      "@/lib/player/playback-clock": clock,
      "@/lib/player/playback-finished": {
        isPlaybackFinished: (pos: number, dur: number, thresh: number) =>
          outroFinished || (dur > 0 && (pos / dur) * 100 >= thresh),
      },
      "@/lib/settings": {
        useSettings: () => ({ settings: { watchedThreshold: 85 } }),
      },
    },
    { window: mockWindow, fetch: mockFetch },
  );

  // 1. Start playback at 0s, then advance via live playback clock (snap.positionSec stays 0)
  clock.setPlaybackClock(0, 0);
  const ep1Src = {
    meta: { id: "kitsu:47640", type: "series", name: "Test" },
    episode: { season: 1, episode: 1 },
    url: "https://media.test/1.mkv",
  };
  runner.render(() => {
    traktMod.useTraktScrobble({
      src: ep1Src,
      snap: { status: "playing", positionSec: 0, durationSec: 1000 },
    });
    simklMod.useSimklScrobble({
      src: ep1Src,
      snap: { status: "playing", positionSec: 0, durationSec: 1000 },
    });
  });
  assert.equal(simklCalls.length, 1);
  assert.equal(simklCalls[0].action, "start");
  assert.equal(traktCalls.length, 1);
  assert.equal(traktCalls[0].action, "start");

  // 2. Clock reaches 720s (72% < 85%) during an outro segment -> latches finishedRef
  outroFinished = true;
  clock.setPlaybackClock(720, 800);
  // Outro segment is cleared before in-place transition to episode 2
  outroFinished = false;

  const ep2Src = {
    meta: { id: "kitsu:47640", type: "series", name: "Test" },
    episode: { season: 1, episode: 2 },
    url: "https://media.test/2.mkv",
  };
  runner.render(() => {
    traktMod.useTraktScrobble({
      src: ep2Src,
      snap: { status: "loading", positionSec: 0, durationSec: 0 },
    });
    simklMod.useSimklScrobble({
      src: ep2Src,
      snap: { status: "loading", positionSec: 0, durationSec: 0 },
    });
  });

  assert.equal(simklBeacons.length, 1);
  assert.ok(simklBeacons[0].url.includes("/scrobble/stop"));
  assert.equal(simklBeacons[0].body.progress, 100);
  assert.equal(simklFallbackCalls.length, 1);
  assert.deepEqual(simklFallbackCalls[0].ep, { season: 1, episode: 1 });
  assert.equal(traktCalls.at(-1)?.action, "stop");
  assert.equal(traktCalls.at(-1)?.progress, 100);

  // 3. Episode 2 starts playing and advances to 40% (400s / 1000s) via live clock
  clock.setPlaybackClock(0, 0);
  runner.render(() => {
    traktMod.useTraktScrobble({
      src: ep2Src,
      snap: { status: "playing", positionSec: 0, durationSec: 1000 },
    });
    simklMod.useSimklScrobble({
      src: ep2Src,
      snap: { status: "playing", positionSec: 0, durationSec: 1000 },
    });
  });
  clock.setPlaybackClock(400, 500);

  // Simulate usePlayerBridge cleanup running first on unmount (deferred via queueMicrotask)
  let activeBridgeCount = 1;
  activeBridgeCount = Math.max(0, activeBridgeCount - 1);
  queueMicrotask(() => {
    if (activeBridgeCount === 0) {
      clock.setPlaybackClock(0, 0);
      clock.setPlaybackStatus("idle");
    }
  });
  // Sibling scrobble hooks unmount synchronously in the same React unmount pass
  runner.unmount();

  assert.equal(simklBeacons.length, 2);
  assert.ok(simklBeacons[1].url.includes("/scrobble/pause"));
  assert.equal(simklBeacons[1].body.progress, 40);
  assert.equal(traktCalls.at(-1)?.action, "pause");
  assert.equal(traktCalls.at(-1)?.progress, 40);

  // After microtask flushes, clock is reset to 0
  await Promise.resolve();
  assert.equal(clock.getPlaybackPosition(), 0);
});


