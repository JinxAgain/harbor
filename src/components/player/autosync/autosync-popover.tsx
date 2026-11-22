import { Check, Loader2, RotateCcw, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { openSyncBar } from "@/lib/player/sub-sync";
import { formatSyncShift } from "@/lib/subtitles/autosync/embedded-sync";
import type { AutoSyncHandle } from "@/views/player/hooks/use-auto-sync";

function dwellMsFor(handle: AutoSyncHandle): number | null {
  switch (handle.status) {
    case "synced":
      return 5500;
    case "within-tolerance":
      return 4000;
    case "no-fit":
    case "no-embedded":
    case "error":
      return 7000;
    default:
      return null;
  }
}

function shouldShowPopover(handle: AutoSyncHandle): boolean {
  if (handle.trigger === "automatic") {
    return handle.status === "synced" || handle.status === "no-fit";
  }
  return (
    handle.status === "analyzing" ||
    handle.status === "synced" ||
    handle.status === "within-tolerance" ||
    handle.status === "no-fit" ||
    handle.status === "no-embedded" ||
    handle.status === "error"
  );
}

export function AutosyncPopover({ handle }: { handle: AutoSyncHandle }) {
  const tr = useT();
  const [dismissed, setDismissed] = useState(false);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [handle.status, handle.trigger, handle.offsetMs]);

  useEffect(() => {
    if (!shouldShowPopover(handle)) return;
    const ms = dwellMsFor(handle);
    if (ms == null || held) return;
    const id = window.setTimeout(() => {
      setDismissed(true);
      handle.dismiss();
    }, ms);
    return () => window.clearTimeout(id);
  }, [handle, held]);

  if (dismissed || !shouldShowPopover(handle)) return null;

  const dismissNow = () => {
    setDismissed(true);
    handle.dismiss();
  };

  const shiftLabel = handle.offsetMs != null ? formatSyncShift(handle.offsetMs) : "";

  return (
    <div
      role="status"
      aria-live="polite"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      className="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-6 pt-[68px] animate-in fade-in slide-in-from-top-2 duration-200"
    >
      <div
        data-harbor-glass="modal"
        data-glass-tier="enhanced"
        data-player-glass="panel"
        className="pointer-events-auto flex items-center gap-2.5 rounded-full bg-elevated px-3.5 py-1.5 text-[12.5px] font-medium text-ink shadow-[0_10px_30px_-12px_rgba(0,0,0,0.65)]"
      >
        {handle.status === "analyzing" && (
          <>
            <Loader2
              size={14}
              strokeWidth={2.4}
              className="animate-spin text-accent motion-reduce:animate-none"
            />
            <span>{tr("Syncing subtitles…")}</span>
            <button
              type="button"
              onClick={() => handle.stop()}
              className="rounded-full px-2 py-0.5 text-[12px] font-semibold text-ink-muted transition-colors hover:bg-raised hover:text-ink"
            >
              {tr("Cancel")}
            </button>
          </>
        )}

        {handle.status === "synced" && (
          <>
            <Check size={14} strokeWidth={2.6} className="text-accent" />
            <span>
              {shiftLabel && shiftLabel !== "0s"
                ? tr("Subtitles synced ({shift})", { shift: shiftLabel })
                : tr("Subtitles synced")}
            </span>
            {handle.canRevert && (
              <button
                type="button"
                onClick={() => {
                  handle.revert();
                  setDismissed(true);
                }}
                className="inline-flex items-center gap-1 rounded-full bg-raised px-2.5 py-0.5 text-[12px] font-semibold text-ink transition-colors hover:bg-surface-hover"
              >
                <RotateCcw size={12} strokeWidth={2.3} />
                {tr("Undo")}
              </button>
            )}
          </>
        )}

        {handle.status === "within-tolerance" && (
          <>
            <Check size={14} strokeWidth={2.6} className="text-accent" />
            <span>{tr("Subtitles already in sync")}</span>
          </>
        )}

        {(handle.status === "no-fit" ||
          handle.status === "no-embedded" ||
          handle.status === "error") && (
          <>
            <span>
              {handle.status === "no-embedded"
                ? tr("No embedded subtitle reference found")
                : handle.status === "error"
                  ? tr("Auto-sync failed")
                  : tr("Could not auto-sync subtitles")}
            </span>
            {handle.status === "error" && (
              <button
                type="button"
                onClick={() => handle.run()}
                className="inline-flex items-center gap-1 rounded-full bg-raised px-2.5 py-0.5 text-[12px] font-semibold text-ink transition-colors hover:bg-surface-hover"
              >
                <RotateCcw size={12} strokeWidth={2.3} />
                {tr("Retry")}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                dismissNow();
                openSyncBar();
              }}
              className="inline-flex items-center gap-1 rounded-full bg-raised px-2.5 py-0.5 text-[12px] font-semibold text-ink transition-colors hover:bg-surface-hover"
            >
              <SlidersHorizontal size={12} strokeWidth={2.2} />
              {tr("Sync manually")}
            </button>
          </>
        )}

        {handle.status !== "analyzing" && (
          <button
            type="button"
            onClick={dismissNow}
            aria-label={tr("Dismiss")}
            className="ms-0.5 rounded-full p-0.5 text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <X size={13} strokeWidth={2.4} />
          </button>
        )}
      </div>
    </div>
  );
}
