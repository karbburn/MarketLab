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

/** A provider response for one symbol, with prices distinct per symbol. */
function symbolPayload(symbol: string): unknown {
  const offset = symbol.charCodeAt(0) % 7;
  const bars = HISTORY_BARS.map((bar) => ({
    ...bar,
    open: bar.open + offset,
    high: bar.high + offset,
    low: bar.low + offset,
    close: bar.close + offset,
    adjClose: bar.adjClose + offset,
  }));
  return {
    provider: {
      ...PROVIDER_PAYLOAD.provider,
      providerSymbol: symbol,
      displaySymbol: symbol,
      displayName: `${symbol} Inc.`,
    },
    bars,
  };
}

/** Serves a provider response for whichever symbol the batch asks for. */
async function stubPerSymbol(page: Page): Promise<void> {
  await page.route('**/api/history*', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const symbol = new URL(route.request().url()).searchParams.get('symbol') ?? 'AAPL';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(symbolPayload(symbol)),
    });
  });
}

/** A provider search response, as the real service returns it for a name query. */
const SEARCH_RESULTS = [
  {
    symbol: 'GOOGL',
    name: 'Alphabet Inc.',
    exchange: 'NMS',
    exchangeName: 'NASDAQ',
    type: 'Equity',
    sector: 'Communication Services',
    industry: 'Internet Content & Information',
  },
  {
    symbol: 'GOOG',
    name: 'Alphabet Inc.',
    exchange: 'NMS',
    exchangeName: 'NASDAQ',
    type: 'Equity',
    sector: 'Communication Services',
    industry: 'Internet Content & Information',
  },
];

/**
 * Serves provider symbol suggestions and records the queries the app sent, so a
 * test can prove the search used the typed token rather than the whole field.
 */
async function stubSearch(page: Page, results: unknown[] = SEARCH_RESULTS): Promise<string[]> {
  const queries: string[] = [];
  await page.route('**/api/search*', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS_HEADERS });
      return;
    }
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    queries.push(query);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ provider: 'yahoo-finance', query, results }),
    });
  });
  return queries;
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
    // The error is also the control's accessible description, not only a
    // neighbouring line of text.
    await expect(dialog.getByLabel('Symbol')).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByLabel('Symbol')).toHaveAccessibleDescription(/Use a provider symbol/i);
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

  test('presents symbol suggestions as a plain list of buttons', async ({ page }) => {
    const queries = await stubSearch(page);
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });

    await dialog.getByLabel('Symbol').fill('google');
    await expect.poll(() => queries.length, { message: 'the dialog should ask the provider' }).toBeGreaterThan(0);

    const suggestions = dialog.locator('.suggestion-list');
    await expect(suggestions).toBeVisible();
    // A list of independent buttons, not a listbox that claims arrow-key
    // navigation it does not implement.
    await expect(suggestions.getByRole('listbox')).toHaveCount(0);
    await expect(suggestions.getByRole('option')).toHaveCount(0);

    await suggestions.getByRole('button', { name: /GOOGL/ }).click();
    await expect(dialog.getByLabel('Symbol')).toHaveValue('GOOGL');
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

  test('returns to the download form when reopened after a successful save', async ({ page }) => {
    await stubService(page, PROVIDER_PAYLOAD);
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });

    await dialog.getByLabel('Symbol').fill('AAPL');
    await dialog.getByRole('button', { name: 'Download' }).click();
    await dialog.getByRole('button', { name: 'Save dataset' }).click();
    await expect(dialog).toBeHidden();

    // Reopening starts a new download instead of restoring the saved review.
    await page.getByRole('button', { name: 'Download market data' }).click();
    await expect(dialog.getByLabel('Symbol')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('button', { name: 'Save dataset' })).toHaveCount(0);
    await expect(dialog.getByText('Yahoo Finance download', { exact: true })).toHaveCount(0);
  });

  test('ignores an abandoned download when a newer one is started', async ({ page }) => {
    await page.route('**/api/history*', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS_HEADERS });
        return;
      }
      const symbol = new URL(route.request().url()).searchParams.get('symbol') ?? 'AAPL';
      if (symbol === 'SLOW') await new Promise((resolve) => setTimeout(resolve, 1200));
      try {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify(symbolPayload(symbol)),
        });
      } catch {
        // The dialog aborted this request; a late body has nowhere to go.
      }
    });

    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });

    await dialog.getByLabel('Symbol').fill('SLOW');
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();
    await expect(dialog.getByText(/Requesting daily history for SLOW/i)).toBeVisible();

    // Abandon the slow request, then ask for a different series.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Download market data' }).click();
    await dialog.getByLabel('Symbol').fill('FAST');
    await dialog.getByRole('button', { name: 'Download', exact: true }).click();

    await expect(dialog.getByText('FAST - daily (Yahoo Finance download)')).toBeVisible();

    // Past the slow response time the review still describes the newer request.
    await page.waitForTimeout(1600);
    await expect(dialog.getByText('FAST - daily (Yahoo Finance download)')).toBeVisible();
    await expect(dialog.getByText(/SLOW - daily/)).toHaveCount(0);
  });
});

