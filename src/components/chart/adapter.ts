import {
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type BusinessDay,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar, ChartType, PriceScaleMode } from '../../domain/types';
import type { CorporateActionMarkerSpec } from '../../lib/corporate-actions';
import type { ComparisonLineSpec, ComparisonLineStyle } from '../../lib/chart/compare-overlays';

export interface IndicatorOutputSpec {
  key: string;
  label: string;
  kind: 'line' | 'histogram' | 'band';
  color: string;
  values: Array<number | null>;
}

export interface IndicatorRenderSpec {
  instanceId: string;
  type: string;
  name: string;
  placement: 'overlay' | 'pane';
  outputs: IndicatorOutputSpec[];
}

export interface ChartRenderInput {
  bars: readonly Bar[];
  chartType: ChartType;
  showVolume: boolean;
  priceScaleMode: PriceScaleMode;
  indicators: readonly IndicatorRenderSpec[];
  /** Rebased comparison overlays, on their own secondary index scale. */
  comparisons: readonly ComparisonLineSpec[];
  /** Provider-reported split/dividend markers for the primary series. */
  corporateActions: readonly CorporateActionMarkerSpec[];
}

export interface CrosshairReading {
  date: string | null;
  price: number | null;
  index: number | null;
}

export interface PaneRect {
  width: number;
  height: number;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function timeToDateString(time: Time | undefined): string | null {
  if (time === undefined || time === null) return null;
  if (typeof time === 'string') return time;
  if (typeof time === 'number') {
    return new Date((time as UTCTimestamp) * 1000).toISOString().slice(0, 10);
  }
  const businessDay = time as BusinessDay;
  return `${String(businessDay.year).padStart(4, '0')}-${String(businessDay.month).padStart(2, '0')}-${String(businessDay.day).padStart(2, '0')}`;
}

/**
 * Thin wrapper around a lightweight-charts instance.
 *
 * The controller owns series lifecycle and coordinate conversion. It never holds
 * application state: React remains the source of truth and calls `render` when the
 * visible configuration changes.
 */
export class ChartController {
  private readonly container: HTMLElement;
  private readonly chart: IChartApi;
  private priceSeries: ISeriesApi<SeriesType> | null = null;
  private volumeSeries: ISeriesApi<'Histogram'> | null = null;
  private readonly compareSeries: ISeriesApi<'Line'>[] = [];
  private corporateActionMarkers: ISeriesMarkersPluginApi<Time> | null = null;
  private readonly indicatorSeries = new Map<string, ISeriesApi<SeriesType>[]>();
  private bars: readonly Bar[] = [];
  private readonly crosshairHandlers = new Set<(reading: CrosshairReading) => void>();
  private readonly viewportHandlers = new Set<() => void>();
  private readonly resizeObserver: ResizeObserver | null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: cssVar('--text-secondary', '#9aa7b6'),
        fontFamily: cssVar('--font-sans', 'system-ui'),
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: cssVar('--border-subtle', '#1f2733'), style: LineStyle.Dotted },
        horzLines: { color: cssVar('--border-subtle', '#1f2733'), style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: cssVar('--border-subtle', '#1f2733') },
      timeScale: {
        borderColor: cssVar('--border-subtle', '#1f2733'),
        rightOffset: 4,
        barSpacing: 6,
        fixLeftEdge: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: cssVar('--text-muted', '#6b7887'), width: 1, style: LineStyle.Dashed, labelBackgroundColor: cssVar('--surface-raised', '#171d28') },
        horzLine: { color: cssVar('--text-muted', '#6b7887'), width: 1, style: LineStyle.Dashed, labelBackgroundColor: cssVar('--surface-raised', '#171d28') },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      localization: { locale: 'en-US' },
    });

    this.chart.subscribeCrosshairMove((param) => this.handleCrosshair(param));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.emitViewport());

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.emitViewport());
      this.resizeObserver.observe(container);
    } else {
      this.resizeObserver = null;
    }
  }

  private handleCrosshair(param: MouseEventParams<Time>): void {
    const date = timeToDateString(param.time);
    let price: number | null = null;
    if (param.point && this.priceSeries && (param.paneIndex === 0 || param.paneIndex === undefined)) {
      const converted = this.priceSeries.coordinateToPrice(param.point.y);
      price = converted === null ? null : Number(converted);
    }
    const index = date ? this.bars.findIndex((bar) => bar.date === date) : -1;
    const reading: CrosshairReading = { date, price, index: index >= 0 ? index : null };
    for (const handler of this.crosshairHandlers) handler(reading);
  }

  private emitViewport(): void {
    for (const handler of this.viewportHandlers) handler();
  }

  private clearIndicators(): void {
    this.corporateActionMarkers?.detach();
    this.corporateActionMarkers = null;
    for (const seriesList of this.indicatorSeries.values()) {
      for (const series of seriesList) {
        try {
          this.chart.removeSeries(series);
        } catch {
          // Series may already be detached; ignoring keeps render idempotent.
        }
      }
    }
    this.indicatorSeries.clear();
    for (const series of this.compareSeries) {
      try {
        this.chart.removeSeries(series);
      } catch {
        // ignore
      }
    }
    this.compareSeries.length = 0;
    // The secondary index axis only exists while comparison overlays are drawn.
    this.chart.applyOptions({ leftPriceScale: { visible: false } });
    if (this.volumeSeries) {
      try {
        this.chart.removeSeries(this.volumeSeries);
      } catch {
        // ignore
      }
      this.volumeSeries = null;
    }
    if (this.priceSeries) {
      try {
        this.chart.removeSeries(this.priceSeries);
      } catch {
        // ignore
      }
      this.priceSeries = null;
    }
  }

  /** Rebuilds every series from the supplied render input. */
  render(input: ChartRenderInput): void {
    this.clearIndicators();
    this.bars = input.bars;
    const upColor = cssVar('--up', '#35c48d');
    const downColor = cssVar('--down', '#e2586a');
    const accent = cssVar('--accent', '#3fb8a3');
    const faint = cssVar('--text-muted', '#6b7887');

    if (input.bars.length === 0) {
      this.chart.applyOptions({});
      this.emitViewport();
      return;
    }

    const firstClose = (input.bars[0] as Bar).close;
    const priceOptions = {
      priceLineVisible: false,
      lastValueVisible: true,
    };

    if (input.chartType === 'candlestick') {
      const series = this.chart.addSeries(CandlestickSeries, {
        ...priceOptions,
        upColor,
        downColor,
        borderUpColor: upColor,
        borderDownColor: downColor,
        wickUpColor: upColor,
        wickDownColor: downColor,
      });
      series.setData(
        input.bars.map((bar) => ({ time: bar.date as Time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })),
      );
      this.priceSeries = series;
    } else if (input.chartType === 'bar') {
      const series = this.chart.addSeries(BarSeries, {
        ...priceOptions,
        upColor,
        downColor,
      });
      series.setData(
        input.bars.map((bar) => ({ time: bar.date as Time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })),
      );
      this.priceSeries = series;
    } else if (input.chartType === 'line') {
      const series = this.chart.addSeries(LineSeries, { ...priceOptions, color: accent, lineWidth: 2 });
      series.setData(input.bars.map((bar) => ({ time: bar.date as Time, value: bar.close })));
      this.priceSeries = series;
    } else if (input.chartType === 'area') {
      const series = this.chart.addSeries(AreaSeries, {
        ...priceOptions,
        lineColor: accent,
        topColor: colorWithAlpha(accent, 0.28),
        bottomColor: colorWithAlpha(accent, 0.02),
        lineWidth: 2,
      });
      series.setData(input.bars.map((bar) => ({ time: bar.date as Time, value: bar.close })));
      this.priceSeries = series;
    } else {
      const series = this.chart.addSeries(BaselineSeries, {
        ...priceOptions,
        baseValue: { type: 'price', price: firstClose },
        topLineColor: upColor,
        topFillColor1: colorWithAlpha(upColor, 0.28),
        topFillColor2: colorWithAlpha(upColor, 0.02),
        bottomLineColor: downColor,
        bottomFillColor1: colorWithAlpha(downColor, 0.02),
        bottomFillColor2: colorWithAlpha(downColor, 0.28),
        lineWidth: 2,
      });
      series.setData(input.bars.map((bar) => ({ time: bar.date as Time, value: bar.close })));
      this.priceSeries = series;
    }

    this.applyPriceScaleMode(input.priceScaleMode);
    this.renderCorporateActions(input.corporateActions);

    let nextPaneIndex = 1;
    if (input.showVolume) {
      const volumeSeries = this.chart.addSeries(
        HistogramSeries,
        { priceFormat: { type: 'volume' }, priceScaleId: 'right', priceLineVisible: false, lastValueVisible: false },
        nextPaneIndex,
      );
      const hasVolume = input.bars.some((bar) => bar.volume !== null);
      volumeSeries.setData(
        hasVolume
          ? input.bars
              .filter((bar) => bar.volume !== null)
              .map((bar) => ({ time: bar.date as Time, value: bar.volume as number, color: colorWithAlpha(faint, 0.55) }))
          : [],
      );
      this.volumeSeries = volumeSeries;
      nextPaneIndex += 1;
    }

    for (const spec of input.indicators) {
      const paneIndex = spec.placement === 'overlay' ? 0 : nextPaneIndex;
      const seriesList: ISeriesApi<SeriesType>[] = [];
      for (const output of spec.outputs) {
        const data = input.bars
          .map((bar, index) => ({ time: bar.date as Time, value: output.values[index] ?? null }))
          .filter((point): point is { time: Time; value: number } => point.value !== null);
        if (output.kind === 'histogram') {
          const histogram = this.chart.addSeries(
            HistogramSeries,
            { color: output.color, priceLineVisible: false, lastValueVisible: false, base: 0 },
            paneIndex,
          );
          histogram.setData(data.map((point) => ({ time: point.time, value: point.value, color: output.color })));
          seriesList.push(histogram);
        } else {
          const line = this.chart.addSeries(
            LineSeries,
            {
              color: output.color,
              lineWidth: 2,
              priceLineVisible: false,
              lastValueVisible: false,
              lineStyle: output.kind === 'band' ? LineStyle.Dashed : LineStyle.Solid,
            },
            paneIndex,
          );
          line.setData(data);
          seriesList.push(line);
        }
      }
      this.indicatorSeries.set(spec.instanceId, seriesList);
      if (spec.placement === 'pane') {
        this.chart.priceScale('right', paneIndex).applyOptions({ autoScale: true, scaleMargins: { top: 0.12, bottom: 0.12 } });
        nextPaneIndex += 1;
      }
    }

    // Comparison overlays go last so they sit above the price series and
    // indicator overlays without altering any of them.
    this.renderComparisons(input.comparisons);

    this.emitViewport();
  }

  /**
   * Adds rebased comparison overlays on the secondary (left) index scale.
   *
   * The lines never touch the primary price scale, so mixing a $40 stock and a
   * $400 fund on one chart cannot make the price axis lie about either. The
   * left scale is shown only while at least one overlay is drawn.
   */
  private renderComparisons(specs: readonly ComparisonLineSpec[]): void {
    if (specs.length === 0) return;
    this.chart.applyOptions({
      leftPriceScale: {
        visible: true,
        borderColor: cssVar('--border-subtle', '#1f2733'),
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
    });
    this.chart.priceScale('left').applyOptions({ autoScale: true, mode: 0 });
    for (const spec of specs) {
      const line = this.chart.addSeries(LineSeries, {
        color: spec.color,
        lineWidth: 2,
        lineStyle: lineStyleFor(spec.lineStyle),
        priceLineVisible: false,
        lastValueVisible: true,
        priceScaleId: 'left',
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      });
      line.setData(spec.points.map((point) => ({ time: point.date as Time, value: point.value })));
      this.compareSeries.push(line);
    }
  }

  /**
   * Places provider-reported actions on the primary price series.
   *
   * Splits sit above the bar as squares; cash dividends sit below it as
   * circles. Markers are attached to the price series but do not alter its
   * axis. The dates were already restricted to displayed sessions by
   * `planCorporateActionMarkers`, so nothing is snapped to a neighbouring bar.
   */
  private renderCorporateActions(specs: readonly CorporateActionMarkerSpec[]): void {
    if (!this.priceSeries || specs.length === 0) return;
    const splitColor = cssVar('--corporate-split', '#d8a13f');
    const dividendColor = cssVar('--corporate-dividend', '#5b9bd5');
    const markers: SeriesMarker<Time>[] = specs.map((spec, index) => ({
      id: `${spec.date}-${spec.type}-${index}`,
      time: spec.date as Time,
      position: spec.type === 'split' ? 'aboveBar' : 'belowBar',
      shape: spec.type === 'split' ? 'square' : 'circle',
      color: spec.type === 'split' ? splitColor : dividendColor,
      text: spec.label,
      size: 1,
    }));
    this.corporateActionMarkers = createSeriesMarkers(this.priceSeries, markers, {
      // Markers are annotation only: never let their text grow the price range.
      autoScale: false,
      zOrder: 'aboveSeries',
    });
  }

  applyPriceScaleMode(mode: PriceScaleMode): void {
    if (!this.priceSeries) return;
    const scale = this.priceSeries.priceScale();
    if (mode === 'logarithmic') scale.applyOptions({ mode: 1 });
    else if (mode === 'percentage') scale.applyOptions({ mode: 2 });
    else scale.applyOptions({ mode: 0 });
  }

  /** Re-reads the design tokens so the chrome follows a theme change. */
  applyTheme(): void {
    const textColor = cssVar('--text-secondary', '#9aa7b6');
    const borderColor = cssVar('--border-subtle', '#1f2733');
    const muted = cssVar('--text-muted', '#6b7887');
    const raised = cssVar('--surface-raised', '#171d28');
    this.chart.applyOptions({
      layout: {
        textColor,
        fontFamily: cssVar('--font-sans', 'system-ui'),
      },
      grid: {
        vertLines: { color: borderColor },
        horzLines: { color: borderColor },
      },
      rightPriceScale: { borderColor },
      timeScale: { borderColor },
      crosshair: {
        vertLine: { color: muted, labelBackgroundColor: raised },
        horzLine: { color: muted, labelBackgroundColor: raised },
      },
    });
  }

  /** Enables or suspends the chart's own drag-to-pan gesture. */
  setDragToPan(enabled: boolean): void {
    this.chart.applyOptions({ handleScroll: { pressedMouseMove: enabled } });
  }

  subscribeCrosshair(handler: (reading: CrosshairReading) => void): () => void {
    this.crosshairHandlers.add(handler);
    return () => this.crosshairHandlers.delete(handler);
  }

  subscribeViewport(handler: () => void): () => void {
    this.viewportHandlers.add(handler);
    return () => this.viewportHandlers.delete(handler);
  }

  paneRect(): PaneRect {
    const size = this.chart.paneSize(0);
    const width = size.width || this.container.clientWidth;
    const height = size.height || this.container.clientHeight;
    return { width, height };
  }

  /**
   * Stage-relative x of the plot area's left edge. The overlay canvas starts at
   * this offset when a left price axis (comparison index scale) is visible.
   */
  paneLeft(): number {
    const rightAxisWidth = this.chart.priceScale('right').width();
    return Math.max(0, this.container.clientWidth - this.paneRect().width - rightAxisWidth);
  }

  timeToX(date: string): number | null {
    const coordinate = this.chart.timeScale().timeToCoordinate(date as Time);
    if (coordinate === null) return null;
    return Number(coordinate);
  }

  priceToY(price: number): number | null {
    if (!this.priceSeries) return null;
    const coordinate = this.priceSeries.priceToCoordinate(price);
    return coordinate === null ? null : Number(coordinate);
  }

  xToDate(x: number): string | null {
    const time = this.chart.timeScale().coordinateToTime(x);
    return timeToDateString(time ?? undefined);
  }

  yToPrice(y: number): number | null {
    if (!this.priceSeries) return null;
    const converted = this.priceSeries.coordinateToPrice(y);
    return converted === null ? null : Number(converted);
  }

  /** Snaps an arbitrary date to the nearest available session date. */
  nearestDate(date: string): string | null {
    if (this.bars.length === 0) return null;
    const exact = this.bars.find((bar) => bar.date === date);
    if (exact) return exact.date;
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const bar of this.bars) {
      const distance = Math.abs(new Date(bar.date).getTime() - new Date(date).getTime());
      if (distance < bestDistance) {
        bestDistance = distance;
        best = bar.date;
      }
    }
    return best;
  }

  getVisibleRange(): { from: number; to: number } | null {
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (!range) return null;
    return { from: range.from as number, to: range.to as number };
  }

  setVisibleRange(range: { from: number; to: number }): void {
    this.chart.timeScale().setVisibleLogicalRange(range as LogicalRange);
  }

  fitContent(): void {
    this.chart.timeScale().fitContent();
  }

  scrollToRealtime(): void {
    this.chart.timeScale().scrollToRealTime();
  }

  barCount(): number {
    return this.bars.length;
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.crosshairHandlers.clear();
    this.viewportHandlers.clear();
    this.chart.remove();
  }
}

function lineStyleFor(style: ComparisonLineStyle): LineStyle {
  switch (style) {
    case 'dashed':
      return LineStyle.Dashed;
    case 'dotted':
      return LineStyle.Dotted;
    case 'large-dashed':
      return LineStyle.LargeDashed;
    case 'solid':
      return LineStyle.Solid;
  }
}

function colorWithAlpha(hex: string, alpha: number): string {
  const normalised = hex.trim();
  if (!normalised.startsWith('#') || (normalised.length !== 7 && normalised.length !== 4)) return normalised;
  const expanded = normalised.length === 4 ? `#${normalised[1]}${normalised[1]}${normalised[2]}${normalised[2]}${normalised[3]}${normalised[3]}` : normalised;
  const r = Number.parseInt(expanded.slice(1, 3), 16);
  const g = Number.parseInt(expanded.slice(3, 5), 16);
  const b = Number.parseInt(expanded.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
