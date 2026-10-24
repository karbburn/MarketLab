import { expect, test } from '@playwright/test';
import {
  buildCorporateActionLibrary,
  buildIssueLibrary,
  seedLibrary,
} from './fixtures/library';

test.describe('chart data provenance', () => {
  test('shows clean provider provenance and deep-links to the inspection panel', async ({ page }) => {
    await seedLibrary(page, buildCorporateActionLibrary());
    await page.goto('/#/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('Data: clean');
    await expect(chip).toHaveAttribute('data-status', 'clean');

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Clean');
    await expect(dialog).toContainText('Yahoo Finance download');
    await expect(dialog).toContainText('NasdaqGS');
    await expect(dialog).toContainText('America/New_York');
    await expect(dialog).toContainText('splits-applied, dividends not reinvested');
    await expect(dialog).toContainText('Retrieved');
    await expect(dialog).toContainText('2026-10-16 00:00');
    await expect(dialog).toContainText('Validation counts');
    await expect(dialog).toContainText('Weekday gaps');
    // Provider caveats are carried verbatim, not paraphrased into a guarantee.
    await expect(dialog).toContainText('Unofficial, undocumented Yahoo Finance data');

    await dialog.getByRole('link', { name: 'Inspect in Data' }).click();
    await expect(page.locator('.topbar-title')).toHaveText('Data library');
    await expect(page).toHaveURL(/#\/data\?dataset=ds_aapl/);

    const inspection = page.locator('.panel').filter({ hasText: 'Inspection - AAPL' }).first();
    await expect(inspection).toBeVisible();
    await expect(inspection).toContainText('Accepted rows');

    // The selection is in the URL, so a reload keeps the same panel open.
    await page.reload();
    await expect(page.locator('.panel').filter({ hasText: 'Inspection - AAPL' }).first()).toBeVisible();
  });

  test('warns with real validation counts and the weekday-gap limitation', async ({ page }) => {
    await seedLibrary(page, buildIssueLibrary());
    await page.goto('/#/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toHaveText('Data: 6 issues');
    await expect(chip).toHaveAttribute('data-status', 'attention');

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Rejected rows');
    await expect(dialog).toContainText('Duplicate sessions');
    await expect(dialog).toContainText('Missing weekday sessions');
    await expect(dialog).toContainText('Order corrections');
    await expect(dialog).toContainText('Weekend rows');
    await expect(dialog).toContainText(
      'Without an exchange calendar, public holidays and genuinely missing sessions look identical',
    );
    await expect(dialog).toContainText('Gaps are shown as gaps and never filled');
  });

  test('labels a CSV import honestly and does not invent adjustment metadata', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/#/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toHaveText('Data: clean');
    await chip.click();

    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toContainText('Imported CSV');
    await expect(dialog).toContainText('Not recorded for this import');
    await expect(dialog).not.toContainText('Retrieved');
    await expect(dialog).toContainText('does not verify those prices against an exchange');
  });

  test('opens the requested dataset directly from the data URL', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/#/data?dataset=ds_msft');

    const inspection = page.locator('.panel').filter({ hasText: 'Inspection - MSFT' }).first();
    await expect(inspection).toBeVisible();
    await expect(inspection).toContainText('Accepted rows');

    // Closing the inspection clears the query parameter rather than leaving a
    // stale deep link behind.
    await inspection.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(/#\/data$/);
  });

  test('warns instead of pretending a missing deep-linked dataset exists', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/#/data?dataset=ds_missing');

    await expect(page.getByText('Dataset "ds_missing" is not stored in this browser.')).toBeVisible();
    await expect(page.locator('.panel').filter({ hasText: 'Inspection -' })).toHaveCount(0);
  });
});
