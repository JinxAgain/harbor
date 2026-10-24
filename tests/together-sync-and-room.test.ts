import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Transpile player-utils.ts to read real constants
const utilsSource = readFileSync(new URL("../src/views/player/player-utils.ts", import.meta.url), "utf8");
const utilsCode = ts.transpileModule(utilsSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const utilsExports: any = {};
new Function("require", "exports", utilsCode)(
  () => ({ isLinuxDesktop: () => false, isMacDesktop: () => false, isWindowsDesktop: () => true }),
  utilsExports,
);
const { SYNC_DRIFT_TOLERANCE_S, SYNC_PLAY_LOOKAHEAD_S, SYNC_SEEK_COOLDOWN_MS } = utilsExports;

// Transpile invite.ts
const inviteSource = readFileSync(new URL("../src/lib/together/invite.ts", import.meta.url), "utf8")
  .replace(/import\.meta\.env\?\.DEV/g, "false")
  .replace(/import\.meta/g, "({ env: { DEV: false } })");
const inviteCode = ts.transpileModule(inviteSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const inviteExports: any = {};
new Function("require", "exports", "window", inviteCode)(
  (name: string) => {
    if (name === "./protocol") {
      return { normalizeRoomCode: (c: string) => c.trim().toUpperCase() };
    }
    return { HARBOR_RELAY_BASE: "https://pub.harbor.site" };
  },
  inviteExports,
  undefined,
);
const { isValidRelayUrl } = inviteExports;

// Transpile use-room-sync.ts to get syncExpectedPosition and syncTarget
const syncSource = readFileSync(new URL("../src/views/player/hooks/use-room-sync.ts", import.meta.url), "utf8");
const syncCode = ts.transpileModule(syncSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const syncExports: any = {};
new Function("require", "exports", syncCode)(
  (name: string) => {
    if (name.includes("player-utils")) {
      return utilsExports;
    }
    return {
      getPlaybackPosition: () => 0,
      getPlaybackBuffered: () => 0,
      useRef: () => ({ current: null }),
      useEffect: () => {},
    };
  },
  syncExports,
);
const { syncExpectedPosition, syncTarget } = syncExports;

test("isValidRelayUrl validates secure wss endpoints and rejects unauthorized schemes", () => {
  assert.equal(isValidRelayUrl("wss://pub.harbor.site"), true);
  assert.equal(isValidRelayUrl("wss://together.mydomain.org/r/room"), true);
  assert.equal(isValidRelayUrl("http://evil.com"), false);
  assert.equal(isValidRelayUrl("ftp://evil.com"), false);
  assert.equal(isValidRelayUrl("javascript:alert(1)"), false);
  assert.equal(isValidRelayUrl("not-a-url"), false);
});

test("syncExpectedPosition computes pure projected position without lookahead offset", () => {
  const now = Date.now();
  const state = {
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: now - 1000, // 1 second ago
    updatedBy: "host",
    speed: 1,
  };
  const duration = 2000;
  const expected = syncExpectedPosition(state, duration);
  const target = syncTarget(state, duration);

  // Expected position should be roughly 100 + 1.0s = 101.0s (age = 1s, speed = 1)
  assert.ok(Math.abs(expected - 101.0) < 0.1);

  // Target adds SYNC_PLAY_LOOKAHEAD_S (0.4s) for seek lead time
  assert.ok(Math.abs(target - (expected + SYNC_PLAY_LOOKAHEAD_S)) < 0.05);

  // Drift tolerance is 1.5s (accommodates 200ms RTT + mpv 200ms time-pos update cadence)
  assert.equal(SYNC_DRIFT_TOLERANCE_S, 1.5);
  assert.equal(SYNC_SEEK_COOLDOWN_MS, 3500);

  // A live position within 0.8s lag does not exceed SYNC_DRIFT_TOLERANCE_S
  const livePos = 100.3; // 0.7s behind host
  const drift = Math.abs(livePos - expected);
  assert.ok(drift < SYNC_DRIFT_TOLERANCE_S);
});

test("paused playback does not project age into expected position or target", () => {
  const now = Date.now();
  const state = {
    mediaId: "tt123",
    positionSeconds: 50,
    playing: false,
    updatedAt: now - 5000, // 5 seconds ago
    updatedBy: "host",
  };
  const duration = 2000;
  const expected = syncExpectedPosition(state, duration);
  const target = syncTarget(state, duration);

  assert.equal(expected, 50);
  assert.equal(target, 50);
});

test("Syncplay-style smooth rate catch-up adjusts rate and avoids seeking for small drift", () => {
  let livePos = 101.8; // 1.8s ahead of host (100.0)
  let liveBuffered = 10;
  let incomingCb: ((s: any) => void) | null = null;
  const seekCalls: number[] = [];
  const rateCalls: number[] = [];
  let rateRefInstance: { current: any } | null = null;
  const mockBridge = {
    seek: (p: number) => seekCalls.push(p),
    setRate: (r: number) => {
      rateCalls.push(r);
      if (rateRefInstance) rateRefInstance.current = r;
    },
    play: async () => {},
    pause: () => {},
  };

  const localExports: any = {};
  new Function("require", "exports", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => liveBuffered,
        };
      }
      return {
        useRef: (init: any) => {
          const ref = { current: init };
          if (init === 1.0 && !rateRefInstance) {
            rateRefInstance = ref;
          }
          return ref;
        },
        useEffect: (fn: any) => fn(),
      };
    },
    localExports,
  );

  const { useRoomSync: hook } = localExports;
  hook({
    inRoom: true,
    isHost: false,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: true },
    roomSnapshot: { participants: [], started: true },
    clientId: "guest",
    src: { meta: { id: "tt123" } },
    snap: { status: "playing", durationSec: 1000, rate: 1.0, buffering: false, firstFrameReady: true },
    bridgeRef: { current: mockBridge },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: (cb: any) => {
      incomingCb = cb;
      return () => {};
    },
    onIncomingCommand: () => () => {},
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
    syncSettings: {
      togetherSlowOnDesync: true,
      togetherRewindThresholdSec: 4.0,
      togetherSyncOnPause: false,
    },
  });

  assert.ok(incomingCb, "incomingState callback registered");

  // State 1: host is at 100s, guest is ahead at 101.8s (drift = +1.8s, > 1.5s, < 4.0s)
  const now = Date.now();
  incomingCb({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: now,
    updatedBy: "host",
    speed: 1,
  });

  // Should adjust rate to 0.95x and NOT seek
  assert.equal(seekCalls.length, 0);
  assert.equal(rateCalls.length, 1);
  assert.equal(Math.round(rateCalls[0] * 100) / 100, 0.95);

  // State 1b (Zero-crossing): guest was slowing down (0.95x) and signedDrift crosses zero to -0.25s
  livePos = 99.75;
  incomingCb({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: now + 30,
    updatedBy: "host",
    speed: 1,
  });

  // Should restore normal playback rate 1.0x upon crossing zero
  assert.equal(seekCalls.length, 0);
  assert.equal(rateCalls.length, 2);
  assert.equal(rateCalls[1], 1.0);

  // State 1c (Host speed change during normal drift <= 1.5s): guest is at 100.5s (absDrift = 0.5s), host changes speed to 1.5
  livePos = 100.5;
  incomingCb({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: now + 60,
    updatedBy: "host",
    speed: 1.5,
  });

  // Should update playback rate to 1.5x
  assert.equal(seekCalls.length, 0);
  assert.equal(rateCalls.length, 3);
  assert.equal(rateCalls[2], 1.5);

  // Reset host speed to 1.0 for subsequent tests
  if (rateRefInstance) rateRefInstance.current = 1.0;

  // State 2: guest is behind at 98.2s (drift = -1.8s, > 1.5s, < 4.0s)
  livePos = 98.2;
  rateCalls.length = 0;
  incomingCb({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: now + 90,
    updatedBy: "host",
    speed: 1,
  });

  // Lagging guest does not speed up above normal rate; lag is absorbed by host slowdown/rewind
  assert.equal(seekCalls.length, 0);
  assert.equal(rateCalls.length, 0);

  // State 3: drift converges to <= 0.15s (livePos = 100.05, drift = 0.05)
  livePos = 100.05;
  rateCalls.length = 0;
  incomingCb({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: now + 120,
    updatedBy: "host",
    speed: 1,
  });

  // Remains at normal rate 1.0x and does NOT seek
  assert.equal(seekCalls.length, 0);
  assert.equal(rateCalls.length, 0);

  // State 4: drift exceeds togetherRewindThresholdSec (4.0s) -> guest at 104.5s
  livePos = 104.5;
  incomingCb({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: now + 150,
    updatedBy: "host",
    speed: 1,
  });

  // Hard seek MUST be triggered
  assert.ok(seekCalls.length > 0);
});

