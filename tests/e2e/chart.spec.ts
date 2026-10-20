import { expect, test, type Page } from '@playwright/test';
import { buildFixtureBars, readStore, seedLibrary } from './fixtures/library';
import { formatCompact, formatPercent, formatPrice } from '../../src/lib/format';

/**
 * Reads the drawings stored on the first chart of the first workspace. The
 * assertions below check the stored records, not only what the toolbar shows.
 */
async function readDrawings(page: Page): Promise<
  Array<{
    type: string;
    anchors: unknown[];
    text?: string;
    visible: boolean;
    locked: boolean;
    style: { color: string; lineWidth: number; lineStyle?: string; fillOpacity?: number; fontSize?: number };
  }>
> {
  const workspaces = await readStore(page, 'workspaces');
  const charts = (
    workspaces[0] as {
      charts?: Array<{
        drawings?: Array<{
          type: string;
          anchors: unknown[];
          text?: string;
          visible: boolean;
          locked: boolean;
          style: { color: string; lineWidth: number; lineStyle?: string; fillOpacity?: number; fontSize?: number };
        }>;
      }>;
    }
  )?.charts;
  return charts?.[0]?.drawings ?? [];
}

/**
 * Whether the drawing overlay has any ink in a stage-relative box. The overlay
 * carries the drawings and nothing else, so a box with no ink is a box with no
 * drawing in it.
 */
async function hasInk(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<boolean> {
  return page.evaluate(({ x, y, width, height }) => {
    const canvas = document.querySelector('canvas.chart-overlay') as HTMLCanvasElement | null;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return false;
    const data = context.getImageData(x, y, width, height).data;
    for (let index = 3; index < data.length; index += 4) {
      if ((data[index] ?? 0) > 0) return true;
    }
    return false;
  }, box);
}

/**
 * Waits until the chart is actually rendered. The overlay canvas is only sized
 * once the chart controller holds the series data, so drawing and selection
 * gestures are meaningful from that point on.
 */
async function waitForChart(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.locator('canvas.chart-overlay').first().getAttribute('width')), {
      message: 'the chart overlay should be sized once the series is rendered',
    })
    .toBeGreaterThan(100);
}

/**
 * Finds the topmost candle pixel in a viewport column. The fixture chart uses
 * the theme's up/down colours, so a saturated green or red pixel is a candle,
 * not grid, text or the transparent drawing overlay.
 */
async function topmostCandleY(page: Page, viewportX: number): Promise<number | null> {
  return page.evaluate((targetX) => {
    const host = document.querySelector('.chart-canvas-host');
    if (!host) return null;
    let best: number | null = null;
    for (const canvas of Array.from(host.querySelectorAll('canvas'))) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const context = canvas.getContext('2d');
      if (!context) continue;
      const devicePixelRatio = canvas.width / rect.width;
      const pixelX = Math.round((targetX - rect.left) * devicePixelRatio);
      if (pixelX < 0 || pixelX >= canvas.width) continue;
      const data = context.getImageData(pixelX, 0, 1, canvas.height).data;
      for (let y = 0; y < canvas.height; y += 1) {
        const index = y * 4;
        const red = data[index] ?? 0;
        const green = data[index + 1] ?? 0;
        const blue = data[index + 2] ?? 0;
        const alpha = data[index + 3] ?? 0;
        const isUp = alpha > 80 && green > 120 && red < 120;
        const isDown = alpha > 80 && red > 150 && green < 120 && blue < 150;
        if (isUp || isDown) {
          const viewportY = rect.top + y / devicePixelRatio;
          if (best === null || viewportY < best) best = viewportY;
          break;
        }
      }
    }
    return best;
  }, viewportX);
}

/** Waits until every visible panel has a rendered, sized drawing overlay. */
async function waitForPanels(page: Page, count: number): Promise<void> {
  await expect
    .poll(
      async () =>
        page.locator('canvas.chart-overlay').evaluateAll(
          (nodes) => nodes.filter((node) => Number(node.getAttribute('width')) > 100).length,
        ),
      { message: `all ${count} panels should be rendered` },
    )
    .toBe(count);
}

