# iw-market-data

Static market data CDN layer for Investment Workstation (IW).

This repository serves as a zero-cost, high-speed public CDN (via GitHub Pages and Fastly edge cache) for sanitized, public end-of-day (EOD) market price and indicator data.

## Endpoints

Base URL: `https://shinyab-v2.github.io/iw-market-data/`

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

## Security & Privacy Note

This repository contains **only public market price data**.
No user credentials, API keys, private portfolio balances, trading accounts, or ledger transaction records are stored or transmitted here.
