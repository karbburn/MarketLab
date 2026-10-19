/**
 * The application's top-level destinations, in sidebar order.
 *
 * One list feeds both the sidebar and the command palette so the two can never
 * drift apart. `label` is the sidebar wording, `title` is the heading the shell
 * shows in the top bar (they differ where the short label needs context, e.g.
 * "Screener" -> "Historical screener").
 */
export interface AppRoute {
  path: string;
  label: string;
  title: string;
  /** Exact matching for the index route, as `NavLink` needs. */
  end?: boolean;
}

export const APP_ROUTES: readonly AppRoute[] = [
  { path: '/', label: 'Overview', title: 'Overview', end: true },
  { path: '/chart', label: 'Chart workspace', title: 'Chart workspace' },
  { path: '/quant', label: 'Quant lab', title: 'Quant lab' },
  { path: '/screener', label: 'Screener', title: 'Historical screener' },
  { path: '/backtest', label: 'Backtest', title: 'Rule-based backtest' },
  { path: '/data', label: 'Data', title: 'Data library' },
  { path: '/workspaces', label: 'Workspaces', title: 'Workspaces and settings' },
];

/** The sidebar's group headings, keyed by the routes they contain. */
export const NAV_GROUP_PATHS: ReadonlyArray<{ label: string; paths: readonly string[] }> = [
  { label: 'Terminal', paths: ['/', '/chart'] },
  { label: 'Research', paths: ['/quant', '/screener', '/backtest'] },
  { label: 'Library', paths: ['/data', '/workspaces'] },
];

/** Top-bar heading for a route path; `fallback` for anything unmatched. */
export function appRouteTitle(pathname: string, fallback = 'MarketLab'): string {
  return APP_ROUTES.find((route) => route.path === pathname)?.title ?? fallback;
}
