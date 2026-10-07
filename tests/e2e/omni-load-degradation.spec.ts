import { test, expect } from '@playwright/test';
// Node transport probe deliberately uses actual staging request-serving routes, not page.route mocks.
import { runStageProbe, STAGE_URL } from '../../scripts/ops/quality-load-probe.mjs';

for (const concurrency of [1, 4, 8]) {
  test(`F2 synthetic gateway degradation at concurrency ${concurrency}`, async ({ baseURL }, testInfo) => {
    test.setTimeout(180_000);
    expect(baseURL, 'production/baseURL overrides are forbidden').toBe(STAGE_URL);
    const report = await runStageProbe({ concurrencies: [concurrency] });
    await testInfo.attach(`f2-concurrency-${concurrency}.json`, {
      body: Buffer.from(JSON.stringify(report, null, 2)), contentType: 'application/json',
    });
    expect(report.status, report.blocker ?? JSON.stringify(report.waves.map(w => w.assessment?.failures))).toBe('passed');
    expect(report.waves).toHaveLength(7);
    expect(report.waves.every(w => w.lifecycle?.cleanupReadback === true)).toBe(true);
  });
}
