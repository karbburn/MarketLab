import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsVertical,
  ChartLineUp,
  Cursor,
  FrameCorners,
  ListBullets,
  Magnet,
  Minus,
  Plus,
  Ruler,
  Square,
  SquaresFour,
  TextT,
  TrendUp,
  Trash,
  WaveSine,
  X,
} from '@phosphor-icons/react';
import type { ChartConfig, ChartType, Drawing, DrawingAnchor, DrawingType, PriceScaleMode, Timeframe } from '../../domain/types';
import { formatPrice, formatSignedPercent } from '../../lib/format';
import { barsForTimeframe, timeframeLabel, availableTimeframes } from '../../lib/timeframe';
import { calculateIndicator, getIndicatorDefinition } from '../../lib/indicators';
import { describeIndicatorInstance } from '../../lib/indicators/management';
import {
  PRICE_NUDGE_LARGE_STEP,
  PRICE_NUDGE_STEP,
  SESSION_NUDGE_LARGE_STEP,
  anchorsRequired,
  hitTestDrawingAnchor,
  hitTestVisibleDrawing,
  isDrawingComplete,
  nudgeDrawingAnchor,
  priceRangeInfo,
  replaceDrawingAnchor,
  snapPriceToBar,
  stackAxisTags,
  textLabelBox,
} from '../../lib/drawings/geometry';
import { removeDrawing } from '../../lib/drawings/management';
import { createId } from '../../lib/id';
import { useStore } from '../../state/store';
import { datasetViews, type DatasetView } from '../../state/selectors';
import { Segmented, Select, Tag } from '../ui';
import { CHART_TYPE_OPTIONS } from '../../lib/chartTypes';
import { prepareComparison, type ComparisonLineSpec, type ComparisonPreparation, type ComparisonTarget } from '../../lib/chart/compare-overlays';
import { planCorporateActionMarkers } from '../../lib/corporate-actions';
import { changePercent, hoverBars } from '../../lib/chart/readout';
import { ChartController, type CrosshairReading, type IndicatorRenderSpec } from './adapter';
import { IndicatorDialog } from './IndicatorDialog';
import { CompareDialog } from './CompareDialog';
import { DrawingManager } from './DrawingManager';
import { TemplateDialog } from './TemplateDialog';

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

/** The style a freshly created drawing starts with. */
const DEFAULT_DRAWING_STYLE = {
  color: '#3fb8a3',
  lineWidth: 1.5,
  lineStyle: 'solid',
  fillOpacity: 0.12,
  fontSize: 12,
} as const;

