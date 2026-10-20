import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: 'chrome',
      },
    },
  ],
  webServer: {
    // `npm run test:e2e` builds before Playwright starts, so this command only
    // serves `dist/`. The strict port guarantees the server binds the port the
    // suite and the service's CORS allow-list expect instead of shifting.
    command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    // Always start a server this suite controls. Reusing one could attach to a
    // stale bundle or a preview server from another checkout.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
