import { useMemo } from "react";
import { isFranchiseExtra, type FranchiseEntry } from "@/lib/providers/anime-detail";
import type { PickerItem } from "../series-episodes/season-arc-picker";

type AnimeOrder = { items: PickerItem[]; onSelect: (key: string) => void } | null;

export function useAnimeFranchiseNav(
  order: AnimeOrder,
  franchise: FranchiseEntry[],
  currentId: string,
  activeEntryId: string,
  onSelectEntry: (entryId: string) => void,
) {
  const franchiseNav = useMemo(
    () =>
      order && franchise.length > 1
        ? franchise
            .filter((f) => f.meta.id !== currentId)
            .map((f) => ({
              metaId: f.meta.id,
              key: `nav:${f.meta.id}`,
              name: f.meta.name,
              count: f.episodeCount ?? 0,
              year: f.startDate?.slice(0, 4),
              extra: isFranchiseExtra(f),
            }))
        : [],
    [order, franchise, currentId],
  );

  const pickerItems: PickerItem[] = useMemo(() => {
    if (!order) return [];
    const mainSeasonCount = order.items.filter((i) => !i.extra).length;
    const extras = franchiseNav
      .filter((n) => (mainSeasonCount > 1 ? n.extra : true))
      .map((n) => ({
        key: n.key,
        name: n.name,
        count: n.count,
        year: n.year,
        extra: n.extra,
      }));
    return [...order.items, ...extras];
  }, [order, franchiseNav]);

  const franchiseActiveKey = activeEntryId !== currentId ? `nav:${activeEntryId}` : undefined;

  const selectPickerItem = (key: string) => {
    const nav = franchiseNav.find((n) => n.key === key);
    if (nav) {
      onSelectEntry(nav.metaId);
      return;
    }
    onSelectEntry(currentId);
    order?.onSelect(key);
  };

  return { pickerItems, selectPickerItem, franchiseActiveKey };
}