test.describe('bulk market data download', () => {
  /** Both the empty-library panel and the library header offer this action. */
  function openBulkDialog(page: Page) {
    return page.getByRole('button', { name: 'Download many symbols', exact: true }).first();
  }

  test('plans a pasted batch, reporting duplicates and invalid tokens', async ({ page }) => {
    await page.goto('/#/data');
    await openBulkDialog(page).click();
    const dialog = page.getByRole('dialog', { name: 'Download many symbols' });
    await expect(dialog).toBeVisible();

    await dialog.locator('#bulk-symbols').fill('aapl, MSFT\naapl\n??bad??');

    // Two valid symbols, one folded repeat, one rejected token.
    await expect(dialog.getByText(/2 symbols ready/)).toBeVisible();
    await expect(dialog.getByText(/1 duplicate\(s\) removed/)).toBeVisible();
    await expect(dialog.getByText(/Ignored: \?\?bad\?\?/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download 2 symbols' })).toBeEnabled();
  });

  test('suggests tickers for a company name and replaces only that line', async ({ page }) => {
    const queries = await stubSearch(page);
    await page.goto('/#/data');
    await openBulkDialog(page).click();
    const dialog = page.getByRole('dialog', { name: 'Download many symbols' });
    const field = dialog.locator('#bulk-symbols');

    await field.fill('amzn\ngoogle');
    const list = dialog.getByRole('listbox', { name: 'Symbol suggestions' });
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(2);
    await expect(list.getByRole('option').first()).toContainText('GOOGL');
    await expect(list.getByRole('option').first()).toContainText('Alphabet Inc.');

    // Only the token under the caret is searched, never the whole batch.
    expect(queries).toEqual(['google']);

    await list.getByRole('option', { name: /GOOGL/ }).click();

    // The pick replaces "google" and leaves the symbol already typed intact.
    await expect(field).toHaveValue('amzn\nGOOGL, ');
    await expect(list).toBeHidden();
    await expect(dialog.getByText(/2 symbols ready/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download 2 symbols' })).toBeEnabled();
  });

  test('drives the suggestions from the keyboard without closing the dialog', async ({ page }) => {
    await stubSearch(page);
    await page.goto('/#/data');
    await openBulkDialog(page).click();
    const dialog = page.getByRole('dialog', { name: 'Download many symbols' });
    const field = dialog.locator('#bulk-symbols');
    const list = dialog.getByRole('listbox', { name: 'Symbol suggestions' });

    await field.fill('google');
    await expect(list).toBeVisible();

    const options = list.getByRole('option');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    // The list wraps rather than trapping focus on the last option.
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Enter');
    await expect(field).toHaveValue('GOOGL, ');

    // A new query reopens the list. The first Escape only dismisses it, which
    // is the standard behaviour of a combobox inside a dialog.
    await field.fill('google');
    await expect(list).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('stores every symbol of a batch and reports each result', async ({ page }) => {
    await stubPerSymbol(page);
    await page.goto('/#/data');
    await openBulkDialog(page).click();
    const dialog = page.getByRole('dialog', { name: 'Download many symbols' });
    await dialog.locator('#bulk-symbols').fill('AAPL, MSFT');
    await dialog.getByRole('button', { name: 'Download 2 symbols' }).click();

    await expect(dialog.getByText(/2 saved, 0 failed\./)).toBeVisible();
    await expect(page.locator('.shell-nav')).toContainText('2 datasets loaded');

    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    for (const symbol of ['AAPL', 'MSFT']) {
      const row = page.locator('table.data tbody tr').filter({ hasText: symbol });
      await expect(row).toContainText('Yahoo Finance');
      await expect(row).toContainText('2026-09-17');
    }
  });

  test('reports an unreachable service per symbol and stores nothing', async ({ page }) => {
    // Aborted on purpose so the assertion holds whether or not the local
    // service happens to be running on this machine.
    await page.route('**/api/history*', (route) => route.abort());
    await page.goto('/#/data');
    await openBulkDialog(page).click();
    const dialog = page.getByRole('dialog', { name: 'Download many symbols' });
    await dialog.locator('#bulk-symbols').fill('AAPL, MSFT');
    await dialog.getByRole('button', { name: 'Download 2 symbols' }).click();

    // Every symbol is reported individually; the batch does not abort early
    // and no series is substituted for a failure.
    await expect(dialog.getByText(/0 saved, 2 failed\./)).toBeVisible();
    await expect(dialog.getByText('Failed', { exact: true })).toHaveCount(2);
    await expect(dialog.getByText(/market-data service is not reachable/i).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Retry failed (2)' })).toBeVisible();
    await expect(page.locator('.shell-nav')).toContainText('0 datasets loaded');
  });

  test('retries only the failed symbols and stores them when the provider recovers', async ({ page }) => {
    const attempts = new Map<string, number>();
    await page.route('**/api/history*', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: CORS_HEADERS });
        return;
      }
      const symbol = new URL(route.request().url()).searchParams.get('symbol') ?? 'AAPL';
      const attempt = (attempts.get(symbol) ?? 0) + 1;
      attempts.set(symbol, attempt);
      if (attempt === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ detail: 'The provider is temporarily unavailable.' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(symbolPayload(symbol)),
      });
    });

    await page.goto('/#/data');
    await openBulkDialog(page).click();
    const dialog = page.getByRole('dialog', { name: 'Download many symbols' });
    await dialog.locator('#bulk-symbols').fill('AAPL, MSFT');
    await dialog.getByRole('button', { name: 'Download 2 symbols' }).click();

    await expect(dialog.getByText(/0 saved, 2 failed\./)).toBeVisible();
    await expect(page.locator('.shell-nav')).toContainText('0 datasets loaded');

    // Retry requests only the two failed symbols, and both now succeed.
    await dialog.getByRole('button', { name: 'Retry failed (2)' }).click();
    await expect(dialog.getByText(/2 saved, 0 failed\./)).toBeVisible();
    await expect(page.locator('.shell-nav')).toContainText('2 datasets loaded');
    expect([...attempts.entries()]).toEqual([
      ['AAPL', 2],
      ['MSFT', 2],
    ]);
  });
});
