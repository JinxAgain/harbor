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
    snap: { status: "playing", durationSec: 1000, rate: 1.0, buffering: false },
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

  // Should adjust rate to 1.05x and NOT seek
  assert.equal(seekCalls.length, 0);
  assert.equal(rateCalls.length, 1);
  assert.equal(Math.round(rateCalls[0] * 100) / 100, 1.05);

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

  // Should restore normal rate 1.0x and NOT seek
  assert.equal(seekCalls.length, 0);
  assert.equal(rateCalls.length, 1);
  assert.equal(rateCalls[0], 1.0);

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
    snap: { status: "playing", durationSec: 1000, rate: 1.0, buffering: false },
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

test("REQUIRED_RELAY_VERSION is 13 and matches WORKER_VERSION", () => {
  assert.equal(REQUIRED_RELAY_VERSION, 13);
  assert.equal(WORKER_VERSION, 13);
  assert.equal(relayOutdated(12), true);
  assert.equal(relayOutdated(13), false);
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

