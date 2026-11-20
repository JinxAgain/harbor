// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import { requestBpPlay, takeBpPlayIntent } from "../src/views/big-picture/bp-play-request";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const continueCardSource = read("src/components/continue-card.tsx");
const contextMenuSource = read("src/components/context-menu.tsx");
const episodeWatchedMenuSource = read("src/components/episode-watched-menu.tsx");
const seriesPlaySource = read("src/lib/local-library/use-series-play.ts");
const seriesEpisodesSource = read("src/views/detail/series-episodes.tsx");
const cinemetaEpisodesSource = read("src/views/detail/cinemeta-episodes.tsx");
const animeEpisodesSource = read("src/views/detail/anime-episodes.tsx");

test("Continue Watching keeps source selection, direct play, and details as separate actions", () => {
  assert.match(
    continueCardSource,
    /const onChooseSource[\s\S]*?openAvailableSources\(episode, true\)/,
  );
  assert.match(continueCardSource, /const onPlay[\s\S]*?openAvailableSources\(episode, false\)/);
  assert.match(continueCardSource, /onClick=\{onOpenDetails\}/);
});

test("Continue Watching wires Choose source through the card wrapper context menu across all card surfaces", () => {
  assert.match(
    continueCardSource,
    /const openCardContextMenu[\s\S]*?openContextMenu\(e,\s*\{\s*kind:\s*"meta",\s*meta,\s*onChooseSource:\s*\(\)\s*=>\s*\{\s*void onChooseSource\(\);\s*\},\s*\}\)/,
  );
  assert.match(
    continueCardSource,
    /<div[\s\S]*?className="group relative w-full min-w-0"[\s\S]*?onContextMenu=\{openCardContextMenu\}/,
  );
  const onChooseSourceBlock = continueCardSource.match(
    /const onChooseSource = async \(\) => \{[\s\S]*?\n  \};/,
  )?.[0];
  assert.ok(onChooseSourceBlock, "onChooseSource handler must exist");
  assert.doesNotMatch(onChooseSourceBlock, /onPlayOverride/);
});

test("Continue Watching re-resolves addon metadata when authentication changes", () => {
  assert.match(continueCardSource, /resolveMeta\(authKey,/);
  assert.match(
    continueCardSource,
    /\}, \[item\._id, item\.type, item\.state\?\.video_id, authKey\]\);/,
  );
});

test("ContextMenu offers Choose source at the top of meta menus when onChooseSource is provided", () => {
  assert.match(
    contextMenuSource,
    /if \(onChooseSource && !playerActions\) \{[\s\S]*?label=\{t\("Choose source"\)\}[\s\S]*?close\(\);\s*onChooseSource\(\);/,
  );
});

test("EpisodeWatchedMenu renders Choose source and all episode lists wire it with manual picking", () => {
  assert.match(
    episodeWatchedMenuSource,
    /\{onChooseSource && \([\s\S]*?label=\{t\("Choose source"\)\}[\s\S]*?onClose\(\);\s*onChooseSource\(\);/,
  );
  assert.match(
    seriesEpisodesSource,
    /opts:\s*\{\s*autoPlay:\s*false,\s*resume:\s*false,\s*forceChooser:\s*true\s*\}[\s\S]*?<EpisodeWatchedMenu[\s\S]*?onChooseSource=\{\(\)\s*=>\s*chooseEpisodeSource\(watchedMenu\)\}/,
  );
  assert.match(
    cinemetaEpisodesSource,
    /opts:\s*\{\s*autoPlay:\s*false,\s*resume:\s*false,\s*forceChooser:\s*true\s*\}[\s\S]*?<EpisodeWatchedMenu[\s\S]*?onChooseSource=\{\(\)\s*=>\s*chooseEpisodeSource\(watchedMenu\)\}/,
  );
  assert.match(
    animeEpisodesSource,
    /openPicker\([\s\S]*?\{\s*autoPlay:\s*false,\s*resume:\s*false\s*\}[\s\S]*?<EpisodeWatchedMenu[\s\S]*?onChooseSource=\{\(\)\s*=>\s*chooseEpisodeSource\(watchedMenu\)\}/,
  );
});

test("useLocalAwareSeriesPlay honors forceChooser without auto-playing via decidePlaybackSource", () => {
  assert.match(
    seriesPlaySource,
    /const stream = \(\) =>\s*openPicker\(meta,\s*episode,\s*\{\s*autoPlay:\s*opts\?\.autoPlay,\s*resume:\s*opts\?\.resume\s*\}\);/,
  );
  assert.match(
    seriesPlaySource,
    /if \(opts\?\.forceChooser\) \{[\s\S]*?if \(versions\.length === 0 && serverCopies\.length === 0\) \{\s*stream\(\);\s*return;\s*\}[\s\S]*?\} else \{\s*const decision = decidePlaybackSource/,
  );
});

test("Big Picture play intent records forcePicker only when explicitly requested", () => {
  requestBpPlay("series:tt0944947", { season: 2, episode: 2 }, true);
  assert.deepEqual(takeBpPlayIntent("series:tt0944947"), {
    resumeAt: { season: 2, episode: 2 },
    forcePicker: true,
  });
  assert.equal(takeBpPlayIntent("series:tt0944947"), null);

  requestBpPlay("series:tt0944947", { season: 2, episode: 3 });
  assert.deepEqual(takeBpPlayIntent("series:tt0944947"), {
    resumeAt: { season: 2, episode: 3 },
    forcePicker: false,
  });
});
