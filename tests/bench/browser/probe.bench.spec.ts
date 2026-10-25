import { expect, test } from '@playwright/test';
import { installBenchHelpers, openChart, enableDiagnostics, readDiagnostics, waitForCharts, timedAction } from './harness';
import { seedBenchLibrary } from './fixtures';

/**
 * Probe, not a measurement: proves the harness's synthetic interactions really
 * reach React and lightweight-charts before any number is trusted. If this fails,
 * every scenario result in the same run is meaningless.
 */
test('harness interactions reach the application', async ({ page }) => {
  await enableDiagnostics(page);
  await installBenchHelpers(page);
  await seedBenchLibrary(page, {
    series: [{ id: 'ds_probe', symbol: 'BNCH', sessions: 320, seed: 7, startPrice: 100 }],
    panels: [{ datasetId: 'ds_probe' }],
  });
  await openChart(page);
  await waitForCharts(page, 1);

  const panel = page.locator('.workspace-grid > .chart-panel').first();
  const legendDate = () => panel.locator('.chart-legend .legend-values .faint').last().innerText();

  // 1. The diagnostics hook is installed and counting.
  const before = await readDiagnostics(page);
  expect(before.chart.renders).toBeGreaterThan(0);

  // 2. A hover moves the crosshair and repaints the legend.
  const idle = (await legendDate()).trim();
  await timedAction(page, 'hover', { panel: 0, ratio: 0.42 });
  await expect.poll(legendDate, { timeout: 2_000 }).not.toBe(idle);

  // 3. A different ratio lands on a different session.
  await timedAction(page, 'hover', { panel: 0, ratio: 0.7 });
  const trusted = (await legendDate()).trim();
  expect(trusted).not.toBe(idle);

  // 4. Parking the pointer clears the readout back to the latest session.
  await timedAction(page, 'park');
  await expect.poll(legendDate, { timeout: 2_000 }).toBe(idle);

  // 5. A dispatched select change reaches React's onChange.
  await timedAction(page, 'priceScale', { panel: 0, value: 'logarithmic' });
  await expect(panel.getByLabel('Price scale')).toHaveValue('logarithmic');

  // 6. A segmented button click reaches React.
  await timedAction(page, 'timeframe', { panel: 0, value: '1W' });
  await expect(panel.getByRole('group', { name: 'Timeframe' }).getByRole('button', { name: '1W' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // 7. The chart render was recorded with series churn.
  const after = await readDiagnostics(page);
  expect(after.chart.renders).toBeGreaterThan(before.chart.renders);
  expect(after.chart.seriesAdded).toBeGreaterThan(0);
  expect(after.phases.timeframe?.count ?? 0).toBeGreaterThan(0);
});
