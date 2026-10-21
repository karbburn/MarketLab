import { useMemo, useRef, useState } from 'react';
import { ArrowCounterClockwise, DownloadSimple, FloppyDisk, Plus, Trash, UploadSimple } from '@phosphor-icons/react';
import { useStore } from '../state/store';
import { datasetViews } from '../state/selectors';
import { parseBackup } from '../lib/export/backup';
import { downloadBackupFile } from '../lib/export/backup-file';
import { readFileAsText } from '../lib/export/download';
import { WORKSPACE_LAYOUTS, chartCountForLayout } from '../state/defaults';
import { CHART_TYPE_OPTIONS } from '../lib/chartTypes';
import { EmptyState, Field, Panel, Segmented, Select, Switch, Tag, TextInput } from '../components/ui';

export function WorkspacesPage() {
  const { state, actions } = useStore();
  const views = useMemo(() => datasetViews(state), [state]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [pendingBackup, setPendingBackup] = useState<{ text: string; summary: string } | null>(null);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [confirmReset, setConfirmReset] = useState(false);
  const [applying, setApplying] = useState(false);
  // A ref guards the same tick in which the disabled state has not rendered yet.
  const applyingRef = useRef(false);

  const exportBackup = () => {
    downloadBackupFile({
      instruments: state.instruments,
      datasets: state.datasets,
      bars: Object.entries(state.barsByDataset).map(([id, bars]) => ({ id, bars })),
      workspaces: state.workspaces,
      watchlists: state.watchlists,
      preferences: state.preferences,
      screeners: state.screeners,
      backtests: state.backtests,
      chartTemplates: state.chartTemplates,
    });
    actions.notify('success', 'Backup file created.');
  };

  const onPickFile = async (file: File) => {
    try {
      const text = await readFileAsText(file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        actions.notify('error', 'That file is not valid JSON.');
        return;
      }
      const result = parseBackup(parsed);
      if (!result.ok) {
        actions.notify('error', result.error);
        return;
      }
      const skippedNote = result.skipped.length > 0 ? ` ${result.skipped.length} entr${result.skipped.length === 1 ? 'y' : 'ies'} will be skipped.` : '';
      setPendingBackup({
        text,
        summary: `${result.value.datasets.length} dataset(s), ${result.value.workspaces.length} workspace(s), ${result.value.bars.reduce((total, entry) => total + entry.bars.length, 0).toLocaleString('en-US')} sessions.${skippedNote}`,
      });
    } catch (readError) {
      actions.notify('error', readError instanceof Error ? readError.message : 'The backup file could not be read.');
    }
  };

  const applyPending = async () => {
    // A restore clears and rewrites several stores; a second submission would
    // run that destructive loop twice, so the first one owns the operation.
    if (!pendingBackup || applyingRef.current) return;
    applyingRef.current = true;
    setApplying(true);
    try {
      const parsed = parseBackup(JSON.parse(pendingBackup.text));
      if (!parsed.ok) {
        actions.notify('error', parsed.error);
        return;
      }
      await actions.restoreBackup(parsed.value, importMode);
      setPendingBackup(null);
    } catch (restoreError) {
      actions.notify('error', restoreError instanceof Error ? restoreError.message : 'The backup could not be restored.');
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };

  return (
    <div className="page">
      <Panel title="Workspaces" subtitle={`${state.workspaces.length} saved`} flush>
        {state.workspaces.length === 0 ? (
          <EmptyState title="No workspaces" body="Download or import market data, then create a workspace from the chart page." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Layout</th>
                  <th className="num">Panels</th>
                  <th className="num">Indicators</th>
                  <th className="num">Drawings</th>
                  <th>Links</th>
                  <th>Updated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.workspaces.map((workspace) => {
                  const indicators = workspace.charts.reduce((total, chart) => total + chart.indicators.length, 0);
                  const drawings = workspace.charts.reduce((total, chart) => total + chart.drawings.length, 0);
                  const isActive = workspace.id === state.activeWorkspaceId;
                  return (
                    <tr key={workspace.id}>
                      <td>
                        {renameId === workspace.id ? (
                          <div className="row tight">
                            <TextInput ariaLabel="Workspace name" value={renameDraft} onChange={setRenameDraft} />
                            <button
                              type="button"
                              className="button sm primary"
                              onClick={() => {
                                void actions.updateWorkspace(workspace.id, (current) => ({ ...current, name: renameDraft.trim() || current.name }));
                                setRenameId(null);
                              }}
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="button ghost sm"
                            onClick={() => {
                              setRenameId(workspace.id);
                              setRenameDraft(workspace.name);
                            }}
                          >
                            {workspace.name}
                          </button>
                        )}
                      </td>
                      <td className="muted">{WORKSPACE_LAYOUTS.find((layout) => layout.id === workspace.layout)?.label ?? workspace.layout}</td>
                      <td className="num">
                        {chartCountForLayout(workspace.layout)} / {workspace.charts.length}
                      </td>
                      <td className="num">{indicators}</td>
                      <td className="num">{drawings}</td>
                      <td className="muted">
                        {workspace.linkGroups[0]?.properties.filter((property) => property !== 'crosshair').join(', ') || 'none'}
                      </td>
                      <td className="mono faint">{workspace.updatedAt.slice(0, 16).replace('T', ' ')}</td>
                      <td>
                        <div className="row tight">
                          {isActive ? (
                            <Tag tone="accent">Active</Tag>
                          ) : (
                            <button type="button" className="button sm" onClick={() => void actions.setActiveWorkspace(workspace.id)}>
                              Activate
                            </button>
                          )}
                          <button
                            type="button"
                            className="button sm ghost"
                            disabled={state.workspaces.length <= 1}
                            onClick={() => void actions.deleteWorkspace(workspace.id)}
                            aria-label={`Delete ${workspace.name}`}
                          >
                            <Trash size={12} aria-hidden />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="panel-foot" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <button
            type="button"
            className="button sm"
            disabled={views.length === 0}
            onClick={() => {
              const first = views[0];
              if (first?.instrument) {
                void actions.createWorkspaceFromBase({
                  name: `Workspace ${state.workspaces.length + 1}`,
                  datasetId: first.dataset.id,
                  instrumentId: first.instrument.id,
                });
              }
            }}
          >
            <Plus size={13} aria-hidden />
            New single-panel workspace
          </button>
          <span className="field-hint">New workspaces start from the first dataset with your default chart preferences.</span>
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="Watchlists" subtitle={`${state.watchlists.length} saved`}>
          <div className="stack">
            {state.watchlists.length === 0 && <span className="field-hint">No watchlists yet.</span>}
            {state.watchlists.map((watchlist) => (
              <div key={watchlist.id} className="spread">
                <div style={{ display: 'grid' }}>
                  <span>{watchlist.name}</span>
                  <span className="panel-sub">{watchlist.instrumentIds.length} instrument(s)</span>
                </div>
                <div className="row tight">
                  <button
                    type="button"
                    className="button ghost sm"
                    onClick={() => {
                      const activeId = state.activeWorkspaceId ?? state.workspaces[0]?.id;
                      if (activeId) void actions.updateWorkspace(activeId, (current) => ({ ...current, activeWatchlistId: watchlist.id }));
                    }}
                  >
                    Use on charts
                  </button>
                  <button type="button" className="button ghost sm" aria-label={`Delete ${watchlist.name}`} onClick={() => void actions.deleteWatchlist(watchlist.id)}>
                    <Trash size={12} aria-hidden />
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="button sm"
              onClick={() => void actions.createWatchlistNamed(`Watchlist ${state.watchlists.length + 1}`, [])}
            >
              <Plus size={13} aria-hidden />
              New watchlist
            </button>
          </div>
        </Panel>

        <Panel title="Preferences">
          <div className="stack">
            <Field label="Theme">
              <Segmented
                label="Theme"
                value={state.preferences.theme}
                onChange={(value) => void actions.setPreferences({ theme: value })}
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                ]}
              />
            </Field>
            <Field label="Default chart type">
              <Select
                value={state.preferences.defaultChartType}
                onChange={(value) => void actions.setPreferences({ defaultChartType: value })}
                options={CHART_TYPE_OPTIONS}
              />
            </Field>
            <Field label="Default timeframe">
              <Select
                value={state.preferences.defaultTimeframe}
                onChange={(value) => void actions.setPreferences({ defaultTimeframe: value })}
                options={[
                  { value: '1D', label: 'Daily' },
                  { value: '1W', label: 'Weekly' },
                  { value: '1M', label: 'Monthly' },
                ]}
              />
            </Field>
            <Switch
              checked={state.preferences.showVolumeByDefault}
              label="Show the volume pane on new charts"
              onChange={(checked) => void actions.setPreferences({ showVolumeByDefault: checked })}
            />
            <Field label="Default workspace">
              <Select
                value={state.preferences.defaultWorkspaceId ?? ''}
                onChange={(value) => {
                  void actions.setPreferences({ defaultWorkspaceId: value === '' ? null : value });
                  if (value) void actions.setActiveWorkspace(value);
                }}
                options={[{ value: '', label: 'Most recent' }, ...state.workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))]}
              />
            </Field>
          </div>
        </Panel>
      </div>

      <Panel title="Backup and restore" subtitle="Workspaces, drawings, indicators, datasets and saved research in one JSON file">
        <div className="stack">
          <div className="row">
            <button type="button" className="button primary" onClick={exportBackup}>
              <DownloadSimple size={13} aria-hidden />
              Export backup
            </button>
            <button type="button" className="button" onClick={() => fileInputRef.current?.click()}>
              <UploadSimple size={13} aria-hidden />
              Choose a backup file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="visually-hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void onPickFile(file);
                event.target.value = '';
              }}
            />
            <span className="field-hint">
              Storage backend: {state.adapterKind === 'indexeddb' ? 'IndexedDB (persists across reloads)' : 'in memory (this session only)'}
            </span>
          </div>

          {pendingBackup && (
            <div className="panel" style={{ borderColor: 'var(--border-strong)' }}>
              <div className="panel-head">
                <span className="panel-title">Confirm restore</span>
                <div style={{ flex: 1 }} />
                <Tag tone="warn">Not applied yet</Tag>
              </div>
              <div className="panel-body stack">
                <span className="panel-sub">{pendingBackup.summary}</span>
                <Field label="Restore mode">
                  <Select
                    value={importMode}
                    onChange={(value) => setImportMode(value)}
                    options={[
                      { value: 'merge', label: 'Merge into existing data (recommended)' },
                      { value: 'replace', label: 'Replace all local data' },
                    ]}
                  />
                </Field>
                <span className="field-hint">
                  Merging keeps your current datasets and overwrites any record that shares an id with the backup. Replacing
                  clears local instruments, datasets, workspaces, watchlists, screens and strategies first.
                </span>
                <div className="row tight">
                  <button type="button" className="button primary" disabled={applying} onClick={() => void applyPending()}>
                    {applying ? 'Applying…' : 'Apply restore'}
                  </button>
                  <button type="button" className="button ghost" disabled={applying} onClick={() => setPendingBackup(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Local data" subtitle="Everything lives on this device. Nothing is uploaded or sent to a service.">
        <div className="stack">
          <div className="row">
            <span className="field-hint">
              {state.datasets.length} dataset(s), {state.instruments.length} instrument(s), {state.workspaces.length} workspace(s),{' '}
              {state.screeners.length} screen(s), {state.backtests.length} strateg{state.backtests.length === 1 ? 'y' : 'ies'}.
            </span>
          </div>
          {confirmReset ? (
            <div className="row">
              <Tag tone="down">This clears local data</Tag>
              <button
                type="button"
                className="button danger"
                onClick={() => {
                  void actions.resetAll();
                  setConfirmReset(false);
                }}
              >
                <ArrowCounterClockwise size={13} aria-hidden />
                Yes, delete all local data
              </button>
              <button type="button" className="button ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="row">
              <button type="button" className="button" onClick={() => setConfirmReset(true)}>
                <FloppyDisk size={13} aria-hidden />
                Delete all local data
              </button>
              <span className="field-hint">Export a backup first if you want to keep anything.</span>
            </div>
          )}
        </div>
      </Panel>
    </div>
  );
}
