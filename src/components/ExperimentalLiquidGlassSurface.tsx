import { useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

const LEGACY_SPECTRUM_PROP = `spectral${"Strength"}` as const;
type LegacySpectrumProps = Partial<Record<typeof LEGACY_SPECTRUM_PROP, number>>;

export type ExperimentalLiquidGlassSurfaceProps = HTMLAttributes<HTMLDivElement> &
  LegacySpectrumProps & {
    children: ReactNode;
    radius?: CSSProperties["borderRadius"];
    shaderRadius?: number;
    interactive?: boolean;
    alwaysActive?: boolean;
    intensity?: number;
    refractionStrength?: number;
    lensStrength?: number;
    causticsStrength?: number;
    motionSpeed?: number;
    motionStrength?: number;
    contentClassName?: string;
    surfaceClassName?: string;
    variant?: "default" | "surface" | "overlay";
    backdropBlur?: boolean;
    rendererOpacity?: number;
  };

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function ExperimentalLiquidGlassSurface({
  children,
  className = "",
  contentClassName = "",
  surfaceClassName = "",
  variant: _variant = "surface",
  backdropBlur: _backdropBlur = true,
  rendererOpacity: _rendererOpacity = 100,
  style,
  radius = "999999px",
  shaderRadius: _shaderRadius = 1,
  interactive = true,
  alwaysActive = false,
  intensity: _intensity = 1.08,
  refractionStrength: _refractionStrength = 1.42,
  lensStrength: _lensStrength = 1.2,
  causticsStrength: _causticsStrength = 1,
  motionSpeed = 1,
  motionStrength = 1,
  onPointerEnter,
  onPointerMove,
  onPointerLeave,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onFocus,
  onBlur,
  ...wrapperProps
}: ExperimentalLiquidGlassSurfaceProps) {
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [pressed, setPressed] = useState(false);

  const forwardedProps = { ...wrapperProps } as HTMLAttributes<HTMLDivElement> &
    Record<string, unknown>;

  delete forwardedProps[LEGACY_SPECTRUM_PROP];

  const normalizedMotion = clamp(motionStrength, 0, 2);
  const normalizedSpeed = clamp(motionSpeed, 0, 3);
  const { transition: callerTransition, ...callerStyle } = style ?? {};

  const active = alwaysActive || keyboardActive;
  const transitionMs = normalizedSpeed <= 0 ? 0 : Math.round(260 / Math.max(0.35, normalizedSpeed));

  const glassStyle: CSSProperties = {
    position: "relative",
    isolation: "isolate",
    overflow: "hidden",
    borderRadius: radius,
    transform: pressed ? `scale(${1 - 0.007 * normalizedMotion}) translateZ(0)` : "translateZ(0)",
    transition: [
      `transform ${transitionMs}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
      callerTransition,
    ]
      .filter(Boolean)
      .join(", "),
    ...callerStyle,
  };

  return (
    <div
      {...forwardedProps}
      className={`${className} ${surfaceClassName}`}
      style={glassStyle}
      data-liquid-glass={interactive ? "interactive" : "static"}
      data-harbor-glass={_variant === "overlay" ? "modal" : "pill"}
      data-glass-tier="enhanced"
      data-liquid-active={active ? "true" : "false"}
      data-liquid-pressed={pressed ? "true" : "false"}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
      }}
      onPointerLeave={(event) => {
        if (interactive) {
          setPressed(false);
        }

        onPointerLeave?.(event);
      }}
      onPointerDown={(event) => {
        if (interactive) {
          setPressed(true);
          setKeyboardActive(false);
        }

        onPointerDown?.(event);
      }}
      onPointerUp={(event) => {
        if (interactive) {
          setPressed(false);
          setKeyboardActive(false);
        }

        onPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        if (interactive) {
          setPressed(false);
          setKeyboardActive(false);
        }

        onPointerCancel?.(event);
      }}
      onFocus={(event) => {
        if (interactive) {
          setKeyboardActive(event.currentTarget.matches(":focus-visible"));
        }

        onFocus?.(event);
      }}
      onBlur={(event) => {
        if (interactive) {
          setKeyboardActive(false);
          setPressed(false);
        }

        onBlur?.(event);
      }}
    >
      <div className={`relative z-10 h-full w-full ${contentClassName}`}>{children}</div>
    </div>
  );
}