test("Pause and unpause with small drift does not force seek when togetherSyncOnPause is false", () => {
  let livePos = 101.0; // 1.0s ahead of host (drift = 1.0s < 4.0s)
  let liveBuffered = 10;
  let incomingCb: ((s: any) => void) | null = null;
  const seekCalls: number[] = [];
  const pauseCalls: number[] = [];
  const mockBridge = {
    seek: (p: number) => seekCalls.push(p),
    setRate: () => {},
    play: async () => {},
    pause: () => { pauseCalls.push(Date.now()); },
  };

  const localExports: any = {};
  new Function("require", "exports", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => liveBuffered,
        };
      }
      return {
        useRef: (init: any) => ({ current: init }),
        useEffect: (fn: any) => fn(),
      };
    },
    localExports,
  );

  const { useRoomSync: hook } = localExports;
  hook({
    inRoom: true,
    isHost: false,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: true },
    roomSnapshot: { participants: [], started: true },
    clientId: "guest",
    src: { meta: { id: "tt123" } },
    snap: { status: "playing", durationSec: 1000, rate: 1.0, buffering: false, firstFrameReady: true },
    bridgeRef: { current: mockBridge },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: (cb: any) => {
      incomingCb = cb;
      return () => {};
    },
    onIncomingCommand: () => () => {},
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
    syncSettings: {
      togetherSlowOnDesync: true,
      togetherRewindThresholdSec: 4.0,
      togetherSyncOnPause: false,
    },
  });

  assert.ok(incomingCb);

  // Host pauses, guest is playing, drift is 1.0s (< 4.0s)
  const now = Date.now();
  incomingCb({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: false,
    updatedAt: now,
    updatedBy: "host",
    speed: 1,
  });

  // bridge.pause() should be called, but bridge.seek() should NOT be called
  assert.equal(pauseCalls.length, 1);
  assert.equal(seekCalls.length, 0);
});

test("Syncplay-style Host Slowdown & Rewind for Lagging Guest", () => {
  let livePos = 100.0;
  let intervalCb: (() => void) | null = null;
  let incomingCmdCb: ((from: string, cmd: any) => void) | null = null;
  const seekCalls: number[] = [];
  const rateCalls: number[] = [];
  let rateRefInstance: { current: any } | null = null;
  const snapObj = { status: "playing", durationSec: 1000, rate: 1.0, buffering: false };
  const mockBridge = {
    seek: (p: number) => seekCalls.push(p),
    setRate: (r: number) => {
      rateCalls.push(r);
      snapObj.rate = r;
      if (rateRefInstance) {
        rateRefInstance.current = r;
      }
    },
    play: async () => {},
    pause: () => {},
  };

  const localExports: any = {};
  new Function("require", "exports", "window", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => 10,
        };
      }
      return {
        useRef: (init: any) => {
          const ref = { current: init };
          if (init === 1.0 && !rateRefInstance) rateRefInstance = ref;
          return ref;
        },
        useEffect: (fn: any) => fn(),
      };
    },
    localExports,
    {
      setInterval: (cb: any) => { intervalCb = cb; return 1; },
      clearInterval: () => {},
      setTimeout: (cb: any) => cb(),
      clearTimeout: () => {},
    },
  );

  const { useRoomSync: hook } = localExports;
  hook({
    inRoom: true,
    isHost: true,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: true },
    roomSnapshot: {
      participants: [{ id: "host", name: "Host" }, { id: "guest1", name: "Guest" }],
      started: true,
    },
    clientId: "host",
    src: { meta: { id: "tt123" } },
    snap: snapObj,
    bridgeRef: { current: mockBridge },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: () => () => {},
    onIncomingCommand: (cb: any) => {
      incomingCmdCb = cb;
      return () => {};
    },
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
    syncSettings: {
      togetherSlowOnDesync: true,
      togetherRewindThresholdSec: 4.0,
      togetherSyncOnPause: false,
    },
  });

  assert.ok(incomingCmdCb, "incomingCommand callback registered");
  assert.ok(intervalCb, "tick interval callback registered");

  // Initial tick: both in sync
  intervalCb();
  assert.equal(rateCalls.length, 0);
  assert.equal(seekCalls.length, 0);

  // Guest reports 2.2s behind host (host at 100s, guest at 97.8s)
  const now = Date.now();
  incomingCmdCb("guest1", {
    action: "report",
    positionSeconds: 97.8,
    playing: true,
    buffering: false,
    mediaId: "tt123",
    updatedAt: now,
  });

  // Host tick: host should slow down to 0.95x
  intervalCb();
  assert.equal(rateCalls.length, 1);
  assert.equal(Math.round(rateCalls[0] * 100) / 100, 0.95);
  assert.equal(seekCalls.length, 0);

  // Run subsequent ticks while still slowed down: rate should stay at 0.95 and NOT decay
  incomingCmdCb("guest1", {
    action: "report",
    positionSeconds: 97.8,
    playing: true,
    buffering: false,
    mediaId: "tt123",
    updatedAt: Date.now(),
  });
  intervalCb();
  assert.equal(rateCalls.length, 1, "Rate must not re-trigger or decay on subsequent slowed ticks");
  assert.equal(rateRefInstance?.current, 0.95);

  incomingCmdCb("guest1", {
    action: "report",
    positionSeconds: 97.8,
    playing: true,
    buffering: false,
    mediaId: "tt123",
    updatedAt: Date.now(),
  });
  intervalCb();
  assert.equal(rateCalls.length, 1, "Rate must remain at 0.95 across multiple host ticks");
  assert.equal(rateRefInstance?.current, 0.95);

  // Guest converges to within 0.1s (drift = 0.1s <= 0.15s)
  incomingCmdCb("guest1", {
    action: "report",
    positionSeconds: 99.9,
    playing: true,
    buffering: false,
    mediaId: "tt123",
    updatedAt: Date.now(),
  });
  intervalCb();
  assert.equal(rateCalls.length, 2);
  assert.equal(rateCalls[1], 1.0, "Rate must restore to base rate 1.0 upon convergence");
  assert.equal(rateRefInstance?.current, 1.0);
  assert.equal(seekCalls.length, 0);

  // Guest stalls 4.5s behind (host at 100s, guest at 95.5s)
  rateCalls.length = 0;
  seekCalls.length = 0;
  incomingCmdCb("guest1", {
    action: "report",
    positionSeconds: 95.5,
    playing: false,
    buffering: true,
    mediaId: "tt123",
    updatedAt: Date.now(),
  });
  // First tick: detects behind, arms timer
  intervalCb();
  assert.equal(seekCalls.length, 0);

  // Tick after >= 2000ms: host has advanced 2.5s normally (livePos = 102.5) while guest remains stalled at 95.5
  const origNow = Date.now;
  try {
    Date.now = () => origNow() + 2500;
    livePos = 102.5;
    intervalCb();
    assert.equal(seekCalls.length, 1);
    assert.equal(seekCalls[0], 95.5);
  } finally {
    Date.now = origNow;
  }
});

test("Regression Test 2: Explicit Host Seek (doSeek: true) ignores lag and guest seeks immediately", () => {
  let livePos = 100.0;
  let intervalCb: (() => void) | null = null;
  let incomingCmdCb: ((from: string, cmd: any) => void) | null = null;
  let incomingStateCb: ((s: any) => void) | null = null;
  const hostSeekCalls: number[] = [];
  const hostRateCalls: number[] = [];
  const guestSeekCalls: number[] = [];
  const mockHostBridge = {
    seek: (p: number) => hostSeekCalls.push(p),
    setRate: (r: number) => hostRateCalls.push(r),
    play: async () => {},
    pause: () => {},
  };
  const mockGuestBridge = {
    seek: (p: number) => guestSeekCalls.push(p),
    setRate: () => {},
    play: async () => {},
    pause: () => {},
  };

  const localExports: any = {};
  new Function("require", "exports", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => 10,
        };
      }
      return {
        useRef: (init: any) => ({ current: init }),
        useEffect: (fn: any) => fn(),
      };
    },
    localExports,
  );
  const { useRoomSync: hook } = localExports;

  globalThis.window = {
    setInterval: (cb: any) => { intervalCb = cb; return 123; },
    clearInterval: () => {},
    setTimeout: () => 123,
    clearTimeout: () => {},
  } as any;

  hook({
    inRoom: true,
    isHost: true,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: true },
    roomSnapshot: {
      participants: [{ id: "host" }, { id: "guest1" }],
      started: true,
      hostClientId: "host",
    },
    clientId: "host",
    src: { meta: { id: "tt123" } },
    snap: { status: "playing", durationSec: 1000, rate: 1.0, buffering: false, firstFrameReady: true },
    bridgeRef: { current: mockHostBridge },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: () => () => {},
    onIncomingCommand: (cb: any) => { incomingCmdCb = cb; return () => {}; },
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
    syncSettings: { togetherSlowOnDesync: true, togetherRewindThresholdSec: 4.0 },
  });

  // Seed lastHostPosRef and lastHostTickAtRef at 100.0s
  intervalCb!();

  // Guest reports old position 95s
  incomingCmdCb!("guest1", {
    action: "report",
    positionSeconds: 95.0,
    playing: true,
    buffering: false,
    mediaId: "tt123",
    updatedAt: Date.now(),
  });
  // Host jumps to 115.0s: hostDrift = 115 - 95 = 20s (< 30s and >= 4.0s).
  // Because |115 - expectedHostPos| > 1.5, isHostJump is triggered and arms hostSeekGraceUntilRef
  livePos = 115.0;
  intervalCb!();
  assert.equal(hostRateCalls.length, 0, "Host should NOT slow down after an explicit jump");
  assert.equal(hostSeekCalls.length, 0, "Host should NOT rewind after an explicit jump");

  // Guest side: Guest at position 100 receives host state with doSeek: true at positionSeconds: 115
  livePos = 100.0;
  hook({
    inRoom: true,
    isHost: false,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: true },
    roomSnapshot: { participants: [{ id: "host" }, { id: "guest1" }], started: true },
    clientId: "guest1",
    src: { meta: { id: "tt123" } },
    snap: { status: "playing", durationSec: 1000, rate: 1.0, buffering: false, firstFrameReady: true },
    bridgeRef: { current: mockGuestBridge },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: (cb: any) => { incomingStateCb = cb; return () => {}; },
    onIncomingCommand: () => () => {},
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
    syncSettings: { togetherSlowOnDesync: true, togetherRewindThresholdSec: 4.0 },
  });

  incomingStateCb!({
    mediaId: "tt123",
    positionSeconds: 115,
    playing: true,
    updatedAt: Date.now(),
    updatedBy: "host",
    speed: 1,
    doSeek: true,
  });
  assert.equal(guestSeekCalls.length, 1, "Guest must immediately seek on doSeek: true");
  assert.equal(Math.round(guestSeekCalls[0]), 115);
});

