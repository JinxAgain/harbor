import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AuthProvider } from "@/lib/auth";
import { CompanionProfilesProvider } from "@/lib/profiles";
import { SettingsProvider } from "@/lib/settings";
import { ShellLayer } from "./player/shell-layer";
import { DragClickStage } from "./player/drag-click-stage";
import { emptySnapshot, type PlayerSnapshot } from "@/lib/player/bridge";
import { createForwardingMpvBridge } from "@/lib/player/mpv-forward";
import { buildSubtitleTimingMediaKey } from "@/lib/player/subtitle-fps";
import {
  HDR_STAGE_AUTOSYNC_DISMISS,
  HDR_STAGE_AUTOSYNC_REVERT,
  HDR_STAGE_AUTOSYNC_RUN,
  HDR_STAGE_AUTOSYNC_STOP,
  HDR_STAGE_AUTOSYNC_SUSPEND,
  HDR_STAGE_SET_SUB_DELAY,
  hdrOverlayEmitAction,
  onHdrStageProps,
  type HdrNavigationRequest,
  type HdrStageAutoSyncActionRequest,
  type HdrStageAutoSyncState,
  type HdrStageSubDelayRequest,
} from "@/lib/hdr-overlay";
import { publishAutoSync } from "@/components/player/autosync/autosync-store";
import { SubSyncBar } from "@/components/player/sub-sync-bar";
import { PlayerNavigationProvider, type PlayerNavigation, type PlayerSrc } from "@/lib/view";
import { PlayerInteractionLockControls } from "@/components/player/player-interaction-lock";
import type { AutoSyncHandle } from "./player/hooks/use-auto-sync";
import { usePlayerInteractionBlocker } from "./player/hooks/use-player-interaction-lock";

export type HdrStagePayload = {
  snap: PlayerSnapshot;
  src: PlayerSrc;
  shellId: string;
  engine: "html5" | "mpv";
  visible: boolean;
  fullscreen: boolean;
  resolvedImdbId: string | null;
  tmdbKey: string | null;
  canChangeEpisode: boolean;
  hasPrevEp: boolean;
  hasNextEp: boolean;
  pipMode: boolean;
  screenLockEnabled: boolean;
  screenLocked: boolean;
  screenLockControlsVisible: boolean;
  screenLockBinding: string;
  autoSync?: HdrStageAutoSyncState;
};

function emitDead() {
  void hdrOverlayEmitAction("hdr-stage://dead", {
    stageId: new URLSearchParams(window.location.search).get("stageId"),
  });
}

const forwardNavigation = (request: HdrNavigationRequest) =>
  void hdrOverlayEmitAction("hdr-stage://navigate", request);
const navigation: PlayerNavigation = {
  openMeta: (...args) => forwardNavigation({ action: "openMeta", args }),
  exitPlayer: (...args) => forwardNavigation({ action: "exitPlayer", args }),
  openPicker: (...args) => forwardNavigation({ action: "openPicker", args }),
  replacePlayerSrc: (...args) => forwardNavigation({ action: "replacePlayerSrc", args }),
};

class OverlayErrorBoundary extends Component<{ children: React.ReactNode }, { crashed: boolean }> {
  state = { crashed: false };
  static getDerivedStateFromError() {
    return { crashed: true };
  }
  componentDidCatch() {
    emitDead();
  }
  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

export function HdrOverlayApp() {
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
    const root = document.getElementById("root");
    if (root) root.style.background = "transparent";
    window.addEventListener("beforeunload", emitDead);
    window.addEventListener("pagehide", emitDead);
    return () => {
      window.removeEventListener("beforeunload", emitDead);
      window.removeEventListener("pagehide", emitDead);
    };
  }, []);
  return (
    <OverlayErrorBoundary>
      <CompanionProfilesProvider>
        <AuthProvider>
          <SettingsProvider>
            <PlayerNavigationProvider value={navigation}>
              <HdrOverlayChrome />
            </PlayerNavigationProvider>
          </SettingsProvider>
        </AuthProvider>
      </CompanionProfilesProvider>
    </OverlayErrorBoundary>
  );
}