interface TextEditorState {
  /** `null` while a brand new label is being typed, the drawing id when re-editing. */
  id: string | null;
  /** Anchor for a new label; an existing label already has its anchors stored. */
  anchor: DrawingAnchor | null;
  /** Stage-relative position of the editor, captured at the click. */
  point: { x: number; y: number };
  value: string;
  original: string;
}

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
  const dragRef = useRef<
    | { kind: 'move'; id: string; startPrice: number; startDate: string; latest: Drawing[] }
    | { kind: 'anchor'; id: string; anchorIndex: number; latest: Drawing[] }
    | null
  >(null);
  const historyRef = useRef<{ past: Drawing[][]; future: Drawing[][] }>({ past: [], future: [] });
  // History lives in a ref so pointer handlers stay synchronous; the lengths are
  // mirrored into state to drive the disabled state of the undo/redo controls.
  const [historySize, setHistorySize] = useState({ past: 0, future: 0 });

  const [tool, setTool] = useState<DrawingType | 'cursor'>('cursor');
  // Magnet mode is a transient drawing preference, like an active tool. It
  // affects creation and anchor dragging but is deliberately not persisted into
  // the workspace or backup schema.
  const [magnet, setMagnet] = useState(false);
  const [pendingAnchors, setPendingAnchors] = useState<DrawingAnchor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Keyboard nudging addresses one endpoint at a time. The id keeps the index
  // from leaking across selections without a state-synchronising effect.
  const [activeAnchor, setActiveAnchor] = useState<{ drawingId: string; index: number } | null>(null);
  const [anchorAnnouncement, setAnchorAnnouncement] = useState('');
  const [readout, setReadout] = useState<CrosshairReading>({ date: null, price: null, index: null });
  const [indicatorDialogOpen, setIndicatorDialogOpen] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [drawingManagerOpen, setDrawingManagerOpen] = useState(false);
  // While a drawing is being dragged or edited the local copy leads; the stored
  // workspace state remains the source of truth at rest.
  const [draftDrawings, setDraftDrawings] = useState<Drawing[] | null>(null);
  // The text tool writes real text, so a click places a label through an inline
  // editor instead of stamping a fixed string. Nothing is stored until the
  // label is committed, so cancelling leaves no drawing and no history entry.
  const [textEditor, setTextEditor] = useState<TextEditorState | null>(null);
  // Escape commits nothing, then blurs the input as it unmounts; the flag stops
  // the blur from being read as a second, committing edit.
  const textEditClosedRef = useRef(false);
  const textEditorInputRef = useRef<HTMLInputElement>(null);
  const managerButtonRef = useRef<HTMLButtonElement>(null);
  const axisLabelsRef = useRef<HTMLDivElement>(null);
  const localDrawings = draftDrawings ?? chart.drawings;
  // The ref makes a sequence of quick manager edits compose even when React has
  // not re-rendered with the previous edit yet.
  const localDrawingsRef = useRef(localDrawings);
  useEffect(() => {
    localDrawingsRef.current = localDrawings;
  }, [localDrawings]);
  // A selection only counts while the drawing it points at still exists, so undo
  // and redo can never leave the toolbar acting on a drawing that is not there.
  const selectedDrawing = selectedId === null ? null : localDrawings.find((drawing) => drawing.id === selectedId) ?? null;
  const selectedDrawingId = selectedDrawing?.id ?? null;
  const activeAnchorIndex =
    selectedDrawing && activeAnchor?.drawingId === selectedDrawing.id
      ? Math.min(activeAnchor.index, selectedDrawing.anchors.length - 1)
      : 0;

  const bars = useMemo(() => view?.bars ?? [], [view]);
  const dataset = view?.dataset ?? null;
  const instrument = view?.instrument ?? null;
  const rendered = useMemo(() => {
    if (!dataset) return bars;
    return barsForTimeframe(bars, dataset, chart.timeframe);
  }, [bars, dataset, chart.timeframe]);

  const allViews = useMemo(() => datasetViews(state), [state]);

  // Comparison ids are stored as dataset references. Any id that no longer
  // resolves (or points at the panel's own dataset) is ignored here; the store
  // normally prunes those on load and on dataset deletion.
  const compareTargets = useMemo<ComparisonTarget[]>(() => {
    if (!dataset || !instrument) return [];
    return (chart.compareDatasetIds ?? [])
      .map((id) => allViews.find((entry) => entry.dataset.id === id))
      .filter((entry): entry is DatasetView => entry !== undefined && entry.dataset.id !== chart.datasetId)
      .map((entry) => ({
        datasetId: entry.dataset.id,
        label: entry.instrument?.symbol ?? entry.dataset.name,
        dataset: entry.dataset,
        bars: entry.bars,
      }));
  }, [allViews, chart.compareDatasetIds, chart.datasetId, dataset, instrument]);

  const comparison = useMemo<ComparisonPreparation | null>(() => {
    if (!dataset || !instrument || compareTargets.length === 0) return null;
    return prepareComparison({
      primary: { datasetId: dataset.id, label: instrument.symbol, dataset, bars },
      candidates: compareTargets,
      timeframe: chart.timeframe,
    });
  }, [bars, chart.timeframe, compareTargets, dataset, instrument]);

  const comparisonLines = useMemo<ComparisonLineSpec[]>(() => comparison?.lines ?? [], [comparison]);

  // Corporate-action markers belong to the primary series only. They are
  // planned against the bars actually on screen, so a 1W/1M aggregation cannot
  // put a marker on a date the time scale does not contain.
  const corporateActionPlan = useMemo(
    () =>
      planCorporateActionMarkers({
        actions: dataset?.provider?.corporateActions ?? [],
        bars: rendered,
        currency: instrument?.currency,
      }),
    [dataset, instrument?.currency, rendered],
  );
  const corporateActionSource =
    dataset?.provider?.provider === 'yahoo-finance' ? 'Yahoo Finance' : 'the provider';

  // A comparison set is relative to the primary dataset. When the panel is
  // re-pointed at a different dataset, drop the old overlays rather than
  // leaving a context that was never chosen against the new primary.
  const previousDatasetId = useRef(chart.datasetId);
  useEffect(() => {
    if (previousDatasetId.current === chart.datasetId) return;
    previousDatasetId.current = chart.datasetId;
    if ((chart.compareDatasetIds ?? []).length === 0) return;
    void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, compareDatasetIds: [] }));
  }, [actions, chart.compareDatasetIds, chart.datasetId, chart.id, workspaceId]);

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
    controller.render({
      bars: rendered,
      chartType: chart.chartType,
      showVolume: chart.showVolume,
      priceScaleMode: chart.priceScaleMode,
      indicators: indicatorSpecs,
      comparisons: comparisonLines,
      corporateActions: corporateActionPlan.markers,
    });
  }, [rendered, chart.chartType, chart.showVolume, chart.priceScaleMode, indicatorSpecs, comparisonLines, corporateActionPlan.markers]);

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
    // A visible left index scale (comparison overlays) shifts the plot area to
    // the right. Keep the drawing layer on the pane, not on the stage origin.
    canvas.style.left = `${controller.paneLeft()}px`;
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

      // A locked drawing is still highlighted when selected, but its endpoints
      // are not interactive handles.
      if (selected && !drawing.locked) {
        const activeIndex = Math.min(activeAnchorIndex, resolved.length - 1);
        for (let index = 0; index < resolved.length; index += 1) {
          const point = resolved[index] as { x: number; y: number };
          const active = index === activeIndex;
          context.beginPath();
          context.arc(point.x, point.y, active ? 6.5 : 5, 0, Math.PI * 2);
          context.fillStyle = labelColor;
          context.fill();
          context.lineWidth = active ? 2.5 : 1.5;
          context.strokeStyle = active ? drawing.style.color : labelColor;
          context.stroke();
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

    // Axis endpoint tags are DOM nodes rather than canvas ink so they can paint
    // over the chart library's axis labels and stay crisp at every DPR. The
    // price axis shows every endpoint of the selected drawing; the time axis
    // follows the endpoint that pointer or keyboard editing currently addresses.
    const tagsHost = axisLabelsRef.current;
    if (tagsHost) {
      tagsHost.replaceChildren();
      if (selectedDrawing && selectedDrawing.visible && !selectedDrawing.locked) {
        const paneLeft = controller.paneLeft();
        const entries = selectedDrawing.anchors
          .map((anchor, index) => {
            const y = controller.priceToY(anchor.price);
            // Off-screen endpoints have no meaningful axis position; do not pin
            // them to the nearest edge as if the price were visible.
            if (y === null || y < 0 || y > rect.height) return null;
            return { key: `anchor-${index}`, y, label: formatPrice(anchor.price) };
          })
          .filter((entry): entry is { key: string; y: number; label: string } => entry !== null);
        for (const entry of stackAxisTags(entries, rect.height)) {
          const tag = document.createElement('span');
          tag.className = 'drawing-axis-label price';
          tag.textContent = entry.label;
          tag.style.top = `${entry.y}px`;
          tagsHost.append(tag);
        }
        const currentAnchor = selectedDrawing.anchors[Math.min(activeAnchorIndex, selectedDrawing.anchors.length - 1)];
        const activeX = currentAnchor ? controller.timeToX(currentAnchor.date) : null;
        if (currentAnchor && activeX !== null && activeX >= 0 && activeX <= rect.width) {
          const tag = document.createElement('span');
          tag.className = 'drawing-axis-label time';
          tag.textContent = currentAnchor.date;
          tag.style.left = `${paneLeft + activeX}px`;
          tagsHost.append(tag);
        }
      }
    }
  }, [activeAnchorIndex, labelColor, localDrawings, selectedId, selectedDrawing, pendingAnchors, readout]);

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
    (next: Drawing[], base: Drawing[] = localDrawingsRef.current) => {
      if (next === base) return;
      // `base` is the state the change started from. A drag supplies its
      // pre-drag snapshot, so Undo restores where the drag began.
      historyRef.current.past.push(base);
      historyRef.current.future = [];
      syncHistory();
      localDrawingsRef.current = next;
      setDraftDrawings(next);
      void actions
        .updateChart(workspaceId, chart.id, (config) => ({ ...config, drawings: next }))
        .then(() => setDraftDrawings((current) => (current === next ? null : current)));
    },
    [actions, chart.id, syncHistory, workspaceId],
  );

  /** Applies a manager edit to the freshest local list, then records one step. */
  const mutateDrawings = useCallback(
    (mutate: (drawings: Drawing[]) => Drawing[]) => {
      const current = localDrawingsRef.current;
      const next = mutate(current);
      if (next !== current) commitDrawings(next, current);
    },
    [commitDrawings],
  );

  /**
   * Moves the endpoint addressed by [ and ], one ordinary history step per
   * keypress. Sessions come from the rendered timeframe, so a weekly panel moves
   * between displayed weekly bars rather than seven calendar days.
   */
  const nudgeActiveAnchor = useCallback(
    (sessionDelta: number, priceDelta: number) => {
      const drawing = localDrawingsRef.current.find((entry) => entry.id === selectedDrawingId);
      if (!drawing || drawing.locked || !drawing.visible) return;
      const index = Math.min(Math.max(activeAnchorIndex, 0), drawing.anchors.length - 1);
      const current = drawing.anchors[index];
      if (!current) return;
      const nextAnchor = nudgeDrawingAnchor(current, rendered.map((bar) => bar.date), {
        sessions: sessionDelta,
        price: priceDelta,
      });
      if (nextAnchor === current) return;
      const anchors = replaceDrawingAnchor(drawing.anchors, index, nextAnchor);
      if (anchors === drawing.anchors) return;
      const next = localDrawingsRef.current.map((entry) => (entry.id === drawing.id ? { ...entry, anchors } : entry));
      commitDrawings(next);
      setAnchorAnnouncement(describeAnchor(drawing, index, nextAnchor));
    },
    [activeAnchorIndex, commitDrawings, rendered, selectedDrawingId],
  );

  const undo = useCallback(() => {
    const previous = historyRef.current.past.pop();
    if (!previous) return;
    historyRef.current.future.push(localDrawingsRef.current);
    syncHistory();
    localDrawingsRef.current = previous;
    setDraftDrawings(previous);
    void actions
      .updateChart(workspaceId, chart.id, (config) => ({ ...config, drawings: previous }))
      .then(() => setDraftDrawings((current) => (current === previous ? null : current)));
  }, [actions, chart.id, syncHistory, workspaceId]);

  const redo = useCallback(() => {
    const next = historyRef.current.future.pop();
    if (!next) return;
    historyRef.current.past.push(localDrawingsRef.current);
    syncHistory();
    localDrawingsRef.current = next;
    setDraftDrawings(next);
    void actions
      .updateChart(workspaceId, chart.id, (config) => ({ ...config, drawings: next }))
      .then(() => setDraftDrawings((current) => (current === next ? null : current)));
  }, [actions, chart.id, syncHistory, workspaceId]);

  /**
   * Screen positions aligned with the anchor array. A null entry means that
   * anchor is outside the current viewport; keeping the hole preserves the
   * index the pointer handler needs in order to move one endpoint.
   */
  const anchorScreenPoints = (drawing: Drawing, controller: ChartController): Array<{ x: number; y: number } | null> =>
    drawing.anchors.map((entry) => {
      const x = controller.timeToX(entry.date);
      const y = controller.priceToY(entry.price);
      return x === null || y === null ? null : { x, y };
    });

  /**
   * The painted box of a text label, measured with the same canvas font the
   * renderer uses. The label is hit-tested against this box rather than the
   * anchor alone, so clicking the visible text selects it.
   */
  const textLabelBoxFor = (drawing: Drawing, points: ReadonlyArray<{ x: number; y: number } | null>) => {
    if (drawing.type !== 'text' || !drawing.text) return null;
    const anchor = points[0];
    if (!anchor) return null;
    const size = drawing.style.fontSize ?? 12;
    const context = canvasRef.current?.getContext('2d');
    let width: number | undefined;
    if (context) {
      context.save();
      context.font = `${size}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-sans')}`;
      width = context.measureText(drawing.text).width;
      context.restore();
    }
    return textLabelBox(anchor, drawing.text, size, width);
  };

  const pointForAnchor = (anchor: DrawingAnchor): { x: number; y: number } | null => {
    const controller = controllerRef.current;
    if (!controller) return null;
    const x = controller.timeToX(anchor.date);
    const y = controller.priceToY(anchor.price);
    return x === null || y === null ? null : { x, y };
  };

  const pointerToAnchor = (event: React.MouseEvent<HTMLDivElement>, magnetEnabled = false): DrawingAnchor | null => {
    const controller = controllerRef.current;
    if (!controller) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left - controller.paneLeft();
    const y = event.clientY - rect.top;
    const rawDate = controller.xToDate(x);
    const date = rawDate ? controller.nearestDate(rawDate) : null;
    const rawPrice = controller.yToPrice(y);
    if (!date || rawPrice === null) return null;
    if (!magnetEnabled) return { date, price: rawPrice };
    const bar = rendered.find((entry) => entry.date === date);
    if (!bar) return { date, price: rawPrice };
    return { date, price: snapPriceToBar(rawPrice, bar, (value) => controller.priceToY(value)) };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    onFocus();
    // The shortcuts belong to this panel, so the pointer click takes focus.
    stageRef.current?.focus({ preventScroll: true });
    const rect = event.currentTarget.getBoundingClientRect();
    const paneLeft = controllerRef.current?.paneLeft() ?? 0;
    const point = { x: event.clientX - rect.left - paneLeft, y: event.clientY - rect.top };

    if (tool === 'cursor') {
      const controller = controllerRef.current;
      if (!controller) return;
      // Handles take precedence over the drawing body, otherwise grabbing an
      // endpoint would move the whole object.
      if (selectedDrawing && !selectedDrawing.locked) {
        const anchorIndex = hitTestDrawingAnchor(anchorScreenPoints(selectedDrawing, controller), point);
        if (anchorIndex !== null) {
          setSelectedId(selectedDrawing.id);
          setActiveAnchor({ drawingId: selectedDrawing.id, index: anchorIndex });
          setAnchorAnnouncement(describeAnchor(selectedDrawing, anchorIndex));
          dragRef.current = {
            kind: 'anchor',
            id: selectedDrawing.id,
            anchorIndex,
            latest: localDrawingsRef.current,
          };
          controller.setDragToPan(false);
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
      }
      const hit = [...localDrawings].reverse().find((drawing) => {
        const points = anchorScreenPoints(drawing, controller);
        return hitTestVisibleDrawing(drawing, points, point, {
          textBox: textLabelBoxFor(drawing, points),
        });
      });
      setSelectedId(hit ? hit.id : null);
      if (hit && !hit.locked) {
        const anchor = pointerToAnchor(event);
        if (!anchor) return;
        dragRef.current = {
          kind: 'move',
          id: hit.id,
          startPrice: anchor.price,
          startDate: anchor.date,
          latest: localDrawingsRef.current,
        };
        // Stop the chart from panning underneath the drawing drag.
        controller.setDragToPan(false);
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }

    const anchor = pointerToAnchor(event, magnet);
    if (!anchor) return;
    const first = pendingAnchors[0];
    if (!first) {
      // Single-anchor tools complete on the first click.
      if (anchorsRequired(tool as DrawingType) === 1) createDrawing([anchor], point);
      else setPendingAnchors([anchor]);
      return;
    }
    createDrawing([first, anchor]);
    setPendingAnchors([]);
  };

  /** Re-opens the label editor for an existing text drawing. */
  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tool !== 'cursor') return;
    if (!pointerToAnchor(event)) return;
    const controller = controllerRef.current;
    if (!controller) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = { x: event.clientX - rect.left - controller.paneLeft(), y: event.clientY - rect.top };
    const target = [...localDrawings]
      .reverse()
      .find((drawing) => {
        if (drawing.type !== 'text' || drawing.locked) return false;
        const points = anchorScreenPoints(drawing, controller);
        return hitTestVisibleDrawing(drawing, points, point, {
          textBox: textLabelBoxFor(drawing, points),
        });
      });
    if (!target) return;
    openTextEditor({ id: target.id, anchor: null, point, value: target.text ?? '', original: target.text ?? '' });
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    // Magnet only applies to anchors the user is placing or reshaping, never to
    // a whole-object move where it would pull individual endpoints apart.
    const snapping = tool !== 'cursor' ? magnet : drag?.kind === 'anchor' && magnet;
    const anchor = pointerToAnchor(event, snapping);
    // The overlay covers the pane while a tool is active, so the chart
    // crosshair no longer fires. The readout and the preview follow the
    // pointer event instead. With the pointer tool the chart owns the
    // crosshair, so this path stays out of the way and cannot double-render.
    if (anchor && (tool !== 'cursor' || drag?.kind === 'anchor')) {
      setReadout((current) => {
        if (current.date === anchor.date && current.price === anchor.price) return current;
        const index = rendered.findIndex((bar) => bar.date === anchor.date);
        return { date: anchor.date, price: anchor.price, index: index >= 0 ? index : null };
      });
    }

    if (!drag || event.buttons === 0) return;
    if (!anchor) return;
    const controller = controllerRef.current;
    if (!controller) return;

    if (drag.kind === 'anchor') {
      const drawing = drag.latest.find((entry) => entry.id === drag.id);
      if (!drawing) return;
      const anchors = replaceDrawingAnchor(drawing.anchors, drag.anchorIndex, anchor);
      if (anchors === drawing.anchors) return;
      const next = drag.latest.map((entry) => (entry.id === drag.id ? { ...entry, anchors } : entry));
      localDrawingsRef.current = next;
      setDraftDrawings(next);
      return;
    }

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
    localDrawingsRef.current = next;
    setDraftDrawings(next);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    controllerRef.current?.setDragToPan(true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // The pre-drag snapshot is the undo base, not the already-moved set.
    const moved = localDrawingsRef.current;
    if (moved !== drag.latest) commitDrawings(moved, drag.latest);
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    controllerRef.current?.setDragToPan(true);
    setDraftDrawings(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const createDrawing = (anchors: DrawingAnchor[], point?: { x: number; y: number }) => {
    const type = tool as DrawingType;
    if (!isDrawingComplete({ type, anchors })) {
      setPendingAnchors(anchors);
      return;
    }
    // A text drawing is only stored once its label is typed, so a cancelled
    // label leaves neither an invisible drawing nor a history entry behind.
    if (type === 'text') {
      const anchor = anchors[0] as DrawingAnchor;
      const editorPoint = point ?? pointForAnchor(anchor);
      if (!editorPoint) return;
      openTextEditor({ id: null, anchor, point: editorPoint, value: '', original: '' });
      selectTool('cursor');
      return;
    }
    const created: Drawing = {
      id: createId('drw'),
      type,
      anchors,
      visible: true,
      locked: false,
      style: { ...DEFAULT_DRAWING_STYLE },
      levels: type === 'fibonacci' ? [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] : undefined,
    };
    commitDrawings([...localDrawingsRef.current, created]);
    setSelectedId(created.id);
    selectTool('cursor');
  };

  const openTextEditor = (editor: TextEditorState) => {
    textEditClosedRef.current = false;
    setTextEditor(editor);
  };

  useEffect(() => {
    if (!textEditor) return;
    // The click that opens the editor also focuses the stage (its own default
    // action), which would immediately blur the field and commit an empty
    // label. Waiting a frame lets that focus land first.
    const frame = requestAnimationFrame(() => textEditorInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [textEditor]);

  const finishTextEdit = (mode: 'commit' | 'cancel') => {
    if (textEditClosedRef.current) return;
    textEditClosedRef.current = true;
    const editor = textEditor;
    if (!editor) return;
    setTextEditor(null);
    const value = editor.value.trim();
    // Cancelling, or committing an empty label, stores nothing: a label with no
    // text cannot be seen, and deleting an existing one stays an explicit act.
    if (mode === 'cancel' || value === '') return;
    if (editor.id === null) {
      if (!editor.anchor) return;
      const created: Drawing = {
        id: createId('drw'),
        type: 'text',
        anchors: [editor.anchor],
        visible: true,
        locked: false,
        style: { ...DEFAULT_DRAWING_STYLE },
        text: value,
      };
      commitDrawings([...localDrawingsRef.current, created]);
      setSelectedId(created.id);
      return;
    }
    if (value === editor.original) return;
    const current = localDrawingsRef.current;
    commitDrawings(current.map((drawing) => (drawing.id === editor.id ? { ...drawing, text: value } : drawing)), current);
  };

  const removeSelected = useCallback(() => {
    if (!selectedDrawingId) return;
    const current = localDrawingsRef.current;
    const next = removeDrawing(current, selectedDrawingId);
    if (next === current) return;
    commitDrawings(next, current);
    setSelectedId(null);
  }, [commitDrawings, selectedDrawingId]);

  const removeComparison = useCallback(
    (datasetId: string) => {
      void actions.updateChart(workspaceId, chart.id, (config) => ({
        ...config,
        compareDatasetIds: (config.compareDatasetIds ?? []).filter((id) => id !== datasetId),
      }));
    },
    [actions, chart.id, workspaceId],
  );

  const clearComparisons = useCallback(() => {
    void actions.updateChart(workspaceId, chart.id, (config) => ({ ...config, compareDatasetIds: [] }));
  }, [actions, chart.id, workspaceId]);

  const selectTool = useCallback((next: DrawingType | 'cursor') => {
    setPendingAnchors([]);
    setTool(next);
  }, []);

  const closeDrawingManager = useCallback(() => {
    setDrawingManagerOpen(false);
    requestAnimationFrame(() => managerButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!focused) return;
    // The shortcuts belong to the focused panel, but the toolbar buttons drop
    // focus to the document when they disable themselves (Undo, Redo, Delete),
    // so a listener on the panel element would silently stop firing. Listening
    // on the window while this panel is the focused one keeps them working.
    const onKeyDown = (event: KeyboardEvent) => {
      // Keystrokes typed into the indicator dialog (or any form control) must
      // never reach the drawing shortcuts.
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, select, textarea, [contenteditable="true"], [role="dialog"]')) return;
      if (event.key === 'Escape') {
        if (drawingManagerOpen) {
          closeDrawingManager();
          return;
        }
        selectTool('cursor');
        setSelectedId(null);
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
        return;
      }
      // Endpoint editing is keyboard-accessible: [ and ] choose an endpoint and
      // the arrows nudge it. Buttons keep their native arrow behaviour and the
      // object list has its own keyboard model, so both are left alone.
      if (!selectedDrawingId || drawingManagerOpen || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '[' || event.key === ']') {
        if (!selectedDrawing) return;
        const anchors = selectedDrawing.anchors;
        if (anchors.length === 0) return;
        event.preventDefault();
        const step = event.key === ']' ? 1 : anchors.length - 1;
        const nextIndex = (activeAnchorIndex + step) % anchors.length;
        setActiveAnchor({ drawingId: selectedDrawing.id, index: nextIndex });
        setAnchorAnnouncement(describeAnchor(selectedDrawing, nextIndex));
        return;
      }
      if (event.target instanceof HTMLElement && event.target.closest('button, a[href]')) return;
      const sessionStep =
        event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
      const priceStep =
        event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
      if (sessionStep === 0 && priceStep === 0) return;
      event.preventDefault();
      nudgeActiveAnchor(
        sessionStep * (event.shiftKey ? SESSION_NUDGE_LARGE_STEP : 1),
        priceStep * (event.shiftKey ? PRICE_NUDGE_LARGE_STEP : PRICE_NUDGE_STEP),
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeAnchorIndex,
    closeDrawingManager,
    drawingManagerOpen,
    focused,
    nudgeActiveAnchor,
    redo,
    removeSelected,
    selectTool,
    selectedDrawing,
    selectedDrawingId,
    undo,
  ]);

  const { hoverBar, previousBar } = hoverBars(rendered, readout.index);
  const changePct = changePercent(hoverBar, previousBar);
  const tone = changePct === null ? undefined : changePct >= 0 ? 'up' : 'down';
  const drawingHelpId = `drawing-help-${chart.id}`;

  return (
    <div className={focused ? 'chart-panel focused' : 'chart-panel'} onFocus={onFocus} tabIndex={-1}>
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
          options={CHART_TYPE_OPTIONS}
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
        <button
          type="button"
          className="tool-button"
          title="Compare symbol"
          aria-label="Compare symbol"
          aria-pressed={compareTargets.length > 0}
          onClick={() => setCompareDialogOpen(true)}
        >
          <ChartLineUp size={14} weight={compareTargets.length > 0 ? 'bold' : 'regular'} />
        </button>
        <button type="button" className="tool-button" title="Add indicator" aria-label="Add indicator" onClick={() => setIndicatorDialogOpen(true)}>
          <Plus size={14} weight="bold" />
        </button>
        <button
          type="button"
          className="tool-button"
          title="Chart templates"
          aria-label="Chart templates"
          aria-pressed={templateDialogOpen}
          onClick={() => setTemplateDialogOpen(true)}
        >
          <SquaresFour size={14} />
        </button>
        <button
          ref={managerButtonRef}
          type="button"
          className="tool-button"
          title={`Drawing objects (${localDrawings.length})`}
          aria-label="Drawing objects"
          aria-pressed={drawingManagerOpen}
          onClick={() => setDrawingManagerOpen((open) => !open)}
        >
          <ListBullets size={14} />
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
          <button
            type="button"
            className="tool-button"
            aria-label="Magnet snap"
            aria-pressed={magnet}
            title="Magnet snap: place drawing anchors on the closest OHLC value"
            onClick={() => setMagnet((enabled) => !enabled)}
          >
            <Magnet size={15} weight={magnet ? 'fill' : 'regular'} />
          </button>
          <button
            type="button"
            className="tool-button"
            aria-label="Delete selected drawing"
            title={selectedDrawing?.locked ? 'Unlock to delete' : 'Delete selected drawing'}
            disabled={!selectedDrawing || selectedDrawing.locked}
            onClick={removeSelected}
            style={{ opacity: selectedDrawing && !selectedDrawing.locked ? 1 : 0.4 }}
          >
            <Trash size={15} />
          </button>
        </div>

        <div className="chart-panel" style={{ minHeight: 380 }}>
          <div
            className="chart-stage"
            ref={stageRef}
            tabIndex={0}
            role="group"
            aria-label={`Price chart, ${instrument?.symbol ?? 'no dataset selected'}`}
            aria-describedby={drawingHelpId}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
            onDoubleClick={handleDoubleClick}
          >
            <div className="chart-canvas-host" ref={containerRef} />
            <canvas
              ref={canvasRef}
              className={tool === 'cursor' ? 'chart-overlay' : 'chart-overlay active'}
            />
            <div ref={axisLabelsRef} className="drawing-axis-labels" aria-hidden="true" />
            <p id={drawingHelpId} className="visually-hidden">
              Select a drawing to show endpoint tags on the price and time axes. Press [ or ] to choose an
              endpoint, then use the arrow keys to nudge it. Hold Shift for five sessions or ten price steps.
            </p>
            <span className="visually-hidden" role="status" aria-live="polite">
              {anchorAnnouncement}
            </span>
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
              {comparison && (
                <div className="legend-row compare-legend-title">
                  <span className="muted">
                    Compare ·{' '}
                    {comparison.baselineDate ? `index 100 = ${comparison.baselineDate}` : 'no shared baseline'}
                  </span>
                  <button type="button" className="legend-action" onClick={clearComparisons}>
                    Clear all
                  </button>
                </div>
              )}
              {comparison?.lines.map((line) => {
                const value = comparisonValueAt(line, readout.date);
                const relative = value === null ? null : value - 100;
                return (
                  <div className="legend-row compare-legend-item" key={line.datasetId}>
                    <span className={`legend-line ${line.lineStyle}`} style={{ borderTopColor: line.color }} aria-hidden />
                    <span className="muted">
                      {line.label}
                      {line.primary ? ' (primary)' : ''}
                    </span>
                    <span className="legend-values mono">
                      <span>{value === null ? '–' : value.toFixed(2)}</span>
                      {relative !== null && <span className={relative >= 0 ? 'up' : 'down'}>{formatSignedPercent(relative)}</span>}
                    </span>
                    {!line.primary && (
                      <button
                        type="button"
                        className="legend-action"
                        aria-label={`Remove ${line.label} comparison`}
                        onClick={() => removeComparison(line.datasetId)}
                      >
                        <X size={11} weight="bold" />
                      </button>
                    )}
                  </div>
                );
              })}
              {comparison && comparison.status !== 'ok' && (
                <div className="legend-row">
                  <span className="muted">{comparison.message}</span>
                </div>
              )}
            </div>

            {textEditor && (
              <input
                className="drawing-text-editor"
                ref={textEditorInputRef}
                style={{ left: textEditor.point.x + 6, top: Math.max(2, textEditor.point.y - 12) }}
                aria-label="Drawing label"
                placeholder="Type a label"
                value={textEditor.value}
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onChange={(event) => setTextEditor({ ...textEditor, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    finishTextEdit('commit');
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    finishTextEdit('cancel');
                  }
                }}
                onBlur={() => finishTextEdit('commit')}
              />
            )}

            {drawingManagerOpen && (
              <DrawingManager
                drawings={localDrawings}
                selectedId={selectedDrawingId}
                onSelect={setSelectedId}
                onMutate={mutateDrawings}
                onClose={closeDrawingManager}
              />
            )}
          </div>
        </div>
      </div>

      {comparison && (
        <div className="panel-foot compare-foot">
          <div className="stack" style={{ gap: 4 }}>
            {comparison.excluded.map((entry) => (
              <span key={entry.datasetId} className="field-hint">
                {entry.label}: {entry.reason}
              </span>
            ))}
            <span className="field-hint">{comparison.methodNote}</span>
          </div>
        </div>
      )}

      {corporateActionPlan.note && (
        <div className="panel-foot action-foot">
          <div className="stack" style={{ gap: 4 }}>
            {corporateActionPlan.markers.length > 0 && (
              <span className="field-hint action-summary">
                {corporateActionPlan.splits > 0 && (
                  <>
                    <span className="action-swatch split" aria-hidden />
                    Split marker
                  </>
                )}
                {corporateActionPlan.dividends > 0 && (
                  <>
                    <span className="action-swatch dividend" aria-hidden />
                    Dividend marker
                  </>
                )}
                <span className="faint">
                  &middot; primary series &middot; {corporateActionSource}
                </span>
              </span>
            )}
            <span className="field-hint">{corporateActionPlan.note}</span>
          </div>
        </div>
      )}

      {chart.indicators.length > 0 && (
        <div className="panel-foot" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {chart.indicators.map((instance) => {
            const definition = getIndicatorDefinition(instance.type);
            const label = describeIndicatorInstance(definition, instance);
            return (
              <span key={instance.id} className="row tight">
                <Tag tone={instance.visible ? 'accent' : undefined}>
                  {label}
                  <span className="panel-sub" style={{ marginLeft: 4 }}>
                    {instance.placement === 'overlay' ? 'overlaid' : 'pane'}
                  </span>
                </Tag>
                <button
                  type="button"
                  className="button ghost sm"
                  aria-label={instance.visible ? `Hide ${label}` : `Show ${label}`}
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
                  aria-label={`Remove ${label}`}
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

      <CompareDialog
        open={compareDialogOpen}
        onClose={() => setCompareDialogOpen(false)}
        chart={chart}
        workspaceId={workspaceId}
        primaryDatasetId={chart.datasetId}
        views={allViews}
        preparation={comparison}
      />

      <TemplateDialog
        open={templateDialogOpen}
        onClose={() => setTemplateDialogOpen(false)}
        chart={chart}
        workspaceId={workspaceId}
      />
    </div>
  );
}

/**
 * The rebased value at the crosshair session, or the latest value when the
 * pointer is away from the chart. A session the comparison does not share is
 * reported as missing (`null`) rather than carried forward.
 */
function comparisonValueAt(line: ComparisonLineSpec, date: string | null): number | null {
  if (line.points.length === 0) return null;
  if (date === null) return line.points[line.points.length - 1]?.value ?? null;
  return line.points.find((point) => point.date === date)?.value ?? null;
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
  if (drawing.type === 'vertical-line') {
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

/**
 * Human-readable endpoint description used by the live region. Passing the
 * already-computed anchor avoids re-reading a stale drawing after a nudge.
 */
function describeAnchor(drawing: Drawing, index: number, anchor = drawing.anchors[index]): string {
  if (!anchor) return '';
  return `Endpoint ${index + 1} of ${drawing.anchors.length}: ${anchor.date}, ${formatPrice(anchor.price)}`;
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
