import { expect, test } from '@playwright/test';

/**
 * Market-data download workflow (service-offline path).
 *
 * The market-data service is intentionally not running during the Playwright
 * suite, so this spec asserts the honest offline behaviour: the dialog opens,
 * symbol entry works, and a download attempt ends in an explicit, actionable
 * "service unreachable" state — never in a fake empty dataset. The full
 * download path is covered by the deterministic unit suites plus the optional
 * live smoke check of the service itself.
 */

test.describe('market data download', () => {
  test('explains the unreachable service instead of failing silently', async ({ page }) => {
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Symbol').fill('AAPL');
    await dialog.getByRole('button', { name: 'Download' }).click();

    await expect(
      dialog.getByText(/market-data service is not reachable/i),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Save dataset' })).toBeHidden();
  });

  test('rejects an invalid symbol without contacting anything', async ({ page }) => {
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download market data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download market data' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Symbol').fill('?? bad ??');
    await expect(dialog.getByText(/Use a provider symbol/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download' })).toBeDisabled();
  });

  test('plans a pasted batch, reporting duplicates and invalid tokens', async ({ page }) => {
    await page.goto('/#/data');
    await page.getByRole('button', { name: 'Download many symbols', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Download many symbols' });
    await expect(dialog).toBeVisible();

    await dialog.locator('#bulk-symbols').fill('aapl, MSFT\naapl\n??bad??');

    // Two valid symbols, one fold of a repeat, one rejected token.
    await expect(dialog.getByText(/2 symbols ready/)).toBeVisible();
    await expect(dialog.getByText(/1 duplicate\(s\) removed/)).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Download 2 symbols' })).toBeEnabled();
    await expect(dialog.getByText(/Ignored: \?\?bad\?\?/)).toBeVisible();
  });

  test('reports an unreachable service per symbol and saves nothing', async ({ page }) => {
    await page.goto('/#/data');
    const storedRows = page.locator('.panel').filter({ hasText: 'Stored datasets' }).locator('tbody tr');
    // Wait for the persisted library to finish loading before sampling it.
    await expect(storedRows.first()).toBeVisible();
    const before = await storedRows.count();

    await page.getByRole('button', { name: 'Download many symbols', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Download many symbols' });
    await expect(dialog).toBeVisible();

    await dialog.locator('#bulk-symbols').fill('AAPL, MSFT');
    await dialog.getByRole('button', { name: 'Download 2 symbols' }).click();

    // Every symbol is reported individually; the batch does not abort early.
    await expect(dialog.getByText(/0 saved, 2 failed\./)).toBeVisible();
    await expect(dialog.getByText('Failed', { exact: true })).toHaveCount(2);
    await expect(dialog.getByText(/market-data service is not reachable/i).first()).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Retry failed (2)' })).toBeVisible();

    // Nothing was stored, so the library is unchanged.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(storedRows).toHaveCount(before);
  });
});
