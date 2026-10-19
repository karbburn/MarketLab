/**
 * The global command palette.
 *
 * A keyboard-first overlay over the whole application: filter navigation,
 * safely invokable actions and the datasets already stored in the local library,
 * then open the highlighted row with Enter. It reads the palette's data from the
 * store's in-memory state - no IndexedDB reads and no network - so results are
 * always the current state of the library.
 */

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import type { SourceKind } from '../../domain/types';
import { useStore } from '../../state/store';
import { datasetViews } from '../../state/selectors';
import { APP_ROUTES } from '../../lib/navigation';
import { planPalette } from '../../lib/command-palette/search';
import type { CommandPaletteItem, DatasetPaletteItem, PaletteItem } from '../../lib/command-palette/types';
import { rememberRecentDataset, readRecentDatasetIds } from '../../lib/command-palette/recents';
import { isMacPlatform, shortcutLabel } from '../../lib/command-palette/platform';
import { planDatasetActivation } from '../../lib/workspace/dataset-activation';
import { requestBulkDownloadDialog, requestDownloadDialog, requestImportDialog } from '../../lib/ui-events';
import { downloadBackupFile } from '../../lib/export/backup-file';
import { Tag } from '../ui';

const SOURCE_TAGS: Record<SourceKind, { label: string; tone?: 'accent' | 'warn' }> = {
  'user-csv': { label: 'CSV' },
  'provider-download': { label: 'Download', tone: 'accent' },
  'bundled-sample': { label: 'Legacy sample', tone: 'warn' },
};

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { state, actions } = useStore();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<readonly string[]>(() => readRecentDatasetIds());

  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  // Keep the latest close callback without re-running the mount effect (which
  // would steal focus back on every parent render).
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // The palette is mounted only while it is open, so the library is read here
  // and never contributes to the rest of the shell's render path.
  const views = useMemo(() => datasetViews(state), [state]);

  const datasetItems = useMemo<DatasetPaletteItem[]>(
    () =>
      views.map((view) => {
        const source = SOURCE_TAGS[view.dataset.sourceKind];
        return {
          id: `dataset:${view.dataset.id}`,
          kind: 'dataset',
          group: 'datasets',
          label: view.instrument?.symbol ?? view.dataset.name,
          detail: view.instrument?.displayName ?? view.dataset.name,
          meta: `${view.dataset.frequency} · ${view.dataset.rowCount.toLocaleString('en-US')} sessions`,
          tag: source.label,
          tagTone: source.tone,
          names: [view.instrument?.displayName ?? '', view.dataset.name].filter((entry) => entry.length > 0),
          keywords: [
            view.dataset.frequency,
            view.dataset.sourceKind,
            view.instrument?.assetType ?? '',
            view.dataset.provider?.providerSymbol ?? '',
          ].filter((entry) => entry.length > 0),
          datasetId: view.dataset.id,
          instrumentId: view.instrument?.id ?? view.dataset.instrumentId,
        };
      }),
    [views],
  );

  const commandItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = APP_ROUTES.map((route) => ({
      id: `nav:${route.path}`,
      kind: 'command',
      group: 'navigation',
      label: route.label,
      detail: route.title === route.label ? undefined : route.title,
      keywords: ['go to', 'open', route.path],
      run: () => navigate(route.path),
    }));

    for (const workspace of state.workspaces) {
      items.push({
        id: `workspace:${workspace.id}`,
        kind: 'command',
        group: 'navigation',
        label: `Open workspace "${workspace.name}"`,
        detail: 'Chart workspace',
        meta: `${workspace.charts.length} panel${workspace.charts.length === 1 ? '' : 's'}`,
        keywords: ['workspace', 'activate', 'open', workspace.name],
        run: () => {
          void actions.setActiveWorkspace(workspace.id);
          navigate('/chart');
        },
      });
    }

    const nextTheme = state.preferences.theme === 'dark' ? 'light' : 'dark';
    items.push(
      {
        id: 'action:import-csv',
        kind: 'command',
        group: 'actions',
        label: 'Import a CSV file',
        keywords: ['csv', 'upload', 'file', 'dataset'],
        run: () => requestImportDialog(),
      },
      {
        id: 'action:download-data',
        kind: 'command',
        group: 'actions',
        label: 'Download market data',
        keywords: ['download', 'provider', 'yahoo', 'symbol', 'data'],
        run: () => requestDownloadDialog(),
      },
      {
        id: 'action:download-many',
        kind: 'command',
        group: 'actions',
        label: 'Download many symbols',
        keywords: ['download', 'batch', 'bulk', 'provider', 'yahoo', 'symbols'],
        run: () => requestBulkDownloadDialog(),
      },
      {
        id: 'action:export-backup',
        kind: 'command',
        group: 'actions',
        label: 'Export a JSON backup',
        keywords: ['backup', 'export', 'save', 'json', 'download'],
        run: () => {
          downloadBackupFile({
            instruments: state.instruments,
            datasets: state.datasets,
            bars: Object.entries(state.barsByDataset).map(([id, bars]) => ({ id, bars })),
            workspaces: state.workspaces,
            watchlists: state.watchlists,
            preferences: state.preferences,
            screeners: state.screeners,
            backtests: state.backtests,
          });
          actions.notify('success', 'Backup file created.');
        },
      },
      {
        id: 'action:theme',
        kind: 'command',
        group: 'actions',
        label: `Switch to ${nextTheme} theme`,
        keywords: ['theme', 'appearance', 'dark', 'light', 'colours'],
        run: () => void actions.setPreferences({ theme: nextTheme }),
      },
    );

    // Mirrors the workspaces screen: the first stored series becomes the base
    // of a new single-panel workspace. Without a panel to seed it, there is no
    // command to offer.
    const firstView = views[0];
    const firstInstrument = firstView?.instrument;
    if (firstView && firstInstrument) {
      items.push({
        id: 'action:new-workspace',
        kind: 'command',
        group: 'actions',
        label: 'New single-panel workspace',
        keywords: ['workspace', 'create', 'new', 'panel'],
        run: () =>
          void actions.createWorkspaceFromBase({
            name: `Workspace ${state.workspaces.length + 1}`,
            datasetId: firstView.dataset.id,
            instrumentId: firstInstrument.id,
          }),
      });
    }

    return items;
  }, [actions, navigate, state, views]);

  // Resolve recent ids against the live library, so a deleted dataset never
  // reappears in "Recently used".
  const recentItems = useMemo<DatasetPaletteItem[]>(
    () =>
      recentIds
        .map((id) => datasetItems.find((item) => item.datasetId === id))
        .filter((item): item is DatasetPaletteItem => item !== undefined),
    [datasetItems, recentIds],
  );

  const plan = useMemo(
    () =>
      planPalette({
        query,
        librarySize: state.datasets.length,
        datasets: datasetItems,
        commands: commandItems,
        recents: recentItems,
      }),
    [commandItems, datasetItems, query, recentItems, state.datasets.length],
  );

  const flatIndex = useMemo(() => new Map(plan.flat.map((item, index) => [item.id, index])), [plan.flat]);
  const safeIndex = plan.flat.length === 0 ? -1 : Math.min(activeIndex, plan.flat.length - 1);
  const activeId = safeIndex >= 0 ? optionId(safeIndex) : undefined;
  const isMac = useMemo(() => isMacPlatform(typeof navigator === 'undefined' ? '' : navigator.platform), []);

  // Mounted means open. Remember the opener, focus the field and lock the page
  // behind the modal; unmounting undoes all three, including focus restore.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const body = document.body;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';
    inputRef.current?.focus();

    return () => {
      body.style.overflow = previousOverflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Escape and the focus trap belong to the document, so they also work while
  // the close control - not the field - holds focus.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = dialog.querySelectorAll<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const revealIndex = (index: number) => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const moveActive = (next: number) => {
    setActiveIndex(next);
    revealIndex(next);
  };

  /** Opens a stored dataset in the chart workspace, reusing an open panel. */
  const activateDataset = (item: DatasetPaletteItem) => {
    const activation = planDatasetActivation({
      workspaces: state.workspaces,
      activeWorkspaceId: state.activeWorkspaceId,
      datasetId: item.datasetId,
      knownDatasetIds: new Set(state.datasets.map((dataset) => dataset.id)),
    });
    if (activation.kind === 'unavailable') {
      actions.notify('warning', 'That dataset is no longer in the local library.');
      return;
    }
    setRecentIds(rememberRecentDataset(item.datasetId));
    onClose();
    if (activation.kind === 'activate-workspace') {
      void actions.setActiveWorkspace(activation.workspaceId);
      navigate('/chart');
      return;
    }
    void actions.setActiveWorkspace(activation.workspaceId);
    void actions.updateChart(activation.workspaceId, activation.chartId, (config) => ({
      ...config,
      datasetId: item.datasetId,
      instrumentId: item.instrumentId,
    }));
    navigate('/chart');
  };

  /** Closes first, then runs the action, so the dialog it opens keeps focus. */
  const activateItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    if (item.kind === 'dataset') {
      activateDataset(item);
      return;
    }
    const { run } = item;
    onClose();
    run();
  };

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const count = plan.flat.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (count === 0) return;
      moveActive(safeIndex < 0 ? 0 : (safeIndex + 1) % count);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (count === 0) return;
      moveActive(safeIndex <= 0 ? count - 1 : safeIndex - 1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activateItem(plan.flat[safeIndex]);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      if (count > 0) moveActive(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      if (count > 0) moveActive(count - 1);
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
      >
        <div className="palette-search">
          <MagnifyingGlass size={15} aria-hidden />
          <input
            id={`${baseId}-input`}
            ref={inputRef}
            className="palette-input"
            type="text"
            role="combobox"
            aria-expanded
            aria-controls={plan.emptyMessage === null ? listboxId : undefined}
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-label="Search views, actions and local datasets"
            placeholder="Search views, actions and datasets…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              // A new query must land on the best match, not on whatever was
              // highlighted before.
              setActiveIndex(0);
              if (listRef.current) listRef.current.scrollTop = 0;
            }}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="palette-kbd">{shortcutLabel(isMac)}</kbd>
          <button type="button" className="button ghost icon" aria-label="Close command palette" onClick={onClose}>
            <X size={14} weight="bold" />
          </button>
        </div>

        {plan.emptyMessage !== null ? (
          <div className="palette-empty">
            <span className="empty-title">{plan.emptyMessage}</span>
            <span className="empty-body">
              {state.datasets.length === 0
                ? 'Datasets come from a CSV import or a download from the local market-data service.'
                : 'Try a symbol, a view name or an action such as “import”.'}
            </span>
          </div>
        ) : (
          <div className="palette-results" id={listboxId} role="listbox" aria-label="Command palette results" ref={listRef}>
            {plan.sections.map((section) => (
              <div className="palette-group" role="group" aria-label={section.title} key={section.group}>
                <div className="palette-group-title" role="presentation">
                  {section.title}
                </div>
                {section.note !== undefined && (
                  <div className="palette-note" role="presentation">
                    {section.note}
                  </div>
                )}
                {section.items.map((item) => {
                  const index = flatIndex.get(item.id) ?? -1;
                  const selected = index === safeIndex;
                  return (
                    <div
                      key={item.id}
                      id={optionId(index)}
                      data-index={index}
                      className="palette-option"
                      role="option"
                      aria-selected={selected}
                      onClick={() => activateItem(item)}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span className={item.kind === 'dataset' ? 'palette-option-label mono' : 'palette-option-label'}>
                        {item.label}
                      </span>
                      {item.kind === 'dataset' && item.tag !== undefined && (
                        <Tag tone={item.tagTone}>{item.tag}</Tag>
                      )}
                      <span className="palette-option-detail">{item.detail ?? ''}</span>
                      {item.meta !== undefined && <span className="palette-option-meta">{item.meta}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
            {plan.commandsNote !== null && (
              <div className="palette-note" role="presentation">
                {plan.commandsNote}
              </div>
            )}
          </div>
        )}

        <footer className="palette-foot">
          <span className="palette-hint">
            <kbd className="palette-kbd">↑</kbd>
            <kbd className="palette-kbd">↓</kbd> Navigate
          </span>
          <span className="palette-hint">
            <kbd className="palette-kbd">↵</kbd> Select
          </span>
          <span className="palette-hint">
            <kbd className="palette-kbd">Esc</kbd> Close
          </span>
          <span className="palette-foot-spacer" />
          <span className="palette-hint">
            {state.datasets.length} dataset{state.datasets.length === 1 ? '' : 's'} in the local library
          </span>
        </footer>
      </div>
    </div>
  );
}
