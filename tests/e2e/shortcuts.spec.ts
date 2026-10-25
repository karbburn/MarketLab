import { expect, test, type Page } from '@playwright/test';
import { seedLibrary } from './fixtures/library';

async function waitForChart(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.locator('canvas.chart-overlay').first().getAttribute('width')), {
      message: 'the chart overlay should be sized once the series is rendered',
    })
    .toBeGreaterThan(100);
}

test.beforeEach(async ({ page }) => {
  await seedLibrary(page);
});

test.describe('keyboard reference', () => {
  test('opens with ? and from the topbar, and stays out of form controls', async ({ page }) => {
    await page.goto('/chart');
    await waitForChart(page);

    await page.keyboard.press('Shift+/');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Anywhere');
    await expect(dialog).toContainText('Focused chart');
    await expect(dialog).toContainText('Workspace');
    await expect(dialog).toContainText('Fit the visible bars to the panel');

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close dialog' }).click();
    await expect(dialog).toBeHidden();

    // A question mark typed into a control belongs to that control.
    await page.getByRole('combobox', { name: 'Active workspace' }).focus();
    await page.keyboard.press('Shift+/');
    await expect(dialog).toBeHidden();
  });
});

test.describe('chart keyboard efficiency', () => {
  test('switches timeframe and fits content on the focused panel', async ({ page }) => {
    await page.goto('/chart');
    await waitForChart(page);

    const stage = page.getByRole('group', { name: 'Price chart, AAPL' }).first();
    await stage.focus();
    await expect(stage).toBeFocused();

    const timeframe = page.getByRole('group', { name: 'Timeframe' }).first();
    await expect(timeframe.getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('2');
    await expect(timeframe.getByRole('button', { name: '1W' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.chart-legend').first()).toContainText('Weekly (aggregated from daily)');
    await expect(page.locator('.chart-stage [role="status"]').last()).toContainText('Timeframe changed to Weekly');

    await page.keyboard.press('3');
    await expect(timeframe.getByRole('button', { name: '1M' })).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('1');
    await expect(timeframe.getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('f');
    await expect(page.locator('.chart-stage [role="status"]').last()).toContainText('Chart fitted to content.');

    // The same keys typed into a field must not move the chart.
    await page.getByRole('combobox', { name: 'Active workspace' }).focus();
    await page.keyboard.press('2');
    await expect(timeframe.getByRole('button', { name: '1D' })).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('workspace layout shortcuts', () => {
  test('applies and persists Alt+Shift+1..4', async ({ page }) => {
    await page.goto('/chart');
    await waitForChart(page);

    const layout = page.getByRole('group', { name: 'Panel layout' }).first();
    await expect(layout.getByRole('button', { name: 'Single panel' })).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Alt+Shift+2');
    await expect(layout.getByRole('button', { name: 'Two stacked' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);

    await page.keyboard.press('Alt+Shift+4');
    await expect(layout.getByRole('button', { name: 'Four panels' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(4);

    await page.keyboard.press('Alt+Shift+3');
    await expect(layout.getByRole('button', { name: 'Two side by side' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);

    await page.keyboard.press('Alt+Shift+1');
    await expect(layout.getByRole('button', { name: 'Single panel' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);

    // The layout is workspace state, so a reload keeps the last choice.
    await page.keyboard.press('Alt+Shift+2');
    await page.reload();
    await waitForChart(page);
    await expect(
      page.getByRole('group', { name: 'Panel layout' }).first().getByRole('button', { name: 'Two stacked' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);
  });
});
