// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function harness() {
  const store = new Map<string, string>();
  const localStorageMock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
  };
  const mocks: Record<string, unknown> = {
    "./cw-profile": { privateCwProfileId: () => null },
  };
  const output = ts.transpileModule(read("src/lib/resume.ts"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const module = { exports: {} as any };
  new Function("require", "module", "exports", "localStorage", output)(
    (name: string) => {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
      return mocks[name];
    },
    module,
    module.exports,
    localStorageMock,
  );
  return {
    api: module.exports as typeof import("../src/lib/resume"),
    store,
  };
}

test("saveResumeMs stores entry with displaySeason and preserves s when displaySeason is undefined", () => {
  const h = harness();
  // Season 1 raw, Episode 5, Display season 2 (e.g. Edgerunners season 2)
  h.api.saveResumeMs("kitsu:50016", 794664, 1, 5, 2);

  const rawJson = h.store.get("harbor.resume")!;
  assert.ok(rawJson, "harbor.resume storage must exist");
  const parsed = JSON.parse(rawJson);

  assert.ok(parsed["kitsu:50016|s1e5"], "Raw season key must be written");
  assert.equal(parsed["kitsu:50016|s1e5"].ms, 794664);
  assert.equal(parsed["kitsu:50016|s1e5"].s, 2);

  // Subsequent saveResumeMs with undefined displaySeason (e.g. closePlayer) preserves existing s
  h.api.saveResumeMs("kitsu:50016", 800000, 1, 5, undefined);
  const updated = JSON.parse(h.store.get("harbor.resume")!);
  assert.equal(updated["kitsu:50016|s1e5"].ms, 800000);
  assert.equal(updated["kitsu:50016|s1e5"].s, 2, "existing.s must be preserved when displaySeason is undefined");
});

test("readResumeEntry falls back to match entries with s: displaySeason when key season differs", () => {
  const h = harness();
  // Simulate data where only raw season key kitsu:50016|s1e5 was saved with s: 2
  const legacyStore = {
    "kitsu:50016|s1e5": {
      ms: 794664,
      t: Date.now(),
      s: 2,
    },
  };
  h.store.set("harbor.resume", JSON.stringify(legacyStore));

  // Look up using canonical season 2 (as ContinueCard or CW does)
  const entry = h.api.readResumeEntry("kitsu:50016", 2, 5);
  assert.ok(entry, "Should resolve entry via fallback displaySeason s match");
  assert.equal(entry.ms, 794664);
  assert.equal(entry.s, 2);

  // readResumeMs should also return 794664
  assert.equal(h.api.readResumeMs("kitsu:50016", 2, 5), 794664);
});

test("lastPlayedEpisode prefers canonical entry over alias key", () => {
  const h = harness();
  const now = Date.now();
  const store = {
    "kitsu:50016|s2e5": {
      ms: 794664,
      t: now + 100,
      s: 2,
    },
    "kitsu:50016|s1e5": {
      ms: 794664,
      t: now,
      s: 2,
    },
  };
  h.store.set("harbor.resume", JSON.stringify(store));

  const best = h.api.lastPlayedEpisode("kitsu:50016");
  assert.ok(best);
  assert.equal(best.season, 1, "lastPlayedEpisode must prefer entry-relative season 1 over alias season 2");
  assert.equal(best.episode, 5);
  assert.equal(best.displaySeason, 2);
});

test("clearResume deletes both raw and display season alias entries", () => {
  const h = harness();
  const now = Date.now();
  const store = {
    "kitsu:50016|s2e5": {
      ms: 794664,
      t: now,
      s: 2,
    },
    "kitsu:50016|s1e5": {
      ms: 794664,
      t: now,
      s: 2,
    },
  };
  h.store.set("harbor.resume", JSON.stringify(store));

  // Clear by display season
  h.api.clearResume("kitsu:50016", 2, 5);
  const parsed = JSON.parse(h.store.get("harbor.resume")!);
  assert.equal(parsed["kitsu:50016|s2e5"], undefined);
  assert.equal(parsed["kitsu:50016|s1e5"], undefined);
});
