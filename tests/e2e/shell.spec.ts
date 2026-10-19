import { expect, test } from '@playwright/test';

test.describe('shell, navigation and theme', () => {
  test('opens on the overview with the bundled sample data labelled as synthetic', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.topbar-title')).toHaveText('Overview');
    await expect(page.locator('.shell-nav')).toContainText('6 datasets loaded');
    await expect(page.getByText('Synthetic sample')).toBeVisible();

    // One row per bundled instrument in the summary table.
    await expect(page.locator('table.data tbody tr')).toHaveCount(6);
    await expect(page.locator('table.data tbody')).toContainText('MLAB-IDX');

    // The synthetic disclaimer must be explicit, not implied.
    await expect(page.getByText('not real market data', { exact: false })).toBeVisible();
  });

  test('reaches every section from the sidebar', async ({ page }) => {
    await page.goto('/');

    const sections: Array<{ link: string; title: string }> = [
      { link: 'Chart workspace', title: 'Chart workspace' },
      { link: 'Quant lab', title: 'Quant lab' },
      { link: 'Screener', title: 'Historical screener' },
      { link: 'Backtest', title: 'Rule-based backtest' },
      { link: 'Data', title: 'Data library' },
      { link: 'Workspaces', title: 'Workspaces and settings' },
      { link: 'Overview', title: 'Overview' },
    ];

    for (const section of sections) {
      await page.getByRole('link', { name: section.link, exact: true }).click();
      await expect(page.locator('.topbar-title')).toHaveText(section.title);
      await expect(page.locator('.page')).toBeVisible();
    }
  });

  test('switches theme and keeps the choice after a reload', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');

    await expect(html).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(html).toHaveAttribute('data-theme', 'light');

    await page.reload();
    await expect(page.locator('.topbar-title')).toHaveText('Overview');
    await expect(html).toHaveAttribute('data-theme', 'light');
  });

  test('keeps a workspace edit after a reload', async ({ page }) => {
    await page.goto('/#/chart');
    await expect(page.locator('.chart-symbol').first()).toHaveText('ATX');

    // Duplicate the focused panel, then show two panels.
    await page.getByRole('button', { name: 'Duplicate panel' }).click();
    await page.getByRole('button', { name: 'Two stacked' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);

    await page.reload();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);
  });

  test('collapses navigation into a drawer on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // The sidebar is off-canvas, so the page itself must not overflow.
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    await expect(toggle).toBeVisible();
    await expect(page.locator('.shell-nav')).not.toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await toggle.click();
    await expect(page.locator('.shell-nav')).toBeVisible();
    await expect(page.locator('.shell-nav-toggle')).toHaveAttribute('aria-expanded', 'true');

    // Following a link navigates and dismisses the drawer.
    await page.locator('.shell-nav').getByRole('link', { name: 'Screener', exact: true }).click();
    await expect(page.locator('.topbar-title')).toHaveText('Historical screener');
    await expect(page.locator('.shell-nav')).not.toBeVisible();

    // Escape also dismisses it.
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.locator('.shell-nav')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.shell-nav')).not.toBeVisible();
  });
});
