import { expect, test } from '@playwright/test';

test.describe('workspaces and settings', () => {
  test('creates and deletes a workspace', async ({ page }) => {
    await page.goto('/#/workspaces');

    const rows = page.locator('table.data tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Primary');

    await page.getByRole('button', { name: 'New single-panel workspace' }).click();
    await expect(page.getByText(/Created workspace/)).toBeVisible();
    await expect(rows).toHaveCount(2);

    await page.getByRole('button', { name: 'Delete Workspace 2' }).click();
    await expect(page.getByText('Workspace deleted.')).toBeVisible();
    await expect(rows).toHaveCount(1);
  });

  test('keeps preferences after a reload', async ({ page }) => {
    await page.goto('/#/workspaces');

    await page.getByLabel('Default timeframe').selectOption('1W');
    await expect(page.getByLabel('Default timeframe')).toHaveValue('1W');

    await page.reload();
    await expect(page.getByLabel('Default timeframe')).toHaveValue('1W');
  });

  test('exports a backup, resets local data and restores it without duplicating series', async ({ page }) => {
    await page.goto('/#/workspaces');
    await page.getByRole('button', { name: 'New single-panel workspace' }).click();
    await expect(page.locator('table.data tbody tr')).toHaveCount(2);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export backup' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^marketlab-backup-\d{4}-\d{2}-\d{2}\.json$/);

    const backupFile = test.info().outputPath('backup.json');
    await download.saveAs(backupFile);

    // Destroy local data, then restore from the file.
    await page.getByRole('button', { name: 'Reset local data to the bundled samples' }).click();
    await page.getByRole('button', { name: 'Yes, reset to the bundled sample set' }).click();
    await expect(page.getByText('Local data reset to the bundled sample set.')).toBeVisible();
    await expect(page.locator('table.data tbody tr')).toHaveCount(1);

    await page.locator('input[type="file"]').setInputFiles(backupFile);
    await expect(page.getByText('Confirm restore')).toBeVisible();
    await expect(page.getByText(/6 dataset\(s\), 2 workspace\(s\)/)).toBeVisible();
    await page.getByRole('button', { name: 'Apply restore' }).click();

    // Identical series are recognised by content hash and not duplicated.
    await expect(page.locator('.toast-body').last()).toContainText('Backup merged');
    await expect(page.locator('.shell-nav')).toContainText('6 datasets loaded');
    await expect(page.locator('table.data tbody tr')).toHaveCount(3);
    await expect(page.locator('table.data tbody tr').filter({ hasText: 'Workspace 2' })).toHaveCount(1);
  });

  test('rejects a file that is not a MarketLab backup', async ({ page }) => {
    await page.goto('/#/workspaces');

    await page.locator('input[type="file"]').setInputFiles({
      name: 'not-a-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ hello: 'world' })),
    });

    await expect(page.getByText('This file was not exported by MarketLab.')).toBeVisible();
    await expect(page.getByText('Confirm restore')).toBeHidden();
  });
});
