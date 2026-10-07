import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "omni-pricing-cache-"));
process.env.DATA_DIR = data;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
fs.mkdirSync(data, { recursive: true });
const core = await import("../../src/lib/db/core.ts");
const cache = await import("../../src/lib/db/readCache.ts");
const pricing = await import("../../src/lib/db/settings/pricing.ts");
test.beforeEach(() => {
  core.resetDbInstance();
  cache.invalidateDbCache("pricing");
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(data, { recursive: true, force: true });
});
test("model lookups share the 30s pricing cache instead of rebuilding every layer", async () => {
  const db = core.getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)").run(
    "pricing",
    "perf-provider",
    JSON.stringify({ "perf-model": { input: 1, output: 2 } })
  );
  const spy = mock.method(db, "prepare");
  for (let i = 0; i < 10; i++)
    assert.deepEqual(await pricing.getPricingForModel("PERF-PROVIDER", "PERF-MODEL"), {
      input: 1,
      output: 2,
    });
  const reads = spy.mock.calls.filter((c) =>
    String(c.arguments[0]).includes("SELECT key, value FROM key_value WHERE namespace = ?")
  ).length;
  spy.mock.restore();
  assert.ok(reads <= 3, `pricing namespace reads: ${reads}; expected <=3 for 10 model lookups`);
});
test("pricing edits invalidate model lookup cache", async () => {
  await pricing.updatePricing({ "perf-provider": { "perf-model": { input: 1, output: 2 } } });
  assert.equal((await pricing.getPricingForModel("perf-provider", "perf-model")).input, 1);
  await pricing.updatePricing({ "perf-provider": { "perf-model": { input: 3 } } });
  assert.equal((await pricing.getPricingForModel("perf-provider", "perf-model")).input, 3);
});
test("pricing reset invalidates cached per-model prices", async () => {
  await pricing.updatePricing({ "perf-provider": { "perf-model": { input: 1 } } });
  await pricing.getPricingForModel("perf-provider", "perf-model");
  await pricing.resetPricing("perf-provider", "perf-model");
  assert.equal(await pricing.getPricingForModel("perf-provider", "perf-model"), null);
});
test("resetAllPricing invalidates cached per-model prices", async () => {
  await pricing.updatePricing({ "perf-provider": { "perf-model": { input: 1 } } });
  await pricing.getPricingForModel("perf-provider", "perf-model");
  await pricing.resetAllPricing();
  assert.equal(await pricing.getPricingForModel("perf-provider", "perf-model"), null);
});
test('canonical -cn provider fallback is not poisoned by an earlier unknown alias lookup', async () => {
  await pricing.getPricingForModel('glmcn', 'glm-5.3-flash');
  const canonical = await pricing.getPricingForModel('glm-cn', 'glm-5.3-flash');
  assert.equal(canonical?.input, 0.075);
});
