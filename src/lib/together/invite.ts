import { normalizeRoomCode } from "./protocol";
import { HARBOR_RELAY_BASE } from "@/lib/config/endpoints";

const RELAY_PARAM = "harbor-relay";
const ROOM_PARAM = "harbor-room";

export type ParsedInvite = {
  relayUrl: string;
  roomCode: string;
};

export const WEB_JOIN_BASE = HARBOR_RELAY_BASE;

export function buildInviteUrl(relayUrl: string, roomCode: string, origin?: string): string {
  const local =
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)
      ? window.location.origin
      : WEB_JOIN_BASE;
  const base = origin ?? local;
  const params = new URLSearchParams();
  params.set(RELAY_PARAM, relayUrl);
  params.set(ROOM_PARAM, roomCode.toUpperCase());
  return `${base}/?${params.toString()}`;
}

export function isValidRelayUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    const isDev = typeof import.meta !== "undefined" && Boolean((import.meta as any).env?.DEV);
    if (parsed.protocol === "ws:") {
      return isDev && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
    }
    if (parsed.protocol !== "wss:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local") ||
      host.endsWith(".internal")
    ) {
      return isDev;
    }
    if (
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host) ||
      /^169\.254\./.test(host)
    ) {
      return isDev;
    }
    return true;
  } catch {
    return false;
  }
}

export function parseInviteFromLocation(): ParsedInvite | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const relay = params.get(RELAY_PARAM)?.trim();
  const roomRaw = params.get(ROOM_PARAM)?.trim();
  if (!relay || !roomRaw) return null;
  const room = normalizeRoomCode(roomRaw);
  if (!room) return null;
  if (!isValidRelayUrl(relay)) return null;
  return { relayUrl: relay, roomCode: room };
}

export function clearInviteParams(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete(RELAY_PARAM);
  url.searchParams.delete(ROOM_PARAM);
  window.history.replaceState(null, "", url.toString());
}
