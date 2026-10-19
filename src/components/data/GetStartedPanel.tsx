import { ChartLineUp, CloudArrowDown, ListChecks, UploadSimple } from '@phosphor-icons/react';
import { Link } from 'react-router-dom';
import { requestBulkDownloadDialog, requestDownloadDialog, requestImportDialog } from '../../lib/ui-events';
import { Panel } from '../ui';

/**
 * The first-run panel.
 *
 * MarketLab stores no bundled market data, so a fresh library is empty on
 * purpose. This panel turns that empty state into the three real ways to fill
 * it — download real history, import a CSV, or open the chart workspace and
 * read what to do next — and says plainly what happens when the local
 * market-data service is not running.
 */
export function GetStartedPanel({ title = 'No market data yet' }: { title?: string }) {
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
          <li>
            Downloads go through the optional local market-data service on <span className="mono">http://127.0.0.1:8787</span>.
            Start it from the <span className="mono">services/market-data</span> folder with{' '}
            <span className="mono">uvicorn app:app --port 8787</span> and then use Data → Download market data.
          </li>
          <li>
            The batch dialog takes a list of symbols — AAPL, MSFT, NVDA, SPY and QQQ are sensible starting points — and
            reports every symbol separately, so one unavailable ticker never discards the rest of the batch.
          </li>
          <li>
            Without that service you can still import a CSV file with <span className="mono">date, open, high, low, close</span>{' '}
            and an optional <span className="mono">volume</span> column. Everything else keeps working.
          </li>
          <li>
            Downloaded bars are daily, come from an unofficial provider, can be delayed and are not licensed for
            redistribution. They are never real-time, and a failed download is reported rather than replaced with other
            data.
          </li>
        </ul>
      </div>
    </Panel>
  );
}
