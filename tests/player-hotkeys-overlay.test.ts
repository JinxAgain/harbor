// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  HOTKEYS,
  effectiveBinding,
  eventToBinding,
  findHotkeyMatch,
  formatBindingForDisplay,
  groupHotkeysByScope,
} from "../src/lib/hotkeys.ts";
import uiFallback from "../src/lib/i18n/locales/ui-fallback.ts";
import zhPlayback from "../src/lib/i18n/locales/zh/playback.ts";

function keyboardEvent(key: string, init: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  } as KeyboardEvent;
}

const keyboardShortcutsSource = readFileSync(
  new URL("../src/views/player/hooks/use-keyboard-shortcuts.ts", import.meta.url),
  "utf8",
);

const hotkeysOverlaySource = readFileSync(
  new URL("../src/components/player/hotkeys-overlay.tsx", import.meta.url),
  "utf8",
);

test("HOTKEYS defines playerHotkeysHelp under scope Player and group Panels", () => {
  const def = HOTKEYS.find((h) => h.id === "playerHotkeysHelp");
  assert.deepEqual(def, {
    id: "playerHotkeysHelp",
    scope: "Player",
    group: "Panels",
    label: "Keyboard shortcuts",
    description: "Show or hide the in-player keyboard shortcuts overlay.",
    defaultBinding: "?",
  });
});

test("eventToBinding normalizes '?' across keyboard layouts without affecting other shifted bindings", () => {
  assert.equal(eventToBinding(keyboardEvent("?", { shiftKey: true })), "?");
  assert.equal(eventToBinding(keyboardEvent("?", { shiftKey: false })), "?");
  assert.equal(eventToBinding(keyboardEvent("?", { ctrlKey: true, shiftKey: true })), "ctrl+?");
  assert.equal(eventToBinding(keyboardEvent("<", { shiftKey: true })), "shift+<");
  assert.equal(eventToBinding(keyboardEvent("ArrowLeft", { shiftKey: true })), "shift+ArrowLeft");
  assert.equal(eventToBinding(keyboardEvent("/", { shiftKey: false })), "/");
  assert.equal(formatBindingForDisplay("?"), "?");
});

test("findHotkeyMatch and effectiveBinding resolve default and custom overrides for playerHotkeysHelp", () => {
  const shiftQuestion = keyboardEvent("?", { shiftKey: true });
  const plainQuestion = keyboardEvent("?", { shiftKey: false });
  assert.equal(findHotkeyMatch(shiftQuestion, {}, "Player"), "playerHotkeysHelp");
  assert.equal(findHotkeyMatch(plainQuestion, {}, "Player"), "playerHotkeysHelp");
  assert.equal(effectiveBinding("playerHotkeysHelp", {}), "?");

  const overrides = {
    playerHotkeysHelp: "ctrl+/",
    playerPlayPause: "k",
  };
  assert.equal(findHotkeyMatch(shiftQuestion, overrides, "Player"), null);
  assert.equal(
    findHotkeyMatch(keyboardEvent("/", { ctrlKey: true }), overrides, "Player"),
    "playerHotkeysHelp",
  );
  assert.equal(effectiveBinding("playerHotkeysHelp", overrides), "ctrl+/");
  assert.equal(effectiveBinding("playerPlayPause", overrides), "k");
});

test("groupHotkeysByScope returns all Player hotkeys grouped cleanly", () => {
  const grouped = groupHotkeysByScope("Player");
  const playerDefs = HOTKEYS.filter((h) => h.scope === "Player");
  const flattened = grouped.flatMap((g) => g.items);

  assert.equal(flattened.length, playerDefs.length);
  assert.ok(flattened.every((h) => h.scope === "Player"));
  assert.ok(flattened.some((h) => h.id === "playerHotkeysHelp"));

  const panels = grouped.find((g) => g.group === "Panels");
  assert.ok(panels);
  assert.ok(panels.items.some((h) => h.id === "playerHotkeysHelp"));
});

test("use-keyboard-shortcuts toggles the hotkeys overlay and PlayerHotkeysOverlay reads live overrides", () => {
  assert.match(
    keyboardShortcutsSource,
    /if\s*\(\s*match\("playerHotkeysHelp"\)\s*&&\s*setShowHotkeys\s*\)\s*\{[\s\S]*?if\s*\(\s*!e\.repeat\s*\)\s*setShowHotkeys\(\(v\)\s*=>\s*!v\)/,
  );
  assert.match(hotkeysOverlaySource, /groupHotkeysByScope\("Player"\)/);
  assert.match(hotkeysOverlaySource, /effectiveBinding\(def\.id,\s*overrides\)/);
  assert.match(hotkeysOverlaySource, /def\.id in overrides/);
  assert.match(hotkeysOverlaySource, /formatBindingForDisplay\(binding\)/);
});

test("ui-fallback and zh playback localize player hotkeys overlay strings", () => {
  const keys = [
    "Keyboard shortcuts",
    "Show or hide the in-player keyboard shortcuts overlay.",
    "Press {key} or Esc to close",
    "Close keyboard shortcuts",
  ];
  for (const key of keys) {
    assert.ok(uiFallback[key], `uiFallback missing: ${key}`);
    assert.ok(zhPlayback[key], `zhPlayback missing: ${key}`);
  }
});
