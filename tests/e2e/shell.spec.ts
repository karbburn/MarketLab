import { expect, test } from '@playwright/test';
import { buildFixtureBars, seedLibrary } from './fixtures/library';

test.describe('shell, navigation and theme', () => {
  test('starts with an empty library and explains how to get real data', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.topbar-title')).toHaveText('Overview');
    await expect(page.locator('.shell-nav')).toContainText('0 datasets loaded');

    // A fresh library is empty on purpose and says so, with the three real
    // ways to fill it.
    const panel = page.locator('.panel').filter({ hasText: 'Welcome to MarketLab' }).first();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Download real market data' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Import a CSV file' })).toBeVisible();
    await expect(panel.getByRole('link', { name: 'Open the chart workspace' })).toBeVisible();

    // No demo series, and no invented prices behind the empty state.
    await expect(page.getByText('ATX')).toHaveCount(0);
    await expect(page.getByText('MLAB-IDX')).toHaveCount(0);
    await expect(page.locator('table.data tbody tr')).toHaveCount(0);
  });

  test('reaches every section from the sidebar', async ({ page }) => {
    await page.goto('/');

    const sections: Array<{ link: string; title: string }> = [
      { link: 'Chart workspace', title: 'Chart workspace' },
      { link: 'Quant lab', title: 'Quant lab' },
      { link: 'Screener', title: 'Historical screener' },
      { link: 'Backtest', title: 'Rule-based backtest' },
      { link: 'Data', title: 'Data library' },
      { link: 'How it works', title: 'How MarketLab works' },
      { link: 'Workspaces', title: 'Workspaces and settings' },
      { link: 'Overview', title: 'Overview' },
    ];

    for (const section of sections) {
      await page.getByRole('link', { name: section.link, exact: true }).click();
      await expect(page.locator('.topbar-title')).toHaveText(section.title);
      await expect(page.locator('.page')).toBeVisible();
    }
  });

  test('labels the overview history span as a union across the stored series', async ({ page }) => {
    await seedLibrary(page);

    // The panels aggregate every stored series, so the earliest-to-latest
    // reading must be presented as a union, not as one dataset's span.
    const series = buildFixtureBars(1013, 100);
    const firstDate = series[0]?.date ?? '';
    const lastDate = series[series.length - 1]?.date ?? '';

    const span = page.locator('.panel').filter({ hasText: 'History span' }).first();
    await expect(span).toContainText('Coverage (union)');
    await expect(span).toContainText(`Earliest and latest session across the stored series: ${firstDate} through ${lastDate}`);
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
    await seedLibrary(page);
    await page.goto('/#/chart');
    await expect(page.locator('.chart-symbol').first()).toHaveText('AAPL');

    // Duplicate the focused panel, then show two panels.
    await page.getByRole('button', { name: 'Duplicate panel' }).click();
    await page.getByRole('button', { name: 'Two stacked' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);

    await page.reload();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);
  });

  test('collapses the docked sidebar on a wide viewport and restores it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    const nav = page.locator('.shell-nav');
    await expect(nav).toBeVisible();

    // The control is a drawer handle on narrow viewports and a collapse handle
    // on wide ones; on a laptop it has to actually move the layout.
    await page.getByRole('button', { name: 'Collapse navigation' }).click();
    await expect(nav).not.toBeVisible();

    const collapsed = await page.evaluate(() => {
      const main = document.querySelector('.shell-main');
      return {
        main: main ? Math.round(main.getBoundingClientRect().width) : 0,
        viewport: document.documentElement.clientWidth,
      };
    });
    expect(collapsed.main).toBeGreaterThanOrEqual(collapsed.viewport - 1);

    await page.getByRole('button', { name: 'Expand navigation' }).click();
    await expect(nav).toBeVisible();
    const navWidth = await nav.evaluate((element) => Math.round(element.getBoundingClientRect().width));
    expect(navWidth).toBeGreaterThan(200);

    // With the sidebar docked, following a link must not hide it again.
    await page.locator('.shell-nav').getByRole('link', { name: 'Screener', exact: true }).click();
    await expect(page.locator('.topbar-title')).toHaveText('Historical screener');
    await expect(nav).toBeVisible();
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

  test('moves focus into the drawer, makes the page inert and restores focus', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.getByRole('button', { name: 'Open navigation' }).click();

    const nav = page.locator('.shell-nav');
    await expect(nav).toBeVisible();
    // The first link, not the rest of the page, receives focus.
    await expect(nav.getByRole('link', { name: 'Overview', exact: true })).toBeFocused();
    expect(await page.locator('.shell-main').evaluate((element) => (element as HTMLElement).inert)).toBe(true);

    await page.keyboard.press('Escape');
    await expect(nav).not.toBeVisible();
    // Closing returns focus to the control that opened the drawer.
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
    expect(await page.locator('.shell-main').evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  });

  test('closes the drawer when the viewport leaves the narrow layout', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.locator('.shell-nav')).toBeVisible();

    // Widening docks the sidebar; the drawer state must not stay open.
    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(page.locator('.shell-nav')).not.toHaveClass(/\bopen\b/);
    await expect(page.locator('.shell-nav')).toBeVisible();

    // Coming back does not re-open a drawer the user did not ask for.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.shell-nav')).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Open navigation' })).toHaveAttribute('aria-expanded', 'false');
  });
});
