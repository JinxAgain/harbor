import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { emptySnapshot } from "../src/lib/player/bridge.ts";

function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function probeHarness() {
  const effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = [];
  const refs: Array<{ current: any }> = [];
  const states: any[] = [];
  const memos: any[] = [];
  let ri = 0;
  let si = 0;
  let mi = 0;
  let ei = 0;
  let position = 0;
  let timer = 0;
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

  const bridge = {
    loads: [] as any[],
    destroyed: 0,
    load(src: any) {
      this.loads.push(src);
      return Promise.resolve();
    },
    destroy() {
      this.destroyed++;
    },
  };
  const bridgeRef = { current: bridge as typeof bridge | null };
  const streamProbes: Array<{ args: any[]; job: ReturnType<typeof deferred> }> = [];
  const pickers: any[][] = [];

  const dependencies = {
    getPlaybackPosition: () => position,
    getPlaybackBuffered: () => 0,
    usePlaybackFlag: (read: () => boolean) => read(),
    isLocalUrl: () => false,
    isTruncatedEnd: () => false,
    clearOnePickerCache() {},
    registerStreamProxy: () => Promise.resolve({ sessionId: "s", url: "https://proxy.test/s" }),
    resolveViaDebrids: () => Promise.resolve({ ok: false }),
    probeStremioServer: () => Promise.resolve(false),
    buildTranscodedUrl: (url: string) => `transcode:${url}`,
    probeStreamStatus: (...args: any[]) => {
      const job = deferred();
      streamProbes.push({ args, job });
      return job.promise;
    },
    BLACK_SCREEN_GRACE_MS: 15000,
    MAX_AUTORETRY_ATTEMPTS: 4,
    NEVER_STARTED_CEILING_MS: 45000,
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
    src: {
      url: "http://127.0.0.1:7000/play/abc123",
      meta: { id: "tt0369179", type: "series" },
      subtitles: [],
      autoFired: false,
      headers: { "X-Test": "1" },
    },
    snap: { ...emptySnapshot, status: "loading" },
    bridgeRef,
    stremioServerTranscode: false,
    instantPlay: false,
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
    return fail();
  };

  const firePendingTimers = (maxMs: number) => {
    let fired = 0;
    for (const entry of Array.from(timers.values())) {
      if (entry.cleared || entry.ms > maxMs) continue;
      entry.cleared = true;
      entry.cb();
      fired++;
    }
    return fired;
  };

  render();
  return {
    render,
    fail,
    cycle,
    firePendingTimers,
    bridge,
    streamProbes,
    pickers,
    next: (url = "http://127.0.0.1:7000/play/other") =>
      render({
        src: { ...params.src, url, meta: { id: "tt0369179", type: "series" } },
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

test("1. manual source failure probes stream and enters archive_restoring countdown with redirected host", async () => {
  const h = probeHarness();
  // First decode error reloads same URL; second triggers triggerAutoRetry -> reportSourceError.
  h.fail();
  assert.equal(h.bridge.loads.length, 1);
  h.cycle();
  let res = h.render();
  assert.equal(res.sourceError?.status, 0);
  assert.equal(res.sourceError?.probing, true);
  assert.equal(h.streamProbes.length, 1);
  assert.equal(h.streamProbes[0].args[0], "http://127.0.0.1:7000/play/abc123");

  h.streamProbes[0].job.resolve({
    status: 206,
    host: "dl-a10b-0862.mypikpak.net",
    viaHost: "127.0.0.1:7000",
    reason: "archive_restoring",
    retryAfterSec: null,
    detail: "Archive · Restoring",
  });
  await settle();
  res = h.render();

  assert.equal(res.sourceError?.reason, "archive_restoring");
  assert.equal(res.sourceError?.status, 206);
  assert.equal(res.sourceError?.host, "dl-a10b-0862.mypikpak.net");
  assert.equal(res.sourceError?.viaHost, "127.0.0.1:7000");
  assert.equal(res.sourceError?.probing, false);
  assert.equal(res.sourceError?.autoRetryInSec, 15);
  assert.equal(res.sourceError?.autoRetryAttempt, 0);
});

test("2. archive_restoring countdown polls in background and auto-reloads when file becomes ready", async () => {
  const h = probeHarness();
  h.fail();
  h.cycle();
  h.streamProbes[0].job.resolve({
    status: 206,
    host: "dl-a10b-0862.mypikpak.net",
    viaHost: "127.0.0.1:7000",
    reason: "archive_restoring",
    retryAfterSec: 10,
    detail: "Archive · Restoring",
  });
  await settle();
  let res = h.render();
  assert.equal(res.sourceError?.autoRetryInSec, 10);

  for (let sec = 10; sec > 0; sec--) {
    h.firePendingTimers(1000);
    res = h.render();
    assert.equal(res.sourceError?.autoRetryInSec, sec - 1);
  }

  // At 0s, background probe runs.
  assert.equal(h.streamProbes.length, 2);
  h.streamProbes[1].job.resolve({
    status: 206,
    host: "dl-a10b-0862.mypikpak.net",
    viaHost: "127.0.0.1:7000",
    reason: "ready",
    retryAfterSec: null,
    detail: null,
  });
  await settle();
  res = h.render();

  assert.equal(res.sourceError, null);
  assert.equal(h.bridge.loads.length, 2);
  assert.equal(h.bridge.loads[1].url, "http://127.0.0.1:7000/play/abc123");
});

test("3. archive_restoring stops auto-polling after ARCHIVE_MAX_AUTO_RETRIES attempts", async () => {
  const h = probeHarness();
  h.fail();
  h.cycle();
  h.streamProbes[0].job.resolve({
    status: 206,
    host: "dl-a10b-0862.mypikpak.net",
    viaHost: "127.0.0.1:7000",
    reason: "archive_restoring",
    retryAfterSec: 10,
    detail: "Archive · Restoring",
  });
  await settle();
  let res = h.render();

  for (let attempt = 1; attempt <= 12; attempt++) {
    for (let sec = res.sourceError.autoRetryInSec; sec > 0; sec--) {
      h.firePendingTimers(1000);
      res = h.render();
    }
    const probeIdx = h.streamProbes.length - 1;
    h.streamProbes[probeIdx].job.resolve({
      status: 206,
      host: "dl-a10b-0862.mypikpak.net",
      viaHost: "127.0.0.1:7000",
      reason: "archive_restoring",
      retryAfterSec: 10,
      detail: "Archive · Restoring",
    });
    await settle();
    res = h.render();
    assert.equal(res.sourceError?.autoRetryAttempt, attempt);
  }

  assert.equal(res.sourceError?.autoRetryInSec, null);
  assert.equal(h.streamProbes.length, 13);
});

test("4. switching url or clearing sourceError discards in-flight probe results", async () => {
  const h = probeHarness();
  h.fail();
  h.cycle();
  assert.equal(h.streamProbes.length, 1);

  h.render().clearSourceError();
  let res = h.render();
  assert.equal(res.sourceError, null);

  h.streamProbes[0].job.resolve({
    status: 206,
    host: "dl-a10b-0862.mypikpak.net",
    viaHost: "127.0.0.1:7000",
    reason: "archive_restoring",
    retryAfterSec: null,
    detail: "Archive · Restoring",
  });
  await settle();
  res = h.render();
  assert.equal(res.sourceError, null, "cleared error must stay cleared after stale probe");

  // Also test switching source while probe is in flight.
  h.fail();
  h.cycle();
  assert.equal(h.streamProbes.length, 2);
  h.next("http://127.0.0.1:7000/play/new_hash");
  h.streamProbes[1].job.resolve({
    status: 504,
    host: "127.0.0.1:7000",
    viaHost: null,
    reason: "http_error",
    retryAfterSec: null,
    detail: "Timed out",
  });
  await settle();
  res = h.render();
  assert.equal(res.sourceError, null, "stale probe from old URL must be ignored");
});

test("5. initial failure probe returning ready updates status/host without looping", async () => {
  const h = probeHarness();
  h.fail();
  h.cycle();
  const loadsBefore = h.bridge.loads.length;

  h.streamProbes[0].job.resolve({
    status: 206,
    host: "cdn.example.com",
    viaHost: "127.0.0.1:7000",
    reason: "ready",
    retryAfterSec: null,
    detail: null,
  });
  await settle();
  const res = h.render();

  assert.equal(res.sourceError?.status, 206);
  assert.equal(res.sourceError?.host, "cdn.example.com");
  assert.equal(res.sourceError?.viaHost, "127.0.0.1:7000");
  assert.equal(res.sourceError?.probing, false);
  assert.equal(h.bridge.loads.length, loadsBefore, "must not auto-reload in a loop");
});

test("6. http_error probe surfaces real status, host, and sanitized detail", async () => {
  const h = probeHarness();
  h.fail();
  h.cycle();

  h.streamProbes[0].job.resolve({
    status: 504,
    host: "127.0.0.1:7000",
    viaHost: null,
    reason: "http_error",
    retryAfterSec: null,
    detail: "Offline download timed out. Please retry in a few moments.",
  });
  await settle();
  const res = h.render();

  assert.equal(res.sourceError?.reason, "http_error");
  assert.equal(res.sourceError?.status, 504);
  assert.equal(res.sourceError?.host, "127.0.0.1:7000");
  assert.equal(
    res.sourceError?.detail,
    "Offline download timed out. Please retry in a few moments.",
  );
  assert.equal(res.sourceError?.probing, false);
});
