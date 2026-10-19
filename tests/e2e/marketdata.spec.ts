import { expect, test, type Page } from '@playwright/test';

/**
 * Market-data download workflow.
 *
 * The optional local market-data service is not part of the end-to-end
 * environment, so the success path is served by a stubbed provider response
 * and the failure path is the real one: the service is simply not there.
 * Both paths must be explicit — a failed download never becomes a dataset and
 * never falls back to other data.
 */

const HISTORY_BARS = [
  { date: '2026-09-14', open: 228.1, high: 231.4, low: 227.6, close: 230.2, adjClose: 230.2, volume: 41_000_000 },
  { date: '2026-09-15', open: 230.4, high: 232.9, low: 229.1, close: 231.8, adjClose: 231.8, volume: 38_500_000 },
  { date: '2026-09-16', open: 231.9, high: 233.2, low: 228.4, close: 229.6, adjClose: 229.6, volume: 44_200_000 },
  { date: '2026-09-17', open: 229.7, high: 234.5, low: 229.2, close: 233.9, adjClose: 233.9, volume: 39_800_000 },
];

const PROVIDER_PAYLOAD = {
  provider: {
    provider: 'yahoo-finance',
    providerSymbol: 'AAPL',
    displaySymbol: 'AAPL',
    displayName: 'Apple Inc.',
    exchange: 'NMS',
    exchangeName: 'NasdaqGS',
    instrumentType: 'EQUITY',
    currency: 'USD',
    timezone: 'America/New_York',
    interval: '1d',
    adjustment: 'Splits applied, dividends not reinvested',
    rangeRequested: { start: '2026-09-01', end: '2026-10-16' },
    rangeActual: { start: '2026-09-14', end: '2026-09-17' },
    retrievedAt: '2026-10-16T21:00:00Z',
    sourceNotes: ['Yahoo Finance is an unofficial source and may be delayed.'],
  },
  bars: HISTORY_BARS,
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
};

/** Serves a stubbed provider response for the local service. */
async function stubService(page: Page, body: unknown, status = 200): Promise<void> {
  await page.route('**/api/history*', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    });
  });
  await page.route('**/api/search*', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ results: [] }),
    });
  });
}

test.describe('market data download', () => {
  test('explains the unreachable service instead of failing silently', async ({ page }) => {
    // The request is aborted on purpose so the assertion holds whether or not
    // the local service happens to be running on this machine.
    await page.route('**/api/history*', (route) => route.abort());
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Symbol').fill('AAPL');
    await dialog.getByRole('button', { name: 'Download' }).click();

    await expect(
      dialog.getByText(/market-data service is not reachable/i),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save dataset' })).toBeHidden();

    // Nothing was stored and no other series was substituted for the failure.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.shell-nav')).toContainText('0 datasets loaded');
  });

  test('rejects an invalid symbol without contacting anything', async ({ page }) => {
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Symbol').fill('?? bad ??');
    await expect(dialog.getByText(/Use a provider symbol/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download' })).toBeDisabled();
  });

  test('offers sensible starting symbols for a first download', async ({ page }) => {
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });

    for (const symbol of ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ']) {
      await expect(dialog.getByRole('button', { name: symbol, exact: true })).toBeVisible();
    }

    await dialog.getByRole('button', { name: 'MSFT', exact: true }).click();
    await expect(dialog.getByLabel('Symbol')).toHaveValue('MSFT');
  });

  test('stores a downloaded series with its provider and provenance', async ({ page }) => {
    await stubService(page, PROVIDER_PAYLOAD);
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });

    await dialog.getByLabel('Symbol').fill('AAPL');
    await dialog.getByRole('button', { name: 'Download' }).click();

    // The download is reviewed before it is stored, with its provenance.
    await expect(dialog.getByText('Yahoo Finance download', { exact: true })).toBeVisible();
    await expect(dialog.getByText('NasdaqGS')).toBeVisible();
    await expect(dialog.getByText('Splits applied, dividends not reinvested')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save dataset' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.locator('.shell-nav')).toContainText('1 dataset loaded');
    const row = page.locator('table.data tbody tr').filter({ hasText: 'AAPL' });
    await expect(row).toContainText('Yahoo Finance');
    await expect(row).toContainText('2026-09-17');
  });

  test('reports a provider failure without storing anything', async ({ page }) => {
    await stubService(page, { detail: 'No data is available for this symbol and range.' }, 404);
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });

    await dialog.getByLabel('Symbol').fill('ZZZZ');
    await dialog.getByRole('button', { name: 'Download' }).click();

    await expect(dialog.getByText(/No data is available for this symbol and range/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save dataset' })).toBeHidden();
    await expect(page.locator('.shell-nav')).toContainText('0 datasets loaded');
  });
});
