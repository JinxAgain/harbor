// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import assert from "node:assert/strict";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import { readFileSync } from "node:fs";
// @ts-expect-error Node test types are intentionally outside the browser-only tsconfig.
import test from "node:test";
import ts from "typescript";

function callback(name: string, scope: Record<string, unknown>) {
  const source = readFileSync(
    new URL("../src/views/player/hooks/use-auto-sync.ts", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(ast) === name &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    )
      found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, `${name} must exist`);
  const compiled = ts.transpileModule(`const callback = ${found.getText(ast)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(scope), `${compiled}; return callback;`)(
    ...Object.values(scope),
  );
}

test("manual timing cancels background work without reverting the chosen delay", () => {
  let disposed = 0;
  let canRevert = true;
  const manualTimingMediaRef = { current: null as string | null };
  const statusScopeRef = { current: {} as unknown };
  const appliedRef = { current: { changed: true } as unknown };
  const committingScopeRef = {
    current: null as { mediaKey: string; trackId: string } | null,
  };
  const awaitingCommitRef = { current: null as unknown };
  const scope = {
    manualTimingMediaRef,
    revertTokenRef: { current: 0 },
    statusScopeRef,
    appliedRef,
    EMPTY_APPLIED_STATE: { changed: false },
    committingScopeRef,
    awaitingCommitRef,
    srcRef: { current: "movie-A" },
    autoSyncMediaKey: (src: string) => src,
    activeDisposeRef: { current: () => disposed++ },
    setCanRevert(value: boolean) {
      canRevert = value;
    },
    setErrorMessage() {},
    setErrorAction() {},
    setStatus() {},
  };
  callback("suspendForManualTiming", scope)();
  assert.equal(disposed, 1);
  assert.equal(scope.revertTokenRef.current, 1);
  assert.equal(manualTimingMediaRef.current, "movie-A");
  assert.equal(statusScopeRef.current, null);
  assert.equal(canRevert, false);
  const isCurrent = callback("isCurrentAutoSyncScope", {
    ...scope,
    liveSnapRef: { current: { subtitleTracks: [] } },
    isSyncedTrack: () => false,
    isAutoSyncScopeCurrent: () => true,
  });
  assert.equal(
    isCurrent({ mediaKey: "movie-A", trackId: "1" }),
    false,
    "late automatic work must not overwrite manual timing even on the same track",
  );
  scope.srcRef.current = "movie-B";
  assert.equal(isCurrent({ mediaKey: "movie-B", trackId: "1" }), true);
});
