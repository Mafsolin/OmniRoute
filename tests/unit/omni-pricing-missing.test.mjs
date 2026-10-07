import test from "node:test";
import assert from "node:assert/strict";
import { variants, deploymentOptions, pricingLookups } from "../helpers/omniPerformanceHarness.mjs";

for (const kind of variants)
  test(
    kind + ": pricing memoizes missing providers and preserves aliases",
    kind === "deployment" ? deploymentOptions : {},
    async () => {
      let scans = 0;
      const aliases = new Proxy(
        { "Long-Provider": "short" },
        {
          ownKeys(obj) {
            scans++;
            return Reflect.ownKeys(obj);
          },
        }
      );
      let snapshot;
      for (const h of pricingLookups(kind, async () => snapshot, aliases)) {
        snapshot = { short: { "mod-el": { input: 2 } }, base: { MODEL: { input: 3 } } };
        const before = scans;
        for (let i = 0; i < 20; i++)
          assert.equal(await h.lookup("missing-provider", "anything"), null, h.name);
        assert.ok(
          scans - before <= 2,
          `alias registry scanned ${scans - before} times for same missing provider: ${h.name}`
        );
        assert.equal((await h.lookup("LONG-PROVIDER", "MOD.EL")).input, 2);
        assert.equal((await h.lookup("BASE-CN", "model")).input, 3);
        snapshot = {
          "Long-Provider": { "mod-el": { input: 4 } },
          "missing-provider": { anything: { input: 9 } },
        };
        assert.equal((await h.lookup("short", "mod-el")).input, 4);
        assert.equal(
          (await h.lookup("missing-provider", "anything")).input,
          9,
          "new pricing snapshot must invalidate negative lookup"
        );
      }
    }
  );
