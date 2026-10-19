"""
MarketLab market-data service.

A small, local-only FastAPI wrapper around `yfinance` that exposes historical
daily OHLCV data and symbol search without requiring an API key. This service is
optional: MarketLab remains fully usable (CSV import + bundled samples) when it
is not running.

Honesty rules:
- Yahoo data is unofficial, undocumented, may be delayed, and can change or
  disappear at any time. Responses carry explicit provenance metadata and the
  client surfaces limitations to the user.
- Only daily bars (`interval=1d`) are served. Intraday is deliberately not
  exposed because MarketLab's canonical model is date-only exchange sessions and
  no code path may fabricate intraday bars.
- Nothing in this file or its responses implies real-time or exchange-licensed
  data access.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable, Iterable

import pandas as pd
import yfinance as yf
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.datastructures import MutableHeaders

SERVICE_VERSION = "1.0.0"
SYMBOL_PATTERN = r"^[A-Za-z0-9._^=:-]{1,16}$"
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MAX_SEARCH_RESULTS = 20
REQUEST_TIMEOUT_SECONDS = 25.0
HISTORY_CACHE_TTL_SECONDS = 600.0
EARLIEST_START = date(1900, 1, 1)

logger = logging.getLogger("marketlab.market_data")

app = FastAPI(title="MarketLab market-data service", version=SERVICE_VERSION)

# Restrict CORS to the frontends MarketLab may be served from during local
# development/preview, plus the project's own deployed origin. Nothing else
# may call this service; the service itself still binds to 127.0.0.1 only, so
# it is unreachable from outside the user's machine.
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "https://marketlab.sourabhpradhan.in",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


class AllowPrivateNetworkMiddleware:
    """Chrome's Private Network Access requires an explicit opt-in header on the
    CORS preflight from a public origin (the deployed site) to a loopback
    address (this service). Without it Chrome blocks the request even when the
    origin is allowed. The origin/method rules of the first-party CORS policy
    are unchanged; this only permits the already-allowed origins to reach the
    user's own localhost."""

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        async def send_hook(message: Any) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(raw=message["headers"])
                headers["Access-Control-Allow-Private-Network"] = "true"
            await send(message)

        await self.app(scope, receive, send_hook)


app.add_middleware(AllowPrivateNetworkMiddleware)  # added last => wraps (runs before) CORS

ADJUSTMENT_POLICY = "splits-applied, dividends not reinvested (as-traded OHLC)"
PROVIDER_NAME = "yahoo-finance"
SOURCE_NOTES = [
    "Unofficial, undocumented Yahoo Finance data; may be delayed for some venues.",
    "Fetched on demand; availability and schema can change without notice.",
    "Daily exchange-session bars only; MarketLab aggregates weekly/monthly locally.",
    "Volume is nullable: Yahoo omits it for some instrument types.",
    "Corporate actions are provider-reported event dates and may be incomplete; "
    "split markers do not imply a price gap because the OHLC series is split-adjusted.",
]


class ProviderError(Exception):
    """An upstream Yahoo/yfinance failure that is not a caller mistake."""


class ProviderTimeout(ProviderError):
    pass


class ProviderThrottled(ProviderError):
    pass


class ProviderMalformed(ProviderError):
    pass


class NoData(Exception):
    """The provider answered but had no data for the request."""


def _iso(value: Any) -> str | None:
    try:
        stamp = pd.Timestamp(value)
        if stamp.tzinfo is not None:
            return stamp.strftime("%Y-%m-%d")
        return stamp.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return None


def _coerce_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return number


def _require_dates(value: Any, kind: str) -> list[Any]:
    try:
        index: Iterable[Any] = list(value)
    except TypeError:
        raise ProviderMalformed("Provider index was not iterable.") from None
    if not index:
        raise NoData(f"No sessions were returned for the requested {kind}.")
    return list(index)


def normalise_history_frame(frame: pd.DataFrame) -> list[dict[str, Any]]:
    """Converts a provider DataFrame into response rows.

    Dates are converted to the exchange-local session date (the frame's tz-aware
    index carries the exchange timezone; the time component is midnight before
    markets open in that zone, so strftime of the local date is the session date
    used by every other layer of the pipeline).
    """
    if frame is None:
        raise NoData("The provider returned no history.")
    required = {"Open", "High", "Low", "Close"}
    missing = required.difference(frame.columns)
    if missing:
        raise ProviderMalformed(
            f"Provider response is missing required columns: {', '.join(sorted(missing))}."
        )
    index = _require_dates(frame.index, "range")

    bars: list[dict[str, Any]] = []
    for index_value in index:
        row = frame.loc[index_value]
        session_date = _iso(index_value)
        if session_date is None:
            # A malformed timestamp is a data-quality failure, not silence.
            raise ProviderMalformed("Provider returned a date that is not a valid session date.")
        open_ = _coerce_number(row.get("Open"))
        high = _coerce_number(row.get("High"))
        low = _coerce_number(row.get("Low"))
        close = _coerce_number(row.get("Close"))
        adj_close = _coerce_number(row.get("Adj Close")) if "Adj Close" in frame.columns else None
        volume = _coerce_number(row.get("Volume")) if "Volume" in frame.columns else None
        bars.append(
            {
                "date": session_date,
                "open": open_,
                "high": high,
                "low": low,
                "close": close,
                "adjClose": adj_close,
                "volume": round(volume) if volume is not None else None,
            }
        )
    if not bars:
        raise NoData("The provider returned no sessions.")
    return bars


