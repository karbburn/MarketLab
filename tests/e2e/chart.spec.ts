import { expect, test, type Page } from '@playwright/test';
import { readStore, seedLibrary } from './fixtures/library';

/**
 * Reads the drawings stored on the first chart of the first workspace. The
 * assertions below check the stored records, not only what the toolbar shows.
 */
async function readDrawings(
  page: Page,
): Promise<Array<{ type: string; anchors: unknown[]; text?: string }>> {
  const workspaces = await readStore(page, 'workspaces');
  const charts = (workspaces[0] as { charts?: Array<{ drawings?: Array<{ type: string; anchors: unknown[]; text?: string }> }> })
    ?.charts;
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
    await stage.click({ position: { x: 480, y: 100 } });
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
