import test from "node:test";
import assert from "node:assert/strict";
import { compareQualitySpeedTypechecks } from "../../scripts/check/check-quality-speed-typecheck.mjs";

const diagnostic = (message) => `src/shared/components/Header.tsx(60,3): error TS2353: Object literal may only specify known properties, and 'settings' does not exist in type '${message}'.\n`;

test("union display order does not fabricate a new TypeScript error", () => {
  const result = compareQualitySpeedTypechecks(diagnostic('Partial<Record<"logs" | "cache", string>>'), diagnostic('Partial<Record<"cache" | "logs", string>>'), 2, 2);
  assert.equal(result.passed, true);
  assert.deepEqual(result.regressions, []);
  assert.equal(result.baselineErrors, 1);
  assert.equal(result.currentErrors, 1);
});

test("new per-file or per-code diagnostics remain regressions", () => {
  const existing = diagnostic('Existing');
  const result = compareQualitySpeedTypechecks(existing, existing + "src/lib/playground/chatRequest.ts(12,3): error TS2304: Cannot find name 'missing'.\n", 2, 2);
  assert.equal(result.passed, false);
  assert.equal(result.regressions.length, 1);
  assert.equal(result.regressions[0].code, "TS2304");
});

test("a second occurrence of an existing error code is a regression", () => {
  assert.equal(compareQualitySpeedTypechecks(diagnostic('A'), diagnostic('B') + diagnostic('C'), 2, 2).passed, false);
});

test("timeouts and compiler crashes cannot pass an empty log", () => {
  for (const code of [1, 124, 137, 143]) {
    assert.equal(compareQualitySpeedTypechecks("", "", 0, code).passed, false);
    assert.equal(compareQualitySpeedTypechecks("", "", code, 0).passed, false);
  }
});
