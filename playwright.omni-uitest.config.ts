import { defineConfig, devices } from '@playwright/test';

// Post-deploy UI contract run against an EXISTING instance (stage or prod loopback).
// No webServer, no globalSetup — nothing gets built or mutated.
export default defineConfig({
  testDir: '/opt/omniroute-quality-speed-20261007/tests/e2e',
  testMatch: ['playground-compare.spec.ts', 'playground-studio.spec.ts', 'omni-user-delivery.spec.ts', 'omni-admin-speed.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 60_000 },
  outputDir: '/opt/omniroute-quality-speed-data/uitest-results',
  reporter: [['list']],
  use: {
    baseURL: process.env.OMNI_UITEST_BASE_URL || 'http://127.0.0.1:20138',
    navigationTimeout: 120_000,
    actionTimeout: 60_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
