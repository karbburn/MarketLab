import { expect, test } from '@playwright/test';
import { seedLibrary } from './fixtures/library';

const GOOD_CSV = [
  'date,open,high,low,close,volume',
  '2026-02-02,10.0,11.0,9.5,10.5,1000',
  '2026-02-03,10.5,12.0,10.0,11.5,1200',
  '2026-02-04,11.5,12.5,11.0,12.0,900',
  '2026-02-05,12.0,13.0,11.8,12.8,1500',
].join('\n');

const PARTLY_BAD_CSV = [
  'date,open,high,low,close,volume',
  '2026-02-02,10.0,11.0,9.5,10.5,1000',
  '2026-02-03,10.5,10.6,10.4,11.0,1200',
  '2026-02-04,-1.0,2.0,0.5,1.5,900',
].join('\n');

const ENTIRELY_BAD_CSV = ['date,open,high,low,close', '2026-02-02,10,9,11,10'].join('\n');

async function openImportDialog(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Import data' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import OHLCV from CSV' });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe('data library', () => {
  // The library starts empty in the application; the data tests work against a
  // seeded set of imported series.
  test.beforeEach(async ({ page }) => {
    await seedLibrary(page);
  });

  test('imports a CSV file and shows the imported series', async ({ page }) => {
    await page.goto('/#/data');
    await expect(page.locator('.shell-nav')).toContainText('6 datasets loaded');

    const dialog = await openImportDialog(page);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'zeta.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(GOOD_CSV),
    });

    await expect(dialog.getByText('4 rows accepted')).toBeVisible();
    await dialog.getByRole('button', { name: 'Import dataset' }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByText(/Imported ZETA/)).toBeVisible();
    await expect(page.locator('.shell-nav')).toContainText('7 datasets loaded');

    const row = page.locator('table.data tbody tr').filter({ hasText: 'ZETA' });
    await expect(row).toContainText('Imported CSV');
    await expect(row).toContainText('2026-02-05');

    await row.getByRole('button', { name: 'Inspect' }).click();
    const inspection = page.locator('.panel').filter({ hasText: 'Inspection - ZETA' }).first();
    await expect(inspection).toBeVisible();
    await expect(inspection).toContainText('Accepted rows');
    await expect(inspection).toContainText('UTC');
  });

  test('rejects rows that break the OHLC invariants and explains why', async ({ page }) => {
    await page.goto('/#/data');
    const dialog = await openImportDialog(page);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'mixed.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(PARTLY_BAD_CSV),
    });

    await expect(dialog.getByText('1 row accepted')).toBeVisible();
    // The first row is kept, the other two are rejected for real reasons.
    const validation = dialog.locator('.panel').filter({ hasText: 'Validation' }).first();
    await expect(validation).toContainText('High (10.6) is below');
    await expect(validation).toContainText('greater than zero');
    await expect(validation).toContainText('Series with zero or negative prices');
  });

  test('refuses a file where no row is usable', async ({ page }) => {
    await page.goto('/#/data');
    const dialog = await openImportDialog(page);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'broken.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(ENTIRELY_BAD_CSV),
    });

    await expect(dialog.getByText('Cannot import')).toBeVisible();
    await expect(dialog.getByText('No valid rows were found in the file.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Import dataset' })).toBeDisabled();
  });

  test('exports a stored dataset as CSV', async ({ page }) => {
    await page.goto('/#/data');

    const downloadPromise = page.waitForEvent('download');
    await page.locator('table.data tbody tr').first().getByRole('button', { name: 'Export' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^marketlab-.*-daily\.csv$/);
    const file = test.info().outputPath('export.csv');
    await download.saveAs(file);
  });

  test('deletes a dataset and reports the new count', async ({ page }) => {
    await page.goto('/#/data');
    await expect(page.locator('.shell-nav')).toContainText('6 datasets loaded');

    const row = page.locator('table.data tbody tr').first();
    await row.getByRole('button', { name: 'Delete', exact: true }).click();

    // Deletion is destructive for panels and drawings, so it asks first.
    await expect(row.getByText(/Removes \d+ panel\(s\)/)).toBeVisible();
    await row.getByRole('button', { name: 'Delete dataset' }).click();

    await expect(page.getByText('Dataset removed.')).toBeVisible();
    await expect(page.locator('table.data tbody tr')).toHaveCount(5);
    await expect(page.locator('.shell-nav')).toContainText('5 datasets loaded');
  });
});
