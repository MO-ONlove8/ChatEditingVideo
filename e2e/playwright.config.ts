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
      testMatch: /(?:web|media)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' },
    },
    {
      name: 'desktop',
      testMatch: /desktop\.spec\.ts/,
    },
    {
      name: 'states',
      testMatch: /states\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://127.0.0.1:5190' },
    },
    ...(process.env.CEV_E2E_REAL_API
      ? [
          {
            name: 'media-live',
            testMatch: /media-live\.spec\.ts/,
            use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' },
          },
          {
            name: 'editing-live',
            testMatch: /editing-live\.spec\.ts/,
            use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:4173' },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: 'pnpm --filter @cev/web preview',
      url: 'http://localhost:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @cev/web exec vite --host 127.0.0.1 --port 5190',
      url: 'http://127.0.0.1:5190',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
