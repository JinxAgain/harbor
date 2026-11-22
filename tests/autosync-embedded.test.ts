// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { parseStoredSettings } from "../src/lib/settings/load.ts";
import { takePreparedSubtitle } from "../src/lib/subtitles/prepared-registry.ts";
import {
  collectSameLanguageCandidates,
  formatSyncShift,
  resolveAutoSyncScope,
  trackAutoSyncKey,
} from "../src/lib/subtitles/autosync/embedded-sync.ts";
import {
  buildRestoreMetadata,
  commitSyncedSubtitleTrack,
  EMPTY_APPLIED_STATE,
  restoreRevertedSubtitleTrack,
  shouldResetAutoSyncOnTrackChange,
  type AppliedAutoSyncState,
} from "../src/views/player/hooks/use-auto-sync.helpers.ts";
import type { TrackInfo } from "../src/lib/player/bridge.ts";

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

test("collectSameLanguageCandidates rejects unknown-language candidates when target language is known", () => {
  const selected = {
    lang: "en",
    url: "https://subs.example/selected.srt",
    originalUrl: "https://subs.example/selected.srt",
  };
  const tracks: TrackInfo[] = [
    {
      id: "t-unknown",
      label: "Unknown external",
      lang: undefined,
      kind: "subtitle",
      selected: false,
      external: true,
      url: "https://subs.example/unknown-track.srt",
    },
  ];
  const available = [
    {
      id: "r-unknown",
      url: "https://subs.example/unknown-res.srt",
      lang: "",
      source: "opensubtitles",
    },
    {
      id: "r-en",
      url: "https://subs.example/known-en.srt",
      lang: "eng",
      source: "opensubtitles",
    },
  ];

  const cands = collectSameLanguageCandidates(selected, available, tracks);
  assert.deepEqual(
    cands.map((c) => c.url),
    ["https://subs.example/known-en.srt"],
  );
});

test("shouldResetAutoSyncOnTrackChange protects in-flight commits and clears stale synced revert state", () => {
  const mediaKey = "m1";
  const scope = { mediaKey, trackId: "t1" };
  const appliedSyncedA: AppliedAutoSyncState = {
    ...EMPTY_APPLIED_STATE,
    originalTrackId: "t1",
    originalTrackKey: "https://subs.example/a.srt",
    committedTrackId: "t1-synced",
    committedTrackKey: "https://subs.example/a-synced.srt",
    scope,
    changed: true,
  };

  // mpv transient selected === null while committing replacement
  assert.equal(
    shouldResetAutoSyncOnTrackChange({
      mediaKey,
      selected: null,
      selectedSynced: false,
      committingScope: scope,
      statusScope: scope,
      applied: EMPTY_APPLIED_STATE,
    }),
    false,
  );

  // HTML5 synchronous selectedSynced === true while committing replacement
  const syncedTrackA: TrackInfo = {
    id: "t1-synced",
    label: "A",
    kind: "subtitle",
    selected: true,
    external: true,
    autoSynced: true,
    url: "https://subs.example/a-synced.srt",
  };
  assert.equal(
    shouldResetAutoSyncOnTrackChange({
      mediaKey,
      selected: syncedTrackA,
      selectedSynced: true,
      committingScope: scope,
      statusScope: scope,
      applied: appliedSyncedA,
    }),
    false,
  );

  // Switching from synced track A to a different synced track B must clear A's stale revert state
  const syncedTrackB: TrackInfo = {
    id: "t2-synced",
    label: "B",
    kind: "subtitle",
    selected: true,
    external: true,
    autoSynced: true,
    url: "https://subs.example/b-synced.srt",
  };
  assert.equal(
    shouldResetAutoSyncOnTrackChange({
      mediaKey,
      selected: syncedTrackB,
      selectedSynced: true,
      committingScope: null,
      statusScope: null,
      applied: appliedSyncedA,
    }),
    true,
  );
});