test("Regression Test 3: No 4-second PPT seek loop under slow seek / unbuffered catch-up", () => {
  let livePos = 95.8; // lagging 4.2s behind host (100.0)
  let liveBuffered = 0.5; // slow seek / unbuffered (< 2.0s)
  let incomingStateCb: ((s: any) => void) | null = null;
  const seekCalls: number[] = [];
  const mockBridge = {
    seek: (p: number) => {
      seekCalls.push(p);
      livePos = p;
    },
    setRate: () => {},
    play: async () => {},
    pause: () => {},
  };

  const localExports: any = {};
  new Function("require", "exports", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => liveBuffered,
        };
      }
      return {
        useRef: (init: any) => ({ current: init }),
        useEffect: (fn: any) => fn(),
      };
    },
    localExports,
  );
  const { useRoomSync: hook } = localExports;

  hook({
    inRoom: true,
    isHost: false,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: true },
    roomSnapshot: { participants: [], started: true },
    clientId: "guest",
    src: { meta: { id: "tt123" } },
    snap: { status: "playing", durationSec: 1000, rate: 1.0, buffering: false, firstFrameReady: true },
    bridgeRef: { current: mockBridge },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: (cb: any) => { incomingStateCb = cb; return () => {}; },
    onIncomingCommand: () => () => {},
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
    syncSettings: { togetherSlowOnDesync: true, togetherRewindThresholdSec: 4.0 },
  });

  const now = Date.now();
  // t = 0: Initial hard seek triggered by host doSeek (host at 100s, guest at 50s)
  incomingStateCb!({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: now,
    updatedBy: "host",
    speed: 1,
    doSeek: true,
  });
  assert.equal(seekCalls.length, 1, "Initial seek triggered");

  // While buffer has not settled (liveBuffered = 0.5s < 2.0s), simulate heartbeats at t = 1s, 2s, 3s, 4s, 5s
  for (let sec = 1; sec <= 5; sec++) {
    incomingStateCb!({
      mediaId: "tt123",
      positionSeconds: 100 + sec,
      playing: true,
      updatedAt: now + sec * 1000,
      updatedBy: "host",
      speed: 1,
    });
  }
  assert.equal(seekCalls.length, 1, "b.seek should NOT be called again while buffer is settling (no PPT loop)");
});

test("Regression Test 4: No seek while guest is loading / durationSec === 0", () => {
  let livePos = 0.0;
  let incomingStateCb: ((s: any) => void) | null = null;
  const seekCalls: number[] = [];
  const mockBridge = {
    seek: (p: number) => seekCalls.push(p),
    setRate: () => {},
    play: async () => {},
    pause: () => {},
  };

  const localExports: any = {};
  new Function("require", "exports", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => 0,
        };
      }
      return {
        useRef: (init: any) => ({ current: init }),
        useEffect: (fn: any) => fn(),
      };
    },
    localExports,
  );
  const { useRoomSync: hook } = localExports;

  // Guest in loading state with durationSec = 0
  hook({
    inRoom: true,
    isHost: false,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: false },
    roomSnapshot: { participants: [], started: true },
    clientId: "guest",
    src: { meta: { id: "tt123" } },
    snap: { status: "loading", durationSec: 0, rate: 1.0, buffering: true, firstFrameReady: false },
    bridgeRef: { current: mockBridge },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: (cb: any) => { incomingStateCb = cb; return () => {}; },
    onIncomingCommand: () => () => {},
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
    syncSettings: { togetherSlowOnDesync: true, togetherRewindThresholdSec: 4.0 },
  });

  // Emits host heartbeat at 1200s
  incomingStateCb!({
    mediaId: "tt123",
    positionSeconds: 1200,
    playing: true,
    updatedAt: Date.now(),
    updatedBy: "host",
    speed: 1,
  });

  assert.equal(seekCalls.length, 0, "No seek allowed while snap.status === 'loading' or durationSec === 0");
});

test("Regression Test 5: Track switch grace window suppresses hard seeks during rebuffering", () => {
  let livePos = 95.8; // 4.2s behind host (100.0)
  let liveBuffered = 0;
  let incomingStateCb: ((s: any) => void) | null = null;
  const seekCalls: number[] = [];
  const commandCalls: any[] = [];
  const mockBridge = {
    seek: (p: number) => seekCalls.push(p),
    setRate: () => {},
    play: async () => {},
    pause: () => {},
  };

  let refIndex = 0;
  const refs: any[] = [];
  let effectIndex = 0;
  const effects: any[] = [];
  const localExports: any = {};
  new Function("require", "exports", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => liveBuffered,
        };
      }
      return {
        useRef: (init: any) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: init }),
        useEffect: (fn: any, deps?: any[]) => {
          const index = effectIndex++;
          const old = effects[index];
          if (
            old &&
            deps &&
            old.deps &&
            deps.length === old.deps.length &&
            deps.every((v, i) => Object.is(v, old.deps[i]))
          ) {
            return;
          }
          old?.cleanup?.();
          effects[index] = { deps, cleanup: fn() };
        },
      };
    },
    localExports,
  );
  const { useRoomSync: hook } = localExports;

  const render = (snapParam: any) => {
    refIndex = 0;
    effectIndex = 0;
    hook({
      inRoom: true,
      isHost: false,
      hasStarted: true,
      setHasStarted: () => {},
      selfFrameReadyRef: { current: true },
      roomSnapshot: { participants: [], started: true },
      clientId: "guest",
      src: { meta: { id: "tt123" } },
      snap: snapParam,
      bridgeRef: { current: mockBridge },
      hostSourceRef: { current: null },
      guestPickRef: { current: false },
      publishState: () => {},
      sendCommand: (cmd: any) => commandCalls.push(cmd),
      onIncomingState: (cb: any) => { incomingStateCb = cb; return () => {}; },
      onIncomingCommand: () => () => {},
      markReady: () => {},
      suppressOutgoingFor: () => {},
      setForeignNotice: () => {},
      syncSettings: { togetherSlowOnDesync: true, togetherRewindThresholdSec: 4.0 },
    });
  };

  // Initial render: audio-1 selected
  render({
    status: "playing",
    durationSec: 1000,
    rate: 1.0,
    buffering: false,
    firstFrameReady: true,
    audioTracks: [{ id: "audio-1", selected: true }],
    subtitleTracks: [],
  });

  // Track switch: audio-2 selected
  render({
    status: "playing",
    durationSec: 1000,
    rate: 1.0,
    buffering: false,
    firstFrameReady: true,
    audioTracks: [{ id: "audio-2", selected: true }],
    subtitleTracks: [],
  });

  // Incoming host state with drift 4.2s (host at 100s, guest at 95.8s) during grace window
  incomingStateCb!({
    mediaId: "tt123",
    positionSeconds: 100,
    playing: true,
    updatedAt: Date.now(),
    updatedBy: "host",
    speed: 1,
  });

  assert.equal(seekCalls.length, 0, "Hard seek must be suppressed during track switch grace window");
  assert.ok(commandCalls.some((c) => c.action === "report" && c.buffering === true), "Reported buffering to host");
});

