# MarketLab

**A local-first charting and quantitative research terminal that runs entirely in your browser.**

[Live application](https://marketlab.sourabhpradhan.in) · [Features](#features) · [Screenshots](#screenshots) · [Getting started](#getting-started) · [Getting data](#getting-data) · [Data and provenance](#data-and-provenance) · [Architecture](#architecture) · [Testing](#testing) · [Project status](#project-status) · [Scope and limitations](#scope-and-limitations)

MarketLab implements, from first principles, the workflow a professional charting terminal gives
you: validated OHLCV ingestion, interactive charts with indicators and drawings, risk and
cross-asset research, historical screening, rule-based backtesting, and export or backup of
everything you have stored. It is a static single-page application — there is no account, no
backend, no analytics or telemetry, and every calendar, indicator and simulation is computed on
your own device. Your data lives in the browser's IndexedDB and is never uploaded anywhere.

**MarketLab ships no bundled market data.** The library starts empty and fills with history you
download through the optional local market-data service or import from a CSV file. Nothing is
synthesised, and no price is ever invented to fill a gap.

MarketLab is an independent project. It is not affiliated with, endorsed by, or derived from
TradingView or any other commercial charting platform; it reimplements a familiar terminal
*workflow* from scratch.

![The chart workspace: a daily AAPL candlestick series with a volume pane, the drawing toolbar and the instrument sidebar](docs/screenshots/workspace.png)

## Contents

- [Features](#features)
  - [Charting](#charting) · [Indicators](#indicators) · [Research](#research) · [Data](#data) · [Workspace](#workspace)
- [Screenshots](#screenshots)
- [Getting started](#getting-started)
- [Getting data](#getting-data)
- [Data and provenance](#data-and-provenance)
- [Architecture](#architecture)
- [Testing](#testing)
- [Hosting](#hosting)
- [Project status](#project-status)
- [Scope and limitations](#scope-and-limitations)

## Features

### Charting

- Candlestick, OHLC bar, line, area and baseline series, with a volume pane and normal,
  logarithmic or percentage price scales.
- Crosshair readout showing OHLC, change and session date for the bar under the pointer.
- Layouts of one, two stacked, two side by side or four panels. Link groups keep panels that
  share a dataset and timeframe in step for symbol, timeframe or visible range, and reducing a
  layout hides panels without deleting them or their drawings.
- Drawing tools: trend line, ray, horizontal level, vertical marker, zone rectangle, Fibonacci
  retracement, measure move and text label — with drag-to-move, undo/redo (`Ctrl`/`Cmd`+`Z`,
  `Shift` to redo) and `Delete` to remove a selection. Shortcuts apply only to the focused chart
  and never while a dialog or a text field has focus.
- **Comparison overlays** — add other stored series to a panel as rebased index lines on a
  separate left axis. Series are aligned on real shared sessions and rebased to 100 at the first
  common session; nothing is forward-filled. The legend removes one series or clears all, and the
  panel foot states the method and any excluded series with reasons.
- **Corporate-action markers** — provider-reported splits and dividends from downloaded Yahoo
  Finance history are marked on the primary series: splits above the bar, cash dividends below.
  The panel names the provider and states that prices are already split-adjusted (so a split
  marker is not a price gap) and that dividends are not reinvested. Imported CSVs and older
  downloads show no markers rather than guessed events.

### Indicators

Twelve indicators, each computed from first principles (no third-party maths library) and
unit-tested against hand-checked values:

- **Trend:** SMA, EMA, ADX, Ichimoku Cloud, Anchored VWAP
- **Momentum:** RSI, MACD, Stochastic Oscillator
- **Volatility:** Bollinger Bands, ATR
- **Volume:** Volume SMA with relative volume, On-Balance Volume

Parameters are clamped to their declared bounds, and outputs that do not exist yet (warm-up
periods) are empty rather than zero.

### Research

- **Quant lab** — total return, CAGR, annualised volatility, Sharpe, Sortino, maximum drawdown,
  Ulcer index, Calmar, historical VaR and CVaR, beta and alpha against a second series, plus a
  normalised performance comparison, rolling volatility, rolling drawdown and a correlation
  matrix over shared sessions. Assumptions (for example, a zero risk-free rate) are printed next
  to the numbers they affect.
- **Screener** — field/operator/value rules evaluated over the sessions you have stored, with the
  matched series, per-row filter columns and a count of how many series were evaluated. A result
  opens in the chart workspace without re-importing it or moving the screen's cutoff.
- **Backtest** — a long-only rule engine with entry, exit, stop-loss and take-profit rules,
  position sizing, commission and slippage, an equity curve against buy-and-hold, a drawdown
  chart and a trade log you can export. Execution assumptions are printed next to the results.

### Data

- **Download real history** — one symbol at a time, or a whole list in one batch of up to 50.
  Symbols are de-duplicated and reported one by one, so a single unavailable ticker never
  discards the rest of the run; **Retry failed** re-requests only the symbols that failed.
- **CSV import** with inferred column roles you can override, a validation report, and rejected
  rows listed with reasons (see [Importing your own data](#importing-your-own-data)).
- **Weekly and monthly views** aggregated from daily bars, always labelled as aggregated. Daily
  data is never interpolated into intraday bars.
- **Provenance** — every downloaded series stores its provider, exchange, adjustment policy,
  retrieval time and provider-reported corporate actions, and shows the source in the data
  library, the inspection panel and the chart legend.
- **Export and backup** — datasets, quant summaries, screener results, backtest trades and the
  equity curve as CSV; the whole workspace as a versioned JSON backup that can be merged into or
  restored over the current state.

### Workspace

Named workspaces with their own panel layouts, watchlists that load an instrument into the
focused panel and show last close, day change, 30-session average volume and a high-low range
shown as a percentage of the low, persisted preferences (including light and dark themes), and a
data library that shows the stored series, their source, frequency, session counts, first and last
session and content hash — with per-series inspection, export and deletion.

## Screenshots

All screenshots were captured from a real provider download (AAPL, MSFT, NVDA, SPY and QQQ
through the local market-data service), so the provenance shown in them — provider, exchange,
adjustment policy and retrieval timestamp — is real rather than illustrative.

**Chart workspace** — the image at the top of this file: daily AAPL bars with the crosshair
readout, volume pane, drawing toolbar and the downloaded instrument list. Five series are stored;
the readout shows the 2026-10-16 session closing at 343.46 on NasdaqGS.

**Quant lab** — risk and return metrics with the provenance note, normalised performance and
rolling volatility. The coverage readout reports 1254 stored sessions for AAPL; assumptions such
as the zero risk-free rate are printed next to the metrics they affect.

![Quant lab: risk and return metrics with normalised performance and rolling volatility charts](docs/screenshots/quant-lab.png)

**Rule-based backtest** — strategy parameters, results against buy-and-hold, and the trade log
export. The execution model is restated above the results rather than buried in documentation.

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
for a batch of up to 50 — AAPL, MSFT, NVDA, SPY and QQQ are sensible starting points, and the
batch dialog accepts any list you paste in. Read
[`services/market-data/README.md`](services/market-data/README.md) for the endpoints, the error
model and the setup details.

The service is entirely optional. Without it, CSV imports, previously downloaded series and every
other feature keep working, and download attempts fail with an explicit message instead of
silently producing nothing.

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

## Data and provenance

The rules below are enforced in code, not just in the documentation:

- **Real data or nothing.** No synthetic series ship with the application. An empty library is a
  first-run state with real actions in it, not a gap filled with invented prices. A browser that
  ran an earlier build still holding the old demo series has them removed on load, and only them:
  imported, downloaded and user-created records are left untouched.
- **Unofficial source, stated plainly.** Yahoo Finance is an undocumented source. Downloads can be
  delayed for some venues, be rate limited, or change shape without notice, and the data is not
  licensed for redistribution.
- **Provenance travels with the prices.** Every downloaded series stores its provider, exchange,
  adjustment policy (`splits-applied, dividends not reinvested`), retrieval timestamp and any
  provider-reported split/dividend events. Adjusted close is stored separately and never mixed
  into OHLC computations.
- **Corporate actions are reported, not inferred.** Split and dividend markers come only from the
  provider's action columns. A split marker records the provider event date; because the OHLC is
  split-adjusted, it does not imply a price gap. Dividend markers are cash per share and are not
  reinvested. Actions with no matching displayed session are counted as unmarked rather than
  moved to a nearby bar, and imported CSVs carry no corporate actions at all.
- **Failures are reported, never papered over.** A failed or empty download is shown as such; no
  other series is substituted for it, and nothing is labelled real unless it came from a provider.
- **Validation before storage.** Imported and downloaded series are checked for OHLC invariants,
  duplicate sessions and unorderable rows before they are written, and the reasons for rejected
  rows are shown to you.
- **No timeframe is invented.** Sessions are daily; aggregation is only downward (daily → weekly
  or monthly) and is labelled as aggregated. Nothing infers an intraday series from daily data.

## Architecture

```
src/
  components/     app shell, UI primitives, chart panels, chart adapter, dialogs
  domain/         canonical domain types (bars, datasets, workspaces, drawings)
  lib/
    backtest/     rule definitions, comparison helpers, simulation engine
    chart/        comparison-overlay preparation and chart presentation helpers
    corporate-actions.ts  provider-action labels and marker planning
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
- **Deterministic maths, explicit gaps.** Indicators, metrics and the backtester are pure
  functions over stored bars, with warm-up periods reported as empty rather than zero.
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

The suites are run for real and the numbers below are the current ones.

| Suite | Size | What it covers |
| --- | --- | --- |
| Unit (Vitest) | 26 files, 280 tests | Indicator values, OHLC validation and CSV mapping, risk metrics and correlation, comparison alignment and rebasing, corporate-action validation and marker planning, screener evaluation, the backtest fill model, the download batch queue, watchlist context maths, backup parsing, the legacy-series removal and export formatting. |
| End-to-end (Playwright) | 58 tests | The shell and navigation, the chart workspace, comparison overlays and corporate-action markers, every drawing tool with the anchors it stores, typing and editing a label, keyboard drawing shortcuts, watchlist context columns, CSV import and rejection paths, the research screens, settings, backup export/restore, the single and batch download success, failure and retry paths, first-run guidance and the migration. |
| Service (pytest) | 26 tests | Success, invalid parameters, empty results, unknown symbols, corporate-action extraction and filtering, throttling, timeouts, malformed responses, caching, CORS and search normalisation — deterministic, never touching the network. |

The end-to-end suite drives the built app with the locally installed Google Chrome
(`channel: 'chrome'`, no browser download) and seeds its own library, because the application
bundles no data. The download paths stub the provider, so the suite does not depend on Yahoo
Finance or on the local service being reachable.

## Hosting

`npm run build` produces a static `dist/` directory with no runtime configuration. Because the app
uses hash routing and stores data per browser profile, the same build can be served from any
static host — the deployment linked at the top of this file runs exactly this bundle.

The optional market-data service is deliberately not deployed. Its CORS whitelist includes the
deployed origin, so a user's own local service can serve the hosted application.

## Project status

**Shipped and verified.** The features above, the full local test gate and a live deployment. The
latest state: `npm run verify` green, 280 unit tests, 58 end-to-end tests, 26 service tests.

**Planned, not started** — the remaining account-free items selected from an internal review of
what a charting terminal offers, in the order they are intended:

1. A global command palette (Ctrl/Cmd-K) for datasets, navigation and local symbol search.

**Deliberately out of scope.** MarketLab is an analysis and research tool, not a trading
terminal: no intraday or streaming quotes, no brokerage connectivity, no accounts or cloud sync,
no short selling, no alerting and no replay. These are product decisions, not gaps.

## Scope and limitations

- Sessions are daily; there is no streaming quote feed, no tick data and no intraday timeframe.
- Downloads depend on an unofficial provider and can fail; the app reports failures instead of
  hiding them or substituting other data.
- The backtester is long-only, single-position and per-series. It does not model portfolios,
  short selling, borrow costs or corporate actions beyond the adjusted close it stores.
- Corporate-action markers are display annotations sourced from provider metadata. They do not
  change OHLC, indicator inputs, screens or backtest calculations.
- State is per browser profile. Moving between browsers is done deliberately through the JSON
  backup, not through an account or a sync service.
- Nothing here is investment advice.

---

MarketLab is an independent project, not affiliated with or endorsed by any charting platform or
data provider. No licence is granted for reuse of this source code.
