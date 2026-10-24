import type { ReactNode } from 'react';
import { useStore } from '../state/store';
import { Skeleton } from './ui';

/**
 * Holds the app back until local storage has been read. Without this the pages
 * would briefly render an empty state that looks like "your data is gone".
 */
export function LoadingGate({ children }: { children: ReactNode }) {
  const { state } = useStore();
  if (state.status === 'ready') return <>{children}</>;
  return (
    <div className="shell">
      <nav className="shell-nav" aria-hidden>
        <div className="shell-brand">
          <span className="shell-brand-mark">ML</span>
          <div style={{ display: 'grid' }}>
            <span className="shell-brand-name">MarketLab</span>
            <span className="shell-brand-sub">Charts, screening, backtesting</span>
          </div>
        </div>
        <div className="nav-group">
          <Skeleton width={120} height={12} />
        </div>
        <div className="nav-group">
          <Skeleton width={150} height={12} />
        </div>
      </nav>
      <div className="shell-main">
        <header className="topbar">
          <span className="topbar-title">Loading local data</span>
        </header>
        <div className="page">
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">Reading local storage</span>
            </div>
            <div className="panel-body stack">
              <Skeleton height={14} />
              <Skeleton width="70%" height={14} />
              <Skeleton width="45%" height={14} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
