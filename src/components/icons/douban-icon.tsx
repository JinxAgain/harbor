export function DoubanIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-label="Douban"
      role="img"
      preserveAspectRatio="xMidYMid meet"
    >
      <rect width="24" height="24" rx="4" fill="#00B51D" />
      <path
        fill="#FFFFFF"
        d="M4.5 5.25h15v1.8h-15v-1.8zm1.8 3.3h11.4v5.7H6.3v-5.7zm1.95 1.65v2.4h7.5V10.2h-7.5zm.6 4.8 1.65 2.55-1.5.9-1.65-2.55 1.5-.9zm6.45.9-1.5-.9 1.5-2.55 1.55.9-1.55 2.55zM3.75 18.15h16.5v1.8H3.75v-1.8z"
      />
    </svg>
  );
}
