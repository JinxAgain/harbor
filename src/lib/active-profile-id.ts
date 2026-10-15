const KEY = "harbor.profiles.v1";

type MinimalProfile = { id: string; isPrimary?: boolean };
type MinimalState = { profiles?: MinimalProfile[]; activeId?: string | null };

function readState(): MinimalState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as MinimalState;
  } catch {
    return null;
  }
}

export function activeProfileId(): string {
  const s = readState();
  if (!s || !Array.isArray(s.profiles) || s.profiles.length === 0) {
    return s?.activeId || "default";
  }
  const active = s.profiles.find((p) => p.id === s.activeId);
  if (active?.id) return active.id;
  const primary = s.profiles.find((p) => p.isPrimary);
  if (primary?.id) return primary.id;
  return s.profiles[0]?.id || "default";
}

export function activeProfileIsPrimary(): boolean {
  const s = readState();
  if (!s || !Array.isArray(s.profiles) || s.profiles.length === 0) return true;
  const active = s.profiles.find((p) => p.id === s.activeId);
  if (active) return active.isPrimary === true;
  const primary = s.profiles.find((p) => p.isPrimary);
  if (primary) return true;
  return s.profiles[0]?.isPrimary === true;
}

