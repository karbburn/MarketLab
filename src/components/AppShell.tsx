import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ChartLineUp,
  SquaresFour,
  Flask,
  FunnelSimple,
  PlayCircle,
  Database,
  Stack,
  Sun,
  Moon,
  UploadSimple,
  CloudArrowDown,
  List,
  X,
} from '@phosphor-icons/react';
import { useStore } from '../state/store';
import { Toaster } from './ui';
import { datasetViews, hasSyntheticData } from '../state/selectors';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { ImportDialog } from './data/ImportDialog';
import { DownloadDialog } from './data/DownloadDialog';
import { BulkDownloadDialog } from './data/BulkDownloadDialog';
import { BULK_DOWNLOAD_DATA_EVENT, DOWNLOAD_DATA_EVENT, IMPORT_DATA_EVENT } from '../lib/ui-events';

interface NavEntry {
  to: string;
  label: string;
  icon: typeof ChartLineUp;
  end?: boolean;
}

const NAV_GROUPS: Array<{ label: string; entries: NavEntry[] }> = [
  {
    label: 'Terminal',
    entries: [
      { to: '/', label: 'Overview', icon: SquaresFour, end: true },
      { to: '/chart', label: 'Chart workspace', icon: ChartLineUp },
    ],
  },
  {
    label: 'Research',
    entries: [
      { to: '/quant', label: 'Quant lab', icon: Flask },
      { to: '/screener', label: 'Screener', icon: FunnelSimple },
      { to: '/backtest', label: 'Backtest', icon: PlayCircle },
    ],
  },
  {
    label: 'Library',
    entries: [
      { to: '/data', label: 'Data', icon: Database },
      { to: '/workspaces', label: 'Workspaces', icon: Stack },
    ],
  },
];

const TITLES: Record<string, string> = {
  '/': 'Overview',
  '/chart': 'Chart workspace',
  '/quant': 'Quant lab',
  '/screener': 'Historical screener',
  '/backtest': 'Rule-based backtest',
  '/data': 'Data library',
  '/workspaces': 'Workspaces and settings',
};

// Below this width the sidebar becomes an off-canvas drawer; above it the
// sidebar is docked and the same control collapses it instead.
const NARROW_NAV_QUERY = '(max-width: 900px)';

function subscribeToNarrowNav(onStoreChange: () => void) {
  const query = window.matchMedia(NARROW_NAV_QUERY);
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
}

function getNarrowNavSnapshot() {
  return window.matchMedia(NARROW_NAV_QUERY).matches;
}

function useNarrowNav() {
  return useSyncExternalStore(subscribeToNarrowNav, getNarrowNavSnapshot);
}

