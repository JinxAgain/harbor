import { Play } from "lucide-react";
import { useSettings } from "@/lib/settings";
import { useKnobAnim } from "@/lib/knob-anim";
import { useT } from "@/lib/i18n";

export function GuestControlToggle() {
  const { settings, update } = useSettings();
  const t = useT();
  const on = settings.togetherGuestsControl;
  const knob = useKnobAnim(on);
  return (
    <button
      onClick={() => update({ togetherGuestsControl: !on })}
      className="flex h-12 items-center justify-between gap-2 rounded-lg border border-edge px-3 text-[12.5px] text-ink-muted transition-colors hover:bg-elevated hover:text-ink"
      aria-pressed={on}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Play size={13} strokeWidth={1.9} className="shrink-0" />
        <span className="flex min-w-0 flex-col text-start">
          <span className="truncate">{t("Guests can play & pause")}</span>
          <span className="truncate text-[10.5px] text-ink-subtle">
            {t("Allow everyone in the room to start, pause, and seek")}
          </span>
        </span>
      </span>
      <span
        aria-hidden
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          on ? "bg-accent" : "bg-edge"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-white shadow-sm ${
            on ? "translate-x-4 rtl:-translate-x-4" : "translate-x-0"
          } ${knob}`}
        />
      </span>
    </button>
  );
}
