import test from "node:test";
import assert from "node:assert/strict";
import { variants, deploymentOptions, pricingLookups } from "../helpers/omniPerformanceHarness.mjs";

for (const kind of variants)
  test(
    kind + ": pricing lookup indexes each snapshot once",
    kind === "deployment" ? deploymentOptions : {},
    async () => {
      let enumerations = 0;
      const models = Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => ["model-" + i, { input: i, output: 1 }])
      );
      const snapshot = {
        "test-provider": new Proxy(models, {
          ownKeys(obj) {
            enumerations++;
            return Reflect.ownKeys(obj);
          },
        }),
      };
      for (const h of pricingLookups(kind, async () => snapshot)) {
        const before = enumerations;
        for (let i = 0; i < 20; i++)
          assert.equal((await h.lookup("TEST-PROVIDER", "MODEL-" + i)).input, i, h.name);
        assert.ok(
          enumerations - before <= 1,
          `model catalog enumerated ${enumerations - before} times; expected once per snapshot: ${h.name}`
        );
      }
    }
  );
