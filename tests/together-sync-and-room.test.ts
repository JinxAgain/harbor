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

test("REQUIRED_RELAY_VERSION is 12 and matches WORKER_VERSION", () => {
  assert.equal(REQUIRED_RELAY_VERSION, 12);
  assert.equal(WORKER_VERSION, 12);
  assert.equal(relayOutdated(11), true);
  assert.equal(relayOutdated(12), false);
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
