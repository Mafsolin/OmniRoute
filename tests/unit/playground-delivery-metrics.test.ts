import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryTracker } from "../../src/lib/playground/deliveryMetrics.ts";

test("unknown usage and reasoning counts never become precise visible TPS or fake cost", () => {
  let now = 0;
  const t = new DeliveryTracker(() => now);
  for (let i = 1; i <= 10; i++) { now = i * 500; t.text(); }
  now = 6000;
  const absent = t.finish({}, { inUsdPer1k: 1, outUsdPer1k: 2, estimated: true });
  assert.equal(absent.tps, null);
  assert.equal(absent.costUsd, null);
  assert.equal(absent.visibleTokens, null);
  assert.equal(absent.visibleTps, null);
  assert.equal(absent.tpsKind, "unknown");
  const noReasoningCount = t.finish({ completion_tokens: 900 });
  assert.equal(noReasoningCount.visibleTokens, null);
  assert.equal(noReasoningCount.visibleTps, null);
});
test("visible delivery excludes reasoning and uses the matching text interval", () => {
  let now = 0;
  const t = new DeliveryTracker(() => now);
  now = 50; t.reasoning();
  for (let i = 1; i <= 9; i++) { now = 1000 + (i - 1) * 500; t.text(); }
  now = 5500;
  const result = t.finish({ completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 300 } });
  assert.equal(result.visibleTokens, 200);
  assert.equal(result.reasoningTokens, 300);
  assert.equal(result.visibleTps, 50);
  assert.equal(result.tpsKind, "delivery");
});
test("metered zero conflicting with observed reasoning and tool output never imply exact text tokens", () => {
  for (const nonText of ["reasoning", "tool"] as const) {
    let now = 0; const t = new DeliveryTracker(() => now);
    now = 50; t[nonText]();
    for (let i = 1; i <= 9; i++) { now = 1000 + (i - 1) * 500; t.text(); }
    now = 5500;
    const result = t.finish({ completion_tokens: 500, completion_tokens_details: { reasoning_tokens: 0 } });
    assert.equal(result.visibleTokens, null, nonText);
    assert.equal(result.visibleTps, null, nonText);
  }
});
