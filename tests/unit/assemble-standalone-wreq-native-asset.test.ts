import test from "node:test";
import assert from "node:assert/strict";

const { NATIVE_ASSET_ENTRIES } = await import("../../scripts/build/assembleStandalone.mjs");

test("standalone packaging includes the Linux x64 wreq-js native binding", () => {
  const entry = NATIVE_ASSET_ENTRIES.find(
    (candidate) => candidate.label === "wreq-js Linux x64 native binding"
  );

  assert.ok(entry);
  assert.deepEqual(entry.src, ["node_modules", "@wreq-js", "binding-linux-x64-gnu"]);
  assert.deepEqual(entry.dest, ["node_modules", "@wreq-js", "binding-linux-x64-gnu"]);
});
