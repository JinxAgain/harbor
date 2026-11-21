import { useSyncExternalStore } from "react";
import { AudioLines } from "lucide-react";
import { useSettings } from "@/lib/settings";
import {
  getSongIdStage,
  identifyNowPlaying,
  subscribeSongIdStage,
  type SongIdMediaContext,
} from "@/lib/song-id";
import { Tooltip } from "@/components/player/transport/tooltip";
import { useT } from "@/lib/i18n";

export function IdentifySongButton({
  className,
  tight,
  editing,
  iconUrl,
  mediaContext,
}: {
  className?: string;
  tight?: boolean;
  editing?: boolean;
  iconUrl?: string;
  mediaContext?: SongIdMediaContext;
}) {
  const t = useT();
  const { settings } = useSettings();
  const stage = useSyncExternalStore(
    subscribeSongIdStage,
    getSongIdStage,
    () => "idle" as const,
  );
  const pending = stage !== "idle";

  if (!settings.songIdEnabled && !editing) return null;

  const onClick = () => {
    if (pending) return;
    void identifyNowPlaying({
      provider: settings.songIdProvider,
      auddKey: settings.auddKey ?? "",
      aiKey: settings.songIdAiKey ?? "",
      aiModel: settings.songIdAiModel ?? "",
      geminiGrounding: settings.songIdGeminiGrounding ?? true,
      shazamFallbackGemini: settings.songIdShazamFallbackGemini ?? false,
      context: mediaContext,
    });
  };

  return (
    <Tooltip label={t("Identify song")}>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-label={t("Identify song")}
        className={
          className ??
          "pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15 disabled:opacity-50"
        }
      >
        {iconUrl ? (
          <img
            src={iconUrl}
            alt=""
            draggable={false}
            className={`h-[22px] w-[22px] select-none object-contain ${pending ? "animate-pulse" : ""}`}
          />
        ) : (
          <AudioLines
            size={tight ? 18 : 22}
            strokeWidth={1.9}
            className={pending ? "animate-pulse" : undefined}
          />
        )}
      </button>
    </Tooltip>
  );
}
