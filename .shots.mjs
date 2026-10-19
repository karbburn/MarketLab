import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: 'chrome' });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const page = await context.newPage();

await page.goto('http://localhost:4173/#/backtest', { waitUntil: 'load' });
await page.getByRole('button', { name: 'Start a new strategy' }).click();
await page.getByRole('img', { name: 'Equity curve versus buy and hold' }).waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);

await page.screenshot({ path: 'docs/screenshots/backtest.png' });
await page.screenshot({ path: 'docs/screenshots/backtest-full.png', fullPage: true });

// A second look with the trade log scrolled into view.
await page.mouse.wheel(0, 900);
await page.waitForTimeout(800);
await page.screenshot({ path: 'docs/screenshots/backtest-trades.png' });

await browser.close();