test.describe('chart workspace', () => {
  // The application stores no bundled data, so every chart test starts from a
  // seeded library that looks like a real import.
  test.beforeEach(async ({ page }) => {
    await seedLibrary(page);
  });

  test('renders an interactive chart with a legend and honest timeframe labels', async ({ page }) => {
    await page.goto('/#/chart');

    await expect(page.locator('.topbar-title')).toHaveText('Chart workspace');
    await expect(page.locator('.chart-symbol').first()).toHaveText('AAPL');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);
    await waitForChart(page);

    // A daily dataset can be viewed as daily, weekly and monthly.
    const timeframe = page.getByRole('group', { name: 'Timeframe' }).first();
    await expect(timeframe.getByRole('button')).toHaveCount(3);
    await expect(timeframe.getByRole('button', { name: '1W' })).toBeEnabled();
    await expect(timeframe.getByRole('button', { name: '1M' })).toBeEnabled();

    const legend = page.locator('.chart-legend').first();
    await expect(legend).toContainText('Daily');

    // Weekly is an aggregation and says so rather than pretending to be native.
    await timeframe.getByRole('button', { name: '1W' }).click();
    await expect(legend).toContainText('Weekly (aggregated from daily)');

    await timeframe.getByRole('button', { name: '1D' }).click();
    await expect(legend).toContainText('Daily');
  });

  test('names the chart stage for the instrument it controls', async ({ page }) => {
    await page.goto('/#/chart');
    await waitForChart(page);

    const stage = page.getByRole('group', { name: 'Price chart, AAPL' }).first();
    await expect(stage).toBeVisible();
    await stage.focus();
    await expect(stage).toBeFocused();
  });

  test('expands the layout to four panels and hides panels without deleting them', async ({ page }) => {
    await page.goto('/#/chart');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);

    await page.getByRole('button', { name: 'Four panels' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(4);
    await waitForPanels(page, 4);

    // Link the symbol so every panel follows the focused one.
    await page.getByRole('checkbox', { name: 'Symbol' }).check();

    // Reducing the layout hides panels; the stored count is still reported.
    await page.getByRole('button', { name: 'Single panel' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);
    await expect(page.getByText(/4 panel\(s\) stored/)).toBeVisible();
  });

  test('adds, toggles and removes an indicator', async ({ page }) => {
    await page.goto('/#/chart');
    await waitForChart(page);

    await page.getByRole('button', { name: 'Add indicator' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Indicators' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: /Simple Moving Average/ }).click();
    await dialog.getByRole('button', { name: 'Add to chart' }).click();
    await expect(dialog).toBeHidden();

    const indicatorFoot = page.locator('.panel-foot').first();
    await expect(indicatorFoot.getByRole('button', { name: 'Remove', exact: true })).toHaveCount(1);
    await expect(page.locator('.indicator-legend-item')).toHaveCount(1);

    await indicatorFoot.getByRole('button', { name: 'Hide', exact: true }).click();
    await indicatorFoot.getByRole('button', { name: 'Show', exact: true }).click();

    await indicatorFoot.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(page.locator('.panel-foot')).toHaveCount(0);
    await expect(page.locator('.indicator-legend-item')).toHaveCount(0);
  });

  test('draws a level, undoes, redoes and deletes it', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });

    await waitForChart(page);
    await expect(deleteSelected).toBeDisabled();

    // A single-anchor tool completes on the first click.
    await page.getByRole('button', { name: 'Horizontal level' }).click();
    await stage.click({ position: { x: 300, y: 150 } });
    await expect(deleteSelected).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Pointer and selection' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Undo drawing' }).click();
    await expect(deleteSelected).toBeDisabled();

    await page.getByRole('button', { name: 'Redo drawing' }).click();
    await expect(deleteSelected).toBeEnabled();

    // The drawing is stored in the workspace, not only in component state.
    await page.getByRole('link', { name: 'Workspaces', exact: true }).click();
    const row = page.locator('table.data tbody tr').filter({ hasText: 'Primary' });
    await expect(row).toContainText('1');

    await page.reload();
    await expect(page.locator('table.data tbody tr').filter({ hasText: 'Primary' })).toBeVisible();

    // Selecting with the pointer tool and deleting works on a fresh load too.
    await page.getByRole('link', { name: 'Chart workspace', exact: true }).click();
    await waitForChart(page);
    await stage.click({ position: { x: 300, y: 150 } });
    await expect(deleteSelected).toBeEnabled();
    await deleteSelected.click();
    await expect(deleteSelected).toBeDisabled();
  });

  test('does not run drawing shortcuts for keys typed in the indicator dialog', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });

    await waitForChart(page);
    await page.getByRole('button', { name: 'Horizontal level' }).click();
    await stage.click({ position: { x: 300, y: 150 } });
    await expect(deleteSelected).toBeEnabled();

    await page.getByRole('button', { name: 'Add indicator' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Indicators' });
    await expect(dialog).toBeVisible();

    // Backspace edits the parameter field; it must not delete the drawing.
    const period = dialog.getByRole('spinbutton').first();
    await period.click();
    await period.press('Backspace');
    await expect(deleteSelected).toBeEnabled();

    // Escape closes the dialog; the half-drawn tool state is untouched.
    await period.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(deleteSelected).toBeEnabled();
  });

  test('grows the layout so a duplicated panel is reachable', async ({ page }) => {
    await page.goto('/#/chart');
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(1);

    await page.getByRole('button', { name: 'Duplicate panel' }).click();
    // The single layout grows to show the new panel instead of hiding it.
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(2);
    await expect(page.getByText(/2 panel\(s\) stored, 2 rendered/)).toBeVisible();

    await page.getByRole('button', { name: 'Duplicate panel' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(3);
    await page.getByRole('button', { name: 'Duplicate panel' }).click();
    await expect(page.locator('canvas.chart-overlay')).toHaveCount(4);
    await expect(page.getByRole('button', { name: 'Duplicate panel' })).toBeDisabled();
    await expect(page.getByText('Four panels is the maximum layout.')).toBeVisible();
  });

  test('loads a watchlist instrument into the focused panel', async ({ page }) => {
    await page.goto('/#/chart');

    await expect(page.locator('.chart-symbol').first()).toHaveText('AAPL');
    await page
      .locator('.page-split table.data tbody tr')
      .filter({ hasText: 'MSFT' })
      .getByRole('button', { name: 'MSFT', exact: true })
      .click();
    await expect(page.locator('.chart-symbol').first()).toHaveText('MSFT');
  });

  test('shows 30-session volume and range context in the watchlist', async ({ page }) => {
    await page.goto('/#/chart');

    const table = page.locator('table.watchlist-table');
    await expect(table.getByRole('columnheader', { name: 'Avg vol 30' })).toHaveAttribute(
      'title',
      'Average reported volume over the last 30 sessions',
    );
    await expect(table.getByRole('columnheader', { name: 'Range 30' })).toHaveAttribute(
      'title',
      'High-low spread as a percentage of the low over the last 30 sessions',
    );

    const recent = buildFixtureBars(1013, 100).slice(-30);
    const volumes = recent.map((entry) => entry.volume).filter((value): value is number => value !== null);
    const averageVolume = volumes.reduce((total, value) => total + value, 0) / volumes.length;
    const low = Math.min(...recent.map((entry) => entry.low));
    const high = Math.max(...recent.map((entry) => entry.high));

    const row = table.locator('tbody tr').filter({ hasText: 'AAPL' });
    const volume = row.locator('td').nth(3);
    const range = row.locator('td').nth(4);
    await expect(volume).toHaveText(formatCompact(averageVolume));
    await expect(volume).toHaveAttribute('title', new RegExp('^Average volume of .* over the last 30 sessions'));
    await expect(range).toHaveText(formatPercent(((high - low) / low) * 100, 1));
    await expect(range).toHaveAttribute(
      'title',
      `High-low range over the last 30 sessions: ${formatPrice(low)} to ${formatPrice(high)} (${formatPercent(
        ((high - low) / low) * 100,
        1,
      )} of the low).`,
    );
    await expect(page.getByText(/Avg vol and range use the last 30 sessions/)).toBeVisible();
  });

  test('switches to the OHLC Bars chart type and keeps it after a reload', async ({ page }) => {
    await page.goto('/#/chart');
    await waitForChart(page);

    const chartType = page.getByLabel('Chart type').first();
    await expect(chartType).toHaveValue('candlestick');

    await chartType.selectOption('bar');
    await expect(chartType).toHaveValue('bar');
    // The panel keeps rendering once the series is rebuilt as bars.
    await waitForChart(page);

    await page.reload();
    await expect(page.getByLabel('Chart type').first()).toHaveValue('bar');
  });

  test('creates each drawing tool with the anchors it needs', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });
    const pointer = page.getByRole('button', { name: 'Pointer and selection' });

    await waitForChart(page);
    await expect(deleteSelected).toBeDisabled();

    const shapes: Array<{ tool: string; type: string; points: Array<{ x: number; y: number }> }> = [
      { tool: 'Trend line', type: 'trendline', points: [{ x: 260, y: 160 }, { x: 460, y: 90 }] },
      { tool: 'Ray', type: 'ray', points: [{ x: 260, y: 90 }, { x: 440, y: 150 }] },
      { tool: 'Horizontal level', type: 'horizontal-line', points: [{ x: 320, y: 140 }] },
      { tool: 'Vertical session marker', type: 'vertical-line', points: [{ x: 360, y: 120 }] },
      { tool: 'Zone rectangle', type: 'rectangle', points: [{ x: 240, y: 100 }, { x: 430, y: 190 }] },
      { tool: 'Fibonacci retracement', type: 'fibonacci', points: [{ x: 240, y: 190 }, { x: 440, y: 100 }] },
      { tool: 'Measure move', type: 'price-range', points: [{ x: 250, y: 180 }, { x: 450, y: 110 }] },
      { tool: 'Text label', type: 'text', points: [{ x: 300, y: 130 }] },
    ];

    for (const shape of shapes) {
      await page.getByRole('button', { name: shape.tool, exact: true }).click();
      for (const point of shape.points) await stage.click({ position: point });
      if (shape.type === 'text') {
        const editor = page.getByRole('textbox', { name: 'Drawing label' });
        await editor.fill(`${shape.tool} label`);
        await editor.press('Enter');
        await expect(editor).toBeHidden();
      }

      await expect(deleteSelected, `${shape.tool} should store a drawing`).toBeEnabled();
      // The tool returns to the pointer once the shape is complete.
      await expect(pointer).toHaveAttribute('aria-pressed', 'true');

      const drawings = await readDrawings(page);
      expect(drawings).toHaveLength(1);
      expect(drawings[0]?.type).toBe(shape.type);
      expect(drawings[0]?.anchors).toHaveLength(shape.points.length);

      await deleteSelected.click();
      await expect(deleteSelected).toBeDisabled();
    }

    expect(await readDrawings(page)).toEqual([]);
  });

  test('writes a text label instead of a fixed string', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const editor = page.getByRole('textbox', { name: 'Drawing label' });
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });

    await waitForChart(page);

    // An abandoned label leaves nothing behind.
    await page.getByRole('button', { name: 'Text label' }).click();
    await stage.click({ position: { x: 320, y: 150 } });
    await expect(editor).toBeVisible();
    await editor.press('Escape');
    await expect(editor).toBeHidden();
    await expect(deleteSelected).toBeDisabled();
    expect(await readDrawings(page)).toEqual([]);

    // A typed label is stored once, with a single anchor.
    await page.getByRole('button', { name: 'Text label' }).click();
    await stage.click({ position: { x: 320, y: 150 } });
    await editor.fill('Breakout');
    await editor.press('Enter');
    await expect(editor).toBeHidden();

    const drawings = await readDrawings(page);
    expect(drawings).toHaveLength(1);
    expect(drawings[0]).toMatchObject({ type: 'text', text: 'Breakout' });
    expect(drawings[0]?.anchors).toHaveLength(1);

    // Deselect so only the label itself is painted, then look for its ink.
    await stage.click({ position: { x: 120, y: 220 } });
    await expect(deleteSelected).toBeDisabled();
    const label = { x: 332, y: 136, width: 90, height: 22 };
    await expect
      .poll(() => hasInk(page, label), { message: 'the label should be painted next to its anchor' })
      .toBe(true);
    // A text label draws no line of its own.
    expect(await hasInk(page, { x: 316, y: 8, width: 8, height: 110 })).toBe(false);

    // Double-clicking the label re-opens the editor for a correction.
    await stage.dblclick({ position: { x: 340, y: 144 } });
    await expect(editor).toBeVisible();
    await editor.fill('Breakdown');
    await editor.press('Enter');
    await expect(editor).toBeHidden();

    const edited = await readDrawings(page);
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ type: 'text', text: 'Breakdown' });
  });

  test('drags one anchor of a selected drawing and keeps the edit after reload', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });
    await waitForChart(page);

    await page.getByRole('button', { name: 'Trend line' }).click();
    await stage.click({ position: { x: 260, y: 160 } });
    await stage.click({ position: { x: 460, y: 90 } });
    await expect(deleteSelected).toBeEnabled();

    const before = (await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>;
    expect(before).toHaveLength(2);
    const fixedAnchor = before[1]!;
    const firstAnchor = before[0]!;

    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    // The first handle is where the first anchor was placed. Grab it, not the
    // middle of the line, and move it independently of the second endpoint.
    await page.mouse.move(box!.x + 260, box!.y + 160);
    await page.mouse.down();
    await page.mouse.move(box!.x + 320, box!.y + 130, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => ((await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>)[0]?.price)
      .not.toBe(firstAnchor.price);

    const moved = (await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>;
    expect(moved[1]).toEqual(fixedAnchor);
    expect(moved[0]?.date).not.toBe(firstAnchor.date);

    // Reshaping an endpoint is one ordinary undo step.
    await page.getByRole('button', { name: 'Undo drawing' }).click();
    await expect
      .poll(async () => ((await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>)[0])
      .toEqual(firstAnchor);

    await page.getByRole('button', { name: 'Redo drawing' }).click();
    await expect
      .poll(async () => ((await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>)[0])
      .toEqual(moved[0]);

    // The moved endpoint is stored, not just drawn locally.
    await page.reload();
    await waitForChart(page);
    const reloaded = (await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>;
    expect(reloaded[0]).toEqual(moved[0]);
    expect(reloaded[1]).toEqual(fixedAnchor);
  });

  test('does not reshape a locked drawing', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    await waitForChart(page);

    await page.getByRole('button', { name: 'Trend line' }).click();
    await stage.click({ position: { x: 260, y: 160 } });
    await stage.click({ position: { x: 460, y: 90 } });

    await page.getByRole('button', { name: 'Drawing objects' }).click();
    const manager = page.getByRole('region', { name: 'Drawing objects' });
    await manager.getByRole('button', { name: 'Lock Trend line' }).click();
    await manager.getByRole('button', { name: 'Close drawing objects' }).click();

    const before = (await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>;
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + 260, box!.y + 160);
    await page.mouse.down();
    await page.mouse.move(box!.x + 320, box!.y + 130, { steps: 8 });
    await page.mouse.up();

    const after = (await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>;
    expect(after).toEqual(before);
  });

  test('magnet mode snaps a new anchor to the nearest candle OHLC', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const magnet = page.getByRole('button', { name: 'Magnet snap' });
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });
    await waitForChart(page);

    await expect(magnet).toHaveAttribute('aria-pressed', 'false');

    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    let target: { x: number; y: number } | null = null;
    for (let x = 300; x <= 340 && target === null; x += 4) {
      const y = await topmostCandleY(page, box!.x + x);
      if (y !== null) target = { x, y };
    }
    expect(target, 'the fixture chart should have a rendered candle in the scan range').not.toBeNull();

    // The same pointer position with magnet off stores the raw chart price.
    await page.getByRole('button', { name: 'Horizontal level' }).click();
    await page.mouse.click(box!.x + target!.x, target!.y + 4);
    await expect(deleteSelected).toBeEnabled();
    const raw = ((await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>)[0]!;
    await deleteSelected.click();
    await expect(deleteSelected).toBeDisabled();

    await magnet.click();
    await expect(magnet).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Horizontal level' }).click();
    await page.mouse.click(box!.x + target!.x, target!.y + 4);
    await expect(deleteSelected).toBeEnabled();

    const snapped = ((await readDrawings(page))[0]?.anchors as Array<{ date: string; price: number }>)[0]!;
    const bar = buildFixtureBars(1013, 100).find((entry) => entry.date === snapped.date);
    expect(bar, 'the snapped date should belong to the fixture series').toBeDefined();
    expect([bar!.open, bar!.high, bar!.low, bar!.close]).toContain(snapped.price);
    expect(snapped.price).not.toBe(raw.price);
  });

  test('manages drawing visibility, locking and deletion from the object list', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });
    await waitForChart(page);

    await page.getByRole('button', { name: 'Zone rectangle' }).click();
    await stage.click({ position: { x: 240, y: 100 } });
    await stage.click({ position: { x: 430, y: 190 } });

    await page.getByRole('button', { name: 'Drawing objects' }).click();
    const manager = page.getByRole('region', { name: 'Drawing objects' });
    await expect(manager).toBeVisible();
    await expect(manager).toBeFocused();
    await expect(manager.getByText('1 object', { exact: true })).toBeVisible();

    const row = manager.getByRole('button', { name: 'Select Zone rectangle' });
    await expect(row).toHaveAttribute('aria-current', 'true');
    await expect(manager.getByRole('button', { name: 'Delete Zone rectangle' })).toBeEnabled();

    // Hiding removes the ink from the chart while keeping the object listed.
    await manager.getByRole('button', { name: 'Hide Zone rectangle' }).click();
    await expect(manager.getByRole('button', { name: 'Show Zone rectangle' })).toHaveAttribute('aria-pressed', 'false');
    await expect(manager.getByText('1 object · 1 hidden', { exact: true })).toBeVisible();
    await expect.poll(() => hasInk(page, { x: 238, y: 98, width: 196, height: 96 })).toBe(false);
    await expect.poll(async () => (await readDrawings(page))[0]?.visible).toBe(false);

    await manager.getByRole('button', { name: 'Show Zone rectangle' }).click();
    await expect.poll(() => hasInk(page, { x: 238, y: 98, width: 196, height: 96 })).toBe(true);
    await expect.poll(async () => (await readDrawings(page))[0]?.visible).toBe(true);

    // Locking is enforced by the manager and by the Delete shortcut.
    await manager.getByRole('button', { name: 'Lock Zone rectangle' }).click();
    await expect(manager.getByRole('button', { name: 'Unlock Zone rectangle' })).toHaveAttribute('aria-pressed', 'true');
    await expect(manager.getByRole('button', { name: 'Delete Zone rectangle' })).toBeDisabled();
    await expect(deleteSelected).toBeDisabled();
    await expect(manager.getByLabel('Line width')).toBeDisabled();
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await readDrawings(page)).length).toBe(1);

    await manager.getByRole('button', { name: 'Unlock Zone rectangle' }).click();
    await expect(manager.getByLabel('Line width')).toBeEnabled();
    await expect(deleteSelected).toBeEnabled();
    await manager.getByRole('button', { name: 'Delete Zone rectangle' }).click();
    await expect(manager.getByText('No objects', { exact: true })).toBeVisible();
    await expect.poll(async () => (await readDrawings(page)).length).toBe(0);

    // Escape closes the floating object list and returns focus to its toggle.
    await page.keyboard.press('Escape');
    await expect(manager).toBeHidden();
    await expect(page.getByRole('button', { name: 'Drawing objects' })).toBeFocused();
  });

  test('edits drawing style and text, undoes it, and keeps it after a reload', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    await waitForChart(page);

    await page.getByRole('button', { name: 'Zone rectangle' }).click();
    await stage.click({ position: { x: 240, y: 100 } });
    await stage.click({ position: { x: 430, y: 190 } });

    await page.getByRole('button', { name: 'Drawing objects' }).click();
    const manager = page.getByRole('region', { name: 'Drawing objects' });
    const rectangleRow = manager.getByRole('button', { name: 'Select Zone rectangle' });
    await expect(rectangleRow).toHaveAttribute('aria-current', 'true');

    // Double-clicking a row is the observed TradingView path into settings; here
    // it focuses the same inspector that single selection reveals.
    await rectangleRow.dblclick();
    await expect(manager.getByRole('button', { name: 'Color #3fb8a3' })).toBeFocused();

    await manager.getByRole('button', { name: 'Color #ef6f6c' }).click();
    await manager.getByLabel('Line width').selectOption('3');
    await manager.getByLabel('Line style').selectOption('dashed');
    await manager.getByLabel('Fill opacity').selectOption('0.25');

    await expect
      .poll(async () => (await readDrawings(page))[0])
      .toMatchObject({
        type: 'rectangle',
        visible: true,
        locked: false,
        style: { color: '#ef6f6c', lineWidth: 3, lineStyle: 'dashed', fillOpacity: 0.25 },
      });

    // The style inspector only offers properties the renderer uses. Text has
    // its own size and copy controls.
    await manager.getByRole('button', { name: 'Close drawing objects' }).click();
    await page.getByRole('button', { name: 'Text label' }).click();
    await stage.click({ position: { x: 300, y: 130 } });
    const editor = page.getByRole('textbox', { name: 'Drawing label' });
    await editor.fill('Breakout');
    await editor.press('Enter');
    await expect(editor).toBeHidden();

    await page.getByRole('button', { name: 'Drawing objects' }).click();
    const textManager = page.getByRole('region', { name: 'Drawing objects' });
    await expect(textManager.getByRole('button', { name: 'Select Breakout' })).toHaveAttribute('aria-current', 'true');
    await textManager.getByRole('button', { name: 'Color #4f8cff' }).click();
    await textManager.getByLabel('Font size').selectOption('20');

    const text = textManager.getByRole('textbox', { name: 'Text' });
    await text.fill('Breakdown');
    await text.press('Enter');
    await expect(textManager.getByRole('button', { name: 'Select Breakdown' })).toHaveAttribute('aria-current', 'true');

    await expect
      .poll(async () => (await readDrawings(page))[1])
      .toMatchObject({
        type: 'text',
        text: 'Breakdown',
        visible: true,
        locked: false,
        style: { color: '#4f8cff', fontSize: 20 },
      });

    // Text edits are ordinary history steps.
    await page.getByRole('button', { name: 'Undo drawing' }).click();
    await expect(textManager.getByRole('button', { name: 'Select Breakout' })).toHaveAttribute('aria-current', 'true');
    await expect(textManager.getByRole('textbox', { name: 'Text' })).toHaveValue('Breakout');
    await page.getByRole('button', { name: 'Redo drawing' }).click();
    await expect(textManager.getByRole('button', { name: 'Select Breakdown' })).toHaveAttribute('aria-current', 'true');

    // Everything survives a reload because the drawing record is persisted.
    await page.reload();
    await waitForChart(page);
    await page.getByRole('button', { name: 'Drawing objects' }).click();
    const reloaded = page.getByRole('region', { name: 'Drawing objects' });

    await reloaded.getByRole('button', { name: 'Select Zone rectangle' }).click();
    await expect(reloaded.getByRole('button', { name: 'Color #ef6f6c' })).toHaveAttribute('aria-pressed', 'true');
    await expect(reloaded.getByLabel('Line width')).toHaveValue('3');
    await expect(reloaded.getByLabel('Line style')).toHaveValue('dashed');
    await expect(reloaded.getByLabel('Fill opacity')).toHaveValue('0.25');

    await reloaded.getByRole('button', { name: 'Select Breakdown' }).click();
    await expect(reloaded.getByRole('button', { name: 'Color #4f8cff' })).toHaveAttribute('aria-pressed', 'true');
    await expect(reloaded.getByLabel('Font size')).toHaveValue('20');
    await expect(reloaded.getByRole('textbox', { name: 'Text' })).toHaveValue('Breakdown');
  });

  test('keeps the drawing object list inside a narrow viewport in both themes', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 800 });
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    await waitForChart(page);

    await page.getByRole('button', { name: 'Horizontal level' }).click();
    await stage.click({ position: { x: 220, y: 140 } });
    await page.getByRole('button', { name: 'Drawing objects' }).click();

    const manager = page.getByRole('region', { name: 'Drawing objects' });
    await expect(manager).toBeVisible();
    const box = await manager.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(721);

    await page.getByRole('button', { name: 'Switch to light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(manager).toBeVisible();
    await expect(manager.getByRole('button', { name: 'Select Horizontal level' })).toBeVisible();
  });

  test('keeps drawing shortcuts working after undo, redo and a disabled button', async ({ page }) => {
    await page.goto('/#/chart');
    const stage = page.locator('.chart-stage').first();
    const deleteSelected = page.getByRole('button', { name: 'Delete selected drawing' });

    await waitForChart(page);

    // Escape drops a half-drawn two-click shape.
    await page.getByRole('button', { name: 'Trend line' }).click();
    await stage.click({ position: { x: 300, y: 150 } });
    await page.keyboard.press('Escape');
    await expect(deleteSelected).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Pointer and selection' })).toHaveAttribute('aria-pressed', 'true');

    await page.getByRole('button', { name: 'Horizontal level' }).click();
    await stage.click({ position: { x: 300, y: 150 } });
    await expect(deleteSelected).toBeEnabled();

    // Undo and redo disable themselves once used, which hands focus back to the
    // document rather than keeping it in the panel: the shortcuts have to keep
    // working from there.
    await page.getByRole('button', { name: 'Undo drawing' }).click();
    await expect(deleteSelected).toBeDisabled();
    await page.getByRole('button', { name: 'Redo drawing' }).click();
    await expect(deleteSelected).toBeEnabled();
    const focusInsidePanel = () =>
      page.evaluate(() => document.activeElement?.closest('.chart-panel') !== null);
    expect(await focusInsidePanel()).toBe(false);

    // Redo restored the drawing and it is still the selection, so the keyboard
    // alone can remove it.
    await page.keyboard.press('Delete');
    await expect(deleteSelected).toBeDisabled();

    // Undo from the keyboard puts it back, again from outside the panel.
    await page.keyboard.press('ControlOrMeta+z');
    expect(await focusInsidePanel()).toBe(false);
    expect(await readDrawings(page)).toHaveLength(1);
  });
});
