import { defineConfig, devices } from '@playwright/test';

/**
 * Prereq: `pnpm e2e` at the repo root builds web + desktop first.
 * First run only: `pnpm --filter @cev/e2e e2e:install` (downloads Chromium).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'web',
      testMatch: /web\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' },
    },
    {
      name: 'desktop',
      testMatch: /desktop\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'pnpm --filter @cev/web preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
