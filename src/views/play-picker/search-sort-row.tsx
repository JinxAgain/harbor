import {
  ArrowDownWideNarrow,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Check,
  ChevronDown,
  Search,
  X,
} from "lucide-react";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import type {
  StreamSearchMode,
  StreamSortDir,
  StreamSortField,
} from "./stream-search-sort";

export function SearchSortRow(props: {
  query: string;
  onQueryChange: (query: string) => void;
  mode: StreamSearchMode;
  onModeChange: (mode: StreamSearchMode) => void;
  regexError: boolean;
  sortBy: StreamSortField;
  onSortByChange: (sortBy: StreamSortField) => void;
  sortDir: StreamSortDir;
  onSortDirToggle: () => void;
}) {
  const t = useT();
  const [sortOpen, setSortOpen] = useState(false);

  const searchModes: Array<{ mode: StreamSearchMode; label: string; title: string }> = [
    { mode: "whole-word", label: "Ab", title: t("Whole word") },
    { mode: "wildcard", label: "*", title: t("Wildcard (* and ?)") },
    { mode: "regex", label: ".*", title: t("Regular expression") },
  ];

  const sortOptions: Array<{ key: StreamSortField; label: string }> = [
    { key: "default", label: t("Default order") },
    { key: "size", label: t("File size") },
    { key: "seeders", label: t("Seeders") },
    { key: "resolution", label: t("Resolution") },
    { key: "score", label: t("Score") },
  ];

  const currentSort = sortOptions.find((o) => o.key === props.sortBy) ?? sortOptions[0];

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <div
        className={`flex min-w-[240px] flex-1 items-center gap-2 rounded-2xl bg-elevated/60 px-3.5 py-2 ring-1 transition-colors ${
          props.regexError ? "ring-danger/60" : "ring-edge-soft focus-within:ring-edge"
        }`}
      >
        <Search size={15} strokeWidth={2.2} className="shrink-0 text-ink-subtle" />
        <input
          type="text"
          value={props.query}
          onChange={(e) => props.onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.blur();
            }
          }}
          placeholder={t("Search streams...")}
          aria-label={t("Search streams...")}
          className="w-full min-w-0 bg-transparent text-[13.5px] text-ink placeholder:text-ink-subtle focus:outline-none"
        />
        {props.query.length > 0 && (
          <button
            type="button"
            onClick={() => props.onQueryChange("")}
            title={t("Clear search")}
            aria-label={t("Clear search")}
            className="rounded-md p-1 text-ink-subtle transition-colors hover:text-ink"
          >
            <X size={14} strokeWidth={2.4} />
          </button>
        )}
        <span className="mx-0.5 h-3.5 w-px shrink-0 bg-edge-soft" />
        <div className="flex items-center gap-1 shrink-0">
          {searchModes.map((m) => {
            const active = props.mode === m.mode;
            return (
              <button
                key={m.mode}
                type="button"
                title={m.title}
                aria-label={m.title}
                aria-pressed={active}
                onClick={() => props.onModeChange(active ? "plain" : m.mode)}
                className={`flex h-6 min-w-6 items-center justify-center rounded px-1.5 text-[11px] font-semibold transition-colors ${
                  active
                    ? "bg-ink text-canvas shadow-xs"
                    : "bg-surface/50 text-ink-muted hover:bg-surface hover:text-ink"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setSortOpen((o) => !o)}
          aria-expanded={sortOpen}
          aria-label={t("Sort streams: {field}", { field: currentSort.label })}
          className="flex items-center gap-2 rounded-2xl bg-elevated/60 px-3.5 py-2.5 text-[13.5px] font-medium text-ink ring-1 ring-edge-soft transition-colors hover:bg-elevated shrink-0"
        >
          <ArrowUpDown size={14} strokeWidth={2.2} className="text-ink-subtle" />
          <span>{currentSort.label}</span>
          <ChevronDown
            size={12}
            strokeWidth={2.4}
            className={`transition-transform duration-150 ${sortOpen ? "rotate-180" : ""} text-ink-subtle`}
          />
        </button>

        {sortOpen && (
          <>
            <button
              type="button"
              aria-label={t("Close menu")}
              onClick={() => setSortOpen(false)}
              className="fixed inset-0 z-10 cursor-default"
            />
            <div className="absolute end-0 top-full z-20 mt-1 min-w-[176px] rounded-xl bg-elevated p-1 ring-1 ring-edge shadow-[0_18px_44px_-14px_rgba(0,0,0,0.7)]">
              {sortOptions.map((opt) => {
                const selected = props.sortBy === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => {
                      props.onSortByChange(opt.key);
                      setSortOpen(false);
                    }}
                    className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-start text-[13px] transition-colors hover:bg-raised ${
                      selected ? "font-semibold text-ink" : "text-ink-muted"
                    }`}
                  >
                    <span className="truncate">{opt.label}</span>
                    <Check
                      size={13}
                      strokeWidth={2.6}
                      className={selected ? "text-ink" : "invisible"}
                    />
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {props.sortBy !== "default" && (
        <button
          type="button"
          onClick={props.onSortDirToggle}
          title={props.sortDir === "desc" ? t("Descending") : t("Ascending")}
          aria-label={props.sortDir === "desc" ? t("Descending") : t("Ascending")}
          className="rounded-2xl bg-elevated/60 p-2.5 text-ink-muted ring-1 ring-edge-soft transition-colors hover:bg-elevated hover:text-ink shrink-0"
        >
          {props.sortDir === "desc" ? (
            <ArrowDownWideNarrow size={15} strokeWidth={2.2} />
          ) : (
            <ArrowUpNarrowWide size={15} strokeWidth={2.2} />
          )}
        </button>
      )}
    </div>
  );
}
