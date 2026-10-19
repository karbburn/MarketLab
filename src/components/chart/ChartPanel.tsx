import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsVertical,
  Cursor,
  FrameCorners,
  Minus,
  Plus,
  Ruler,
  Square,
  TextT,
  TrendUp,
  Trash,
  WaveSine,
} from '@phosphor-icons/react';
import type { Bar, ChartConfig, ChartType, Drawing, DrawingAnchor, DrawingType, PriceScaleMode, Timeframe } from '../../domain/types';
import { formatPrice, formatSignedPercent } from '../../lib/format';
import { barsForTimeframe, timeframeLabel, availableTimeframes } from '../../lib/timeframe';
import { calculateIndicator, getIndicatorDefinition } from '../../lib/indicators';
import { isDrawingComplete, priceRangeInfo } from '../../lib/drawings/geometry';
import { createId } from '../../lib/id';
import { useStore } from '../../state/store';
import type { DatasetView } from '../../state/selectors';
import { Segmented, Select, Tag } from '../ui';
import { ChartController, type CrosshairReading, type IndicatorRenderSpec } from './adapter';
import { IndicatorDialog } from './IndicatorDialog';

const TOOLS: Array<{ id: DrawingType | 'cursor'; label: string; icon: typeof Cursor }> = [
  { id: 'cursor', label: 'Pointer and selection', icon: Cursor },
  { id: 'trendline', label: 'Trend line', icon: TrendUp },
  { id: 'ray', label: 'Ray', icon: ArrowsVertical },
  { id: 'horizontal-line', label: 'Horizontal level', icon: Minus },
  { id: 'vertical-line', label: 'Vertical session marker', icon: FrameCorners },
  { id: 'rectangle', label: 'Zone rectangle', icon: Square },
  { id: 'fibonacci', label: 'Fibonacci retracement', icon: WaveSine },
  { id: 'price-range', label: 'Measure move', icon: Ruler },
  { id: 'text', label: 'Text label', icon: TextT },
];

