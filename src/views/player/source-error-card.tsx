import { CloudDownload, ListVideo, Loader2, RotateCcw, ServerCrash, WifiOff } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { SourceError } from "./hooks/use-auto-retry";

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  410: "Gone",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

type ErrorTone = "error" | "offline" | "archive" | "checking";

function describe(error: SourceError): { title: string; detail: string; tone: ErrorTone } {
  const status = error.status;
  if (error.exhausted)
    return {
      title: "Harbor couldn't start any source",
      detail:
        "Every source Harbor tried failed to start. Pick a different one, or try again in a moment.",
      tone: "error",
    };
  if (error.reason === "archive_restoring")
    return {
      title: "Cloud file is waking up",
      detail:
        "This file hasn't been accessed for a while and the cloud drive is restoring it from archive storage. This usually takes 1–3 minutes.",
      tone: "archive",
    };
  if (error.probing && status === 0)
    return {
      title: "Checking source…",
      detail: "Checking why this stream couldn't start.",
      tone: "checking",
    };
  if (error.reason === "truncated")
    return {
      title: "Stream ended unexpectedly",
      detail:
        "The server accepted the request but closed the connection before sending video data. Retry or choose another source.",
      tone: "error",
    };
  if (status === 0)
    return {
      title: "This source didn't respond",
      detail:
        "The provider's server could not be reached. It may be offline, or you have no connection.",
      tone: "offline",
    };
  if (status >= 500)
    return {
      title: "This source is down",
      detail:
        "The provider's server returned an error. Nothing on Harbor's side can fix this. Pick another source.",
      tone: "error",
    };
  if (status >= 400)
    return {
      title: "This source rejected the stream",
      detail:
        "The provider refused the request. The link is likely expired, region locked, or out of quota.",
      tone: "error",
    };
  return {
    title: "Harbor couldn't play this source",
    detail: "The source responded but the stream would not open. Try a different one.",
    tone: "error",
  };
}

export function SourceErrorCard({
  error,
  onChoose,
  onRetry,
}: {
  error: SourceError;
  onChoose: () => void;
  onRetry: () => void;
}) {
  const t = useT();
  const info = describe(error);
  const isArchive = info.tone === "archive";
  const isChecking = info.tone === "checking";
  const statusName = STATUS_TEXT[error.status];

  let codeLabel: string;
  if (isArchive) {
    codeLabel = t("Archive · Restoring");
  } else if (isChecking) {
    codeLabel = t("Checking…");
  } else if (error.reason === "truncated") {
    codeLabel =
      error.status > 0 ? `HTTP ${error.status} · ${t("Empty stream")}` : t("Empty stream");
  } else {
    codeLabel = error.status === 0 ? t("No response") : `HTTP ${error.status}`;
  }

  const badgeClass = isArchive
    ? "bg-amber-500/14 text-amber-300"
    : isChecking
      ? "bg-white/10 text-ink-muted"
      : "bg-rose-500/12 text-rose-300";

  const codeTextClass = isArchive
    ? "text-amber-300"
    : isChecking
      ? "text-ink-muted"
      : "text-rose-300";

  const hostLine =
    error.viaHost && error.viaHost !== error.host
      ? `${error.host} · ${t("via {host}", { host: error.viaHost })}`
      : error.host;

  return (
    <div
      data-harbor-glass="scrim"
      className="animate-fade-in absolute inset-0 z-[90] flex items-center justify-center bg-canvas/85 p-6 backdrop-blur-md"
    >
      <div
        data-harbor-glass="modal"
        data-player-glass="panel"
        className="animate-modal-in flex w-[min(94vw,440px)] flex-col items-center gap-5 rounded-2xl border border-edge-soft bg-elevated/95 px-7 py-8 text-center shadow-[0_30px_90px_-25px_rgba(0,0,0,0.7)]"
      >
        <div className={`flex h-14 w-14 items-center justify-center rounded-full ${badgeClass}`}>
          {isArchive ? (
            <CloudDownload size={26} strokeWidth={2} />
          ) : isChecking ? (
            <Loader2 size={26} strokeWidth={2} className="animate-spin" />
          ) : info.tone === "offline" ? (
            <WifiOff size={26} strokeWidth={2} />
          ) : (
            <ServerCrash size={26} strokeWidth={2} />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="font-display text-[20px] font-medium text-ink">{t(info.title)}</h2>
          <p className="text-[13.5px] leading-relaxed text-ink-muted">{t(info.detail)}</p>
        </div>
        {(!error.exhausted || !!error.host) && (
          <div className="flex w-full flex-col gap-1.5 rounded-xl border border-edge-soft bg-canvas/50 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-subtle">
                {error.exhausted
                  ? t("Last source tried")
                  : isArchive
                    ? t("Cloud status")
                    : t("Source said")}
              </span>
              {!error.exhausted && (
                <span className={`font-mono text-[13px] font-semibold ${codeTextClass}`}>
                  {codeLabel}
                  {!isArchive && !isChecking && error.reason !== "truncated" && statusName
                    ? ` ${statusName}`
                    : ""}
                </span>
              )}
            </div>
            {hostLine && (
              <div className="truncate text-start font-mono text-[11.5px] text-ink-subtle">
                {hostLine}
              </div>
            )}
            {error.detail && !isArchive && (
              <div className="line-clamp-2 text-start text-[11.5px] leading-snug text-ink-muted">
                {error.detail}
              </div>
            )}
            {isArchive && error.autoRetryInSec != null && (
              <div className="flex items-center gap-2 pt-0.5 text-start text-[12px] font-medium text-amber-300/90">
                <Loader2 size={13} className="shrink-0 animate-spin text-amber-300" />
                <span>
                  {error.autoRetryInSec > 0
                    ? t("Auto-retrying in {seconds}s…", { seconds: error.autoRetryInSec })
                    : t("Checking if file is ready…")}
                </span>
              </div>
            )}
          </div>
        )}
        <div className="flex w-full items-center gap-2.5">
          <button
            type="button"
            onClick={onRetry}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-edge-soft text-[14px] font-semibold text-ink-muted transition-colors hover:border-edge hover:text-ink"
          >
            <RotateCcw size={16} strokeWidth={2.2} />
            {isArchive ? t("Retry now") : t("Retry")}
          </button>
          <button
            type="button"
            onClick={onChoose}
            className="flex h-11 flex-[1.4] items-center justify-center gap-2 rounded-xl bg-accent text-[14px] font-semibold text-canvas transition-opacity hover:opacity-90"
          >
            <ListVideo size={17} strokeWidth={2.2} />
            {t("Choose another source")}
          </button>
        </div>
      </div>
    </div>
  );
}
