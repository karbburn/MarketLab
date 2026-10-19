import { expect, test, type Page } from '@playwright/test';
import { seedLibrary } from './fixtures/library';

/* The palette is a global overlay: every test below opens it the way a user
 * would and asserts on what they can see, hear (roles and selected state) and
 * act on. Fixtures are deterministic; nothing here touches the network. */

const palette = (page: Page) => page.getByRole('dialog', { name: 'Command palette' });
const search = (page: Page) => page.getByRole('combobox', { name: 'Search views, actions and local datasets' });
const trigger = (page: Page) => page.getByRole('button', { name: /^Open the command palette/ });

/**
 * Navigates and waits for the shell to mount. The store hydrates from IndexedDB
 * after `load`, and the shell owns the palette shortcut, so pressing keys before
 * this point would race the listener registration.
 */
async function gotoReady(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(trigger(page)).toBeVisible();
}

test.describe('global command palette', () => {
  test('opens from the shell control, focuses the field and restores focus on close', async ({ page }) => {
    await gotoReady(page, '/');

    const button = trigger(page);
    await button.click();

    await expect(palette(page)).toBeVisible();
    // Typing goes straight into the field, with no extra click.
    await expect(search(page)).toBeFocused();
    await expect(search(page)).toHaveValue('');

    // The overlay must sit above chart panels, the sidebar, dialogs and toasts.
    await expect(page.locator('.palette-backdrop')).toHaveCSS('z-index', '70');

    await page.getByRole('button', { name: 'Close command palette' }).click();
    await expect(palette(page)).toBeHidden();
    await expect(button).toBeFocused();
  });

  test('opens with Ctrl+K, Cmd+K and Ctrl+Shift+P', async ({ page }) => {
    await gotoReady(page, '/');

    for (const shortcut of ['Control+k', 'Meta+k', 'Control+Shift+p']) {
      await page.keyboard.press(shortcut);
      await expect(palette(page), `${shortcut} should open the palette`).toBeVisible();
      await expect(search(page)).toBeFocused();

      await page.keyboard.press('Escape');
      await expect(palette(page), `${shortcut} palette should close with Escape`).toBeHidden();
    }
  });

  test('filters, moves the highlight with the arrow keys and runs it with Enter', async ({ page }) => {
    await gotoReady(page, '/');
    await page.keyboard.press('Control+k');

    // An empty query starts on the first navigation entry.
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('Overview');
    await page.keyboard.press('ArrowDown');
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('Chart workspace');
    await page.keyboard.press('ArrowDown');
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('Quant lab');
    await page.keyboard.press('ArrowUp');
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('Chart workspace');

    await page.keyboard.press('Enter');
    await expect(palette(page)).toBeHidden();
    await expect(page.locator('.topbar-title')).toHaveText('Chart workspace');

    // A query narrows the list and lands on the best match.
    await page.keyboard.press('Control+k');
    await search(page).fill('  QUANT  ');
    await expect(palette(page).getByRole('option')).toHaveCount(1);
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('Quant lab');
    await page.keyboard.press('Enter');
    await expect(page.locator('.topbar-title')).toHaveText('Quant lab');
  });

  test('opens a stored dataset in the chart workspace without duplicating a panel', async ({ page }) => {
    await seedLibrary(page);
    await gotoReady(page, '/#/data');

    await page.keyboard.press('Control+k');
    await search(page).fill('msft');

    // One local match, symbol first and the stored dataset details beside it.
    await expect(palette(page).getByRole('option')).toHaveCount(1);
    const option = palette(page).getByRole('option', { name: /MSFT/ });
    await expect(option).toContainText('MSFT');
    await expect(option).toContainText('MSFT Test Series');
    await expect(option).toContainText('daily');
    await expect(option).toContainText('320 sessions');

    await page.keyboard.press('Enter');
    await expect(page.locator('.topbar-title')).toHaveText('Chart workspace');
    await expect(page.locator('.chart-symbol').first()).toHaveText('MSFT');
    await expect(page.locator('.chart-stage')).toHaveCount(1);

    // Reopening offers the same dataset as a recent, and choosing it again
    // activates the panel already showing it instead of adding another.
    await page.keyboard.press('Control+k');
    await expect(palette(page).getByRole('group', { name: 'Recently used' })).toBeVisible();
    await expect(palette(page).getByRole('option', { selected: true })).toContainText('MSFT');
    await search(page).fill('msft');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chart-symbol').first()).toHaveText('MSFT');
    await expect(page.locator('.chart-stage')).toHaveCount(1);
  });

  test('closes when the backdrop is clicked', async ({ page }) => {
    await gotoReady(page, '/');
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();

    // The palette is pinned near the top, so the top-left corner is backdrop.
    await page.mouse.click(4, 4);
    await expect(palette(page)).toBeHidden();
  });

  test('stays usable on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await seedLibrary(page);
    await gotoReady(page, '/');

    // The shortcut hint is dropped before the control itself gets cramped.
    await expect(page.locator('.palette-trigger-kbd')).toBeHidden();

    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    await search(page).fill('spy');
    await expect(palette(page).getByRole('option', { name: /SPY/ })).toBeVisible();

    const box = await page.locator('.palette').boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBe(0);

    await page.keyboard.press('Enter');
    await expect(page.locator('.topbar-title')).toHaveText('Chart workspace');
    await expect(page.locator('.chart-symbol').first()).toHaveText('SPY');
  });

  test('never offers a dataset that was deleted', async ({ page }) => {
    await seedLibrary(page);
    await gotoReady(page, '/#/data');

    const row = page.locator('table.data tbody tr').first();
    await expect(row).toContainText('AAPL');
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await row.getByRole('button', { name: 'Delete dataset' }).click();
    await expect(page.locator('table.data tbody tr')).toHaveCount(5);

    await page.keyboard.press('Control+k');
    await search(page).fill('aapl');
    await expect(page.getByText('No results for “aapl”.')).toBeVisible();
    await expect(palette(page).getByRole('option', { name: /AAPL/ })).toHaveCount(0);
  });

  test('offers no invented datasets in an empty library', async ({ page }) => {
    await gotoReady(page, '/');
    await page.keyboard.press('Control+k');

    await expect(page.getByText('0 datasets in the local library')).toBeVisible();
    await expect(palette(page).getByRole('option', { name: /AAPL/ })).toHaveCount(0);
    // Navigation and the real actions are still there.
    await expect(palette(page).getByRole('option', { name: /Chart workspace/ })).toBeVisible();
    await expect(palette(page).getByRole('option', { name: /Import a CSV file/ })).toBeVisible();

    await search(page).fill('aapl');
    await expect(page.getByText('No results for “aapl”.')).toBeVisible();
  });

  test('keeps the palette shortcut working inside a form field', async ({ page }) => {
    await seedLibrary(page);
    await gotoReady(page, '/#/chart');

    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    const nameField = page.getByRole('textbox', { name: 'Workspace name' });
    await nameField.fill('Primary');
    await nameField.click();

    // Ctrl+K is the documented exception: it must still reach the palette, and
    // must not type a "k" into the field it was pressed in.
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    await expect(search(page)).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    await expect(nameField).toHaveValue('Primary');
  });

  test('leaves drawing shortcuts and their tool state untouched', async ({ page }) => {
    await seedLibrary(page);
    await gotoReady(page, '/#/chart');

    const trend = page.getByRole('button', { name: 'Trend line' });
    const pointer = page.getByRole('button', { name: 'Pointer and selection' });

    // The existing drawing shortcut still cancels a tool.
    await trend.click();
    await expect(trend).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(pointer).toHaveAttribute('aria-pressed', 'true');

    // With the palette open, Escape belongs to the palette: the selected tool
    // survives, because the chart ignores keys aimed at a dialog.
    await trend.click();
    await expect(trend).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Control+k');
    await expect(palette(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(palette(page)).toBeHidden();
    await expect(trend).toHaveAttribute('aria-pressed', 'true');
  });
});
