import { invoke } from "@tauri-apps/api/core";

export type StreamProbeReason =
  | "ready"
  | "archive_restoring"
  | "http_error"
  | "truncated"
  | "no_response";

export type StreamProbeResult = {
  status: number;
  host: string;
  viaHost: string | null;
  reason: StreamProbeReason;
  retryAfterSec: number | null;
  detail: string | null;
};

export async function probeStreamStatus(
  url: string,
  headers?: Record<string, string>,
): Promise<StreamProbeResult | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  try {
    return await invoke<StreamProbeResult>("probe_stream_status", {
      args: { url, headers: headers ?? null },
    });
  } catch {
    return null;
  }
}
