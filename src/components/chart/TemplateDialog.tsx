import { useMemo, useState } from 'react';
import { FloppyDisk, Trash } from '@phosphor-icons/react';
import type { ChartConfig, ChartTemplate } from '../../domain/types';
import { applyChartTemplate, createChartTemplate } from '../../lib/chart/templates';
import { useStore } from '../../state/store';
import { Field, Modal, Tag, TextInput } from '../ui';

const CHART_TYPE_LABELS: Record<ChartConfig['chartType'], string> = {
  candlestick: 'Candles',
  bar: 'OHLC bars',
  line: 'Line',
  area: 'Area',
  baseline: 'Baseline',
};

const SCALE_LABELS: Record<ChartConfig['priceScaleMode'], string> = {
  normal: 'Linear',
  logarithmic: 'Log',
  percentage: 'Percent',
};

function templateSummary(template: ChartTemplate): string {
  return [
    CHART_TYPE_LABELS[template.chartType],
    SCALE_LABELS[template.priceScaleMode],
    template.timeframe,
    template.showVolume ? 'volume' : 'no volume',
    `${template.indicators.length} indicator${template.indicators.length === 1 ? '' : 's'}`,
  ].join(' · ');
}

/**
 * Saved chart templates for one panel.
 *
 * A template stores presentation and indicators only. Applying one replaces
 * those on this panel and leaves its dataset, visible range, comparisons and
 * drawings untouched; the copy is applied in a single chart write.
 */
export function TemplateDialog({
  open,
  onClose,
  chart,
  workspaceId,
}: {
  open: boolean;
  onClose: () => void;
  chart: ChartConfig;
  workspaceId: string;
}) {
  const { state, actions } = useStore();
  const [name, setName] = useState('');
  const templates = useMemo(
    () => [...state.chartTemplates].sort((left, right) => left.name.localeCompare(right.name)),
    [state.chartTemplates],
  );

  const saveCurrent = async () => {
    if (!name.trim()) return;
    await actions.saveChartTemplate(createChartTemplate(chart, name));
    setName('');
  };

  const apply = (template: ChartTemplate) => {
    void actions.updateChart(workspaceId, chart.id, (config) => applyChartTemplate(config, template));
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Chart templates"
      wide
      footer={
        <button type="button" className="button ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="stack">
        <span className="panel-sub">
          A template stores the chart type, price scale, volume pane, timeframe and the ordered indicator set. It never
          stores market data, the visible range, comparisons or drawings.
        </span>

        <div className="panel" style={{ background: 'var(--surface-inset)' }}>
          <div className="panel-body stack">
            <span className="panel-title">Save this chart as a template</span>
            <div className="row">
              <Field label="Template name">
                <TextInput
                  value={name}
                  onChange={setName}
                  placeholder="e.g. Trend review"
                  ariaLabel="Template name"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void saveCurrent();
                    }
                  }}
                />
              </Field>
              <button type="button" className="button primary" disabled={!name.trim()} onClick={() => void saveCurrent()}>
                <FloppyDisk size={13} aria-hidden />
                Save template
              </button>
            </div>
            <span className="field-hint">
              Currently captures {CHART_TYPE_LABELS[chart.chartType]}, {SCALE_LABELS[chart.priceScaleMode]},{' '}
              {chart.timeframe}, {chart.showVolume ? 'volume shown' : 'volume hidden'} and{' '}
              {chart.indicators.length} indicator{chart.indicators.length === 1 ? '' : 's'}.
            </span>
          </div>
        </div>

        <div className="stack">
          <span className="panel-title">Saved templates</span>
          {templates.length === 0 ? (
            <span className="field-hint">No templates yet. Save one from any panel, then apply it here or on another panel.</span>
          ) : (
            <ul className="list-reset stack">
              {templates.map((template) => (
                <li key={template.id} className="spread template-row">
                  <div style={{ display: 'grid', gap: 2 }}>
                    <span className="row tight">
                      <strong>{template.name}</strong>
                      {template.timeframe !== chart.timeframe && <Tag>{template.timeframe}</Tag>}
                    </span>
                    <span className="panel-sub">{templateSummary(template)}</span>
                  </div>
                  <div className="row tight">
                    <button type="button" className="button sm primary" onClick={() => apply(template)}>
                      Apply
                    </button>
                    <button
                      type="button"
                      className="button ghost sm"
                      aria-label={`Delete template ${template.name}`}
                      title={`Delete ${template.name}`}
                      onClick={() => void actions.deleteChartTemplate(template.id)}
                    >
                      <Trash size={13} aria-hidden />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <span className="field-hint">
          Applying a template replaces this panel&apos;s indicator set. Drawings on the chart are preserved, and applying
          a template is not part of drawing undo history.
        </span>
      </div>
    </Modal>
  );
}
