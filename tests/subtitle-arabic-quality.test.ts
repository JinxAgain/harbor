// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import {
  arabicMatchIncludes,
  normalizeArabicForMatch,
} from "../src/lib/subtitles/arabic-normalize.ts";
import {
  analyzeArabicSubtitleQuality,
  cleanupArabicCuesSafely,
  cleanupArabicSubtitleTextSafely,
} from "../src/lib/subtitles/arabic-quality.ts";

test("Arabic matching folds marks, letters, digits, punctuation, and direction controls", () => {
  const dirty = "\u061Cإِعْلَانـ، سَنَة ٢٠٢٤ و کِتاب ۱۲۳؟";
  assert.equal(normalizeArabicForMatch(dirty), "اعلان سنة 2024 و كتاب 123");
  assert.equal(arabicMatchIncludes(dirty, "اعلان سنة 2024"), true);
});

test("matching normalization never mutates display text", () => {
  const display = "﴿السَّلَامُ عَلَيْكُمْ﴾";
  const before = display.slice();
  assert.equal(normalizeArabicForMatch(display), "السلام عليكم");
  assert.equal(display, before);
});

test("healthy Arabic cues produce explicit quality diagnostics", () => {
  const cues = [
    { start: 1, end: 3, text: "مرحبا بكم" },
    { start: 4, end: 6, text: "كيف حالكم؟" },
  ];
  const quality = analyzeArabicSubtitleQuality("", cues);
  assert.equal(quality.healthy, true);
  assert.equal(quality.arabicCueRatio, 1);
  assert.equal(quality.issues.length, 0);
});

test("malformed timing, overlap, damaged text, speed, and bidi imbalance are reported", () => {
  const raw = "00:broken --> timing\n\u202Bنص\uFFFD\u0001";
  const cues = [
    { start: 1, end: 1.2, text: "هذا سطر عربي طويل جدا وسريع للغاية\nسطر ثان\nسطر ثالث" },
    { start: 1.1, end: 2, text: "\u202Bنص" },
    { start: 3, end: 2, text: "" },
  ];
  const quality = analyzeArabicSubtitleQuality(raw, cues, { encodingHealthy: false });
  assert.equal(quality.healthy, false);
  assert.equal(quality.encodingHealthy, false);
  assert.equal(quality.malformedBlockCount, 1);
  assert.equal(quality.malformedCueCount, 2);
  assert.equal(quality.overlapCount, 1);
  assert.equal(quality.overlappingCueCount, 1);
  assert.equal(quality.invalidTimingCount, 1);
  assert.ok(quality.fastReadingCueCount >= 1);
  assert.ok(quality.excessiveReadingSpeedCount >= 1);
  assert.equal(quality.unbalancedBidiControlCount, 1);
  assert.equal(quality.rtlControlIssues, 1);
  assert.ok(quality.issues.some((issue) => issue.code === "replacement-characters"));
});

test("safe cleanup removes only invalid controls and normalizes whitespace", () => {
  const balanced = "\u202Bنص\u202C";
  const raw = `${balanced}\u202B\u200B  كلمة\u00A0  أخرى`;
  const result = cleanupArabicSubtitleTextSafely(raw);
  assert.match(result.text, /^\u202Bنص\u202C/u);
  assert.equal(result.text.includes("\u200B"), false);
  assert.equal(result.text.includes("\u202B\u200B"), false);
  assert.match(result.text, /كلمة أخرى$/u);
  assert.equal(result.removedInvalidBidiControls, 1);

  const cues = cleanupArabicCuesSafely([{ start: 0, end: 1, text: "  نص  عربي  " }]);
  assert.deepEqual(cues, [{ start: 0, end: 1, text: "نص عربي" }]);
});
