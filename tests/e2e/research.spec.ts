import { expect, test } from '@playwright/test';
import { seedLibrary } from './fixtures/library';

// The application bundles no data, so the research screens are tested against
// a seeded library of imported series.
test.beforeEach(async ({ page }) => {
  await seedLibrary(page);
});

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

    // The saved-screen picker is named for assistive technology, not labelled
    // only by its first option.
    await expect(page.getByRole('combobox', { name: 'Saved screens' })).toBeVisible();

    await page.getByRole('button', { name: 'Start a new screen' }).click();
    await expect(page.getByText('of 6 series matched')).toBeVisible();

    const results = page.locator('.panel').filter({ hasText: 'Results' }).first();
    await expect(results.locator('tbody tr')).toHaveCount(6);
    // Every filter has a visible column, and unmatched rows are marked as such.
    await expect(results).toContainText('Price vs SMA');

    // An unsaved draft cannot be deleted: there is nothing stored to remove.
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);

    // Saving persists the screen into the saved list.
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.toast-body')).toContainText('Saved screen "Untitled screen"');
    await expect(page.locator('option', { hasText: 'Untitled screen' })).toBeAttached();
  });

  test('opens a screened instrument in the chart workspace', async ({ page }) => {
    await page.goto('/#/screener');
    await page.getByRole('button', { name: 'Start a new screen' }).click();

    const results = page.locator('.panel').filter({ hasText: 'Results' }).first();
    const row = results.locator('tbody tr').filter({ hasText: 'MSFT' });
    await row.getByRole('button', { name: 'MSFT', exact: true }).click();

    // The screened dataset is re-pointed at the first chart, not re-imported.
    await expect(page.locator('.topbar-title')).toHaveText('Chart workspace');
    await expect(page.locator('.chart-symbol').first()).toHaveText('MSFT');

    // The switch is persisted like any other chart edit.
    await page.reload();
    await expect(page.locator('.chart-symbol').first()).toHaveText('MSFT');
  });

  test('edits and deletes a saved screen', async ({ page }) => {
    await page.goto('/#/screener');
    await page.getByRole('button', { name: 'Start a new screen' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('option', { hasText: 'Untitled screen' })).toBeAttached();

    // Selecting a saved screen exposes an Edit action that clones it into the editor.
    await page.locator('.panel-head select').first().selectOption({ label: 'Untitled screen' });
    await expect(page.getByLabel('Screen name')).toBeDisabled();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page.getByLabel('Screen name')).toBeEnabled();

    await page.getByLabel('Screen name').fill('Momentum');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('option', { hasText: 'Momentum' })).toBeAttached();

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator('option', { hasText: 'Momentum' })).toHaveCount(0);
  });
});

test.describe('rule-based backtest', () => {
  test('simulates the default strategy and states its execution assumptions', async ({ page }) => {
    await page.goto('/#/backtest');

    await expect(page.getByRole('combobox', { name: 'Saved strategies' })).toBeVisible();

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

  test('keeps the remove control on the rule row at desktop width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();
    await page.getByRole('button', { name: 'Add entry rule' }).click();

    const row = page
      .locator('.rule-row')
      .filter({ has: page.getByRole('button', { name: 'Remove rule' }) })
      .first();
    const remove = row.getByRole('button', { name: 'Remove rule' });
    const firstSelect = row.getByRole('combobox').first();

    const removeBox = await remove.boundingBox();
    const selectBox = await firstSelect.boundingBox();
    expect(removeBox).not.toBeNull();
    expect(selectBox).not.toBeNull();

    // On the same line as the rule, not wrapped beneath it.
    expect(removeBox!.y).toBeLessThan(selectBox!.y + selectBox!.height);
  });

  test('exports the trade list as CSV', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Trades' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^marketlab-trades-.*\.csv$/);
  });

  test('saves a research run, verifies it and keeps it after a reload', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const panel = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    await expect(panel.getByRole('button', { name: 'Save run' })).toBeEnabled();
    await panel.getByRole('button', { name: 'Save run' }).click();
    await expect(page.locator('.toast-body')).toContainText('Saved research run "Untitled strategy"');

    const runs = panel.getByRole('combobox', { name: 'Saved research runs' });
    await expect(runs).toContainText('Untitled strategy');
    await expect(panel.getByText(/Window fingerprint sha256:[0-9a-f]+/)).toBeVisible();

    // The saved configuration is inspectable, not only its outputs.
    await panel.getByText('Strategy configuration recorded with this run').click();
    await expect(panel.getByText('20-session SMA crosses above 50-session SMA')).toBeVisible();

    // Verification re-runs the frozen engine against the stored inputs and
    // reports a match without altering the saved record.
    await panel.getByRole('button', { name: 'Rerun and verify' }).click();
    await expect(panel.getByText('Verified', { exact: true })).toBeVisible();

    await page.reload();
    const reloaded = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    await expect(reloaded.getByRole('combobox', { name: 'Saved research runs' })).toContainText('Untitled strategy');
    await expect(reloaded.getByText(/Window fingerprint sha256:[0-9a-f]+/)).toBeVisible();
  });

  test('exports a research manifest and refuses to overwrite it on re-import', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const panel = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    await panel.getByRole('button', { name: 'Save run' }).click();
    await expect(panel.getByRole('button', { name: 'Export manifest' })).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export manifest' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.research-run\.json$/);
    const manifestPath = await download.path();
    expect(manifestPath).not.toBeNull();

    await panel.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(panel.getByText('No saved research runs')).toBeVisible();

    const fileInput = panel.getByLabel('Import research run manifest');
    await fileInput.setInputFiles(manifestPath as string);
    await expect(page.locator('.toast-body').last()).toContainText('Saved research run "Untitled strategy"');
    await expect(panel.getByRole('combobox', { name: 'Saved research runs' })).toContainText('Untitled strategy');

    // A second import of the same immutable run is reported, not written.
    await fileInput.setInputFiles(manifestPath as string);
    await expect(page.locator('.toast-body').last()).toContainText('already saved');
  });

  test('loads a saved research run into the strategy editor', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    // Make the run distinguishable from the default strategy.
    await page.getByLabel('Initial capital').fill('250000');
    await page.getByRole('button', { name: 'Run', exact: true }).click();

    const panel = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    await panel.getByRole('button', { name: 'Save run' }).click();
    await expect(page.locator('.toast-body')).toContainText('Saved research run');

    // Start a fresh default strategy so the editor no longer holds the saved one.
    await page.getByRole('button', { name: 'New strategy' }).click();
    await expect(page.getByLabel('Initial capital')).toHaveValue('100000');

    await panel.getByRole('button', { name: 'Load into editor' }).click();
    await expect(page.getByLabel('Initial capital')).toHaveValue('250000');

    // Loading creates an editable working copy, not a saved strategy.
    await expect(page.getByRole('combobox', { name: 'Saved strategies' })).toHaveValue('');
    const workingCopy = page.locator('.research-working-copy');
    await expect(workingCopy).toContainText('Working copy');
    await expect(workingCopy).toContainText('The saved run and its results are unchanged');

    // Starting a fresh strategy clears the working-copy context.
    await page.getByRole('button', { name: 'New strategy' }).click();
    await expect(page.locator('.research-working-copy')).toHaveCount(0);
  });
});
