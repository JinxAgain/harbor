// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import type { Settings } from "../src/lib/settings/types.ts";
import { applySubStyle, resetSubStyleCache } from "../src/lib/player/sub-style.ts";
import {
  assNormalizeCacheKey,
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
  assert.notEqual(
    smallFactor,
    null,
    "small embedded ASS (frac < 0.02, leading asterisk) must not be rejected",
  );

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

test("applySubStyle resolves sub-back-color without sub-shadow-color race and deduplicates per sessionKey", async () => {
  resetSubStyleCache();
  const calls: Array<{ name: string; value: unknown }> = [];
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { name: string; value: unknown }) => {
        if (command === "mpv_set_property") {
          calls.push({ name: args.name, value: args.value });
        }
        return undefined;
      },
    },
  };

  const shadowSettings = createMockSettings({ subStyle: "shadow", subOpacity: 1 });
  await applySubStyle(shadowSettings, {
    assNativeActive: false,
    imageNativeActive: false,
    sessionKey: "s1",
  });
  assert.ok(!calls.some((c) => c.name === "sub-shadow-color"));
  assert.equal(calls.find((c) => c.name === "sub-back-color")?.value, "#FF000000");

  calls.length = 0;
  await applySubStyle(shadowSettings, {
    assNativeActive: false,
    imageNativeActive: false,
    sessionKey: "s1",
  });
  assert.equal(calls.length, 0, "unchanged subtitle style should not resend IPC properties");

  await applySubStyle(createMockSettings({ subStyle: "box", subOpacity: 1, subBoxOpacity: 0.5 }), {
    assNativeActive: false,
    imageNativeActive: false,
    sessionKey: "s1",
  });
  assert.ok(calls.length > 0, "changed subStyle must emit updated properties");
  assert.equal(calls.find((c) => c.name === "sub-back-color")?.value, "#80000000");

  calls.length = 0;
  await applySubStyle(createMockSettings({ subStyle: "box", subOpacity: 1, subBoxOpacity: 0.5 }), {
    assNativeActive: false,
    imageNativeActive: false,
    sessionKey: "s2",
  });
  assert.ok(calls.length > 10, "new sessionKey must flush full property set");
});

test("applySubStyle serializes concurrent calls so a rapid undefined->normalized assScale bounce never drops the normalized scale", async () => {
  resetSubStyleCache();
  const settings = createMockSettings({
    subAssOverride: "scale",
    subAssNormalizeSize: true,
    subFontSize: 32,
  });

  const finalProps = new Map<string, unknown>();
  const scaleWrites: number[] = [];
  let pendingScaleGate: { target: number; release: () => void; reached: Promise<void> } | null =
    null;

  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { name: string; value: unknown }) => {
        if (command !== "mpv_set_property") return undefined;
        if (
          args.name === "sub-scale" &&
          pendingScaleGate &&
          args.value === pendingScaleGate.target
        ) {
          const gate = pendingScaleGate;
          pendingScaleGate = null;
          let resolveGate!: () => void;
          const waitForRelease = new Promise<void>((resolve) => {
            resolveGate = resolve;
          });
          gate.release = resolveGate;
          gate.signalReached();
          await waitForRelease;
        }
        finalProps.set(args.name, args.value);
        if (args.name === "sub-scale" && typeof args.value === "number") {
          scaleWrites.push(args.value);
        }
        return undefined;
      },
    },
  };

  function armScaleGate(target: number) {
    let signalReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      signalReached = resolve;
    });
    const gate = {
      target,
      reached,
      signalReached,
      release: () => {},
    };
    pendingScaleGate = gate;
    return gate;
  }

  // 1. Initial normalized ASS track applies sub-scale=0.48
  await applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: 0.48,
    sessionKey: "s1",
  });
  assert.equal(finalProps.get("sub-scale"), 0.48);
  assert.equal(finalProps.get("sub-ass-override"), "scale");

  // 2. Rapid track replacement: Call A writes un-normalized 1.0 in-flight while Call B arrives with 0.48
  const gate1 = armScaleGate(1);
  const callA = applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: undefined,
    sessionKey: "s1",
  });
  await Promise.resolve();
  await gate1.reached;

  const callB = applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: 0.48,
    sessionKey: "s1",
  });
  gate1.release();
  await Promise.all([callA, callB]);

  assert.equal(
    finalProps.get("sub-scale"),
    0.48,
    "sub-scale must settle on normalized 0.48 after Call A -> Call B bounce",
  );

  // 3. Same-tick coalescing skips superseded Call A IPC completely
  scaleWrites.length = 0;
  const p1 = applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: undefined,
    sessionKey: "s1",
  });
  const p2 = applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: 0.62,
    sessionKey: "s1",
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(scaleWrites, [0.62]);
  assert.equal(finalProps.get("sub-scale"), 0.62);

  // 4. resetSubStyleCache() prevents an in-flight call from poisoning a subsequent session
  const gateReset = armScaleGate(0.75);
  const inFlight = applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: 0.75,
    sessionKey: "s1",
  });
  await Promise.resolve();
  await gateReset.reached;

  resetSubStyleCache();
  const nextSessionCall = applySubStyle(settings, {
    assNativeActive: true,
    imageNativeActive: false,
    assScale: 0.75,
    sessionKey: "s1",
  });
  gateReset.release();
  await Promise.all([inFlight, nextSessionCall]);
  assert.equal(finalProps.get("sub-scale"), 0.75);
  assert.ok(scaleWrites.filter((v) => v === 0.75).length >= 2);
});

test("assNormalizeCacheKey distinguishes replaced external tracks even when mpv reuses track id", () => {
  assert.equal(
    assNormalizeCacheKey(false, "file:///movie.mkv", {
      id: "2",
      external: true,
      externalFilename: "a.ass",
    }),
    "",
  );
  assert.equal(
    assNormalizeCacheKey(true, null, { id: "2", external: true, externalFilename: "a.ass" }),
    "",
  );
  assert.equal(assNormalizeCacheKey(true, "file:///movie.mkv", null), "");

  const origKey = assNormalizeCacheKey(true, "file:///movie.mkv", {
    id: "2",
    external: true,
    externalFilename: "C:\\temp\\orig.ass",
  });
  const replacedKey = assNormalizeCacheKey(true, "file:///movie.mkv", {
    id: "2",
    external: true,
    externalFilename: "C:/temp/autosync_abc.ass",
  });
  const samePathDifferentSlashes = assNormalizeCacheKey(true, "file:///movie.mkv", {
    id: "2",
    external: true,
    externalFilename: "C:/temp/orig.ass",
  });

  assert.notEqual(origKey, "");
  assert.notEqual(origKey, replacedKey);
  assert.equal(origKey, samePathDifferentSlashes);

  const embeddedKey = assNormalizeCacheKey(true, "file:///movie.mkv", {
    id: "1",
    external: false,
  });
  assert.equal(embeddedKey, "file:///movie.mkv|1|0|");
});
