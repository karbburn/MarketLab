"""
Deterministic tests for the MarketLab market-data service.

Every provider response in these tests is synthesised; the network is never
touched. A separate, optional manual smoke test (see README) exercises the real
Yahoo endpoint and is not part of this suite.
"""

from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as service  # noqa: E402


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    service._CACHE.clear()
    client = TestClient(service.app, raise_server_exceptions=True)
    client.headers.update({"origin": "http://localhost:5173"})
    return client


def history_frame(rows: list[dict[str, float | int | str]]) -> pd.DataFrame:
    """Builds a tz-aware daily frame like `yf.Ticker(...).history()` returns."""
    index = pd.DatetimeIndex([row["date"] for row in rows], tz="America/New_York", name="Date")
    frame = pd.DataFrame(
        {
            "Open": [row["open"] for row in rows],
            "High": [row["high"] for row in rows],
            "Low": [row["low"] for row in rows],
            "Close": [row["close"] for row in rows],
            "Adj Close": [row.get("adjClose", row["close"]) for row in rows],
            "Volume": [row["volume"] for row in rows],
        },
        index=index,
    )
    if any("dividend" in row or "split" in row for row in rows):
        frame["Dividends"] = [row.get("dividend", 0.0) for row in rows]
        frame["Stock Splits"] = [row.get("split", 0.0) for row in rows]
    return frame


def stub_history(monkeypatch: pytest.MonkeyPatch, frame: pd.DataFrame, meta: dict | None = None) -> None:
    service._CACHE.clear()

    def fake_fetch(symbol: str, start: str, end: str):
        metadata = meta or {}
        return (
            frame,
            metadata.get("currency"),
            metadata.get("exchangeName"),
            metadata.get("fullExchangeName"),
            metadata.get("instrumentType"),
            metadata.get("displayName") or metadata.get("shortName"),
            metadata.get("timezone") or metadata.get("exchangeTimezoneName"),
        )

    monkeypatch.setattr(service, "fetch_history", fake_fetch)


def stub_search(monkeypatch: pytest.MonkeyPatch, results: list[dict]) -> None:
    def fake_search(query: str, limit: int) -> list[dict]:
        return results[:limit]

    monkeypatch.setattr(service, "search_symbols", fake_search)


