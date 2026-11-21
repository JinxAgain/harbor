import { useState } from "react";
import { Check, Heart, LoaderCircle } from "@/components/icons/music-icons";
import { useT } from "@/lib/i18n";
import { searchTyped } from "@/lib/music/catalog";
import { isMusicLiked } from "@/lib/music/liked";
import { getMusicState, toggleMusicLiked } from "@/lib/music/player";
import { findBestSongMatch } from "@/lib/song-id-match";

type Song = { title: string; artist: string; album: string; artwork: string };
type State = "idle" | "saving" | "saved" | "error";

export function SongIdSave({ song, compact }: { song: Song; compact: boolean }) {
  const t = useT();
  const [state, setState] = useState<State>("idle");

  const save = async () => {
    if (state === "saving" || state === "saved") return;
    setState("saving");
    try {
      const results = await searchTyped(`${song.artist} ${song.title}`.trim(), 12);
      const track = findBestSongMatch(results.tracks, song);
      if (!track) throw new Error("no match");
      if (!isMusicLiked(getMusicState().likedIds, track)) {
        toggleMusicLiked(track);
      }
      setState("saved");
    } catch {
      setState("error");
    }
  };

  const label =
    state === "saved"
      ? t("music.saved")
      : state === "error"
        ? t("music.action.error")
        : t("music.dock.part.like");

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={state === "saving" || state === "saved"}
      onClick={() => void save()}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-white/10 text-white/85 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-100 ${compact ? "size-9" : "size-11"}`}
    >
      {state === "saving" ? (
        <LoaderCircle
          size={compact ? 16 : 18}
          aria-hidden="true"
          className="animate-spin motion-reduce:animate-none"
        />
      ) : state === "saved" ? (
        <Check size={compact ? 16 : 18} aria-hidden="true" />
      ) : (
        <Heart
          size={compact ? 16 : 18}
          aria-hidden="true"
          className={state === "error" ? "opacity-50" : undefined}
        />
      )}
    </button>
  );
}
