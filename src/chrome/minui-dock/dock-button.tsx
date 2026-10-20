import { useState, type ReactNode } from "react";

export function DockButton({
  label,
  active,
  scale,
  baseSize,
  onClick,
  hideIndicator,
  hovered = false,
  showTooltip = false,
  onHover,
  onFocusChange,
  children,
}: {
  label: string;
  active: boolean;
  scale: number;
  baseSize: number;
  onClick: () => void;
  hideIndicator?: boolean;
  hovered?: boolean;
  showTooltip?: boolean;
  onHover?: (hovered: boolean) => void;
  onFocusChange?: (focused: boolean) => void;
  children: ReactNode;
}) {
  const [punch, setPunch] = useState(false);
  const handleClick = () => {
    setPunch(true);
    onClick();
    window.setTimeout(() => setPunch(false), 220);
  };
  const lift = scale > 1 ? (scale - 1) * 14 : 0;
  const tipOffset = lift + baseSize * (scale - 1);
  const showTip = Boolean(showTooltip && !hideIndicator);
  const tipBg = "color-mix(in srgb, var(--color-elevated) 92%, var(--color-canvas))";
  return (
    <div
      onPointerEnter={() => onHover?.(true)}
      onPointerLeave={() => onHover?.(false)}
      className="relative flex shrink-0 flex-col items-center justify-end"
      style={{
        width: baseSize * scale,
        height: baseSize,
        zIndex: showTip ? 200 : Math.round(scale * 100),
        transition: "width 140ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}
    >
      <span
        role="tooltip"
        aria-hidden={!showTip}
        className="harbor-minui-tooltip pointer-events-none absolute left-1/2 z-20 whitespace-nowrap rounded-xl border px-3 py-1.5 text-[12.5px] font-semibold leading-none tracking-[0.01em] backdrop-blur-xl"
        style={{
          bottom: baseSize + 10,
          background: tipBg,
          color: "var(--color-ink)",
          borderColor: "var(--color-edge)",
          boxShadow:
            "0 12px 28px -8px rgba(15,15,18,0.38), 0 4px 12px -4px rgba(15,15,18,0.20), inset 0 1px 0 color-mix(in srgb, var(--color-ink) 10%, transparent)",
          opacity: showTip ? 1 : 0,
          transform: `translateX(-50%) translateY(${-(tipOffset + (showTip ? 0 : -4))}px) scale(${showTip ? 1 : 0.92})`,
          transformOrigin: "center bottom",
          transition:
            "transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 140ms ease",
        }}
      >
        {label}
        <span
          aria-hidden
          className="absolute -bottom-[4px] left-1/2 h-[7px] w-[7px] -translate-x-1/2 rotate-45"
          style={{
            background: tipBg,
            borderRight: "1px solid var(--color-edge)",
            borderBottom: "1px solid var(--color-edge)",
          }}
        />
      </span>
      <button
        type="button"
        onClick={handleClick}
        onFocus={(e) => {
          if (e.currentTarget.matches(":focus-visible")) onFocusChange?.(true);
        }}
        onBlur={() => onFocusChange?.(false)}
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className="harbor-minui-button flex items-center justify-center rounded-2xl border outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{
          width: baseSize,
          height: baseSize,
          background: active ? "var(--color-accent)" : "var(--color-elevated)",
          color: active ? "#fff" : hovered ? "var(--color-ink)" : "var(--color-ink-muted)",
          borderColor: active ? "transparent" : "var(--color-edge-soft)",
          boxShadow: active
            ? "0 10px 24px -10px var(--color-accent-soft), inset 0 1px 0 rgba(255,255,255,0.22)"
            : "0 2px 6px -2px rgba(15,15,18,0.10), inset 0 1px 0 rgba(255,255,255,0.7)",
          transform: `translateY(${-lift}px) scale(${punch ? 0.9 : scale})`,
          transformOrigin: "center bottom",
          transition: punch
            ? "transform 160ms cubic-bezier(0.34, 1.56, 0.64, 1), background-color 160ms ease, color 160ms ease, box-shadow 160ms ease"
            : "transform 140ms cubic-bezier(0.34, 1.56, 0.64, 1), background-color 200ms ease, color 200ms ease, box-shadow 200ms ease",
        }}
      >
        {children}
      </button>
      {hideIndicator ? null : (
        <span
          aria-hidden
          className="absolute bottom-[-10px] h-1.5 w-1.5 rounded-full"
          style={{
            background: "var(--color-accent)",
            opacity: active ? 1 : 0,
            transform: `scale(${active ? 1 : 0.4})`,
            transition: "opacity 160ms ease, transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
          }}
        />
      )}
    </div>
  );
}
