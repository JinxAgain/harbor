// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { parseStoredSettings } from "../src/lib/settings/load.ts";
import {
  collectSameLanguageCandidates,
  formatSyncShift,
  resolveAutoSyncScope,
  trackAutoSyncKey,
} from "../src/lib/subtitles/autosync/embedded-sync.ts";

test("resolveAutoSyncScope matches Nuvio candidate scope policy", () => {
  assert.equal(resolveAutoSyncScope("manual", "automatic"), "selected_only");
  assert.equal(resolveAutoSyncScope("manual", "restore"), "selected_only");
  assert.equal(resolveAutoSyncScope("manual", "manual"), "selected_only");
  assert.equal(resolveAutoSyncScope("automatic", "automatic"), "startup_search");
  assert.equal(resolveAutoSyncScope("automatic", "restore"), "selected_then_search");
  assert.equal(resolveAutoSyncScope("automatic", "manual"), "selected_only");
});

test("trackAutoSyncKey distinguishes same-language external tracks by source URL", () => {
  const first = trackAutoSyncKey({
    id: "ext-1",
    url: "https://subs.example/en-1.srt",
    originalUrl: "https://subs.example/en-1.srt",
  });
  const second = trackAutoSyncKey({
    id: "ext-2",
    url: "https://subs.example/en-2.srt",
    originalUrl: "https://subs.example/en-2.srt",
  });
  assert.notEqual(first, second);
  assert.equal(
    trackAutoSyncKey({ id: "3", url: undefined, originalUrl: undefined, externalFilename: undefined }),
    "id:3",
  );
});

test("collectSameLanguageCandidates filters by normalized language, deduplicates, and honors limit", () => {
  const selected = {
    lang: "eng",
    url: "https://subs.example/selected.srt",
    originalUrl: "https://subs.example/selected.srt",
  };
  const tracks = [
    {
      id: "1",
      label: "Embedded",
      lang: "en",
      kind: "subtitle" as const,
      selected: false,
      external: false,
      url: "https://media.example/embedded.mkv",
    },
    {
      id: "2",
      label: "Selected",
      lang: "en",
      kind: "subtitle" as const,
      selected: true,
      external: true,
      url: "https://subs.example/selected.srt",
      originalUrl: "https://subs.example/selected.srt",
    },
    {
      id: "3",
      label: "Alt EN",
      lang: "English",
      kind: "subtitle" as const,
      selected: false,
      external: true,
      url: "https://subs.example/alt-en.srt",
      originalUrl: "https://subs.example/alt-en.srt",
      format: "srt",
    },
    {
      id: "4",
      label: "French",
      lang: "fr",
      kind: "subtitle" as const,
      selected: false,
      external: true,
      url: "https://subs.example/alt-fr.srt",
    },
  ];
  const available = [
    {
      id: "r1",
      url: "https://subs.example/alt-en.srt",
      lang: "en",
      source: "opensubtitles",
    },
    {
      id: "r2",
      url: "https://subs.example/res-en-2.srt",
      lang: "eng",
      source: "subdl",
    },
    {
      id: "r3",
      url: "https://subs.example/res-es.srt",
      lang: "es",
      source: "subdl",
    },
    {
      id: "r4",
      url: "https://subs.example/res-en-3.srt",
      lang: "en",
      source: "subsource",
    },
  ];

  const cands = collectSameLanguageCandidates(selected, available, tracks, 2);
  assert.deepEqual(
    cands.map((c) => c.url),
    ["https://subs.example/alt-en.srt", "https://subs.example/res-en-2.srt"],
  );
});

test("formatSyncShift formats sub-50ms, sub-second, and second shifts cleanly", () => {
  assert.equal(formatSyncShift(0), "0s");
  assert.equal(formatSyncShift(24), "0s");
  assert.equal(formatSyncShift(250), "+250ms");
  assert.equal(formatSyncShift(-480), "-480ms");
  assert.equal(formatSyncShift(-1460), "-1.5s");
  assert.equal(formatSyncShift(12400), "+12s");
});

test("settings sanitize autoSyncMode and autoSyncToleranceMs with defaults", () => {
  const defaults = parseStoredSettings(null);
  assert.equal(defaults.subtitleAutoSync, false);
  assert.equal(defaults.autoSyncMode, "thorough");
  assert.equal(defaults.autoSyncToleranceMs, 0);

  const custom = parseStoredSettings(
    JSON.stringify({
      subtitleAutoSync: true,
      autoSyncMode: "quick",
      autoSyncToleranceMs: 300,
    }),
  );
  assert.equal(custom.subtitleAutoSync, true);
  assert.equal(custom.autoSyncMode, "quick");
  assert.equal(custom.autoSyncToleranceMs, 300);

  const invalid = parseStoredSettings(
    JSON.stringify({
      autoSyncMode: "ultra",
      autoSyncToleranceMs: 250,
    }),
  );
  assert.equal(invalid.autoSyncMode, "thorough");
  assert.equal(invalid.autoSyncToleranceMs, 0);
});
