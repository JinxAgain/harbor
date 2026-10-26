export function LiquidGlassFilterDefs() {
  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none fixed -top-96 -left-96 h-0 w-0 overflow-hidden opacity-0"
    >
      <defs>
        <filter
          id="harbor-liquid-glass-refract"
          x="-8%"
          y="-8%"
          width="116%"
          height="116%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.008 0.012"
            numOctaves={2}
            seed={7}
            result="lgNoise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="lgNoise"
            scale={9}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
    </svg>
  );
}

