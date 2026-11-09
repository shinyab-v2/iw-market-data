# iw-market-data

Static market data CDN layer for Investment Workstation (IW).

This repository serves sanitized public end-of-day (EOD) market prices and indicators.

## Endpoints

Primary base URL: `https://raw.githubusercontent.com/shinyab-v2/iw-market-data/main/`

Fallback base URL: `https://cdn.jsdelivr.net/gh/shinyab-v2/iw-market-data@main/`

The existing GitHub Pages site uses branch publishing and may lag scheduled
bot commits. It is a historical access path.

- **Daily Prices (OHLCV):**
  - Path: `prices/{ticker}.json` (e.g., `prices/005930.json`, `prices/SOXL.json`)
  - Format: JSON
  - Retention: Up to 500 trading days
- **Universe Metadata:**
  - Path: `universe/active.json`
- **Computed Indicators:**
  - Path: `indicators/{ticker}.json`

## Price Schema (v1)

```json
{
  "ticker": "005930",
  "updatedAt": "2026-11-09T08:00:00Z",
  "currency": "KRW",
  "market": "KRX",
  "rows_hash": "<SHA-256 of the canonical OHLCV rows>",
  "rows": [
    {
      "d": "2026-11-06",
      "o": 58000,
      "h": 58500,
      "l": 57500,
      "c": 58200,
      "v": 11200000
    }
  ]
}
```

The scheduled builder publishes changed prices and indicators together.
Both files carry the same `rows_hash`. A failed or unsafe symbol fetch
fails the job before any files are published. Unchanged builds skip the commit.

## Security & Privacy Note

This repository contains **only public market price data**.
No user credentials, API keys, private portfolio balances, trading accounts, or ledger transaction records are stored or transmitted here.
