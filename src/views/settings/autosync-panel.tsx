import { isDesktopTauri } from "@/lib/platform";
import { useSettings } from "@/lib/settings";
import { useT } from "@/lib/i18n";
import { Nested, OptionScale, SettingGroup, SettingRow } from "./kit";
import { Section, ToggleRow } from "./shared";

const MODE_OPTIONS = ["quick", "thorough"] as const;
const TOLERANCE_OPTIONS = [0, 100, 200, 300, 400, 500] as const;

export function AutoSyncPanel() {
  const t = useT();
  const { settings, update } = useSettings();
  const supported = isDesktopTauri();
  const master = supported && settings.subtitleAutoSync;

  return (
    <div className="hset-form-page">
      <Section
        title={t("Subtitle auto-sync")}
        subtitle={t(
          "Align external subtitles against the video's embedded subtitle tracks. Works across languages without decoding audio.",
        )}
      >
        <ToggleRow
          label={t("Auto-sync subtitles")}
          sub={t(
            "Automatically match external subtitles to embedded subtitle timing when playback starts. Off by default.",
          )}
          lockReason={
            supported
              ? undefined
              : t("Embedded subtitle auto-sync is available only in the Harbor desktop app.")
          }
          value={master}
          onChange={(v) => update({ subtitleAutoSync: v })}
        />

        {supported && master && (
          <Nested>
            <SettingGroup label={t("While auto-sync is on")}>
              <SettingRow
                label={t("Sync mode")}
                desc={
                  settings.autoSyncMode === "quick"
                    ? t("Stops at the first reliable subtitle match for faster startup.")
                    : t("Checks more candidates and applies the strongest alignment.")
                }
              >
                <OptionScale
                  value={settings.autoSyncMode}
                  options={MODE_OPTIONS}
                  format={(mode) => (mode === "quick" ? t("Quick") : t("Thorough"))}
                  onChange={(v) => update({ autoSyncMode: v })}
                />
              </SettingRow>

              <SettingRow
                label={t("Sync tolerance")}
                desc={t(
                  "Skip rewriting subtitles whose maximum timing shift is already within this threshold.",
                )}
              >
                <OptionScale
                  value={settings.autoSyncToleranceMs}
                  options={TOLERANCE_OPTIONS}
                  format={(ms) => (ms === 0 ? t("Off") : `${ms} ms`)}
                  onChange={(v) => update({ autoSyncToleranceMs: v })}
                />
              </SettingRow>
            </SettingGroup>
          </Nested>
        )}
      </Section>
    </div>
  );
}
