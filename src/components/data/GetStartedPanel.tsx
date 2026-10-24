import { ChartLineUp, CloudArrowDown, ListChecks, UploadSimple } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { DEFAULT_SERVICE_URL, isLocalMarketDataService } from '../../lib/marketdata/client';
import { requestBulkDownloadDialog, requestDownloadDialog, requestImportDialog } from '../../lib/ui-events';
import { Panel } from '../ui';

/**
 * The first-run panel.
 *
 * MarketLab stores no bundled market data, so a fresh library is empty on
 * purpose. This panel turns that empty state into the three real ways to fill
 * it — download real history, import a CSV, or open the chart workspace and
 * read what to do next — and says plainly which market-data path this page uses.
 */
export function GetStartedPanel({ title = 'No market data yet' }: { title?: string }) {
  const localService = isLocalMarketDataService();
  return (
    <Panel
      title={title}
      subtitle="MarketLab works on real historical bars. Nothing is bundled and nothing is invented."
    >
      <div className="stack">
        <div className="row tight">
          <button type="button" className="button primary" onClick={requestDownloadDialog}>
            <CloudArrowDown size={14} aria-hidden />
            Download real market data
          </button>
          <button type="button" className="button" onClick={requestBulkDownloadDialog}>
            <ListChecks size={14} aria-hidden />
            Download many symbols
          </button>
          <button type="button" className="button" onClick={requestImportDialog}>
            <UploadSimple size={14} aria-hidden />
            Import a CSV file
          </button>
          <Link className="button" to="/chart">
            <ChartLineUp size={14} aria-hidden />
            Open the chart workspace
          </Link>
        </div>
        <ul className="list-reset stack field-hint">
          {localService ? (
            <li>
              Downloads go through the local market-data service on{' '}
              <span className="mono">{DEFAULT_SERVICE_URL}</span>. Start it from the{' '}
              <span className="mono">services/market-data</span> folder with{' '}
              <span className="mono">uvicorn app:app --port 8787</span> and then use Data → Download market data.
            </li>
          ) : (
            <li>
              Downloads go through MarketLab's hosted market-data service, so no local setup or browser permission is
              needed. If it is unavailable, import a CSV file and everything else keeps working.
            </li>
          )}
          <li>
            The batch dialog takes a list of symbols — AAPL, MSFT, NVDA, SPY and QQQ are sensible starting points — and
            reports every symbol separately, so one unavailable ticker never discards the rest of the batch.
          </li>
          <li>
            CSV import accepts <span className="mono">date, open, high, low, close</span> and an optional{' '}
            <span className="mono">volume</span> column. Everything else keeps working.
          </li>
          <li>
            Downloaded bars are daily, come from a market-data provider, can be delayed and are not licensed for
            redistribution. They are never real-time, and a failed download is reported rather than replaced with other
            data.
          </li>
        </ul>
      </div>
    </Panel>
  );
}
