import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { seedLibrary } from './fixtures/library';

test.describe('workspaces and settings', () => {
  test('creates and deletes a workspace', async ({ page }) => {
    await seedLibrary(page);
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

  test('exports a backup, deletes local data and restores it without duplicating series', async ({ page }) => {
    await seedLibrary(page);
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
    await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, delete all local data' }).click();
    await expect(page.getByText('All local data was deleted.')).toBeVisible();
    await expect(page.locator('table.data tbody tr')).toHaveCount(0);

    await page.locator('input[type="file"]').setInputFiles(backupFile);
    await expect(page.getByText('Confirm restore')).toBeVisible();
    await expect(page.getByText(/6 dataset\(s\), 2 workspace\(s\)/)).toBeVisible();
    await page.getByRole('button', { name: 'Apply restore' }).click();

    // Identical series are recognised by content hash and not duplicated.
    await expect(page.locator('.toast-body').last()).toContainText('Backup merged');
    await expect(page.locator('.shell-nav')).toContainText('6 datasets loaded');
    await expect(page.locator('table.data tbody tr')).toHaveCount(2);
    await expect(page.locator('table.data tbody tr').filter({ hasText: 'Workspace 2' })).toHaveCount(1);
  });

  test('reports a workspace whose dataset cannot be restored instead of writing it', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/#/workspaces');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export backup' }).click();
    const download = await downloadPromise;
    const file = test.info().outputPath('damaged-backup.json');
    await download.saveAs(file);

    // Damage the exported file: keep one dataset and the workspace that uses
    // it, but change the recorded hash so the bars no longer verify.
    const bundle = JSON.parse(await readFile(file, 'utf8')) as {
      instruments: Array<{ id: string }>;
      datasets: Array<{ id: string; instrumentId: string; contentHash: string }>;
      bars: Array<{ id: string }>;
      workspaces: Array<{ charts: Array<{ datasetId: string }> }>;
      watchlists: unknown[];
      screeners: unknown[];
      backtests: unknown[];
    };
    const workspace = bundle.workspaces[0]!;
    const datasetId = workspace.charts[0]!.datasetId;
    const dataset = bundle.datasets.find((entry) => entry.id === datasetId)!;
    dataset.contentHash = 'fnv1a-00000000';
    bundle.datasets = [dataset];
    bundle.bars = bundle.bars.filter((entry) => entry.id === datasetId);
    bundle.workspaces = [workspace];
    bundle.instruments = bundle.instruments.filter((entry) => entry.id === dataset.instrumentId);
    bundle.watchlists = [];
    bundle.screeners = [];
    bundle.backtests = [];
    await writeFile(file, JSON.stringify(bundle), 'utf8');

    await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
    await page.getByRole('button', { name: 'Yes, delete all local data' }).click();
    await expect(page.locator('table.data tbody tr')).toHaveCount(0);

    await page.locator('input[type="file"]').setInputFiles(file);
    await expect(page.getByText('Confirm restore')).toBeVisible();
    await page.getByRole('button', { name: 'Apply restore' }).click();

    // The dataset failed validation, so neither it nor the workspace that
    // referenced it may be written; the result says so rather than shrinking.
    await expect(page.locator('.toast-body').last()).toContainText(
      '1 workspace could not be restored because its dataset was missing.',
    );
    await expect(page.locator('table.data tbody tr')).toHaveCount(0);
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
