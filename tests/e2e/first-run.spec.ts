import { expect, test } from '@playwright/test';
import { readStore, seedLegacyLibrary } from './fixtures/library';

/**
 * The first-run and migration behaviour.
 *
 * The application no longer bundles synthetic demo series. A browser that ran
 * an earlier build still holds them, and they are removed on load without
 * touching a single imported or downloaded record. A fresh profile starts
 * empty and says so.
 */

test.describe('first run and removal of the bundled demo series', () => {
  test('a fresh profile contains no demo series and no invented prices', async ({ page }) => {
    await page.goto('/data');

    await expect(page.locator('.shell-nav')).toContainText('0 datasets loaded');
    await expect(page.getByText('ATX')).toHaveCount(0);
    await expect(page.getByText('MLAB-IDX')).toHaveCount(0);
    await expect(page.locator('table.data tbody tr')).toHaveCount(0);

    const stored = await readStore(page, 'datasets');
    expect(stored).toEqual([]);
  });

  test('removes the bundled demo series from an existing browser profile and keeps imported data', async ({ page }) => {
    await seedLegacyLibrary(page);

    // The imported series survives; the demo series is gone from the library.
    await expect(page.locator('.shell-nav')).toContainText('1 dataset loaded');
    await expect(page.getByText('ATX')).toHaveCount(0);
    await expect(page.locator('table.data tbody tr').filter({ hasText: 'ACME' })).toHaveCount(1);

    // The storage itself is clean: the demo dataset, its bars and its
    // instrument are removed, the imported ones are untouched.
    const datasets = await readStore(page, 'datasets');
    expect(datasets.map((entry) => entry.id)).toEqual(['ds_acme']);
    const bars = await readStore(page, 'bars');
    expect(bars.map((entry) => entry.id)).toEqual(['ds_acme']);
    const instruments = await readStore(page, 'instruments');
    expect(instruments.map((entry) => entry.id)).toEqual(['inst_acme']);
  });

  test('does not leave broken references to the removed demo series', async ({ page }) => {
    await seedLegacyLibrary(page);

    // The cleanup runs after the first load reads IndexedDB. Wait for the
    // migrated state to reach the shell before reading storage directly,
    // otherwise this assertion races the asynchronous migration.
    await expect(page.locator('.shell-nav')).toContainText('1 dataset loaded');

    // The workspace pointed at the demo series, so it is removed rather than
    // left pointing at a dataset that no longer exists.
    const workspaces = await readStore(page, 'workspaces');
    expect(workspaces).toEqual([]);

    // The demo watchlist only held demo instruments and is removed with them.
    const watchlists = await readStore(page, 'watchlists');
    expect(watchlists).toEqual([]);

    // The saved strategy ran on the demo series and cannot be simulated.
    const backtests = await readStore(page, 'backtests');
    expect(backtests).toEqual([]);

    // The chart workspace has no panel left to render, and says so.
    await page.goto('/chart');
    await expect(page.getByRole('button', { name: 'Create a workspace' })).toBeVisible();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(0);
  });

  test('does not recreate the demo series after a reload', async ({ page }) => {
    await seedLegacyLibrary(page);
    await page.reload();
    await page.goto('/data');

    await expect(page.locator('.shell-nav')).toContainText('1 dataset loaded');
    await expect(page.getByText('ATX')).toHaveCount(0);

    const datasets = await readStore(page, 'datasets');
    expect(datasets.map((entry) => entry.id)).toEqual(['ds_acme']);
  });

  test('guides the user on every screen that needs data', async ({ page }) => {
    const screens: Array<{ route: string; heading: string }> = [
      { route: '/', heading: 'Welcome to MarketLab' },
      { route: '/chart', heading: 'Nothing to chart yet' },
      { route: '/quant', heading: 'No market data to analyse' },
      { route: '/screener', heading: 'No market data to screen' },
      { route: '/backtest', heading: 'No market data to simulate' },
      { route: '/data', heading: 'No datasets stored' },
    ];

    for (const screen of screens) {
      await page.goto(screen.route);
      const panel = page.locator('.panel').filter({ hasText: screen.heading }).first();
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Download real market data' })).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Import a CSV file' })).toBeVisible();
    }
  });

  test('explains how to start the local service when it is not running', async ({ page }) => {
    await page.goto('/data');

    const panel = page.locator('.panel').filter({ hasText: 'No datasets stored' }).first();
    await expect(panel).toContainText('127.0.0.1:8787');
    await expect(panel).toContainText('uvicorn app:app --port 8787');
    // The limitations of provider data stay visible next to the action.
    await expect(panel).toContainText('never real-time');
  });
});