export function ChartPanel({
  chart,
  workspaceId,
  view,
  focused,
  onFocus,
  onRangeChange,
  appliedRange,
}: {
  chart: ChartConfig;
  workspaceId: string;
  view: DatasetView | null;
  focused: boolean;
  onFocus: () => void;
  onRangeChange?: (range: { from: number; to: number } | null) => void;
  appliedRange?: { from: number; to: number } | null;
}) {
  const { state, actions } = useStore();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<ChartController | null>(null);
  const dragRef = useRef<{ id: string; startPrice: number; startDate: string; latest: Drawing[] } | null>(null);
  const historyRef = useRef<{ past: Drawing[][]; future: Drawing[][] }>({ past: [], future: [] });
  // History lives in a ref so pointer handlers stay synchronous; the lengths are
  // mirrored into state to drive the disabled state of the undo/redo controls.
  const [historySize, setHistorySize] = useState({ past: 0, future: 0 });

  const [tool, setTool] = useState<DrawingType | 'cursor'>('cursor');
  const [pendingAnchors, setPendingAnchors] = useState<DrawingAnchor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [readout, setReadout] = useState<CrosshairReading>({ date: null, price: null, index: null });
  const [indicatorDialogOpen, setIndicatorDialogOpen] = useState(false);
  // While a drawing is being dragged or just created the local copy leads; the
  // stored workspace state remains the source of truth at rest.
  const [dragDrawings, setDragDrawings] = useState<Drawing[] | null>(null);
  const localDrawings = dragDrawings ?? chart.drawings;
  // A selection only counts while the drawing it points at still exists, so undo
  // and redo can never leave the toolbar acting on a drawing that is not there.
  const selectedDrawingId =
    selectedId !== null && localDrawings.some((drawing) => drawing.id === selectedId) ? selectedId : null;

  const bars = useMemo(() => view?.bars ?? [], [view]);
  const dataset = view?.dataset ?? null;
  const instrument = view?.instrument ?? null;
  const rendered = useMemo(() => {
    if (!dataset) return bars;
    return barsForTimeframe(bars, dataset, chart.timeframe);
  }, [bars, dataset, chart.timeframe]);

  const indicatorSpecs = useMemo<IndicatorRenderSpec[]>(() => {
    const specs: IndicatorRenderSpec[] = [];
    for (const instance of chart.indicators) {
      if (!instance.visible) continue;
      const definition = getIndicatorDefinition(instance.type);
      if (!definition) continue;
      const calculation = calculateIndicator(instance.type, rendered, instance.parameters);
      if (!calculation) continue;
      specs.push({
        instanceId: instance.id,
        type: instance.type,
        name: definition.name,
        placement: instance.placement,
        outputs: definition.outputs.map((output, index) => ({
          key: output.key,
          label: output.label,
          kind: output.kind,
          color: index === 0 && instance.style.color ? instance.style.color : output.defaultColor ?? '#4f8cff',
          values: calculation.outputs[output.key] ?? [],
        })),
      });
    }
    return specs;
  }, [chart.indicators, rendered]);

  // Create the chart once, then re-render whenever the configuration changes.
  useEffect(() => {
    if (!containerRef.current) return;
    const controller = new ChartController(containerRef.current);
    controllerRef.current = controller;
    const unsubscribe = controller.subscribeCrosshair((reading) => setReadout(reading));
    return () => {
      unsubscribe();
      controllerRef.current = null;
      controller.destroy();
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    controller.render({ bars: rendered, chartType: chart.chartType, showVolume: chart.showVolume, priceScaleMode: chart.priceScaleMode, indicators: indicatorSpecs });
  }, [rendered, chart.chartType, chart.showVolume, chart.priceScaleMode, indicatorSpecs]);

  // The controller reads its colours from the CSS variables, so a theme switch
  // has to be pushed into it explicitly.
  useEffect(() => {
    controllerRef.current?.applyTheme();
  }, [state.preferences.theme]);

  // Token colour used by the drawing layer; recomputed with the theme so the
  // memoised draw callback redraws with the new palette.
  const labelColor = useMemo(
    () => cssVar('--text-primary', state.preferences.theme === 'light' ? '#141a21' : '#e7edf4'),
    [state.preferences.theme],
  );

  const draw = useCallback(() => {
    const controller = controllerRef.current;
    const canvas = canvasRef.current;
    if (!controller || !canvas) return;
    const rect = controller.paneRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const toPoint = (anchor: DrawingAnchor) => {
      const x = controller.timeToX(anchor.date);
      const y = controller.priceToY(anchor.price);
      return x === null || y === null ? null : { x, y };
    };

    for (const drawing of localDrawings) {
      if (!drawing.visible) continue;
      const points = drawing.anchors.map(toPoint);
      if (points.some((point) => point === null)) continue;
      const resolved = points as Array<{ x: number; y: number }>;
      const selected = drawing.id === selectedId;
      context.strokeStyle = selected ? labelColor : drawing.style.color;
      context.lineWidth = drawing.style.lineWidth;
      context.setLineDash(drawing.style.lineStyle === 'dashed' ? [5, 4] : []);
      context.beginPath();
      renderDrawingShape(context, drawing, resolved, rect);
      context.stroke();
      context.setLineDash([]);

      if (drawing.type === 'rectangle') {
        const first = resolved[0] as { x: number; y: number };
        const second = resolved[1] as { x: number; y: number };
        context.fillStyle = withAlpha(drawing.style.color, drawing.style.fillOpacity ?? 0.12);
        context.fillRect(Math.min(first.x, second.x), Math.min(first.y, second.y), Math.abs(second.x - first.x), Math.abs(second.y - first.y));
      }

      if (drawing.type === 'fibonacci') {
        const first = drawing.anchors[0] as DrawingAnchor;
        const second = drawing.anchors[1] as DrawingAnchor;
        const levels = drawing.levels ?? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
        const x0 = (resolved[0] as { x: number }).x;
        const x1 = (resolved[1] as { x: number }).x;
        context.font = '10px ui-monospace, monospace';
        for (const level of levels) {
          const price = first.price + (second.price - first.price) * level;
          const y = controller.priceToY(price);
          if (y === null) continue;
          context.strokeStyle = withAlpha(drawing.style.color, 0.65);
          context.setLineDash([3, 3]);
          context.beginPath();
          context.moveTo(Math.min(x0, x1), y);
          context.lineTo(Math.max(x0, x1), y);
          context.stroke();
          context.setLineDash([]);
          context.fillStyle = withAlpha(labelColor, 0.7);
          context.fillText(`${(level * 100).toFixed(1)}%  ${formatPrice(price)}`, Math.max(x0, x1) + 4, y - 2);
        }
      }

      if (drawing.type === 'price-range') {
        const info = priceRangeInfo(drawing);
        if (info) {
          const first = resolved[0] as { x: number; y: number };
          const second = resolved[1] as { x: number; y: number };
          context.fillStyle = withAlpha(drawing.style.color, 0.14);
          context.fillRect(Math.min(first.x, second.x), Math.min(first.y, second.y), Math.abs(second.x - first.x), Math.abs(second.y - first.y));
          context.fillStyle = labelColor;
          context.font = '11px ui-monospace, monospace';
          const label = `${formatSignedPercent(info.pct)}  ${formatPrice(info.delta)}`;
          context.fillText(label, Math.max(first.x, second.x) + 5, Math.min(first.y, second.y) - 6);
        }
      }

      if (drawing.text) {
        const anchor = resolved[0] as { x: number; y: number };
        context.fillStyle = drawing.style.color;
        context.font = `${drawing.style.fontSize ?? 12}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-sans')}`;
        context.fillText(drawing.text, anchor.x + 6, anchor.y - 4);
      }

      if (selected) {
        for (const point of resolved) {
          context.fillStyle = labelColor;
          context.beginPath();
          context.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
          context.fill();
        }
      }
    }

    // In-progress drawing preview follows the pointer using the pending anchor set.
    if (pendingAnchors.length === 1 && readout.date && readout.price !== null) {
      const first = toPoint(pendingAnchors[0] as DrawingAnchor);
      const second = toPoint({ date: readout.date, price: readout.price });
      if (first && second) {
        context.strokeStyle = labelColor;
        context.lineWidth = 1;
        context.setLineDash([4, 4]);
        context.beginPath();
        context.moveTo(first.x, first.y);
        context.lineTo(second.x, second.y);
        context.stroke();
        context.setLineDash([]);
      }
    }
  }, [labelColor, localDrawings, selectedId, pendingAnchors, readout]);

  useEffect(() => {
    draw();
    const controller = controllerRef.current;
    if (!controller) return;
    return controller.subscribeViewport(draw);
  }, [draw]);

  // Report the visible logical range so a link group can mirror it.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !onRangeChange) return;
    const emit = () => {
      const range = controller.getVisibleRange();
      onRangeChange(range ? { from: range.from, to: range.to } : null);
    };
    const unsubscribe = controller.subscribeViewport(emit);
    // Emit once on install so range linking works before the first pan.
    emit();
    return unsubscribe;
  }, [onRangeChange]);

  // Apply a range pushed in from a linked chart.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !appliedRange) return;
    const current = controller.getVisibleRange();
    if (current && Math.abs(current.from - appliedRange.from) < 0.001 && Math.abs(current.to - appliedRange.to) < 0.001) {
      return;
    }
    controller.setVisibleRange(appliedRange);
  }, [appliedRange]);

  const syncHistory = useCallback(() => {
    setHistorySize({ past: historyRef.current.past.length, future: historyRef.current.future.length });
  }, []);

  const commitDrawings = useCallback(
    (next: Drawing[], base: Drawing[] = localDrawings) => {
      // `base` is the state the change started from. A drag supplies its
      // pre-drag snapshot, so Undo restores where the drag began.
      historyRef.current.past.push(base);
      historyRef.current.future = [];
      syncHistory();
      setDragDrawings(null);
      void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, drawings: next }));
    },
    [actions, chart.id, localDrawings, syncHistory, workspaceId],
  );

  const undo = useCallback(() => {
    const previous = historyRef.current.past.pop();
    if (!previous) return;
    historyRef.current.future.push(localDrawings);
    syncHistory();
    setDragDrawings(null);
    void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, drawings: previous }));
  }, [actions, chart.id, localDrawings, syncHistory, workspaceId]);

  const redo = useCallback(() => {
    const next = historyRef.current.future.pop();
    if (!next) return;
    historyRef.current.past.push(localDrawings);
    syncHistory();
    setDragDrawings(null);
    void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, drawings: next }));
  }, [actions, chart.id, localDrawings, syncHistory, workspaceId]);

  const pointerToAnchor = (event: React.PointerEvent<HTMLDivElement>): DrawingAnchor | null => {
    const controller = controllerRef.current;
    if (!controller) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const rawDate = controller.xToDate(x);
    const date = rawDate ? controller.nearestDate(rawDate) : null;
    const price = controller.yToPrice(y);
    if (!date || price === null) return null;
    return { date, price };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    onFocus();
    // The shortcuts belong to this panel, so the pointer click takes focus.
    stageRef.current?.focus({ preventScroll: true });
    const anchor = pointerToAnchor(event);
    if (!anchor) return;

    if (tool === 'cursor') {
      const controller = controllerRef.current;
      if (!controller) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const hit = [...localDrawings].reverse().find((drawing) => {
        if (drawing.locked) return false;
        const screenAnchors = drawing.anchors
          .map((entry) => {
            const x = controller.timeToX(entry.date);
            const y = controller.priceToY(entry.price);
            return x === null || y === null ? null : { x, y };
          })
          .filter((entry): entry is { x: number; y: number } => entry !== null);
        return hitTest(screenAnchors, drawing.type, point);
      });
      setSelectedId(hit ? hit.id : null);
      if (hit) {
        dragRef.current = { id: hit.id, startPrice: anchor.price, startDate: anchor.date, latest: localDrawings };
        // Stop the chart from panning underneath the drawing drag.
        controller.setDragToPan(false);
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }

    const first = pendingAnchors[0];
    if (!first) {
      if (tool === 'horizontal-line' || tool === 'vertical-line') {
        createDrawing([anchor]);
      } else {
        setPendingAnchors([anchor]);
      }
      return;
    }
    createDrawing([first, anchor]);
    setPendingAnchors([]);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const anchor = pointerToAnchor(event);
    // The overlay covers the pane while a tool is active, so the chart
    // crosshair no longer fires. The readout and the preview follow the
    // pointer event instead. With the pointer tool the chart owns the
    // crosshair, so this path stays out of the way and cannot double-render.
    if (anchor && tool !== 'cursor') {
      setReadout((current) => {
        if (current.date === anchor.date && current.price === anchor.price) return current;
        const index = rendered.findIndex((bar) => bar.date === anchor.date);
        return { date: anchor.date, price: anchor.price, index: index >= 0 ? index : null };
      });
    }

    const drag = dragRef.current;
    if (!drag || event.buttons === 0) return;
    if (!anchor) return;
    const controller = controllerRef.current;
    if (!controller) return;
    const priceDelta = anchor.price - drag.startPrice;
    const indexDelta = indexDistance(controller, drag.startDate, anchor.date);
    if (indexDelta === null) return;
    const next = drag.latest.map((drawing) => {
      if (drawing.id !== drag.id) return drawing;
      return {
        ...drawing,
        anchors: drawing.anchors.map((entry) => ({
          date: shiftDate(controller, entry.date, indexDelta) ?? entry.date,
          price: entry.price + priceDelta,
        })),
      };
    });
    setDragDrawings(next);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    controllerRef.current?.setDragToPan(true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // The pre-drag snapshot is the undo base, not the already-moved set.
    if (dragDrawings) commitDrawings(dragDrawings, drag.latest);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    controllerRef.current?.setDragToPan(true);
    setDragDrawings(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const createDrawing = (anchors: DrawingAnchor[]) => {
    if (!isDrawingComplete({ type: tool as DrawingType, anchors })) {
      setPendingAnchors(anchors);
      return;
    }
    const type = tool as DrawingType;
    const created: Drawing = {
      id: createId('drw'),
      type,
      anchors,
      visible: true,
      locked: false,
      style: { color: '#3fb8a3', lineWidth: 1.5, lineStyle: 'solid', fillOpacity: 0.12, fontSize: 12 },
      text: type === 'text' ? 'Label' : undefined,
      levels: type === 'fibonacci' ? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] : undefined,
    };
    commitDrawings([...localDrawings, created]);
    setSelectedId(created.id);
    selectTool('cursor');
  };

  const removeSelected = useCallback(() => {
    if (!selectedDrawingId) return;
    commitDrawings(localDrawings.filter((drawing) => drawing.id !== selectedDrawingId));
    setSelectedId(null);
  }, [commitDrawings, localDrawings, selectedDrawingId]);

  const selectTool = (next: DrawingType | 'cursor') => {
    setPendingAnchors([]);
    setTool(next);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Keystrokes typed into the indicator dialog (or any form control) must
    // never reach the drawing shortcuts.
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, select, textarea, [contenteditable="true"], [role="dialog"]')) return;
    if (event.key === 'Escape') {
      selectTool('cursor');
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedDrawingId) {
      event.preventDefault();
      removeSelected();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    }
  };

  const hoverBar: Bar | null = readout.index !== null ? (rendered[readout.index] ?? null) : rendered.length ? (rendered[rendered.length - 1] as Bar) : null;
  const previousBar = readout.index !== null && readout.index > 0 ? rendered[readout.index - 1] ?? null : rendered.length > 1 ? rendered[rendered.length - 2] ?? null : null;
  const changePct = hoverBar && previousBar && previousBar.close !== 0 ? ((hoverBar.close - previousBar.close) / previousBar.close) * 100 : null;
  const tone = changePct === null ? undefined : changePct >= 0 ? 'up' : 'down';

  return (
    <div className={focused ? 'chart-panel focused' : 'chart-panel'} onFocus={onFocus} tabIndex={-1} onKeyDown={handleKeyDown}>
      <div className="chart-panel-head">
        <span className="chart-symbol">{instrument?.symbol ?? 'No instrument'}</span>
        <Segmented
          label="Timeframe"
          value={chart.timeframe}
          onChange={(value: Timeframe) =>
            void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, timeframe: value }))
          }
          options={(dataset ? availableTimeframes(dataset.frequency) : (['1D', '1W', '1M'] as Timeframe[])).map((timeframe) => ({
            value: timeframe,
            label: timeframe,
            title: dataset ? timeframeLabel(timeframe, dataset.frequency) : timeframe,
          }))}
        />
        <Select
          ariaLabel="Chart type"
          value={chart.chartType}
          onChange={(value: ChartType) => void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, chartType: value }))}
          options={[
            { value: 'candlestick', label: 'Candles' },
            { value: 'line', label: 'Line' },
            { value: 'area', label: 'Area' },
            { value: 'baseline', label: 'Baseline' },
          ]}
        />
        <Select
          ariaLabel="Price scale"
          value={chart.priceScaleMode}
          onChange={(value: PriceScaleMode) => void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, priceScaleMode: value }))}
          options={[
            { value: 'normal', label: 'Linear' },
            { value: 'logarithmic', label: 'Log' },
            { value: 'percentage', label: 'Percent' },
          ]}
        />
        <div style={{ flex: 1 }} />
        <button type="button" className="tool-button" title="Add indicator" aria-label="Add indicator" onClick={() => setIndicatorDialogOpen(true)}>
          <Plus size={14} weight="bold" />
        </button>
        <button type="button" className="tool-button" title="Undo drawing" aria-label="Undo drawing" disabled={historySize.past === 0} onClick={undo}>
          <ArrowCounterClockwise size={14} />
        </button>
        <button type="button" className="tool-button" title="Redo drawing" aria-label="Redo drawing" disabled={historySize.future === 0} onClick={redo}>
          <ArrowClockwise size={14} />
        </button>
        <button type="button" className="tool-button" title="Fit content" aria-label="Fit content" onClick={() => controllerRef.current?.fitContent()}>
          <FrameCorners size={14} />
        </button>
      </div>

      <div className="chart-layout" style={{ padding: 6 }}>
        <div className="drawing-rail" role="toolbar" aria-label="Drawing tools">
          {TOOLS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="tool-button"
              aria-pressed={tool === entry.id}
              aria-label={entry.label}
              title={entry.label}
              onClick={() => selectTool(entry.id)}
            >
              <entry.icon size={15} weight={tool === entry.id ? 'bold' : 'regular'} />
            </button>
          ))}
          <button type="button" className="tool-button" aria-label="Delete selected drawing" title="Delete selected drawing" disabled={!selectedDrawingId} onClick={removeSelected} style={{ opacity: selectedDrawingId ? 1 : 0.4 }}>
            <Trash size={15} />
          </button>
        </div>

        <div className="chart-panel" style={{ minHeight: 380 }}>
          <div
            className="chart-stage"
            ref={stageRef}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
          >
            <div className="chart-canvas-host" ref={containerRef} />
            <canvas
              ref={canvasRef}
              className={tool === 'cursor' ? 'chart-overlay' : 'chart-overlay active'}
            />
            <div className="chart-legend">
              <div className="legend-row">
                <strong className="chart-symbol">{instrument?.symbol ?? '--'}</strong>
                <span className="muted">{instrument?.displayName ?? 'No dataset selected'}</span>
                <span className="faint">|</span>
                <span>{dataset ? timeframeLabel(chart.timeframe, dataset.frequency) : '--'}</span>
                <span className="faint">|</span>
                <span>{instrument?.exchange ?? dataset?.timezone ?? '--'}</span>
                {instrument?.metadata?.synthetic === true && <Tag tone="warn">Demo data</Tag>}
              </div>
              {hoverBar && (
                <div className="legend-values mono">
                  <span>O {formatPrice(hoverBar.open)}</span>
                  <span>H {formatPrice(hoverBar.high)}</span>
                  <span>L {formatPrice(hoverBar.low)}</span>
                  <span>C {formatPrice(hoverBar.close)}</span>
                  {changePct !== null && <span className={tone}>{formatSignedPercent(changePct)}</span>}
                  <span className="faint">{hoverBar.date}</span>
                </div>
              )}
              {indicatorSpecs.map((spec) => {
                const index = readout.index ?? rendered.length - 1;
                const definition = getIndicatorDefinition(spec.type);
                return (
                  <div className="legend-row indicator-legend-item" key={spec.instanceId}>
                    <span className="legend-swatch" style={{ background: spec.outputs[0]?.color ?? '#4f8cff' }} />
                    <span className="muted">{definition?.name ?? spec.name}</span>
                    <span className="legend-values mono">
                      {spec.outputs.map((output) => {
                        const value = output.values[index];
                        return (
                          <span key={output.key}>
                            {output.label} {value === null || value === undefined ? '-' : formatPrice(value)}
                          </span>
                        );
                      })}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {chart.indicators.length > 0 && (
        <div className="panel-foot" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {chart.indicators.map((instance) => {
            const definition = getIndicatorDefinition(instance.type);
            return (
              <span key={instance.id} className="row tight">
                <Tag tone={instance.visible ? 'accent' : undefined}>{definition?.name ?? instance.type}</Tag>
                <button
                  type="button"
                  className="button ghost sm"
                  onClick={() =>
                    void actions.updateChart(workspaceId, chart.id, (config) => ({
                      ...config,
                      indicators: config.indicators.map((entry) => (entry.id === instance.id ? { ...entry, visible: !entry.visible } : entry)),
                    }))
                  }
                >
                  {instance.visible ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  className="button ghost sm"
                  onClick={() =>
                    void actions.updateChart(workspaceId, chart.id, (config) => ({
                      ...config,
                      indicators: config.indicators.filter((entry) => entry.id !== instance.id),
                    }))
                  }
                >
                  Remove
                </button>
              </span>
            );
          })}
        </div>
      )}

      <IndicatorDialog
        open={indicatorDialogOpen}
        onClose={() => setIndicatorDialogOpen(false)}
        chart={chart}
        workspaceId={workspaceId}
      />
    </div>
  );
}

function renderDrawingShape(
  context: CanvasRenderingContext2D,
  drawing: Drawing,
  points: Array<{ x: number; y: number }>,
  rect: { width: number; height: number },
): void {
  const first = points[0] as { x: number; y: number };
  if (drawing.type === 'horizontal-line') {
    context.moveTo(0, first.y);
    context.lineTo(rect.width, first.y);
    return;
  }
  if (drawing.type === 'vertical-line' || drawing.type === 'text') {
    context.moveTo(first.x, 0);
    context.lineTo(first.x, rect.height);
    return;
  }
  if (drawing.type === 'ray') {
    const second = points[1] ?? first;
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const scale = Math.max(rect.width, rect.height) * 2;
    const length = Math.hypot(dx, dy) || 1;
    context.moveTo(first.x, first.y);
    context.lineTo(first.x + (dx / length) * scale, first.y + (dy / length) * scale);
    return;
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] as { x: number; y: number };
    const end = points[i + 1] as { x: number; y: number };
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
  }
  if (drawing.type === 'rectangle' && points.length >= 2) {
    const second = points[1] as { x: number; y: number };
    context.moveTo(first.x, second.y);
    context.lineTo(first.x, first.y);
    context.moveTo(second.x, first.y);
    context.lineTo(second.x, second.y);
  }
}

function hitTest(
  screenAnchors: Array<{ x: number; y: number }>,
  type: DrawingType,
  point: { x: number; y: number },
): boolean {
  if (screenAnchors.length === 0) return false;
  const tolerance = 6;
  const first = screenAnchors[0] as { x: number; y: number };
  if (type === 'horizontal-line') return Math.abs(point.y - first.y) <= tolerance;
  if (type === 'vertical-line') return Math.abs(point.x - first.x) <= tolerance;
  if (screenAnchors.length === 1) return Math.hypot(point.x - first.x, point.y - first.y) <= tolerance * 2;
  if (type === 'rectangle') {
    const second = screenAnchors[1] as { x: number; y: number };
    const minX = Math.min(first.x, second.x) - tolerance;
    const maxX = Math.max(first.x, second.x) + tolerance;
    const minY = Math.min(first.y, second.y) - tolerance;
    const maxY = Math.max(first.y, second.y) + tolerance;
    return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
  }
  for (let i = 0; i < screenAnchors.length - 1; i += 1) {
    const start = screenAnchors[i] as { x: number; y: number };
    const end = screenAnchors[i + 1] as { x: number; y: number };
    if (distanceToSegment(point, start, end) <= tolerance) return true;
  }
  return false;
}

function distanceToSegment(
  point: { x: number; y: number },
  start: { x: number; y: number },
  end: { x: number; y: number },
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function indexDistance(controller: ChartController, fromDate: string, toDate: string): number | null {
  const from = controller.nearestDate(fromDate);
  const to = controller.nearestDate(toDate);
  if (!from || !to) return null;
  const fromX = controller.timeToX(from);
  const toX = controller.timeToX(to);
  if (fromX === null || toX === null) return null;
  // Convert the pixel delta into a logical bar delta using the current spacing.
  const range = controller.getVisibleRange();
  if (!range || range.to === range.from) return 0;
  const paneWidth = controller.paneRect().width || 1;
  const barsPerPixel = (range.to - range.from) / paneWidth;
  return Math.round((toX - fromX) * barsPerPixel);
}

function shiftDate(controller: ChartController, date: string, offset: number): string | null {
  const from = controller.nearestDate(date);
  if (!from) return null;
  const x = controller.timeToX(from);
  if (x === null) return null;
  const range = controller.getVisibleRange();
  if (!range || range.to === range.from) return from;
  const paneWidth = controller.paneRect().width || 1;
  const pixelsPerBar = paneWidth / (range.to - range.from);
  const shifted = controller.xToDate(x + offset * pixelsPerBar);
  return shifted ? controller.nearestDate(shifted) : from;
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function withAlpha(hex: string, alpha: number): string {
  const value = hex.trim();
  if (!value.startsWith('#') || value.length !== 7) return value;
  const r = Number.parseInt(value.slice(1, 3), 16);
  const g = Number.parseInt(value.slice(3, 5), 16);
  const b = Number.parseInt(value.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