// Transpile relay-version.ts
const relayVerSource = readFileSync(new URL("../src/lib/together/relay-version.ts", import.meta.url), "utf8");
const relayVerCode = ts.transpileModule(relayVerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const relayVerExports: any = {};
new Function("require", "exports", relayVerCode)(() => ({}), relayVerExports);
const { REQUIRED_RELAY_VERSION, relayOutdated } = relayVerExports;

// Load worker.js Room and sanitize functions
const workerSource = readFileSync(new URL("../src-tauri/relay/worker.js", import.meta.url), "utf8")
  .replace("export class Room", "class Room")
  .replace("export default", "const defaultExport =") +
  "\nmodule.exports = { Room, WORKER_VERSION, sanitizeLocation };";
const workerExports: any = {};
const workerModule = { exports: workerExports };
new Function("module", "exports", "fetch", "Response", "WebSocketPair", workerSource)(
  workerModule,
  workerExports,
  () => {},
  class {},
  class { 0 = {}; 1 = {}; },
);
const { Room, WORKER_VERSION, sanitizeLocation } = workerModule.exports;

test("REQUIRED_RELAY_VERSION is 14 and matches WORKER_VERSION", () => {
  assert.equal(REQUIRED_RELAY_VERSION, 14);
  assert.equal(WORKER_VERSION, 14);
  assert.equal(relayOutdated(13), true);
  assert.equal(relayOutdated(14), false);
});

test("worker Room handleClaimHost guards against hijacking by peer2 even with fresh: true", () => {
  const storageMap = new Map();
  const mockStorage = {
    get: async () => new Map(),
    put: (k: string, v: any) => storageMap.set(k, v),
    delete: (k: string) => storageMap.delete(k),
  };
  const mockState = {
    storage: mockStorage,
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn: any) => fn(),
    acceptWebSocket: () => {},
  };

  const room = new Room(mockState);
  const sentMsgs1: any[] = [];
  const sentMsgs2: any[] = [];
  const s1: any = {
    send: (raw: string) => sentMsgs1.push(JSON.parse(raw)),
    close: () => {},
    serializeAttachment: () => {},
  };
  const s2: any = {
    send: (raw: string) => sentMsgs2.push(JSON.parse(raw)),
    close: () => {},
    serializeAttachment: () => {},
  };

  // Peer 1 joins and is host
  room.handleHello(s1, { clientId: "peer1", name: "HostUser" });
  assert.equal(room.hostClientId, "peer1");

  // Peer 2 joins
  room.handleHello(s2, { clientId: "peer2", name: "GuestUser" });
  assert.equal(room.hostClientId, "peer1");

  // Peer 2 sends claim-host with fresh: true (e.g. clicking Play in picker/detail)
  room.handleClaimHost(s2, { t: "claim-host", fresh: true });

  // Host MUST NOT be hijacked by peer2!
  assert.equal(room.hostClientId, "peer1");

  // Peer 2 should have received rejection message with the true hostClientId
  const lastMsg2 = sentMsgs2[sentMsgs2.length - 1];
  assert.deepEqual(lastMsg2, { t: "host", hostClientId: "peer1" });
});

test("worker Room handleState compensates one-way sender latency from peer RTT", () => {
  const storageMap = new Map();
  const mockStorage = {
    get: async () => new Map(),
    put: (k: string, v: any) => storageMap.set(k, v),
    delete: (k: string) => storageMap.delete(k),
  };
  const mockState = {
    storage: mockStorage,
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn: any) => fn(),
    acceptWebSocket: () => {},
  };

  const room = new Room(mockState);
  const s1: any = {
    send: () => {},
    close: () => {},
    serializeAttachment: () => {},
  };
  room.handleHello(s1, { clientId: "peer1", name: "HostUser" });

  // Peer 1 sends state with rtt = 300ms
  const now = Date.now();
  room.handleState(s1, {
    t: "state",
    state: {
      mediaId: "tt123",
      positionSeconds: 100,
      playing: true,
      updatedAt: now,
      updatedBy: "peer1",
    },
    rtt: 300,
  });

  // srvAt should be compensated by ~150ms (rtt / 2)
  assert.ok(room.syncState);
  const diff = Date.now() - room.syncState.srvAt;
  assert.ok(diff >= 140 && diff <= 300, `srvAt should be ~150ms in the past, got diff ${diff}`);
});

test("sanitizeLocation preserves service, addonId, personId, meta logo/releaseInfo, and episode name", () => {
  // Service location
  const svc = sanitizeLocation({ kind: "service", service: "stremio" });
  assert.deepEqual(svc, { kind: "service", service: "stremio" });

  // Addon location
  const addon = sanitizeLocation({ kind: "addon-detail", addonId: "community.torrentio" });
  assert.deepEqual(addon, { kind: "addon-detail", addonId: "community.torrentio" });

  // Person location
  const person = sanitizeLocation({ kind: "person", personId: 98765 });
  assert.deepEqual(person, { kind: "person", personId: 98765 });

  // Full detail location with logo, releaseInfo, and episode name
  const detail = sanitizeLocation({
    kind: "series-detail",
    id: "tt123456",
    name: "Show Title",
    meta: {
      id: "tt123456",
      type: "series",
      name: "Show Title",
      poster: "https://poster.jpg",
      background: "https://bg.jpg",
      logo: "https://logo.png",
      releaseInfo: "2024-",
    },
    episode: {
      season: 2,
      episode: 5,
      name: "Chapter Five",
    },
  });
  assert.deepEqual(detail, {
    kind: "series-detail",
    id: "tt123456",
    name: "Show Title",
    meta: {
      id: "tt123456",
      type: "series",
      name: "Show Title",
      poster: "https://poster.jpg",
      background: "https://bg.jpg",
      logo: "https://logo.png",
      releaseInfo: "2024-",
    },
    episode: {
      season: 2,
      episode: 5,
      name: "Chapter Five",
    },
  });
});

test("worker Room preserves joinedAt, ready, location across reconnect within grace period and cleans up when empty", () => {
  const storageMap = new Map();
  const mockStorage = {
    get: async (keys: string | string[]) => {
      const res = new Map();
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) if (storageMap.has(k)) res.set(k, storageMap.get(k));
      return Array.isArray(keys) ? res : res.get(keys);
    },
    put: (k: string, v: any) => storageMap.set(k, v),
    delete: (k: string) => storageMap.delete(k),
  };
  const mockState = {
    storage: mockStorage,
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn: any) => fn(),
    acceptWebSocket: () => {},
  };

  const room = new Room(mockState);
  const sentMsgs: any[] = [];
  const s1: any = {
    send: (raw: string) => sentMsgs.push(JSON.parse(raw)),
    close: () => {},
    serializeAttachment: () => {},
  };

  // Peer 1 joins as host
  room.handleHello(s1, { clientId: "peer1", name: "HostUser" });
  assert.equal(room.hostClientId, "peer1");
  const p1 = room.peers.get(s1);
  assert.ok(p1);
  p1.ready = true;
  p1.location = { kind: "service", service: "stremio" };
  const initialJoinedAt = p1.joinedAt;

  // Socket 1 drops -> triggers onClose
  room.onClose(s1);
  assert.equal(room.peers.size, 0);
  assert.ok(room.disconnectTimers.has("peer1"));
  const pending = room.disconnectTimers.get("peer1");
  assert.ok(pending.peer);
  assert.equal(pending.peer.ready, true);
  assert.deepEqual(pending.peer.location, { kind: "service", service: "stremio" });

  // Peer 1 reconnects on new socket s2 before grace expires
  const s2: any = {
    send: (raw: string) => sentMsgs.push(JSON.parse(raw)),
    close: () => {},
    serializeAttachment: () => {},
  };
  room.handleHello(s2, { clientId: "peer1", name: "HostUser" });
  assert.equal(room.disconnectTimers.size, 0);
  assert.equal(room.peers.size, 1);
  const reconnected = room.peers.get(s2);
  assert.equal(reconnected.joinedAt, initialJoinedAt);
  assert.equal(reconnected.ready, true);
  assert.deepEqual(reconnected.location, { kind: "service", service: "stremio" });

  // Peer 1 explicitly leaves -> resetIfEmpty resets room state
  room.started = true;
  room.syncState = { mediaId: "tt123", positionSeconds: 10, playing: true };
  room.handleLeave(s2);
  assert.equal(room.peers.size, 0);
  assert.equal(room.started, false);
  assert.equal(room.syncState, null);
  assert.equal(room.hostClientId, null);
  assert.equal(room.explicitHostClientId, null);
});

