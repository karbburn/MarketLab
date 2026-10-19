# MarketLab

**A local-first charting and quantitative research terminal that runs entirely in the browser.**

[Live application](https://marketlab.sourabhpradhan.in) · [Getting started](#getting-started) · [Getting data](#getting-data) · [Architecture](#architecture) · [Scope](#scope-and-limitations)

MarketLab implements, from first principles, the workflow a trading terminal gives you: validated
OHLCV ingestion, interactive charts with indicators and drawings, risk and cross-asset research,
historical screening, rule-based backtesting, and export or backup of everything you have stored.
It is a static single-page app — there is no account, no backend and no telemetry, and every
calendar, indicator and simulation is computed on your own device. Your data lives in the
browser's IndexedDB and is never uploaded anywhere.

**MarketLab stores no bundled market data.** The library starts empty and fills with history you
download through the optional local market-data service or import from a CSV file. Nothing is
synthesised, and no price is ever invented to fill a gap.

MarketLab is an independent project. It is not affiliated with, endorsed by, or derived from
TradingView or any other commercial charting platform; it reimplements a familiar terminal
*workflow* from scratch.

![The MarketLab chart workspace: a daily candlestick series with a volume pane, drawing tools and a watchlist](docs/screenshots/workspace.png)

## Features

### Charting

- Candlestick, bar, line, area and baseline series, with a volume pane and normal, logarithmic or
  percentage price scales.
- Crosshair readout showing OHLC, change and session date for the bar under the pointer.
- Layouts of one, two stacked, two side by side or four panels. Link groups keep panels that
  share a dataset and timeframe in step for symbol, timeframe or visible range, and reducing a
  layout hides panels without deleting them or their drawings.
- Drawing tools: trend line, ray, horizontal level, vertical marker, zone rectangle, Fibonacci
  retracement, measure move and text label — with drag-to-move, undo/redo (`Ctrl`/`Cmd`+`Z`,
  `Shift` to redo) and `Delete` to remove a selection. Shortcuts apply only to the focused chart
  and never while a dialog or a text field has focus.

### Indicators

Twelve indicators, each computed from first principles (no third-party maths library) and
unit-tested against hand-checked values: SMA, EMA, Bollinger Bands, RSI, MACD, Stochastic
Oscillator, ATR, ADX, Anchored VWAP, Volume SMA with relative volume, On-Balance Volume and
Ichimoku Cloud. Parameters are clamped to their declared bounds, and outputs that do not exist
yet (warm-up periods) are empty rather than zero.

### Research

- **Quant lab** — total return, CAGR, annualised volatility, Sharpe, Sortino, maximum drawdown,
  Ulcer index, Calmar, historical VaR and CVaR, beta and alpha against a second series, plus a
  normalised performance comparison, rolling volatility, rolling drawdown and a correlation
  matrix over shared sessions. Assumptions (for example, a zero risk-free rate) are printed next
  to the numbers they affect.
- **Screener** — field/operator/value rules evaluated over the sessions you have stored, with the
  matched series, per-row filter columns and a count of how many series were evaluated.
- **Backtest** — a long-only rule engine with entry, exit, stop-loss and take-profit rules,
  position sizing, commission and slippage, an equity curve against buy-and-hold, a drawdown
  chart and a trade log you can export.

![Quant lab: risk and return metrics with normalised performance and rolling volatility charts](docs/screenshots/quant-lab.png)

### Data

- **Download real history** — one symbol at a time, or a whole list in one batch. Every symbol is
  reported on its own, so one unavailable ticker never discards the rest of the run.
- **CSV import** with inferred column roles you can override, a validation report, and rejected
  rows listed with reasons (see [Importing your own data](#importing-your-own-data)).
- **Weekly and monthly views** aggregated from daily bars, always labelled as aggregated. Daily
  data is never interpolated into intraday bars.
- **Provenance** — every downloaded series stores its provider, exchange, adjustment policy and
  retrieval time, and shows them in the data library, the inspection panel and the chart legend.
- **Export and backup** — datasets, quant summaries, screener results, backtest trades and the
  equity curve as CSV; the whole workspace as a versioned JSON backup that can be merged into or
  restored over the current state.

### Workspace

Named workspaces with their own panel layouts, watchlists that load an instrument into the
focused panel, persisted preferences (including light and dark themes), and a data library that
shows the stored series, their source, frequency, session counts, first and last session and
content hash — with per-series inspection, export and deletion.

![Rule-based backtest: strategy parameters, results against buy-and-hold, and a per-trade log](docs/screenshots/backtest.png)

## Getting started

Requires **Node.js 20.19+ or 22.12+** (Vite 8) and npm.

```bash
git clone https://github.com/karbburn/MarketLab.git
cd MarketLab
npm install
npm run dev
```

Open the printed URL. The library starts empty on purpose: the first screen offers to download
real market data, to import a CSV file, or to open the chart workspace and read how to get
started. Nothing is pre-filled, and no placeholder prices are shown.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server. |
| `npm run build` | Type-check with `tsc -b`, then build the production bundle into `dist/`. |
| `npm run preview` | Serve the built bundle locally. |
| `npm run typecheck` | Type-check only. |
| `npm run lint` | Run ESLint over the repository. |
| `npm test` | Run the unit test suite (Vitest). |
| `npm run test:watch` | Run unit tests in watch mode. |
| `npm run test:e2e` | Run the Playwright end-to-end suite against a preview build. |
| `npm run verify` | Lint, type-check, unit test and build in one pass. |

## Getting data

### Downloading real history

MarketLab downloads daily bars from Yahoo Finance through a small local service that lives in
`services/market-data/`. It is deliberately outside the app: the frontend only talks to
`127.0.0.1`, so nothing is proxied through the site you are viewing.

```bash
cd services/market-data
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m uvicorn app:app --host 127.0.0.1 --port 8787
```

Then use **Data → Download market data** for a single symbol, or **Data → Download many symbols**
for a batch — AAPL, MSFT, NVDA, SPY and QQQ are sensible starting points, and the batch dialog
accepts any list you paste in. Read
[`services/market-data/README.md`](services/market-data/README.md) for the endpoints, the error
model and the setup details.

Worth stating plainly: **Yahoo Finance is an unofficial, undocumented source.** Downloads can be
delayed for some venues, be rate limited, or change shape without notice, and the data is not
licensed for redistribution. Every series keeps its provider, exchange, adjustment policy and
retrieval timestamp so the provenance travels with the prices. The service is entirely optional:
without it, CSV imports, previously downloaded series and every other feature keep working, and
download attempts fail with an explicit message instead of silently producing nothing.

### Importing your own data

CSV import accepts a header row and infers the column roles, which you can override before
importing:

```csv
date,open,high,low,close,volume
2024-01-02,187.15,188.44,183.89,185.64,82488700
2024-01-03,184.22,185.88,183.43,184.25,58414500
```

| Column | Required | Notes |
| --- | --- | --- |
| `date` | yes | Exchange session date; `YYYY-MM-DD` is the canonical form. |
| `open`, `high`, `low`, `close` | yes | Positive prices satisfying `high >= max(open, close)` and `low <= min(open, close)`. |
| `volume` | no | Stored as missing rather than zero when absent. |

Rows are rejected, with the reason reported, when they break an invariant or conflict with the
chosen duplicate policy (`reject`, `keep first` or `keep last`). Out-of-order rows and weekend
sessions are reported as warnings. Missing sessions are reported as gaps rather than invented,
and every stored series carries a content hash that is also used to recognise an already-stored
series when a backup is restored.

## Architecture

```
src/
  components/     app shell, UI primitives, chart panels, chart adapter, dialogs
  domain/         canonical domain types (bars, datasets, workspaces, drawings)
  lib/
    backtest/     rule definitions, comparison helpers, simulation engine
    csv/          CSV parsing and column mapping
    drawings/     drawing geometry and hit testing
    export/       CSV writers, JSON backup and browser download helpers
    indicators/   indicator implementations and registry
    marketdata/   provider-independent client, batch queue and response normalisation
    migration/    removal of the legacy bundled demo series
    persistence/  IndexedDB adapter with an in-memory fallback
    quant/        performance, risk, correlation and comparison metrics
    screener/     screener fields and evaluation
    validation/   dataset validation and OHLC invariants
    workspace/    backup schema and migration
  pages/          one module per top-level screen
  state/          store, defaults, selectors
  styles/         design tokens and global styles
services/
  market-data/    optional local FastAPI + yfinance service and its tests
tests/
  unit/           Vitest suites
  e2e/            Playwright suites
```

**Stack.** React 19 with TypeScript in strict mode, built by Vite 8. Rendering of price panes is
delegated to [`lightweight-charts`](https://github.com/tradingview/lightweight-charts), while
drawings, hit testing and readouts are drawn on a plain canvas overlay that shares the price
pane's coordinate space. Boundaries — imported backups, CSV rows, download responses — are parsed
with Zod and rejected with an explanation rather than coerced. Styling is plain CSS over a small
set of design tokens, with dark and light themes.

**Decisions worth knowing.**

- **Canonical bars.** A session is identified by its date (`YYYY-MM-DD`), bucketed in UTC. Only
  daily → weekly (Monday-based) and daily → monthly aggregation is offered; intraday is
  unsupported by design, and nothing infers an intraday series from daily data.
- **Real data or nothing.** The application ships no synthetic series. An empty library is a
  first-run state with real actions in it, not a gap filled with invented prices. A browser that
  ran an earlier build still holding the old demo series has them removed on load, and only
  them: imported, downloaded and user-created records are left untouched.
- **Deterministic maths, explicit gaps.** Indicators, metrics and the backtester are pure
  functions over stored bars, with warm-up periods reported as empty rather than zero.
- **Validation before storage.** Imported and downloaded series are checked for OHLC invariants,
  duplicate sessions and unorderable rows before they are written, and the reasons for rejected
  rows are shown to you.
- **A disclosed execution model.** Signals are evaluated on a session's close and orders fill at
  the next session's open — no same-bar fill, no look-ahead. Costs and slippage apply to both
  sides; when a bar touches both the stop and the target, the stop is assumed to fill first; a
  position still open at the end is closed at the last session and labelled end-of-data.
- **Local-first persistence.** The store writes to IndexedDB through a serialised per-record
  write queue, and falls back to in-memory storage (saying so) when IndexedDB is unavailable.
  Exports and backups exist so a durable copy is always a click away.
- **Hash routing.** Routes are served from the fragment, so the production build is a directory
  of static files that needs no server rewrite rules and can be hosted anywhere.

## Testing

```bash
npm run verify                     # lint, type-check, unit tests, production build
npm run test:e2e                   # Playwright against the built app on 127.0.0.1:4173
python -m pytest services/market-data/tests -q
```

Unit tests cover the pure logic where correctness is decided: indicator values, OHLC validation
and CSV mapping, risk metrics and correlation, screener evaluation, the backtest engine's fill
model, the download batch queue, backup parsing and migration, the removal of the legacy demo
series, and export formatting. The end-to-end suite drives the built app with the locally
installed Google Chrome (`channel: 'chrome'`, no browser download) and covers the shell, the
chart workspace, drawing and keyboard behaviour, CSV import and rejection paths, the research
screens, settings, backup export/restore, the download success and failure paths, and the
first-run and migration behaviour. The service test suite is deterministic and never touches the
network.

## Hosting

`npm run build` produces a static `dist/` directory with no runtime configuration. Because the app
uses hash routing and stores data per browser profile, the same build can be served from any
static host — the deployment linked at the top of this file runs exactly this bundle.

## Scope and limitations

MarketLab is a research tool, and its edges are intentional:

- Sessions are daily; there is no streaming quote feed, no tick data and no intraday timeframe.
- Downloads depend on an unofficial provider and can fail; the app reports failures instead of
  hiding them or substituting other data.
- The backtester is long-only, single-position and per-series. It does not model portfolios,
  short selling, borrow costs or corporate actions beyond the adjusted close it stores.
- State is per browser profile. Moving between browsers is done deliberately through the JSON
  backup, not through an account or a sync service.
- Nothing here is investment advice.

---

MarketLab is an independent project, not affiliated with or endorsed by any charting platform or
data provider. No licence is granted for reuse of this source code.
