import { useEffect, useRef, useState } from "react";
import { PenCursor } from "./pen-cursor";

export type Stroke = {
  id: string;
  authorId: string;
  authorName: string;
  color: string;
  points: { x: number; y: number }[];
  bornAt: number;
  path?: string;
};

const STROKE_LIFETIME_MS = 9000;
const MIN_POINT_DIST_SQ = 0.004 * 0.004;

type Box = { left: number; top: number; width: number; height: number };

export type VideoTransform = { panscan?: number; zoom?: number; stretch?: boolean };

export function videoContentBox(
  boxW: number,
  boxH: number,
  videoW: number,
  videoH: number,
  transform?: VideoTransform,
): Box {
  const whole = { left: 0, top: 0, width: boxW, height: boxH };
  if (boxW <= 0 || boxH <= 0) return whole;
  if (videoW <= 0 || videoH <= 0) return whole;
  if (transform?.stretch) return whole;

  const scale = Math.min(boxW / videoW, boxH / videoH);
  let w = videoW * scale;
  let h = videoH * scale;

  const panscan = Math.max(0, Math.min(1, transform?.panscan ?? 0));
  if (panscan > 0) {
    let area = boxH - h;
    let fw = h > 0 ? w / h : 1;
    let fh = 1;
    if (Math.round(area) === 0) {
      area = boxW - w;
      fw = 1;
      fh = w > 0 ? h / w : 1;
    }
    w += area * panscan * fw;
    h += area * panscan * fh;
  }

  const zoom = transform?.zoom ?? 0;
  if (zoom !== 0) {
    const factor = Math.pow(2, zoom);
    w *= factor;
    h *= factor;
  }

  return { left: (boxW - w) / 2, top: (boxH - h) / 2, width: w, height: h };
}

export function StrokesLayer({
  strokes,
  hideOthers,
  selfId,
  videoWidth = 0,
  videoHeight = 0,
  transform,
}: {
  strokes: Stroke[];
  hideOthers: boolean;
  selfId: string;
  videoWidth?: number;
  videoHeight?: number;
  transform?: VideoTransform;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const box = useContentBox(hostRef, videoWidth, videoHeight, transform);
  const visibleStrokes = hideOthers ? strokes.filter((s) => s.authorId === selfId) : strokes;
  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0" style={{ zIndex: 15 }}>
      {visibleStrokes.length > 0 && (
        <div
          className="absolute"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
        >
          <StrokesSvg strokes={visibleStrokes} />
        </div>
      )}
    </div>
  );
}

function useContentBox(
  ref: React.RefObject<HTMLDivElement | null>,
  videoWidth: number,
  videoHeight: number,
  transform?: VideoTransform,
): Box {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return videoContentBox(size.w, size.h, videoWidth, videoHeight, transform);
}

