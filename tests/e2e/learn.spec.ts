import { expect, test } from '@playwright/test';
import { seedLibrary } from './fixtures/library';

test.describe('learning page', () => {
  test('opens from the sidebar and states the conventions up front', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'How it works', exact: true }).click();

    await expect(page.locator('.topbar-title')).toHaveText('How MarketLab works');
    await expect(page.getByRole('heading', { level: 1, name: 'How MarketLab works' })).toBeVisible();
    await expect(page.locator('.learn-section')).toHaveCount(11);
    await expect(page.locator('.learn-facts')).toContainText('252');
    await expect(page.locator('.learn-rail')).toContainText('Metric reference');
    await expect(page.locator('.learn-rail').getByRole('link', { name: 'What is stored', exact: true })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  test('uses the contents rail to move to a section', async ({ page }) => {
    await page.goto('/learn');

    await page.locator('.learn-rail').getByRole('link', { name: 'Backtests', exact: true }).click();

    await expect(page).toHaveURL(/#\/learn\?section=execution$/);
    await expect(page.getByRole('heading', { level: 2, name: 'Backtests' })).toBeFocused();
    await expect(page.locator('.learn-rail').getByRole('link', { name: 'Backtests', exact: true })).toHaveAttribute(
      'aria-current',
      'location',
    );
  });

  test('deep-links to a late section and marks it current while the scroll settles', async ({ page }) => {
    await page.goto('/learn?section=route');

    const heading = page.getByRole('heading', { level: 2, name: 'A route through the app' });
    await expect(heading).toBeFocused();
    await expect(
      page.locator('.learn-rail').getByRole('link', { name: 'A route through the app', exact: true }),
    ).toHaveAttribute('aria-current', 'location');

    // The last section can sit below the 170px spy line, so the bottom of the
    // page must still count as arriving at it.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(
      page.locator('.learn-rail').getByRole('link', { name: 'A route through the app', exact: true }),
    ).toHaveAttribute('aria-current', 'location');
  });

  test('clears a deep-linked highlight when returning to the guide root', async ({ page }) => {
    await page.goto('/learn?section=rule-check');
    await expect(
      page.locator('.learn-rail').getByRole('link', { name: 'Check the rule', exact: true }),
    ).toHaveAttribute('aria-current', 'location');

    // The root URL has no section, so the spy must recompute instead of leaving
    // the previous deep link current after a same-page navigation.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole('link', { name: 'How it works', exact: true }).click();
    await expect(page).toHaveURL(/#\/learn$/);
    await expect(
      page.locator('.learn-rail').getByRole('link', { name: 'What is stored', exact: true }),
    ).toHaveAttribute('aria-current', 'location');
  });

  test('puts the contents rail first in DOM order and above the content on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 });
    await page.goto('/learn');

    await expect(page.getByRole('navigation', { name: 'On this page' })).toBeVisible();

    const railBeforeContent = await page.evaluate(() => {
      const rail = document.querySelector('.learn-rail');
      const content = document.querySelector('.learn-content');
      if (!rail || !content) return false;
      return Boolean(rail.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(railBeforeContent).toBe(true);

    const railBox = await page.locator('.learn-rail').boundingBox();
    const contentBox = await page.locator('.learn-content').boundingBox();
    expect(railBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    expect(railBox?.y ?? Number.MAX_SAFE_INTEGER).toBeLessThan(contentBox?.y ?? 0);
  });

  test('calculates CAGR from user inputs and withholds a short span', async ({ page }) => {
    await page.goto('/learn?section=returns');

    const calc = page.locator('.learn-calc');
    await calc.getByLabel('Start value').fill('100');
    await calc.getByLabel('End value').fill('121');
    await calc.getByLabel('Calendar days').fill('730');

    await expect(calc.locator('.learn-calc-row').filter({ hasText: 'Total return' })).toContainText('+21.00%');
    await expect(calc.locator('.learn-calc-row').filter({ hasText: 'CAGR' })).toContainText('+10.01%');
    await expect(calc.locator('.learn-calc-row').filter({ hasText: 'Calendar years' })).toContainText('2.00');

    await calc.getByLabel('Calendar days').fill('30');
    await expect(calc.locator('.learn-calc-row').filter({ hasText: 'CAGR' })).toContainText('--');
    await expect(calc).toContainText('CAGR is withheld for spans of 30 days or less');
  });

  test('explores a metric formula and its withheld cases', async ({ page }) => {
    await page.goto('/learn?section=reference');
    const explorer = page.locator('.learn-explorer');

    await explorer.getByRole('button', { name: 'Risk', exact: true }).click();
    await expect(explorer.getByRole('button', { name: 'Risk', exact: true })).toHaveAttribute('aria-pressed', 'true');

    await explorer.getByRole('button', { name: 'Maximum drawdown', exact: true }).click();
    await expect(explorer.getByRole('heading', { name: 'Maximum drawdown' })).toBeVisible();
    await expect(explorer.locator('.learn-formula')).toContainText('runningPeak');
    await expect(explorer).toContainText('Close-to-close only. An intraday low is not used.');
    await expect(explorer.getByRole('link', { name: 'Quant lab' })).toBeVisible();
    await expect(explorer.getByRole('button', { name: 'Copy formula for Maximum drawdown' })).toBeVisible();
  });

  test('reports a clipboard failure instead of failing silently', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error('clipboard blocked')),
        },
      });
    });
    await page.goto('/learn?section=reference');
    const explorer = page.locator('.learn-explorer');

    await explorer.getByRole('button', { name: 'Copy formula for Total return' }).click();

    await expect(explorer.locator('.learn-copy')).toHaveAttribute('data-state', 'error');
    await expect(explorer.getByRole('status')).toContainText('Copy is unavailable here');

    // Changing the metric clears the error for the next formula.
    await explorer.getByRole('button', { name: 'CAGR', exact: true }).click();
    await expect(explorer.getByRole('status')).toHaveText('');
  });

  test('moves the screener cutoff through the warm-up boundary', async ({ page }) => {
    await page.goto('/learn?section=screening');
    const drill = page.locator('#screening .learn-drill');
    const slider = drill.getByLabel('Cutoff session');

    await slider.focus();
    await slider.press('Home');
    for (let step = 0; step < 5; step += 1) await slider.press('ArrowRight');

    await expect(drill).toContainText('6 of 12 sessions');
    await expect(drill.locator('.learn-drill-stat').filter({ hasText: '6-session return' })).toContainText(
      'Needs 7 sessions',
    );

    await slider.press('ArrowRight');
    await expect(drill).toContainText('7 of 12 sessions');
    await expect(drill.locator('.learn-drill-stat').filter({ hasText: '6-session return' })).toContainText(
      'Available',
    );
    await expect(drill.locator('.learn-drill-stat').filter({ hasText: 'Sessions after cutoff' })).toContainText('5');
  });

  test('tests whether two saved runs are comparable', async ({ page }) => {
    await page.goto('/learn?section=comparison');
    const drill = page.locator('.learn-compare-drill');

    await expect(drill).toContainText('0 of 6 differences');
    await expect(drill.locator('.learn-compare-verdict')).toContainText('No differences selected');
    await expect(drill.getByRole('button', { name: 'Reset differences' })).toBeDisabled();

    await drill.getByRole('button', { name: 'Different strategy settings' }).click();
    await expect(drill.getByRole('button', { name: 'Different strategy settings' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(drill.locator('.learn-compare-verdict')).toContainText(
      'Comparable inputs, different strategy',
    );
    await expect(drill.locator('.learn-compare-verdict')).not.toContainText('Not directly comparable');

    // The chips are ordinary buttons, so activation does not need a custom key handler.
    const missing = drill.getByRole('button', { name: 'Dataset missing now' });
    await missing.focus();
    await missing.press('Enter');
    await expect(drill.locator('.learn-compare-verdict')).toContainText('Snapshot-only comparison');
    await expect(drill.locator('.learn-compare-verdict')).toContainText(
      'current input check is unavailable',
    );
    await expect(drill.locator('.learn-compare-notes')).toContainText('snapshot remains readable');

    await drill.getByRole('button', { name: 'Different window' }).click();
    await expect(drill).toContainText('3 of 6 differences');
    await expect(drill.locator('.learn-compare-verdict')).toContainText('Not directly comparable');
    await expect(drill.locator('.learn-compare-example')).toContainText('Descriptive only');

    await drill.getByRole('button', { name: 'Reset differences' }).click();
    await expect(drill).toContainText('0 of 6 differences');
    await expect(drill.locator('.learn-compare-verdict')).toContainText('No differences selected');
    await expect(drill.getByRole('button', { name: 'Different window' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(drill.getByRole('button', { name: 'Reset differences' })).toBeDisabled();
  });

  test('keeps the saved-run comparison drill inside a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto('/learn?section=comparison');
    const drill = page.locator('.learn-compare-drill');

    await drill.getByRole('button', { name: 'Different engine version' }).click();
    await expect(drill.locator('.learn-compare-verdict')).toContainText('Not directly comparable');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);

    const box = await drill.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390.5);
  });

  test('checks a rule and moves to the next case', async ({ page }) => {
    await page.goto('/learn?section=rule-check');
    const check = page.locator('.learn-check');

    await expect(check).toContainText('Case 1 of 4');
    await check.getByRole('button', { name: 'About 44%', exact: true }).click();
    await expect(check.locator('.learn-check-feedback')).toContainText('Correct');
    await expect(check.locator('.learn-check-feedback')).toContainText('1.20 squared');

    await check.getByRole('button', { name: 'Next case', exact: true }).click();
    await expect(check).toContainText('Case 2 of 4');
    await expect(check).toContainText('Two series share only one session');
    // The advance is deliberate, so focus follows the exercise instead of
    // falling back to the document body.
    await expect(check.locator('.learn-check-prompt')).toBeFocused();
  });

  test('locks the rule-check options after the first answer', async ({ page }) => {
    await page.goto('/learn?section=rule-check');
    const check = page.locator('.learn-check');

    await check.getByRole('button', { name: '20.00%', exact: true }).click();
    await expect(check.locator('.learn-check-feedback strong')).toHaveText('Not quite');

    const correctOption = check.getByRole('button', { name: 'About 44%', exact: true });
    await expect(correctOption).toBeDisabled();
    await expect(correctOption).not.toHaveAttribute('aria-pressed', 'true');
    await expect(check.locator('.learn-check-feedback strong')).toHaveText('Not quite');
    // The correct option is marked for learning, but it is not recorded as the
    // answer and the styling still shows which one was wrong.
    await expect(correctOption).toHaveAttribute('data-result', 'correct');
    await expect(check.getByRole('button', { name: '20.00%', exact: true })).toHaveAttribute(
      'data-result',
      'wrong',
    );
  });

  test('restarts the rule check with focus on the first prompt', async ({ page }) => {
    await page.goto('/learn?section=rule-check');
    const check = page.locator('.learn-check');
    const answers = [
      'About 44%',
      'Draws nothing and reports the shared count',
      'The stop',
      'VaR 95',
    ];

    for (const [index, answer] of answers.entries()) {
      await check.getByRole('button', { name: answer, exact: true }).click();
      await expect(check.locator('.learn-check-feedback strong')).toHaveText('Correct');
      await check
        .getByRole('button', {
          name: index === answers.length - 1 ? 'Start over' : 'Next case',
          exact: true,
        })
        .click();
    }

    await expect(check).toContainText('Case 1 of 4');
    await expect(check.locator('.learn-check-prompt')).toBeFocused();
    await expect(check.getByRole('button', { name: 'About 44%', exact: true })).toBeEnabled();
  });

  test('walks through the backtest execution order', async ({ page }) => {
    await page.goto('/learn?section=execution');
    const execution = page.locator('.learn-execution');

    await execution.getByRole('button', { name: 'Stop and target', exact: true }).click();

    await expect(execution.getByRole('button', { name: 'Stop and target', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(execution.getByRole('heading', { name: 'The stop wins a tie' })).toBeVisible();
    await expect(execution).toContainText('The conservative choice is the stated one.');
  });

  test('links from the Quant lab to the risk method', async ({ page }) => {
    await seedLibrary(page);
    await page.goto('/quant');

    await page.getByRole('link', { name: 'Read the full method, including when a metric is withheld' }).click();

    await expect(page.locator('.topbar-title')).toHaveText('How MarketLab works');
    await expect(page.getByRole('heading', { level: 2, name: 'Risk' })).toBeFocused();
  });
});
