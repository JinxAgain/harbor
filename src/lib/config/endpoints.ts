function resolveBase(raw: string | undefined, fallback: string): string {
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
  return value.replace(/\/+$/, "");
}

const metaEnv: Record<string, string | undefined> =
  typeof import.meta !== "undefined" && (import.meta as any).env ? (import.meta as any).env : {};

export const HARBOR_API_BASE = resolveBase(
  metaEnv.VITE_HARBOR_API_BASE,
  "https://harbor.site",
);

export const HARBOR_TRAKT_BASE = resolveBase(
  metaEnv.VITE_HARBOR_TRAKT_BASE,
  HARBOR_API_BASE,
);

export const HARBOR_MAL_BASE = resolveBase(metaEnv.VITE_HARBOR_MAL_BASE, HARBOR_API_BASE);

export const HARBOR_TVDB_BASE = resolveBase(metaEnv.VITE_HARBOR_TVDB_BASE, HARBOR_API_BASE);

export const HARBOR_BUGS_BASE = resolveBase(
  metaEnv.VITE_HARBOR_BUGS_BASE,
  "https://bugs.harbor.site",
);

export const HARBOR_SYNC_BASE = resolveBase(
  metaEnv.VITE_HARBOR_SYNC_BASE,
  "https://sync.harbor.site",
);

export const HARBOR_RELAY_BASE = resolveBase(
  metaEnv.VITE_HARBOR_RELAY_BASE,
  "https://app.harbor.site",
);

export const HARBOR_DISCORD_INVITE = resolveBase(
  metaEnv.VITE_HARBOR_DISCORD_INVITE,
  "https://discord.gg/harbor",
);
