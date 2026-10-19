import { expect, test, type Page } from '@playwright/test';
import { buildCorporateActionLibrary, buildFixtureLibrary, seedLibrary } from './fixtures/library';

/**
 * Corporate-action markers.
 *
 * The provider-download fixture stores two actions. On a daily panel both fall
 * on sessions; on a weekly panel the Monday dividend falls between displayed
 * bars and must be reported as unmarked rather than moved to the nearest bar.
 * No network is involved.
 */

async function waitForChart(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.locator('canvas.chart-overlay').first().getAttribute('width')), {
      message: 'the chart overlay should be sized once the series is rendered',
    })
    .toBeGreaterThan(100);
}

test.describe('corporate-action markers', () => {
  test('labels provider actions and leaves them on their real session dates', async ({ page }) => {
    await seedLibrary(page, buildCorporateActionLibrary());
    await page.goto('/#/chart');
    await waitForChart(page);

    const foot = page.locator('.action-foot');
    await expect(foot).toBeVisible();
    await expect(foot).toContainText('Provider-reported corporate actions: 1 split, 1 cash dividend.');
    await expect(foot).toContainText('Markers sit at provider event dates');
    await expect(foot).toContainText('prices are split-adjusted');
    await expect(foot).toContainText('not reinvested');
    await expect(foot).toContainText('primary series');
    await expect(foot).toContainText('Yahoo Finance');
    await expect(foot.locator('.action-swatch')).toHaveCount(2);

    // The primary price chart and volume pane are still present.
    await expect(page.getByLabel('Chart type').first()).toHaveValue('candlestick');
    await waitForChart(page);

    // A weekly panel has no bar for the Monday action, so it is reported as
    // unmarked instead of being snapped to a nearby weekly session.
    const timeframe = page.getByRole('group', { name: 'Timeframe' }).first();
    await timeframe.getByRole('button', { name: '1W' }).click();
    await expect(foot).toContainText('Provider-reported corporate actions: 1 split, 0 cash dividends.');
    await expect(foot).toContainText('1 action date does not coincide with a displayed session and is not marked.');
    await expect(foot.locator('.action-swatch')).toHaveCount(1);

    // Back on the daily panel both actions are markable again, with no
    // accumulated "unmatched" state.
    await timeframe.getByRole('button', { name: '1D' }).click();
    await expect(foot).toContainText('Provider-reported corporate actions: 1 split, 1 cash dividend.');
    await expect(foot).not.toContainText('does not coincide');

    // Actions are part of the stored dataset, not transient UI state.
    await page.reload();
    await waitForChart(page);
    await expect(page.locator('.action-foot')).toContainText('Provider-reported corporate actions: 1 split, 1 cash dividend.');
  });

  test('does not invent corporate actions for an imported CSV series', async ({ page }) => {
    await seedLibrary(page, buildFixtureLibrary());
    await page.goto('/#/chart');
    await waitForChart(page);
    await expect(page.locator('.action-foot')).toHaveCount(0);
  });
});