def normalise_corporate_actions(frame: pd.DataFrame) -> list[dict[str, Any]]:
    """Extracts provider-reported splits and cash dividends from a history frame.

    `history(actions=True)` adds `Dividends` and `Stock Splits` columns to the
    same daily frame. Their index is the exchange-local session date, so each
    event is tied to the same date vocabulary as the bars. Non-positive and
    non-numeric cells are ignored: the provider may fill absent actions with
    zero, but no value is invented. Events are returned in date order.
    """
    if frame is None:
        return []
    columns: list[tuple[str, str]] = []
    if "Dividends" in frame.columns:
        columns.append(("dividend", "Dividends"))
    if "Stock Splits" in frame.columns:
        columns.append(("split", "Stock Splits"))
    if not columns:
        return []

    actions: list[dict[str, Any]] = []
    for index_value in frame.index:
        session_date = _iso(index_value)
        if session_date is None:
            continue
        row = frame.loc[index_value]
        for action_type, column in columns:
            value = _coerce_number(row.get(column))
            if value is not None and value > 0:
                actions.append({"date": session_date, "type": action_type, "value": value})
    actions.sort(key=lambda action: (action["date"], 0 if action["type"] == "split" else 1))
    return actions


def fetch_history(symbol: str, start: str, end: str) -> tuple[pd.DataFrame, str | None, str | None, str | None, str | None, str | None, str | None]:
    """Downloads daily history and returns (frame, currency, exchange, exchangeName, instrumentType, displaySymbol, exchangeTimezone)."""
    try:
        ticker = yf.Ticker(symbol)
        # auto_adjust=False keeps OHLC as-traded (splits applied by Yahoo,
        # dividends not reinvested) and reports a separate `Adj Close`
        # (dividends + splits adjusted). `actions=True` adds provider-reported
        # Dividends and Stock Splits columns for chart markers. The adjustment
        # policy is declared in the response metadata so two conventions are
        # never mixed silently.
        frame = ticker.history(start=start, end=end, interval="1d", auto_adjust=False, actions=True)
    except Exception as error:  # yfinance raises broad, undocumented exception types
        # Yahoo answers unknown tickers with its own 404 ("Quote not found")
        # or with a delisted notice; both mean "no data", not "service broken".
        message = str(error)
        lowered = message.lower()
        if ("rate" in lowered and "limit" in lowered) or "too many requests" in lowered:
            raise ProviderThrottled("Yahoo throttled this request.") from error
        if "timed out" in lowered or "timeout" in lowered:
            raise ProviderTimeout("The provider request timed out.") from error
        if "404" in message or "quote not found" in lowered or "possibly delisted" in lowered:
            raise NoData(f"No data found for symbol {symbol}; it may be delisted or unknown.") from error
        raise ProviderError(f"Yahoo request failed: {message}") from error

    try:
        metadata = ticker.history_metadata or {}
    except Exception:
        # Some yfinance versions raise a KeyError (e.g. 'exchangeTimezoneName')
        # when a symbol is unknown or delisted. The history frame is still the
        # source of truth: an empty frame becomes a clean NoData below, and a
        # populated frame is served without descriptive metadata.
        metadata = {}
    return (
        frame,
        metadata.get("currency"),
        metadata.get("exchangeName"),
        metadata.get("fullExchangeName"),
        metadata.get("instrumentType"),
        metadata.get("shortName") or metadata.get("longName"),
        metadata.get("exchangeTimezoneName"),
    )


_CACHE: dict[tuple[str, str, str], tuple[float, Any]] = {}


def _cache_get(key: tuple[str, str, str]) -> Any:
    hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < HISTORY_CACHE_TTL_SECONDS:
        return hit[1]
    if hit:
        _CACHE.pop(key, None)
    return None


def _cache_put(key: tuple[str, str, str], value: Any) -> None:
    if len(_CACHE) > 200:
        _CACHE.clear()
    _CACHE[key] = (time.monotonic(), value)


async def _run_with_timeout(function: Callable[[], Any], seconds: float) -> Any:
    loop = asyncio.get_running_loop()
    return await asyncio.wait_for(loop.run_in_executor(None, function), timeout=seconds)


