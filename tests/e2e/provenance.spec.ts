import { expect, test } from '@playwright/test';
import {
  buildAdvisoryOnlyLibrary,
  buildCorporateActionLibrary,
  buildIssueLibrary,
  buildMixedSeverityLibrary,
  buildMultiChartLibrary,
  buildPartialCoverageLibrary,
  seedLibrary,
} from './fixtures/library';

test.describe('chart data provenance', () => {
  test('shows clean provider provenance and deep-links to the focused inspection panel', async ({ page }) => {
    await seedLibrary(page, buildCorporateActionLibrary());
    await page.goto('/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('Data: no issues');
    await expect(chip).toHaveAttribute('data-status', 'clean');
    expect(await chip.getAttribute('data-severity')).toBeNull();
    // Freshness is descriptive and day-granular, so the test matches the shape
    // rather than freezing the calendar date the suite runs on.
    await expect(chip).toHaveAttribute(
      'title',
      /^Data: no issues - (retrieved|imported) .+ - open provenance and quality details$/,
    );

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('No recorded issues');
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

    // The status is a report of what MarketLab checked, not a certification,
    // and the dialog says so.
    await expect(dialog).toContainText('This is not a certification');

    // This download predates stored coverage, so the dialog reports the stored
    // sessions and never claims coverage of a requested window.
    await expect(dialog).toContainText('320 stored sessions');
    await expect(dialog).not.toContainText('Sessions outside the returned window');

    await dialog.getByRole('link', { name: 'Inspect in Data' }).click();
    await expect(page.locator('.topbar-title')).toHaveText('Data library');
    await expect(page).toHaveURL(/\/data\?dataset=ds_aapl#inspection$/);

    const inspection = page.locator('.panel').filter({ hasText: 'Inspection - AAPL' }).first();
    await expect(inspection).toBeVisible();
    await expect(inspection).toContainText('Accepted rows');
    // The explicit fragment scrolls to and focuses the inspection region.
    await expect(inspection).toBeFocused();

    // Reloading the deep link restores the selection and the focus behaviour.
    await page.reload();
    const reloaded = page.locator('.panel').filter({ hasText: 'Inspection - AAPL' }).first();
    await expect(reloaded).toBeVisible();
    await expect(reloaded).toBeFocused();
  });

  test('warns with prioritised material issues and the weekday-gap limitation', async ({ page }) => {
    await seedLibrary(page, buildIssueLibrary());
    await page.goto('/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toHaveText('Data: 3 issues');
    await expect(chip).toHaveAttribute('data-status', 'attention');
    await expect(chip).toHaveAttribute('data-severity', 'material');

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('3 issues, 3 notes');
    // Material issues and advisory notes are separate groups; nothing is hidden.
    await expect(dialog.locator('.field-label').filter({ hasText: /^Issues$/ })).toHaveCount(1);
    await expect(dialog.locator('.field-label').filter({ hasText: /^Notes$/ })).toHaveCount(1);
    await expect(dialog).toContainText('Rejected rows');
    await expect(dialog).toContainText('Duplicate session rows');
    await expect(dialog).toContainText('Weekend rows');
    await expect(dialog).toContainText('Rows without volume');
    await expect(dialog).toContainText('Missing weekday sessions');
    await expect(dialog).toContainText('Order corrections');
    await expect(dialog).toContainText(
      'Without an exchange calendar, public holidays and genuinely missing sessions look identical',
    );
    await expect(dialog).toContainText('Gaps are shown as gaps and never filled');
  });

  test('labels a CSV import honestly and does not invent adjustment metadata', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toHaveText('Data: no issues');
    await chip.click();

    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toContainText('No recorded issues');
    await expect(dialog).toContainText('Imported CSV');
    await expect(dialog).toContainText('Not recorded for this import');
    await expect(dialog).not.toContainText('Retrieved');
    await expect(dialog).toContainText('does not verify those prices against an exchange');
  });

  test('reports advisory-only findings as notes without a warning chip', async ({ page }) => {
    await seedLibrary(page, buildAdvisoryOnlyLibrary());
    await page.goto('/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toHaveText('Data: 2 notes');
    await expect(chip).toHaveAttribute('data-status', 'attention');
    await expect(chip).toHaveAttribute('data-severity', 'advisory');

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toContainText('2 notes');
    await expect(dialog).not.toContainText('No recorded issues');
    await expect(dialog.locator('.field-label').filter({ hasText: /^Notes$/ })).toHaveCount(1);
    // No material tier exists, so there is no Issues group.
    await expect(dialog.locator('.field-label').filter({ hasText: /^Issues$/ })).toHaveCount(0);
    await expect(dialog).toContainText('Rows without volume');
    await expect(dialog).toContainText('Missing weekday sessions');
  });

  test('reports mixed severity on the chip and keeps both dialog groups', async ({ page }) => {
    await seedLibrary(page, buildMixedSeverityLibrary());
    await page.goto('/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toHaveText('Data: 1 issue');
    await expect(chip).toHaveAttribute('data-severity', 'material');

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toContainText('1 issue, 1 note');
    await expect(dialog.locator('.field-label').filter({ hasText: /^Issues$/ })).toHaveCount(1);
    await expect(dialog.locator('.field-label').filter({ hasText: /^Notes$/ })).toHaveCount(1);
    await expect(dialog).toContainText('Rejected rows');
    await expect(dialog).toContainText('Missing weekday sessions');
  });

  test('selects a dataset from the table without stealing focus, and clears URL state on close', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/data');

    await page
      .locator('tbody tr')
      .filter({ hasText: 'AAPL' })
      .getByRole('button', { name: 'Inspect' })
      .click();

    const inspection = page.locator('.panel').filter({ hasText: 'Inspection - AAPL' }).first();
    await expect(inspection).toBeVisible();
    await expect(inspection).toContainText('Accepted rows');
    // Only the explicit fragment may move focus.
    await expect(inspection).not.toBeFocused();
    await expect(page).toHaveURL(/\/data\?dataset=ds_aapl$/);

    await inspection.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(/\/data$/);
    await expect(page.locator('.panel').filter({ hasText: 'Inspection -' })).toHaveCount(0);

    // A deep link with the fragment selects and focuses the panel, and the
    // focus behaviour survives a reload.
    await page.goto('/data?dataset=ds_msft#inspection');
    const msft = page.locator('.panel').filter({ hasText: 'Inspection - MSFT' }).first();
    await expect(msft).toBeVisible();
    await expect(msft).toBeFocused();
    await page.reload();
    await expect(page.locator('.panel').filter({ hasText: 'Inspection - MSFT' }).first()).toBeFocused();

    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page).toHaveURL(/\/data$/);
  });

  test('warns instead of pretending a missing deep-linked dataset exists', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/data?dataset=ds_missing#inspection');

    await expect(page.getByText('Dataset "ds_missing" is not stored in this browser.')).toBeVisible();
    await expect(page.locator('.panel').filter({ hasText: 'Inspection -' })).toHaveCount(0);
  });

  test('surfaces a download shortfall and opens and closes by keyboard and pointer', async ({ page }) => {
    await seedLibrary(page, buildPartialCoverageLibrary());
    await page.goto('/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toBeVisible();
    // The shortfall is the only recorded issue, so the chip reads singular.
    await expect(chip).toHaveText('Data: 1 issue');
    await expect(chip).toHaveAttribute('data-status', 'attention');
    await expect(chip).toHaveAttribute('data-severity', 'material');

    // Keyboard open: focus the chip and press Enter.
    await chip.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1 issue');
    await expect(dialog).toContainText('issues that may affect what this chart shows');
    await expect(dialog).toContainText('Requested range not covered');
    await expect(dialog).toContainText('requested 2015-01-02');

    // Keyboard close returns focus to the chip that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(chip).toBeFocused();

    // Pointer open and close.
    await chip.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    // The shortfall deep-links into the inspection panel that names the
    // requested window.
    await chip.click();
    await dialog.getByRole('link', { name: 'Inspect in Data' }).click();
    await expect(page).toHaveURL(/\/data\?dataset=ds_aapl#inspection$/);
    const inspection = page.locator('.panel').filter({ hasText: 'Inspection - AAPL' }).first();
    await expect(inspection).toBeVisible();
    await expect(inspection).toContainText('Requested range');
    await expect(inspection).toContainText('2015-01-02');
  });

  test('lists comparison-series provenance and links each row to its own dataset', async ({ page }) => {
    await seedLibrary(page, buildMultiChartLibrary());
    await page.goto('/chart');

    // Add MSFT as an overlay on the first panel.
    await page.getByRole('button', { name: 'Compare symbol' }).first().click();
    const compareDialog = page.getByRole('dialog', { name: 'Compare symbols' });
    await expect(compareDialog).toBeVisible();
    await compareDialog.getByLabel('Stored series to compare').selectOption('ds_msft');
    await compareDialog.getByRole('button', { name: 'Add overlay' }).click();
    await compareDialog.getByRole('button', { name: 'Close', exact: true }).click();

    const primaryChip = page.locator('.provenance-chip').first();
    // The chip remains primary-dataset only.
    await expect(primaryChip).toHaveText('Data: no issues');
    await primaryChip.click();

    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toContainText('No recorded issues');
    await expect(dialog).toContainText('Also on this chart');
    const comparisonRow = dialog.locator('.provenance-compare-row');
    await expect(comparisonRow).toHaveCount(1);
    await expect(comparisonRow).toContainText('MSFT');
    await expect(comparisonRow).toContainText('Imported CSV');
    // The row reuses the comparison dataset's own summary, not the primary's.
    await expect(comparisonRow).toContainText('Data: 2 notes');

    await dialog.getByRole('link', { name: 'Inspect MSFT in Data' }).click();
    await expect(page).toHaveURL(/\/data\?dataset=ds_msft#inspection$/);
    const inspection = page.locator('.panel').filter({ hasText: 'Inspection - MSFT' }).first();
    await expect(inspection).toBeVisible();
    await expect(inspection).toBeFocused();
  });

  test('keeps each panel provenance independent in a multi-chart workspace', async ({ page }) => {
    await seedLibrary(page, buildMultiChartLibrary());
    await page.goto('/chart');

    const chips = page.locator('.provenance-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveText('Data: no issues');
    await expect(chips.nth(1)).toHaveText('Data: 2 notes');
    await expect(chips.nth(1)).toHaveAttribute('data-severity', 'advisory');

    await chips.nth(1).click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toContainText('2 notes');
    await expect(dialog).not.toContainText('No recorded issues');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    await chips.nth(0).click();
    await expect(dialog).toContainText('No recorded issues');
  });

  test('updates provenance when the panel dataset changes and closes an open dialog', async ({ page }) => {
    await seedLibrary(page, buildAdvisoryOnlyLibrary());
    await page.goto('/chart');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toHaveText('Data: 2 notes');

    // Weekly aggregation is derived, so the stored dataset provenance is unchanged.
    const timeframe = page.getByRole('group', { name: 'Timeframe' }).first();
    await timeframe.getByRole('button', { name: '1W' }).click();
    await expect(chip).toHaveText('Data: 2 notes');

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toContainText('2 notes');

    // Change the focused panel's dataset while the dialog is open. The select is
    // behind the modal, so dispatch the change the way a keyboard user would
    // after the modal is dismissed; the point is that the panel is re-pointed
    // and the open dialog must not keep describing the old series.
    await page.getByLabel('Focused panel dataset').evaluate((element, value) => {
      const select = element as HTMLSelectElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }, 'ds_msft');

    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.chart-symbol').first()).toHaveText('MSFT');
    await expect(chip).toHaveText('Data: no issues');
    expect(await chip.getAttribute('data-severity')).toBeNull();
  });

  test('renders the disclosure in light theme without changing the words', async ({ page }) => {
    await seedLibrary(page, buildIssueLibrary());
    await page.goto('/chart');

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    const chip = page.locator('.provenance-chip').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('Data: 3 issues');

    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Data provenance' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Rejected rows');
    await expect(dialog).toContainText('Missing weekday sessions');
    await expect(dialog).toContainText(
      'Without an exchange calendar, public holidays and genuinely missing sessions look identical',
    );
  });

  test('keeps the chip and dialog inside 320 px and 390 px viewports', async ({ page }) => {
    await seedLibrary(page, buildMixedSeverityLibrary());

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/chart');

      const chip = page.locator('.provenance-chip').first();
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText('Data: 1 issue');

      const chipBox = await chip.boundingBox();
      expect(chipBox, `chip should have a box at ${width}px`).not.toBeNull();
      expect(chipBox!.x).toBeGreaterThanOrEqual(0);
      expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(width + 1);

      let overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `page should not overflow at ${width}px`).toBeLessThanOrEqual(1);

      await chip.click();
      const dialog = page.getByRole('dialog', { name: 'Data provenance' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('1 issue, 1 note');

      const dialogBox = await dialog.boundingBox();
      expect(dialogBox, `dialog should have a box at ${width}px`).not.toBeNull();
      expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(width + 1);

      overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `dialog should not overflow at ${width}px`).toBeLessThanOrEqual(1);

      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
    }
  });
});
