import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { DownloadSimple, FloppyDisk, Plus, Trash } from '@phosphor-icons/react';
import type { ScreenerDefinition, ScreenerField, ScreenerFilter, ScreenerOperator } from '../domain/types';
import { useStore } from '../state/store';
import { datasetViews } from '../state/selectors';
import { evaluateScreener } from '../lib/screener/evaluate';
import { defaultFieldWindow, resolveSortWindow } from '../lib/screener/fields';
import { createScreenerDefinition } from '../state/defaults';
import { createId } from '../lib/id';
import { planDatasetActivation } from '../lib/workspace/dataset-activation';
import { downloadTextFile } from '../lib/export/download';
import { screenerToCsv } from '../lib/export/csv';
import { formatPercent, formatPrice } from '../lib/format';
import { EmptyState, Field, NumberInput, Panel, Select, Tag, TextInput } from '../components/ui';
import { GetStartedPanel } from '../components/data/GetStartedPanel';

const FIELD_OPTIONS: Array<{ value: ScreenerField; label: string; unit: 'pct' | 'level' | 'ratio' }> = [
  { value: 'return', label: 'Return over window', unit: 'pct' },
  { value: 'price-vs-sma', label: 'Price vs SMA', unit: 'pct' },
  { value: 'price-vs-ema', label: 'Price vs EMA', unit: 'pct' },
  { value: 'rsi', label: 'RSI', unit: 'level' },
  { value: 'volatility', label: 'Annualised volatility', unit: 'pct' },
  { value: 'max-drawdown', label: 'Max drawdown in window', unit: 'pct' },
  { value: 'relative-volume', label: 'Relative volume', unit: 'ratio' },
  { value: 'close', label: 'Last close', unit: 'level' },
];

const OPERATOR_OPTIONS: Array<{ value: ScreenerOperator; label: string }> = [
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'at least' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'at most' },
  { value: 'crosses-above', label: 'crossed above' },
  { value: 'crosses-below', label: 'crossed below' },
];

