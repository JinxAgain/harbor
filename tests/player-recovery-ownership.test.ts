import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { emptySnapshot } from "../src/lib/player/bridge.ts";

function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function recoveryHarness() {
  const effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
  const refs: Array<{ current: any }> = [],
    states: any[] = [],
    memos: any[] = [];
  let ri = 0,
    si = 0,
    mi = 0,
    ei = 0,
    position = 0,
    timer = 0;
  const timers = new Map<number, { id: number; cb: () => void; ms: number; cleared: boolean }>();
  let pending: Array<{ i: number; deps?: unknown[]; run: () => any }> = [];
  const same = (a?: unknown[], b?: unknown[]) =>
    !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const react = {
    useRef: (value: any) => refs[ri++] ?? (refs[ri - 1] = { current: value }),
    useState: (value: any) => {
      const i = si++;
      if (!(i in states)) states[i] = value;
      return [
        states[i],
        (next: any) => {
          states[i] = typeof next === "function" ? next(states[i]) : next;
        },
      ];
    },
    useCallback: (fn: any, deps: unknown[]) => {
      const i = mi++;
      if (!memos[i] || !same(memos[i].deps, deps)) memos[i] = { deps, fn };
      return memos[i].fn;
    },
    useEffect: (run: () => any, deps?: unknown[]) => {
      const i = ei++;
      if (!effects[i] || !same(effects[i].deps, deps)) pending.push({ i, deps, run });
    },
  };
  const makeBridge = () => ({
    loads: [] as any[],
    destroyed: 0,
    load(src: any) {
      this.loads.push(src);
      return Promise.resolve();
    },
    destroy() {
      this.destroyed++;
    },
  });
  const bridge = makeBridge(),
    bridgeRef = { current: bridge as ReturnType<typeof makeBridge> | null };
  const proxyRequests: Array<{ args: any[]; job: ReturnType<typeof deferred> }> = [];
  const debridRequests: Array<{ args: any[]; job: ReturnType<typeof deferred> }> = [];
  const probes: Array<ReturnType<typeof deferred>> = [],
    pickers: any[][] = [];
  const dependencies = {
    getPlaybackPosition: () => position,
    getPlaybackBuffered: () => 0,
    usePlaybackFlag: (read: () => boolean) => read(),
    isLocalUrl: () => false,
    isTruncatedEnd: () => false,
    clearOnePickerCache() {},
    registerStreamProxy: (...args: any[]) => {
      const job = deferred();
      proxyRequests.push({ args, job });
      return job.promise;
    },
    resolveViaDebrids: (...args: any[]) => {
      const job = deferred();
      debridRequests.push({ args, job });
      return job.promise;
    },
    probeStremioServer: () => {
      const job = deferred();
      probes.push(job);
      return job.promise;
    },
    buildTranscodedUrl: (url: string) => `transcode:${url}`,
    BLACK_SCREEN_GRACE_MS: 15000,
    MAX_AUTORETRY_ATTEMPTS: 4,
    NEVER_STARTED_CEILING_MS: 75000,
    ROOM_STALL_MS: 15000,
    SLOW_LOAD_MS: 10000,
    STUCK_AUTORETRY_MS: 20000,
    GENUINE_FAILURE_WINDOW_MS: 30000,
  };
  const source = readFileSync(
    new URL("../src/views/player/hooks/use-auto-retry.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module: any = {};
  new Function("require", "exports", "window", "console", compiled)(
    (id: string) => (id === "react" ? react : dependencies),
    module,
    {
      setTimeout: (cb: () => void, ms = 0) => {
        const id = ++timer;
        timers.set(id, { id, cb, ms, cleared: false });
        return id;
      },
      clearTimeout: (id: number) => {
        const entry = timers.get(id);
        if (entry) entry.cleared = true;
      },
      setInterval: () => ++timer,
      clearInterval() {},
    },
    { warn() {} },
  );
  let params: any = {
    src: { url: "https://media.test/a.mkv", meta: { id: "tt100", type: "movie" }, subtitles: [] },
    snap: { ...emptySnapshot, status: "loading" },
    bridgeRef,
    stremioServerTranscode: true,
    instantPlay: true,
    inRoom: false,
    debrids: [],
    selfFrameReadyRef: { current: false },
    openPicker: (...args: any[]) => pickers.push(args),
    engineFailure: false,
    isP2pEngine: false,
    engineStats: null,
  };
  let result: any;
  const render = (patch: any = {}) => {
    params = { ...params, ...patch };
    ri = si = mi = ei = 0;
    pending = [];
    result = module.useAutoRetry(params);
    for (const e of pending) effects[e.i]?.cleanup?.();
    for (const e of pending) effects[e.i] = { deps: e.deps, cleanup: e.run() };
    return result;
  };
  const fail = () => render({ snap: { ...emptySnapshot, status: "error", errorCode: "decode" } });
  const cycle = () => {
    render({ snap: { ...emptySnapshot, status: "loading" } });
    fail();
  };
  const runTimersUpTo = (ms: number) => {
    for (const entry of Array.from(timers.values())) {
      if (entry.cleared || entry.ms > ms) continue;
      entry.cleared = true;
      entry.cb();
    }
  };
  render();
  return {
    render,
    fail,
    cycle,
    runTimersUpTo,
    bridge,
    bridgeRef,
    makeBridge,
    proxyRequests,
    debridRequests,
    probes,
    pickers,
    get params() {
      return params;
    },
    clock: (pos: number) => {
      position = pos;
    },
    next: (url = "https://media.test/b.mkv") =>
      render({
        src: { ...params.src, url, meta: { id: "tt200", type: "movie" } },
        snap: { ...emptySnapshot, status: "loading" },
      }),
    unmount: () => {
      for (const effect of effects) effect.cleanup?.();
    },
  };
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

for (const rejected of [false, true]) {
  test(`old proxy ${rejected ? "failure" : "response"} cannot replace the user's next source`, async () => {
    const h = recoveryHarness();
    h.fail();
    h.cycle();
    assert.equal(h.proxyRequests.length, 1);
    const old = h.proxyRequests[0].job;
    h.next();
    if (rejected) old.reject(new Error("proxy unavailable"));
    else old.resolve({ url: "https://proxy.test/old" });
    await settle();
    assert.equal(h.bridge.loads.length, 1, "only the earlier same-URL retry should have loaded");
    assert.equal(h.bridge.destroyed, 0);
    assert.equal(h.pickers.length, 0, "old errors must not open the old title's picker");
  });
}

test("late proxy response cannot load a replacement bridge", async () => {
  const h = recoveryHarness();
  h.fail();
  h.cycle();
  const replacement = h.makeBridge();
  h.bridgeRef.current = replacement;
  h.proxyRequests[0].job.resolve({ url: "https://proxy.test/old" });
  await settle();
  assert.equal(replacement.loads.length, 0);
});

test("unmount cancels debrid resolution and ignores its late result", async () => {
  const h = recoveryHarness();
  h.render({ src: { ...h.params.src, streamRef: { infoHash: "fixture-hash" } }, debrids: [{}] });
  h.fail();
  const request = h.debridRequests[0];
  assert.ok(request);
  h.unmount();
  assert.equal(request.args[4].aborted, true);
  request.job.resolve({ ok: true, via: "fixture", data: { url: "https://debrid.test/old" } });
  await settle();
  assert.equal(h.bridge.loads.length, 0);
});

test("source changes during debrid header proxy setup cannot load the old stream", async () => {
  const h = recoveryHarness();
  h.render({ src: { ...h.params.src, streamRef: { infoHash: "fixture-hash" } }, debrids: [{}] });
  h.fail();
  h.debridRequests[0].job.resolve({
    ok: true,
    via: "fixture",
    data: { url: "https://debrid.test/old", headers: { "X-Fixture": "test" } },
  });
  await settle();
  assert.equal(h.proxyRequests.length, 1);
  h.next();
  h.proxyRequests[0].job.resolve({ url: "https://proxy.test/old" });
  await settle();
  assert.equal(h.bridge.loads.length, 0);
});

test("late remux response cannot replace a new source with the same URL", async () => {
  const h = recoveryHarness();
  h.fail();
  h.cycle();
  h.proxyRequests[0].job.resolve({ url: "https://proxy.test/a" });
  await settle();
  h.cycle();
  assert.equal(h.proxyRequests.length, 2);
  assert.deepEqual(h.proxyRequests[1].args[2], { transcode: true });
  h.next(h.params.src.url);
  h.proxyRequests[1].job.resolve({ url: "https://proxy.test/remux-old" });
  await settle();
  assert.equal(h.bridge.loads.length, 2);
});

test("late server probe cannot destroy a new player or select old transcoding", async () => {
  const h = recoveryHarness();
  h.render({ src: { ...h.params.src, url: "http://127.0.0.1:11470/a" } });
  h.fail();
  h.cycle();
  assert.equal(h.probes.length, 1);
  h.next();
  h.probes[0].resolve(true);
  await settle();
  assert.equal(h.bridge.destroyed, 0);
  assert.equal(h.render().transcodedUrl, null);
});

test("normal proxy recovery still loads the current source", async () => {
  const h = recoveryHarness();
  h.fail();
  h.cycle();
  h.proxyRequests[0].job.resolve({ url: "https://proxy.test/current" });
  await settle();
  assert.equal(h.bridge.loads.at(-1)?.url, "https://proxy.test/current");
});

test("proxy failure still advances automatic playback for the current source", async () => {
  const h = recoveryHarness();
  h.fail();
  h.cycle();
  h.proxyRequests[0].job.reject(new Error("proxy unavailable"));
  await settle();
  assert.equal(h.pickers.length, 1);
  assert.equal(h.pickers[0][0].id, "tt100");
  assert.equal(h.bridge.destroyed, 1);
});

test("playback that recovered while a proxy was pending is not interrupted", async () => {
  const h = recoveryHarness();
  h.fail();
  h.cycle();
  h.clock(30);
  h.render({ snap: { ...emptySnapshot, status: "playing", firstFrameReady: true } });
  h.proxyRequests[0].job.resolve({ url: "https://proxy.test/stale" });
  await settle();
  assert.equal(h.bridge.loads.length, 1);
});

test("normal debrid recovery retains the resolved URL and stream format", async () => {
  const h = recoveryHarness();
  h.render({ src: { ...h.params.src, streamRef: { infoHash: "fixture-hash" } }, debrids: [{}] });
  h.fail();
  h.debridRequests[0].job.resolve({
    ok: true,
    via: "fixture",
    data: { url: "https://debrid.test/current", notWebReady: true },
  });
  await settle();
  assert.deepEqual(h.bridge.loads[0], {
    url: "https://debrid.test/current",
    subtitles: [],
    notWebReady: true,
  });
});

test("a rejected debrid request falls back only while its source is current", async () => {
  for (const leave of [false, true]) {
    const h = recoveryHarness();
    h.render({ src: { ...h.params.src, streamRef: { infoHash: "fixture-hash" } }, debrids: [{}] });
    h.fail();
    if (leave) h.unmount();
    h.debridRequests[0].job.reject(new Error("debrid unavailable"));
    await settle();
    assert.equal(h.pickers.length, leave ? 0 : 1);
    assert.equal(h.bridge.destroyed, leave ? 0 : 1);
  }
});

test("server transcoding still activates for the current failed source", async () => {
  const h = recoveryHarness();
  h.render({ src: { ...h.params.src, url: "http://127.0.0.1:11470/a" } });
  h.fail();
  h.cycle();
  h.probes[0].resolve(true);
  await settle();
  assert.equal(h.bridge.destroyed, 1);
  assert.equal(h.render().transcodedUrl, "transcode:http://127.0.0.1:11470/a");
});

test("manual source recovery failure does not silently choose another title or stream", async () => {
  const h = recoveryHarness();
  h.render({ instantPlay: false });
  h.fail();
  h.cycle();
  h.proxyRequests[0].job.reject(new Error("proxy unavailable"));
  await settle();
  assert.equal(h.pickers.length, 0);
  assert.equal(h.bridge.destroyed, 0);
  assert.equal(h.render().sourceError?.host, "media.test");
});

test("initial startAtSec failure before first frame still retries even when positionSec > 5", async () => {
  const h = recoveryHarness();
  h.clock(454);
  h.fail();
  await settle();
  assert.equal(h.bridge.loads.length, 1, "same-URL retry should run without startAtSec");
  assert.equal(h.bridge.loads[0].startAtSec, undefined);

  const started = recoveryHarness();
  started.render({
    selfFrameReadyRef: { current: true },
    snap: { ...emptySnapshot, status: "playing", firstFrameReady: true },
  });
  started.clock(454);
  started.fail();
  await settle();
  assert.equal(
    started.bridge.loads.length,
    0,
    "error after first frame with pos > 5 should not auto-reload",
  );
});

test("manual selection (autoFired: false) in Watch Together never auto-switches on stall timers or error and retryCurrentSource reloads same URL", async () => {
  const h = recoveryHarness();
  const manualUrl = "http://127.0.0.1:7000/play/3f851f49";
  h.render({
    src: {
      url: manualUrl,
      meta: { id: "tt36586020", type: "movie" },
      subtitles: [],
      autoFired: false,
    },
    instantPlay: false,
    inRoom: true,
    snap: { ...emptySnapshot, status: "loading" },
  });

  // 1. Stall timers past ROOM_STALL_MS (15s in mock) and STUCK_AUTORETRY_MS (20s in mock)
  // must NOT auto-switch a manually selected source, nor show premature error before NEVER_STARTED_CEILING_MS.
  h.runTimersUpTo(25_000);
  assert.equal(
    h.pickers.length,
    0,
    "manual selection in room must not auto-switch on ROOM_STALL_MS or STUCK_AUTORETRY_MS",
  );
  assert.equal(h.bridge.destroyed, 0);
  assert.equal(h.render().sourceError, null);

  // 2. On playback error (first fail reloads same URL, second fail on localhost skips proxy/remux and invokes triggerAutoRetry),
  // Watch Together must NOT switch to another addon via openPicker; instead it shows SourceErrorCard.
  h.fail();
  assert.equal(h.bridge.loads.length, 1);
  assert.equal(h.bridge.loads[0].url, manualUrl);
  h.cycle();
  h.probes[0].resolve(false);
  await settle();
  assert.equal(
    h.pickers.length,
    0,
    "manual selection error in room must not open picker for autoPlay",
  );
  assert.equal(h.bridge.destroyed, 0);
  assert.equal(h.render().sourceError?.host, "127.0.0.1:7000");

  // 3. Explicit retryCurrentSource() clears sourceError and reloads the same selected URL.
  h.render().retryCurrentSource();
  assert.equal(h.pickers.length, 0);
  assert.equal(h.bridge.loads.length, 2);
  assert.equal(h.bridge.loads[1].url, manualUrl);
  assert.equal(h.render().sourceError, null);
});

test("manual selection (autoFired: false) with instantPlay: true does not auto-switch on stall or error", async () => {
  const h = recoveryHarness();
  h.render({
    src: {
      url: "https://media.test/manual.mkv",
      meta: { id: "tt300", type: "movie" },
      subtitles: [],
      autoFired: false,
    },
    instantPlay: true,
    inRoom: false,
    snap: { ...emptySnapshot, status: "loading" },
  });

  h.runTimersUpTo(25_000);
  assert.equal(
    h.pickers.length,
    0,
    "manual selection must not trigger STUCK_AUTORETRY_MS even with instantPlay: true",
  );
  assert.equal(h.bridge.destroyed, 0);

  h.fail();
  h.cycle();
  h.proxyRequests[0].job.reject(new Error("proxy unavailable"));
  await settle();
  assert.equal(
    h.pickers.length,
    0,
    "manual selection must not auto-switch even when instantPlay: true",
  );
  assert.equal(h.bridge.destroyed, 0);
  assert.equal(h.render().sourceError?.host, "media.test");
});

test("auto-fired Watch Together stream (autoFired: true) still auto-retries on ROOM_STALL_MS", () => {
  const h = recoveryHarness();
  h.render({
    src: {
      url: "https://media.test/auto.mkv",
      meta: { id: "tt400", type: "movie" },
      subtitles: [],
      autoFired: true,
    },
    instantPlay: false,
    inRoom: true,
    snap: { ...emptySnapshot, status: "loading" },
  });

  h.runTimersUpTo(15_000);
  assert.equal(
    h.pickers.length,
    1,
    "autoFired Watch Together stream should still advance on room stall",
  );
  assert.equal(h.pickers[0][0].id, "tt400");
  assert.deepEqual(h.pickers[0][2], {
    autoPlay: true,
    attempt: 1,
    resume: undefined,
    startPositionMs: undefined,
  });
  assert.equal(h.bridge.destroyed, 1);
});
