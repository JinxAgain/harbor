import { useCallback } from "react";
import { ContinueCard } from "@/components/continue-card";
import { Row } from "@/components/row";
import { useT } from "@/lib/i18n";
import { useView } from "@/lib/view";
import { clearLocalCw } from "@/lib/local-cw";
import { readResumeEntry } from "@/lib/resume";
import type { LibraryItem } from "@/lib/stremio";
import type { LocalEntry } from "@/lib/local-library";
import { localPlayerSrc } from "@/lib/local-library/player-src";
import { findLocalMovieVersions, findLocalEpisodeVersions } from "@/lib/local-library/versions";
import { openLocalVersions } from "@/lib/player/local-versions-modal";
import { useLocalContinueWatching } from "@/lib/local-library/use-local-cw";

/**
 * Continue Watching for files on disk. Same store, item shape and card as the
 * Home row; scoped to the local library and hidden when nothing is in progress.
 */
export function LocalCwRow() {
  const t = useT();
  const { openPlayer } = useView();
  const cards = useLocalContinueWatching();

  const play = useCallback(
    (entry: LocalEntry, item: LibraryItem) => {
      const versions =
        entry.type === "show" && entry.season != null && entry.episode != null
          ? findLocalEpisodeVersions(entry.season, entry.episode, entry.tmdbId, entry.imdbId)
          : findLocalMovieVersions(entry.tmdbId, entry.imdbId);
      const start = (target: LocalEntry) => {
        const src = localPlayerSrc(target, target.isAnime === true);
        // Only fall back to item._id if src.meta.id is not canonical or is missing.
        // Never downgrade canonical tmdb/imdb src.meta.id back to legacy local:<hash>.
        const id =
          src.meta.id && !src.meta.id.startsWith("local:")
            ? src.meta.id
            : item._id;
        const candidateIds = [item._id, src.meta.id, `local:${target.id}`];
        if (target.imdbId) candidateIds.push(target.imdbId);
        if (target.tmdbId != null) {
          candidateIds.push(`tmdb:${target.type === "show" ? "tv" : "movie"}:${target.tmdbId}`);
        }
        let bestLocal: ReturnType<typeof readResumeEntry> = null;
        for (const cid of candidateIds) {
          const e = readResumeEntry(cid, target.season ?? undefined, target.episode ?? undefined);
          if (e && (!bestLocal || e.t > bestLocal.t)) {
            bestLocal = e;
          }
        }
        const rawOff = item.state?.timeOffset ?? 0;
        const rawMtime = item.state?.lastWatched ?? (item as { _mtime?: unknown })._mtime;
        const remoteMtime =
          typeof rawMtime === "number" ? rawMtime : Date.parse(String(rawMtime ?? ""));
        const off =
          bestLocal && (!Number.isFinite(remoteMtime) || bestLocal.t > remoteMtime) && bestLocal.ms > 0
            ? bestLocal.ms
            : rawOff > 0
              ? rawOff
              : undefined;
        openPlayer({
          ...src,
          resume: true,
          startPositionMs: off,
          meta: { ...src.meta, id },
        });
      };
      if (versions.length > 1) {
        openLocalVersions({
          title: entry.title,
          poster: item.poster ?? entry.poster ?? null,
          entries: versions,
          onPlayLocal: start,
        });
        return;
      }
      start(entry);
    },
    [openPlayer],
  );

  const onDismiss = useCallback((item: LibraryItem) => clearLocalCw(item._id), []);

  if (cards.length === 0) return null;

  return (
    <Row title={t("Continue Watching")} min={260} shape="landscape" scrollKey="library:local:cw">
      {cards.map(({ item, entry }) => (
        <ContinueCard
          key={item._id}
          item={item}
          onDismiss={onDismiss}
          onPlayOverride={() => play(entry, item)}
        />
      ))}
    </Row>
  );
}
