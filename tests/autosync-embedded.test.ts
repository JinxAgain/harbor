// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
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
  matchesCommittedSyncedTrack,
  resolveAutoSyncRunTarget,
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

test("HTML5 deferred snapshot commit pre-seeds committedTrackKey so matchesCommittedSyncedTrack holds", async () => {
  const preCommitTrack: TrackInfo = {
    id: "html-0",
    label: "English",
    lang: "en",
    kind: "subtitle",
    selected: true,
    external: true,
    url: "blob:https://harbor.local/pre-commit",
    originalUrl: "https://subs.example/deferred.srt",
  };
  const addedBlobs: string[] = [];
  let renderedTracks: TrackInfo[] = [preCommitTrack];
  let deferredNextTrack: TrackInfo | null = null;

  const commit = await commitSyncedSubtitleTrack({
    bridge: {
      async addSubtitle(url, lang, title, select, metadata) {
        addedBlobs.push(url);
        // Simulate HTML5 emit()->setSnap() committing only after current microtask:
        deferredNextTrack = {
          id: "html-synced-1",
          label: title ?? "Sub",
          lang,
          kind: "subtitle",
          selected: Boolean(select),
          external: true,
          url,
          originalUrl: metadata?.originalUrl,
          autoSynced: metadata?.autoSynced,
        };
        return true;
      },
      setSubDelay() {},
    },
    engine: "html5",
    chosenUrl: "https://subs.example/deferred.srt",
    retimedPath: null,
    retimedText: "1\n00:00:02,000 --> 00:00:04,000\nSynced\n",
    format: "srt",
    lang: "en",
    title: "English",
    baseMetadata: buildRestoreMetadata(preCommitTrack),
    replaceExisting: true,
    replaceTrackId: "html-0",
    commitOrigin: "automatic",
    getCurrentTracks: () => renderedTracks,
    isStillCurrent: () => true,
  });

  assert.equal(commit.ok, true);
  assert.equal(commit.committedTrackId, null);
  assert.equal(commit.committedTrackKey, "https://subs.example/deferred.srt");

  assert.ok(deferredNextTrack);
  renderedTracks = [deferredNextTrack];
  assert.equal(
    matchesCommittedSyncedTrack(
      {
        changed: true,
        committedTrackId: commit.committedTrackId,
        committedTrackKey: commit.committedTrackKey,
      },
      renderedTracks[0],
    ),
    true,
  );
  takePreparedSubtitle(addedBlobs[0])?.cleanup();
});

test("resolveAutoSyncRunTarget uses original backup and delay on Re-sync, never retimed temp files", () => {
  const originalTrack: TrackInfo = {
    id: "sub-orig",
    label: "English",
    lang: "en",
    kind: "subtitle",
    selected: false,
    external: true,
    url: "https://subs.example/show-s02e07.srt",
    originalUrl: "https://subs.example/show-s02e07.srt",
    release: "Show.S02E07.1080p.WEB-DL",
    externalFilename: "C:\\tmp\\show-s02e07.srt",
    prepared: true,
  };
  const syncedTrack: TrackInfo = {
    id: "sub-synced-1",
    label: "English",
    lang: "en",
    kind: "subtitle",
    selected: true,
    external: true,
    url: "C:\\tmp\\autosync_aaa_111.srt",
    originalUrl: "https://subs.example/show-s02e07.srt",
    externalFilename: "C:\\tmp\\autosync_aaa_111.srt",
    prepared: true,
    autoSynced: true,
  };
  const applied: AppliedAutoSyncState = {
    originalTrack,
    replacedSelected: true,
    originalTrackId: originalTrack.id,
    originalTrackKey: "https://subs.example/show-s02e07.srt",
    committedTrackId: syncedTrack.id,
    committedTrackKey: "https://subs.example/show-s02e07.srt",
    originalBackupPath: "C:\\tmp\\autosync_orig_aaa_000.srt",
    originalBackupText: "1\n00:00:01,000 --> 00:00:02,000\nOriginal\n",
    originalBackupFormat: "srt",
    subDelayBefore: 1.5,
    scope: { mediaKey: "m-s02e07", trackId: originalTrack.id },
    changed: true,
  };

  const target = resolveAutoSyncRunTarget({
    currentSelected: syncedTrack,
    applied,
    currentMediaKey: "m-s02e07",
    season: 2,
    episode: 7,
  });
  assert.ok(target);
  assert.equal(target.sourceTrack.id, "sub-orig");
  assert.equal(target.replaceTrackId, "sub-synced-1");
  assert.equal(target.preservedApplied, applied);
  assert.equal(target.selectedInput.localPath, "C:\\tmp\\autosync_orig_aaa_000.srt");
  assert.equal(target.selectedInput.inlineText, applied.originalBackupText);
  assert.equal(target.selectedInput.season, 2);
  assert.equal(target.selectedInput.episode, 7);

  // Alternative synced track (replacedSelected: false): strips autosync_* localPath, keeps originalUrl.
  const altSynced: TrackInfo = {
    ...syncedTrack,
    id: "sub-alt-synced",
    originalUrl: "https://subs.example/alt-s02e07.srt",
    externalFilename: "/tmp/autosync_alt_222.srt",
  };
  const altTarget = resolveAutoSyncRunTarget({
    currentSelected: altSynced,
    applied: {
      ...applied,
      replacedSelected: false,
      committedTrackId: altSynced.id,
      committedTrackKey: "https://subs.example/alt-s02e07.srt",
    },
    currentMediaKey: "m-s02e07",
    season: 2,
    episode: 7,
  });
  assert.ok(altTarget);
  assert.equal(altTarget.selectedInput.url, "https://subs.example/alt-s02e07.srt");
  assert.equal(altTarget.selectedInput.localPath, undefined);
});

