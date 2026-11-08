import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PRICES_DIR = path.join(ROOT_DIR, 'prices');
const UNIVERSE_FILE = path.join(ROOT_DIR, 'universe', 'active.json');

export function normalizeTickerString(ticker) {
  if (ticker === null || ticker === undefined) return '';
  const s = String(ticker).trim().toUpperCase();
  if (/^\d{1,5}$/.test(s)) return s.padStart(6, '0');
  return s;
}

export function formatNyDate(epochSec) {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(epochSec * 1000));
}

export function formatIsoDateText(compactDate) {
  const s = String(compactDate || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return null;
}

export function validateAndSanitizeRows(rows, maxDays = 500) {
  if (!Array.isArray(rows)) return [];
  const byDate = new Map();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const d = formatIsoDateText(r.d);
    if (!d) continue;

    const o = Number(r.o);
    const h = Number(r.h);
    const l = Number(r.l);
    const c = Number(r.c);
    const v = Number(r.v);

    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c) || !Number.isFinite(v)) {
      continue;
    }
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0 || v < 0) {
      continue;
    }
    if (h < Math.max(o, c) * 0.999 || l > Math.min(o, c) * 1.001) {
      continue;
    }

    byDate.set(d, {
      d,
      o: Math.round(o * 1000) / 1000,
      h: Math.round(h * 1000) / 1000,
      l: Math.round(l * 1000) / 1000,
      c: Math.round(c * 1000) / 1000,
      v: Math.round(v)
    });
  }
  return [...byDate.values()].sort((a, b) => a.d.localeCompare(b.d)).slice(-maxDays);
}

export function parseNaverFchart(text, maxDays = 500) {
  const matches = [...String(text || '').matchAll(/<item\s+data="([^"]+)"/g)];
  const rawRows = [];
  for (const m of matches) {
    const parts = m[1].split('|');
    if (parts.length < 6) continue;
    rawRows.push({
      d: parts[0],
      o: Number(parts[1]),
      h: Number(parts[2]),
      l: Number(parts[3]),
      c: Number(parts[4]),
      v: Number(parts[5])
    });
  }
  return validateAndSanitizeRows(rawRows, maxDays);
}

export function parseNaverApiJson(data, maxDays = 500) {
  const list = data?.priceInfos || [];
  const rawRows = list.map(item => ({
    d: item.localDate,
    o: item.openPrice,
    h: item.highPrice,
    l: item.lowPrice,
    c: item.closePrice,
    v: item.accumulatedTradingVolume
  }));
  return validateAndSanitizeRows(rawRows, maxDays);
}

export function parseYahooChart(data, maxDays = 500) {
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const rawRows = [];
  for (let i = 0; i < timestamps.length; i++) {
    const d = formatNyDate(timestamps[i]);
    if (!d) continue;
    rawRows.push({
      d,
      o: quote.open?.[i],
      h: quote.high?.[i],
      l: quote.low?.[i],
      c: quote.close?.[i],
      v: quote.volume?.[i] ?? 0
    });
  }
  return validateAndSanitizeRows(rawRows, maxDays);
}

async function fetchDomestic(ticker, count = 500) {
  const sym = normalizeTickerString(ticker);
  try {
    const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${sym}&timeframe=day&count=${count}&requestType=0`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const text = await res.text();
      const rows = parseNaverFchart(text, count);
      if (rows.length > 0) return { ok: true, provider: 'NAVER_FCHART', rows };
    }
  } catch (err) {}

  try {
    const now = new Date();
    const start = new Date(now.getTime() - 400 * 86400000);
    const s = start.toISOString().slice(0, 10).replace(/-/g, '');
    const e = now.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://api.stock.naver.com/chart/domestic/item/${sym}?periodType=dayCandle&startDateTime=${s}&endDateTime=${e}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (res.ok) {
      const data = await res.json();
      const rows = parseNaverApiJson(data, count);
      if (rows.length > 0) return { ok: true, provider: 'NAVER_API', rows };
    }
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  }
  return { ok: false, error: 'NO_ROWS', rows: [] };
}

async function fetchUs(ticker, count = 500) {
  const sym = normalizeTickerString(ticker);
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2y`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return { ok: false, error: `HTTP_${res.status}`, rows: [] };
    const data = await res.json();
    const rows = parseYahooChart(data, count);
    if (rows.length > 0) return { ok: true, provider: 'YAHOO_CHART', rows };
    return { ok: false, error: 'NO_VALID_OHLCV', rows: [] };
  } catch (err) {
    return { ok: false, error: err.message, rows: [] };
  }
}

export function computeRowsHash(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(rows || [])).digest('hex');
}

export async function runBuild({ universeFile = UNIVERSE_FILE, pricesDir = PRICES_DIR, count = 500, dryRun = false } = {}) {
  if (!fs.existsSync(pricesDir)) {
    fs.mkdirSync(pricesDir, { recursive: true });
  }

  const universe = JSON.parse(fs.readFileSync(universeFile, 'utf8'));
  const symbols = universe.symbols || [];
  console.log(`Starting market data build for ${symbols.length} tickers...`);

  const summary = { total: symbols.length, updated: 0, unchanged: 0, failed: 0, details: [] };

  for (const item of symbols) {
    const ticker = normalizeTickerString(item.ticker);
    const isKr = item.market === 'KRX' || /^\d{6}$/.test(ticker) || /^\d{4}[A-Z0-9]{2}$/.test(ticker);
    
    let result = null;
    if (isKr) {
      result = await fetchDomestic(ticker, count);
    } else {
      result = await fetchUs(ticker, count);
    }

    if (!result || !result.ok || !result.rows.length) {
      console.warn(`[FAIL] ${ticker}: ${result?.error || 'No rows returned'}`);
      summary.failed++;
      summary.details.push({ ticker, status: 'FAILED', error: result?.error });
      continue;
    }

    const targetFile = path.join(pricesDir, `${ticker}.json`);
    const newHash = computeRowsHash(result.rows);

    let existingHash = null;
    let existingUpdatedAt = null;
    if (fs.existsSync(targetFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
        existingHash = computeRowsHash(existing.rows);
        existingUpdatedAt = existing.updatedAt;
      } catch (err) {}
    }

    if (existingHash === newHash) {
      summary.unchanged++;
      summary.details.push({ ticker, status: 'UNCHANGED', rows: result.rows.length });
      continue;
    }

    const payload = {
      ticker,
      updatedAt: new Date().toISOString(),
      currency: item.currency || (isKr ? 'KRW' : 'USD'),
      market: isKr ? 'KRX' : 'US',
      rows: result.rows
    };

    if (!dryRun) {
      fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf8');
    }
    summary.updated++;
    const lastRow = result.rows.at(-1);
    console.log(`[OK] ${ticker}: ${result.rows.length} rows (${result.provider}), lastClose: ${lastRow.c} (${lastRow.d})`);
    summary.details.push({ ticker, status: 'UPDATED', rows: result.rows.length, lastClose: lastRow.c, lastDate: lastRow.d });
  }

  console.log(`\nBuild complete: Total ${summary.total}, Updated ${summary.updated}, Unchanged ${summary.unchanged}, Failed ${summary.failed}`);
  return summary;
}

if (process.argv[1] && process.argv[1].endsWith('build-market-data.mjs')) {
  runBuild().catch(err => {
    console.error('Fatal build error:', err);
    process.exit(1);
  });
}
