import { useEffect, useRef } from "react";
import type { Meta } from "@/lib/cinemeta";
import type { RoomSnapshot } from "@/lib/together/client";
import type { PlayInvite, SourceDescriptor } from "@/lib/together/protocol";
import { buildPlayInvite } from "@/lib/together/build-invite";
import { hostSourceMatchesMedia, type HostSourceInfo } from "@/lib/together/room-derive";
import type { PlayEpisode } from "@/lib/view";

export function useRoomInvite(params: {
  meta: Meta;
  episode?: PlayEpisode;
  inSession: boolean;
  roomSnapshot: RoomSnapshot;
  clientId: string;
  hostSource: HostSourceInfo | null;
  lastInviteProto: number;
  roomGuestPick?: boolean;
  roomGuestControl?: boolean;
  wasInvitedTo: (key: string) => boolean;
  claimHost: (fresh: boolean) => void;
  sendInvite: (invite: PlayInvite) => void;
}): {
  inviteKey: string;
  canInvite: boolean;
  inviteSentRef: React.MutableRefObject<string | null>;
  hostSourceForMedia: SourceDescriptor | null;
  expectHostSource: boolean;
} {
  const {
    meta,
    episode,
    inSession,
    roomSnapshot,
    clientId,
    hostSource,
    lastInviteProto,
    roomGuestPick,
    roomGuestControl,
    wasInvitedTo,
    claimHost,
    sendInvite,
  } = params;

  const inviteKey = `${meta.id}|${episode?.season ?? ""}|${episode?.episode ?? ""}`;
  const foreignHost = !!roomSnapshot.hostClientId && roomSnapshot.hostClientId !== clientId;
  const invited = wasInvitedTo(inviteKey);
  const canInvite = inSession && !invited && (!foreignHost || roomGuestControl === true);
  const inviteSentRef = useRef<string | null>(null);
  const hostClaimedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!inSession) return;
    // If we are the host following a guest's episode invite, reset room readiness via claimHost(true)
    if (!foreignHost && invited && hostClaimedRef.current !== inviteKey) {
      hostClaimedRef.current = inviteKey;
      claimHost(true);
      return;
    }
    if (!canInvite) return;
    if (inviteSentRef.current === inviteKey) return;
    inviteSentRef.current = inviteKey;
    if (!foreignHost) {
      hostClaimedRef.current = inviteKey;
      claimHost(true);
    }
    sendInvite(buildPlayInvite(meta, episode));
  }, [inSession, canInvite, invited, foreignHost, inviteKey, sendInvite, claimHost, meta, episode]);

  const isRoomGuest = inSession && foreignHost;
  const hostSourceForMedia =
    isRoomGuest && !roomGuestPick && hostSourceMatchesMedia(hostSource, meta.id, episode ?? null)
      ? hostSource!.descriptor
      : null;
  const expectHostSource =
    isRoomGuest && !roomGuestPick && (hostSourceForMedia != null || (wasInvitedTo(inviteKey) && lastInviteProto >= 2));

  return { inviteKey, canInvite, inviteSentRef, hostSourceForMedia, expectHostSource };
}
