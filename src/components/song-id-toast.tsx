import { useCallback, useEffect, useRef, useState } from "react";
import { SongIdCard, type SongCardStyle } from "./song-id-card";
import { useT } from "@/lib/i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useSettings } from "@/lib/settings";
import type { SongCardPosition } from "@/lib/settings/types";
import {
  cancelSongIdentification,
  isSafeHttpsUrl,
  onSongIdToast,
  type SongIdToastMsg,
} from "@/lib/song-id";

const POSITION_LAYOUT: Record<SongCardPosition, { wrap: string; origin: string }> = {
  "top-center": {
    wrap: "left-1/2 top-8 -translate-x-1/2 items-center",
    origin: "origin-top",
  },
  "bottom-left": {
    wrap: "bottom-24 left-7 items-start",
    origin: "origin-bottom-left",
  },
  "bottom-right": {
    wrap: "bottom-24 right-7 items-end",
    origin: "origin-bottom-right",
  },
};

export function SongIdToast() {
  const t = useT();
  const { settings } = useSettings();
  const style = (settings.songCardStyle ?? "cinematic") as SongCardStyle;
  const position = (settings.songCardPosition ?? "top-center") as SongCardPosition;
  const showDetails = settings.songCardDetails ?? true;

  const [msg, setMsg] = useState<SongIdToastMsg | null>(null);
  const [enter, setEnter] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const off = onSongIdToast((next) => {
      setMsg(next);
      if (timer.current) {
        window.clearTimeout(timer.current);
        timer.current = undefined;
      }
      if (next && next.kind !== "info") {
        const delayMs = next.kind === "error" ? 6000 : 10000;
        timer.current = window.setTimeout(() => setMsg(null), delayMs);
      }
    });
    return () => {
      off();
      if (timer.current) window.clearTimeout(timer.current);
      cancelSongIdentification();
    };
  }, []);

  useEffect(() => {
    if (!msg) {
      setEnter(false);
      return;
    }
    setEnter(false);
    const id = requestAnimationFrame(() => setEnter(true));
    return () => cancelAnimationFrame(id);
  }, [msg]);

  const dismiss = useCallback(() => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
    setMsg(null);
    cancelSongIdentification();
  }, []);

  const visible = Boolean(msg && settings.songIdEnabled);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"][aria-modal="true"], [data-dropdown-menu]')) {
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      dismiss();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, dismiss]);

  if (!visible || !msg) return null;

  const safeHref = isSafeHttpsUrl(msg.href);
  const open = safeHref
    ? () => {
        openUrl(safeHref).catch((e) => console.error("open failed", e));
      }
    : undefined;

  const layout = POSITION_LAYOUT[position] ?? POSITION_LAYOUT["top-center"];

  const anim = [
    "pointer-events-auto transition-all duration-500 ease-out motion-reduce:transition-none",
    layout.origin,
    enter ? "scale-100 opacity-100" : "scale-90 opacity-0",
    msg.kind === "result" ? "hover:ring-white/25" : "",
  ].join(" ");

  return (
    <div
      className={`pointer-events-none absolute z-30 flex flex-col gap-3 ${layout.wrap}`}
    >
      <span
        data-harbor-glass="pill"
        data-player-glass="pill"
        className="rounded-full bg-black/70 px-4 py-1.5 text-sm font-semibold text-white/90 shadow-lg backdrop-blur"
      >
        ▶ {t("Now Playing")}
      </span>
      <SongIdCard
        message={msg}
        style={style}
        showDetails={showDetails}
        onOpen={open}
        onClose={dismiss}
        className={anim}
      />
    </div>
  );
}
