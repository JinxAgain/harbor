// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import type { Settings } from "../src/lib/settings/types.ts";
import { applySubStyle } from "../src/lib/player/sub-style.ts";
import {
  computeAssBaseFactor,
  assScaleFromFactor,
  parseAssStyles,
  dominantDialogueStyle,
} from "../src/lib/player/ass-header.ts";
import { isAssTrack } from "../src/lib/player/sub-format.ts";
import type { TrackInfo } from "../src/lib/player/bridge.ts";

function createMockSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    subFontSize: 32,
    subFontColor: "#FFFFFF",
    subBorderColor: "#000000",
    subBorderSize: 2,
    subMarginY: 20,
    subAlignX: "center",
    subAssOverride: "no",
    subAssNormalizeSize: false,
    subStyle: "outline",
    subFontFamily: "inter",
    subBold: false,
    customFonts: [],
    subBoxOpacity: 0.6,
    subBoxColor: "#000000",
    subOpacity: 1,
    subLineSpacing: 0,
    subHideSdh: false,
    mpvExtraOptions: "",
    ...overrides,
  } as unknown as Settings;
}

function captureMpvProps() {
  const props = new Map<string, unknown>();
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { name: string; value: unknown }) => {
        if (command === "mpv_set_property") {
          props.set(args.name, args.value);
        }
        return undefined;
      },
    },
  };
  return props;
}

test("subAssOverride === 'yes' (Font only) applies font name override, scales by subFontSize on native ASS, and adjusts sub-pos without breaking margins", async () => {
  const props = captureMpvProps();
  const settings = createMockSettings({
    subAssOverride: "yes",
    subFontFamily: "inter",
    subFontSize: 48,
    subMarginY: 20,
  });

  // When native ASS is active: sub-scale scales according to subFontSize, sub-pos reflects subMarginY, ass margins stay "no"
  await applySubStyle(settings, { assNativeActive: true, imageNativeActive: false });

  assert.equal(props.get("sub-ass-override"), "scale");
  assert.equal(props.get("sub-ass-style-overrides"), "FontName=Inter");
  assert.equal(props.get("sub-scale"), 48 / 32);
  assert.equal(props.get("sub-ass-force-margins"), "no");
  assert.equal(props.get("sub-pos"), 80);

  // When native ASS is false (plain text SRT): sub-scale scales according to subFontSize
  const srtProps = captureMpvProps();
  await applySubStyle(settings, { assNativeActive: false, imageNativeActive: false });
  assert.equal(srtProps.get("sub-scale"), 48 / 32);
  assert.equal(srtProps.get("sub-pos"), 80);
});

test("subAssOverride === 'yes' with assScale applies font override AND size normalization simultaneously", async () => {
  const props = captureMpvProps();
  const settings = createMockSettings({
    subAssOverride: "yes",
    subFontFamily: "rounded",
    subFontSize: 32,
    subMarginY: 20,
  });

  await applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: 1.35,
  });

  assert.equal(props.get("sub-ass-override"), "scale");
  assert.equal(props.get("sub-scale"), 1.35);
  assert.equal(props.get("sub-ass-style-overrides"), "FontName=Fredoka");
  assert.equal(props.get("sub-ass-force-margins"), "no");
  assert.equal(props.get("sub-pos"), 80);
});

test("mpvExtraOptions sub-ass-override and sub-ass-style-overrides are preserved over defaults", async () => {
  const props = captureMpvProps();
  const settings = createMockSettings({
    subAssOverride: "no",
    mpvExtraOptions: `
# Custom font override via mpv.conf
sub-ass-override=yes
sub-ass-style-overrides=FontName=TangYuan Comfortaa SC Bold
`,
  });

  await applySubStyle(settings, { assNativeActive: true, imageNativeActive: false });

  assert.equal(props.get("sub-ass-override"), "yes");
  assert.equal(props.get("sub-ass-style-overrides"), "FontName=TangYuan Comfortaa SC Bold");
  assert.equal(props.get("sub-ass-force-margins"), "no");
});

test("computeAssBaseFactor normalizes both small embedded ASS (*Default) and large external ASS to target height", () => {
  const smallEmbeddedAss = `
[Script Info]
Title: Small Embedded Test
ScriptType: v4.00+
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: *Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,*Default,,0,0,0,,Small embedded dialogue line
`;

  const largeExternalAss = `
[Script Info]
Title: Large External Test
ScriptType: v4.00+
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,72,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Large external dialogue line
`;

  const smallFactor = computeAssBaseFactor(smallEmbeddedAss);
  assert.notEqual(smallFactor, null, "small embedded ASS (frac < 0.02, leading asterisk) must not be rejected");

  const largeFactor = computeAssBaseFactor(largeExternalAss);
  assert.notEqual(largeFactor, null, "large external ASS must be parsed");

  const targetSize = 32;
  const smallScale = assScaleFromFactor(smallFactor!, targetSize);
  const largeScale = assScaleFromFactor(largeFactor!, targetSize);

  // Original rendered heights at 720p base:
  // small: 20 * (720 / 1080) = 13.333px. When scaled: 13.333 * smallScale = 32px.
  // large: 72 * (720 / 1080) = 48.000px. When scaled: 48.000 * largeScale = 32px.
  const renderedSmallHeight = 20 * (720 / 1080) * smallScale;
  const renderedLargeHeight = 72 * (720 / 1080) * largeScale;

  assert.ok(
    Math.abs(renderedSmallHeight - renderedLargeHeight) < 0.01,
    `Normalized heights must match: small=${renderedSmallHeight}, large=${renderedLargeHeight}`,
  );
  assert.ok(
    Math.abs(renderedSmallHeight - targetSize) < 0.01,
    `Rendered height must match target size ${targetSize}, got ${renderedSmallHeight}`,
  );
});

test("isAssTrack detects external ASS tracks via format, externalFilename, or url", () => {
  const trackWithFormat: TrackInfo = {
    id: "1",
    label: "English [ASS]",
    kind: "subtitle",
    selected: true,
    format: "ass",
    title: "English",
  };
  assert.equal(isAssTrack(trackWithFormat), true);

  const trackWithFilename: TrackInfo = {
    id: "2",
    label: "Track 2",
    kind: "subtitle",
    selected: true,
    externalFilename: "movie.commentary.ass",
    title: "Commentary",
  };
  assert.equal(isAssTrack(trackWithFilename), true);

  const trackWithUrl: TrackInfo = {
    id: "3",
    label: "Remote Stream",
    kind: "subtitle",
    selected: true,
    url: "https://example.com/subs/episode1.ssa?auth=xyz",
    title: "Subtitle 3",
  };
  assert.equal(isAssTrack(trackWithUrl), true);

  const trackSrt: TrackInfo = {
    id: "4",
    label: "English SRT",
    kind: "subtitle",
    selected: true,
    format: "srt",
    title: "English",
    url: "https://example.com/subs/episode1.srt",
  };
  assert.equal(isAssTrack(trackSrt), false);
});