test("Draw Mode Callback Stability across stroke updates", () => {
  const drawModeSource = readFileSync(new URL("../src/views/player/hooks/use-draw-mode.ts", import.meta.url), "utf8");
  const drawModeCode = ts.transpileModule(drawModeSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const stateMap = new Map<number, any>();
  let hookIndex = 0;
  const mockReact = {
    useState: (initial: any) => {
      const idx = hookIndex++;
      if (!stateMap.has(idx)) stateMap.set(idx, initial);
      const val = stateMap.get(idx);
      const setVal = (updater: any) => {
        const next = typeof updater === "function" ? updater(stateMap.get(idx)) : updater;
        stateMap.set(idx, next);
      };
      return [val, setVal];
    },
    useCallback: (fn: any, deps: any[]) => {
      const idx = hookIndex++;
      const prev = stateMap.get(idx);
      if (prev && deps.every((d: any, i: number) => d === prev.deps[i])) {
        return prev.fn;
      }
      stateMap.set(idx, { fn, deps });
      return fn;
    },
    useEffect: () => {},
  };

  const drawModeExports: any = {};
  new Function("require", "exports", drawModeCode)(
    (name: string) => {
      if (name === "react") return mockReact;
      if (name.includes("colors")) return { nameColor: () => "#ff0000" };
      return {};
    },
    drawModeExports,
  );

  const { useDrawMode } = drawModeExports;
  const sendDraw = () => {};

  // First render
  hookIndex = 0;
  const render1 = useDrawMode({
    inRoom: true,
    participantCount: 2,
    clientId: "c1",
    topPath: "/player",
    onIncomingDraw: () => () => {},
    sendDraw,
  });

  // Simulate drawing a stroke point which updates strokes state
  render1.onDrawStart({
    id: "s1",
    authorId: "c1",
    authorName: "Alice",
    color: "#ff0000",
    points: [{ x: 0.1, y: 0.2 }],
    bornAt: Date.now(),
  });

  // Second render after strokes state change
  hookIndex = 0;
  const render2 = useDrawMode({
    inRoom: true,
    participantCount: 2,
    clientId: "c1",
    topPath: "/player",
    onIncomingDraw: () => () => {},
    sendDraw,
  });

  // Verify callbacks are referentially identical
  assert.equal(render1.onDrawStart, render2.onDrawStart);
  assert.equal(render1.onDrawPoint, render2.onDrawPoint);
  assert.equal(render1.onDrawEnd, render2.onDrawEnd);
  assert.equal(render1.clearStrokes, render2.clearStrokes);
  assert.equal(render2.strokes.length, 1);
});

test("SeekBar container disables pointer events when drawMode is true", () => {
  const transportSource = readFileSync(new URL("../src/components/player/transport.tsx", import.meta.url), "utf8");
  assert.ok(transportSource.includes('drawMode ? "pointer-events-none" : ""'));

  const stremioSource = readFileSync(new URL("../src/components/player/transport-stremio.tsx", import.meta.url), "utf8");
  assert.ok(stremioSource.includes('drawMode ? "pointer-events-none" : "pointer-events-auto"'));
});

test("Regression Test 6: Guest does not deadlock when firstFrameReady transitions false -> true after pause", () => {
  let livePos = 16.308;
  let incomingStateCb: ((s: any) => void) | null = null;
  const playCalls: number[] = [];
  const seekCalls: number[] = [];
  const mockBridge = {
    seek: (p: number) => seekCalls.push(p),
    setRate: () => {},
    play: async () => { playCalls.push(Date.now()); },
    pause: () => {},
  };

  let refIndex = 0;
  const refs: any[] = [];
  let effectIndex = 0;
  const effects: any[] = [];
  const localExports: any = {};
  new Function("require", "exports", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => 5,
        };
      }
      return {
        useRef: (init: any) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: init }),
        useEffect: (fn: any, deps?: any[]) => {
          const index = effectIndex++;
          const old = effects[index];
          if (
            old &&
            deps &&
            old.deps &&
            deps.length === old.deps.length &&
            deps.every((v, i) => Object.is(v, old.deps[i]))
          ) {
            return;
          }
          old?.cleanup?.();
          effects[index] = { deps, cleanup: fn() };
        },
      };
    },
    localExports,
  );
  const { useRoomSync: hook } = localExports;

  const selfFrameReadyRef = { current: false };
  const render = (snapParam: any) => {
    refIndex = 0;
    effectIndex = 0;
    hook({
      inRoom: true,
      isHost: false,
      hasStarted: true,
      setHasStarted: () => {},
      selfFrameReadyRef,
      roomSnapshot: { participants: [], started: true },
      clientId: "guest",
      src: { url: "http://127.0.0.1:7000/play/test", meta: { id: "tt123" } },
      snap: snapParam,
      bridgeRef: { current: mockBridge },
      hostSourceRef: { current: null },
      guestPickRef: { current: false },
      publishState: () => {},
      onIncomingState: (cb: any) => { incomingStateCb = cb; return () => {}; },
      onIncomingCommand: () => () => {},
      markReady: () => {},
      suppressOutgoingFor: () => {},
      setForeignNotice: () => {},
      syncSettings: { togetherSlowOnDesync: true, togetherRewindThresholdSec: 4.0 },
    });
  };

  // 1. file-loaded arrives: status is "paused", durationSec > 0, but firstFrameReady is still false
  render({
    status: "paused",
    durationSec: 7533,
    rate: 1.0,
    buffering: false,
    firstFrameReady: false,
    videoWidth: 1920,
    videoHeight: 804,
  });

  // 2. playback-restart arrives: status and durationSec unchanged, firstFrameReady becomes true
  render({
    status: "paused",
    durationSec: 7533,
    rate: 1.0,
    buffering: false,
    firstFrameReady: true,
    videoWidth: 1920,
    videoHeight: 804,
  });

  // 3. Host sends playing: true at 16.308s -> Guest MUST call bridge.play() and NOT drop the state!
  incomingStateCb!({
    mediaId: "tt123",
    positionSeconds: 16.308,
    playing: true,
    updatedAt: Date.now(),
    updatedBy: "host",
    speed: 1,
  });
  assert.equal(playCalls.length, 1, "Guest must unpause when host starts playing after firstFrameReady");
});

test("Regression Test 7: Host immediate seek broadcast, pending seek guard, and no rewind to 0s or paused guest", () => {
  let livePos = 23.5;
  let intervalCb: (() => void) | null = null;
  let incomingCmdCb: ((from: string, cmd: any) => void) | null = null;
  const hostSeekCalls: number[] = [];
  const publishedStates: any[] = [];
  const mockHostBridge = {
    seek: (p: number) => hostSeekCalls.push(p),
    setRate: () => {},
    play: async () => {},
    pause: () => {},
  };

  const localExports: any = {};
  new Function("require", "exports", "window", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => 10,
        };
      }
      return {
        useRef: (init: any) => ({ current: init }),
        useEffect: (fn: any) => fn(),
      };
    },
    localExports,
    {
      setInterval: (cb: any) => { intervalCb = cb; return 1; },
      clearInterval: () => {},
      setTimeout: (cb: any) => cb(),
      clearTimeout: () => {},
    },
  );
  const { useRoomSync: hook } = localExports;

  const guestControlRef = { current: true };
  const api = hook({
    inRoom: true,
    isHost: true,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: true },
    roomSnapshot: {
      participants: [{ id: "host" }, { id: "guest1" }],
      started: true,
      hostClientId: "host",
    },
    clientId: "host",
    src: { url: "http://127.0.0.1:7000/play/test", meta: { id: "tt123" } },
    snap: { status: "playing", durationSec: 1000, rate: 1.0, buffering: false, firstFrameReady: true },
    bridgeRef: { current: mockHostBridge },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    guestControlRef,
    publishState: (s: any) => publishedStates.push(s),
    onIncomingState: () => () => {},
    onIncomingCommand: (cb: any) => { incomingCmdCb = cb; return () => {}; },
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
    syncSettings: { togetherSlowOnDesync: true, togetherRewindThresholdSec: 4.0 },
  });

  // 1. Guest reports reloading at 0.0s (buffering: true, positionSeconds: 0)
  incomingCmdCb!("guest1", {
    action: "report",
    positionSeconds: 0,
    playing: false,
    buffering: true,
    mediaId: "tt123",
    updatedAt: Date.now(),
  });
  intervalCb!();
  const origNow = Date.now;
  try {
    Date.now = () => origNow() + 3000;
    intervalCb!();
    assert.equal(hostSeekCalls.length, 0, "Host must NEVER rewind to 0.0s when guest is reloading");
  } finally {
    Date.now = origNow;
  }

  // 2. Host explicitly seeks to 300s while mpv getPlaybackPosition() is still at 23.5s
  publishedStates.length = 0;
  api.notifyHostSeek(300);
  assert.equal(publishedStates.length, 1, "notifyHostSeek immediately publishes state");
  assert.equal(publishedStates[0].positionSeconds, 300);
  assert.equal(publishedStates[0].doSeek, true);

  // Next tick runs 500ms later while mpv time-pos is STILL 23.5s (seek in flight)
  intervalCb!();
  const lastPub = publishedStates[publishedStates.length - 1];
  assert.ok(
    lastPub.positionSeconds >= 300,
    `Host tick during in-flight seek must not snap back to 23.5s (got ${lastPub.positionSeconds})`,
  );

  // 3. When guestControlRef is false, incoming guest play/pause/seek commands are ignored
  guestControlRef.current = false;
  const prevSeekLen = hostSeekCalls.length;
  incomingCmdCb!("guest1", { action: "seek", positionSeconds: 500, seq: 1 });
  assert.equal(hostSeekCalls.length, prevSeekLen, "Guest seek ignored when guestControl is false");
});

test("worker Room enforces guestControl on commands and resets started/ready on host-leaving", () => {
  const storageMap = new Map();
  const mockStorage = {
    get: async () => new Map(),
    put: (k: string, v: any) => storageMap.set(k, v),
    delete: (k: string) => storageMap.delete(k),
  };
  const mockState = {
    storage: mockStorage,
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn: any) => fn(),
    acceptWebSocket: () => {},
  };

  const room = new Room(mockState);
  const hostMsgs: any[] = [];
  const guestMsgs: any[] = [];
  const sHost: any = {
    send: (raw: string) => hostMsgs.push(JSON.parse(raw)),
    close: () => {},
    serializeAttachment: () => {},
  };
  const sGuest: any = {
    send: (raw: string) => guestMsgs.push(JSON.parse(raw)),
    close: () => {},
    serializeAttachment: () => {},
  };

  room.handleHello(sHost, { clientId: "host1", name: "Host" });
  room.handleHello(sGuest, { clientId: "guest1", name: "Guest" });
  room.handleReady(sHost, { ready: true });
  room.handleReady(sGuest, { ready: true });
  room.handleStart(sHost);
  assert.equal(room.started, true);

  // Host publishes state with guestControl: false
  room.handleState(sHost, {
    t: "state",
    state: {
      mediaId: "tt123",
      positionSeconds: 50,
      playing: true,
      guestControl: false,
      updatedAt: Date.now(),
      updatedBy: "host1",
    },
  });

  hostMsgs.length = 0;
  // Guest tries to pause while guestControl is false -> blocked by relay
  room.handleCommand(sGuest, { t: "cmd", command: { action: "pause" } });
  assert.equal(hostMsgs.length, 0, "Relay blocks guest pause when guestControl is false");

  // Guest report is still allowed even when guestControl is false
  room.handleCommand(sGuest, {
    t: "cmd",
    command: { action: "report", positionSeconds: 49, playing: true },
  });
  assert.equal(hostMsgs.length, 1, "Relay still forwards guest report when guestControl is false");

  // Host leaves video -> broadcasts started: false and resets ready: false
  guestMsgs.length = 0;
  room.handleHostLeaving(sHost);
  assert.equal(room.started, false);
  assert.ok(guestMsgs.some((m) => m.t === "started" && m.started === false));
  assert.ok(guestMsgs.some((m) => m.t === "participant-ready" && m.clientId === "guest1" && m.ready === false));
});

