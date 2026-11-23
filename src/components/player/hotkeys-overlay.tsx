import { Keyboard, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import {
  effectiveBinding,
  eventToBinding,
  formatBindingForDisplay,
  groupHotkeysByScope,
} from "@/lib/hotkeys";
import { useT } from "@/lib/i18n";
import { noteOverlayDismiss } from "@/lib/player/overlay-dismiss";
import { useSettings } from "@/lib/settings";

/**
 * In-player keyboard shortcuts reference modal toggled by the `playerHotkeysHelp` hotkey (`?`).
 * Reads effective bindings from settings so customized shortcuts are reflected live.
 */
export function PlayerHotkeysOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { settings } = useSettings();
  const overrides = settings.hotkeys ?? {};
  const groups = useMemo(() => groupHotkeysByScope("Player"), []);
  const helpKeyDisplay = formatBindingForDisplay(effectiveBinding("playerHotkeysHelp", overrides));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const binding = eventToBinding(e);
      if (e.key === "Escape" || binding === effectiveBinding("playerClose", overrides)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose, overrides]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("Keyboard shortcuts")}
      data-harbor-glass="scrim"
      className="absolute inset-0 z-[105] flex cursor-default items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onClick={() => {
        noteOverlayDismiss();
        onClose();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        data-harbor-glass="modal"
        data-player-glass="panel"
        className="flex max-h-[82vh] w-[min(92vw,920px)] flex-col overflow-hidden rounded-2xl border border-edge bg-surface/95 text-ink shadow-2xl backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 border-b border-edge-soft px-6 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-edge-soft bg-elevated text-ink">
              <Keyboard size={18} strokeWidth={2.1} />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-[18px] font-bold leading-tight text-ink">
                {t("Keyboard shortcuts")}
              </h2>
              <p className="mt-0.5 truncate text-[13px] text-ink-muted">
                {t("Press {key} or Esc to close", { key: helpKeyDisplay })}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("Close keyboard shortcuts")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-edge-soft bg-elevated text-ink-muted transition-colors hover:bg-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={18} strokeWidth={2.2} />
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
            {groups.map(({ group, items }) => (
              <section key={group} className="min-w-0">
                <h3 className="mb-2.5 text-[11.5px] font-bold uppercase tracking-[0.14em] text-ink-subtle">
                  {t(group)}
                </h3>
                <div className="divide-y divide-edge-soft/70 rounded-xl border border-edge-soft bg-elevated/45">
                  {items.map((def) => {
                    const binding = effectiveBinding(def.id, overrides);
                    const isCustom = def.id in overrides;
                    return (
                      <div
                        key={def.id}
                        title={t(def.description)}
                        className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[14px] font-medium text-ink">
                            {t(def.label)}
                          </span>
                          {isCustom && (
                            <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-accent-soft px-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-accent">
                              {t("Custom")}
                            </span>
                          )}
                        </div>
                        <kbd
                          className={`inline-flex h-7 min-w-[36px] shrink-0 items-center justify-center whitespace-nowrap rounded-lg border px-2.5 font-sans text-[12.5px] font-semibold ${
                            isCustom
                              ? "border-accent/50 bg-accent-soft text-accent"
                              : "border-edge-soft bg-elevated text-ink"
                          }`}
                        >
                          {formatBindingForDisplay(binding)}
                        </kbd>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
