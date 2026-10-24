import { useCallback } from "react";
import { ContinueCard } from "@/components/continue-card";
import { Row } from "@/components/row";
import { useT } from "@/lib/i18n";
import { useView } from "@/lib/view";
import { clearLocalCw, localCwEntry } from "@/lib/local-cw";
import { pickPreferredResume, readResumeEntry, useResumeVersion } from "@/lib/resume";
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
  useResumeVersion();

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
          bestLocal = pickPreferredResume(bestLocal, e);
        }
        const rawOff = item.state?.timeOffset ?? 0;
        const rawDur = item.state?.duration ?? 0;
        const rawMtime = item.state?.lastWatched ?? (item as { _mtime?: unknown })._mtime;
        const remoteMtime =
          typeof rawMtime === "number" ? rawMtime : Date.parse(String(rawMtime ?? ""));
        let localDur = rawDur > 0 && !item.external ? rawDur : 0;
        for (const cid of candidateIds) {
          const lcw = localCwEntry(cid, false) ?? localCwEntry(cid, true);
          if (lcw && lcw.durationMs > 0 && localDur === 0) {
            const matchesEp = target.type !== "show" || (lcw.season === target.season && lcw.episode === target.episode);
            if (matchesEp) localDur = lcw.durationMs;
          }
        }
        const isFirstParty = Boolean(bestLocal && !bestLocal.source);
        const beatsRemote = !Number.isFinite(remoteMtime)
          ? true
          : Boolean(item.external) && isFirstParty
            ? (bestLocal?.t ?? 0) + 60_000 >= remoteMtime
            : !item.external && !isFirstParty
              ? (bestLocal?.t ?? 0) > remoteMtime + 60_000
              : (bestLocal?.t ?? 0) > remoteMtime;
        const effectiveResume = bestLocal && beatsRemote ? bestLocal : null;
        const off =
          effectiveResume
            ? (effectiveResume.source && localDur > 0 && effectiveResume.pct != null
                ? Math.round(effectiveResume.pct * localDur)
                : effectiveResume.ms > 0
                  ? effectiveResume.ms
                  : effectiveResume.pct != null && localDur > 0
                    ? Math.round(effectiveResume.pct * localDur)
                    : undefined)
            : rawOff > 0
              ? (item.external && localDur > 0 && rawDur > 0
                  ? Math.round((rawOff / rawDur) * localDur)
                  : rawOff)
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