test("worker Room handleClaimHost clears syncState and resets started when msg.fresh is true", () => {
  const storageMap = new Map();
  const mockStorage = {
    get: async () => new Map(),
    put: (k: string, v: any) => storageMap.set(k, v),
    delete: (k: string) => storageMap.delete(k),
  };
  const mockState = {
    storage: mockStorage,
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn: any) => fn(),
    acceptWebSocket: () => {},
  };

  const room = new Room(mockState);
  const sHost: any = { send: () => {}, close: () => {}, serializeAttachment: () => {} };
  room.handleHello(sHost, { clientId: "host1", name: "Host" });
  room.handleClaimHost(sHost, { t: "claim-host", fresh: false });
  room.syncState = { mediaId: "tt123", positionSeconds: 1410, playing: false };
  room.started = true;
  assert.ok(room.syncState !== null);
  assert.equal(room.started, true);

  // When claimHost is called with fresh: true (e.g. switching episode), syncState must be cleared
  room.handleClaimHost(sHost, { t: "claim-host", fresh: true });
  assert.equal(room.syncState, null, "syncState must be cleared on fresh claimHost");
  assert.equal(room.started, false, "started must be reset to false on fresh claimHost");
});

test("useRoomInvite allows guest with roomGuestControl to send invite without claiming host", () => {
  const inviteSource = readFileSync(new URL("../src/views/play-picker/use-room-invite.ts", import.meta.url), "utf8");
  const inviteCode = ts.transpileModule(inviteSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const createRunner = () => {
    const refs: any[] = [];
    let refIdx = 0;
    const lastDeps: any[][] = [];
    const effectFns: any[] = [];

    const mockReact = {
      useRef: (init: any) => {
        const idx = refIdx++;
        if (refs[idx] === undefined) refs[idx] = { current: init };
        return refs[idx];
      },
      useEffect: (fn: any, deps?: any[]) => {
        const idx = effectFns.length;
        const prev = lastDeps[idx];
        const changed = !prev || !deps || deps.some((d, i) => d !== prev[i]);
        if (changed) {
          lastDeps[idx] = deps ? [...deps] : [];
          effectFns.push(fn);
        }
      },
    };

    const activeExports: any = {};
    new Function("require", "exports", inviteCode)(
      (name: string) => {
        if (name === "react") return mockReact;
        if (name.includes("build-invite")) {
          return {
            buildPlayInvite: (meta: any, ep: any) => ({
              mediaId: meta.id,
              episode: ep,
            }),
          };
        }
        if (name.includes("room-derive")) {
          return { hostSourceMatchesMedia: () => false };
        }
        return {};
      },
      activeExports,
    );

    return {
      run: (params: any) => {
        refIdx = 0;
        effectFns.length = 0;
        const res = activeExports.useRoomInvite(params);
        for (const fn of effectFns) fn();
        return res;
      },
    };
  };

  // Case 1: Guest with roomGuestControl: false cannot invite
  const runner1 = createRunner();
  let invitesSent: any[] = [];
  let hostClaimed = false;
  const res1 = runner1.run({
    meta: { id: "series1", type: "series", name: "Show" },
    episode: { season: 1, episode: 2 },
    inSession: true,
    roomSnapshot: { hostClientId: "host1", participants: [] },
    clientId: "guest1",
    hostSource: null,
    lastInviteProto: 2,
    roomGuestControl: false,
    wasInvitedTo: () => false,
    claimHost: () => { hostClaimed = true; },
    sendInvite: (inv: any) => invitesSent.push(inv),
  });
  assert.equal(res1.canInvite, false);
  assert.equal(invitesSent.length, 0);
  assert.equal(hostClaimed, false);

  // Case 2: Guest with roomGuestControl: true CAN invite and does NOT claim host
  const runner2 = createRunner();
  invitesSent = [];
  hostClaimed = false;
  const res2 = runner2.run({
    meta: { id: "series1", type: "series", name: "Show" },
    episode: { season: 1, episode: 2 },
    inSession: true,
    roomSnapshot: { hostClientId: "host1", participants: [] },
    clientId: "guest1",
    hostSource: null,
    lastInviteProto: 2,
    roomGuestControl: true,
    wasInvitedTo: () => false,
    claimHost: () => { hostClaimed = true; },
    sendInvite: (inv: any) => invitesSent.push(inv),
  });
  assert.equal(res2.canInvite, true);
  assert.equal(invitesSent.length, 1);
  assert.equal(invitesSent[0].episode.episode, 2);
  assert.equal(hostClaimed, false, "Guest must not usurp hostClientId");

  // Case 3: Host following guest invite calls claimHost(true) to reset readiness
  const runner3 = createRunner();
  invitesSent = [];
  let freshHostClaim = false;
  runner3.run({
    meta: { id: "series1", type: "series", name: "Show" },
    episode: { season: 1, episode: 2 },
    inSession: true,
    roomSnapshot: { hostClientId: "host1", participants: [] },
    clientId: "host1",
    hostSource: null,
    lastInviteProto: 2,
    roomGuestControl: true,
    wasInvitedTo: (key: string) => key === "series1|1|2",
    claimHost: (fresh: boolean) => { freshHostClaim = fresh; },
    sendInvite: (inv: any) => invitesSent.push(inv),
  });
  assert.equal(freshHostClaim, true, "Host must claimHost(true) when following guest episode invite");
});

test("useLobbyGate automatically triggers startHost once when everyoneReady and selfFrameReadyRef is true", () => {
  const lobbySource = readFileSync(new URL("../src/views/player/hooks/use-lobby-gate.ts", import.meta.url), "utf8");
  const lobbyCode = ts.transpileModule(lobbySource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const createRunner = () => {
    const refs: any[] = [];
    const states: any[] = [];
    const lastDeps: any[][] = [];
    let refIdx = 0;
    let stateIdx = 0;
    let effectFns: any[] = [];

    const mockReact = {
      useRef: (init: any) => {
        const idx = refIdx++;
        if (refs[idx] === undefined) refs[idx] = { current: init };
        return refs[idx];
      },
      useState: (init: any) => {
        const idx = stateIdx++;
        if (states[idx] === undefined) states[idx] = typeof init === "function" ? init() : init;
        return [states[idx], (v: any) => { states[idx] = typeof v === "function" ? v(states[idx]) : v; }];
      },
      useCallback: (fn: any) => fn,
      useEffect: (fn: any, deps?: any[]) => {
        const idx = effectFns.length;
        const prev = lastDeps[idx];
        const changed = !prev || !deps || deps.some((d, i) => d !== prev[i]);
        if (changed) {
          lastDeps[idx] = deps ? [...deps] : [];
          effectFns.push(fn);
        }
      },
    };

    const activeExports: any = {};
    new Function("require", "exports", lobbyCode)(
      (name: string) => {
        if (name === "react") return mockReact;
        if (name.includes("player-utils")) {
          return { GUEST_ESCAPE_MS: 15000, READY_STALE_MS: 30000 };
        }
        return {};
      },
      activeExports,
    );

    return {
      run: (params: any) => {
        refIdx = 0;
        stateIdx = 0;
        effectFns = [];
        const res = activeExports.useLobbyGate(params);
        for (const fn of effectFns) fn();
        return res;
      },
    };
  };

  let startRoomCalled = 0;
  let hasStartedVal = false;
  const runner = createRunner();

  // Step 1: Not everyone ready (guest is ready: false) -> should NOT startHost
  runner.run({
    inRoom: true,
    isHost: true,
    hasStarted: hasStartedVal,
    setHasStarted: (v: boolean) => { hasStartedVal = v; },
    roomSnapshot: {
      started: false,
      participants: [
        { id: "host1", ready: true },
        { id: "guest1", ready: false },
      ],
    },
    startRoom: () => { startRoomCalled++; },
    suppressOutgoingFor: () => {},
    bridgeRef: { current: { play: async () => {} } },
    initialSyncDoneRef: { current: false },
    selfFrameReadyRef: { current: true },
    mediaKey: "series1|1|2",
  });
  assert.equal(startRoomCalled, 0);
  assert.equal(hasStartedVal, false);

  // Step 2: All participants ready and selfFrameReadyRef is true -> auto-startHost fires!
  runner.run({
    inRoom: true,
    isHost: true,
    hasStarted: hasStartedVal,
    setHasStarted: (v: boolean) => { hasStartedVal = v; },
    roomSnapshot: {
      started: false,
      participants: [
        { id: "host1", ready: true },
        { id: "guest1", ready: true },
      ],
    },
    startRoom: () => { startRoomCalled++; },
    suppressOutgoingFor: () => {},
    bridgeRef: { current: { play: async () => {} } },
    initialSyncDoneRef: { current: false },
    selfFrameReadyRef: { current: true },
    mediaKey: "series1|1|2",
  });
  assert.equal(startRoomCalled, 1, "startRoom must be called once when everyoneReady");
  assert.equal(hasStartedVal, true, "hasStarted must be set to true when everyoneReady");

  // Step 3: Second pass on same mediaKey -> does not call startRoom again
  runner.run({
    inRoom: true,
    isHost: true,
    hasStarted: hasStartedVal,
    setHasStarted: (v: boolean) => { hasStartedVal = v; },
    roomSnapshot: {
      started: true,
      participants: [
        { id: "host1", ready: true },
        { id: "guest1", ready: true },
      ],
    },
    startRoom: () => { startRoomCalled++; },
    suppressOutgoingFor: () => {},
    bridgeRef: { current: { play: async () => {} } },
    initialSyncDoneRef: { current: false },
    selfFrameReadyRef: { current: true },
    mediaKey: "series1|1|2",
  });
  assert.equal(startRoomCalled, 1, "startRoom must not be called repeatedly");
});

test("TogetherClient optimistically resets started, syncState, and participant readiness on episode transitions", () => {
  const clientSource = readFileSync(new URL("../src/lib/together/client.ts", import.meta.url), "utf8")
    .replace(/import\.meta\.env\?\.DEV/g, "false");
  const clientCode = ts.transpileModule(clientSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const clientExports: any = {};
  new Function("require", "exports", clientCode)(
    (name: string) => {
      if (name.includes("protocol")) {
        return { WT_PROTO: 2 };
      }
      if (name.includes("client-types")) {
        return { diagnoseRelayFailure: () => null };
      }
      return {};
    },
    clientExports,
  );
  const { TogetherClient } = clientExports;

  const client = new TogetherClient("wss://pub.harbor.site", "host1", "Host");
  (client as any).room = "ROOM12";
  (client as any).send = () => {};

  // Seed snapshot with active playing state from previous episode
  (client as any).snapshot = {
    state: "joined",
    room: "ROOM12",
    hostClientId: "host1",
    started: true,
    syncState: { mediaId: "tt123", positionSeconds: 1410, playing: true, updatedAt: Date.now(), updatedBy: "host1", speed: 1 },
    participants: [
      { id: "host1", name: "Host", ready: true, joinedAt: 1, pingMs: 10, avatar: null, color: null, location: null },
      { id: "guest1", name: "Guest", ready: true, joinedAt: 2, pingMs: 15, avatar: null, color: null, location: null },
    ],
    lastError: null,
  };

  // 1. sendInvite optimistically resets started, syncState, and readiness
  client.sendInvite({ mediaId: "tt123", mediaType: "series", episode: { season: 1, episode: 2 } });
  let snap = client.getSnapshot();
  assert.equal(snap.started, false);
  assert.equal(snap.syncState, null);
  assert.equal(snap.participants.every((p: any) => p.ready === false), true);

  // Restore active state
  (client as any).snapshot.started = true;
  (client as any).snapshot.syncState = { mediaId: "tt123", positionSeconds: 1410 };
  (client as any).snapshot.participants[0].ready = true;
  (client as any).snapshot.participants[1].ready = true;

  // 2. claimHost(true) optimistically resets started, syncState, and readiness and sets hostClientId
  client.claimHost(true);
  snap = client.getSnapshot();
  assert.equal(snap.started, false);
  assert.equal(snap.syncState, null);
  assert.equal(snap.participants.every((p: any) => p.ready === false), true);
  assert.equal(snap.hostClientId, "host1");

  // claimHost(false) optimistically claims host without resetting room
  client.claimHost(false);
  assert.equal(client.getSnapshot().hostClientId, "host1");

  // Restore active state
  (client as any).snapshot.started = true;
  (client as any).snapshot.syncState = { mediaId: "tt123", positionSeconds: 1410 };
  (client as any).snapshot.participants[0].ready = true;
  (client as any).snapshot.participants[1].ready = true;

  // 3. incoming invite message from peer resets started, syncState, and readiness
  (client as any).handleServer({
    t: "invite",
    from: "guest1",
    name: "Guest",
    invite: { mediaId: "tt123", episode: { season: 1, episode: 2 } },
    at: Date.now(),
  });
  snap = client.getSnapshot();
  assert.equal(snap.started, false);
  assert.equal(snap.syncState, null);
  assert.equal(snap.participants.every((p: any) => p.ready === false), true);
});

test("useRoomSync guards against stale playback position during episode transition and seeds host resume position", () => {
  let livePos = 1410; // stale position from episode 1
  let intervalCb: (() => void) | null = null;
  const publishedStates: any[] = [];
  const readyCalls: boolean[] = [];

  const refs: any[] = [];
  let refIndex = 0;
  const effects: { deps: any[] | undefined; cleanup: any }[] = [];
  let effectIndex = 0;

  const localExports: any = {};
  new Function("require", "exports", "window", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => 10,
        };
      }
      return {
        useRef: (init: any) => {
          const index = refIndex++;
          if (refs[index] === undefined) refs[index] = { current: init };
          return refs[index];
        },
        useEffect: (fn: any, deps: any[]) => {
          const index = effectIndex++;
          const prev = effects[index];
          let changed = true;
          if (prev && prev.deps && deps) {
            changed = deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
          }
          if (changed) {
            if (prev?.cleanup && typeof prev.cleanup === "function") prev.cleanup();
            effects[index] = { deps, cleanup: fn() };
          }
        },
      };
    },
    localExports,
    {
      setInterval: (cb: any) => { intervalCb = cb; return 1; },
      clearInterval: () => { intervalCb = null; },
      setTimeout: (cb: any) => cb(),
      clearTimeout: () => {},
    },
  );
  const { useRoomSync: hook } = localExports;

  const selfFrameReadyRef = { current: false };
  let currentHasStarted = false;
  const setHasStarted = (v: boolean) => { currentHasStarted = v; };

  const render = (opts: {
    hasStarted: boolean;
    resumeReady: boolean;
    resolvedStartSec: number | null;
    episode: { season: number; episode: number };
    durationSec: number;
  }) => {
    refIndex = 0;
    effectIndex = 0;
    return hook({
      inRoom: true,
      isHost: true,
      hasStarted: opts.hasStarted,
      setHasStarted,
      selfFrameReadyRef,
      resumeReady: opts.resumeReady,
      resolvedStartSec: opts.resolvedStartSec,
      roomSnapshot: {
        participants: [{ id: "host", ready: true }, { id: "guest1", ready: false }],
        started: opts.hasStarted,
        hostClientId: "host",
      },
      clientId: "host",
      src: {
        url: `http://127.0.0.1:7000/play/ep${opts.episode.episode}`,
        meta: { id: "tt123", name: "Show" },
        episode: opts.episode,
      },
      snap: {
        status: "paused",
        durationSec: opts.durationSec,
        rate: 1.0,
        buffering: false,
        videoWidth: 1920,
        videoHeight: 1080,
      },
      bridgeRef: { current: null },
      hostSourceRef: { current: null },
      guestPickRef: { current: false },
      publishState: (s: any) => publishedStates.push(s),
      onIncomingState: () => () => {},
      onIncomingCommand: () => () => {},
      markReady: (r: boolean) => readyCalls.push(r),
      suppressOutgoingFor: () => {},
      setForeignNotice: () => {},
    });
  };

  // Phase 1: Episode 1 finishes at 1410s
  render({
    hasStarted: true,
    resumeReady: true,
    resolvedStartSec: 0,
    episode: { season: 1, episode: 1 },
    durationSec: 1500,
  });

  // Phase 2: Episode switches to S1E2, but resume is NOT ready yet (resumeReady: false)
  // livePos still returns 1410 (stale mpv position of previous episode)
  livePos = 1410;
  publishedStates.length = 0;
  readyCalls.length = 0;
  const api2 = render({
    hasStarted: false,
    resumeReady: false,
    resolvedStartSec: null,
    episode: { season: 1, episode: 2 },
    durationSec: 1500,
  });

  // Heartbeat should not run because hasStarted is false and resumeReady is false
  assert.equal(intervalCb, null, "Heartbeat interval should not be running during lobby load");

  // publishHostStateNow called during lobby with resumeReady false must NOT publish stale 1410
  api2.notifyHostPlayPause(false);
  const lobbyPublish = publishedStates[publishedStates.length - 1];
  assert.ok(lobbyPublish.positionSeconds !== 1410, "Must not broadcast stale 1410s position");
  assert.equal(lobbyPublish.positionSeconds, 0, "Defaults to 0 before resume is resolved");

  // markReady should not have marked host ready while resumeReady is false
  assert.equal(readyCalls.includes(true), false, "Host must not mark ready before resumeReady is true");

  // Phase 3: Resume finishes resolving for S1E2: Host has history at 420s (e.g. 7 minutes in)
  publishedStates.length = 0;
  livePos = 420; // player sought to 420s
  render({
    hasStarted: false,
    resumeReady: true,
    resolvedStartSec: 420,
    episode: { season: 1, episode: 2 },
    durationSec: 1500,
  });

  // Now lobby seed should have broadcast positionSeconds: 420
  const seeded = publishedStates.find((s) => s.positionSeconds === 420);
  assert.ok(seeded, "Lobby seed should publish Host's resolved history timestamp (420s)");
  assert.equal(seeded.playing, false);

  // Ready should be marked
  assert.ok(readyCalls.includes(true), "Host should mark ready once resumeReady is true");

  // Phase 4: Room starts (hasStarted: true, playing: true)
  publishedStates.length = 0;
  render({
    hasStarted: true,
    resumeReady: true,
    resolvedStartSec: 420,
    episode: { season: 1, episode: 2 },
    durationSec: 1500,
  });

  // Heartbeat interval runs and ticks with position around 420
  assert.ok(intervalCb !== null, "Heartbeat interval runs when started");
  intervalCb!();
  const heartbeatState = publishedStates[publishedStates.length - 1];
  assert.equal(heartbeatState.positionSeconds, 420);
});

