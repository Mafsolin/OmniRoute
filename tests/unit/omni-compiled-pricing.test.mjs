import test from "node:test";
import assert from "node:assert/strict";
import { variants, deploymentOptions, pricingLookups } from "../helpers/omniPerformanceHarness.mjs";

for (const kind of variants)
  test(
    kind + ": pricing lookup uses cache without local variable shadowing",
    kind === "deployment" ? deploymentOptions : {},
    async () => {
      let hits = 0;
      for (const h of pricingLookups(kind, async () => {
        hits++;
        return { "test-provider": { "test.model": { input: 1, output: 2 } } };
      })) {
        const before = hits;
        const result = await h.lookup("TEST-PROVIDER", "TEST.MODEL");
        assert.equal(result.input, 1, h.name);
        assert.equal(hits - before, 1, h.name);
      }
    }
  );
