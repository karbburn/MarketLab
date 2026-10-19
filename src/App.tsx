import { HashRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { OverviewPage } from './pages/Overview';
import { ChartWorkspacePage } from './pages/ChartWorkspace';
import { QuantLabPage } from './pages/QuantLab';
import { ScreenerPage } from './pages/Screener';
import { BacktestPage } from './pages/Backtest';
import { DataPage } from './pages/DataPage';
import { WorkspacesPage } from './pages/WorkspacesPage';

/**
 * Hash routing keeps deep links working when the built app is served from a
 * static host (or opened directly) without any server-side rewrite rules.
 */
export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<OverviewPage />} />
          <Route path="chart" element={<ChartWorkspacePage />} />
          <Route path="quant" element={<QuantLabPage />} />
          <Route path="screener" element={<ScreenerPage />} />
          <Route path="backtest" element={<BacktestPage />} />
          <Route path="data" element={<DataPage />} />
          <Route path="workspaces" element={<WorkspacesPage />} />
          <Route path="*" element={<OverviewPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
