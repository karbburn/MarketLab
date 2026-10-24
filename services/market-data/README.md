# MarketLab market-data service

An optional, local-only FastAPI wrapper around [`yfinance`](https://github.com/ranaroussi/yfinance)
for development on the same machine. It gives MarketLab historical daily OHLCV
downloads and symbol search without any API key.

The deployed site does **not** use this service. It calls the same-origin Vercel
edge proxy in [`api/market-data/`](../../api/market-data), which talks to Yahoo
Finance server-side and can use Twelve Data as an optional fallback. That is why
downloads work on a phone or another computer without installing Python or
starting a local process. This FastAPI service is only for `localhost` /
`127.0.0.1` development and debugging.

**What this is not:** an official or guaranteed Yahoo Finance feed. Data may be
delayed, incomplete, or change shape without notice; availability can fail
(transient outages, rate limiting). MarketLab treats every failure as a
first-class state and keeps working offline with CSV imports and already-downloaded
datasets.

Only **daily** bars are served. MarketLab's canonical model is date-only exchange
sessions; weekly/monthly views are aggregated inside the app, and intraday is
deliberately unsupported. OHLC is split-adjusted (dividends not reinvested); the separate
`adjClose` column is present in the provider response but is not stored or used by the app.
The adjustment policy is recorded in every download's metadata.

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

Then in MarketLab on `localhost` or `127.0.0.1`: **Data → Download market data**.
The local frontend targets `http://127.0.0.1:8787` on the same machine. The
service binds to loopback (`127.0.0.1`), so it is not reachable from other
machines, and its CORS allow-list only lets MarketLab's own frontends read
responses: the local dev and preview origins plus the project's deployed site at
`https://marketlab.sourabhpradhan.in`. CORS is a browser read restriction, not a
network boundary: a browser on another origin can still send a request, but it
cannot read the response, and a local process can call the service directly
regardless of origin. The service performs no writes and no file I/O.

On a deployed hostname the browser uses the same-origin edge proxy instead; it
never asks another device to run this service. If you want the fallback in the
hosted proxy, set `TWELVE_DATA_API_KEY` in Vercel. The key is server-side only
and is not used by this local FastAPI service.

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

## Hosted proxy

The Vercel functions in `api/market-data/` expose the same routes under
`/api/market-data/{health,search,history}`. History uses Yahoo Finance first.
When `TWELVE_DATA_API_KEY` is set in the Vercel project and Yahoo is throttled,
unavailable or has no data, the proxy tries Twelve Data's `time_series`
endpoint server-side. Twelve Data downloads are split-adjusted with dividends
not reinvested, but the endpoint does not provide a separate adjusted close or
corporate-action rows, so `adjClose` is null and `corporateActions` is empty.
The response always names the provider that answered. Without the key, only
Yahoo is used and failures stay explicit.

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