test("collectSameLanguageCandidates forwards episode and release metadata for ZIP selection", () => {
  const selected: TrackInfo = {
    id: "t0",
    label: "English",
    lang: "en",
    kind: "subtitle",
    selected: true,
    external: true,
    url: "https://subs.example/selected.srt",
    originalUrl: "https://subs.example/selected.srt",
  };
  const cands = collectSameLanguageCandidates(
    selected,
    [
      {
        id: "r1",
        url: "https://subs.example/pack.zip",
        lang: "en",
        release: "Show.S03E09.1080p.NF.WEB-DL",
      },
    ],
    [
      {
        id: "t1",
        label: "English Alt",
        lang: "en",
        kind: "subtitle",
        selected: false,
        external: true,
        url: "https://subs.example/alt.zip",
        originalUrl: "https://subs.example/alt.zip",
        release: "Show.S03E09.BLURAY",
        externalFilename: "Show.S03E09.en.zip",
      },
    ],
    12,
    { season: 3, episode: 9 },
  );
  assert.equal(cands.length, 2);
  assert.equal(cands[0].release, "Show.S03E09.BLURAY");
  assert.equal(cands[0].filename, "Show.S03E09.en.zip");
  assert.equal(cands[0].season, 3);
  assert.equal(cands[0].episode, 9);
  assert.equal(cands[1].release, "Show.S03E09.1080p.NF.WEB-DL");
  assert.equal(cands[1].season, 3);
  assert.equal(cands[1].episode, 9);
});

test("regression contracts: deferred replacement removal, popover held reset, restore guard, desktop gate", () => {
  const mpvSrc = readFileSync(new URL("../src/lib/player/mpv.ts", import.meta.url), "utf8");
  const mpvAddBlock = mpvSrc.slice(mpvSrc.indexOf("async addSubtitle"), mpvSrc.indexOf("getSelectedTrackCues"));
  assert.ok(mpvAddBlock.indexOf('"mpv_sub_add"') > 0);
  assert.ok(mpvAddBlock.indexOf('"mpv_sub_remove"') > mpvAddBlock.indexOf('"mpv_sub_add"'));

  const htmlSrc = readFileSync(new URL("../src/lib/player/html5/bridge.ts", import.meta.url), "utf8");
  const htmlAddBlock = htmlSrc.slice(htmlSrc.indexOf("async addSubtitle"), htmlSrc.indexOf("getSelectedTrackCues"));
  assert.ok(htmlAddBlock.indexOf("await ensureLoaded(track)") > 0);
  assert.ok(
    htmlAddBlock.indexOf("if (loaded) removeSupersededTrack()") >
      htmlAddBlock.indexOf("await ensureLoaded(track)"),
  );

  const popoverSrc = readFileSync(
    new URL("../src/components/player/autosync/autosync-popover.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(popoverSrc.includes("if (!visible) {\n      setHeld(false);") || popoverSrc.includes("if (!visible)"));
  assert.ok((popoverSrc.match(/setHeld\(false\)/g) ?? []).length >= 5);

  const autoloadSrc = readFileSync(
    new URL("../src/views/player/hooks/use-track-autoload.ts", import.meta.url),
    "utf8",
  );
  assert.ok(autoloadSrc.includes("t.autoSynced === true"));
  assert.ok(autoloadSrc.includes("satisfiedKey: restoreKey"));

  const hookSrc = readFileSync(
    new URL("../src/views/player/hooks/use-auto-sync.ts", import.meta.url),
    "utf8",
  );
  assert.ok(hookSrc.includes("isDesktopTauri()"));
  assert.ok(!hookSrc.includes("isNativeTauri"));
  assert.ok(hookSrc.includes('case "container_unavailable":'));
});
