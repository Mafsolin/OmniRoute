import { defineConfig, devices } from '@playwright/test';

// Dedicated isolated staging runner: never inherit prod URL/auth/onboarding/autobuild.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['omni-user-delivery.spec.ts', 'omni-admin-speed.spec.ts', 'omni-load-degradation.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  expect: { timeout: 5000 },
  globalSetup: './scripts/ops/quality-load-probe.mjs',
  outputDir: 'test-results/omni-quality',
  reporter: [['list'], ['html', { outputFolder: 'test-results/omni-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:20138',
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      launchOptions: {
        ...(process.env.OMNIROUTE_QUALITY_CHROMIUM_PATH ? { executablePath: process.env.OMNIROUTE_QUALITY_CHROMIUM_PATH } : {}),
      },
    },
  }],
});
