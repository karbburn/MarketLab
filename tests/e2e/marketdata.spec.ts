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
});
