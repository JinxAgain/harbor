import { artistIdentityKey } from "@/lib/music/artist-popularity";
import type { MusicTrack } from "@/lib/music/types";

export const SONG_ID_GEMINI_MODELS = [
  { value: "gemini-2.5-flash", label: "2.5 Flash" },
  { value: "gemini-2.5-flash-lite", label: "2.5 Flash-Lite" },
  { value: "gemini-3.8-flash", label: "3.8 Flash" },
  { value: "gemini-3.5-flash-lite", label: "3.5 Flash-Lite" },
  { value: "gemini-4-argon", label: "4 Argon" },
] as const;

export type SongIdTrackCandidate = {
  title: string;
  artist: string;
};

export function isSafeHttpsUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" && parsed.hostname.length > 0 ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function artistsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Matches a recognized song against catalog search tracks without falling back to unrelated items.
 */
export function findBestSongMatch(
  tracks: readonly MusicTrack[],
  song: SongIdTrackCandidate,
): MusicTrack | null {
  const title = artistIdentityKey(song.title);
  if (!title) return null;
  const artist = artistIdentityKey(song.artist);

  if (artist) {
    const exact = tracks.find(
      (track) =>
        artistIdentityKey(track.title) === title && artistIdentityKey(track.artist) === artist,
    );
    if (exact) return exact;

    const exactTitleLooseArtist = tracks.find(
      (track) =>
        artistIdentityKey(track.title) === title &&
        artistsMatch(artistIdentityKey(track.artist), artist),
    );
    if (exactTitleLooseArtist) return exactTitleLooseArtist;

    return (
      tracks.find((track) => {
        const trackTitle = artistIdentityKey(track.title);
        const trackArtist = artistIdentityKey(track.artist);
        if (!trackTitle || !artistsMatch(trackArtist, artist)) return false;
        return trackTitle.includes(title) || title.includes(trackTitle);
      }) ?? null
    );
  }

  return tracks.find((track) => artistIdentityKey(track.title) === title) ?? null;
}
