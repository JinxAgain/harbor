import assert from "node:assert/strict";
import test from "node:test";
import "./_localstorage-stub";
import {
  findBestSongMatch,
  isSafeHttpsUrl,
  SONG_ID_GEMINI_MODELS,
} from "../src/lib/song-id-match";
import { parseStoredSettings } from "../src/lib/settings/load";
import type { MusicTrack } from "../src/lib/music/types";

function makeTrack(title: string, artist: string, id = `${artist}:${title}`): MusicTrack {
  return {
    id,
    title,
    artist,
    artwork: "",
    durationSeconds: 180,
    durationLabel: "3:00",
  };
}

test("isSafeHttpsUrl accepts only valid https URLs with hosts", () => {
  assert.equal(
    isSafeHttpsUrl("  https://www.shazam.com/track/42  "),
    "https://www.shazam.com/track/42",
  );
  assert.equal(isSafeHttpsUrl("http://example.com/a.jpg"), null);
  assert.equal(isSafeHttpsUrl("javascript:alert(1)"), null);
  assert.equal(isSafeHttpsUrl("file:///C:/Windows/System32/calc.exe"), null);
  assert.equal(isSafeHttpsUrl("ms-msdt:/id"), null);
  assert.equal(isSafeHttpsUrl(""), null);
  assert.equal(isSafeHttpsUrl(null), null);
});

test("findBestSongMatch requires title and avoids blind unrelated fallbacks", () => {
  const tracks = [
    makeTrack("Completely Different Track", "Random Artist", "1"),
    makeTrack("Running Up That Hill (A Deal with God)", "Kate Bush", "2"),
  ];

  assert.equal(
    findBestSongMatch(tracks, { title: "", artist: "Kate Bush" }),
    null,
    "empty title must never match",
  );
  assert.equal(
    findBestSongMatch(tracks, { title: "Running Up That Hill", artist: "Wrong Artist" }),
    null,
    "artist mismatch must not fall back to tracks[0]",
  );
  assert.equal(
    findBestSongMatch(tracks, { title: "Running Up That Hill", artist: "Kate Bush" })?.id,
    "2",
  );
  assert.equal(
    findBestSongMatch(tracks, { title: "Running Up That Hill (A Deal with God)", artist: "" })?.id,
    "2",
  );
});

test("parseStoredSettings migrates song ID settings safely", () => {
  const fresh = parseStoredSettings(null);
  assert.equal(fresh.songIdProvider, "shazam");
  assert.equal(fresh.songIdAiModel, "gemini-3.8-flash");
  assert.equal(fresh.songIdGeminiGrounding, true);
  assert.equal(fresh.songIdShazamFallbackGemini, false);
  assert.equal(fresh.songCardPosition, "top-center");

  const legacy = parseStoredSettings(
    JSON.stringify({
      songIdProvider: "ai",
      songIdAiModel: "gemini-3.6-flash",
    }),
  );
  assert.equal(legacy.songIdProvider, "ai");
  assert.equal(legacy.songIdAiModel, "gemini-3.8-flash");

  const retired = parseStoredSettings(
    JSON.stringify({
      songIdProvider: "audd",
      songIdAiModel: "gemini-3.5-flash",
      _songIdGemini38V1: true,
    }),
  );
  assert.equal(retired.songIdProvider, "audd");
  assert.equal(retired.songIdAiModel, "gemini-3.8-flash");

  const userChosen = parseStoredSettings(
    JSON.stringify({
      songIdProvider: "bogus",
      songIdAiModel: "gemini-3.5-flash-lite",
      _songIdGemini38V1: true,
    }),
  );
  assert.equal(userChosen.songIdProvider, "shazam");
  assert.equal(userChosen.songIdAiModel, "gemini-3.5-flash-lite");

  const values = SONG_ID_GEMINI_MODELS.map((m) => m.value);
  assert.ok(values.includes("gemini-2.5-flash"));
  assert.ok(values.includes("gemini-2.5-flash-lite"));
  assert.ok(values.includes("gemini-3.8-flash"));

  assert.equal(
    parseStoredSettings(JSON.stringify({ songCardPosition: "bottom-left" })).songCardPosition,
    "bottom-left",
  );
  assert.equal(
    parseStoredSettings(JSON.stringify({ songCardPosition: "bottom-right" })).songCardPosition,
    "bottom-right",
  );
  assert.equal(
    parseStoredSettings(JSON.stringify({ songCardPosition: "top-left" })).songCardPosition,
    "top-center",
  );
});
