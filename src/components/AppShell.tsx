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
} from '@phosphor-icons/react';
import { useStore } from '../state/store';
import { Toaster } from './ui';
import { datasetViews, hasSyntheticData } from '../state/selectors';
import { useState } from 'react';
import { ImportDialog } from './data/ImportDialog';

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

export function AppShell() {
  const { state, actions } = useStore();
  const location = useLocation();
  const [importOpen, setImportOpen] = useState(false);

  const views = datasetViews(state);
  const synthetic = hasSyntheticData(state);
  const title = TITLES[location.pathname] ?? 'MarketLab';

  return (
    <div className="shell">
      <nav className="shell-nav" aria-label="Primary">
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
              <span className="tag warn">Synthetic sample</span>
            </div>
          )}
        </div>
      </nav>

      <div className="shell-main">
        <header className="topbar">
          <span className="topbar-title">{title}</span>
          <span className="topbar-spacer" />
          {state.adapterKind === 'memory' && <span className="tag warn">Storage unavailable: changes will not persist</span>}
          <button type="button" className="button sm" onClick={() => setImportOpen(true)}>
            <UploadSimple size={13} weight="bold" aria-hidden />
            Import data
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
    </div>
  );
}