export function AppShell() {
  const { state, actions } = useStore();
  const location = useLocation();
  const [importOpen, setImportOpen] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [bulkDownloadOpen, setBulkDownloadOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(false);
  const narrow = useNarrowNav();

  const views = datasetViews(state);
  const synthetic = hasSyntheticData(state);
  const title = TITLES[location.pathname] ?? 'MarketLab';

  // One control, two layouts: on narrow viewports it opens the drawer, on wide
  // viewports it collapses the docked sidebar.
  const navExpanded = narrow ? navOpen : !navCollapsed;
  const navToggleLabel = navExpanded
    ? narrow
      ? 'Close navigation'
      : 'Collapse navigation'
    : narrow
      ? 'Open navigation'
      : 'Expand navigation';
  const shellClassName = ['shell', navOpen ? 'nav-open' : '', navCollapsed ? 'nav-collapsed' : '']
    .filter(Boolean)
    .join(' ');

  // The pages inside the shell ask for the import and download dialogs
  // through the event bus, so the dialogs can live in one place.
  useEffect(() => {
    const onImport = () => setImportOpen(true);
    const onDownload = () => setDownloadOpen(true);
    const onBulkDownload = () => setBulkDownloadOpen(true);
    window.addEventListener(IMPORT_DATA_EVENT, onImport);
    window.addEventListener(DOWNLOAD_DATA_EVENT, onDownload);
    window.addEventListener(BULK_DOWNLOAD_DATA_EVENT, onBulkDownload);
    return () => {
      window.removeEventListener(IMPORT_DATA_EVENT, onImport);
      window.removeEventListener(DOWNLOAD_DATA_EVENT, onDownload);
      window.removeEventListener(BULK_DOWNLOAD_DATA_EVENT, onBulkDownload);
    };
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  return (
    <div className={shellClassName}>
      {navOpen && (
        <button
          type="button"
          className="shell-scrim"
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
        />
      )}
      <nav id="primary-nav" className={navOpen ? 'shell-nav open' : 'shell-nav'} aria-label="Primary">
        <div className="shell-brand">
          <span className="shell-brand-mark" aria-hidden>
            ML
          </span>
          <div style={{ display: 'grid' }}>
            <span className="shell-brand-name">MarketLab</span>
            <span className="shell-brand-sub">Local terminal</span>
          </div>
        </div>

        {NAV_GROUPS.map((group) => (
          <div className="nav-group" key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            {group.entries.map((entry) => (
              <NavLink
                key={entry.to}
                to={entry.to}
                end={entry.end}
                className={({ isActive }) => (isActive ? 'nav-item active' : 'nav-item')}
                onClick={() => setNavOpen(false)}
              >
                <entry.icon size={15} weight="regular" aria-hidden />
                <span className="nav-item-label">{entry.label}</span>
              </NavLink>
            ))}
          </div>
        ))}

        <div style={{ flex: 1 }} />

        <div className="nav-group">
          <div className="nav-group-label">Data</div>
          <div className="panel-sub" style={{ padding: '0 8px 6px' }}>
            {views.length} dataset{views.length === 1 ? '' : 's'} loaded
          </div>
          {synthetic && (
            <div style={{ padding: '0 8px 6px' }}>
              <span className="tag warn">Legacy demo data</span>
            </div>
          )}
        </div>
      </nav>

      <div className="shell-main">
        <header className="topbar">
          <button
            type="button"
            className="button ghost icon shell-nav-toggle"
            aria-label={navToggleLabel}
            aria-expanded={navExpanded}
            aria-controls="primary-nav"
            title={navToggleLabel}
            onClick={() => {
              if (narrow) setNavOpen((open) => !open);
              else setNavCollapsed((collapsed) => !collapsed);
            }}
          >
            {navExpanded ? <X size={17} /> : <List size={17} />}
          </button>
          <span className="topbar-title">{title}</span>
          <span className="topbar-spacer" />
          {state.loadError && (
            <span className="tag down" title={state.loadError}>
              Local data could not be read
            </span>
          )}
          {state.adapterKind === 'memory' && <span className="tag warn">Storage unavailable: changes will not persist</span>}
          <button type="button" className="button ghost sm" aria-label="Download data" onClick={() => setDownloadOpen(true)}>
            <CloudArrowDown size={13} weight="bold" aria-hidden />
            <span className="topbar-action-label">Download data</span>
          </button>
          <button type="button" className="button sm" aria-label="Import data" onClick={() => setImportOpen(true)}>
            <UploadSimple size={13} weight="bold" aria-hidden />
            <span className="topbar-action-label">Import data</span>
          </button>
          <button
            type="button"
            className="button ghost icon"
            aria-label={state.preferences.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={state.preferences.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => void actions.setPreferences({ theme: state.preferences.theme === 'dark' ? 'light' : 'dark' })}
          >
            {state.preferences.theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </header>

        <main>
          <Outlet />
        </main>
      </div>

      <Toaster />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <DownloadDialog open={downloadOpen} onClose={() => setDownloadOpen(false)} />
      <BulkDownloadDialog open={bulkDownloadOpen} onClose={() => setBulkDownloadOpen(false)} />
    </div>
  );
}