def stub_error(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    def raise_error(symbol: str, start: str, end: str):
        raise error

    monkeypatch.setattr(service, "fetch_history", raise_error)


EXPECTED_METADATA = {
    "currency": "USD",
    "exchangeName": "NMS",
    "fullExchangeName": "NasdaqGS",
    "instrumentType": "EQUITY",
    "shortName": "Apple Inc.",
    "exchangeTimezoneName": "America/New_York",
}


# ---------------------------------------------------------------- health ----

def test_health_reports_service_and_provider(client: TestClient) -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["provider"] == "yahoo-finance"
    assert body["service"] == "marketlab-market-data"
    assert "yfinance" in body


def test_cors_allows_configured_local_origins_only(client: TestClient) -> None:
    ok = client.get("/api/health")
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    foreign = TestClient(service.app, raise_server_exceptions=False)
    foreign.headers.update({"origin": "https://evil.example"})
    assert foreign.get("/api/health").headers.get("access-control-allow-origin") is None


def test_cors_allows_deployed_project_origin(client: TestClient) -> None:
    probe = TestClient(service.app, raise_server_exceptions=False)
    probe.headers.update({"origin": "https://marketlab.sourabhpradhan.in"})
    assert probe.get("/api/health").headers.get("access-control-allow-origin") == "https://marketlab.sourabhpradhan.in"


def test_preflight_from_deployed_origin_optins_to_private_network_access(client: TestClient) -> None:
    """Chrome requires `Access-Control-Allow-Private-Network: true` on the CORS
    preflight before a public site may call a loopback address."""
    response = client.options(
        "/api/health",
        headers={
            "origin": "https://marketlab.sourabhpradhan.in",
            "access-control-request-method": "GET",
            "access-control-request-headers": "access-control-request-private-network",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == "https://marketlab.sourabhpradhan.in"
    assert response.headers.get("access-control-allow-private-network") == "true"


# ---------------------------------------------------------------- search ----

def test_search_normalises_quotes(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_search(
        monkeypatch,
        [
            {"symbol": "AAPL", "name": "Apple Inc.", "exchange": "NMS", "exchangeName": "NASDAQ", "type": "Equity", "sector": "Technology", "industry": "Consumer Electronics"},
            {"symbol": "AAPL.MX", "name": "Apple Listed in Mexico", "exchange": "MEX", "exchangeName": "Mexico", "type": "Equity", "sector": None, "industry": None},
        ],
    )
    response = client.get("/api/search", params={"q": "apple", "limit": 2})
    assert response.status_code == 200
    body = response.json()
    assert body["provider"] == "yahoo-finance"
    assert [row["symbol"] for row in body["results"]] == ["AAPL", "AAPL.MX"]
    assert body["results"][0]["name"] == "Apple Inc."
    assert body["results"][0]["exchangeName"] == "NASDAQ"
    assert body["results"][1]["sector"] is None


def test_search_requires_meaningful_query(client: TestClient) -> None:
    assert client.get("/api/search", params={"q": "a"}).status_code == 422
    assert client.get("/api/search").status_code == 422


def test_search_symbols_skips_rows_without_symbols(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeSearch:
        def __init__(self, query: str, max_results: int = 10) -> None:
            self.quotes = [
                {"symbol": "AAPL", "longname": "Apple Inc.", "exchange": "NMS", "exchDisp": "NASDAQ", "typeDisp": "Equity", "sector": "Technology", "industry": "Consumer Electronics"},
                {"longname": "No symbol row"},
                {"symbol": "AAPL.MX", "shortname": "Apple in Mexico", "exchange": "MEX", "exchangeName": "Mexico", "quoteType": "EQUITY"},
            ]

    monkeypatch.setattr(service.yf, "Search", FakeSearch)
    results = service.search_symbols("apple", 10)
    assert [row["symbol"] for row in results] == ["AAPL", "AAPL.MX"]
    assert results[0]["name"] == "Apple Inc."
    assert results[0]["type"] == "Equity"
    assert results[0]["sector"] == "Technology"
    assert results[1]["name"] == "Apple in Mexico"


def test_search_throttling_maps_to_429(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_throttle(query: str, limit: int) -> list[dict]:
        raise service.ProviderThrottled("Yahoo throttled this request.")

    monkeypatch.setattr(service, "search_symbols", raise_throttle)
    response = client.get("/api/search", params={"q": "apple"})
    assert response.status_code == 429


def test_unknown_route_is_a_clean_404(client: TestClient) -> None:
    response = client.get("/api/fetch-url", params={"url": "https://example.com"})
    assert response.status_code == 404  # no arbitrary-URL endpoint exists at all


# --------------------------------------------------------------- history ----

def test_history_success_normalises_rows_and_metadata(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_history(
        monkeypatch,
        history_frame(
            [
                {"date": "2024-01-02", "open": 10.0, "high": 11.0, "low": 9.5, "close": 10.5, "volume": 1_000},
                {"date": "2024-01-03", "open": 10.5, "high": 12.0, "low": 10.1, "close": 11.25, "volume": 1_500},
            ]
        ),
        EXPECTED_METADATA,
    )
    response = client.get("/api/history", params={"symbol": "AAPL", "start": "2024-01-01", "end": "2024-01-10"})
    assert response.status_code == 200
    body = response.json()
    assert body["provider"]["providerSymbol"] == "AAPL"
    assert body["provider"]["currency"] == "USD"
    assert body["provider"]["exchangeName"] == "NasdaqGS"
    assert body["provider"]["interval"] == "1d"
    assert "dividends not reinvested" in body["provider"]["adjustment"]
    assert body["provider"]["rangeRequested"] == {"start": "2024-01-01", "end": "2024-01-10"}
    assert body["provider"]["retrievedAt"]
    assert body["provider"]["sourceNotes"]
    assert len(body["bars"]) == 2
    first = body["bars"][0]
    assert first["date"] == "2024-01-02"  # session date, exchange-local, no UTC shift
    assert first["open"] == 10.0
    assert first["volume"] == 1000
    assert first["adjClose"] == 10.5


def test_history_includes_provider_corporate_actions(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_history(
        monkeypatch,
        history_frame(
            [
                {"date": "2024-01-02", "open": 10.0, "high": 11.0, "low": 9.5, "close": 10.5, "volume": 1_000, "dividend": 0.24},
                {"date": "2024-01-03", "open": 10.5, "high": 12.0, "low": 10.1, "close": 11.25, "volume": 1_500, "split": 4.0},
                {"date": "2024-01-04", "open": 11.25, "high": 11.5, "low": 10.8, "close": 11.1, "volume": 900, "dividend": 0.0, "split": 0.0},
            ]
        ),
        EXPECTED_METADATA,
    )
    response = client.get("/api/history", params={"symbol": "AAPL", "start": "2024-01-01", "end": "2024-01-10"})
    assert response.status_code == 200
    assert response.json()["provider"]["corporateActions"] == [
        {"date": "2024-01-02", "type": "dividend", "value": 0.24},
        {"date": "2024-01-03", "type": "split", "value": 4.0},
    ]


def test_corporate_actions_sort_splits_before_dividends_on_the_same_session() -> None:
    frame = history_frame(
        [
            {"date": "2024-01-02", "open": 10.0, "high": 11.0, "low": 9.5, "close": 10.5, "volume": 1_000, "dividend": 0.24, "split": 2.0},
        ]
    )
    actions = service.normalise_corporate_actions(frame)
    assert [action["type"] for action in actions] == ["split", "dividend"]


def test_corporate_actions_ignore_absent_and_non_positive_values() -> None:
    frame = history_frame(
        [
            {"date": "2024-01-02", "open": 10.0, "high": 11.0, "low": 9.5, "close": 10.5, "volume": 1_000},
            {"date": "2024-01-03", "open": 10.5, "high": 12.0, "low": 10.1, "close": 11.25, "volume": 1_500, "dividend": -0.5, "split": 0.0},
        ]
    )
    assert service.normalise_corporate_actions(frame) == []


def test_corporate_actions_are_empty_when_the_provider_has_no_action_columns() -> None:
    frame = history_frame(
        [{"date": "2024-01-02", "open": 10.0, "high": 11.0, "low": 9.5, "close": 10.5, "volume": 1_000}]
    )
    assert "Dividends" not in frame.columns
    assert service.normalise_corporate_actions(frame) == []


def test_history_cache_hits_and_misses(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_history(
        monkeypatch,
        history_frame([{"date": "2024-01-02", "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}]),
        EXPECTED_METADATA,
    )
    params = {"symbol": "AAPL", "start": "2024-01-01", "end": "2024-01-10"}
    first = client.get("/api/history", params=params)
    assert first.status_code == 200
    assert first.json().get("cached") is not True
    second = client.get("/api/history", params=params)
    assert second.status_code == 200
    assert second.json()["cached"] is True

    # A cache entry expires or is bypassed for a different range: miss again.
    other = client.get("/api/history", params={"symbol": "AAPL", "start": "2024-02-01", "end": "2024-02-10"})
    assert other.status_code == 200
    assert other.json().get("cached") is not True


def test_history_rejects_invalid_parameters(client: TestClient) -> None:
    assert client.get("/api/history", params={"symbol": "A APL"}).status_code == 400
    assert client.get("/api/history", params={"symbol": "AAPL", "start": "01/02/2024"}).status_code == 400
    assert client.get("/api/history", params={"symbol": "AAPL", "end": "2024-13-01"}).status_code == 400
    assert client.get("/api/history", params={"symbol": "AAPL", "start": "2024-05-01", "end": "2024-01-01"}).status_code == 400
    assert client.get("/api/history", params={"symbol": "AAPL", "start": "1899-01-01"}).status_code == 400


def test_history_empty_provider_result_is_a_404(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_history(monkeypatch, history_frame([]), EXPECTED_METADATA)
    response = client.get("/api/history", params={"symbol": "APPLWRONG", "start": "2024-01-01"})
    assert response.status_code == 404
    assert response.json()["detail"]


def test_history_maps_throttling_to_429(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_error(monkeypatch, service.ProviderThrottled("Yahoo throttled this request."))
    response = client.get("/api/history", params={"symbol": "AAPL"})
    assert response.status_code == 429
    assert response.json()["detail"] == "Yahoo throttled this request."


def test_history_maps_timeout_to_503(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_error(monkeypatch, service.ProviderTimeout("The provider request timed out."))
    response = client.get("/api/history", params={"symbol": "AAPL"})
    assert response.status_code == 503


def test_history_maps_generic_outage_to_502(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_error(monkeypatch, service.ProviderError("Yahoo request failed: connection reset"))
    response = client.get("/api/history", params={"symbol": "AAPL"})
    assert response.status_code == 502


def test_history_malformed_provider_columns_map_to_502(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    stub_history(monkeypatch, pd.DataFrame({"Close": [1.0]}), EXPECTED_METADATA)
    response = client.get("/api/history", params={"symbol": "AAPL"})
    assert response.status_code == 502
    assert "missing required columns" in response.json()["detail"]


def test_history_null_volume_is_preserved_as_null(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    index = pd.DatetimeIndex(["2024-01-02"], tz="America/New_York", name="Date")
    stub_history(
        monkeypatch,
        pd.DataFrame({"Open": [1.0], "High": [1.0], "Low": [1.0], "Close": [1.0]}, index=index),
        EXPECTED_METADATA,
    )
    body = client.get("/api/history", params={"symbol": "AAPL"}).json()
    assert body["bars"][0]["volume"] is None
    assert body["bars"][0]["adjClose"] is None


def test_history_bad_session_date_is_malformed_not_silent(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    index = pd.DatetimeIndex(["2024-01-02"], tz="America/New_York", name="Date")
    frame = pd.DataFrame({"Open": [1.0], "High": [1.0], "Low": [1.0], "Close": [1.0]}, index=index)
    stub_history(monkeypatch, frame, EXPECTED_METADATA)
    # Corrupt normalisation inputs directly to simulate a broken provider clock.
    monkeypatch.setattr(service, "_iso", lambda _value: None)
    response = client.get("/api/history", params={"symbol": "AAPL"})
    assert response.status_code == 502
    assert "session date" in response.json()["detail"]


def test_unknown_symbol_http_404_maps_to_nodata_404(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Yahoo answers unknown tickers with its own HTTP 404; that is "no data", not an outage."""
    service._CACHE.clear()

    class FakeTicker:
        history_metadata: dict | None = None

        def history(self, start: str, end: str, interval: str, auto_adjust: bool, actions: bool) -> pd.DataFrame:
            raise Exception(
                'HTTP Error 404: {"quoteSummary":{"result":null,"error":{"code":"Not Found",'
                '"description":"Quote not found for symbol: QWERTY123XYZ"}}}'
            )

    monkeypatch.setattr(service.yf, "Ticker", lambda symbol: FakeTicker())
    response = client.get(
        "/api/history", params={"symbol": "QWERTY123XYZ", "start": "2024-01-01", "end": "2024-02-01"}
    )
    assert response.status_code == 404
    assert "No data found" in response.json()["detail"]


def test_delisted_notice_maps_to_nodata_404(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """yfinance also signals delisted symbols with a 'possibly delisted' message."""
    service._CACHE.clear()

    class FakeTicker:
        history_metadata: dict | None = None

        def history(self, start: str, end: str, interval: str, auto_adjust: bool, actions: bool) -> pd.DataFrame:
            raise Exception("1 Failed download: ['BRKA.B']: YFPricesMissingError('possibly delisted; no price data found ')")

    monkeypatch.setattr(service.yf, "Ticker", lambda symbol: FakeTicker())
    response = client.get("/api/history", params={"symbol": "BRKA.B", "start": "2024-01-01", "end": "2024-02-01"})
    assert response.status_code == 404
    assert "No data found" in response.json()["detail"]


def test_empty_frame_with_broken_metadata_maps_to_nodata_404(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """Live yfinance 1.4.1 returns an EMPTY frame for unknown symbols and its
    `history_metadata` property then raises KeyError('exchangeTimezoneName').
    That must become a clean 404, never a 502 outage."""
    service._CACHE.clear()

    empty = pd.DataFrame(
        {"Open": [], "High": [], "Low": [], "Close": [], "Adj Close": [], "Volume": []}
    )

    class FakeTicker:
        @property
        def history_metadata(self) -> dict:
            raise KeyError("exchangeTimezoneName")

        def history(self, start: str, end: str, interval: str, auto_adjust: bool, actions: bool) -> pd.DataFrame:
            return empty

    monkeypatch.setattr(service.yf, "Ticker", lambda symbol: FakeTicker())
    response = client.get("/api/history", params={"symbol": "QWERTY123XYZ", "start": "2024-01-01", "end": "2024-02-01"})
    assert response.status_code == 404
    assert "No data found" in response.json()["detail"] or "no sessions" in response.json()["detail"].lower()
