import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { seedLibrary, readStore } from './fixtures/library';

/**
 * Saved research-run batch export/import.
 *
 * The library is seeded with imported series so a strategy can be simulated and
 * saved. Every assertion is about the shape and identity of the files and the
 * persisted records: no assertion depends on a particular market value.
 */

test.beforeEach(async ({ page }) => {
  await seedLibrary(page);
});

function runsPanel(page: Page): Locator {
  return page.locator('.panel').filter({ hasText: 'Research runs' }).first();
}

async function saveRunNamed(page: Page, name: string, capital: string): Promise<void> {
  const panel = runsPanel(page);
  // The empty state offers "Start a new strategy"; once a draft exists the
  // toolbar offers "New strategy". Exactly one is present at a time.
  await page.getByRole('button', { name: /^(Start a new strategy|New strategy)$/ }).first().click();
  await page.getByLabel('Initial capital').fill(capital);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await panel.getByRole('button', { name: 'Save run' }).click();
  await expect(page.locator('.toast-body').last()).toContainText('Saved research run');

  await panel.getByRole('button', { name: 'Rename' }).click();
  await panel.getByLabel('Research run name').fill(name);
  await panel.getByRole('button', { name: 'Save name' }).click();
  await expect(panel.getByRole('list', { name: 'Saved research runs' })).toContainText(name);
}

function runRow(page: Page, name: string): Locator {
  return runsPanel(page).locator('.research-run-item').filter({ hasText: name });
}