export function ScreenerPage() {
  const { state, actions } = useStore();
  const navigate = useNavigate();
  const views = useMemo(() => datasetViews(state), [state]);
  const [draft, setDraft] = useState<ScreenerDefinition | null>(null);
  const [selectedSavedId, setSelectedSavedId] = useState<string>('');

  const selectedSaved = state.screeners.find((entry) => entry.id === selectedSavedId) ?? null;
  const definition = draft ?? selectedSaved;
  const definitionIsSaved = definition !== null && state.screeners.some((entry) => entry.id === definition.id);

  const result = useMemo(() => {
    if (!definition) return null;
    const inputs = views
      .filter((view) => definition.universeDatasetIds.includes(view.dataset.id))
      .map((view) => ({ dataset: view.dataset, instrument: view.instrument ?? {
        id: view.dataset.instrumentId,
        symbol: view.dataset.name,
        displayName: view.dataset.name,
        assetType: 'other' as const,
        currency: 'USD',
      }, bars: view.bars }));
    return evaluateScreener(definition, inputs);
  }, [definition, views]);

  const startNew = () => {
    const created = createScreenerDefinition(views.map((view) => view.dataset.id));
    setDraft(created);
    setSelectedSavedId('');
  };

  // A screen needs a universe of stored series; without any, there is nothing
  // to screen and the controls would only offer empty selections.
  if (views.length === 0) {
    return (
      <div className="page">
        <GetStartedPanel title="No market data to screen" />
      </div>
    );
  }

  const updateDraft = (updater: (current: ScreenerDefinition) => ScreenerDefinition) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const updateFilter = (filterId: string, updater: (filter: ScreenerFilter) => ScreenerFilter) => {
    updateDraft((current) => ({ ...current, filters: current.filters.map((filter) => (filter.id === filterId ? updater(filter) : filter)) }));
  };

  // Clone a saved definition into the editable draft. Arrays are copied so the
  // editor never mutates the stored record in place.
  const editSaved = () => {
    if (!selectedSaved) return;
    setDraft({
      ...selectedSaved,
      universeDatasetIds: [...selectedSaved.universeDatasetIds],
      filters: selectedSaved.filters.map((filter) => ({ ...filter })),
      combinators: [...selectedSaved.combinators],
    });
  };

  const removeFilter = (filterId: string) => {
    updateDraft((current) => {
      const index = current.filters.findIndex((filter) => filter.id === filterId);
      if (index === -1) return current;
      // combinators[i] joins filters[i] and filters[i + 1]. Removing a filter
      // must remove the operator that used to precede it so the remaining rows
      // stay aligned.
      const combinators = [...current.combinators];
      if (combinators.length > 0) combinators.splice(index === 0 ? 0 : index - 1, 1);
      return { ...current, filters: current.filters.filter((filter) => filter.id !== filterId), combinators };
    });
  };

  /**
   * Carry a screened instrument into the research workflow. The dataset is
   * already stored, so this only re-points the first chart of the active
   * workspace and switches to it: no new import, and no change to the screen
   * definition or its cutoff. A dataset that is already on screen has its
   * workspace activated instead, so the panel is not re-pointed at itself and
   * no duplicate is created. The command palette uses the same rule.
   */
  const openInChart = (datasetId: string, instrumentId: string) => {
    const plan = planDatasetActivation({
      workspaces: state.workspaces,
      activeWorkspaceId: state.activeWorkspaceId,
      datasetId,
      knownDatasetIds: new Set(state.datasets.map((entry) => entry.id)),
    });
    if (plan.kind === 'unavailable') return;
    void actions.setActiveWorkspace(plan.workspaceId);
    if (plan.kind === 'repoint-chart') {
      void actions.updateChart(plan.workspaceId, plan.chartId, (config) => ({ ...config, datasetId, instrumentId }));
    }
    navigate('/chart');
  };

  return (
    <div className="page">
      <Panel
        title="Screen definition"
        subtitle="Filters run against the stored daily bars at the chosen cutoff"
        actions={
          <div className="row tight">
            <Select
              ariaLabel="Saved screens"
              value={selectedSavedId}
              onChange={(value) => {
                setSelectedSavedId(value);
                setDraft(null);
              }}
              options={[{ value: '', label: 'Saved screens' }, ...state.screeners.map((entry) => ({ value: entry.id, label: entry.name }))]}
            />
            <button type="button" className="button sm" onClick={startNew}>
              <Plus size={13} aria-hidden />
              New screen
            </button>
            {selectedSaved && !draft && (
              <button type="button" className="button sm" onClick={editSaved}>
                Edit
              </button>
            )}
            {definition && draft && (
              <button
                type="button"
                className="button sm primary"
                onClick={() => {
                  void actions.saveScreener(draft);
                  setSelectedSavedId(draft.id);
                }}
              >
                <FloppyDisk size={13} aria-hidden />
                Save
              </button>
            )}
            {definition && (
              <button
                type="button"
                className="button sm"
                disabled={!result}
                onClick={() => {
                  if (!definition || !result) return;
                  const fields = definition.filters.map((filter) => filter.field);
                  downloadTextFile(
                    `marketlab-screen-${definition.name.replace(/\s+/g, '-').toLowerCase()}.csv`,
                    screenerToCsv(result.rows, fields),
                    'text/csv',
                  );
                }}
              >
                <DownloadSimple size={13} aria-hidden />
                Export
              </button>
            )}
            {definitionIsSaved && definition && (
              <button
                type="button"
                className="button sm danger"
                onClick={() => {
                  void actions.deleteScreener(definition.id);
                  setDraft(null);
                  setSelectedSavedId('');
                }}
              >
                Delete
              </button>
            )}
            {draft && (
              <button type="button" className="button sm ghost" onClick={() => setDraft(null)}>
                Discard changes
              </button>
            )}
          </div>
        }
      >
        {!definition ? (
          <EmptyState
            title="No screen selected"
            body="Choose a saved screen, or start a new one. A screen is a set of numeric filters combined with AND/OR."
            action={
              <button type="button" className="button primary" onClick={startNew}>
                Start a new screen
              </button>
            }
          />
        ) : (
          <div className="stack">
            <div className="grid-4">
              <Field label="Screen name">
                <TextInput
                  value={definition.name}
                  disabled={!draft}
                  onChange={(value) => updateDraft((current) => ({ ...current, name: value }))}
                />
              </Field>
              <Field label="Cutoff date" hint="Only sessions up to and including this date are used.">
                <TextInput
                  type="date"
                  value={definition.cutoff ?? ''}
                  disabled={!draft}
                  onChange={(value) => updateDraft((current) => ({ ...current, cutoff: value === '' ? null : value }))}
                />
              </Field>
              <Field label="Sort by">
                <Select
                  value={definition.sortBy}
                  onChange={(value) =>
                    updateDraft((current) => ({
                      ...current,
                      sortBy: value,
                      sortWindow:
                        value === 'symbol'
                          ? current.sortWindow
                          : defaultFieldWindow(value as ScreenerField),
                    }))
                  }
                  options={[
                    { value: 'symbol', label: 'Symbol' },
                    ...FIELD_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
                  ]}
                />
              </Field>
              <Field label="Direction">
                <Select
                  value={definition.sortDirection}
                  onChange={(value) => updateDraft((current) => ({ ...current, sortDirection: value as 'asc' | 'desc' }))}
                  options={[
                    { value: 'desc', label: 'Descending' },
                    { value: 'asc', label: 'Ascending' },
                  ]}
                />
              </Field>
              <Field label="Sort window" hint="Sessions used for the sort value. Filters keep their own windows.">
                <NumberInput
                  value={resolveSortWindow(definition.sortBy, definition.sortWindow)}
                  min={1}
                  max={500}
                  step={1}
                  disabled={!draft || definition.sortBy === 'symbol'}
                  onChange={(value) =>
                    updateDraft((current) => ({
                      ...current,
                      sortWindow: Number.isFinite(value) ? Math.min(500, Math.max(1, Math.round(value))) : 20,
                    }))
                  }
                />
              </Field>
            </div>

            <div className="divider" />

            <div className="stack">
              <span className="field-label">Universe</span>
              <div className="row">
                {views.map((view) => (
                  <label key={view.dataset.id} className="row tight">
                    <input
                      type="checkbox"
                      disabled={!draft}
                      checked={definition.universeDatasetIds.includes(view.dataset.id)}
                      onChange={() =>
                        updateDraft((current) => ({
                          ...current,
                          universeDatasetIds: current.universeDatasetIds.includes(view.dataset.id)
                            ? current.universeDatasetIds.filter((id) => id !== view.dataset.id)
                            : [...current.universeDatasetIds, view.dataset.id],
                        }))
                      }
                    />
                    <span className="field-label">{view.instrument?.symbol ?? view.dataset.name}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="divider" />

            <div className="stack">
              <span className="field-label">Filters</span>
              {definition.filters.map((filter, index) => (
                <div key={filter.id} className="stack">
                  {index > 0 && (
                    <div className="row tight">
                      <Select
                        value={definition.combinators[index - 1] ?? 'AND'}
                        disabled={!draft}
                        onChange={(value) =>
                          updateDraft((current) => {
                            const combinators = [...current.combinators];
                            combinators[index - 1] = value as 'AND' | 'OR';
                            return { ...current, combinators };
                          })
                        }
                        options={[
                          { value: 'AND', label: 'AND' },
                          { value: 'OR', label: 'OR' },
                        ]}
                      />
                      <span className="field-hint">joins the previous filter with this one</span>
                    </div>
                  )}
                  <div className="rule-row">
                    <Field label="Field">
                      <Select
                        value={filter.field}
                        disabled={!draft}
                        onChange={(value) => updateFilter(filter.id, (current) => ({ ...current, field: value }))}
                        options={FIELD_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                      />
                    </Field>
                    <Field label="Operator">
                      <Select
                        value={filter.operator}
                        disabled={!draft}
                        onChange={(value) => updateFilter(filter.id, (current) => ({ ...current, operator: value }))}
                        options={OPERATOR_OPTIONS}
                      />
                    </Field>
                    <Field label="Value">
                      <NumberInput
                        value={filter.value}
                        step={0.1}
                        disabled={!draft}
                        onChange={(value) => updateFilter(filter.id, (current) => ({ ...current, value: Number.isFinite(value) ? value : 0 }))}
                      />
                    </Field>
                    <Field label="Window">
                      <NumberInput
                        value={filter.window}
                        min={1}
                        max={500}
                        step={1}
                        disabled={!draft}
                        onChange={(value) => updateFilter(filter.id, (current) => ({ ...current, window: Number.isFinite(value) ? Math.max(1, Math.round(value)) : 20 }))}
                      />
                    </Field>
                    <button
                      type="button"
                      className="button ghost sm"
                      disabled={!draft || definition.filters.length <= 1}
                      aria-label="Remove filter"
                      onClick={() => removeFilter(filter.id)}
                    >
                      <Trash size={13} aria-hidden />
                    </button>
                  </div>
                </div>
              ))}
              <div className="row">
                <button
                  type="button"
                  className="button sm"
                  disabled={!draft}
                  onClick={() =>
                    updateDraft((current) => ({
                      ...current,
                      filters: [...current.filters, { id: createId('flt'), field: 'rsi', operator: 'lt', value: 30, window: 14 }],
                    }))
                  }
                >
                  <Plus size={13} aria-hidden />
                  Add filter
                </button>
                <span className="field-hint">
                  A filter whose field cannot be computed for a series is treated as not matched, never as matched by default.
                </span>
              </div>
            </div>
          </div>
        )}
      </Panel>

      {definition && result && (
        <Panel
          title="Results"
          subtitle={`${result.matchedCount} of ${result.evaluatedCount} series matched · ${
            definition.sortBy === 'symbol'
              ? `sorted by symbol (${definition.sortDirection === 'asc' ? 'ascending' : 'descending'})`
              : `sorted by ${fieldLabel(definition.sortBy as ScreenerField)} (${resolveSortWindow(definition.sortBy, definition.sortWindow)} sessions, ${
                  definition.sortDirection === 'asc' ? 'ascending' : 'descending'
                })`
          }`}
          flush
        >
          {result.rows.length === 0 ? (
            <EmptyState title="Empty universe" body="Select at least one dataset in the universe list." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Name</th>
                    <th>As of</th>
                    {definition.filters.map((filter) => (
                      <th key={filter.id} className="num" title={FIELD_OPTIONS.find((option) => option.value === filter.field)?.label}>
                        {`${fieldLabel(filter.field)} (${filter.window})`}
                      </th>
                    ))}
                    <th>Matched</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr key={row.datasetId} className={row.passed ? '' : 'dim'}>
                      <td>
                        <button
                          type="button"
                          className="button ghost sm"
                          title="Open in the chart workspace"
                          onClick={() => openInChart(row.datasetId, row.instrumentId)}
                        >
                          {row.symbol}
                        </button>
                      </td>
                      <td>{row.displayName}</td>
                      <td className="mono">{row.asOf ?? '--'}</td>
                      {definition.filters.map((filter) => (
                        <td key={filter.id} className="num">
                          {renderFieldValue(filter.field, row.values[filter.field])}
                        </td>
                      ))}
                      <td>{row.passed ? <Tag tone="accent">Match</Tag> : <span className="faint">No</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      <Panel title="How the fields are computed">
        <ul className="list-reset stack field-hint">
          <li>Return over window: percent change between the close `window` sessions back and the cutoff close.</li>
          <li>Price vs SMA/EMA: percent distance of the close from a moving average of the given period.</li>
          <li>RSI: Wilder's relative strength index on closes over the given period; 0 to 100.</li>
          <li>Annualised volatility: sample standard deviation of session returns in the window, annualised at the dataset frequency (square root of 252 daily, 52 weekly or 12 monthly sessions per year).</li>
          <li>Max drawdown in window: worst close-to-close drawdown inside the window only.</li>
          <li>Relative volume: volume divided by the average volume of the window. Unavailable when the series has no volume.</li>
          <li>&quot;Crossed above&quot; and &quot;crossed below&quot; compare the value now against the threshold and the previous session, so a single touch does not qualify.</li>
          <li>
            <Link to="/learn?section=screening">Read how the cutoff and missing fields work</Link>
          </li>
        </ul>
      </Panel>
    </div>
  );
}

function fieldLabel(field: ScreenerField): string {
  return FIELD_OPTIONS.find((option) => option.value === field)?.label ?? field;
}

function renderFieldValue(field: ScreenerField, value: number | null | undefined): string {
  if (value === null || value === undefined) return '--';
  const option = FIELD_OPTIONS.find((entry) => entry.value === field);
  if (option?.unit === 'pct') return formatPercent(value);
  if (option?.unit === 'ratio') return `${value.toFixed(2)}x`;
  if (field === 'close') return formatPrice(value);
  return value.toFixed(2);
}
