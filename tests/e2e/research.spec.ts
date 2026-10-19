import { expect, test } from '@playwright/test';

test.describe('quant lab', () => {
  test('reports risk metrics computed from the stored sessions', async ({ page }) => {
    await page.goto('/#/quant');

    const primary = page.locator('.panel').filter({ hasText: 'Risk and return' }).first();
    await expect(primary).toBeVisible();
    await expect(primary).toContainText('Sharpe');
    await expect(primary).toContainText('Max drawdown');
    await expect(primary).toContainText('VaR 95');
    // Risk-free rate and method choices are stated, not implied.
    await expect(primary).toContainText('Risk-free rate assumed at zero');

    await expect(page.getByRole('img', { name: /Normalised performance/ })).toBeVisible();
    await expect(page.getByText('Method notes')).toBeVisible();
  });

  test('builds a correlation matrix from the selected series', async ({ page }) => {
    await page.goto('/#/quant');
    await page.getByRole('button', { name: 'Select all' }).click();

    const matrix = page.locator('.panel').filter({ hasText: 'Correlation matrix' }).first();
    await expect(matrix).toContainText('shared sessions');
    // The diagonal of a real correlation matrix is exactly 1.00.
    await expect(matrix.locator('tbody tr').first()).toContainText('1.00');
  });
});

test.describe('historical screener', () => {
  test('creates a screen with a default filter and returns matching instruments', async ({ page }) => {
    await page.goto('/#/screener');

    await page.getByRole('button', { name: 'Start a new screen' }).click();
    await expect(page.getByText('of 6 series matched')).toBeVisible();

    const results = page.locator('.panel').filter({ hasText: 'Results' }).first();
    await expect(results.locator('tbody tr')).toHaveCount(6);
    // Every filter has a visible column, and unmatched rows are marked as such.
    await expect(results).toContainText('Price vs SMA');

    // Saving persists the screen into the saved list.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast-body')).toContainText('Saved screen "Untitled screen"');
    await expect(page.locator('option', { hasText: 'Untitled screen' })).toBeAttached();
  });
});

test.describe('rule-based backtest', () => {
  test('simulates the default strategy and states its execution assumptions', async ({ page }) => {
    await page.goto('/#/backtest');

    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const results = page.locator('.panel').filter({ hasText: 'Results' }).first();
    await expect(results).toContainText('Trades');
    await expect(results).toContainText('Win rate');
    await expect(results).toContainText('Buy and hold');

    await expect(page.getByRole('img', { name: 'Equity curve versus buy and hold' })).toBeVisible();

    // The trade log is the table with the per-trade columns.
    await expect(page.getByRole('columnheader', { name: 'Net PnL' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Exit price' })).toBeVisible();

    // The fill model is disclosed in the UI, not only in the source.
    const assumptions = page.locator('.panel').filter({ hasText: 'Execution assumptions' }).first();
    await expect(assumptions).toContainText('fill at the next session');
    await expect(assumptions).toContainText('no same-bar fill and no look-ahead');
    await expect(assumptions).toContainText('Only long positions are simulated');

    // Editing parameters marks the previous run as stale until it is re-run.
    await page.getByLabel('Initial capital').fill('250000');
    await expect(page.getByText('Stale')).toBeVisible();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('Stale')).toBeHidden();
  });

  test('exports the trade list as CSV', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Trades' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^marketlab-trades-.*\.csv$/);
  });
});