test.describe('research-run batch export and import', () => {
  test('exports several runs as one file and restores them without changing the snapshots', async ({ page }) => {
    await page.goto('/#/backtest');
    await saveRunNamed(page, 'Alpha run', '250000');
    await saveRunNamed(page, 'Beta run', '300000');

    const panel = runsPanel(page);
    const exportButton = panel.getByRole('button', { name: /Export selected/ });

    // Nothing ticked: the action is unavailable and the state is stated.
    await expect(panel.getByText('No runs selected. Tick a run to include it in one batch export file.')).toBeVisible();
    await expect(exportButton).toBeDisabled();

    const beforeExport = await readStore(page, 'researchRuns');
    expect(beforeExport).toHaveLength(2);

    await panel.getByLabel('Select Alpha run for export').check();
    await panel.getByLabel('Select Beta run for export').check();
    await expect(panel.getByText('2 of 2 runs ticked for one batch export file.')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Export selected (2)' })).toBeEnabled();

    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Export selected (2)' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('marketlab.research-runs.json');
    const downloadPath = await download.path();
    expect(downloadPath).not.toBeNull();
    const text = await readFile(downloadPath as string, 'utf8');
    const batch = JSON.parse(text) as {
      app: string;
      kind: string;
      batchVersion: number;
      containsInputData: boolean;
      runs: Array<{ kind: string; manifestVersion: number; containsInputData: boolean; run: { id: string; name: string } }>;
    };

    expect(batch.app).toBe('marketlab');
    expect(batch.kind).toBe('research-run-batch');
    expect(batch.batchVersion).toBe(1);
    expect(batch.containsInputData).toBe(false);
    expect(batch.runs).toHaveLength(2);
    for (const manifest of batch.runs) {
      expect(manifest.kind).toBe('research-run');
      expect(manifest.manifestVersion).toBe(1);
      expect(manifest.containsInputData).toBe(false);
    }
    expect(batch.runs.map((manifest) => manifest.run.name).sort()).toEqual(['Alpha run', 'Beta run']);
    // Manifests never carry bars.
    expect(text).not.toContain('"bars"');

    // Remove both runs so the import has to rebuild them.
    await runRow(page, 'Alpha run').click();
    await panel.getByRole('button', { name: 'Delete', exact: true }).click();
    await runRow(page, 'Beta run').click();
    await panel.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(panel.getByText('No saved research runs')).toBeVisible();
    expect(await readStore(page, 'researchRuns')).toHaveLength(0);

    await panel.getByLabel('Import research run manifest').setInputFiles(downloadPath as string);

    const report = panel.locator('.research-import-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText('2 imported');
    await expect(report).toContainText('2 runs in the file');
    await expect(report).toContainText('Imported "Alpha run".');
    await expect(report).toContainText('Imported "Beta run".');
    await expect(page.locator('.toast-body').last()).toContainText('Batch import: 2 imported of 2 runs.');

    const stored = await readStore(page, 'researchRuns');
    expect(stored).toHaveLength(2);
    const exportedRuns = batch.runs
      .map((manifest) => manifest.run)
      .sort((left, right) => left.id.localeCompare(right.id));
    const storedRuns = [...stored].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    // The stored records are the exported snapshots, field for field.
    expect(storedRuns).toEqual(exportedRuns);

    // Re-importing the same file reports duplicates and writes nothing.
    const beforeReimport = JSON.stringify(storedRuns);
    await panel.getByLabel('Import research run manifest').setInputFiles(downloadPath as string);
    await expect(report).toContainText('2 duplicate');
    await expect(report).toContainText('2 runs in the file');
    await expect(report).toContainText('"Alpha run" is already saved. Imported runs are never overwritten.');
    const afterReimport = await readStore(page, 'researchRuns');
    expect(afterReimport).toHaveLength(2);
    expect(JSON.stringify([...afterReimport].sort((left, right) => String(left.id).localeCompare(String(right.id))))).toBe(
      beforeReimport,
    );
    await expect(panel.getByRole('list', { name: 'Saved research runs' })).toContainText('Alpha run');
  });

  test('imports the sound runs from a mixed batch and reports the rest', async ({ page }) => {
    await page.goto('/#/backtest');
    await saveRunNamed(page, 'Keep me', '150000');

    const panel = runsPanel(page);
    const stored = await readStore(page, 'researchRuns');
    expect(stored).toHaveLength(1);
    const existing = stored[0] as Record<string, unknown> & { id: string; name: string };

    const envelope = (run: Record<string, unknown>) => ({
      app: 'marketlab',
      kind: 'research-run',
      manifestVersion: 1,
      exportedAt: '2026-10-24T10:00:00.000Z',
      containsInputData: false,
      run,
    });

    const mixed = {
      app: 'marketlab',
      kind: 'research-run-batch',
      batchVersion: 1,
      exportedAt: '2026-10-24T10:00:00.000Z',
      containsInputData: false,
      runs: [
        // A new id with the recorded snapshot: importable.
        envelope({ ...existing, id: 'run-copied-snapshot', name: 'Copied snapshot' }),
        // The same id as the stored run: refused, never overwritten.
        envelope(existing),
        // Structurally invalid: reported, does not block the first entry.
        envelope({ ...existing, id: 'run-invalid', name: 'Invalid copy', dataset: { bad: true } }),
      ],
    };

    const before = JSON.stringify(existing);
    await panel.getByLabel('Import research run manifest').setInputFiles({
      name: 'mixed.research-runs.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(mixed), 'utf8'),
    });

    const report = panel.locator('.research-import-report');
    await expect(report).toBeVisible();
    await expect(report).toContainText('1 imported');
    await expect(report).toContainText('1 duplicate');
    await expect(report).toContainText('1 invalid');
    await expect(report).toContainText('3 runs in the file');
    await expect(report).toContainText('Imported "Copied snapshot".');
    await expect(report).toContainText('"Keep me" is already saved. Imported runs are never overwritten.');
    await expect(report).toContainText('"Invalid copy" was not imported:');

    const after = await readStore(page, 'researchRuns');
    expect(after).toHaveLength(2);
    const kept = after.find((run) => run.id === existing.id);
    // The pre-existing record is byte-identical: no overwrite, no rewrite.
    expect(JSON.stringify(kept)).toBe(before);
    const imported = after.find((run) => run.id === 'run-copied-snapshot');
    expect(imported).toMatchObject({ name: 'Copied snapshot' });
    expect((imported as { metrics?: unknown }).metrics).toEqual((existing as { metrics?: unknown }).metrics);
    expect((imported as { trades?: unknown }).trades).toEqual((existing as { trades?: unknown }).trades);
  });

  test('rejects a batch from a newer build without writing anything', async ({ page }) => {
    await page.goto('/#/backtest');
    await saveRunNamed(page, 'Untouched', '120000');

    const panel = runsPanel(page);
    const before = JSON.stringify(await readStore(page, 'researchRuns'));

    await panel.getByLabel('Import research run manifest').setInputFiles({
      name: 'future.research-runs.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          app: 'marketlab',
          kind: 'research-run-batch',
          batchVersion: 2,
          exportedAt: '2027-01-01T00:00:00.000Z',
          containsInputData: false,
          runs: [],
        }),
        'utf8',
      ),
    });

    await expect(page.locator('.toast-body').last()).toContainText('newer than this build supports');
    await expect(panel.locator('.research-import-report')).toHaveCount(0);
    expect(JSON.stringify(await readStore(page, 'researchRuns'))).toBe(before);
  });

  test('keeps the batch controls usable at 390 px in both themes', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/backtest');
    await saveRunNamed(page, 'Narrow run', '100000');

    const panel = runsPanel(page);
    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    await panel.getByLabel('Select Narrow run for export').check();
    await expect(panel.getByText('1 of 1 runs ticked for one batch export file.')).toBeVisible();
    const exportButton = panel.getByRole('button', { name: 'Export selected (1)' });
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toBeInViewport();

    const downloadPromise = page.waitForEvent('download');
    await exportButton.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('marketlab.research-runs.json');

    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(panel.getByLabel('Select Narrow run for export')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Export selected (1)' })).toBeVisible();
  });
});
