import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildFixtureBars, buildPartialCoverageLibrary, readStore, seedLibrary } from './fixtures/library';

// The fixture's session span is deterministic, so the backtest results can be
// held to naming it with dates rather than only a session count.
const FIRST_FIXTURE_SESSION = buildFixtureBars(1013, 100)[0]?.date ?? '';

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

  test('names the simulated window with dates and flags a shortfall', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const results = page.locator('.panel').filter({ hasText: 'Results' }).first();

    // The window is stated with dates, not only a session count, and the
    // boundaries are the stored series' own first and last sessions.
    await expect(results).toContainText('Simulated sessions');
    await expect(results).toContainText(`${FIRST_FIXTURE_SESSION} to 2026-10-16`);
    // The warm-up split and the data provenance are disclosed beside the
    // metrics rather than left implied.
    await expect(results).toContainText('after the indicator warm-up');
    await expect(results).toContainText('Data source');

    // A requested start older than the stored series must be visible in the
    // results instead of silently simulating a shorter window.
    await page.getByLabel('Start date').fill('2025-01-01');
    await expect(page.getByText('Stale')).toBeVisible();
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('Stale')).toBeHidden();

    const warning = results.locator('.coverage-warning');
    await expect(warning).toContainText('Not all of the requested window is stored.');
    await expect(warning).toContainText('The requested start 2025-01-01 is earlier than the first stored session');
    await expect(warning).toContainText(`this run begins at ${FIRST_FIXTURE_SESSION}`);
    // The metrics still stay visible; the warning supplements them rather
    // than replacing the result.
    await expect(results).toContainText('Total return');
  });

  test('discloses a dataset that returned less than its download request', async ({ page }) => {
    // Default strategies carry no dates, so a short download would otherwise be
    // invisible: the requested window and the simulated window would both look
    // like the stored series.
    await seedLibrary(page, buildPartialCoverageLibrary());
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const results = page.locator('.panel').filter({ hasText: 'Results' }).first();
    await expect(results).toContainText('Stored coverage');

    const warning = results.locator('.coverage-warning');
    await expect(warning).toContainText('The stored dataset does not cover its whole download request.');
    await expect(warning).toContainText('request starting 2015-01-02');
    // The run's own window is fully covered, so the warning must be about the
    // dataset, not about the strategy's dates.
    await expect(results).toContainText('Simulated sessions');
  });

  test('explains recomputed results and distinguishes a loaded saved run', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const reading = page.locator('.panel').filter({ hasText: 'Reading these results' }).first();
    await expect(reading).toContainText('Recomputed in this browser from the current stored dataset.');
    await expect(reading).toContainText('This run covers');
    await expect(reading).toContainText('What this does not tell you');
    await expect(reading).toContainText('not by itself evidence of a better strategy');
    await expect(reading).toContainText(
      'Past behaviour on one instrument over one window is not a forecast.',
    );

    const runs = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    await expect(page.getByText('Stale')).toBeHidden();
    await runs.getByRole('button', { name: 'Save run' }).click();
    await expect(page.locator('.toast-body').last()).toContainText('Saved research run');

    // Loading the snapshot creates a fresh recomputation; the saved metrics are
    // not silently replaced, and the reading says so.
    await page.getByRole('button', { name: 'New strategy' }).click();
    await runs.getByRole('button', { name: 'Load into editor' }).click();

    await expect(reading).toContainText('Recomputed now from the loaded configuration.');
    await expect(reading).toContainText('The saved run');
    await expect(reading).toContainText('keeps the metrics it recorded');
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

    const runs = panel.getByRole('list', { name: 'Saved research runs' });
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
    await expect(reloaded.getByRole('list', { name: 'Saved research runs' })).toContainText('Untitled strategy');
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
    await expect(panel.getByRole('list', { name: 'Saved research runs' })).toContainText('Untitled strategy');

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

  test('pairs a run with a re-imported content-identical series', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const panel = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    await panel.getByRole('button', { name: 'Save run' }).click();
    await expect(page.locator('.toast-body')).toContainText('Saved research run "Untitled strategy"');

    // Reproduce the exact state after a user re-downloads a series and removes
    // the earlier import: the stored dataset id disappears, but a sibling
    // record with the same bars, instrument and frequency survives under a new
    // id. The run record is untouched.
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('marketlab', 3);
        open.onerror = () => reject(open.error ?? new Error('Could not open the database'));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['datasets', 'bars'], 'readwrite');
          const datasets = tx.objectStore('datasets');
          const bars = tx.objectStore('bars');
          const originalRequest = datasets.get('ds_aapl');
          originalRequest.onsuccess = () => {
            const original = originalRequest.result as Record<string, unknown> | undefined;
            const barsRequest = bars.get('ds_aapl');
            barsRequest.onsuccess = () => {
              const originalBars = barsRequest.result as { id: string; bars: unknown[] } | undefined;
              if (!original || !originalBars) {
                reject(new Error('The fixture dataset ds_aapl was not found.'));
                return;
              }
              datasets.put({ ...original, id: 'ds_aapl2', name: 'AAPL - daily (re-imported)' });
              bars.put({ id: 'ds_aapl2', bars: originalBars.bars });
              datasets.delete('ds_aapl');
              bars.delete('ds_aapl');
            };
            barsRequest.onerror = () => reject(barsRequest.error ?? new Error('Could not read the bars'));
          };
          originalRequest.onerror = () => reject(originalRequest.error ?? new Error('Could not read the dataset'));
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error ?? new Error('Could not write the sibling records'));
        };
      });
    });
    await page.reload();

    const reloaded = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    await expect(reloaded.getByRole('list', { name: 'Saved research runs' })).toContainText('Untitled strategy');

    // The stored id is gone, but the run's inputs resolve through their content
    // identity, so the run stays verifiable instead of being mislabelled as
    // missing its dataset.
    await reloaded.getByRole('button', { name: 'Rerun and verify' }).click();
    await expect(reloaded.getByText('Verified', { exact: true })).toBeVisible();

    // Loading the run re-points the draft at the sibling series and says so.
    const loadButton = reloaded.getByRole('button', { name: 'Load into editor' });
    await expect(loadButton).toBeEnabled();
    await loadButton.click();
    // The re-point is disclosed, not hidden behind the generic load message.
    const toasts = page.locator('.toast-body');
    await expect(toasts.first()).toContainText('re-imported under a new library id');
    await expect(toasts.last()).toContainText('Loaded the configuration from research run "Untitled strategy"');

    // The draft runs against the sibling, not the deleted id.
    const workingCopy = page.locator('.research-working-copy');
    await expect(workingCopy).toContainText('Working copy');
  });

  test('compares two saved research runs without changing either record', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const runsPanel = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    const saveRun = runsPanel.getByRole('button', { name: 'Save run' });

    // First snapshot: the default strategy, named so the comparison is legible.
    await page.getByLabel('Strategy name').fill('Baseline run');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('Stale')).toBeHidden();
    await saveRun.click();
    await expect(page.locator('.toast-body').last()).toContainText('Saved research run "Baseline run"');

    // Second snapshot: a materially different position size, so the recorded
    // metrics and configuration differ without changing the market data.
    await page.getByLabel('Strategy name').fill('Half size');
    await page.getByLabel('Position size (%)').fill('50');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('Stale')).toBeHidden();
    await saveRun.click();
    await expect(page.locator('.toast-body').last()).toContainText('Saved research run "Half size"');

    const before = await readStore(page, 'researchRuns');
    expect(before).toHaveLength(2);

    const compare = page.locator('.panel').filter({ hasText: 'Compare saved runs' }).first();
    const selectA = compare.getByRole('combobox', { name: 'Run A' });
    const selectB = compare.getByRole('combobox', { name: 'Run B' });
    await expect(selectA).toBeVisible();
    await expect(selectB).toBeVisible();

    // Choose an explicit pair rather than relying on the newest-first default.
    const baselineId = await selectA.locator('option', { hasText: 'Baseline run' }).getAttribute('value');
    const halfSizeId = await selectB.locator('option', { hasText: 'Half size' }).getAttribute('value');
    expect(baselineId).not.toBeNull();
    expect(halfSizeId).not.toBeNull();
    await selectA.selectOption(baselineId as string);
    await selectB.selectOption(halfSizeId as string);

    await expect(compare.locator('.compare-run-name').nth(0)).toHaveText('Baseline run');
    await expect(compare.locator('.compare-run-name').nth(1)).toHaveText('Half size');
    await expect(compare.getByText('Different strategies', { exact: true })).toBeVisible();
    await expect(compare.getByText('Inputs match', { exact: true }).first()).toBeVisible();

    // Recorded values stay visible and deltas are labelled in percentage
    // points; profit factor deliberately has no arithmetic delta.
    const totalRow = compare.locator('.compare-metrics-table tbody tr').filter({ hasText: 'Total return' });
    const totalDelta = totalRow.locator('td').nth(2);
    await expect(totalRow.locator('td').nth(0)).not.toHaveText('--');
    await expect(totalDelta).toContainText('pp');
    expect(await totalDelta.textContent()).not.toBe('0.00 pp');

    const profitFactorRow = compare.locator('.compare-metrics-table tbody tr').filter({ hasText: 'Profit factor' });
    await expect(profitFactorRow.locator('td').nth(2)).toHaveText('n/a');

    const positionRow = compare.locator('.compare-config-table tbody tr').filter({ hasText: 'Position size' });
    await expect(positionRow).toContainText('95.00%');
    await expect(positionRow).toContainText('50.00%');
    await expect(positionRow).toContainText('Differs');

    // Swapping is immediate and keeps both records selected.
    const aBeforeSwap = await selectA.inputValue();
    const bBeforeSwap = await selectB.inputValue();
    await compare.getByRole('button', { name: 'Swap run A and run B' }).click();
    await expect(selectA).toHaveValue(bBeforeSwap);
    await expect(selectB).toHaveValue(aBeforeSwap);
    await expect(compare.locator('.compare-run-name').nth(0)).toHaveText('Half size');
    await expect(compare.locator('.compare-run-name').nth(1)).toHaveText('Baseline run');

    // Comparison is read-only: both IndexedDB records are byte-for-byte the
    // same objects after selecting, reading and swapping.
    const after = await readStore(page, 'researchRuns');
    expect(after).toEqual(before);
  });

  test('filters the run library and renames a snapshot without changing its results', async ({ page }) => {
    await page.goto('/#/backtest');
    await page.getByRole('button', { name: 'Start a new strategy' }).click();

    const panel = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    const saveRun = panel.getByRole('button', { name: 'Save run' });

    await page.getByLabel('Strategy name').fill('Baseline run');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('Stale')).toBeHidden();
    await saveRun.click();
    await expect(page.locator('.toast-body').last()).toContainText('Saved research run "Baseline run"');

    await page.getByLabel('Strategy name').fill('Half size');
    await page.getByLabel('Position size (%)').fill('50');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByText('Stale')).toBeHidden();
    await saveRun.click();
    await expect(page.locator('.toast-body').last()).toContainText('Saved research run "Half size"');

    const library = panel.getByRole('list', { name: 'Saved research runs' });
    await expect(library.getByRole('button')).toHaveCount(2);
    await expect(library).toContainText('Baseline run');
    await expect(library).toContainText('Half size');
    await expect(library).toContainText('Return');
    await expect(library).toContainText('Trades');
    await expect(library).toContainText('Sharpe');

    const before = await readStore(page, 'researchRuns');
    const baselineBefore = before.find((run) => run.name === 'Baseline run');
    expect(baselineBefore).toBeDefined();
    const baselineId = String(baselineBefore!.id);

    await library.getByRole('button', { name: /Baseline run/ }).click();
    await expect(panel.locator('.research-run-inspector-title')).toContainText('Baseline run');

    // Filtering narrows the library and follows the visible set. A zero-match
    // filter hides the inspector instead of showing a run outside the results.
    const filter = panel.getByRole('textbox', { name: 'Filter saved runs' });
    await filter.fill('half');
    await expect(library.getByRole('button')).toHaveCount(1);
    await expect(library).toContainText('Half size');
    await expect(library).not.toContainText('Baseline run');
    await expect(panel.locator('.research-run-inspector-title')).toContainText('Half size');
    await filter.fill('zzz');
    await expect(panel.getByText('No runs match this filter')).toBeVisible();
    await expect(panel.locator('.research-runs-inspector')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Clear filter' }).click();
    await expect(library.getByRole('button')).toHaveCount(2);

    await library.getByRole('button', { name: /Baseline run/ }).click();
    await expect(panel.locator('.research-run-inspector-title')).toContainText('Baseline run');

    // Renaming is a metadata correction: blank names are refused, and the
    // recorded snapshot must remain identical except for the display label.
    await panel.getByRole('button', { name: 'Rename' }).click();
    const nameInput = panel.getByRole('textbox', { name: 'Research run name' });
    await expect(nameInput).toBeFocused();
    await nameInput.fill('   ');
    await panel.getByRole('button', { name: 'Save name' }).click();
    await expect(panel.getByRole('alert')).toContainText('Enter a name');

    await nameInput.fill('Baseline renamed');
    await nameInput.press('Enter');
    await expect(page.locator('.toast-body').last()).toContainText('Renamed research run to "Baseline renamed"');
    await expect(library).toContainText('Baseline renamed');
    await expect(panel.locator('.research-run-inspector-title')).toContainText('Baseline renamed');

    const after = await readStore(page, 'researchRuns');
    const baselineAfter = after.find((run) => String(run.id) === baselineId);
    expect(baselineAfter).toBeDefined();
    expect(baselineAfter).toEqual({ ...baselineBefore, name: 'Baseline renamed' });

    // The comparison reads live records, so its labels update without a rerun.
    const compare = page.locator('.panel').filter({ hasText: 'Compare saved runs' }).first();
    await expect(compare.getByRole('combobox', { name: 'Run A' })).toContainText('Baseline renamed');

    // Export uses the corrected label and still carries the same recorded metrics.
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export manifest' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('baseline-renamed');
    const manifestPath = await download.path();
    expect(manifestPath).not.toBeNull();
    const manifest = JSON.parse(await readFile(manifestPath as string, 'utf8')) as {
      run: { name: string; metrics: unknown };
    };
    expect(manifest.run.name).toBe('Baseline renamed');
    expect(manifest.run.metrics).toEqual(baselineBefore!.metrics);

    await page.reload();
    const reloaded = page.locator('.panel').filter({ hasText: 'Research runs' }).first();
    await expect(reloaded.getByRole('list', { name: 'Saved research runs' })).toContainText('Baseline renamed');

    await page.setViewportSize({ width: 390, height: 900 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
