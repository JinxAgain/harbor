import { useSyncExternalStore } from "react";
import { AudioLines } from "lucide-react";
import { useSettings } from "@/lib/settings";
import {
  cancelSongIdentification,
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
    if (pending) {
      cancelSongIdentification();
      return;
    }
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

  const actionLabel = pending ? t("Cancel song identification") : t("Identify song");

  return (
    <Tooltip label={actionLabel}>
      <button
        type="button"
        onClick={onClick}
        aria-label={actionLabel}
        className={
          className ??
          "pointer-events-auto inline-flex h-11 w-11 items-center justify-center rounded-full text-white/90 transition hover:bg-white/15"
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