def _parse_date_parameter(value: str, name: str) -> str:
    if not DATE_PATTERN.match(value):
        raise HTTPException(status_code=400, detail=f"{name} must be an ISO date (YYYY-MM-DD).")
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{name} is not a valid calendar date.") from None
    if parsed < EARLIEST_START:
        raise HTTPException(status_code=400, detail=f"{name} must be {EARLIEST_START.isoformat()} or later.")
    return value


@app.exception_handler(ProviderError)
async def provider_error_handler(_: Any, error: ProviderError) -> JSONResponse:
    if isinstance(error, ProviderThrottled):
        return JSONResponse(status_code=429, content={"detail": str(error)})
    if isinstance(error, ProviderTimeout):
        return JSONResponse(status_code=503, content={"detail": str(error)})
    return JSONResponse(status_code=502, content={"detail": str(error)})


@app.exception_handler(NoData)
async def no_data_handler(_: Any, error: NoData) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": str(error)})


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "marketlab-market-data",
        "version": SERVICE_VERSION,
        "provider": PROVIDER_NAME,
        "yfinance": getattr(yf, "__version__", "unknown"),
    }


def search_symbols(query: str, limit: int) -> list[dict[str, Any]]:
    try:
        search = yf.Search(query, max_results=limit)
        quotes = search.quotes or []
    except Exception as error:
        message = str(error).lower()
        if "rate" in message and "limit" in message:
            raise ProviderThrottled("Yahoo throttled this request.") from error
        raise ProviderError(f"Yahoo search failed: {error}") from error
    results: list[dict[str, Any]] = []
    for quote in quotes:
        symbol = quote.get("symbol")
        if not isinstance(symbol, str) or not symbol:
            continue
        results.append(
            {
                "symbol": symbol,
                "name": quote.get("longname") or quote.get("shortname") or symbol,
                "exchange": quote.get("exchange"),
                "exchangeName": quote.get("exchDisp") or quote.get("exchange"),
                "type": quote.get("typeDisp") or quote.get("quoteType"),
                "sector": quote.get("sector"),
                "industry": quote.get("industry"),
            }
        )
        if len(results) >= limit:
            break
    return results


@app.get("/api/search")
async def search_endpoint(
    q: str = Query(min_length=2, max_length=64),
    limit: int = Query(default=10, ge=1, le=MAX_SEARCH_RESULTS),
) -> dict[str, Any]:
    try:
        results = await _run_with_timeout(lambda: search_symbols(q, limit), REQUEST_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="The provider request timed out.") from None
    return {"provider": PROVIDER_NAME, "query": q, "results": results}


@app.get("/api/history")
async def history_endpoint(
    symbol: str = Query(min_length=2, max_length=16),
    start: str | None = Query(default=None),
    end: str | None = Query(default=None),
) -> dict[str, Any]:
    symbol = symbol.strip()
    if not re.match(SYMBOL_PATTERN, symbol):
        raise HTTPException(status_code=400, detail="Symbol contains unsupported characters.")

    start_bound = _parse_date_parameter(start, "start") if start else (date.today() - timedelta(days=365 * 5)).isoformat()
    end_bound = _parse_date_parameter(end, "end") if end else date.today().isoformat()
    if start_bound > end_bound:
        raise HTTPException(status_code=400, detail="start must be on or before end.")

    cache_key = (PROVIDER_NAME, symbol, f"{start_bound}..{end_bound}")
    cached = _cache_get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    try:
        frame, currency, exchange, exchange_name, instrument_type, display_name, exchange_tz = await _run_with_timeout(
            lambda: fetch_history(symbol, start_bound, end_bound), REQUEST_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=503, detail="The provider request timed out.") from None

    bars = normalise_history_frame(frame)
    corporate_actions = normalise_corporate_actions(frame)
    metadata = {
        "provider": PROVIDER_NAME,
        "providerSymbol": symbol,
        "displaySymbol": symbol,
        "displayName": display_name,
        "exchange": exchange,
        "exchangeName": exchange_name,
        "instrumentType": instrument_type,
        "currency": currency,
        "timezone": exchange_tz,
        "interval": "1d",
        "adjustment": ADJUSTMENT_POLICY,
        "rangeRequested": {"start": start_bound, "end": end_bound},
        "rangeActual": {"start": bars[0]["date"], "end": bars[-1]["date"]},
        "retrievedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sourceNotes": SOURCE_NOTES,
        "corporateActions": corporate_actions,
    }
    payload = {"provider": metadata, "bars": bars}
    _cache_put(cache_key, payload)
    return payload


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("MARKETLAB_DATA_PORT", "8787"))
    uvicorn.run(app, host="127.0.0.1", port=port)