test("commitSyncedSubtitleTrack and restoreRevertedSubtitleTrack handle mpv and HTML5 lifecycles", async () => {
  // 1. mpv simulation: addSubtitle emits transient selected=null mid-replace, then resolves.
  const mpvOriginal: TrackInfo = {
    id: "ext-0",
    label: "English",
    lang: "en",
    kind: "subtitle",
    selected: true,
    external: true,
    url: "https://subs.example/orig.srt",
    originalUrl: "https://subs.example/orig.srt",
  };
  let mpvTracks: TrackInfo[] = [mpvOriginal];
  let mpvDelay = 1.25;
  let mpvAdds = 0;

  const mpvCommit = await commitSyncedSubtitleTrack({
    bridge: {
      async addSubtitle(url, lang, title, select, metadata) {
        mpvAdds += 1;
        // Simulate mpv_sub_remove clearing selected before mpv_sub_add
        mpvTracks = [];
        const nextTrack: TrackInfo = {
          id: "ext-1",
          label: title ?? "Synced",
          lang,
          kind: "subtitle",
          selected: Boolean(select),
          external: true,
          url,
          externalFilename: url,
          originalUrl: metadata?.originalUrl,
          autoSynced: metadata?.autoSynced,
          prepared: metadata?.prepared,
        };
        mpvTracks = [nextTrack];
        return true;
      },
      setSubDelay(sec) {
        mpvDelay = sec;
      },
    },
    engine: "mpv",
    chosenUrl: "https://subs.example/orig.srt",
    retimedPath: "C:/temp/autosync_123.srt",
    retimedText: "1\n00:00:02,000 --> 00:00:04,000\nRetimed\n",
    format: "srt",
    lang: "en",
    title: "English",
    baseMetadata: buildRestoreMetadata(mpvOriginal),
    replaceExisting: true,
    replaceTrackId: "ext-0",
    commitOrigin: "automatic",
    getCurrentTracks: () => mpvTracks,
    isStillCurrent: () => true,
  });

  assert.equal(mpvAdds, 1);
  assert.equal(mpvCommit.ok, true);
  assert.equal(mpvCommit.committedTrackId, "ext-1");
  assert.equal(mpvDelay, 0);
  const preparedMpv = takePreparedSubtitle("C:/temp/autosync_123.srt");
  assert.equal(preparedMpv?.text.includes("Retimed"), true);

  // 2. HTML5 simulation with revoked blob + revert from local originalBackupText (zero network).
  const htmlOriginal: TrackInfo = {
    id: "html-0",
    label: "English",
    lang: "en",
    kind: "subtitle",
    selected: true,
    external: true,
    url: "blob:https://harbor.local/revoked-original-blob",
    originalUrl: "https://subs.example/orig.srt",
  };
  let htmlTracks: TrackInfo[] = [htmlOriginal];
  let htmlDelay = -0.8;
  const restoredUrls: string[] = [];

  const htmlBridge = {
    async addSubtitle(url: string, lang?: string, title?: string, select?: boolean, metadata?: Record<string, unknown>) {
      restoredUrls.push(url);
      htmlTracks = [
        {
          id: "html-next",
          label: title ?? "Sub",
          lang,
          kind: "subtitle",
          selected: Boolean(select),
          external: true,
          url,
          originalUrl: metadata?.originalUrl as string | undefined,
          autoSynced: metadata?.autoSynced as boolean | undefined,
        },
      ];
      return true;
    },
    setSubtitleTrack() {},
    setSubDelay(sec: number) {
      htmlDelay = sec;
    },
  };

  const htmlCommit = await commitSyncedSubtitleTrack({
    bridge: htmlBridge,
    engine: "html5",
    chosenUrl: "https://subs.example/orig.srt",
    retimedPath: null,
    retimedText: "1\n00:00:02,000 --> 00:00:04,000\nSynced\n",
    format: "srt",
    lang: "en",
    title: "English",
    baseMetadata: buildRestoreMetadata(htmlOriginal),
    replaceExisting: true,
    replaceTrackId: "html-0",
    commitOrigin: "automatic",
    getCurrentTracks: () => htmlTracks,
    isStillCurrent: () => true,
  });

  assert.equal(htmlCommit.ok, true);
  assert.equal(htmlDelay, 0);
  assert.equal(restoredUrls[0]?.startsWith("blob:"), true);
  takePreparedSubtitle(restoredUrls[0])?.cleanup();

  const reverted = await restoreRevertedSubtitleTrack({
    bridge: htmlBridge,
    applied: {
      originalTrack: htmlOriginal,
      replacedSelected: true,
      originalTrackId: htmlOriginal.id,
      originalTrackKey: "https://subs.example/orig.srt",
      committedTrackId: htmlCommit.committedTrackId,
      committedTrackKey: htmlCommit.committedTrackKey,
      originalBackupPath: null,
      originalBackupText: "1\n00:00:01,000 --> 00:00:03,000\nOriginal\n",
      originalBackupFormat: "srt",
      subDelayBefore: -0.8,
      scope: { mediaKey: "m1", trackId: "html-0" },
      changed: true,
    },
    currentSelected: htmlTracks[0],
    engine: "html5",
    commitOrigin: "automatic",
  });

  assert.equal(reverted, true);
  assert.equal(htmlDelay, -0.8);
  assert.equal(restoredUrls[1]?.startsWith("blob:"), true);
  assert.notEqual(restoredUrls[1], htmlOriginal.url);
  assert.equal(htmlTracks[0]?.autoSynced, false);
  takePreparedSubtitle(restoredUrls[1])?.cleanup();
});
