import {
  resetOmdbBudget,
  subscribeOmdbBudget,
  type OmdbBudget,
  omdbBudget as readOmdbBudget,
} from "@/lib/providers/omdb";
import { useEffect, useState } from "react";
import { Music, Check, RotateCw } from "../icons";
import { useSettings } from "@/lib/settings";
import { useAuth } from "@/lib/auth";
import { hasCustomMetaAddon, hasCustomMetaAddonAsync } from "@/lib/meta-resource";
import { useT } from "@/lib/i18n";
import { Section, Segmented, ToggleRow } from "../shared";
import { ROW_ACTION, SettingGroup, SettingRow, Nested } from "../kit";
import {
  fetchGeminiSongModels,
  SONG_ID_GEMINI_MODELS,
  type SongIdProvider,
} from "@/lib/song-id";
import { EpisodeOrderSetting } from "../episode-order-setting";
import { SportsApiSetting } from "../sports-api-setting";
import { GameMetadataSetting } from "../game-metadata-setting";
import { useProviderKeys, type ProviderKeysArgs } from "./provider-keys";

export function ProvidersTab(props: ProviderKeysArgs) {
  const { settings, update } = useSettings();
  const { authKey } = useAuth();
  const [metaAddonResult, setMetaAddonResult] = useState<{
    authKey: string | null;
    found: boolean;
  } | null>(null);
  const hasMetaAddon =
    metaAddonResult?.authKey === authKey ? metaAddonResult.found : hasCustomMetaAddon();
  useEffect(() => {
    let cancelled = false;
    void hasCustomMetaAddonAsync(authKey)
      .then((found) => {
        if (!cancelled) setMetaAddonResult({ authKey, found });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [authKey]);
  const t = useT();
  const { keyRow, modals } = useProviderKeys(props);

  return (
    <>
      {modals}

      <Section
        title={t("Metadata providers")}
        subtitle={t(
          "Add TMDB for more catalogs and artwork. Other providers add the features listed below. You can use Harbor with Cinemeta without adding a key.",
        )}
      >
        <SettingGroup>
          {keyRow("tmdb")}
          {keyRow("omdb")}
          {keyRow("tvdb")}
          {keyRow("mdblist")}
          {keyRow("fanart")}
          {keyRow("rpdb")}
          {keyRow("postersrv")}
          {keyRow("nyt")}
        </SettingGroup>
      </Section>

      <SportsApiSetting />
      <GameMetadataSetting />

      <Section title={t("Titles and descriptions")}>
        <SettingGroup>
          <ToggleRow
            label={t("Use Cinemeta for title metadata")}
            sub={t(
              "Cinemeta supplies titles and descriptions. Turn it off when an installed metadata addon supplies them instead.",
            )}
            value={settings.cinemetaEnabled}
            onChange={(v) => update({ cinemetaEnabled: v })}
            warn={
              !settings.cinemetaEnabled && !hasMetaAddon
                ? t(
                    "No metadata addon detected. Harbor is falling back to Cinemeta so titles still load, but turn this back on unless you are installing one.",
                  )
                : undefined
            }
          />
          <ToggleRow
            label={t("Prefer my installed metadata addon")}
            sub={t(
              "Try your addon first for titles and descriptions. Use Cinemeta when the addon has no result.",
            )}
            value={settings.preferCustomMetaAddon}
            onChange={(v) => update({ preferCustomMetaAddon: v })}
          />
          <ToggleRow
            label={t("Use free IMDb data without a TMDB key")}
            sub={t(
              "With no TMDB key, the About panel pulls cast, crew, and title info from a free IMDb source. TMDB is still used whenever a key is set.",
            )}
            value={settings.imdbApiFallback}
            onChange={(v) => update({ imdbApiFallback: v })}
          />
        </SettingGroup>
      </Section>

      <Section title={t("Episode order")}>
        <SettingGroup>
          <EpisodeOrderSetting />
        </SettingGroup>
      </Section>

      <Section title={t("Song identification")}>
        <SettingGroup>
          <SettingRow
            wide
            icon={<Music size={18} strokeWidth={2} />}
            label={t("Song ID provider")}
            desc={t("Which service names the track when you tap Identify song in the player.")}
          >
            <Segmented
              value={settings.songIdProvider}
              options={[
                { value: "shazam", label: t("Shazam (Free)") },
                { value: "audd", label: t("AudD") },
                { value: "ai", label: t("AI (Gemini)") },
              ]}
              onChange={(v) => update({ songIdProvider: v as SongIdProvider })}
            />
          </SettingRow>
          <Nested>
            {settings.songIdProvider === "shazam" && (
              <>
                <SettingRow
                  label={t("Shazam (Free)")}
                  desc={t(
                    "Free acoustic fingerprinting on Windows. No API key required.",
                  )}
                />
                <ToggleRow
                  label={t("Fall back to Gemini if no match")}
                  sub={t(
                    "Automatically try Gemini ({model}) on the same audio clip when Shazam cannot match it (requires a Gemini API key).",
                    { model: settings.songIdAiModel },
                  )}
                  value={settings.songIdShazamFallbackGemini}
                  onChange={(v) => update({ songIdShazamFallbackGemini: v })}
                />
                {settings.songIdShazamFallbackGemini && keyRow("songai")}
              </>
            )}
            {settings.songIdProvider === "audd" && keyRow("audd")}
            {settings.songIdProvider === "ai" && (
              <>
                {keyRow("songai")}
                <GeminiModelSetting
                  model={settings.songIdAiModel}
                  apiKey={settings.songIdAiKey}
                  onSelect={(v) => update({ songIdAiModel: v })}
                />
                <ToggleRow
                  label={t("Use movie & show context")}
                  sub={t(
                    "Share the current title and episode with Gemini and allow Google Search to verify soundtracks.",
                  )}
                  value={settings.songIdGeminiGrounding}
                  onChange={(v) => update({ songIdGeminiGrounding: v })}
                />
              </>
            )}
          </Nested>
        </SettingGroup>
      </Section>

      <Section title={t("API budget")}>
        <SettingGroup>
          <OmdbBudgetRow />
        </SettingGroup>
      </Section>
    </>
  );
}

function GeminiModelSetting({
  model,
  apiKey,
  onSelect,
}: {
  model: string;
  apiKey: string;
  onSelect: (model: string) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(model);
  const [fetched, setFetched] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(model);
  }, [model]);

  const trimmed = draft.trim();
  const canApply = trimmed.length > 0 && trimmed !== model;
  const presetValues = new Set<string>(SONG_ID_GEMINI_MODELS.map((m) => m.value));
  const options: Array<{ value: string; label: string }> = SONG_ID_GEMINI_MODELS.map((m) => ({
    value: m.value,
    label: t(m.label),
  }));
  if (model && !presetValues.has(model)) {
    options.push({ value: model, label: model });
  }

  const applyCustom = () => {
    if (!canApply) return;
    onSelect(trimmed);
  };

  const handleFetch = async () => {
    if (!apiKey.trim()) {
      setFetchError(t("Save a Gemini API key above first."));
      return;
    }
    setLoading(true);
    setFetchError(null);
    try {
      const models = await fetchGeminiSongModels(apiKey);
      setFetched(models);
      if (models.length === 0) {
        setFetchError(t("No compatible Gemini models were returned for this key."));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setFetchError(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingRow
      wide
      label={t("Gemini model")}
      desc={t(
        "2.5 Flash is the most reliable free-tier default. Type any live Gemini model ID below or fetch models supported by your key.",
      )}
      warn={fetchError ?? undefined}
    >
      <div className="flex flex-col gap-3">
        <Segmented value={model} options={options} onChange={onSelect} />
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applyCustom();
              }
            }}
            placeholder={t("Custom model ID (e.g. gemini-2.5-flash)")}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            aria-label={t("Custom Gemini model ID")}
            className="h-11 min-w-[220px] flex-1 rounded-[8px] border border-edge-soft bg-elevated px-3 text-[15px] text-ink outline-none placeholder:text-ink-subtle focus:border-edge focus:bg-raised"
          />
          <button
            type="button"
            disabled={!canApply}
            onClick={applyCustom}
            className={`${ROW_ACTION} disabled:pointer-events-none disabled:opacity-45`}
          >
            {t("Apply")}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void handleFetch()}
            className={`${ROW_ACTION} disabled:pointer-events-none disabled:opacity-45`}
          >
            <RotateCw size={16} strokeWidth={2.2} className={loading ? "animate-spin" : ""} />
            {loading ? t("Fetching…") : t("Fetch models")}
          </button>
        </div>
        {fetched && fetched.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {fetched.map((id) => {
              const active = id === model;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onSelect(id)}
                  className={`harbor-press-pop rounded-[7px] border px-2.5 py-1 text-[13.5px] font-medium transition-colors ${
                    active
                      ? "border-ink bg-ink text-canvas"
                      : "border-edge-soft bg-elevated text-ink-muted hover:border-edge hover:text-ink"
                  }`}
                >
                  {id}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </SettingRow>
  );
}

function OmdbBudgetRow() {
  const tr = useT();
  const { settings } = useSettings();
  const [budget, setBudget] = useState<OmdbBudget>(() => readOmdbBudget());
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => subscribeOmdbBudget(setBudget), []);
  useEffect(() => {
    if (!confirmed) return;
    const t = setTimeout(() => setConfirmed(false), 1400);
    return () => clearTimeout(t);
  }, [confirmed]);

  const label = tr("OMDB daily budget");

  if (!settings.omdbKey) {
    return (
      <SettingRow
        label={label}
        lockReason={tr("Save an OMDB key in Library & metadata to enable rating fetches.")}
      />
    );
  }

  const desc = budget.keyInvalid
    ? tr("Key rejected. Check it on Library & metadata.")
    : tr("{used} / {limit} requests today.", { used: budget.used, limit: budget.limit }) +
      (budget.exhausted ? " " + tr("Budget exhausted, resets at midnight UTC.") : "");

  return (
    <SettingRow label={label} desc={desc}>
      <button
        type="button"
        onClick={() => {
          resetOmdbBudget();
          setConfirmed(true);
        }}
        className={ROW_ACTION}
      >
        {confirmed ? (
          <Check size={18} strokeWidth={2.4} className="text-accent" />
        ) : (
          <RotateCw size={18} strokeWidth={2.2} />
        )}
        {confirmed ? tr("Reset") : tr("Reset counter")}
      </button>
    </SettingRow>
  );
}
