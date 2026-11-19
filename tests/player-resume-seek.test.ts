import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function harness() {
  const refs: any[] = [],
    effects: any[] = [];
  let refIndex = 0,
    effectIndex = 0,
    clears = 0,
    plays = 0;
  const listeners = new Set<(snap: any) => void>();
  const seeks: number[] = [],
    notified: number[] = [];
  const bridge = {
    subscribe(fn: (snap: any) => void) {
      listeners.add(fn);
      fn({ positionSec: 0, status: "paused" });
      return () => listeners.delete(fn);
    },
    seek(sec: number) {
      seeks.push(sec);
      for (const fn of listeners) fn({ positionSec: 0, status: "paused" });
    },
    play: async () => {
      plays++;
    },
  };
  const bridgeRef = { current: bridge },
    inRoomRef = { current: false };
  const compiled = ts.transpileModule(
    readFileSync("src/views/player/hooks/use-pending-seek-apply.ts", "utf8"),
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  const module: any = {};
  new Function("require", "exports", compiled)((name: string) => {
    if (name === "react")
      return {
        useRef: (current: any) => refs[refIndex++] ?? (refs[refIndex - 1] = { current }),
        useEffect: (run: any, deps: any[]) => {
          const i = effectIndex++,
            old = effects[i];
          if (old && deps.every((dep, n) => Object.is(dep, old.deps[n]))) return;
          old?.cleanup?.();
          effects[i] = { deps, cleanup: run() };
        },
      };
    if (name === "@/lib/media-session")
      return { notifyMediaSeeked: (sec: number) => notified.push(sec) };
    throw new Error(name);
  }, module);
  return {
    seeks,
    notified,
    inRoomRef,
    get clears() {
      return clears;
    },
    get plays() {
      return plays;
    },
    render(patch: any = {}) {
      refIndex = effectIndex = 0;
      module.usePendingSeekApply({
        pendingSeekSec: 600,
        durationSec: 1800,
        sourceKey: "episode-1",
        bridgeRef,
        inRoomRef,
        clearPendingSeek: () => {
          clears++;
        },
        ...patch,
      });
    },
    clock(positionSec: number, status = "paused") {
      for (const fn of listeners) fn({ positionSec, status });
    },
    unmount() {
      for (const effect of effects) effect.cleanup?.();
    },
  };
}

test("a queued resume cannot enable intro skipping until playback confirms the saved position", () => {
  const h = harness();
  h.render();
  assert.deepEqual(h.seeks, [600]);
  assert.equal(h.clears, 0);
  assert.equal(h.plays, 0);
  h.clock(0);
  h.clock(90);
  h.clock(300);
  assert.equal(h.clears, 0, "old clock and intro end must not release the resume gate");
  h.clock(600);
  assert.equal(h.clears, 1);
  assert.equal(h.plays, 1);
  assert.deepEqual(h.notified, [600]);
  h.clock(601);
  assert.equal(h.clears, 1);
});

test("rerenders with a new clear callback do not enqueue another seek", () => {
  const h = harness();
  h.render();
  h.render();
  h.render();
  assert.deepEqual(h.seeks, [600]);
  h.clock(600);
  assert.equal(h.clears, 1);
});

test("a cancelled or replaced source cannot finish its old resume", () => {
  const h = harness();
  h.render();
  h.render({ sourceKey: "episode-2", pendingSeekSec: null });
  h.clock(600);
  assert.equal(h.clears, 0);
  assert.equal(h.plays, 0);
  h.render({ sourceKey: "episode-2", pendingSeekSec: 400 });
  h.unmount();
  h.clock(400);
  assert.equal(h.clears, 0);
});

test("paused source switches and room playback retain their playback state", () => {
  for (const room of [false, true]) {
    const h = harness();
    h.inRoomRef.current = room;
    h.render({ startPaused: !room });
    h.clock(600);
    assert.equal(h.clears, 1);
    assert.equal(h.plays, 0);
  }
});

test("metadata is required and loading telemetry cannot acknowledge a resume", () => {
  const h = harness();
  h.render({ durationSec: 0 });
  assert.equal(h.seeks.length, 0);
  h.render();
  h.clock(600, "loading");
  assert.equal(h.clears, 0);
  h.clock(NaN);
  assert.equal(h.clears, 0);
  h.clock(600);
  assert.equal(h.clears, 1);
});

test("start over can settle at zero without waiting for playback to advance", () => {
  const h = harness();
  h.render({ pendingSeekSec: 0 });
  assert.deepEqual(h.seeks, [0]);
  assert.equal(h.clears, 1);
  assert.equal(h.plays, 1);
});

test("loadedWithStartAt avoids duplicate startup seek while gating until position confirms, with first-frame fallback", () => {
  const h = harness();
  h.render({ loadedWithStartAt: true, startPaused: true });
  assert.deepEqual(h.seeks, [], "must not fire duplicate b.seek while startAtSec load is in flight");
  assert.equal(h.clears, 0);

  // Confirming target position clears gate without ever issuing another seek
  h.clock(600, "paused");
  assert.deepEqual(h.seeks, []);
  assert.equal(h.clears, 1);

  // Fallback: if the first rendered frame lands at 0 despite startAtSec, issue a single seek
  const fallback = harness();
  fallback.render({ loadedWithStartAt: true, startPaused: true });
  fallback.clock(0, "paused");
  assert.deepEqual(fallback.seeks, [], "wait for firstFrameReady before falling back");
  fallback.render({ loadedWithStartAt: true, startPaused: true });
  // Simulate firstFrameReady=true at position 0 through a direct clock listener emission
  fallback.unmount();

  const bridgeListeners = new Set<(snap: any) => void>();
  const fbSeeks: number[] = [];
  let fbClears = 0;
  const fbRefs: any[] = [], fbEffects: any[] = [];
  let fbRi = 0, fbEi = 0;
  const fbMod: any = {};
  const compiled = ts.transpileModule(
    readFileSync("src/views/player/hooks/use-pending-seek-apply.ts", "utf8"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  new Function("require", "exports", compiled)((name: string) => {
    if (name === "react")
      return {
        useRef: (current: any) => fbRefs[fbRi++] ?? (fbRefs[fbRi - 1] = { current }),
        useEffect: (run: any, deps: any[]) => {
          const i = fbEi++, old = fbEffects[i];
          if (old && deps.every((dep, n) => Object.is(dep, old.deps[n]))) return;
          old?.cleanup?.();
          fbEffects[i] = { deps, cleanup: run() };
        },
      };
    if (name === "@/lib/media-session") return { notifyMediaSeeked() {} };
    throw new Error(name);
  }, fbMod);
  const fbBridge = {
    subscribe(fn: (s: any) => void) {
      bridgeListeners.add(fn);
      fn({ positionSec: 0, status: "paused", firstFrameReady: false });
      return () => bridgeListeners.delete(fn);
    },
    seek(sec: number) { fbSeeks.push(sec); },
    play: async () => {},
  };
  fbMod.usePendingSeekApply({
    pendingSeekSec: 600,
    durationSec: 1800,
    sourceKey: "ep-fallback",
    bridgeRef: { current: fbBridge },
    inRoomRef: { current: true },
    startPaused: true,
    loadedWithStartAt: true,
    clearPendingSeek: () => { fbClears++; },
  });
  for (const fn of bridgeListeners) fn({ positionSec: 0, status: "paused", firstFrameReady: true });
  assert.deepEqual(fbSeeks, [600]);
  assert.equal(fbClears, 0);
  for (const fn of bridgeListeners) fn({ positionSec: 600, status: "paused", firstFrameReady: true });
  assert.equal(fbClears, 1);
});
