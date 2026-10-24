// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";

const mpvSource = readFileSync(new URL("../src/lib/player/mpv.ts", import.meta.url), "utf8");
const exitSnapshotSource = readFileSync(
  new URL("../src/views/player/hooks/use-exit-snapshot.ts", import.meta.url),
  "utf8",
);
const trackAutoloadSource = readFileSync(
  new URL("../src/views/player/hooks/use-track-autoload.ts", import.meta.url),
  "utf8",
);
const fetchSubsSource = readFileSync(
  new URL("../src/lib/subtitles/fetch-into-player.ts", import.meta.url),
  "utf8",
);
const trickplaySource = readFileSync(
  new URL("../src/views/player/hooks/use-trickplay.ts", import.meta.url),
  "utf8",
);
const rustMpvSource = readFileSync(new URL("../src-tauri/src/mpv.rs", import.meta.url), "utf8");

test("Task 1: useExitSnapshot does not invoke live captureMpvFrame during active playback", () => {
  // grabFrame must guard against live capture when allowLiveMpvCapture is false
  assert.match(
    exitSnapshotSource,
    /if \(!allowLiveMpvCapture\) \{/,
    "grabFrame should return early before calling captureMpvFrame when live capture is disallowed",
  );

  // During active playing, tick(false) must be called so cplayer is never blocked by live screenshot,
  // and grabFrame only reads from the in-memory thumbCacheNearest without spawning shadow-mpv I/O.
  assert.match(
    exitSnapshotSource,
    /thumbCacheNearest\(bucket, 2\)/,
    "grabFrame must use in-memory thumbCacheNearest for playback thumbnail cache",
  );
  assert.match(
    exitSnapshotSource,
    /const warm = window\.setTimeout\(\(\) => void tick\(false\), WARM_MS\);/,
    "Warmup timer while playing must pass false to disallow live mpv capture",
  );
  assert.match(
    exitSnapshotSource,
    /const id = window\.setInterval\(\(\) => void tick\(false\), CACHE_MS\);/,
    "Cache interval while playing must pass false to disallow live mpv capture",
  );

  // When paused, tick(true) is safe because video is stationary
  assert.match(
    exitSnapshotSource,
    /const pauseTimer = window\.setTimeout\(\(\) => void tick\(true\), 300\);/,
    "Pause timer may capture live frame while stationary",
  );

  // mpv_screenshot_data_url should not use CPU screenshot-sw="yes"
  assert.match(
    rustMpvSource,
    /mpv\.set_property\("screenshot-sw", "no"\)/,
    "screenshot-sw must be 'no' to prevent CPU zimg tone mapping stalls",
  );
});

test("Task 2: spawn_event_loop observes hdr-status without per-event synchronous polling", () => {
  // user-data/display-info/hdr-status should be in OBSERVED_PROPS
  assert.match(
    rustMpvSource,
    /\("user-data\/display-info\/hdr-status", 23, PropertyKind::String\)/,
    "user-data/display-info/hdr-status must be observed via OBSERVED_PROPS",
  );

  // Event loop must NOT do synchronous get_property("user-data/display-info/hdr-status") at the top of the loop
  const eventLoopMatch = rustMpvSource.match(
    /fn spawn_event_loop[\s\S]*?loop \{([\s\S]*?)let res = ctx\.wait_event/,
  );
  assert.ok(eventLoopMatch, "spawn_event_loop body not found");
  assert.doesNotMatch(
    eventLoopMatch[1],
    /get_property::<String>\("user-data\/display-info\/hdr-status"\)/,
    "Top of event loop must not synchronously poll get_property",
  );

  // PropertyChange event should handle hdr-status
  assert.match(
    rustMpvSource,
    /if \*name == "user-data\/display-info\/hdr-status"/,
    "PropertyChange handler must process user-data/display-info/hdr-status event",
  );
});

test("Task 3: cache-on-disk is disabled for local files unless full_download requested", () => {
  assert.match(
    rustMpvSource,
    /let is_local_file = source_kind\(&args\.url\) == "local-file";/,
    "Must detect local file source kind",
  );
  assert.match(
    rustMpvSource,
    /if full_dl \|\| !is_local_file \{[\s\S]*?cache-on-disk", "yes"[\s\S]*?\} else \{[\s\S]*?cache-on-disk", "no"/,
    "cache-on-disk must be 'no' for local files without full_download",
  );
});

test("Task 3: applyAudioFilters deduplicates target af string to prevent WASAPI resets", () => {
  assert.match(
    mpvSource,
    /if \(!mpvStarted\) return;/,
    "applyAudioFilters must guard against running before mpv starts",
  );
  assert.match(
    mpvSource,
    /let lastAppliedAf: string \| null = null;/,
    "lastAppliedAf tracking variable must be present",
  );
  assert.match(
    mpvSource,
    /if \(target === lastAppliedAf\) return;/,
    "applyAudioFilters must skip when target matches lastAppliedAf",
  );
  assert.match(
    mpvSource,
    /lastAppliedAf = target;/,
    "lastAppliedAf must be updated on change",
  );
});

test("Task 3: setAudioNormalize and setAudioProfile are decoupled from subtitle track autoload", () => {
  // setAudioNormalize should have its own effect independent of snap.subtitleTracks
  assert.match(
    trackAutoloadSource,
    /useEffect\(\(\) => \{[\s\n\r]*bridgeRef\.current\?\.setAudioNormalize\(settings\.audioNormalize\);[\s\n\r]*bridgeRef\.current\?\.setAudioProfile\?\.\(settings\.audioProfile\);[\s\n\r]*\}, \[settings\.audioNormalize, settings\.audioProfile, bridgeRef\]\);/,
    "Audio normalize and profile must be in their own useEffect dependent only on settings",
  );

  // The subtitle track autoload effect should NOT call setAudioNormalize or setAudioProfile
  const autoTrackEffect = trackAutoloadSource.match(
    /const subIdSig = subtitleAutoSelectionSignature\(snap\.subtitleTracks\);[\s\S]*?const key = `\$\{src\.url\}\|\$\{audioIdSig\}\|\$\{subIdSig\}\|\$\{preferenceSig\}`;[\s\S]*?if \(autoTrackKeyRef\.current === key\) return;[\s\S]*?(const prefs = readPlayerPrefs)/,
  );
  assert.ok(autoTrackEffect, "Track autoload effect not found");
  assert.doesNotMatch(
    autoTrackEffect[0],
    /setAudioNormalize/,
    "Subtitle auto-track effect must not call setAudioNormalize",
  );
  assert.doesNotMatch(
    autoTrackEffect[0],
    /setAudioProfile/,
    "Subtitle auto-track effect must not call setAudioProfile",
  );
});

test("Task 3: subsync preflight is skipped when external candidate auto-selection is disabled", () => {
  assert.match(
    fetchSubsSource,
    /const shouldAutoSelectCandidate =\s*p\.autoSelect !== false && \(p\.shouldAutoSelect \? p\.shouldAutoSelect\(\) : true\);/,
    "shouldAutoSelectCandidate check must guard candidate preflight",
  );
  assert.match(
    fetchSubsSource,
    /const preflights = shouldAutoSelectCandidate\s*\? await preflightPreparedCandidates/,
    "preflightPreparedCandidates must be conditionally skipped when auto-selection is false",
  );
});

test("Task 3: useTrickplay delays eager shadow mpv on local/network mounts", () => {
  assert.match(
    trickplaySource,
    /const isLocal = !url\.includes\(":\/\/"\) \|\| url\.startsWith\("file:\/\/"\);/,
    "useTrickplay should identify local files",
  );
  assert.match(
    trickplaySource,
    /setTimeout\(\(\) => \{[\s\S]*?trickplaySpawnEager\(\);[\s\S]*?\}, 3500\);/,
    "useTrickplay should delay eager trickplay on local mounts to prevent startup I/O storms",
  );
});

test("Task 4: onWindowFocusRestore does not issue ao-reload during active playback", () => {
  const focusRestoreBlock = mpvSource.match(
    /const onWindowFocusRestore = \(\) => \{([\s\S]*?)\};/,
  );
  assert.ok(focusRestoreBlock, "onWindowFocusRestore function not found");
  assert.match(
    focusRestoreBlock[1],
    /if \(snap\.status === "playing"\) return;/,
    "onWindowFocusRestore must return early when playback is active",
  );
  assert.match(
    focusRestoreBlock[1],
    /scheduleAudioDeviceReload\(\);/,
    "onWindowFocusRestore should still schedule reload when paused/idle after screensaver",
  );
});

