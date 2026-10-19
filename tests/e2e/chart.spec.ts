import { expect, test, type Page } from '@playwright/test';

/**
 * Waits until the chart is actually rendered. The overlay canvas is only sized
 * once the chart controller holds the series data, so drawing and selection
 * gestures are meaningful from that point on.
 */
async function waitForChart(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.locator('canvas.chart-overlay').first().getAttribute('width')), {
      message: 'the chart overlay should be sized once the series is rendered',
    })
    .toBeGreaterThan(100);
}

/** Waits until every visible panel has a rendered, sized drawing overlay. */
async function waitForPanels(page: Page, count: number): Promise<void> {
  await expect
    .poll(
      async () =>
        page.locator('canvas.chart-overlay').evaluateAll(
          (nodes) => nodes.filter((node) => Number(node.getAttribute('width')) > 100).length,
        ),
      { message: `all ${count} panels should be rendered` },
    )
    .toBe(count);
}

test.describe('chart workspace', () => {
  test('renders an interactive chart with a legend and honest timeframe labels', async ({ page }) => {
    await page.goto('/#/chart');

    await expect(page.locator('.topbar-title')).toHaveText('Chart workspace');
    await expect(page.locator('.chart-symbol').first()).toHaveText('ATX');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);
    await waitForChart(page);

    // A daily dataset can be viewed as daily, weekly and monthly.
    const timeframe = page.getByRole('group', { name: 'Timeframe' }).first();
    await expect(timeframe.getByRole('button')).toHaveCount(3);
    await expect(timeframe.getByRole('button', { name: '1W' })).toBeEnabled();
    await expect(timeframe.getByRole('button', { name: '1M' })).toBeEnabled();

    const legend = page.locator('.chart-legend').first();
    await expect(legend).toContainText('Daily');

    // Weekly is an aggregation and says so rather than pretending to be native.
    await timeframe.getByRole('button', { name: '1W' }).click();
    await expect(legend).toContainText('Weekly (aggregated from daily)');

    await timeframe.getByRole('button', { name: '1D' }).click();
    await expect(legend).toContainText('Daily');
  });

  test('expands the layout to four panels and hides panels without deleting them', async ({ page }) => {
    await page.goto('/#/chart');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);

    await page.getByRole('button', { name: 'Four panels' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(4);
    await waitForPanels(page, 4);

    // Link the symbol so every panel follows the focused one.
    await page.getByRole('checkbox', { name: 'Symbol' }).check();

    // Reducing the layout hides panels; the stored count is still reported.
    await page.getByRole('button', { name: 'Single panel' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);
    await expect(page.getByText(/4 panel\(s\) stored/)).toBeVisible();
  });

  test('adds, toggles and removes an indicator', async ({ page }) => {
    await page.goto('/#/chart');
    await waitForChart(page);

    await page.getByRole('button', { name: 'Add indicator' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Indicators' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: /Simple Moving Average/ }).click();
    await dialog.getByRole('button', { name: 'Add to chart' }).click();
    await expect(dialog).toBeHidden();

    const indicatorFoot = page.locator('.panel-foot').first();
    await expect(indicatorFoot.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(1);
    await expect(page.locator('.indicator-legend-item')).toHaveCount(1);

    await indicatorFoot.getByRole('button', { name: 'Hide', exact: true }).click();
    await indicatorFoot.getByRole('button', { name: 'Show', exact: true }).click();

    await indicatorFoot.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.panel-foot')).toHaveCount(0);
    await expect(page.locator('.indicator-legend-item')).toHaveCount(0);
  });

  test('draws a level, undoes, redoes and deletes it', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });

    await waitForChart(page);
    await expect(deleteSelected).toBeDisabled();

    // A single-anchor tool completes on the first click.
    await page.getByRole('button', { name: 'Horizontal level' }).click();
    await stage.click({ position: { x: 300, y: 150 } });
    await expect(deleteSelected).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Pointer and selection' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Undo drawing' }).click();
    await expect(deleteSelected).toBeDisabled();

    await page.getByRole('button', { name: 'Redo drawing' }).click();
    await expect(deleteSelected).toBeEnabled();

    // The drawing is stored in the workspace, not only in component state.
    await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
    const row = page.locator('table.data tbody tr').filter({ hasText: 'Primary' });
    await expect(row).toContainText('1');

    await page.reload();
    await expect(page.locator('table.data tbody tr').filter({ hasText: 'Primary' })).toBeVisible();

    // Selecting with the pointer tool and deleting works on a fresh load too.
    await page.getByRole('link', { name: 'Chart workspace', exact: true }).click();
    await waitForChart(page);
    await stage.click({ position: { x: 300, y: 150 } });
    await expect(deleteSelected).toBeEnabled();
    await deleteSelected.click();
    await expect(deleteSelected).toBeDisabled();
  });

  test('does not run drawing shortcuts for keys typed in the indicator dialog', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });

    await waitForChart(page);
    await page.getByRole('button', { name: 'Horizontal level' }).click();
    await stage.click({ position: { x: 300, y: 150 } });
    await expect(deleteSelected).toBeEnabled();

    await page.getByRole('button', { name: 'Add indicator' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Indicators' });
    await expect(dialog).toBeVisible();

    // Backspace edits the parameter field; it must not delete the drawing.
    const period = dialog.getByRole('spinbutton').first();
    await period.click();
    await period.press('Backspace');
    await expect(deleteSelected).toBeEnabled();

    // Escape closes the dialog; the half-drawn tool state is untouched.
    await period.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(deleteSelected).toBeEnabled();
  });

  test('grows the layout so a duplicated panel is reachable', async ({ page }) => {
    await page.goto('/#/chart');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);

    await page.getByRole('button', { name: 'Duplicate panel' }).click();
    // The single layout grows to show the new panel instead of hiding it.
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);
    await expect(page.getByText(/2 panel\(s\) stored, 2 rendered/)).toBeVisible();

    await page.getByRole('button', { name: 'Duplicate panel' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(3);
    await page.getByRole('button', { name: 'Duplicate panel' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Duplicate panel' })).toBeDisabled();
    await expect(page.getByText('Four panels is the maximum layout.')).toBeVisible();
  });

  test('loads a watchlist instrument into the focused panel', async ({ page }) => {
    await page.goto('/#/chart');

    await expect(page.locator('.chart-symbol').first()).toHaveText('ATX');
    await page
      .locator('.page-split table.data tbody tr')
      .filter({ hasText: 'NRG' })
      .getByRole('button', { name: 'NRG', exact: true })
      .click();
    await expect(page.locator('.chart-symbol').first()).toHaveText('NRG');
  });
});
