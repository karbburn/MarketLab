import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedLibrary } from './fixtures/library';
import { periodKeyForDate } from '../../src/lib/timeframe';

/**
 * Linked crosshair across panels.
 *
 * Two panels, two symbols, one link property. The assertion surface is the
 * legend, which is real DOM: a mirrored crosshair must also publish the linked
 * session into the receiving panel's readout. The line itself is drawn on the
 * chart canvas and is intentionally not asserted pixel by pixel.
 */

async function waitForChart(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.locator('canvas.chart-overlay').first().getAttribute('width')))
    .toBeGreaterThan(100);
}

/** The session date in a panel's OHLC legend row. */
async function panelDate(panel: Locator): Promise<string> {
  const text = await panel
    .locator('.chart-legend .legend-values')
    .first()
    .locator('.faint')
    .last()
    .innerText();
  return text.trim();
}

async function parkPointer(page: Page): Promise<void> {
  await page.mouse.move(4, 4);
  await page.waitForTimeout(250);
}

async function hoverPanel(page: Page, panel: Locator, ratio = 0.55): Promise<void> {
  const box = await panel.locator('.chart-canvas-host').boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * ratio, box!.y + box!.height * 0.45);
  await page.waitForTimeout(300);
}

/** Seeds two side-by-side panels: AAPL first, MSFT second. */
async function twoPanelWorkspace(page: Page): Promise<{ first: Locator; second: Locator }> {
  await seedLibrary(page);
  await page.goto('/#/chart');
  await waitForChart(page);

  await page.getByRole('button', { name: 'Duplicate panel' }).click();
  const panels = page.locator('.workspace-grid > .chart-panel');
  await expect(panels).toHaveCount(2);
  await waitForChart(page);

  const second = panels.nth(1);
  await second.locator('.chart-canvas-host').click({ position: { x: 80, y: 80 } });
  await page.getByLabel('Focused panel dataset').selectOption('ds_msft');
  await waitForChart(page);
  await parkPointer(page);

  return { first: panels.nth(0), second };
}

const crosshairToggle = (page: Page) => page.getByRole('checkbox', { name: 'Crosshair' });

test.describe('linked crosshair', () => {
  test('mirrors the hovered session into another panel and clears when the pointer leaves', async ({ page }) => {
    const { first, second } = await twoPanelWorkspace(page);

    const latest = await panelDate(second);
    await crosshairToggle(page).check();
    await expect(crosshairToggle(page)).toBeChecked();

    await hoverPanel(page, first);
    const hovered = await panelDate(first);
    expect(hovered).not.toBe(latest);
    // The second panel now reads the same session, from its own bars.
    await expect.poll(() => panelDate(second)).toBe(hovered);

    await parkPointer(page);
    await expect.poll(() => panelDate(second)).toBe(latest);
  });

  test('does not mirror anything while the link is off', async ({ page }) => {
    const { first, second } = await twoPanelWorkspace(page);
    const latest = await panelDate(second);

    await expect(crosshairToggle(page)).not.toBeChecked();
    await hoverPanel(page, first);
    const hovered = await panelDate(first);
    expect(hovered).not.toBe(latest);
    expect(await panelDate(second)).toBe(latest);
  });

  test('maps a daily session into the containing week of a weekly panel', async ({ page }) => {
    const { first, second } = await twoPanelWorkspace(page);
    await crosshairToggle(page).check();

    await page
      .getByRole('group', { name: 'Timeframe' })
      .nth(1)
      .getByRole('button', { name: '1W' })
      .click();
    await waitForChart(page);
    await parkPointer(page);

    await hoverPanel(page, first);
    const hovered = await panelDate(first);
    const weeklyDate = await panelDate(second);
    // Same ISO week, even though the weekly bar is labelled with its own last session.
    expect(periodKeyForDate(weeklyDate, '1W')).toBe(periodKeyForDate(hovered, '1W'));
  });

  test('keeps the link enabled after a reload and lists it with the workspace', async ({ page }) => {
    await twoPanelWorkspace(page);
    await crosshairToggle(page).check();
    await expect(crosshairToggle(page)).toBeChecked();

    await page.reload();
    await waitForChart(page);
    await expect(crosshairToggle(page)).toBeChecked();

    await page.goto('/#/workspaces');
    await expect(page.locator('table.data tbody tr').first()).toContainText('crosshair');
  });
});
