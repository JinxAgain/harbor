import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { t } from "@/lib/i18n";
import { isSafeHttpsUrl, SONG_ID_GEMINI_MODELS } from "./song-id-match";

export { isSafeHttpsUrl, SONG_ID_GEMINI_MODELS };

export type SongIdProvider = "shazam" | "audd" | "ai";
export type SongIdStage = "idle" | "capturing" | "identifying";

export type SongIdMediaContext = {
  title?: string;
  year?: string;
  season?: number;
  episode?: number;
};

export type SongResult = {
  title: string;
  artist: string;
  album: string;
  artwork: string;
  link: string;
  provider?: string;
} | null;

export type SongIdToastMsg = {
  kind: "info" | "result" | "error";
  title: string;
  body?: string;
  art?: string;
  href?: string;
  linkLabel?: string;
  song?: { title: string; artist: string; album: string; artwork: string };
};

const TOAST_EVENT = "harbor:song-id-toast";

function toast(msg: SongIdToastMsg | null): void {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: msg }));
}

export function onSongIdToast(cb: (msg: SongIdToastMsg | null) => void): () => void {
  const h = (e: Event) => cb((e as CustomEvent<SongIdToastMsg | null>).detail);
  window.addEventListener(TOAST_EVENT, h);
  return () => window.removeEventListener(TOAST_EVENT, h);
}

function youtubeSearchUrl(artist: string, title: string): string {
  const q = [artist, title].filter(Boolean).join(" ").trim();
  return "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
}

function linkLabelFor(href: string): string {
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (host.includes("shazam.com")) return "Open on Shazam";
    if (host.includes("youtube.com") || host.includes("youtu.be")) return "Open on YouTube";
  } catch {
    // Fall through to generic label.
  }
  return "Open track";
}

export function mediaContextFromPlayer(input: {
  title?: string | null;
  releaseDate?: string | null;
  season?: number | null;
  episode?: number | null;
}): SongIdMediaContext | undefined {
  const title = input.title?.trim();
  if (!title) return undefined;
  const yearMatch = input.releaseDate?.match(/\b(19\d{2}|20\d{2})\b/);
  const season =
    typeof input.season === "number" && input.season > 0 ? input.season : undefined;
  const episode =
    typeof input.episode === "number" && input.episode > 0 ? input.episode : undefined;
  return {
    title,
    year: yearMatch?.[1],
    season,
    episode,
  };
}

let currentStage: SongIdStage = "idle";
let activeGeneration = 0;
const stageListeners = new Set<() => void>();

function setStage(next: SongIdStage): void {
  if (currentStage === next) return;
  currentStage = next;
  for (const listener of stageListeners) listener();
}

export function getSongIdStage(): SongIdStage {
  return currentStage;
}

export function subscribeSongIdStage(cb: () => void): () => void {
  stageListeners.add(cb);
  return () => stageListeners.delete(cb);
}

export function isIdentifying(): boolean {
  return currentStage !== "idle";
}

export function cancelSongIdentification(): void {
  activeGeneration += 1;
  const wasRunning = currentStage !== "idle";
  if (wasRunning) {
    setStage("idle");
  }
  toast(null);
  if (wasRunning && isTauri()) {
    void invoke("cancel_song_identification").catch(() => {});
  }
}

export type SongIdOptions = {
  provider: SongIdProvider;
  auddKey: string;
  aiKey: string;
  aiModel: string;
  geminiGrounding?: boolean;
  shazamFallbackGemini?: boolean;
  context?: SongIdMediaContext;
};

function showResult(res: SongResult): void {
  const head = res ? res.title || res.artist : "";
  if (!res || !head) {
    toast({ kind: "error", title: t("Couldn't identify the song") });
    return;
  }
  const sub = res.title ? [res.artist, res.album].filter(Boolean).join(" · ") : res.album;
  const safeArt = isSafeHttpsUrl(res.artwork) ?? undefined;
  const safeLink = isSafeHttpsUrl(res.link);
  const href = safeLink ?? youtubeSearchUrl(res.artist, res.title);
  toast({
    kind: "result",
    title: head,
    body: sub || undefined,
    art: safeArt,
    href,
    linkLabel: linkLabelFor(href),
    song: { title: res.title, artist: res.artist, album: res.album, artwork: safeArt ?? "" },
  });
}

export async function fetchGeminiSongModels(apiKey: string): Promise<string[]> {
  if (!isTauri()) {
    throw new Error(t("Fetching live Gemini models requires the desktop app"));
  }
  return invoke<string[]>("list_gemini_models", { apiKey });
}

export async function identifyNowPlaying(opts: SongIdOptions): Promise<void> {
  if (currentStage !== "idle") return;

  if (!isTauri()) {
    toast({
      kind: "error",
      title: t("Song identification requires the desktop app"),
      body: t("Audio capture from the player is only available in the Windows desktop build."),
    });
    return;
  }

  const provider = opts.provider;
  const auddKey = (opts.auddKey ?? "").trim();
  const aiKey = (opts.aiKey ?? "").trim();

  if (provider === "audd" && !auddKey) {
    toast({
      kind: "error",
      title: t("Missing AudD key"),
      body: t("Add it in Settings → Library & metadata"),
    });
    return;
  }
  if (provider === "ai" && !aiKey) {
    toast({
      kind: "error",
      title: t("Missing Gemini API key"),
      body: t("Add it in Settings → Library & metadata"),
    });
    return;
  }

  const generation = ++activeGeneration;
  setStage("capturing");
  toast({ kind: "info", title: t("Listening…") });

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<string>("harbor:song-id-stage", (event) => {
      if (generation !== activeGeneration) return;
      if (event.payload === "capturing") {
        setStage("capturing");
        toast({ kind: "info", title: t("Listening…") });
      } else if (event.payload === "identifying") {
        setStage("identifying");
        toast({ kind: "info", title: t("Identifying…") });
      }
    });
  } catch {
    // Non-Tauri test environments may not support event listeners.
  }

  try {
    const res = await invoke<SongResult>("identify_now_playing", {
      request: {
        provider,
        apiKey: provider === "ai" ? aiKey : provider === "audd" ? auddKey : null,
        model: (opts.aiModel ?? "").trim() || null,
        context: opts.context ?? null,
        geminiGrounding: opts.geminiGrounding ?? true,
        fallbackGeminiKey:
          provider === "shazam" && opts.shazamFallbackGemini && aiKey ? aiKey : null,
      },
    });
    if (generation !== activeGeneration) return;
    showResult(res);
  } catch (e) {
    if (generation !== activeGeneration) return;
    console.error("song-id failed", e);
    const detail = typeof e === "string" ? e : ((e as Error)?.message ?? String(e));
    toast({
      kind: "error",
      title: t("Song identification failed"),
      body: detail.trim().slice(0, 260) || undefined,
    });
  } finally {
    unlisten?.();
    if (generation === activeGeneration) {
      setStage("idle");
    }
  }
}
