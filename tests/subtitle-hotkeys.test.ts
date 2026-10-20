// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  HOTKEYS,
  effectiveBinding,
  findHotkeyMatch,
  formatBindingForDisplay,
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

test("HOTKEYS defines subtitle position and size hotkeys under scope Player and group Tracks", () => {
  const posUp = HOTKEYS.find((h) => h.id === "playerSubPosUp");
  assert.deepEqual(posUp, {
    id: "playerSubPosUp",
    scope: "Player",
    group: "Tracks",
    label: "Raise subtitles",
    description: "Move subtitles higher on the video.",
    defaultBinding: "alt+ArrowUp",
  });

  const posDown = HOTKEYS.find((h) => h.id === "playerSubPosDown");
  assert.deepEqual(posDown, {
    id: "playerSubPosDown",
    scope: "Player",
    group: "Tracks",
    label: "Lower subtitles",
    description: "Move subtitles closer to the bottom of the video.",
    defaultBinding: "alt+ArrowDown",
  });

  const sizeUp = HOTKEYS.find((h) => h.id === "playerSubSizeUp");
  assert.deepEqual(sizeUp, {
    id: "playerSubSizeUp",
    scope: "Player",
    group: "Tracks",
    label: "Increase subtitle size",
    description: "Make subtitles larger during playback.",
    defaultBinding: "alt+PageUp",
  });

  const sizeDown = HOTKEYS.find((h) => h.id === "playerSubSizeDown");
  assert.deepEqual(sizeDown, {
    id: "playerSubSizeDown",
    scope: "Player",
    group: "Tracks",
    label: "Decrease subtitle size",
    description: "Make subtitles smaller during playback.",
    defaultBinding: "alt+PageDown",
  });
});

test("findHotkeyMatch and effectiveBinding resolve default bindings and user overrides", () => {
  const altUp = keyboardEvent("ArrowUp", { altKey: true });
  const altDown = keyboardEvent("ArrowDown", { altKey: true });
  const altPgUp = keyboardEvent("PageUp", { altKey: true });
  const altPgDn = keyboardEvent("PageDown", { altKey: true });

  assert.equal(findHotkeyMatch(altUp, {}, "Player"), "playerSubPosUp");
  assert.equal(findHotkeyMatch(altDown, {}, "Player"), "playerSubPosDown");
  assert.equal(findHotkeyMatch(altPgUp, {}, "Player"), "playerSubSizeUp");
  assert.equal(findHotkeyMatch(altPgDn, {}, "Player"), "playerSubSizeDown");

  // Effective binding returns defaults when no override
  assert.equal(effectiveBinding("playerSubPosUp", {}), "alt+ArrowUp");
  assert.equal(effectiveBinding("playerSubPosDown", {}), "alt+ArrowDown");
  assert.equal(effectiveBinding("playerSubSizeUp", {}), "alt+PageUp");
  assert.equal(effectiveBinding("playerSubSizeDown", {}), "alt+PageDown");

  // Custom user override takes precedence
  const overrides = {
    playerSubPosDown: "ctrl+shift+ArrowDown",
    playerSubSizeUp: "ctrl+PageUp",
  };
  const ctrlShiftDown = keyboardEvent("ArrowDown", { ctrlKey: true, shiftKey: true });
  assert.equal(findHotkeyMatch(ctrlShiftDown, overrides, "Player"), "playerSubPosDown");
  assert.equal(findHotkeyMatch(altDown, overrides, "Player"), null);
  assert.equal(effectiveBinding("playerSubPosDown", overrides), "ctrl+shift+ArrowDown");
});

test("formatBindingForDisplay formats arrows and page keys properly", () => {
  assert.equal(formatBindingForDisplay("alt+ArrowUp"), "Alt + ↑");
  assert.equal(formatBindingForDisplay("alt+ArrowDown"), "Alt + ↓");
  assert.equal(formatBindingForDisplay("alt+PageUp"), "Alt + PgUp");
  assert.equal(formatBindingForDisplay("alt+PageDown"), "Alt + PgDn");
});

test("use-keyboard-shortcuts handles subtitle position and size adjustments and depends on settings", () => {
  assert.match(
    keyboardShortcutsSource,
    /if\s*\(\s*match\("playerSubPosDown"\)\s*\)\s*\{[\s\S]*?subMarginY[\s\S]*?- 2[\s\S]*?update\(\{ subMarginY/,
  );
  assert.match(
    keyboardShortcutsSource,
    /if\s*\(\s*match\("playerSubPosUp"\)\s*\)\s*\{[\s\S]*?subMarginY[\s\S]*?\+ 2[\s\S]*?update\(\{ subMarginY/,
  );
  assert.match(
    keyboardShortcutsSource,
    /if\s*\(\s*match\("playerSubSizeUp"\)\s*\)\s*\{[\s\S]*?subFontSize[\s\S]*?\+ 2[\s\S]*?update\(\{ subFontSize/,
  );
  assert.match(
    keyboardShortcutsSource,
    /if\s*\(\s*match\("playerSubSizeDown"\)\s*\)\s*\{[\s\S]*?subFontSize[\s\S]*?- 2[\s\S]*?update\(\{ subFontSize/,
  );

  assert.match(keyboardShortcutsSource, /settings\.subMarginY,/);
  assert.match(keyboardShortcutsSource, /settings\.subFontSize,/);
});

test("zh locale and ui-fallback translate all four subtitle hotkey labels and descriptions", () => {
  const labels = [
    "Lower subtitles",
    "Raise subtitles",
    "Increase subtitle size",
    "Decrease subtitle size",
  ];
  const descriptions = [
    "Move subtitles closer to the bottom of the video.",
    "Move subtitles higher on the video.",
    "Make subtitles larger during playback.",
    "Make subtitles smaller during playback.",
  ];

  for (const label of labels) {
    assert.ok(uiFallback[label], `uiFallback missing label: ${label}`);
    assert.ok(zhPlayback[label], `zhPlayback missing label: ${label}`);
  }
  for (const desc of descriptions) {
    assert.ok(uiFallback[desc], `uiFallback missing description: ${desc}`);
    assert.ok(zhPlayback[desc], `zhPlayback missing description: ${desc}`);
  }

  assert.equal(zhPlayback["Lower subtitles"], "下移字幕");
  assert.equal(zhPlayback["Raise subtitles"], "上移字幕");
  assert.equal(zhPlayback["Increase subtitle size"], "增大字幕大小");
  assert.equal(zhPlayback["Decrease subtitle size"], "减小字幕大小");
});
