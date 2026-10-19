# MarketLab

A local-first charting and quantitative research terminal. It runs entirely in the browser,
stores everything on your own device, and makes no third-party network requests at runtime.

MarketLab is an independent project. It is not affiliated with, endorsed by, or derived from
any commercial charting platform; it implements a familiar terminal *workflow* from scratch.

## What it does

- **Interactive charts** - candlestick, bar, line, area and baseline series, a volume pane,
  linear/logarithmic/percentage price scales, and a crosshair readout legend.
- **Historical data you control** - import OHLCV CSV files, review the validation report,
  and inspect the stored series. Weekly and monthly views are aggregated from daily data
  and are labelled as such.
- **Optional real historical data** - run the bundled local service (see below) and download
  daily bars from Yahoo Finance (unofficial source, no API key), with the provider, exchange,
  adjustment policy and retrieval time recorded and shown for every series.
- **Indicators** - SMA, EMA, Bollinger Bands, RSI, MACD, Stochastic Oscillator, ATR, ADX,
  Anchored VWAP, Volume SMA with relative volume, On-Balance Volume and Ichimoku Cloud,
  each computed from first principles and tested against hand-checked values.
- **Drawing tools** - trend line, ray, horizontal and vertical levels, zone rectangle,
  Fibonacci retracement, measure move and text labels, with drag-to-move, undo/redo and
  a delete action.
- **Multi-chart layouts** - one, two stacked, two side by side, or four panels, with link
  groups that keep panels sharing the same series and timeframe in step. Reducing a layout
  hides panels without deleting them.
- **Quant lab** - annualised return and volatility, Sharpe, Sortino, maximum drawdown,
  Calmar, historical VaR/CVaR, beta and correlation, with a normalised performance
  comparison and a correlation matrix over shared sessions. Assumptions (such as a zero
  risk-free rate) are printed next to the numbers.
- **Screener** - field/operator/value rules evaluated over historical sessions, with the
  matched series, per-row filter columns and a count of how many series were evaluated.
- **Backtesting** - a long-only rule engine with entry, exit, stop-loss and take-profit
  rules, costs and slippage, an equity curve against buy-and-hold, and a trade log.
- **Workspaces, watchlists and preferences** - named workspaces with their own panel
  layouts, saved watchlists, and persisted preferences including theme.
- **Export and backup** - dataset, quant, screener and backtest results as CSV, plus a
  versioned JSON backup of the whole workspace that can be merged or restored.

## Honesty notes

This project deliberately avoids overstating what it does:

- The bundled data is **deterministic synthetic data**, generated locally, and is labelled
  "not real market data" wherever it appears. It exists so the app is usable on first run.
- Data downloaded from the optional market-data service comes from **Yahoo Finance, an
  unofficial, undocumented source**: it may be delayed for some venues, can change or
  disappear without notice, and is not licensed for redistribution. Downloads are daily
  only, as-traded OHLC with a separately stored adjusted close (splits applied, dividends
  not reinvested), and every stored series keeps the provider, exchange, adjustment policy
  and retrieval timestamp next to its prices. The app works fully without the service;
  no request is made unless you opt in from Data → Download market data.
- Imported data is validated: prices must be positive, `low <= min(open, close)` and
  `max(open, close) <= high` must hold, sessions must be unique under the chosen duplicate
  policy, and out-of-order rows are reported. Rejected rows are listed with reasons.
- Daily data is never interpolated into intraday bars. Only daily to weekly (Monday-based)
  and daily to monthly aggregation is offered, and the series label says it was aggregated.
- Indicator outputs that do not exist yet (warm-up periods) are empty, not zero.
- Backtest results are presented together with the execution model that produced them:
  signals are evaluated on a session's close, orders fill at the next session's open, there
  is no same-bar fill or look-ahead, and short selling is not modelled.

## Getting started

Requires Node.js 20 or newer.

```bash
npm install
npm run dev        # development server
```

Open the printed local URL. On first run the app seeds the bundled sample set so every
screen has data.

A maintained deployment of this repository runs at
[`https://marketlab.sourabhpradhan.in`](https://marketlab.sourabhpradhan.in) — the same
static app, with all data stored in that browser only.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server. |
| `npm run build` | Type-check with `tsc -b`, then build the production bundle. |
| `npm run preview` | Serve the built bundle locally. |
| `npm run typecheck` | Type-check only. |
| `npm run lint` | Run ESLint over the repository. |
| `npm test` | Run the unit test suite (Vitest). |
| `npm run test:watch` | Run unit tests in watch mode. |
| `npm run test:e2e` | Run the Playwright end-to-end suite against a preview build. |
| `npm run verify` | Lint, type-check, unit test and build in one pass. |

The end-to-end suite drives the built app on `http://127.0.0.1:4173` using the locally
installed Google Chrome (`channel: 'chrome'`), so no browser download is required.

## Optional market-data service

MarketLab can also download real (unofficial) daily historical bars from Yahoo Finance
via a small local service in `services/market-data/`. It needs Python 3.10+:

```bash
python -m pip install fastapi uvicorn yfinance
python -m uvicorn app:app --app-dir services/market-data --host 127.0.0.1 --port 8787
```

Then in the app: **Data → Download market data**. Notes:

- The service is local-only: it binds to `127.0.0.1`, accepts requests only from the
  app's local origins, exposes no configurable URL-fetch endpoint, and needs no API key.
- It serves daily sessions only (`interval=1d`) with `auto_adjust=False`, so prices are
  as-traded and an adjusted close is stored separately (dividends are not reinvested).
- The service is optional. When it is not running, everything else in MarketLab keeps
  working, attempts to download fail with an explicit message, and previously downloaded
  series remain available from local storage.
- The Python test suite for the service is deterministic and never touches the network:
  `python -m pytest services/market-data/tests`.

## Importing your own data

CSV import accepts a header row and infers the column roles, which you can override before
importing. A typical file:

```csv
date,open,high,low,close,volume
2024-01-02,187.15,188.44,183.89,185.64,82488700
2024-01-03,184.22,185.88,183.43,184.25,58414500
```

- `date` is the exchange session date (`YYYY-MM-DD` is the canonical form).
- `open`, `high`, `low` and `close` are required; `volume` is optional.
- Missing sessions are reported as gaps rather than invented.
- The series is stored with a content hash, which is also used to recognise an
  already-stored series when restoring a backup.

## Project layout

```
src/
  components/     application shell, UI primitives, chart panels, dialogs
  data/           deterministic synthetic sample data
  domain/         canonical domain types
  lib/
    backtest/     rule definitions, comparison helpers, simulation engine
    csv/          CSV parsing and column mapping
    drawings/     drawing geometry and hit testing
    export/       CSV, JSON backup and browser download helpers
    indicators/   indicator implementations and registry
    marketdata/   provider-independent client and response normalisation
    persistence/  IndexedDB adapter with an in-memory fallback
    quant/        performance, risk and correlation metrics
    screener/     screener fields and evaluation
    validation/   dataset validation and OHLC invariants
  pages/          one module per top-level screen
  state/          store, defaults and selectors
  styles/         design tokens and component styles
services/
  market-data/    optional local FastAPI + yfinance download service and its tests
tests/
  unit/           Vitest suites
  e2e/            Playwright suites
```

## Persistence

Data is stored in IndexedDB in your browser profile. Nothing leaves the device. If
IndexedDB is unavailable the app falls back to in-memory storage for the session and says
so. Use the backup export if you want a durable copy you can move between browsers.

## Licence

MIT. See [LICENSE](./LICENSE).