test("useRoomSync seeds 0 when Host has no playback history for episode", () => {
  let livePos = 0;
  const publishedStates: any[] = [];
  const refs: any[] = [];
  let refIndex = 0;
  const effects: { deps: any[] | undefined; cleanup: any }[] = [];
  let effectIndex = 0;

  const localExports: any = {};
  new Function("require", "exports", "window", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name.includes("playback-clock")) {
        return {
          getPlaybackPosition: () => livePos,
          getPlaybackBuffered: () => 10,
        };
      }
      return {
        useRef: (init: any) => {
          const index = refIndex++;
          if (refs[index] === undefined) refs[index] = { current: init };
          return refs[index];
        },
        useEffect: (fn: any, deps: any[]) => {
          const index = effectIndex++;
          const prev = effects[index];
          let changed = true;
          if (prev && prev.deps && deps) {
            changed = deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
          }
          if (changed) {
            if (prev?.cleanup && typeof prev.cleanup === "function") prev.cleanup();
            effects[index] = { deps, cleanup: fn() };
          }
        },
      };
    },
    localExports,
    {
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: (cb: any) => cb(),
      clearTimeout: () => {},
    },
  );
  const { useRoomSync: hook } = localExports;

  refIndex = 0;
  effectIndex = 0;
  hook({
    inRoom: true,
    isHost: true,
    hasStarted: false,
    setHasStarted: () => {},
    selfFrameReadyRef: { current: false },
    resumeReady: true,
    resolvedStartSec: 0,
    roomSnapshot: {
      participants: [{ id: "host", ready: true }, { id: "guest1", ready: false }],
      started: false,
      hostClientId: "host",
    },
    clientId: "host",
    src: {
      url: "http://127.0.0.1:7000/play/ep2",
      meta: { id: "tt123", name: "Show" },
      episode: { season: 1, episode: 2 },
    },
    snap: {
      status: "paused",
      durationSec: 1500,
      rate: 1.0,
      buffering: false,
      videoWidth: 1920,
      videoHeight: 1080,
    },
    bridgeRef: { current: null },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: (s: any) => publishedStates.push(s),
    onIncomingState: () => () => {},
    onIncomingCommand: () => () => {},
    markReady: () => {},
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
  });

  const seeded = publishedStates.find((s) => s.positionSeconds === 0);
  assert.ok(seeded, "Lobby seed should publish 0s when host has no history");
});