export function DrawCanvas({
  enabled,
  selfId,
  selfName,
  selfColor,
  hideOthers,
  strokes,
  videoWidth = 0,
  videoHeight = 0,
  transform,
  onStrokeStart,
  onStrokePoint,
  onStrokeEnd,
}: {
  enabled: boolean;
  selfId: string;
  selfName: string;
  selfColor: string;
  hideOthers: boolean;
  strokes: Stroke[];
  videoWidth?: number;
  videoHeight?: number;
  transform?: VideoTransform;
  onStrokeStart: (stroke: Stroke) => void;
  onStrokePoint: (id: string, x: number, y: number) => void;
  onStrokeEnd: (id: string) => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const penRef = useRef<HTMLDivElement>(null);
  const rectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null);
  const drawing = useRef<{ id: string; lastX: number; lastY: number } | null>(null);
  const pendingPointRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const rafIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const el = surfaceRef.current;
    if (!el) return;
    const updateRect = () => {
      const r = el.getBoundingClientRect();
      rectRef.current = { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    updateRect();
    const ro = new ResizeObserver(updateRect);
    ro.observe(el);
    window.addEventListener("resize", updateRect);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", updateRect);
    };
  }, [enabled]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current != null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  if (!enabled) return null;

  const norm = (clientX: number, clientY: number) => {
    let r = rectRef.current;
    if (!r || r.width === 0 || r.height === 0) {
      const domRect = surfaceRef.current?.getBoundingClientRect();
      if (!domRect || domRect.width === 0 || domRect.height === 0) return { x: 0, y: 0 };
      r = { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height };
      rectRef.current = r;
    }
    const box = videoContentBox(r.width, r.height, videoWidth, videoHeight, transform);
    if (box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: (clientX - r.left - box.left) / box.width,
      y: (clientY - r.top - box.top) / box.height,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    try {
      surfaceRef.current?.setPointerCapture(e.pointerId);
    } catch {
      /* unsupported */
    }
    const domRect = surfaceRef.current?.getBoundingClientRect();
    if (domRect) {
      rectRef.current = { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height };
    }
    const { x, y } = norm(e.clientX, e.clientY);
    const id = `${selfId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    drawing.current = { id, lastX: x, lastY: y };
    if (penRef.current && rectRef.current) {
      const px = e.clientX - rectRef.current.left;
      const py = e.clientY - rectRef.current.top;
      penRef.current.style.display = "block";
      penRef.current.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-70%, -77%)`;
    }
    onStrokeStart({
      id,
      authorId: selfId,
      authorName: selfName,
      color: selfColor,
      points: [{ x, y }],
      bornAt: Date.now(),
    });
  };

  const onMove = (e: React.PointerEvent) => {
    let r = rectRef.current;
    if (!r) {
      const domRect = surfaceRef.current?.getBoundingClientRect();
      if (domRect) {
        r = { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height };
        rectRef.current = r;
      }
    }
    if (r && penRef.current) {
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      penRef.current.style.display = "block";
      penRef.current.style.transform = `translate3d(${px}px, ${py}px, 0) translate(-70%, -77%)`;
    }
    const cur = drawing.current;
    if (!cur) return;
    const { x, y } = norm(e.clientX, e.clientY);
    const dx = x - cur.lastX;
    const dy = y - cur.lastY;
    if (dx * dx + dy * dy < MIN_POINT_DIST_SQ) return;
    cur.lastX = x;
    cur.lastY = y;

    // Throttle point emission to requestAnimationFrame
    pendingPointRef.current = { id: cur.id, x, y };
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (pendingPointRef.current) {
          onStrokePoint(pendingPointRef.current.id, pendingPointRef.current.x, pendingPointRef.current.y);
          pendingPointRef.current = null;
        }
      });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    const cur = drawing.current;
    if (cur) {
      const { x, y } = norm(e.clientX, e.clientY);
      if (x !== cur.lastX || y !== cur.lastY || pendingPointRef.current != null) {
        onStrokePoint(cur.id, x, y);
      }
      pendingPointRef.current = null;
      onStrokeEnd(cur.id);
      drawing.current = null;
    }
    try {
      surfaceRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* unsupported */
    }
  };

  const onLeave = () => {
    if (penRef.current) {
      penRef.current.style.display = "none";
    }
  };

  void strokes;
  void hideOthers;
  void selfId;

  return (
    <div
      ref={surfaceRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={onLeave}
      className="pointer-events-auto absolute inset-0 z-20"
      style={{ cursor: "none", touchAction: "none" }}
    >
      <div
        ref={penRef}
        className="pointer-events-none absolute"
        style={{
          display: "none",
          left: 0,
          top: 0,
          willChange: "transform",
        }}
      >
        <PenCursor tint={selfColor} size={40} />
      </div>
    </div>
  );
}

function StrokesSvg({ strokes }: { strokes: Stroke[] }) {
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1 1" preserveAspectRatio="none">
      {strokes.map((s) => {
        if (s.points.length < 2) return null;
        const d = strokePath(s.points);
        return (
          <path
            key={s.id}
            d={d}
            stroke={s.color}
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            vectorEffect="non-scaling-stroke"
            style={{
              willChange: "opacity",
              animation: `harbor-stroke-fade ${STROKE_LIFETIME_MS}ms cubic-bezier(0.32, 0.72, 0.24, 1) forwards`,
            }}
          />
        );
      })}
    </svg>
  );
}

function strokePath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length; i++) d += ` L ${points[i].x} ${points[i].y}`;
  return d;
}