function HdrOverlayChrome() {
  const [payload, setPayload] = useState<(HdrStagePayload & { stageId: string }) | null>(null);
  const bridge = useMemo(() => createForwardingMpvBridge(), []);
  const bridgeRef = useRef(bridge);
  const snapRef = useRef<PlayerSnapshot>(emptySnapshot);
  const gotPayloadRef = useRef(false);
  const toggleLock = useCallback(() => {
    const event = payload?.screenLocked ? "hdr-stage://unlock" : "hdr-stage://lock";
    void hdrOverlayEmitAction(event, {});
  }, [payload?.screenLocked]);
  const reportLockedActivity = useCallback(
    () => void hdrOverlayEmitAction("hdr-stage://activity", {}),
    [],
  );

  const currentMediaKey = payload
    ? buildSubtitleTimingMediaKey({
        sourceUrl: payload.src.url,
        mediaId: payload.src.meta.id,
        season: payload.src.episode?.season,
        episode: payload.src.episode?.episode,
      })
    : "";

  const autoSyncState = payload?.autoSync;
  const hasAutoSync = autoSyncState != null;
  const asStatus = autoSyncState?.status ?? "idle";
  const asTrigger = autoSyncState?.trigger ?? "automatic";
  const asOffsetMs = autoSyncState?.offsetMs ?? null;
  const asScale = autoSyncState?.scale ?? null;
  const asWithinTolerance = autoSyncState?.withinTolerance ?? false;
  const asCanRevert = autoSyncState?.canRevert ?? false;
  const asErrorMessage = autoSyncState?.errorMessage ?? null;
  const asErrorAction = autoSyncState?.errorAction;

  const forwardedAutoSync = useMemo<AutoSyncHandle | null>(() => {
    if (!hasAutoSync) return null;
    const actionPayload = (): HdrStageAutoSyncActionRequest => ({ mediaKey: currentMediaKey });
    return {
      status: asStatus,
      trigger: asTrigger,
      offsetMs: asOffsetMs,
      scale: asScale,
      withinTolerance: asWithinTolerance,
      canRevert: asCanRevert,
      errorMessage: asErrorMessage,
      errorAction: asErrorAction,
      run: () => void hdrOverlayEmitAction(HDR_STAGE_AUTOSYNC_RUN, actionPayload()),
      stop: () => void hdrOverlayEmitAction(HDR_STAGE_AUTOSYNC_STOP, actionPayload()),
      revert: () => void hdrOverlayEmitAction(HDR_STAGE_AUTOSYNC_REVERT, actionPayload()),
      dismiss: () => void hdrOverlayEmitAction(HDR_STAGE_AUTOSYNC_DISMISS, actionPayload()),
      suspendForManualTiming: () =>
        void hdrOverlayEmitAction(HDR_STAGE_AUTOSYNC_SUSPEND, actionPayload()),
    };
  }, [
    hasAutoSync,
    asStatus,
    asTrigger,
    asOffsetMs,
    asScale,
    asWithinTolerance,
    asCanRevert,
    asErrorMessage,
    asErrorAction,
    currentMediaKey,
  ]);

  useEffect(() => {
    publishAutoSync(forwardedAutoSync);
  }, [forwardedAutoSync]);

  useEffect(() => () => publishAutoSync(null), []);

  const handleSubDelay = useCallback(
    (sec: number) => {
      if (!currentMediaKey) return;
      const req: HdrStageSubDelayRequest = { mediaKey: currentMediaKey, sec };
      void hdrOverlayEmitAction(HDR_STAGE_SET_SUB_DELAY, req);
    },
    [currentMediaKey],
  );

  usePlayerInteractionBlocker({
    enabled: payload?.screenLockEnabled ?? false,
    locked: payload?.screenLocked ?? false,
    binding: payload?.screenLockBinding ?? "ctrl+l",
    onToggle: toggleLock,
    onLockedActivity: reportLockedActivity,
  });

  useEffect(() => {
    let cancelled = false;
    let off: (() => void) | undefined;
    let id: number | undefined;
    const stageId = new URLSearchParams(window.location.search).get("stageId");
    void onHdrStageProps<HdrStagePayload & { stageId: string }>((p) => {
      if (cancelled || p.stageId !== stageId) return;
      gotPayloadRef.current = true;
      setPayload(p);
      snapRef.current = p.snap;
      bridge.pushSnapshot(
        p.snap,
        buildSubtitleTimingMediaKey({
          sourceUrl: p.src.url,
          mediaId: p.src.meta.id,
          season: p.src.episode?.season,
          episode: p.src.episode?.episode,
        }),
      );
    })
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        off = unlisten;
        // Register before requesting: the main window may reply immediately.
        void hdrOverlayEmitAction("hdr-stage://request", {});
        let tries = 0;
        id = window.setInterval(() => {
          if (gotPayloadRef.current || tries++ > 40) {
            window.clearInterval(id);
            return;
          }
          void hdrOverlayEmitAction("hdr-stage://request", {});
        }, 150);
      })
      .catch(emitDead);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      off?.();
    };
  }, [bridge]);

  useEffect(() => {
    if (!payload?.stageId) return;
    // This effect runs after the actual shell commits. Hidden WebViews may not
    // receive animation frames, so rAF must not gate the first ready signal.
    document.getElementById("harbor-boot")?.remove();
    const root = document.getElementById("root");
    if (root) {
      root.removeAttribute("data-startup-hidden");
      root.inert = false;
    }
    const ready = () =>
      void hdrOverlayEmitAction("hdr-stage://ready", { stageId: payload.stageId });
    ready();
    const id = window.setInterval(ready, 1000);
    return () => window.clearInterval(id);
  }, [payload?.stageId]);

  useEffect(() => {
    let last = 0;
    const onMove = () => {
      const now = performance.now();
      if (now - last < 200) return;
      last = now;
      void hdrOverlayEmitAction("hdr-stage://activity", {});
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  if (!payload) return <div className="fixed inset-0" style={{ background: "transparent" }} />;
  const { snap, src } = payload;

  const act = (event: string, args: unknown = {}) => void hdrOverlayEmitAction(event, args);
  const download = {
    status: { kind: "idle" } as const,
    start: async () => {},
    cancel: () => {},
    reveal: async () => {},
    reset: () => {},
  };

  return (
    <div className="fixed inset-0 overflow-hidden" style={{ background: "transparent" }}>
      <DragClickStage
        drawMode={false}
        pipMode={payload.pipMode}
        onClick={() => act("hdr-stage://play-pause")}
        onDoubleClick={() => act("hdr-stage://fullscreen")}
      />
      <ShellLayer
        shellId={payload.shellId}
        shellSnap={snap}
        snapRef={snapRef}
        bridgeRef={bridgeRef}
        engine={payload.engine}
        visible={payload.visible}
        fullscreen={payload.fullscreen}
        drawMode={false}
        hideOthersDrawings={false}
        pipMode={payload.pipMode}
        showDraw={false}
        metaId={src.meta.id}
        onMenuOpenChange={(open) => act("hdr-stage://menu-open", { open })}
        onBack={() => act("hdr-stage://back")}
        onPlayPause={() => act("hdr-stage://play-pause")}
        onSeek={(sec) => act("hdr-stage://seek", { sec })}
        onSeekStep={(delta) => act("hdr-stage://seek-step", { delta })}
        rememberSubChoice={(t) => act("hdr-stage://remember-sub", { lang: t?.lang ?? null })}
        onSubDelay={handleSubDelay}
        onPiP={() => act("hdr-stage://pip")}
        onFullscreen={() => act("hdr-stage://fullscreen")}
        openCastMenu={() => act("hdr-stage://cast")}
        onToggleDraw={() => {}}
        onToggleHideOthers={() => {}}
        onClearDraw={() => {}}
        onScreenshot={() => act("hdr-stage://screenshot")}
        onPickAnother={() => act("hdr-stage://pick-another")}
        canPickAnother={false}
        title={src.title}
        subtitle={src.subtitle}
        hoverTitle={src.meta.name}
        hoverSub={
          src.episode
            ? `S${src.episode.imdbSeason ?? src.episode.season} · E${String(src.episode.imdbEpisode ?? src.episode.episode).padStart(2, "0")}`
            : undefined
        }
        hasPrevEp={payload.hasPrevEp}
        hasNextEp={payload.hasNextEp}
        onPrevEp={() => act("hdr-stage://prev-ep")}
        onNextEp={() => act("hdr-stage://next-ep")}
        metaImdbId={payload.resolvedImdbId}
        metaTitle={src.meta.name ?? null}
        metaReleaseDate={src.meta.releaseDate ?? null}
        meta={src.meta}
        tmdbKey={payload.tmdbKey}
        season={src.episode?.season ?? null}
        episode={src.episode?.episode ?? null}
        download={download}
        sleep={undefined}
      />
      {!payload.pipMode && (
        <SubSyncBar
          delaySec={snap.subDelaySec}
          onDelay={handleSubDelay}
          syncAvailable={snap.subtitleTracks.some((t) => t.selected)}
        />
      )}
      <PlayerInteractionLockControls
        enabled={payload.screenLockEnabled}
        locked={payload.screenLocked}
        visible={payload.screenLocked ? payload.screenLockControlsVisible : payload.visible}
        binding={payload.screenLockBinding}
        onLock={() => act("hdr-stage://lock")}
        onUnlock={() => act("hdr-stage://unlock")}
      />
    </div>
  );
}
