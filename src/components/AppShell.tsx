import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  ChartLineUp,
  SquaresFour,
  Flask,
  FunnelSimple,
  PlayCircle,
  Database,
  BookOpen,
  Stack,
  Sun,
  Moon,
  UploadSimple,
  CloudArrowDown,
  List,
  X,
  MagnifyingGlass,
} from '@phosphor-icons/react';
import { useStore } from '../state/store';
import { Toaster } from './ui';
import { datasetViews, hasSyntheticData } from '../state/selectors';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ImportDialog } from './data/ImportDialog';
import { DownloadDialog } from './data/DownloadDialog';
import { BulkDownloadDialog } from './data/BulkDownloadDialog';
import { CommandPalette } from './command-palette/CommandPalette';
import { BULK_DOWNLOAD_DATA_EVENT, DOWNLOAD_DATA_EVENT, IMPORT_DATA_EVENT } from '../lib/ui-events';
import { APP_ROUTES, NAV_GROUP_PATHS, appRouteTitle } from '../lib/navigation';
import { isPaletteShortcut, isMacPlatform, shortcutLabel } from '../lib/command-palette/platform';

interface NavEntry {
  to: string;
  label: string;
  icon: typeof ChartLineUp;
  end?: boolean;
}

/** Sidebar icons, keyed by route path so the route list stays in one place. */
const NAV_ICONS: Record<string, typeof ChartLineUp> = {
  '/': SquaresFour,
  '/chart': ChartLineUp,
  '/quant': Flask,
  '/screener': FunnelSimple,
  '/backtest': PlayCircle,
  '/data': Database,
  '/learn': BookOpen,
  '/workspaces': Stack,
};

const NAV_GROUPS: Array<{ label: string; entries: NavEntry[] }> = NAV_GROUP_PATHS.map((group) => ({
  label: group.label,
  entries: group.paths
    .map((path) => APP_ROUTES.find((route) => route.path === path))
    .filter((route): route is (typeof APP_ROUTES)[number] => route !== undefined)
    .map((route) => ({ to: route.path, label: route.label, icon: NAV_ICONS[route.path] ?? SquaresFour, end: route.end })),
}));

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const narrow = useNarrowNav();
  const navRef = useRef<HTMLElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  // Whether this component opened the drawer, so closing it returns focus to
  // the control that opened it and a breakpoint change does not steal focus.
  const navWasOpenRef = useRef(false);

  const views = datasetViews(state);
  const synthetic = hasSyntheticData(state);
  const title = appRouteTitle(location.pathname);
  const isMac = useMemo(() => isMacPlatform(typeof navigator === 'undefined' ? '' : navigator.platform), []);
  const paletteHint = shortcutLabel(isMac);

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
  const shellClassName = navCollapsed ? 'shell nav-collapsed' : 'shell';

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

  // The narrow drawer is a modal navigation surface: opening it moves focus to
  // the first link, and closing it returns focus to the toggle that opened it.
  useEffect(() => {
    if (!narrow) return;
    if (navOpen) {
      navWasOpenRef.current = true;
      const nav = navRef.current;
      const firstLink = nav?.querySelector<HTMLElement>('.nav-item');
      (firstLink ?? nav)?.focus();
      return;
    }
    if (navWasOpenRef.current) {
      navWasOpenRef.current = false;
      navToggleRef.current?.focus();
    }
  }, [narrow, navOpen]);

  // Leaving the narrow layout drops the drawer, so a resize or rotation cannot
  // leave it open (or re-open it) without a user action. The reset lives in the
  // media-query callback rather than the render body.
  useEffect(() => {
    const query = window.matchMedia(NARROW_NAV_QUERY);
    const onChange = () => {
      if (query.matches) return;
      navWasOpenRef.current = false;
      setNavOpen(false);
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // The global palette shortcut. It deliberately ignores whether the user is
  // typing somewhere: Ctrl/Cmd+K is the one binding that must always reach the
  // palette. It is skipped while one of the shell's own dialogs is open, so the
  // palette never stacks on top of a modal.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPaletteShortcut(event)) return;
      if (document.querySelector('.dialog')) return;
      event.preventDefault();
      setNavOpen(false);
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
      <nav
        id="primary-nav"
        className={navOpen ? 'shell-nav open' : 'shell-nav'}
        aria-label="Primary"
        tabIndex={-1}
        ref={navRef}
      >
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

      <div className="shell-main" inert={narrow && navOpen}>
        <header className="topbar">
          <button
            type="button"
            className="button ghost icon shell-nav-toggle"
            aria-label={navToggleLabel}
            aria-expanded={navExpanded}
            aria-controls="primary-nav"
            title={navToggleLabel}
            ref={navToggleRef}
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
          <button
            type="button"
            className="button ghost sm palette-trigger"
            aria-label={`Open the command palette (${paletteHint})`}
            title={`Search views, actions and datasets (${paletteHint})`}
            onClick={() => {
              setNavOpen(false);
              setPaletteOpen(true);
            }}
          >
            <MagnifyingGlass size={13} weight="bold" aria-hidden />
            <span className="topbar-action-label">Search</span>
            <kbd className="palette-kbd palette-trigger-kbd">{paletteHint}</kbd>
          </button>
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
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <DownloadDialog open={downloadOpen} onClose={() => setDownloadOpen(false)} />
      <BulkDownloadDialog open={bulkDownloadOpen} onClose={() => setBulkDownloadOpen(false)} />
    </div>
  );
}
