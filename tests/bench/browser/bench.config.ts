import { defineConfig, devices } from '@playwright/test';

/**
 * Browser benchmark configuration.
 *
 * Deliberately separate from `playwright.config.ts`: this suite measures a
 * production build and reports numbers, it never gates a change. `npm run
 * test:e2e` still runs only the end-to-end suite, and `npm run bench` (Vitest)
 * still runs only the Node benchmark files.
 *
 * Run with `npm run bench:browser` (which builds first and serves `dist/`).
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.bench.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    // A fixed viewport keeps four-panel pane sizes identical between runs.
    viewport: { width: 1600, height: 1000 },
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
    // `npm run bench:browser` builds first, so this only serves the static build.
    // A dedicated port keeps it from colliding with an e2e run.
    command: 'npm run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
