import { anilistRequest } from "./client";
import { kitsuToAnilist } from "@/lib/providers/anime-mapping";

const RELATIONS_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) {
    seasonYear
    startDate { year }
    title { english romaji userPreferred }
    relations {
      edges {
        relationType(version: 2)
        node {
          id
          type
          format
          episodes
          status
          averageScore
          seasonYear
          title { english romaji userPreferred }
          coverImage { large }
          bannerImage
          description(asHtml: false)
          startDate { year month day }
        }
      }
    }
  }
}`;

const FRANCHISE_RELATIONS = new Set(["SEQUEL", "PREQUEL", "PARENT", "SIDE_STORY"]);
const ANIME_FORMATS = new Set(["TV", "TV_SHORT", "ONA", "OVA", "MOVIE", "SPECIAL"]);
const MAX_DEPTH = 6;
const MAX_NODES = 40;

type RawNode = {
  id: number;
  type?: string | null;
  format: string | null;
  episodes: number | null;
  status: string | null;
  averageScore: number | null;
  seasonYear: number | null;
  title: { english: string | null; romaji: string | null; userPreferred: string | null };
  coverImage: { large: string | null } | null;
  bannerImage: string | null;
  description: string | null;
  startDate: { year: number | null; month: number | null; day: number | null } | null;
};
type RawEdge = {
  relationType: string | null;
  node: RawNode | null;
  parentTitles?: string[];
  parentYear?: number;
};
type RelationsResponse = {
  Media: {
    seasonYear?: number | null;
    startDate?: { year: number | null } | null;
    title?: { english: string | null; romaji: string | null; userPreferred: string | null } | null;
    relations: { edges: RawEdge[] } | null;
  } | null;
};

function normBaseTitle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(season|cour|part)\b.*$/i, " ")
    .replace(/\b\d+(st|nd|rd|th)\b.*$/i, " ")
    .replace(/\bfinal(\s+season)?\b.*$/i, " ")
    .replace(/\b(the\s+)?movie\b.*$/i, " ")
    .replace(/\s+(ii|iii|iv|v|vi|vii|viii|ix|x|[2-9])\s*$/i, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSameFranchiseOther(edge: RawEdge): boolean {
  if (edge.relationType !== "OTHER" || !edge.node || !edge.parentTitles?.length) return false;
  if (edge.node.type && edge.node.type !== "ANIME") return false;
  if (edge.node.format && !ANIME_FORMATS.has(edge.node.format)) return false;
  const nodeTitles = [
    edge.node.title.english,
    edge.node.title.romaji,
    edge.node.title.userPreferred,
  ]
    .filter((t): t is string => !!t && t.trim().length > 0)
    .map(normBaseTitle)
    .filter((t) => t.length >= 3);
  if (nodeTitles.length === 0) return false;
  for (const pt of edge.parentTitles) {
    const p = normBaseTitle(pt);
    if (p.length >= 3 && nodeTitles.includes(p)) return true;
  }
  return false;
}

export type AnilistFranchiseNode = {
  id: number;
  name: string;
  type: "movie" | "series";
  format?: string;
  poster?: string;
  banner?: string;
  description?: string;
  episodes?: number;
  year?: number;
  startDate?: string;
  rating?: string;
  upcoming: boolean;
  sideStory?: boolean;
};

const edgeCache = new Map<number, RawEdge[]>();

async function fetchEdges(anilistId: number): Promise<RawEdge[]> {
  const cached = edgeCache.get(anilistId);
  if (cached) return cached;
  try {
    const data = await anilistRequest<RelationsResponse>(
      RELATIONS_QUERY,
      { id: anilistId },
      undefined,
      true,
    );
    const parentTitles = [
      data?.Media?.title?.english,
      data?.Media?.title?.romaji,
      data?.Media?.title?.userPreferred,
    ]
      .filter((t): t is string => !!t && t.trim().length > 0)
      .map((t) => t.trim());
    const parentYear = data?.Media?.seasonYear ?? data?.Media?.startDate?.year ?? undefined;
    const edges = (data?.Media?.relations?.edges ?? []).map((e) => ({
      ...e,
      parentTitles,
      parentYear,
    }));
    edgeCache.set(anilistId, edges);
    return edges;
  } catch {
    edgeCache.set(anilistId, []);
    return [];
  }
}

function fmtDate(d: RawNode["startDate"]): string | undefined {
  if (!d?.year) return undefined;
  const mm = String(d.month ?? 1).padStart(2, "0");
  const dd = String(d.day ?? 1).padStart(2, "0");
  return `${d.year}-${mm}-${dd}`;
}

function toNode(n: RawNode): AnilistFranchiseNode {
  return {
    id: n.id,
    name: (n.title.english ?? n.title.romaji ?? n.title.userPreferred ?? "").trim(),
    type: n.format === "MOVIE" ? "movie" : "series",
    format: n.format ?? undefined,
    poster: n.coverImage?.large ?? undefined,
    banner: n.bannerImage ?? undefined,
    description: (n.description ?? "").replace(/<[^>]+>/g, "").trim() || undefined,
    episodes: n.episodes ?? undefined,
    year: n.seasonYear ?? n.startDate?.year ?? undefined,
    startDate: fmtDate(n.startDate),
    rating:
      typeof n.averageScore === "number" && n.averageScore > 0
        ? (n.averageScore / 10).toFixed(1)
        : undefined,
    upcoming: n.status === "NOT_YET_RELEASED",
  };
}

export async function anilistFranchise(kitsuId: number): Promise<AnilistFranchiseNode[]> {
  const root = await kitsuToAnilist(kitsuId).catch(() => null);
  if (!root) return [];
  const out = new Map<number, AnilistFranchiseNode>();
  const visited = new Map<number, boolean>([[root, false]]);
  let frontier: Array<{ id: number; sideStory: boolean }> = [{ id: root, sideStory: false }];
  let depth = 0;
  while (frontier.length > 0 && depth < MAX_DEPTH && out.size < MAX_NODES) {
    const batches = await Promise.all(frontier.map((f) => fetchEdges(f.id)));
    const next: Array<{ id: number; sideStory: boolean }> = [];
    for (let i = 0; i < frontier.length; i++) {
      const parentSide = frontier[i].sideStory;
      for (const e of batches[i]) {
        if (
          !e.relationType ||
          (!FRANCHISE_RELATIONS.has(e.relationType) && !isSameFranchiseOther(e))
        ) {
          continue;
        }
        const n = e.node;
        if (!n || n.id == null) continue;
        if (n.type && n.type !== "ANIME") continue;
        if (n.format && !ANIME_FORMATS.has(n.format)) continue;
        const edgeSide = parentSide || e.relationType === "SIDE_STORY";
        const prevSide = visited.get(n.id);
        if (prevSide !== undefined) {
          if (prevSide && !edgeSide) {
            visited.set(n.id, false);
            const existing = out.get(n.id);
            if (existing) out.set(n.id, { ...existing, sideStory: false });
            next.push({ id: n.id, sideStory: false });
          }
          continue;
        }
        visited.set(n.id, edgeSide);
        const node = { ...toNode(n), ...(edgeSide ? { sideStory: true } : {}) };
        if (node.name) out.set(n.id, node);
        if (!edgeSide) next.push({ id: n.id, sideStory: false });
      }
    }
    frontier = next;
    depth++;
  }
  return [...out.values()];
}

export type AnimeRelation = {
  id: number;
  name: string;
  year?: number;
  format?: string;
  poster?: string;
  kind: "prequel" | "sequel";
  upcoming: boolean;
};

const MAX_RELATIONS = 20;

export async function animeRelations(anilistId: number): Promise<AnimeRelation[]> {
  const out: AnimeRelation[] = [];
  const seen = new Map<number, number>();
  let frontier: Array<{ id: number; dir: number }> = [{ id: anilistId, dir: 0 }];
  seen.set(anilistId, 0);
  while (frontier.length > 0 && out.length < MAX_RELATIONS) {
    const batches = await Promise.all(frontier.map((f) => fetchEdges(f.id)));
    const next: Array<{ id: number; dir: number }> = [];
    for (let i = 0; i < frontier.length; i++) {
      const dir = frontier[i].dir;
      for (const e of batches[i]) {
        const sameOther = isSameFranchiseOther(e);
        if (e.relationType !== "PREQUEL" && e.relationType !== "SEQUEL" && !sameOther) continue;
        const n = e.node;
        if (!n || n.id == null) continue;
        if (n.type && n.type !== "ANIME") continue;
        if (n.format && !ANIME_FORMATS.has(n.format)) continue;
        if (n.format === "MOVIE") continue;
        if (seen.has(n.id)) continue;
        const nodeYear = n.seasonYear ?? n.startDate?.year ?? undefined;
        const step =
          e.relationType === "PREQUEL"
            ? -1
            : e.relationType === "SEQUEL"
              ? 1
              : e.parentYear != null && nodeYear != null && nodeYear < e.parentYear
                ? -1
                : 1;
        const nextDir = dir + step;
        seen.set(n.id, nextDir);
        const node = toNode(n);
        if (!node.name) continue;
        out.push({
          id: node.id,
          name: node.name,
          year: node.year,
          format: node.format,
          poster: node.poster,
          kind: nextDir < 0 ? "prequel" : "sequel",
          upcoming: node.upcoming,
        });
        next.push({ id: n.id, dir: nextDir });
      }
    }
    frontier = next;
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "prequel" ? -1 : 1;
    if (a.kind === "prequel") return (b.year ?? 0) - (a.year ?? 0);
    return (a.year ?? 0) - (b.year ?? 0);
  });
  return out;
}
