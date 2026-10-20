import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  buildFixtureLibrary,
  buildSingleSeriesLibrary,
  buildSparseOverlapLibrary,
  seedLibrary,
} from './fixtures/library';

/**
 * Compare-symbol overlays.
 *
 * The library is seeded directly into IndexedDB, exactly like the other chart
 * tests: no network and no live provider request is involved. The fixture
 * series share the same session dates, so the common-date alignment has real
 * overlapping history to work with.
 */

async function waitForChart(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.locator('canvas.chart-overlay').first().getAttribute('width')), {
      message: 'the chart overlay should be sized once the series is rendered',
    })
    .toBeGreaterThan(100);
}

async function openCompareDialog(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Compare symbol' }).click();
  const dialog = page.getByRole('dialog', { name: 'Compare symbols' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function addComparison(dialog: Locator, datasetId: string): Promise<void> {
  await dialog.getByLabel('Stored series to compare').selectOption(datasetId);
  await dialog.getByRole('button', { name: 'Add overlay' }).click();
}

test.describe('compare-symbol overlays', () => {
  test('opens the selector and adds several symbols without changing the primary', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/#/chart');
    await waitForChart(page);

    await expect(page.locator('.chart-symbol').first()).toHaveText('AAPL');

    const dialog = await openCompareDialog(page);
    await expect(dialog).toContainText('rebased to an index of 100');
    await addComparison(dialog, 'ds_msft');
    await addComparison(dialog, 'ds_qqq');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // The primary instrument is untouched; the overlays are an addition.
    await expect(page.locator('.chart-symbol').first()).toHaveText('AAPL');

    const legend = page.locator('.chart-legend').first();
    await expect(legend).toContainText('Compare · index 100 =');
    await expect(legend.locator('.compare-legend-item')).toHaveCount(3);

    // The primary is drawn as the first rebased series, then the comparisons.
    const rows = legend.locator('.compare-legend-item');
    await expect(rows.nth(0)).toContainText('AAPL (primary)');
    await expect(rows.nth(1)).toContainText('MSFT');
    await expect(rows.nth(2)).toContainText('QQQ');

    // Every line is distinguishable by colour *and* by stroke style.
    const lineStyles = await rows
      .locator('.legend-line')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('class') ?? ''));
    expect(lineStyles).toEqual(['legend-line solid', 'legend-line dashed', 'legend-line dotted']);
    const colours = await rows
      .locator('.legend-line')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderTopColor));
    expect(new Set(colours).size).toBe(3);

    // The method and the comparison scale are stated in the UI.
    await expect(legend).toContainText('Compare · index 100');
    await expect(page.locator('.compare-foot')).toContainText('first session shared');
    await expect(page.locator('.compare-foot')).toContainText('never by array position');

    // Candles and the volume pane are still rendered behind the overlays.
    await waitForChart(page);
    await expect(page.getByLabel('Chart type').first()).toHaveValue('candlestick');
  });

  test('removes one comparison and clears all overlays', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/#/chart');
    await waitForChart(page);

    const dialog = await openCompareDialog(page);
    await addComparison(dialog, 'ds_msft');
    await addComparison(dialog, 'ds_qqq');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    const legend = page.locator('.chart-legend').first();
    await expect(legend.locator('.compare-legend-item')).toHaveCount(3);

    await legend.getByRole('button', { name: 'Remove MSFT comparison' }).click();
    await expect(legend.locator('.compare-legend-item')).toHaveCount(2);
    await expect(legend).not.toContainText('MSFT');

    await legend.getByRole('button', { name: 'Clear all' }).click();
    await expect(legend.locator('.compare-legend-item')).toHaveCount(0);
    await expect(legend).not.toContainText('Compare · index 100');
    // The primary series is still there.
    await expect(page.locator('.chart-symbol').first()).toHaveText('AAPL');
    await waitForChart(page);
  });

  test('clears overlays when the primary instrument changes', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/#/chart');
    await waitForChart(page);

    const dialog = await openCompareDialog(page);
    await addComparison(dialog, 'ds_msft');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.compare-legend-item')).toHaveCount(2);

    // Load NVDA into the focused panel from the watchlist.
    await page
      .locator('.page-split table.data tbody tr')
      .filter({ hasText: 'NVDA' })
      .getByRole('button', { name: 'NVDA', exact: true })
      .click();

    await expect(page.locator('.chart-symbol').first()).toHaveText('NVDA');
    // The comparison set was chosen against AAPL, so it does not survive.
    await expect(page.locator('.compare-legend-item')).toHaveCount(0);

    await page.reload();
    await expect(page.locator('.chart-symbol').first()).toHaveText('NVDA');
    await expect(page.locator('.compare-legend-item')).toHaveCount(0);
  });

  test('persists comparison selections across a reload', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/#/chart');
    await waitForChart(page);

    const dialog = await openCompareDialog(page);
    await addComparison(dialog, 'ds_msft');
    await addComparison(dialog, 'ds_qqq');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('.compare-legend-item')).toHaveCount(3);

    await page.reload();

    await expect(page.locator('.compare-legend-item')).toHaveCount(3);
    await expect(page.locator('.chart-legend').first()).toContainText('MSFT');
    await expect(page.locator('.chart-legend').first()).toContainText('QQQ');
    await expect(page.getByRole('button', { name: 'Compare symbol' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('reports insufficient shared history instead of drawing a one-point line', async ({ page }) => {
    await seedLibrary(page, buildSparseOverlapLibrary());
    await page.goto('/#/chart');
    await waitForChart(page);

    const dialog = await openCompareDialog(page);
    await addComparison(dialog, 'ds_msft');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    const legend = page.locator('.chart-legend').first();
    await expect(legend).toContainText('1 shared session(s); at least 2 are needed');
    // No fabricated line is drawn when there is nothing honest to draw.
    await expect(legend.locator('.compare-legend-item')).toHaveCount(0);
    await waitForChart(page);
  });

  test('shows the first-run guidance for an empty library', async ({ page }) => {
    await page.goto('/#/chart');

    await expect(page.getByText('Nothing to chart yet')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compare symbol' })).toHaveCount(0);
  });

  test('points a single-series library at the download and import actions', async ({ page }) => {
    await seedLibrary(page, buildSingleSeriesLibrary());
    await page.goto('/#/chart');
    await waitForChart(page);

    const dialog = await openCompareDialog(page);
    await expect(dialog).toContainText('Only one series is stored');
    await expect(dialog.getByRole('button', { name: 'Download real market data' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Import a CSV file' })).toBeVisible();
  });

  test('keeps the compare dialog open when Escape closes a stacked download dialog', async ({ page }) => {
    await seedLibrary(page, buildSingleSeriesLibrary());
    await page.goto('/#/chart');
    await waitForChart(page);

    const compare = await openCompareDialog(page);
    await compare.getByRole('button', { name: 'Download real market data' }).click();

    const download = page.getByRole('dialog', { name: 'Download market data' });
    await expect(download).toBeVisible();
    await expect(compare).toBeVisible();

    // Only the top dialog reacts: one Escape must not discard the compare draft.
    await page.keyboard.press('Escape');
    await expect(download).toBeHidden();
    await expect(compare).toBeVisible();

    // The compare dialog is the top layer again, so its own Escape closes it.
    await page.keyboard.press('Escape');
    await expect(compare).toBeHidden();
  });

  test('keeps the compare workflow usable at a narrow viewport', async ({ page }) => {
    await seedLibrary(page, buildFixtureLibrary());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/chart');
    await waitForChart(page);

    const dialog = await openCompareDialog(page);
    await addComparison(dialog, 'ds_msft');
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    await expect(page.locator('.compare-legend-item')).toHaveCount(2);
    // The page itself must not overflow horizontally.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
