# MarketLab market-data service

An optional, local-only FastAPI wrapper around [`yfinance`](https://github.com/ranaroussi/yfinance)
that gives MarketLab historical daily OHLCV downloads and symbol search without
any API key.

**What this is not:** an official or guaranteed Yahoo Finance feed. Data may be
delayed, incomplete, or change shape without notice; availability can fail
(transient outages, rate limiting). MarketLab treats every failure as a
first-class state and keeps working offline with CSV imports and already-downloaded
datasets.

Only **daily** bars are served. MarketLab's canonical model is date-only exchange
sessions; weekly/monthly views are aggregated inside the app, and intraday is
deliberately unsupported. OHLC is as-traded (splits applied by Yahoo, dividends
not reinvested); the separate `adjClose` column is captured but not yet used by
 computations. The adjustment policy is recorded in every download's metadata.

History responses also carry `provider.corporateActions`, an array of
provider-reported events in the requested range:

```json
{ "date": "2024-01-03", "type": "split", "value": 4.0 }
{ "date": "2024-02-15", "type": "dividend", "value": 0.24 }
```

`value` is new shares per old share for a split and cash per share for a
dividend. These events are never inferred from price moves and may be
incomplete. A split marker identifies the provider event date; because the OHLC
series is split-adjusted, it does not imply a price gap. Dividend markers are
not reinvested.

## Setup

```bash
cd services/market-data
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
source .venv/bin/activate
pip install -r requirements.txt
```

## Run

```bash
uvicorn app:app --host 127.0.0.1 --port 8787
```

Then in MarketLab: **Data → Download market data**. The frontend targets
`http://127.0.0.1:8787` on the same machine. The service binds to loopback
(`127.0.0.1`), so it is not reachable from other machines, and its CORS
allow-list only lets MarketLab's own frontends read responses: the local dev and
preview origins plus the project's deployed site at
`https://marketlab.sourabhpradhan.in`. CORS is a browser read restriction, not a
network boundary: a browser on another origin can still send a request, but it
cannot read the response, and a local process can call the service directly
regardless of origin. The service performs no writes and no file I/O.
Run locally, the service lets the deployed app download real data too; no data
ever passes through the deployment host.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /api/health` | availability + provider/library versions |
| `GET /api/search?q=<2-64 chars>&limit<=20` | symbol lookup (fuzzy), returns symbol/name/exchange/type |
| `GET /api/history?symbol=AAPL&start=2020-01-01&end=2025-01-01` | daily bars + provenance metadata + provider corporate actions |

Errors are JSON `{"detail": ...}`. The service's own errors use a string detail:
`400` invalid input, `404` no data for the symbol/range, `429` provider
throttled, `502` malformed provider response, `503` provider timeout. FastAPI
also returns `422` for query-validation failures (for example `q` outside 2-64
characters or `limit` out of range); in that case `detail` is its standard array
of validation entries rather than a string. Treat `422` as a client error.
Results are cached in-process for 10 minutes.

## Tests (deterministic; no network)

```bash
cd services/market-data
python -m pytest tests -q
```

## Optional live smoke check (manual; requires network)

This is **not** part of the automated suite and may fail due to Yahoo-side
issues independent of this code:

```bash
uvicorn app:app --port 8787 &
curl "http://127.0.0.1:8787/api/health"
curl "http://127.0.0.1:8787/api/history?symbol=AAPL&start=2025-09-01&end=2025-09-30"
```