test("Regression Test: Guest Episode 1 useRoomSync does not re-assert markReady(true) on episode reset and calls markReady(false) on unmount", () => {
  const localExports: any = {};
  const refs: any[] = [];
  const effects: any[] = [];
  let refIndex = 0;
  let effectIndex = 0;

  new Function("require", "exports", "window", syncCode)(
    (name: string) => {
      if (name.includes("player-utils")) return utilsExports;
      if (name === "react") {
        return {
          useRef: (init: any) => {
            const index = refIndex++;
            if (!refs[index]) refs[index] = { current: init };
            return refs[index];
          },
          useEffect: (fn: any, deps: any[]) => {
            const index = effectIndex++;
            const prev = effects[index];
            let changed = true;
            if (prev && prev.deps && deps) {
              changed = deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]));
            }
            if (changed) {
              if (prev?.cleanup && typeof prev.cleanup === "function") prev.cleanup();
              effects[index] = { deps, cleanup: fn() };
            }
          },
        };
      }
      return {
        getPlaybackPosition: () => 0,
        usePlaybackFlag: () => false,
        useSettings: () => ({ settings: {} }),
        isDifferentMedia: (a: any, b: any) => {
          if (!a || !b) return true;
          if (a.mediaId !== b.meta?.id) return true;
          const aSeason = a.episode?.season ?? null;
          const bSeason = b.episode?.season ?? null;
          const aEp = a.episode?.episode ?? null;
          const bEp = b.episode?.episode ?? null;
          return aSeason !== bSeason || aEp !== bEp;
        },
      };
    },
    localExports,
    {
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: (cb: any) => cb(),
      clearTimeout: () => {},
    },
  );
  const { useRoomSync: hook } = localExports;

  const markReadyCalls: boolean[] = [];
  const markReady = (ready: boolean) => markReadyCalls.push(ready);
  const selfFrameReadyRef = { current: true };

  // Step 1: Guest is playing Episode 1 (hasStarted: true, selfFrameReady: true)
  refIndex = 0;
  effectIndex = 0;
  hook({
    inRoom: true,
    isHost: false,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef,
    resumeReady: true,
    resolvedStartSec: 0,
    roomSnapshot: {
      participants: [{ id: "host", ready: true }, { id: "guest1", ready: true }],
      started: true,
      hostClientId: "host",
      syncState: {
        mediaId: "tt123",
        episode: { season: 1, episode: 1 },
      },
    },
    clientId: "guest1",
    src: {
      url: "http://127.0.0.1:7000/play/ep1",
      meta: { id: "tt123", name: "Show" },
      episode: { season: 1, episode: 1 },
    },
    snap: {
      status: "playing",
      durationSec: 1500,
      rate: 1.0,
      buffering: false,
      videoWidth: 1920,
      videoHeight: 1080,
    },
    bridgeRef: { current: null },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: () => () => {},
    onIncomingCommand: () => () => {},
    markReady,
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
  });

  markReadyCalls.length = 0;

  // Step 2: Host advances to Episode 2 -> room reset (started: false, guest1.ready = false)
  // Re-render guest's Episode 1 PlayerView before it gets unmounted
  refIndex = 0;
  effectIndex = 0;
  hook({
    inRoom: true,
    isHost: false,
    hasStarted: true,
    setHasStarted: () => {},
    selfFrameReadyRef,
    resumeReady: true,
    resolvedStartSec: 0,
    roomSnapshot: {
      participants: [{ id: "host", ready: true }, { id: "guest1", ready: false }],
      started: false,
      hostClientId: "host",
      syncState: null,
    },
    clientId: "guest1",
    src: {
      url: "http://127.0.0.1:7000/play/ep1",
      meta: { id: "tt123", name: "Show" },
      episode: { season: 1, episode: 1 },
    },
    snap: {
      status: "playing",
      durationSec: 1500,
      rate: 1.0,
      buffering: false,
      videoWidth: 1920,
      videoHeight: 1080,
    },
    bridgeRef: { current: null },
    hostSourceRef: { current: null },
    guestPickRef: { current: false },
    publishState: () => {},
    onIncomingState: () => () => {},
    onIncomingCommand: () => () => {},
    markReady,
    suppressOutgoingFor: () => {},
    setForeignNotice: () => {},
  });

  // Verify: guest Episode 1 should NOT call markReady(true)
  assert.equal(
    markReadyCalls.includes(true),
    false,
    "Guest Episode 1 PlayerView must not re-assert markReady(true) when room resets readiness",
  );

  // Step 3: PlayerView unmounts -> run all effect cleanups
  markReadyCalls.length = 0;
  for (const eff of effects) {
    if (eff?.cleanup && typeof eff.cleanup === "function") {
      eff.cleanup();
    }
  }

  // Verify: unmount must call markReady(false)
  assert.ok(
    markReadyCalls.includes(false),
    "Guest PlayerView unmount must call markReady(false)",
  );
});

test("worker Room handleInvite resets started, syncState, and peer readiness", () => {
  const storageMap = new Map();
  const mockStorage = {
    get: async () => new Map(),
    put: (k: string, v: any) => storageMap.set(k, v),
    delete: (k: string) => storageMap.delete(k),
  };
  const mockState = {
    storage: mockStorage,
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn: any) => fn(),
    acceptWebSocket: () => {},
  };
  const room = new Room(mockState);
  room.started = true;
  room.syncState = { mediaId: "tt123", positionSeconds: 100, playing: true };
  const s1: any = { send: () => {}, close: () => {}, serializeAttachment: () => {} };
  const s2: any = { send: () => {}, close: () => {}, serializeAttachment: () => {} };
  const p1 = { clientId: "host", name: "Host", ready: true, socket: s1 };
  const p2 = { clientId: "guest", name: "Guest", ready: true, socket: s2 };
  room.peers.set(s1, p1);
  room.peers.set(s2, p2);

  const broadcasts: any[] = [];
  room.broadcast = (msg: any) => broadcasts.push(msg);

  room.handleInvite(s1, {
    invite: {
      mediaId: "tt123",
      mediaType: "series",
      episode: { season: 1, episode: 2 },
    },
  });

  assert.equal(room.started, false, "Room.started must be reset to false on invite");
  assert.equal(room.syncState, null, "Room.syncState must be cleared on invite");
  assert.equal(p1.ready, false, "Host peer.ready must be reset to false");
  assert.equal(p2.ready, false, "Guest peer.ready must be reset to false");
  assert.ok(
    broadcasts.some((b) => b.t === "started" && b.started === false),
    "Must broadcast started: false on invite",
  );
  assert.ok(
    broadcasts.some((b) => b.t === "participant-ready" && b.clientId === "guest" && b.ready === false),
    "Must broadcast guest readiness reset on invite",
  );
});




